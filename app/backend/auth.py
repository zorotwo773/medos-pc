"""
MedOS auth — per-user username/password authentication + session cookies.

Gate logic:
  GATE_ENABLED = bool(SESSION_SECRET)
    True  → production: login page required, credentials validated against users DB
    False → dev mode: every request resolves to legacy@medos (admin rights everywhere)

Users table lives in USERS_DB_PATH (auto-created).
On first boot with gate enabled, an admin user is seeded from MEDOS_ADMIN_PASSWORD.
Session cookies are itsdangerous-signed JWTs (HttpOnly, SameSite=Lax).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from contextlib import closing
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request, Response, status
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

import config as _config

# ─── Config ────────────────────────────────────────────────────────────────
_DEFAULT_COOKIE    = "medos_session"
_DEFAULT_TTL_DAYS  = 30

SESSION_SECRET: str    = os.getenv("MEDOS_SESSION_SECRET", "").strip()
COOKIE_NAME: str       = os.getenv("MEDOS_COOKIE_NAME", _DEFAULT_COOKIE).strip() or _DEFAULT_COOKIE
COOKIE_TTL_DAYS: int   = int(os.getenv("MEDOS_COOKIE_TTL_DAYS", str(_DEFAULT_TTL_DAYS)) or _DEFAULT_TTL_DAYS)
TRUST_PROXY: bool      = os.getenv("MEDOS_TRUST_PROXY", "false").strip().lower() in {"1", "true", "yes"}
ADMIN_INIT_PASSWORD: str = os.getenv("MEDOS_ADMIN_PASSWORD", "NYC@727264").strip()

GATE_ENABLED: bool = bool(SESSION_SECRET)

_BACKEND_DIR = Path(__file__).parent
# config.ROOT already discards a recorded MEDOS_ROOT that is no longer reachable
# (an external drive rarely keeps the same drive letter or /Volumes name), so
# reuse it rather than re-reading the raw environment value here.
_ROOT = _config.ROOT
_RELEASE_USERS_DB = _BACKEND_DIR.parent.parent / "data" / "users.sqlite"


def _resolve_users_db() -> Path:
    """Prefer the configured accounts database, then any database that exists.

    Creating an empty users.sqlite at an unreachable or relocated path is what
    made established accounts report "incorrect password": every account was
    gone, so the only credential left was the freshly seeded admin. Mirror the
    override-then-local ordering that config._portable_path() uses for data.
    """
    configured = Path(os.getenv("USERS_DB_PATH", str(_ROOT / "data" / "users.sqlite")))
    try:
        if configured.exists() or not _RELEASE_USERS_DB.exists():
            return configured
    except OSError:
        pass
    return _RELEASE_USERS_DB


USERS_DB_PATH = _resolve_users_db()

LEGACY_USER_EMAIL = "legacy@medos"
LEGACY_USER_NAME  = "Local"

_SIGNER = URLSafeTimedSerializer(
    secret_key=SESSION_SECRET or "dev-only-no-secret",
    salt="medos.session.v1",
)

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


# ─── Pydantic models ───────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class MeResponse(BaseModel):
    authenticated: bool
    name: Optional[str] = None
    email: Optional[str] = None
    is_admin: bool = False
    gate_enabled: bool


class CreateUserRequest(BaseModel):
    username: str    = Field(min_length=1, max_length=40)
    display_name: str = Field(min_length=1, max_length=80)
    password: str    = Field(min_length=4, max_length=200)
    is_admin: bool   = False


class UpdateUserRequest(BaseModel):
    display_name: Optional[str] = None
    password: Optional[str]     = None
    is_admin: Optional[bool]    = None


# ─── Helpers ───────────────────────────────────────────────────────────────
def slugify(name: str) -> str:
    norm = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    return _SLUG_STRIP.sub("-", norm.lower()).strip("-")[:40]


def user_email(username: str) -> str:
    return f"{slugify(username)}@medos"


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    itr  = 390_000
    dk   = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode("ascii"), itr)
    return f"pbkdf2:sha256:{itr}:{salt}:{dk.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        _, _, itr, salt, expected = stored.split(":")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode("ascii"), int(itr))
        return hmac.compare_digest(dk.hex(), expected)
    except Exception:
        return False


# ─── Users DB ──────────────────────────────────────────────────────────────
def _users_conn() -> sqlite3.Connection:
    USERS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(USERS_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        display_name  TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL,
        last_login    TEXT
    )""")
    conn.commit()
    return conn


def ensure_admin_user() -> None:
    """Seed the default admin when the users table is empty (first boot)."""
    if not GATE_ENABLED:
        return
    try:
        with closing(_users_conn()) as conn:
            if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
                now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                conn.execute(
                    "INSERT INTO users(username,display_name,password_hash,is_admin,created_at) VALUES(?,?,?,1,?)",
                    ("admin", "Administrator", _hash_password(ADMIN_INIT_PASSWORD), now),
                )
                conn.commit()
                print(f"[auth] Admin user seeded (username: admin) in {USERS_DB_PATH}")
    except Exception as e:
        print(f"[auth] ensure_admin_user ({USERS_DB_PATH}): {e}")


class UsersDatabaseUnavailable(RuntimeError):
    """Raised when the accounts database cannot be opened or read at all."""


def verify_credentials(username: str, password: str) -> Optional[dict]:
    """Return the user row for valid credentials, or None when they do not match.

    Raises UsersDatabaseUnavailable when the accounts database itself cannot be
    read, so the caller can say so instead of blaming the password.
    """
    slug = slugify(username)
    if not slug:
        return None
    try:
        with closing(_users_conn()) as conn:
            row = conn.execute("SELECT * FROM users WHERE username=?", (slug,)).fetchone()
            if not row or not _verify_password(password, row["password_hash"]):
                return None
            record = dict(row)
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            try:
                conn.execute("UPDATE users SET last_login=? WHERE id=?", (now, row["id"]))
                conn.commit()
            except sqlite3.Error as error:
                # A read-only or locked database must never turn a correct
                # password into a rejected one.
                print(f"[auth] last_login not recorded for {slug}: {error}")
            return record
    except (sqlite3.Error, OSError) as error:
        raise UsersDatabaseUnavailable(f"{USERS_DB_PATH}: {error}") from error


# Short-TTL cache so per-request session validation (SessionMiddleware) doesn't hit
# SQLite on every asset fetch. Invalidated on any user create/update/delete so admin
# changes (delete, demote, password change) take effect within one TTL at worst.
_USER_CACHE: dict = {}
_USER_CACHE_TTL = 15.0
_USER_CACHE_LOCK = threading.Lock()
_DB_UNAVAILABLE = object()   # sentinel: could not read the users DB (fail open)


def _invalidate_user_cache() -> None:
    with _USER_CACHE_LOCK:
        _USER_CACHE.clear()


def resolve_current_user(slug: str):
    """Current DB row for a username slug. Returns a dict if the user exists, None if
    it has been deleted, or _DB_UNAVAILABLE if the DB could not be read. Cached briefly."""
    slug = slugify(slug or "")
    if not slug:
        return None
    now = time.time()
    with _USER_CACHE_LOCK:
        hit = _USER_CACHE.get(slug)
        if hit and hit[1] > now:
            return hit[0]
    try:
        with closing(_users_conn()) as conn:
            r = conn.execute(
                "SELECT id, username, display_name, is_admin FROM users WHERE username=?", (slug,)
            ).fetchone()
            row = dict(r) if r else None
    except Exception:
        return _DB_UNAVAILABLE   # don't lock users out on a transient DB error
    with _USER_CACHE_LOCK:
        _USER_CACHE[slug] = (row, now + _USER_CACHE_TTL)
    return row


def list_users() -> list:
    try:
        with closing(_users_conn()) as conn:
            rows = conn.execute(
                "SELECT id, username, display_name, is_admin, created_at, last_login FROM users ORDER BY id"
            ).fetchall()
            return [dict(r) for r in rows]
    except Exception:
        return []


def create_user(req: CreateUserRequest) -> dict:
    slug = slugify(req.username)
    if not slug:
        raise ValueError("Invalid username — no alphanumeric characters")
    USERS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with closing(_users_conn()) as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users(username,display_name,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)",
                (slug, req.display_name.strip(), _hash_password(req.password), 1 if req.is_admin else 0, now),
            )
            conn.commit()
            return {"id": cur.lastrowid, "username": slug, "display_name": req.display_name.strip(), "is_admin": req.is_admin}
        except sqlite3.IntegrityError:
            raise ValueError(f"Username '{slug}' already taken")


def update_user(user_id: int, req: UpdateUserRequest) -> bool:
    parts, params = [], []
    if req.display_name is not None:
        parts.append("display_name=?");  params.append(req.display_name.strip())
    if req.password is not None:
        parts.append("password_hash=?"); params.append(_hash_password(req.password))
    if req.is_admin is not None:
        parts.append("is_admin=?");      params.append(1 if req.is_admin else 0)
    if not parts:
        return True
    params.append(user_id)
    with closing(_users_conn()) as conn:
        c = conn.execute(f"UPDATE users SET {', '.join(parts)} WHERE id=?", params)
        conn.commit()
        _invalidate_user_cache()   # demotion / password change takes effect now
        return c.rowcount > 0


def delete_user(user_id: int) -> bool:
    with closing(_users_conn()) as conn:
        c = conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        conn.commit()
        _invalidate_user_cache()   # deleted user loses access now
        return c.rowcount > 0


# ─── Session cookie helpers ────────────────────────────────────────────────
def _cookie_payload(user: dict) -> dict:
    uname = user.get("username") or user.get("slug") or ""
    return {
        "user_id":  user.get("id"),
        "name":     user.get("display_name") or user.get("name") or uname,
        "slug":     uname,
        "email":    user_email(uname),
        "is_admin": bool(user.get("is_admin", False)),
        "iat":      int(time.time()),
    }


def read_cookie_value(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        return _SIGNER.loads(raw, max_age=COOKIE_TTL_DAYS * 86400)
    except (SignatureExpired, BadSignature):
        return None


def set_session_cookie(response: Response, user: dict) -> dict:
    payload = _cookie_payload(user)
    response.set_cookie(
        key=COOKIE_NAME,
        value=_SIGNER.dumps(payload),
        max_age=COOKIE_TTL_DAYS * 86400,
        httponly=True,
        secure=TRUST_PROXY,
        samesite="lax",
        path="/",
    )
    return payload


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=COOKIE_NAME, path="/",
        secure=TRUST_PROXY, httponly=True, samesite="lax",
    )


# ─── ASGI middleware: populates request.state ─────────────────────────────
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp


class SessionMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        request.state.user_email    = None
        request.state.user_name     = None
        request.state.user_is_admin = False
        request.state.gate_enabled  = GATE_ENABLED

        if not GATE_ENABLED:
            request.state.user_email    = LEGACY_USER_EMAIL
            request.state.user_name     = LEGACY_USER_NAME
            request.state.user_is_admin = True   # dev mode: full access
            return await call_next(request)

        payload = read_cookie_value(request.cookies.get(COOKIE_NAME))
        if payload:
            # Re-check the signed cookie against the users DB: a deleted user must lose
            # access immediately (not after the 30-day cookie TTL), and admin rights must
            # come from the DB's CURRENT is_admin — not the cookie — so a demotion can't be
            # self-reversed with a stale is_admin:true cookie.
            current = resolve_current_user(payload.get("slug") or "")
            if current is None:
                pass  # user deleted — leave request unauthenticated
            elif current is _DB_UNAVAILABLE:
                # Couldn't verify (transient DB error) — fall back to the signed cookie.
                request.state.user_email    = payload.get("email") or LEGACY_USER_EMAIL
                request.state.user_name     = payload.get("name")  or "Anonymous"
                request.state.user_is_admin = bool(payload.get("is_admin", False))
            else:
                request.state.user_email    = user_email(current["username"])
                request.state.user_name     = current["display_name"] or "Anonymous"
                request.state.user_is_admin = bool(current["is_admin"])

        return await call_next(request)


# ─── FastAPI dependencies ──────────────────────────────────────────────────
def require_user(request: Request) -> str:
    email = getattr(request.state, "user_email", None)
    if not email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="auth required")
    return email


def require_admin(request: Request) -> str:
    email = getattr(request.state, "user_email", None)
    if not email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="auth required")
    if not getattr(request.state, "user_is_admin", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin required")
    return email


def current_user_optional(request: Request) -> Optional[str]:
    return getattr(request.state, "user_email", None)

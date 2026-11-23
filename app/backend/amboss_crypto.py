"""
AMBOSS content decryption.

Reverse-engineered from the iMedicalDoctor APK (`net.imedicaldoctor.imd`) — the
same app that ships UpToDate. The outer-two-layer chain (DS -> inner_hex,
ActivationCode -> license_str, extract `content_password`) is identical to the
UTD path; AMBOSS only swaps the Layer-3 salt source.

Layer 3 (per-row):
    salt   = str(doc_id).ljust(8).encode()
    aes_key = PBKDF2_SHA1(CONTENT_PW, salt, iters=19, keylen=16)
    raw    = AES_CBC(aes_key, N0_IV).decrypt(base64_decode(doc))
    html   = gzip_decompress(raw)

All 6,930 rows in `Docs` decrypt successfully with this scheme (verified
2026-04-20, 2.4 GB of HTML).

The constants are cached in `.env` for reuse, but hardcoded here as a
fallback so the module works out-of-the-box for the 2025 bundle. Override
via environment variables if the app rotates its key material.
"""
from __future__ import annotations

import base64
import hashlib
import os
import zlib
from functools import lru_cache
from typing import Optional

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad


# ─── Defaults (valid for net.imedicaldoctor.imd 2025 bundle) ─────────────────
_DEFAULT_CONTENT_PW = "hs;d,hghdk[;ak"
_DEFAULT_N0_IV_HEX  = "1173696667686f6b6c7a787776626e6d"


# ─── Public accessors ────────────────────────────────────────────────────────

def get_content_password() -> str:
    """The shared AES passphrase for all AMBOSS/UTD Layer-3 keys.

    Reads from AMBOSS_CONTENT_PW env var first (or IMD_CONTENT_PW fallback),
    falls back to the known 2025 value extracted from the APK.
    """
    return (
        os.environ.get("AMBOSS_CONTENT_PW")
        or os.environ.get("IMD_CONTENT_PW")
        or _DEFAULT_CONTENT_PW
    )


def get_n0_iv() -> bytes:
    """Layer-3 AES-CBC initialization vector."""
    hex_ = os.environ.get("AMBOSS_N0_IV_HEX") or _DEFAULT_N0_IV_HEX
    return bytes.fromhex(hex_)


# ─── Core decryptor ──────────────────────────────────────────────────────────

def _derive_key(doc_id: int, content_pw: str) -> bytes:
    salt = str(doc_id).ljust(8).encode("utf-8")
    return hashlib.pbkdf2_hmac("sha1", content_pw.encode("utf-8"), salt, 19, 16)


def decrypt_doc(
    doc_id: int,
    payload_b64: str,
    *,
    content_pw: Optional[str] = None,
    iv: Optional[bytes] = None,
) -> str:
    """Decrypt one `Docs.doc` row and return UTF-8 HTML.

    Args:
        doc_id:      The row's integer id (used as the PBKDF2 salt).
        payload_b64: Base64-encoded ciphertext from `Docs.doc`.
        content_pw:  Override for the content password.
        iv:          Override for the AES IV.
    """
    pw = content_pw or get_content_password()
    iv_bytes = iv or get_n0_iv()

    ct = base64.b64decode(payload_b64)
    key = _derive_key(doc_id, pw)
    raw = AES.new(key, AES.MODE_CBC, iv_bytes).decrypt(ct)
    try:
        raw = unpad(raw, 16)
    except ValueError:
        # Some rows encode without PKCS#7 padding; gzip still unpacks cleanly.
        pass
    # gzip (wbits=31 == 16 + MAX_WBITS) is what the APK produces.
    return zlib.decompress(raw, 31).decode("utf-8", "replace")


# ─── Smoke test ──────────────────────────────────────────────────────────────

def self_test(db_path: str, sample_id: int = 1) -> dict:
    """Decrypt one row from `db_path` and report length + head.

    Returns a dict suitable for logging / health-check endpoints.
    """
    import sqlite3
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    row = c.execute(
        "SELECT id, title, doc FROM Docs WHERE id=?", (sample_id,)
    ).fetchone()
    c.close()
    if not row:
        return {"ok": False, "error": f"id={sample_id} not in Docs"}
    try:
        html = decrypt_doc(row[0], row[2])
        return {
            "ok": True,
            "id": row[0],
            "title": row[1],
            "html_len": len(html),
            "head": html[:200],
        }
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ─── LCID → id map (resolves internal article links) ────────────────────────

@lru_cache(maxsize=1)
def _build_lcid_map(db_path: str) -> dict:
    """Map `data-learningcard-id` ('xo0EVS') to Docs.id.

    AMBOSS article HTML links to other articles via `data-learningcard-id`,
    which is the filename stem of `Docs.path` (e.g. 'base/xo0EVS.html').
    Cached forever because the bundle is immutable during a server run.
    """
    import sqlite3
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = c.execute("SELECT id, path FROM Docs WHERE path IS NOT NULL").fetchall()
    finally:
        c.close()
    mapping: dict[str, int] = {}
    for doc_id, path in rows:
        if not path:
            continue
        # path looks like 'base/xo0EVS.html'; stem is 'xo0EVS'
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if stem:
            mapping[stem] = doc_id
    return mapping


def lcid_to_id(db_path: str, lcid: str) -> Optional[int]:
    """Resolve a learning-card id to its Docs.id, or None if unknown."""
    return _build_lcid_map(db_path).get(lcid)

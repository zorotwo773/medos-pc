"""
MedOS Unified FastAPI Backend

Features:
  - NVIDIA NIM (Llama 3.3 70B) RAG chat over FAISS vectorstore
  - Gemini 1.5 Flash proxy (AI tutor + Q-Bank generation)
  - Cliniccons disease database
  - Z-Anatomy definitions
  - All paths via .env — no hardcoded sibling references

Start:  python main.py
Docs:   http://localhost:8002/docs
"""
import os, json, sys, time, re, sqlite3, difflib, subprocess, threading, hashlib, asyncio
import ipaddress
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional, List
from functools import lru_cache
from urllib.parse import quote, unquote

# Force UTF-8 on stdout/stderr. The backend is launched with its streams redirected to
# backend.log/backend.err, where the embeddable Python defaults to cp1252. Printing a
# non-ASCII install path (e.g. a Cyrillic/CJK Windows username) — load_diseases() does
# this at boot — would otherwise raise UnicodeEncodeError and abort startup, leaving the
# status page stuck on "Backend starting…". The launcher also sets PYTHONUTF8=1; this is
# belt-and-suspenders for any other entry point. Mirrors build_book_chapter_index.py.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import httpx
from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
import fitz

# ─── Central configuration (imports .env automatically) ───────────────────
BASE = Path(__file__).parent
from config import (
    NVIDIA_API_KEY, NVIDIA_BASE_URL, NVIDIA_MODEL,
    GEMINI_API_KEY, GEMINI_MODEL, BACKEND_PORT, ALLOWED_ORIGINS,
    VECTORSTORE_PATH, ANATOMY_DEFS_PATH, HARRISONS_PATH,
    LIBRARY_PATH, LIBRARY_INDEX_DB, LEXI_DB_PATH, DRUG_REF_DB, GLOBAL_SEARCH_DB, ROOT,
    UTD_DB_PATH, AMBOSS_DIR,
)
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
LEXI_DB_PATH_RAW = os.getenv("LEXI_DB_PATH", "")

def _env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def _lan_url_from_ip(raw_value: Optional[str]) -> Optional[str]:
    """Return the browser URL for a safe, usable MEDOS_LAN_IP value."""
    if not isinstance(raw_value, str):
        return None
    if any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in raw_value):
        return None

    candidate = raw_value.strip()
    if not candidate or "%" in candidate:
        return None

    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None

    if address.is_unspecified or address.is_loopback or address.is_multicast:
        return None

    host = f"[{address.compressed}]" if address.version == 6 else address.compressed
    return f"http://{host}:3000"

# ─── Global state ─────────────────────────────────────────────────────────
rag_chain      = None
vectorstore    = None
harrisons_data: list = []
_library_sig_cache: dict[str, object] = {"at": 0.0, "sig": tuple()}
_reindex_lock  = threading.Lock()   # prevents duplicate concurrent reindex jobs

# Lightweight session bridge: app writes here, extension reads it to stay in sync
_session_state: dict = {
    "current_term": None,
    "current_source": None,   # amboss | utd | drug | qbank
    "current_id": None,
    "current_title": None,
    "qbank_active": False,
    "db": "step2",
    "updated_at": None,
}

# ─── Boot loaders ─────────────────────────────────────────────────────────
def load_diseases():
    global harrisons_data
    print(f"[boot] Loading clinical conditions from: {HARRISONS_PATH}")
    if not HARRISONS_PATH.exists():
        print(f"  WARN: {HARRISONS_PATH} not found — disease endpoints will return empty.")
        return
    try:
        raw = json.loads(HARRISONS_PATH.read_text(encoding="utf-8"))
        harrisons_data = raw if isinstance(raw, list) else raw.get("diseases", [])
        print(f"  OK — {len(harrisons_data)} diseases loaded.")
    except Exception as e:
        print(f"  ERROR: {e}")


def _disease_points(disease: dict) -> list[str]:
    points = disease.get("clinical_synthesis")
    if isinstance(points, list):
        return points
    legacy = disease.get("harrisons_synthesis")
    return legacy if isinstance(legacy, list) else []


def init_rag():
    global rag_chain, vectorstore
    if not NVIDIA_API_KEY:
        print("[boot] NVIDIA_API_KEY not set — /chat disabled.")
        return
    if not VECTORSTORE_PATH.exists():
        print(f"[boot] Vectorstore not found at {VECTORSTORE_PATH} — /chat disabled.")
        return
    try:
        sys.path.insert(0, str(VECTORSTORE_PATH.parent.parent))

        from langchain_community.vectorstores import FAISS
        from langchain_huggingface import HuggingFaceEmbeddings
        from langchain_openai import ChatOpenAI
        from langchain.chains import RetrievalQA
        from langchain.prompts import PromptTemplate

        print("[boot] Loading embedding model…")
        embeddings = HuggingFaceEmbeddings(
            model_name="BAAI/bge-large-en-v1.5",
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )
        print("[boot] Loading FAISS vectorstore…")
        vectorstore = FAISS.load_local(
            str(VECTORSTORE_PATH), embeddings,
            allow_dangerous_deserialization=True,
        )
        print(f"  OK — {vectorstore.index.ntotal} vectors.")

        llm = ChatOpenAI(
            base_url=NVIDIA_BASE_URL,
            api_key=NVIDIA_API_KEY,
            model=NVIDIA_MODEL,
            temperature=0.1,
            max_tokens=1024,
        )
        prompt = PromptTemplate(
            template="""You are an expert medical assistant for clinical reference and USMLE preparation.
Use ONLY the provided context to answer. Be specific and cite pathophysiology.
If the context does not contain the answer, say so clearly.

Context:
{context}

Question: {question}

Answer:""",
            input_variables=["context", "question"],
        )
        rag_chain = RetrievalQA.from_chain_type(
            llm=llm, chain_type="stuff",
            retriever=vectorstore.as_retriever(search_kwargs={"k": 5}),
            chain_type_kwargs={"prompt": prompt},
            return_source_documents=True,
        )
        print("[boot] RAG chain ready.")
    except Exception as e:
        print(f"[boot] RAG init error: {e}")
        rag_chain = None


# ─── Lifespan ─────────────────────────────────────────────────────────────
def _install_quiet_asyncio_handler() -> None:
    """Swallow the benign ConnectionResetError [WinError 10054] that the Windows asyncio
    Proactor logs when a client (browser, boot health-poller, Next proxy) drops a
    keep-alive/HTTP connection mid-response. It never affects serving — /health keeps
    returning 200 — but it spams backend.err with scary tracebacks and tripped the boot
    status page's naive 'error' detector, making a healthy backend look crashed. Real
    application errors flow through FastAPI's handlers, not this loop hook, so they are
    unaffected; anything that isn't a connection drop is still passed through."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    previous = loop.get_exception_handler()

    def handler(loop, context):
        exc = context.get("exception")
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        msg = context.get("message", "")
        if "_call_connection_lost" in msg or "_ProactorBasePipeTransport" in msg:
            return
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _install_quiet_asyncio_handler()
    # Critical path — must finish before we `yield` (i.e. before uvicorn reports
    # "startup complete" and begins serving). Keep this fast: only diseases JSON
    # and the admin-user seed, which auth needs to answer the very first /me.
    load_diseases()
    _auth.ensure_admin_user()

    # Everything below is HEAVY and must NOT block ASGI startup. uvicorn binds
    # :8002 and accepts TCP connections before `yield` returns, but it queues
    # every HTTP request until then — so a slow warm-up here makes /health, /me,
    # /auth/logout and /qbank/* all hang for minutes. The app then loads in a
    # degraded "yellow" state (no user, no counts) and sign-out silently fails
    # until warm-up finishes. Run it on background threads instead: the backend
    # serves within seconds; /chat and global search light up a little later and
    # already degrade gracefully when their indexes aren't ready yet.
    def _warm_rag():
        try:
            init_rag()
        except Exception as e:
            print(f"[boot] RAG init skipped: {e}")

    def _warm_search():
        try:
            global_search_db = GLOBAL_SEARCH_DB
            if _env("MEDOS_REBUILD_GLOBAL_SEARCH").lower() in {"1", "true", "yes"} or not global_search_db.exists():
                print("[search] building global search index...")
                subprocess.run(
                    [sys.executable, str(BASE / "scripts" / "build_global_search_index.py")],
                    check=False,
                    timeout=240,
                )
            _warm_search_indexes()
            print("[search] interactive indexes warmed.")
        except Exception as e:
            print(f"[search] warm-up skipped: {e}")

    # Q-bank is the app's main feature, so it warms FIRST and alone: bank counts
    # for every installed bank, then the decrypt-heavy valid-ids sweep for the
    # banks the user actually studies (most recent activity first — that's how
    # we know which USMLE step they're preparing for). Every other heavy warm-up
    # waits for it. Without this ordering, the reference/search builds and the
    # q-bank's own first-use costs all fight for one cold disk, and the Q-bank
    # page loses: counts crawl in over minutes and the first Start block stalls.
    _qbank_warmed = threading.Event()

    def _warm_qbank():
        try:
            from qbank_reader import warm_qbank_boot
            warm_qbank_boot()
        except Exception as e:
            print(f"[qbank] warm-up skipped: {e}")
        finally:
            _qbank_warmed.set()

    def _after_qbank(fn):
        # Release even if the q-bank warm hangs — 6 banks × worst-case cold
        # decrypt sweeps; beyond this something is wrong and waiting longer
        # would just keep search//chat dark. The extra quiet window after the
        # warm matters too: these builds are GIL-heavy, and starting them the
        # instant the q-bank is ready made the user's FIRST "Start block"
        # (which lands right in that window) take ~8s instead of ~1s.
        def _run():
            _qbank_warmed.wait(timeout=600)
            time.sleep(90)
            fn()
        return _run

    threading.Thread(target=_warm_qbank, daemon=True).start()
    threading.Thread(target=_after_qbank(_warm_rag), daemon=True).start()
    threading.Thread(target=_after_qbank(_warm_search), daemon=True).start()
    # Library index warm-up delegated to the new library router. Stays immediate:
    # it's a quick in-memory metadata load the Library page needs right away.
    threading.Thread(target=_boot_lib, daemon=True).start()

    def _boot_torrent_seed():
        # In-app seeding while MedOS is open (default on). Never block HTTP.
        try:
            import torrent_fetch
            result = torrent_fetch.auto_start_seed()
            print(f"[torrent] auto-seed: {result.get('detail') or result}")
        except Exception as e:
            print(f"[torrent] auto-seed skipped: {e}")

    threading.Thread(target=_boot_torrent_seed, daemon=True).start()
    if _env("MEDOS_SKIP_REFERENCE_WARMUP").lower() in {"1", "true", "yes"}:
        print("[reference] warm-up skipped by MEDOS_SKIP_REFERENCE_WARMUP.")
    else:
        def _warm_reference():
            try:
                import reference_reader
                # Background CPU/IO priority: this build reads GBs off a cold
                # disk at boot and must lose every scheduling fight against
                # interactive requests (/qbank/list hung for minutes when it
                # didn't — the "Start block spinner forever" bug).
                reference_reader._enter_background_thread_mode()
                for db in ("step2", "step1", "step3"):
                    reference_reader.warm_reference_index(db)
                print("[reference] hover index warmed.")
            except Exception as e:
                print(f"[reference] warm-up skipped: {e}")
        threading.Thread(target=_after_qbank(_warm_reference), daemon=True).start()
    # LAN auto-sync: discover sibling MedOS devices on the local network and
    # keep Q-Bank progression unioned across all of them, no manual export.
    try:
        import lan_sync
        lan_sync.start(http_port=BACKEND_PORT, lan_ip=_env("MEDOS_LAN_IP"))
    except Exception as e:
        print(f"[sync] LAN auto-sync not started: {e}")
    yield
    print("[shutdown] MedOS backend stopped.")


# ─── App ──────────────────────────────────────────────────────────────────
app = FastAPI(title="MedOS API", version="1.0.0", lifespan=lifespan)

# Auth gate (no-op in dev if MEDOS_SESSION_SECRET is unset; see auth.GATE_ENABLED).
# Must be added BEFORE CORSMiddleware so cookies are populated by the time
# any route runs. Starlette wraps middleware in reverse order of `add_middleware`
# calls, so the last add_middleware runs first — see Starlette docs.
import auth as _auth

# CORS needs allow_credentials=True so the browser includes the session cookie
# on cross-origin XHR (e.g. when running `next dev` on :3000 against a backend
# on :8002). In production everything is same-origin via nginx, so this is
# only relevant during development.
_cors_origins = ALLOWED_ORIGINS if ALLOWED_ORIGINS else ["http://localhost:3000"]
_cors_origin_regex = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|0\.0\.0\.0|"
    r"10(?:\.\d{1,3}){3}|"
    r"192\.168(?:\.\d{1,3}){2}|"
    r"172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}"
    r")(?::\d+)?$"
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(_auth.SessionMiddleware)

# The network policy must execute before auth, CORS, and all route handling.
# Starlette reverses add_middleware order, so this security boundary is added last.
from network_access import NetworkAccessMiddleware as _NetworkAccessMiddleware
app.add_middleware(_NetworkAccessMiddleware)

# ─── PDF.js Viewer ────────────────────────────────────────────────────────
PDFJS_DIR = BASE / "static" / "pdfjs"
if PDFJS_DIR.exists():
    app.mount("/pdfjs", StaticFiles(directory=str(PDFJS_DIR)), name="pdfjs")

# ─── Shared media interoperability runtime ───────────────────────────────
from media_interop import router as media_interop_router
app.include_router(media_interop_router)

# ─── UpToDate reader (router + static assets) ────────────────────────────
from utd_reader import router as utd_router, STATIC_DIR as _UTD_STATIC
app.include_router(utd_router)
if _UTD_STATIC.exists():
    app.mount(
        "/utd/static",
        StaticFiles(directory=str(_UTD_STATIC)),
        name="utd_static",
    )

# ─── AMBOSS reader (router + static assets) ──────────────────────────────
from amboss_reader import (
    router as amboss_router,
    STATIC_DIR as _AMBOSS_STATIC,
    images_dir as _amboss_images_dir,
)
app.include_router(amboss_router)
if _AMBOSS_STATIC.exists():
    app.mount(
        "/amboss/static",
        StaticFiles(directory=str(_AMBOSS_STATIC)),
        name="amboss_static",
    )
# Serve the bundle's Images/ folder so runtime-decoded `../Images/…` references
# (inside base64 `data-content` blobs our HTML rewriter can't see) resolve
# correctly relative to `/amboss/article/{id}`.
_amb_imgs = _amboss_images_dir()
if _amb_imgs is not None:
    app.mount(
        "/amboss/Images",
        StaticFiles(directory=str(_amb_imgs)),
        name="amboss_images",
    )

# ─── UWorld Library reader (router + bundled images) ─────────────────────
from uworld_library_reader import (
    router as uworld_library_router,
    images_dir as _uworld_library_images_dir,
)
app.include_router(uworld_library_router)
_uwlib_imgs = _uworld_library_images_dir()
if _uwlib_imgs is not None:
    app.mount(
        "/uworld-library/Images",
        StaticFiles(directory=str(_uwlib_imgs)),
        name="uworld_library_images",
    )

# ─── Q-Bank reader ────────────────────────────────────────────────────────
from qbank_reader import router as qbank_router
app.include_router(qbank_router)

# ─── Clinic Consult algorithm reference reader ────────────────────────────
from cliniccons_reader import router as cliniccons_router
app.include_router(cliniccons_router)

# ─── ACLS algorithm poster images ──────────────────────────────────────────
from acls_reader import router as acls_router
app.include_router(acls_router)

# ─── UpToDate Pathways — interactive clinical decision journeys ─────────────
from pathways_reader import router as pathways_router
app.include_router(pathways_router)

# ─── Central reference hover scanner ───────────────────────────────────────
from reference_reader import router as reference_router
app.include_router(reference_router)

# ─── Custom Library — user-authored folders, saved links, copies, notes ────
from routers.custom import router as _custom_router
app.include_router(_custom_router)

# ─── Offline PDF export (top-right Export PDF action) ───────────────────
from routers.export import router as _export_router
app.include_router(_export_router)

# ─── Phase-1 routers (take precedence over legacy app-level routes) ───────
from routers.library  import router as _library_router,  boot_library_index as _boot_lib
from routers.search   import router as _search_router, warm_search_indexes as _warm_search_indexes
from routers.glossary import router as _glossary_router
from routers.firstaid import router as _firstaid_router
from routers.ao       import router as _ao_router
from routers.lexi_calc import router as _lexi_calc_router
from routers.drugs     import router as _drugs_router
from routers.anki      import router as _anki_router
from routers.umls         import router as _umls_router
from routers.medlineplus  import router as _medlineplus_router
from routers.openfda      import router as _openfda_router
from routers.trials       import router as _trials_router
from routers.sanford      import router as _sanford_router
from routers.utd_ddx      import router as _utdddx_router
app.include_router(_library_router)
app.include_router(_search_router)
app.include_router(_glossary_router)
app.include_router(_firstaid_router)
app.include_router(_ao_router)
app.include_router(_lexi_calc_router)
app.include_router(_drugs_router)
app.include_router(_sanford_router)
app.include_router(_utdddx_router)
app.include_router(_anki_router)
app.include_router(_umls_router)
app.include_router(_medlineplus_router)
app.include_router(_openfda_router)
app.include_router(_trials_router)

# ─── Unified activity / progression tracking ──────────────────────────────
from routers.activity import router as _activity_router
app.include_router(_activity_router)

# ─── LAN auto-sync (peer-to-peer Q-Bank progression across devices) ────────
from routers.sync import router as _sync_router
app.include_router(_sync_router)

# ─── On-device content management (phone pulls books/modules over the LAN) ──
from routers.content import router as _content_router
app.include_router(_content_router)

# ─── Host-only network access control ─────────────────────────────────────
from routers.network_access import router as _network_access_router
app.include_router(_network_access_router)


# ─── Backwards-compat alias: /dashboard/search → /search/legacy ───────────
@app.get("/dashboard/search")
def dashboard_search_compat(
    q:      str = Query(..., min_length=1, max_length=200),
    scopes: str = Query(default="all"),
    limit:  int = Query(default=18, ge=1, le=50),
):
    """Legacy dashboard search endpoint — delegates to the new /search router."""
    from routers.search import dashboard_search_legacy
    return dashboard_search_legacy(q=q, scopes=scopes, limit=limit)


# ─── Pydantic request / response models ───────────────────────────────────
class ChatRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=1000)
    model: Optional[str] = Field(default="nvidia-llama70b", max_length=60)

    @field_validator("question")
    @classmethod
    def no_injections(cls, v: str) -> str:
        # Strip leading/trailing whitespace; reject if only whitespace
        v = v.strip()
        if not v:
            raise ValueError("question must not be blank")
        return v


class ChatResponse(BaseModel):
    answer: str
    sources: list
    model: str
    elapsed: float


class TutorRequest(BaseModel):
    question: str  = Field(..., min_length=3, max_length=1000)
    context: str   = Field(..., min_length=10, max_length=8000,
                           description="Chapter text excerpt to answer from")
    chapter_title: str = Field(default="", max_length=200)

    @field_validator("question", "context")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        return v.strip()


class GenerateQuestionRequest(BaseModel):
    topic: str       = Field(..., min_length=2, max_length=100)
    difficulty: str  = Field(default="medium", pattern=r"^(easy|medium|hard)$")

    @field_validator("topic")
    @classmethod
    def clean_topic(cls, v: str) -> str:
        # Allow only alphanumeric + spaces + common punctuation
        v = v.strip()
        if not re.match(r"^[A-Za-z0-9 ,\-/&]+$", v):
            raise ValueError("topic contains invalid characters")
        return v


class LibraryAnalyzeRequest(BaseModel):
    text: str  = Field(..., min_length=50, max_length=10000,
                       description="Extracted PDF text to analyse")
    filename: str = Field(default="unknown.pdf", max_length=200)

    @field_validator("filename")
    @classmethod
    def safe_filename(cls, v: str) -> str:
        # Strip path components
        return Path(v).name


AI_PROVIDER_FAILURE = "AI provider request failed. Check backend logs for details."
AI_MALFORMED_JSON = "AI provider returned malformed JSON."


def _log_ai_failure(context: str, detail: object) -> None:
    print(f"[ai] {context}: {str(detail)[:600]}")


# ─── Gemini helper ────────────────────────────────────────────────────────
async def _gemini(prompt: str) -> str:
    """Send a prompt to Gemini 1.5 Flash and return the text response."""
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503,
            detail="AI features are paused in this build. Coming soon.")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
        )
    if resp.status_code != 200:
        _log_ai_failure("Gemini API error", f"{resp.status_code}: {resp.text[:600]}")
        raise HTTPException(status_code=502, detail=AI_PROVIDER_FAILURE)
    try:
        data = resp.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        _log_ai_failure("Gemini response parse error", e)
        raise HTTPException(status_code=502, detail=AI_PROVIDER_FAILURE)


# ─── Routes ───────────────────────────────────────────────────────────────
@app.get("/")
def root():
    return {
        "name": "MedOS API", "version": "1.0.0",
        "rag": rag_chain is not None,
        "diseases": len(harrisons_data),
        "docs": "/docs",
    }


# ─── Auth endpoints ───────────────────────────────────────────────────────
from fastapi import Request as _AuthRequest, Response as _AuthResponse


@app.post("/auth/login", response_model=_auth.MeResponse)
def auth_login(body: _auth.LoginRequest, response: _AuthResponse):
    if not _auth.GATE_ENABLED:
        # Dev mode: accept any credentials, set a cookie so the Next.js middleware
        # doesn't redirect back to /login on every request.
        _auth.set_session_cookie(response, {
            "username": "local",
            "display_name": _auth.LEGACY_USER_NAME,
            "is_admin": True,
        })
        return _auth.MeResponse(
            authenticated=True,
            name=_auth.LEGACY_USER_NAME,
            email=_auth.LEGACY_USER_EMAIL,
            is_admin=True,
            gate_enabled=False,
        )
    try:
        user = _auth.verify_credentials(body.username, body.password)
    except _auth.UsersDatabaseUnavailable as error:
        # Usually a portable install whose recorded data drive is not connected.
        # Reporting this as bad credentials sent people hunting for a lost password.
        print(f"[auth] accounts database unavailable: {error}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="accounts database unavailable",
        ) from error
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")
    payload = _auth.set_session_cookie(response, user)
    return _auth.MeResponse(
        authenticated=True,
        name=payload.get("name"),
        email=payload.get("email"),
        is_admin=bool(user.get("is_admin", False)),
        gate_enabled=True,
    )


@app.post("/auth/logout")
def auth_logout(response: _AuthResponse):
    _auth.clear_session_cookie(response)
    return {"ok": True}


@app.get("/me", response_model=_auth.MeResponse)
def auth_me(request: _AuthRequest):
    email = getattr(request.state, "user_email", None)
    return _auth.MeResponse(
        authenticated=bool(email) and _auth.GATE_ENABLED,
        name=getattr(request.state, "user_name", None),
        email=email,
        is_admin=getattr(request.state, "user_is_admin", False),
        gate_enabled=_auth.GATE_ENABLED,
    )


# ─── Admin: user management ───────────────────────────────────────────────
# Dev mode (no SESSION_SECRET): open to all. Prod mode: admin cookie required.

@app.get("/admin/users")
def admin_list_users(request: _AuthRequest):
    if _auth.GATE_ENABLED:
        _auth.require_admin(request)
    return _auth.list_users()


@app.post("/admin/users", status_code=201)
def admin_create_user(body: _auth.CreateUserRequest, request: _AuthRequest):
    if _auth.GATE_ENABLED:
        _auth.require_admin(request)
    try:
        return _auth.create_user(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/admin/users/{user_id}")
def admin_update_user(user_id: int, body: _auth.UpdateUserRequest, request: _AuthRequest):
    if _auth.GATE_ENABLED:
        _auth.require_admin(request)
    if not _auth.update_user(user_id, body):
        raise HTTPException(status_code=404, detail="user not found")
    return {"ok": True}


@app.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: int, request: _AuthRequest):
    if _auth.GATE_ENABLED:
        _auth.require_admin(request)
    if not _auth.delete_user(user_id):
        raise HTTPException(status_code=404, detail="user not found")
    return {"ok": True}


_HELP_DOCS = {
    "user-guide": ("MedOS_USER_GUIDE.md", "MedOS User Guide"),
    "readme":     ("README.md", "README"),
}


@app.get("/help/{doc}")
def get_help_doc(doc: str):
    """Serve the shipped user-facing docs (User Guide, README) to the in-app
    documentation viewer. They live at the MedOS root (one level above app/)."""
    entry = _HELP_DOCS.get(doc)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown doc")
    filename, title = entry
    # The docs live in the MedOS folder (app/../). Anchor to the backend SOURCE
    # location first — it is always app/backend/ regardless of cwd or a MEDOS_ROOT
    # override that points at an external data drive.
    app_root = Path(__file__).resolve().parents[2]   # app/backend/main.py → MedOS/
    for base in (app_root, ROOT, ROOT.parent, Path.cwd(), Path.cwd().parent):
        try:
            text = (base / filename).read_text(encoding="utf-8", errors="replace")
            return {"title": title, "markdown": text}
        except Exception:
            continue
    raise HTTPException(status_code=404, detail="document not found on disk")


@app.get("/health")
def health():
    from utd_content import configured_bundle_dir, content_status
    utd_bundle = configured_bundle_dir(UTD_DB_PATH)
    utd_ok = (
        (utd_bundle / "utdtoc.db").exists()
        and (utd_bundle / "unidex.en.sqlite").exists()
        and content_status(utd_bundle)["ready"]
    )
    amboss_ok = (AMBOSS_DIR / "amboss-2025.db").exists()
    cliniccons_ok = bool(harrisons_data)

    chunks = int(vectorstore.index.ntotal) if vectorstore is not None else 0

    books = 0
    try:
        books = len(_library_books_index())
    except Exception:
        pass

    models_available: list[str] = []
    if rag_chain is not None:
        models_available.append("nvidia")
    if NVIDIA_API_KEY:
        models_available.append("nvidia-direct")
    if GEMINI_API_KEY:
        models_available.append("gemini")

    lan_url = _lan_url_from_ip(os.getenv("MEDOS_LAN_IP"))

    drug_reference = {"exists": DRUG_REF_DB.exists(), "path": str(DRUG_REF_DB), "drug_count": 0}
    if DRUG_REF_DB.exists():
        try:
            c = sqlite3.connect(f"file:{DRUG_REF_DB}?mode=ro", uri=True)
            try:
                drug_reference["drug_count"] = int(c.execute("SELECT COUNT(*) FROM drugs").fetchone()[0] or 0)
            finally:
                c.close()
        except Exception as exc:
            drug_reference["error"] = str(exc)

    return {
        "status": "ok",
        "lan_url": lan_url,
        "rag": rag_chain is not None,
        "diseases": len(harrisons_data),
        "vectorstore": vectorstore is not None,
        "chunks": chunks,
        "nvidia_model": NVIDIA_MODEL if rag_chain else None,
        "gemini": bool(GEMINI_API_KEY),
        "books": books,
        "corpora": {
            "utd": utd_ok,
            "amboss": amboss_ok,
            "cliniccons": cliniccons_ok,
            "harrisons": False,
            "drug_reference": drug_reference["exists"],
        },
        "drug_reference": drug_reference,
        "models_available": models_available,
    }


# ── RAG chat ───────────────────────────────────────────────────────────────
@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    start = time.time()
    model_id = (req.model or "nvidia").lower()

    # Gemini direct path — no RAG retrieval, pure LLM
    if model_id == "gemini":
        if not GEMINI_API_KEY:
            raise HTTPException(status_code=503, detail="AI features are paused in this build. Coming soon.")
        prompt = f"""You are a concise medical assistant for clinical reference and USMLE preparation.
Answer the following question accurately. Use clear structure (bullet points or short paragraphs).
If uncertain, say so explicitly rather than guessing.

Question: {req.question}

Answer:"""
        answer = await _gemini(prompt)
        return ChatResponse(
            answer=answer, sources=[], model=GEMINI_MODEL,
            elapsed=round(time.time() - start, 2),
        )

    # NVIDIA NIM RAG path (default)
    if not rag_chain:
        raise HTTPException(status_code=503,
            detail="AI features are paused in this build. Coming soon.")
    try:
        result = rag_chain.invoke({"query": req.question})
        sources = [
            {
                "source": Path(doc.metadata.get("source", "Unknown")).name,
                "page": doc.metadata.get("page", 0),
                "content": doc.page_content[:200],
            }
            for doc in result.get("source_documents", [])
        ]
        return ChatResponse(
            answer=result.get("result", "No answer generated."),
            sources=sources,
            model=NVIDIA_MODEL,
            elapsed=round(time.time() - start, 2),
        )
    except Exception as e:
        _log_ai_failure("RAG chat failed", e)
        raise HTTPException(status_code=500, detail="AI chat failed. Check backend logs for details.")


# ── NVIDIA Direct chat (streaming, vision-capable) ────────────────────────
class NvidiaDirectRequest(BaseModel):
    question: str   = Field(..., min_length=1, max_length=4000)
    image_b64: Optional[str]  = Field(default=None, description="Base64-encoded image (no data-URL prefix)")
    image_mime: Optional[str] = Field(default="image/jpeg", description="MIME type of the image")
    model: Optional[str]      = Field(default=None, max_length=100)
    enable_thinking: bool      = Field(default=True)


@app.post("/chat/nvidia-direct")
async def chat_nvidia_direct(req: NvidiaDirectRequest):
    """
    Direct NVIDIA NIM endpoint — no RAG retrieval, streams the response
    as Server-Sent Events (text/event-stream).

    Supports vision: include image_b64 (base64 string, no prefix) and
    image_mime to send an image with the question.
    """
    if not NVIDIA_API_KEY:
        raise HTTPException(status_code=503, detail="AI features are paused in this build. Coming soon.")

    model_name = (req.model or NVIDIA_MODEL or "google/gemma-4-31b-it").strip()

    # Build message content — text only or multimodal
    if req.image_b64:
        content = [
            {"type": "text", "text": req.question},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{req.image_mime};base64,{req.image_b64}"
                },
            },
        ]
    else:
        content = req.question

    payload: dict = {
        "model": model_name,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 16384,
        "temperature": 0.7,
        "top_p": 0.95,
        "stream": True,
    }

    # Gemma 4 supports extended thinking
    if "gemma-4" in model_name.lower():
        payload["chat_template_kwargs"] = {"enable_thinking": req.enable_thinking}

    import json as _json

    async def _stream():
        async with httpx.AsyncClient(timeout=180) as client:
            async with client.stream(
                "POST",
                f"{NVIDIA_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {NVIDIA_API_KEY}",
                    "Accept": "text/event-stream",
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as r:
                if r.status_code != 200:
                    body = await r.aread()
                    err_text = body.decode(errors="replace")[:300].replace('"', "'")
                    _log_ai_failure("NVIDIA direct stream error", f"{r.status_code}: {err_text}")
                    # Emit as a regular content chunk so the frontend displays it
                    fake_chunk = {
                        "choices": [{"delta": {"content": f"\n\n**Error {r.status_code}:** {AI_PROVIDER_FAILURE}"}}]
                    }
                    yield f"data: {_json.dumps(fake_chunk)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:].strip()
                    if raw in ("[DONE]", "[KEEPALIVE]", ""):
                        yield f"data: {raw}\n\n"
                        continue
                    try:
                        obj = _json.loads(raw)
                        delta = obj.get("choices", [{}])[0].get("delta", {})
                        content  = delta.get("content") or ""
                        thinking = delta.get("reasoning_content") or ""
                        if content:
                            yield f"data: {_json.dumps({'choices':[{'delta':{'content': content}}]})}\n\n"
                        elif thinking:
                            # Stream thinking as italic grey text
                            yield f"data: {_json.dumps({'choices':[{'delta':{'content': thinking, 'thinking': True}}]})}\n\n"
                    except Exception as e:
                        _log_ai_failure("NVIDIA stream parse skipped", e)

    from fastapi.responses import StreamingResponse as _SR
    return _SR(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── AI Tutor (Gemini proxy — chapter Q&A) ─────────────────────────────────
@app.post("/ai/tutor")
async def ai_tutor(req: TutorRequest):
    prompt = f"""You are a medical AI tutor. Based on the chapter content below, answer the student's question clearly and educationally. Be concise but thorough.

CHAPTER: "{req.chapter_title}"
CONTENT: {req.context[:3000]}

QUESTION: {req.question}

Answer:"""
    answer = await _gemini(prompt)
    return {"answer": answer}


# ── Question generation (Gemini proxy) ────────────────────────────────────
@app.post("/ai/generate-question")
async def generate_question(req: GenerateQuestionRequest):
    prompt = f"""Generate a USMLE Step 1 style multiple choice question about {req.topic}. Difficulty: {req.difficulty}.
Return ONLY valid JSON — no markdown fences:
{{
  "question": "Clinical vignette here",
  "options": ["A ...", "B ...", "C ...", "D ..."],
  "correctIndex": 0,
  "explanation": "Detailed explanation here",
  "topic": "{req.topic}",
  "difficulty": "{req.difficulty}"
}}"""
    raw = await _gemini(prompt)
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise HTTPException(status_code=502, detail=AI_MALFORMED_JSON)
    try:
        q = json.loads(match.group())
    except json.JSONDecodeError as e:
        _log_ai_failure("question JSON parse error", e)
        raise HTTPException(status_code=502, detail=AI_MALFORMED_JSON)
    # Validate shape
    required = {"question", "options", "correctIndex", "explanation"}
    if not required.issubset(q):
        raise HTTPException(status_code=502, detail="Gemini response missing required fields")
    if not isinstance(q["options"], list) or len(q["options"]) < 2:
        raise HTTPException(status_code=502, detail="options must be a list with ≥2 items")
    return q


# ── Library PDF analysis (Gemini proxy) ───────────────────────────────────
@app.post("/ai/analyze-pdf")
async def analyze_pdf(req: LibraryAnalyzeRequest):
    prompt = f"""You are a medical education expert. Analyse this medical textbook excerpt and organise it into body systems and chapters.
Return ONLY valid JSON — no markdown fences:
{{
  "title": "book title",
  "author": "author name or Unknown",
  "systems": [
    {{ "name": "Cardiology", "chapters": [{{"title": "...", "content": "first 200 chars"}}] }}
  ]
}}

TEXT (truncated):
{req.text[:6000]}"""
    raw = await _gemini(prompt)
    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise HTTPException(status_code=502, detail=AI_MALFORMED_JSON)
    try:
        result = json.loads(match.group())
    except json.JSONDecodeError as e:
        _log_ai_failure("PDF analysis JSON parse error", e)
        raise HTTPException(status_code=502, detail=AI_MALFORMED_JSON)
    result.setdefault("title", req.filename.replace(".pdf", ""))
    result.setdefault("systems", [])
    return result


# ── Library Native Endpoints ──────────────────────────────────────────────

def _reindex_bg(force: bool = False) -> None:
    """Fire-and-forget library reindex. Skips if already running."""
    if _reindex_lock.locked():
        return
    def _work():
        with _reindex_lock:
            try:
                _ensure_library_index(force=force)
            except Exception as e:
                print(f"[library] background reindex error: {e}")
    threading.Thread(target=_work, daemon=True).start()


def _read_books_from_db() -> list[dict]:
    """Read whatever is currently in the SQLite books table — never blocks on I/O."""
    # Do NOT call _library_index_init() here — that triggers os.walk on every
    # request which stalls for 10-15 s on a large library.  The index is built
    # at startup; reads just hit the pre-existing SQLite directly.
    c = _library_index_conn()
    try:
        rows = c.execute(
            "SELECT id, title, subtitle, href FROM books ORDER BY lower(title)"
        ).fetchall()
    finally:
        c.close()
    out = []
    for r in rows:
        href = r["href"] or ""
        rel = ""
        if "path=" in href:
            rel = unquote(href.split("path=", 1)[1])
        rel = (rel or r["id"] or "").replace("\\", "/")
        if not rel:
            continue
        filename = Path(rel).name
        subtitle = r["subtitle"] or ""
        folder = subtitle.removesuffix(" book").strip() or "General"
        out.append({
            "id": rel,
            "title": r["title"] or Path(rel).stem,
            "filename": filename,
            "folder": folder,
        })
    return out


# ── Dashboard search ────────────────────────────────────────────────────────
_DASHBOARD_SCOPE_ALIASES = {
    "all": "all",
    "uptodate": "uptodate",
    "amboss": "amboss",
    "books": "books",
    "anatomy": "anatomy",
    "calc": "calc",
    "calculators": "calc",
    "diseases": "meds",
    "lexi": "lexi",
    "lexicomp": "lexi",
    "drugs": "drugs",
    "drug": "drugs",
    "medications": "drugs",
    "meds": "drugs",
}

_MEDICAL_NORMALIZATION = {
    "haem": "hem",
    "haemo": "hemo",
    "anaemia": "anemia",
    "paediatric": "pediatric",
    "oesophagus": "esophagus",
    "foetus": "fetus",
    "diarrhoea": "diarrhea",
    "tumour": "tumor",
    "oedema": "edema",
    "leukaemia": "leukemia",
}

_ABBREV_EXPANSIONS = {
    "hf": "heart failure",
    "chf": "congestive heart failure",
    "copd": "chronic obstructive pulmonary disease",
    "ckd": "chronic kidney disease",
    "cad": "coronary artery disease",
    "acs": "acute coronary syndrome",
    "af": "atrial fibrillation",
    "mi": "myocardial infarction",
    "dka": "diabetic ketoacidosis",
    "pe": "pulmonary embolism",
}

_CALCULATOR_SEARCH_INDEX = [
    {
        "id": "egfr",
        "title": "eGFR (CKD-EPI)",
        "subtitle": "Renal function and drug adjustment",
        "href": "/calculators?q=eGFR",
        "scope": "calc",
        "kind": "calculator",
        "search_text": "egfr ckd epi kidney renal creatinine drug adjustment",
    },
    {
        "id": "creatinine-clearance",
        "title": "Creatinine Clearance",
        "subtitle": "Cockcroft-Gault dosing support",
        "href": "/calculators?q=Creatinine Clearance",
        "scope": "calc",
        "kind": "calculator",
        "search_text": "creatinine clearance cockcroft gault renal dosing",
    },
    {
        "id": "meld-na",
        "title": "MELD-Na",
        "subtitle": "Liver disease severity",
        "href": "/calculators?q=MELD",
        "scope": "calc",
        "kind": "calculator",
        "search_text": "meld na cirrhosis liver transplant hepatology",
    },
    {
        "id": "curb-65",
        "title": "CURB-65",
        "subtitle": "Pneumonia severity",
        "href": "/calculators?q=CURB",
        "scope": "calc",
        "kind": "calculator",
        "search_text": "curb 65 pneumonia cap severity respiratory",
    },
    {
        "id": "bmi",
        "title": "BMI",
        "subtitle": "Body mass index",
        "href": "/calculators?q=BMI",
        "scope": "calc",
        "kind": "calculator",
        "search_text": "bmi body mass index obesity nutrition",
    },
    {
        "id": "chads-vasc",
        "title": "CHA2DS2-VASc",
        "subtitle": "Stroke risk in atrial fibrillation",
        "href": "/calculators?q=CHA2DS2",
        "scope": "calc",
        "kind": "calculator",
        "search_text": "cha2ds2 vasc af atrial fibrillation stroke anticoagulation",
    },
]

_ACRONYM_STOPWORDS = {"and", "of", "in", "to", "for", "the", "a", "an", "with"}


def _normalize_medical_text(text: str) -> str:
    value = (text or "").lower()
    for src, dst in _MEDICAL_NORMALIZATION.items():
        value = value.replace(src, dst)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _score_search_match(query_norm: str, text_norm: str) -> float:
    if not query_norm or not text_norm:
        return 0.0
    score = 0.0
    if query_norm == text_norm:
        score += 140.0
    if text_norm.startswith(query_norm):
        score += 50.0
    if query_norm in text_norm:
        score += 65.0

    q_tokens = query_norm.split()
    t_tokens = text_norm.split()
    token_hits = 0
    strong_fuzzy_hits = 0
    for tok in q_tokens:
        best_ratio = max((difflib.SequenceMatcher(None, tok, cand).ratio() for cand in t_tokens), default=0.0)
        if tok in t_tokens:
            token_hits += 1
            score += 18.0
            strong_fuzzy_hits += 1
        elif tok in text_norm:
            score += 8.0
        elif best_ratio >= 0.9:
            score += 18.0
            strong_fuzzy_hits += 1
        elif best_ratio >= 0.78:
            score += 9.0
        elif len(tok) >= 4:
            score -= 10.0
    if q_tokens and token_hits == len(q_tokens):
        score += 16.0
    elif len(q_tokens) > 1 and (token_hits + strong_fuzzy_hits) < len(q_tokens):
        score -= 18.0

    score += difflib.SequenceMatcher(None, query_norm, text_norm).ratio() * 45.0
    return score


def _title_acronym(title: str) -> str:
    words = re.findall(r"[A-Za-z]+", title.lower())
    words = [w for w in words if w not in _ACRONYM_STOPWORDS]
    if not words:
        return ""
    return "".join(w[0] for w in words[:6])


@lru_cache(maxsize=1)
def _amboss_acronym_index() -> list[dict]:
    db_path = AMBOSS_DIR / "amboss-2025.db"
    if not db_path.exists():
        return []
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT id, title FROM Docs WHERE title IS NOT NULL").fetchall()
    finally:
        c.close()
    out = []
    for r in rows:
        title = r["title"] or ""
        ac = _title_acronym(title)
        if len(ac) >= 2:
            out.append({
                "id": int(r["id"]),
                "title": title,
                "subtitle": f"AMBOSS article · {ac.upper()}",
                "href": f"/amboss?doc={int(r['id'])}",
                "scope": "amboss",
                "kind": "abbr",
                "search_text": f"{title} {ac}",
            })
    return out


@lru_cache(maxsize=1)
def _utd_acronym_index() -> list[dict]:
    db_path = UTD_DB_PATH / "unidex.en.sqlite"
    if not db_path.exists():
        return []
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT topic_id, title FROM topic WHERE title IS NOT NULL").fetchall()
    finally:
        c.close()
    out = []
    for r in rows:
        title = r["title"] or ""
        ac = _title_acronym(title)
        if len(ac) >= 2:
            out.append({
                "id": int(r["topic_id"]),
                "title": title,
                "subtitle": f"UpToDate topic · {ac.upper()}",
                "href": f"/uptodate?t={int(r['topic_id'])}",
                "scope": "uptodate",
                "kind": "abbr",
                "search_text": f"{title} {ac}",
            })
    return out


def _scope_set(raw_scopes: str) -> set[str]:
    cleaned = {
        _DASHBOARD_SCOPE_ALIASES[s.strip().lower()]
        for s in (raw_scopes or "all").split(",")
        if s.strip().lower() in _DASHBOARD_SCOPE_ALIASES
    }
    return cleaned or {"all"}


def _scope_enabled(scopes: set[str], scope: str) -> bool:
    return "all" in scopes or scope in scopes


def _query_amboss_fast(query: str, query_norm: str, limit: int) -> list[dict]:
    db_path = AMBOSS_DIR / "amboss-2025.db"
    if not db_path.exists():
        return []
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        seen: set[int] = set()
        out: list[dict] = []
        for pattern in (f"{query}%", f"%{query}%"):
            rows = c.execute(
                "SELECT id, title FROM Docs WHERE title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?",
                (pattern, limit),
            ).fetchall()
            for r in rows:
                rid = int(r["id"])
                if rid in seen:
                    continue
                seen.add(rid)
                out.append({
                    "id": rid,
                    "title": r["title"] or "",
                    "subtitle": "AMBOSS article",
                    "href": f"/amboss?doc={rid}",
                    "scope": "amboss",
                    "kind": "article",
                    "search_text": r["title"] or "",
                })
                if len(out) >= limit:
                    break
            if len(out) >= limit:
                break

        # Include chapter-level TOC entries for faster structured navigation.
        toc_rows = c.execute(
            "SELECT id, name, docId FROM TOC WHERE docId > 0 AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?",
            (f"{query}%", max(4, limit // 2)),
        ).fetchall()
        for r in toc_rows:
            doc_id = int(r["docId"])
            if doc_id in seen:
                continue
            out.append({
                "id": f"toc-{int(r['id'])}",
                "title": r["name"] or "",
                "subtitle": "AMBOSS chapter",
                "href": f"/amboss?doc={doc_id}",
                "scope": "amboss",
                "kind": "chapter",
                "search_text": r["name"] or "",
            })
    finally:
        c.close()
    return out


def _query_utd_fast(query: str, query_norm: str, limit: int) -> list[dict]:
    qf_path = UTD_DB_PATH / "utdqf.sqlite"
    idx_path = UTD_DB_PATH / "unidex.en.sqlite"
    out: list[dict] = []
    seen: set[int] = set()

    if qf_path.exists():
        c = sqlite3.connect(f"file:{qf_path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                "SELECT t, xp, f FROM qf WHERE lower(u) LIKE ? ORDER BY f DESC LIMIT ?",
                (f"{query_norm}%", limit),
            ).fetchall()
            for r in rows:
                xp = (r["xp"] or "").strip()
                if not xp.isdigit():
                    continue
                tid = int(xp)
                if tid in seen:
                    continue
                seen.add(tid)
                out.append({
                    "id": tid,
                    "title": (r["t"] or "").strip() or f"Topic {tid}",
                    "subtitle": "UpToDate topic",
                    "href": f"/uptodate?t={tid}",
                    "scope": "uptodate",
                    "kind": "topic",
                    "search_text": (r["t"] or "").strip(),
                })
                if len(out) >= limit:
                    break
        finally:
            c.close()

    if len(out) < limit and idx_path.exists():
        c = sqlite3.connect(f"file:{idx_path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                "SELECT topic_id, title FROM topic WHERE title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?",
                (f"{query}%", limit),
            ).fetchall()
            for r in rows:
                tid = int(r["topic_id"])
                if tid in seen:
                    continue
                seen.add(tid)
                out.append({
                    "id": tid,
                    "title": r["title"] or "",
                    "subtitle": "UpToDate topic",
                    "href": f"/uptodate?t={tid}",
                    "scope": "uptodate",
                    "kind": "topic",
                    "search_text": r["title"] or "",
                })
                if len(out) >= limit:
                    break
        finally:
            c.close()
    return out


@lru_cache(maxsize=1)
def _lexi_search_tables() -> list[tuple[str, str]]:
    if not LEXI_DB_PATH or not LEXI_DB_PATH.exists():
        return []
    c = sqlite3.connect(f"file:{LEXI_DB_PATH}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        out: list[tuple[str, str]] = []
        candidates = ("title", "name", "term", "display_name", "generic_name", "brand_name")
        for t in tables:
            cols = [r[1] for r in c.execute(f"PRAGMA table_info('{t}')").fetchall()]
            for col in candidates:
                if col in cols:
                    out.append((t, col))
                    break
        return out
    finally:
        c.close()


def _query_lexi_fast(query: str, limit: int) -> list[dict]:
    if not LEXI_DB_PATH or not LEXI_DB_PATH.exists():
        return []
    table_cols = _lexi_search_tables()
    if not table_cols:
        return []
    c = sqlite3.connect(f"file:{LEXI_DB_PATH}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    out: list[dict] = []
    seen: set[str] = set()
    try:
        for table, col in table_cols[:20]:
            rows = c.execute(
                f"SELECT {col} as term FROM '{table}' WHERE {col} LIKE ? ESCAPE '\\' LIMIT ?",
                (f"{query}%", min(8, limit)),
            ).fetchall()
            for r in rows:
                term = (r["term"] or "").strip()
                if not term:
                    continue
                key = term.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "id": f"{table}:{term}",
                    "title": term,
                    "subtitle": f"Lexicomp · {table}",
                    "href": f"/lexi?q={quote(term)}",
                    "scope": "lexi",
                    "kind": "term",
                    "search_text": term,
                })
                if len(out) >= limit:
                    return out
    finally:
        c.close()
    return out


def _query_drugs_fast(query: str, query_norm: str, limit: int) -> list[dict]:
    if not DRUG_REF_DB.exists():
        return []
    try:
        c = sqlite3.connect(f"file:{DRUG_REF_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        out: list[dict] = []
        seen: set[int] = set()
        try:
            fts_q = re.sub(r"[^\w\s]", "", query_norm).strip() + "*"
            if fts_q != "*":
                rows = c.execute(
                    """
                    SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                           qi.drug_class, qi.dose_snippet
                    FROM drug_fts
                    JOIN drug_quick_info qi ON qi.drug_id = drug_fts.drug_id
                    WHERE drug_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (fts_q, limit),
                ).fetchall()
                for r in rows:
                    did = int(r["drug_id"])
                    if did in seen:
                        continue
                    seen.add(did)
                    brands = r["brand_names"] or ""
                    drug_class = r["drug_class"] or ""
                    subtitle = " · ".join(filter(None, [
                        brands.split(",")[0].strip() if brands else "",
                        drug_class.split("|")[0].strip()[:36] if drug_class else "",
                        (r["dose_snippet"] or "")[:60],
                    ])) or "Drug reference"
                    out.append({
                        "id": did,
                        "title": r["generic_name"] or "",
                        "subtitle": subtitle,
                        "href": f"/drugs?id={did}",
                        "scope": "drugs",
                        "kind": "drug",
                        "search_text": f"{r['generic_name']} {brands} {drug_class}",
                    })
                    if len(out) >= limit:
                        return out

            rows = c.execute(
                """
                SELECT drug_id, generic_name, brand_names, drug_class, dose_snippet
                FROM drug_quick_info
                WHERE lower(generic_name) LIKE ?
                   OR lower(brand_names) LIKE ?
                ORDER BY lower(generic_name)
                LIMIT ?
                """,
                (f"{query_norm}%", f"%{query_norm}%", limit),
            ).fetchall()
            for r in rows:
                did = int(r["drug_id"])
                if did in seen:
                    continue
                seen.add(did)
                brands = r["brand_names"] or ""
                drug_class = r["drug_class"] or ""
                out.append({
                    "id": did,
                    "title": r["generic_name"] or "",
                    "subtitle": " · ".join(filter(None, [
                        brands.split(",")[0].strip() if brands else "",
                        drug_class.split("|")[0].strip()[:36] if drug_class else "",
                    ])) or "Drug reference",
                    "href": f"/drugs?id={did}",
                    "scope": "drugs",
                    "kind": "drug",
                    "search_text": f"{r['generic_name']} {brands} {drug_class}",
                })
        finally:
            c.close()
        return out
    except Exception:
        return []


@lru_cache(maxsize=1)
def _utd_search_index() -> list[dict]:
    db_path = UTD_DB_PATH / "unidex.en.sqlite"
    if not db_path.exists():
        return []
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT topic_id, title FROM topic ORDER BY title").fetchall()
    finally:
        c.close()
    return [
        {
            "id": int(r["topic_id"]),
            "title": r["title"] or "",
            "subtitle": "UpToDate topic",
            "href": f"/uptodate?t={int(r['topic_id'])}",
            "scope": "uptodate",
            "kind": "topic",
            "search_text": r["title"] or "",
        }
        for r in rows if r["title"]
    ]


@lru_cache(maxsize=1)
def _amboss_search_index() -> list[dict]:
    db_path = AMBOSS_DIR / "amboss-2025.db"
    if not db_path.exists():
        return []
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT id, title FROM Docs ORDER BY title").fetchall()
    finally:
        c.close()
    return [
        {
            "id": int(r["id"]),
            "title": r["title"] or "",
            "subtitle": "AMBOSS article",
            "href": f"/amboss?doc={int(r['id'])}",
            "scope": "amboss",
            "kind": "article",
            "search_text": r["title"] or "",
        }
        for r in rows if r["title"]
    ]


@lru_cache(maxsize=1)
def _anatomy_search_index() -> list[dict]:
    if not ANATOMY_DEFS_PATH.exists():
        return []
    return [
        {
            "id": f.stem,
            "title": f.stem.replace("_", " "),
            "subtitle": "Anatomy structure",
            "href": f"/anatomy?structure={quote(f.stem.replace('_', ' '))}",
            "scope": "anatomy",
            "kind": "structure",
            "search_text": f.stem.replace("_", " "),
        }
        for f in ANATOMY_DEFS_PATH.glob("*.txt")
    ]


def _library_signature() -> tuple[str, ...]:
    now = time.time()
    cached_at = float(_library_sig_cache.get("at", 0.0) or 0.0)
    cached_sig = _library_sig_cache.get("sig", tuple())
    if isinstance(cached_sig, tuple) and now - cached_at < 300:
        return cached_sig  # cache drive scan for 5 minutes
    if not LIBRARY_PATH.exists():
        return tuple()
    out: list[str] = []
    for root, dirs, files in os.walk(LIBRARY_PATH):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for file in files:
            if file.lower().endswith(".pdf"):
                full = Path(root) / file
                rel = os.path.relpath(full, LIBRARY_PATH).replace("\\", "/")
                try:
                    stat = full.stat()
                except OSError:
                    continue
                out.append(f"{rel}\t{stat.st_mtime_ns}")
    sig = tuple(sorted(out))
    _library_sig_cache["at"] = now
    _library_sig_cache["sig"] = sig
    return sig


def _library_index_conn() -> sqlite3.Connection:
    c = sqlite3.connect(LIBRARY_INDEX_DB)
    c.row_factory = sqlite3.Row
    return c


def _library_index_init() -> None:
    c = _library_index_conn()
    try:
        c.execute("PRAGMA journal_mode=WAL")   # readers never block writers
        c.execute("PRAGMA synchronous=NORMAL")
        c.commit()
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                subtitle TEXT NOT NULL,
                href TEXT NOT NULL,
                scope TEXT NOT NULL,
                kind TEXT NOT NULL,
                search_text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chapters (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                subtitle TEXT NOT NULL,
                href TEXT NOT NULL,
                scope TEXT NOT NULL,
                kind TEXT NOT NULL,
                search_text TEXT NOT NULL
            );
            """
        )
        c.commit()
    finally:
        c.close()


def _library_signature_digest(signature: tuple[str, ...]) -> str:
    blob = "\n".join(signature).encode("utf-8", errors="ignore")
    return hashlib.sha1(blob).hexdigest()


def _books_from_signature(signature: tuple[str, ...]) -> list[dict]:
    books: list[dict] = []
    for token in signature:
        rel, _mtime_raw = token.split("\t", 1)
        title = Path(rel).stem
        folder = Path(rel).parent.name or "General"
        books.append({
            "id": rel,
            "title": title,
            "subtitle": f"{folder} book",
            "href": f"/library?path={quote(rel)}",
            "scope": "books",
            "kind": "book",
            "search_text": f"{title} {folder}",
        })
    return books


@lru_cache(maxsize=512)
def _pdf_toc_entries(path_str: str, mtime_ns: int) -> tuple[tuple[str, int], ...]:
    try:
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import fitz, json, re, sys; "
                    "doc=fitz.open(sys.argv[1]); "
                    "toc=doc.get_toc(simple=True) or []; "
                    "doc.close(); "
                    "items=[]; seen=set(); "
                    "for _, title, page in toc: "
                    " clean=re.sub(r'\\s+', ' ', (title or '').strip()); "
                    " entry=(clean, max(1, int(page or 1))); "
                    " if clean and entry not in seen: seen.add(entry); items.append(entry); "
                    "print(json.dumps(items[:200]))"
                ),
                path_str,
            ],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except Exception:
        return tuple()
    if proc.returncode != 0 or not proc.stdout.strip():
        return tuple()
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return tuple()
    return tuple((str(title), int(page)) for title, page in data if title)


@lru_cache(maxsize=4)
def _library_search_index(signature: tuple[str, ...]) -> tuple[list[dict], list[dict]]:
    books: list[dict] = []
    chapters: list[dict] = []
    for token in signature:
        rel, mtime_raw = token.split("\t", 1)
        full = LIBRARY_PATH / rel
        title = Path(rel).stem
        folder = Path(rel).parent.name or "General"
        books.append({
            "id": rel,
            "title": title,
            "subtitle": f"{folder} book",
            "href": f"/library?path={quote(rel)}",
            "scope": "books",
            "kind": "book",
            "search_text": f"{title} {folder}",
        })
        for chapter_title, page in _pdf_toc_entries(str(full), int(mtime_raw)):
            chapters.append({
                "id": f"{rel}:{page}",
                "title": chapter_title,
                "subtitle": f"{title} · p. {page}",
                "href": f"/library?path={quote(rel)}&page={page}",
                "scope": "books",
                "kind": "chapter",
                "search_text": f"{chapter_title} {title} {folder}",
            })
    return books, chapters


def _ensure_library_index(force: bool = False) -> None:
    """Persist a lightweight index (metadata + chapter TOC) in SQLite.

    PDFs stay on the original drive; only index rows are stored.
    If the library drive is temporarily unavailable, keep the previous index
    instead of wiping data (prevents books from disappearing in UI).
    """
    _library_index_init()
    signature = _library_signature()
    if not signature:
        return
    digest = _library_signature_digest(signature)
    c = _library_index_conn()
    try:
        cur = c.execute("SELECT value FROM meta WHERE key='library_signature'").fetchone()
        existing = cur["value"] if cur else ""
        if (not force) and existing == digest:
            return
    finally:
        c.close()

    books = _books_from_signature(signature)
    c = _library_index_conn()
    try:
        c.execute("BEGIN")
        c.execute("DELETE FROM books")
        c.executemany(
            "INSERT INTO books (id,title,subtitle,href,scope,kind,search_text) VALUES (?,?,?,?,?,?,?)",
            [
                (
                    str(b.get("id", "")),
                    str(b.get("title", "")),
                    str(b.get("subtitle", "")),
                    str(b.get("href", "")),
                    str(b.get("scope", "books")),
                    str(b.get("kind", "book")),
                    str(b.get("search_text", "")),
                )
                for b in books
            ],
        )
        c.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('library_signature', ?)",
            (digest,),
        )
        c.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('library_index_updated_at', ?)",
            (str(int(time.time())),),
        )
        c.commit()
    finally:
        c.close()

    # Pre-generate any missing thumbnails in a SEPARATE PROCESS so they're ready
    # on first load. PyMuPDF's fitz.open()/render are GIL-holding C calls; doing
    # this in a background *thread* froze the whole asyncio event loop for minutes
    # on first boot of a large library — every HTTP request hung until the scan
    # finished (the "app won't start / yellow state, sign-out dead" symptom). A
    # child process has its own GIL, so the server stays responsive. The script
    # skips already-cached thumbnails, so steady-state boots are a cheap no-op.
    try:
        _thumb_flags = 0
        if os.name == "nt":
            _thumb_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
                subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0
            )
        subprocess.Popen(
            [sys.executable, str(BASE / "scripts" / "pregen_thumbnails.py"), str(LIBRARY_PATH)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_thumb_flags,
        )
    except Exception as exc:
        print(f"[library] thumbnail pregen not started: {exc}")


def _disease_search_index() -> list[dict]:
    return [
        {
            "id": d.get("disease_name", ""),
            "title": d.get("disease_name", ""),
            "subtitle": d.get("primary_organ", "Disease"),
            "href": f"/diseases?search={quote(d.get('disease_name', ''))}&disease={quote(d.get('disease_name', ''))}",
            "scope": "meds",
            "kind": "disease",
            "search_text": " ".join(
                [
                    d.get("disease_name", ""),
                    d.get("primary_organ", ""),
                    d.get("primary_system", ""),
                    " ".join(d.get("secondary_organs_involved", [])),
                    " ".join(_disease_points(d)[:2]),
                    d.get("citation", {}).get("chapter_title", ""),
                    " ".join(code.get("code", "") + " " + code.get("description", "") for code in d.get("icd_codes", [])),
                ]
            ),
        }
        for d in harrisons_data if d.get("disease_name")
    ]


def _library_books_index() -> list[dict]:
    _ensure_library_index()
    c = _library_index_conn()
    try:
        rows = c.execute(
            "SELECT id, title, subtitle, href, scope, kind, search_text FROM books ORDER BY lower(title)"
        ).fetchall()
    finally:
        c.close()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "subtitle": r["subtitle"],
            "href": r["href"],
            "scope": r["scope"],
            "kind": r["kind"],
            "search_text": r["search_text"],
        }
        for r in rows
    ]


def _library_chapter_index() -> list[dict]:
    _ensure_library_index()
    c = _library_index_conn()
    try:
        rows = c.execute(
            "SELECT id, title, subtitle, href, scope, kind, search_text FROM chapters ORDER BY lower(title)"
        ).fetchall()
    finally:
        c.close()
    return [
        {
            "id": r["id"],
            "title": r["title"],
            "subtitle": r["subtitle"],
            "href": r["href"],
            "scope": r["scope"],
            "kind": r["kind"],
            "search_text": r["search_text"],
        }
        for r in rows
    ]


def _search_candidates(scopes: set[str]) -> list[dict]:
    # Legacy full-index helper retained for diagnostics; dashboard uses
    # targeted indexed queries in `dashboard_search` for instant suggestions.
    items: list[dict] = []
    if _scope_enabled(scopes, "uptodate"):
        items.extend(_utd_search_index())
    if _scope_enabled(scopes, "amboss"):
        items.extend(_amboss_search_index())
    if _scope_enabled(scopes, "books"):
        books, _chapters = _library_search_index(_library_signature())
        items.extend(books)
    if _scope_enabled(scopes, "anatomy"):
        items.extend(_anatomy_search_index())
    if _scope_enabled(scopes, "calc"):
        items.extend(_CALCULATOR_SEARCH_INDEX)
    if _scope_enabled(scopes, "meds"):
        items.extend(_disease_search_index())
    if _scope_enabled(scopes, "drugs"):
        items.extend(_query_drugs_fast("", "", 50))
    return items


@app.get("/lexi/health")
def lexi_health():
    return {
        "configured": bool(LEXI_DB_PATH_RAW),
        "exists": bool(LEXI_DB_PATH and LEXI_DB_PATH.exists()),
        "path": str(LEXI_DB_PATH) if LEXI_DB_PATH else "",
        "search_tables": len(_lexi_search_tables()) if (LEXI_DB_PATH and LEXI_DB_PATH.exists()) else 0,
    }


@app.get("/lexi/search")
def lexi_search(q: str = Query(..., min_length=1, max_length=120), limit: int = Query(default=20, ge=1, le=50)):
    if not LEXI_DB_PATH or not LEXI_DB_PATH.exists():
        return {"configured": False, "results": []}
    return {"configured": True, "results": _query_lexi_fast(q.strip(), limit)}


# ── Disease database ───────────────────────────────────────────────────────
@app.get("/diseases")
def get_diseases(
    search: str = Query(default="", max_length=200),
    organ: str  = Query(default="", max_length=100),
):
    data = harrisons_data
    if search:
        s = search.lower()
        data = [d for d in data if
                s in d.get("disease_name", "").lower() or
                s in d.get("primary_organ", "").lower() or
                s in d.get("primary_system", "").lower() or
                any(s in p.lower() for p in _disease_points(d)) or
                any(s in (c.get("code", "") + " " + c.get("description", "")).lower() for c in d.get("icd_codes", []))]
    if organ and organ != "All":
        data = [d for d in data if d.get("primary_organ") == organ]
    return {"diseases": data, "count": len(data)}


@app.get("/diseases/{name}")
def get_disease(name: str):
    if len(name) > 200:
        raise HTTPException(status_code=422, detail="name too long")
    for d in harrisons_data:
        if d.get("disease_name", "").lower() == name.lower():
            return d
    raise HTTPException(status_code=404, detail="Disease not found")


# ── Anatomy definitions ────────────────────────────────────────────────────
@app.get("/anatomy/{structure_name}")
def get_anatomy(structure_name: str):
    if len(structure_name) > 200:
        raise HTTPException(status_code=422, detail="structure_name too long")
    if not ANATOMY_DEFS_PATH.exists():
        raise HTTPException(status_code=503, detail="Anatomy definitions directory not configured")
    clean = structure_name.strip()
    for f in ANATOMY_DEFS_PATH.glob("*.txt"):
        if clean.lower() in f.stem.lower():
            try:
                return {"name": structure_name,
                        "definition": f.read_text(encoding="utf-8", errors="ignore")}
            except Exception:
                pass
    raise HTTPException(status_code=404, detail=f"No definition for '{structure_name}'")


# ─── Session state (app ↔ extension sync) ────────────────────────────────
@app.get("/session/state")
def get_session_state():
    return _session_state


@app.post("/session/state")
def set_session_state(body: dict):
    global _session_state
    from datetime import datetime, timezone
    allowed = {"current_term", "current_source", "current_id", "current_title", "qbank_active", "db"}
    for k, v in body.items():
        if k in allowed:
            _session_state[k] = v
    _session_state["updated_at"] = datetime.now(timezone.utc).isoformat()
    return {"ok": True}


# ─── Entry point ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn, asyncio
    print("=" * 52)
    print("  MedOS Backend")
    print(f"  Local  : http://localhost:{BACKEND_PORT}")
    print(f"  Docs   : http://localhost:{BACKEND_PORT}/docs")
    print(f"  CORS   : * (all origins allowed)")
    print(f"  RAG    : {'NVIDIA NIM ' + NVIDIA_MODEL if NVIDIA_API_KEY else 'disabled'}")
    print(f"  Gemini : {'enabled' if GEMINI_API_KEY else 'disabled'}")
    print("=" * 52)
    # On Windows, uvicorn hard-codes the asyncio Proactor event loop, whose
    # socket accept() path intermittently dies with OSError [WinError 64] "The
    # specified network name is no longer available" on a transient network
    # change (Wi-Fi reconnect, VPN toggle, sleep/wake, adapter reset). That kills
    # the listener while the process stays alive, so :8002 starts refusing
    # connections and the app looks like it "won't start" even though the backend
    # is still running. The Selector loop has no such accept bug, and we use no
    # asyncio subprocesses (search-index builds run via threaded subprocess.run),
    # so the Proactor loop buys us nothing here. uvicorn.run() would force
    # Proactor regardless of the loop policy, so we drive Server.serve() on a
    # Selector loop we create ourselves.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    config = uvicorn.Config("main:app", host="0.0.0.0", port=BACKEND_PORT, reload=False, proxy_headers=False)
    asyncio.run(uvicorn.Server(config).serve())

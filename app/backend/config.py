"""
MedOS backend configuration — single source of truth.

All path resolution starts from ROOT, which is computed relative to this file
so the project is fully portable (no machine-specific absolute paths at import time).
Absolute overrides are still accepted via environment variables / .env.
"""
from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import List

from dotenv import load_dotenv

# ── Locate .env relative to this file ─────────────────────────────────────
_HERE = Path(__file__).parent          # backend/
_ENV  = _HERE / ".env"
if _ENV.exists():
    load_dotenv(_ENV)

# Overrides written by the Content Manager (imported content folders, a newer
# UpToDate/Sanford/etc. folder the user pointed us at). Lower priority than a
# real environment variable / .env line, higher priority than the repo-local
# default, so a user override always wins over "the pack we shipped" without
# needing to touch .env. Populated once ROOT is known (below) — safe because
# every _env() call that matters happens after that point in this module.
_USER_OVERRIDES: dict[str, str] = {}


def _env(key: str, default: str = "") -> str:
    if key in _USER_OVERRIDES and _USER_OVERRIDES[key]:
        return _USER_OVERRIDES[key].strip()
    return (os.getenv(key) or default).strip()


# ── Root resolution ────────────────────────────────────────────────────────
# When the project is at  D:\MedOS\app\  the layout is:
#   app/backend/config.py  →  parents[1] = app/  →  parents[2] = MedOS/
# We expose ROOT = the MedOS/ parent so all data paths resolve naturally.
_RELEASE_ROOT: Path = _HERE.parent.parent
_RECORDED_ROOT_RAW = _env("MEDOS_ROOT", "")
_RECORDED_ROOT = Path(_RECORDED_ROOT_RAW) if _RECORDED_ROOT_RAW else None


def _resolve_root() -> Path:
    """Resolve ROOT, ignoring a recorded MEDOS_ROOT that no longer exists.

    Portable and space-saving installs record an absolute MEDOS_ROOT such as
    D:/MedOS-Universal-1.1.4-001. An external drive is not guaranteed the same
    letter (or the same /Volumes name) the next time it is connected, so that
    recorded value can point at nothing. ROOT is the base for every other data
    path, including the accounts database, so a dead ROOT used to break the
    whole app at once. Falling back to the release-relative root keeps MedOS
    usable and lets each individual path override heal itself via
    _portable_path() below.
    """
    if _RECORDED_ROOT is None:
        return _RELEASE_ROOT
    configured = _RECORDED_ROOT
    try:
        if configured.is_dir():
            return configured
    except OSError:
        pass
    print(
        f"[config] MEDOS_ROOT is not reachable ({configured}); "
        f"falling back to {_RELEASE_ROOT}",
        file=sys.stderr,
    )
    return _RELEASE_ROOT


ROOT: Path = _resolve_root()
# Readers that consult os.environ directly must not keep using a dead root.
os.environ["MEDOS_ROOT"] = str(ROOT)

# data/user_content.json — written by POST /content/import-folder. Shape:
# {"overrides": {"UTD_DB_PATH": "D:/imd/imduptodate2026-09", ...}}
USER_CONTENT_FILE: Path = ROOT / "data" / "user_content.json"


def _load_user_content_overrides() -> dict[str, str]:
    try:
        if USER_CONTENT_FILE.exists():
            data = json.loads(USER_CONTENT_FILE.read_text(encoding="utf-8"))
            raw = data.get("overrides", {}) if isinstance(data, dict) else {}
            return {str(k): str(v) for k, v in raw.items() if v}
    except Exception as exc:
        print(f"[config] user_content.json ignored: {exc}")
    return {}


_USER_OVERRIDES.update(_load_user_content_overrides())
# Several readers (qbank_reader, utd_reader, ...) read os.environ.get(KEY)
# directly instead of importing the resolved constant from this module — an
# established MedOS pattern for allowing a per-process path override. Mirror
# every user_content.json override into the real environment (without ever
# clobbering an operator-set env var) so those readers pick it up too.
for _k, _v in _USER_OVERRIDES.items():
    os.environ.setdefault(_k, _v)


def _first_existing_path(candidates: list[Path]) -> Path:
    for candidate in candidates:
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return candidates[0]


def _portable_path(key: str, default: str | Path) -> Path:
    """Use env override only when it exists; otherwise prefer repo-local data."""
    fallback = Path(default)
    raw = _env(key, "")
    if not raw:
        return fallback
    configured = Path(raw)
    stale_root_child = False
    if _RECORDED_ROOT is not None and ROOT != _RECORDED_ROOT:
        try:
            configured.resolve().relative_to(_RECORDED_ROOT.resolve())
            stale_root_child = True
        except (OSError, ValueError):
            pass
    if configured.exists() or not fallback.exists() or not stale_root_child:
        return configured
    return fallback


def _portable_optional_path(key: str, default: str | Path | None = None) -> Path | None:
    raw = _env(key, "")
    fallback = Path(default) if default is not None else None
    if raw:
        configured = Path(raw)
        stale_root_child = False
        if _RECORDED_ROOT is not None and ROOT != _RECORDED_ROOT:
            try:
                configured.resolve().relative_to(_RECORDED_ROOT.resolve())
                stale_root_child = True
            except (OSError, ValueError):
                pass
        if (
            configured.exists() or
            fallback is None or
            not fallback.exists() or
            not stale_root_child
        ):
            return configured
    return fallback if fallback is not None and fallback.exists() else None


def _default_anki_collection() -> Path:
    appdata = os.getenv("APPDATA")
    candidates = [
        ROOT / "data" / "anki" / "collection.anki2",
        ROOT / "data" / "anki" / "User 1" / "collection.anki2",
        ROOT / "Anki2" / "User 1" / "collection.anki2",
        ROOT / "anki" / "collection.anki2",
        ROOT / "anki" / "User 1" / "collection.anki2",
    ]
    if appdata:
        candidates.append(Path(appdata) / "Anki2" / "User 1" / "collection.anki2")
    candidates.append(Path.home() / "AppData" / "Roaming" / "Anki2" / "User 1" / "collection.anki2")
    return _first_existing_path(candidates)

# ── Per-service paths ──────────────────────────────────────────────────────
# Prefer .env overrides; fall back to ROOT-relative defaults.
VECTORSTORE_PATH = _portable_path(
    "VECTORSTORE_PATH",
    ROOT / "data" / "faiss" / "books_v1",
)

ANATOMY_DEFS_PATH = _portable_path(
    "ANATOMY_DEFS_PATH",
    ROOT / "data" / "anatomy",
)

HARRISONS_PATH = _portable_path(
    "HARRISONS_PATH",
    _HERE.parent / "public" / "cliniccons_disease_database.json",
)

LIBRARY_PATH = _portable_path(
    "LIBRARY_PATH",
    ROOT / "data" / "books",
)

LIBRARY_INDEX_DB: Path = _HERE / "library_index.sqlite3"
# User-imported PDF question banks live in their own root so they can be
# exported/transferred as a pack without touching the vendor bundles.
IMPORTED_QBANK_ROOT: Path = _portable_path(
    "IMPORTED_QBANK_ROOT",
    ROOT / "data" / "qbanks-imported",
)
BOOK_CHAPTER_INDEX_DB: Path = _portable_path(
    "BOOK_CHAPTER_INDEX_DB",
    ROOT / "data" / "book_chapter_index.sqlite",
)
GLOBAL_SEARCH_DB: Path = _portable_path(
    "GLOBAL_SEARCH_DB",
    ROOT / "data" / "global_search.sqlite",
)

LEXI_DB_PATH_RAW = _env("LEXI_DB_PATH", "")
LEXI_DB_PATH = _portable_optional_path("LEXI_DB_PATH")

LEXI_CALC_DIR = _portable_path(
    "LEXI_CALC_DIR",
    ROOT / "data" / "Lexi" / "calc",
)
LEXI_CALC_DB = _portable_path(
    "LEXI_CALC_DB",
    LEXI_CALC_DIR / "calc.sqlite",
)

UTD_DB_PATH = _portable_path(
    "UTD_DB_PATH",
    ROOT / "data" / "uptodate",
)

# UpToDate Pathways — interactive clinical decision trees (v2-crypto Docs table,
# same shape as the UWorld library). `PATHWAYS_SRC_DB` is the shipped bundle;
# `PATHWAYS_DB` is the normalized graph DB emitted by scripts/build_pathways.py
# that the runtime reader serves (so it never decrypts 500 KB HTML per request).
PATHWAYS_DIR = _portable_path("PATHWAYS_DIR", ROOT / "data" / "utdpathways")
PATHWAYS_SRC_DB = _portable_path("PATHWAYS_SRC_DB", PATHWAYS_DIR / "utdpathways.db")
PATHWAYS_DB = _portable_path("PATHWAYS_DB", PATHWAYS_DIR / "pathways.sqlite")

# Sanford Guide — antimicrobial therapy reference. Ships as an UNENCRYPTED
# static-HTML bundle (the unpacked "com.sanfordguide.amt" mobile app): a folder
# of per-topic *.html + images + a FTS.db manifest (search_base). We normalize
# the richer `sanfordguide/` edition into `sanford.sqlite` at build time
# (scripts/build_sanford.py) so the reader never parses raw HTML per request.
SANFORD_DIR = _portable_path("SANFORD_DIR", ROOT / "data" / "sanfordguide")
SANFORD_ASSET_DIR = _portable_path("SANFORD_ASSET_DIR", SANFORD_DIR / "sanfordguide")
SANFORD_DB = _portable_path("SANFORD_DB", SANFORD_DIR / "sanford.sqlite")

# UpToDate DDx — differential-diagnosis matrix. Ships as an UNENCRYPTED SQLite
# (`uptodateddx.db`): diagnoses(id,diagnosisName,ismain) + ddx(id1,id2,signs,
# tests). We normalize it into `utdddx.sqlite` (scripts/build_utdddx.py).
UTDDDX_DIR = _portable_path("UTDDDX_DIR", ROOT / "data" / "uptodate ddx")
UTDDDX_SRC_DB = _portable_path("UTDDDX_SRC_DB", UTDDDX_DIR / "uptodateddx.db")
UTDDDX_DB = _portable_path("UTDDDX_DB", UTDDDX_DIR / "utdddx.sqlite")

AMBOSS_DIR = _portable_path(
    "AMBOSS_DIR",
    ROOT / "data" / "amboss",
)

# UWorld reference-article library (vendor bundle, v2 crypto). Structural
# twin of the AMBOSS library (Docs/TOC/images/Search). The folder name carries a
# date ("uworldstep1library-March-2026"), so the reader globs within this dir for
# the bundle if the exact path is absent.
UWORLD_LIBRARY_DIR = _portable_optional_path(
    "UWORLD_LIBRARY_DIR",
    ROOT / "data" / "uworldstep1library-March-2026",
)

STEP1_DB_PATH = _portable_optional_path(
    "STEP1_DB_PATH",
    ROOT / "data" / "uworld" / "STEP-1-2026-march" / "uworldSTEP1-2026-march.db",
)

STEP2_DB_PATH = _portable_optional_path(
    "STEP2_DB_PATH",
    ROOT / "data" / "uworld" / "STEP2-2026-march" / "uworldSTEP2-2026-march.db",
)

STEP3_DB_PATH = _portable_optional_path(
    "STEP3_DB_PATH",
    ROOT / "data" / "uworld" / "STEP3-2026-march" / "uworldSTEP3-2026-march.db",
)

# Folder of NBME self-assessment + CMS clinical form databases. Each immediate
# subfolder is one form (nbme-<step>-<form> or nbme-<Subject>-<form>) and holds a
# `<foldername>.db` plus a media-E/ dir, identical in shape to the UWorld banks.
ASSESSMENT_DIR = _portable_path(
    "ASSESSMENT_DIR",
    ROOT / "data" / "Assesment",
)

# Consolidated data dirs
FAISS_DIR  = _portable_path("FAISS_DIR",  ROOT / "data" / "faiss")
BM25_DIR   = _portable_path("BM25_DIR",   ROOT / "data" / "bm25")
MODELS_DIR = _portable_path("MODELS_DIR", ROOT / "models")

GLOSSARY_DB = _portable_path("GLOSSARY_DB", ROOT / "data" / "glossary.db")
REFERENCE_ENTITIES_DB = _portable_path(
    "REFERENCE_ENTITIES_DB",
    ROOT / "data" / "reference_entities.sqlite",
)
REFERENCE_LOOKUP_DB = _portable_path(
    "REFERENCE_LOOKUP_DB",
    ROOT / "data" / "reference_lookup.sqlite",
)

FIRSTAID_PDF = _portable_path(
    "FIRSTAID_PDF",
    LIBRARY_PATH / "USMLE" / "First Aid for the USMLE Step 1 2026.pdf",
)
FIRSTAID_INDEX_DB = _portable_path(
    "FIRSTAID_INDEX_DB",
    ROOT / "data" / "firstaid_index.sqlite",
)
FIRSTAID_EDITION = _env("FIRSTAID_EDITION", "2026")
FA_SNIPPET_CACHE_DIR = _portable_path(
    "FA_SNIPPET_CACHE_DIR",
    ROOT / "data" / "_fa_snippet_cache",
)

DRUG_REF_DB = _portable_path("DRUG_REF_DB", ROOT / "data" / "drug_reference.sqlite")
RXNORM_DB = _portable_path("RXNORM_DB", ROOT / "data" / "rxnorm.sqlite")


def _default_rxnorm_rrf_dir() -> Path:
    """Locate the raw RxNorm distribution without pinning one download date.

    RxNorm drops land in `data/RxNorm_full_<MMDDYYYY>/prescribe/rrf`. The date
    changes every release (and the user may import a differently named copy),
    so glob for whichever dated folder is actually present.
    """
    data = ROOT / "data"
    try:
        candidates = sorted(data.glob("RxNorm_full_*"))
    except OSError:
        candidates = []
    for candidate in candidates:
        rrf = candidate / "prescribe" / "rrf"
        try:
            if rrf.is_dir():
                return rrf
        except OSError:
            continue
    return data / "RxNorm_full" / "prescribe" / "rrf"


RXNORM_RRF_DIR = _portable_path("RXNORM_RRF_DIR", _default_rxnorm_rrf_dir())
UMLS_DB = _portable_path("UMLS_DB", ROOT / "data" / "umls.sqlite")
# Slim always-shipped copy (see scripts/build_umls_lite.py) — umls_reader falls
# back to this when the full umls-full pack isn't installed, so term resolve /
# codes / hover cards keep working without the 4.2 GB pack.
UMLS_LITE_DB = _portable_path("UMLS_LITE_DB", ROOT / "data" / "umls_lite.sqlite")
UMLS_META_DIR = _portable_path(
    "UMLS_META_DIR",
    ROOT / "data" / "umls" / "2026AA" / "META",
)
MICROMEDEX_DB = _portable_path("MICROMEDEX_DB", ROOT / "data" / "Lexi" / "mm" / "imdiMDX_DrugRef.sqlite")
MICROMEDEX_INTERACTION_DB = _portable_path(
    "MICROMEDEX_INTERACTION_DB",
    ROOT / "data" / "Lexi" / "mm" / "mm intraction" / "imdiMDX_DrugInt.sqlite",
)

AO_DATA_PATH = _portable_path("AO_DATA_PATH", ROOT / "data" / "ao")
CONCEPT_LINKS_DB = _portable_path("CONCEPT_LINKS_DB", ROOT / "data" / "concept_links.sqlite")

ANKI_COLLECTION = _portable_path("ANKI_COLLECTION", _default_anki_collection())
ANKI_MEDIA_DIR   = _portable_path("ANKI_MEDIA_DIR", ANKI_COLLECTION.parent / "collection.media")
ANKI_PROGRESS_DB  = ROOT / "data" / "anki_progress.sqlite"
ANKI_USERDECKS_DB = ROOT / "data" / "anki_userdecks.sqlite"

# ── API credentials ────────────────────────────────────────────────────────
NVIDIA_API_KEY  = _env("NVIDIA_API_KEY")
NVIDIA_BASE_URL = _env("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
NVIDIA_MODEL    = _env("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")
GEMINI_API_KEY  = _env("GEMINI_API_KEY")
GEMINI_MODEL    = _env("GEMINI_MODEL", "gemini-3.5-flash")

# ── Server ─────────────────────────────────────────────────────────────────
BACKEND_PORT = int(_env("BACKEND_PORT", "8002"))
_raw_origins = _env("ALLOWED_ORIGINS", "http://localhost:3000")
ALLOWED_ORIGINS: List[str] = [o.strip() for o in _raw_origins.split(",") if o.strip()]

# Auto-add 127.0.0.1:3000 (status server redirects here) and the current LAN IP
# (START.ps1 exports MEDOS_LAN_IP before spawning backend).
_auto_origins = ["http://127.0.0.1:3000"]
_lan_ip = _env("MEDOS_LAN_IP", "")
if _lan_ip:
    _auto_origins.append(f"http://{_lan_ip}:3000")
for _o in _auto_origins:
    if _o not in ALLOWED_ORIGINS:
        ALLOWED_ORIGINS.append(_o)

# ── Embedding / reranker model names ──────────────────────────────────────
EMBED_MODEL    = _env("EMBED_MODEL",    "BAAI/bge-large-en-v1.5")
RERANKER_MODEL = _env("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")

# ── Thumbnail settings ─────────────────────────────────────────────────────
THUMB_DIR  = LIBRARY_PATH / "_thumbs"
THUMB_SIZE = (240, 320)   # (width, height) in px for WebP cover thumbnails


@lru_cache(maxsize=1)
def describe() -> dict:
    """Return a diagnostic dict of resolved paths (useful for /health)."""
    return {
        "root":           str(ROOT),
        "library":        str(LIBRARY_PATH),
        "vectorstore":    str(VECTORSTORE_PATH),
        "glossary_db":    str(GLOSSARY_DB),
        "reference_entities": str(REFERENCE_ENTITIES_DB),
        "reference_lookup": str(REFERENCE_LOOKUP_DB),
        "firstaid_pdf":   str(FIRSTAID_PDF),
        "firstaid_index": str(FIRSTAID_INDEX_DB),
        "concept_links":  str(CONCEPT_LINKS_DB),
        "faiss_dir":      str(FAISS_DIR),
        "utd":            str(UTD_DB_PATH),
        "amboss":         str(AMBOSS_DIR),
        "umls_db":        str(UMLS_DB),
        "umls_lite_db":   str(UMLS_LITE_DB),
        "user_content_file": str(USER_CONTENT_FILE),
    }

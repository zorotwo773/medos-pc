"""
Q-Bank reader — FastAPI router.

Reads UWorld STEP1, STEP2, and STEP3 SQLite databases:
  uworldSTEP1-2026-march.db  — ~3,600 questions
  uworldSTEP2-2026-march.db  — 4,085 questions
  uworldSTEP3-2026-march.db  — ~2,700 questions

All question content (stem, answer choices, explanation) is read from the
FTS Search_content table which is plaintext — the Questions.question and
Answers.answerText columns are encrypted and are never read.

FTS type mapping:
  type=0  title / subject
  type=1  question stem
  type=2  explanation
  type=3  individual answer choice (one row per choice, in order)

Questions.corrAns  (1-based index of the correct answer choice)
"""
from __future__ import annotations

import os
import random
import re
import sqlite3
import threading
import time
import hashlib
import base64
import gzip
import io
import html
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from functools import lru_cache
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad
from pydantic import BaseModel, Field

from media_interop import media_interop_head

# Per-tester scoping: the session middleware in auth.py sets
# request.state.user_email. We depend on it via require_user, which falls
# back to 'legacy@medos' when the gate is disabled (dev mode).
from auth import require_user

# ─── Config ───────────────────────────────────────────────────────────────────
BASE = Path(__file__).parent
try:
    from config import ROOT
except Exception:
    ROOT = BASE.parent.parent

try:
    from config import ASSESSMENT_DIR as _ASSESSMENT_DIR
except Exception:
    _ASSESSMENT_DIR = ROOT / "data" / "Assesment"
ASSESSMENT_DIR = Path(os.environ.get("ASSESSMENT_DIR", "").strip() or _ASSESSMENT_DIR)
try:
    from config import AMBOSS_DIR as _CONFIG_AMBOSS_DIR
except Exception:
    _CONFIG_AMBOSS_DIR = ROOT / "data" / "amboss"
try:
    from config import IMPORTED_QBANK_ROOT as _CONFIG_IMPORTED_QBANK_ROOT
except Exception:
    _CONFIG_IMPORTED_QBANK_ROOT = ROOT / "data" / "qbanks-imported"

router = APIRouter(prefix="/qbank", tags=["Q-Bank"])

# Bank keys are now free-form strings resolved through the dynamic registry
# (see _bank_registry). The 3 UWorld banks keep their stable "step{n}" keys;
# NBME/CMS forms get "nbme-<step>-<form>" / "cms-<subject-slug>-<form>" keys.
# DB_KEY remains a `str` alias so existing FastAPI signatures accept any key and
# validation happens in _resolve_bank (404 on unknown).
DB_KEY = str


class ScanRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=120000)
    limit: int = Field(default=80, ge=1, le=250)


class QBankUserState(BaseModel):
    sessions: Optional[list[dict[str, Any]]] = None
    usedIdsByDb: Optional[dict[str, list[int]]] = None
    markedIdsByDb: Optional[dict[str, list[int]]] = None
    trackingPref: Optional[bool] = None


class QBankSessionBody(BaseModel):
    session: dict[str, Any]


class QBankResetRequest(BaseModel):
    db: DB_KEY
    sessions: bool = True
    used_ids: bool = True
    marked_ids: bool = False

_VALID_IDS_CACHE: dict[str, set[int]] = {}
# Computing valid ids decrypts EVERY stem + answer in a bank (minutes for an
# AMBOSS bank on a cold disk), and valid_only=true — the default for every
# /qbank/list — depends on it. Two guards keep that cost off the user's path:
# a per-bank single-flight lock (concurrent cold requests otherwise all run the
# same decryption sweep — the same stampede class as the reference index), and
# a disk cache keyed on the bank file's size+mtime so the sweep runs once per
# installed bundle, not once per boot.
_VALID_IDS_LOCK = threading.Lock()
_VALID_IDS_DB_LOCKS: dict[str, threading.Lock] = {}
_VALID_IDS_DISK_DIR = ROOT / "data" / "cache" / "qbank_valid_ids"
_DEFAULT_CONTENT_PW = "hs;d,hghdk[;ak"
_PAYLOAD_IV = bytes.fromhex("1173696667686f6b6c7a787776626e6d")

_DB_CONFIG: dict[str, tuple[str, str, str]] = {
    "step1": ("STEP1_DB_PATH", "STEP1_DIR", "uworldSTEP1-2026-march.db"),
    "step2": ("STEP2_DB_PATH", "STEP2_DIR", "uworldSTEP2-2026-march.db"),
    "step3": ("STEP3_DB_PATH", "STEP3_DIR", "uworldSTEP3-2026-march.db"),
}

_DEFAULT_DB_DIRS: dict[str, Path] = {
    "step1": BASE.parent.parent / "data" / "uworld" / "STEP-1-2026-march",
    "step2": BASE.parent.parent / "data" / "uworld" / "STEP2-2026-march",
    "step3": BASE.parent.parent / "data" / "uworld" / "STEP3-2026-march",
}

# The 3 UWorld banks are the "core" set used to seed per-user state maps. NBME/CMS
# bank keys are added to those maps on demand as the user touches them.
_UWORLD_KEYS: tuple[str, ...] = ("step1", "step2", "step3")
_UWORLD_LABELS: dict[str, str] = {"step1": "UWorld STEP 1", "step2": "UWorld STEP 2", "step3": "UWorld STEP 3"}
_UWORLD_STEPS: dict[str, int] = {"step1": 1, "step2": 2, "step3": 3}
_ALL_DBS: tuple[str, ...] = _UWORLD_KEYS
_QBANK_STATE_DB = Path(os.environ.get("QBANK_STATE_DB", str(ROOT / "data" / "qbank_state.sqlite3")))
_STEP_TOKENS = {"1", "2", "3"}

# AMBOSS qbanks live as `Amboss - …<year>/ambossqb-….db` bundles dropped straight
# into data/. They share the UWorld qbank schema (Questions/Answers/Refs/Search)
# and the v2 crypto _decrypt_qbank_html already handles, so they only need
# registry entries — keys are "amboss1" / "amboss2" / "amboss3".
_AMBOSS_QBANK_ROOT = Path(os.environ.get("AMBOSS_QBANK_DIR", "").strip() or (ROOT / "data"))
_AMBOSS_STEP_LABELS: dict[int, str] = {1: "Step 1", 2: "Step 2 CK", 3: "Step 3"}
_AMBOSS_SUBSYSTEM_ID_BASE = 1_000_000
_AMBOSS_SUBSYSTEM_ID_FACTOR = 1_000
_AMBOSS_QBANK_MEDIA_ALIASES: dict[tuple[str, int, str], str] = {
    # AMBOSS Step 1 2025 qbank row 948 references a stale package filename that
    # is absent from both its media-E folder and the shared Images folder. The
    # current AMBOSS image pack carries the same IgG/Fc-region figure under this
    # article image filename.
    ("amboss1", 948, "big_5b55d3f2afa1d.jpg"): "big_5ab901e4b807a.jpg",
}


@dataclass(frozen=True)
class BankInfo:
    key: str
    db_path: Path
    category: str            # uworld | nbme | cms | amboss* | mehlman | boardvitals | mksap
    step: Optional[int]      # 1/2/3 for uworld + nbme; None for source-specific banks
    subject: Optional[str]   # clinical subject for cms (e.g. "Medicine"); None otherwise
    form: Optional[str]      # form number/label
    label: str


# Mehlman "High-Yield" PDF-derived qbanks ship as `data/mehlman-<n>-<year>/`
# bundles that are structural twins of the UWorld/AMBOSS banks (same
# Questions/Answers/Search schema, same v2 crypto, same media-E layout), so
# they plug into the exact same reader/quiz path — they only need discovery +
# a registry entry. Each folder's `title.txt` carries the human subject name
# ("HY Psychiatry", "Step 3 Qbank", …); the folder itself is the stable key.
_MEHLMAN_ROOT = Path(os.environ.get("MEHLMAN_DIR", "").strip() or (ROOT / "data"))
_MEHLMAN_DIR_RE = re.compile(r"^mehlman-", re.IGNORECASE)

# Additional vendor bundles are deliberately discovered from one narrow root.
# BoardVitals and both ABIM banks already use the UWorld-shaped/v2-crypto
# schema; MKSAP is the companion database generated by
# scripts/build_mksap19_qbank.py. Exact name classifiers prevent unrelated
# SQLite files under data/ from becoming banks.
_ADDITIONAL_QBANK_ROOT = Path(os.environ.get("ADDITIONAL_QBANK_DIR", "").strip() or (ROOT / "data"))
_BOARDVITALS_DIR_RE = re.compile(r"^boardvitals-", re.IGNORECASE)
_MKSAP_DIR_RE = re.compile(r"^mksap19(?:part2db)?$", re.IGNORECASE)
_AMBOSS_ABIM_DIR_RE = re.compile(r"^Amboss - Internal Medicine \(ABIM\)2025$", re.IGNORECASE)
_UWORLD_ABIM_DIR_RE = re.compile(r"^INTERNAL-2026-march$", re.IGNORECASE)

# Q-Banks created by the PDF importer. Each bank is a folder in
# data/qbanks-imported/ that carries `<folder>.db`, an `imported.json` sidecar
# (display name + source PDF) and a plaintext `media-E/` folder.
_IMPORTED_QBANK_ROOT = Path(
    os.environ.get("IMPORTED_QBANK_ROOT", "").strip() or _CONFIG_IMPORTED_QBANK_ROOT
)
_IMPORTED_DIR_RE = re.compile(r"^imported-", re.IGNORECASE)


def _uworld_db_path(db: str) -> Path:
    """Resolve a UWorld bank's DB path, raising 503 (with config hint) if absent."""
    path_env, dir_env, default_name = _DB_CONFIG[db]
    raw = os.environ.get(path_env, "").strip()
    fallback = _DEFAULT_DB_DIRS[db] / default_name

    if raw:
        p = Path(raw)
        if not p.exists() and fallback.exists():
            p = fallback
    else:
        step_dir = os.environ.get(dir_env, "").strip()
        p = (Path(step_dir) if step_dir else _DEFAULT_DB_DIRS[db]) / default_name
        if not p.exists() and fallback.exists():
            p = fallback
    if not p.exists():
        raise HTTPException(503, f"{db.upper()} database not found: {p}. Configure {path_env} in backend/.env")
    return p


def _slugify_subject(subject: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", subject.lower()).strip("-")


def _classify_assessment(folder: Path) -> Optional[BankInfo]:
    """Map a data/Assesment/<folder> into a BankInfo, or None if not a form dir.

    Folder names look like `nbme-<step>-<form>` (NBME self-assessment) or
    `nbme-<Subject>-<form>` (CMS clinical form, subject may contain spaces or a
    hyphen, e.g. "Ob-Gyn"). The form number is always the token after the LAST
    hyphen; everything between the leading "nbme-" and that is step-or-subject.
    """
    name = folder.name
    if not name.lower().startswith("nbme-"):
        return None
    db_file = folder / f"{name}.db"
    if not db_file.exists():
        return None
    body = name[5:]
    idx = body.rfind("-")
    if idx <= 0:
        return None
    mid, form = body[:idx], body[idx + 1:]
    if not form:
        return None
    if mid in _STEP_TOKENS:
        step = int(mid)
        return BankInfo(f"nbme-{step}-{form}", db_file, "nbme", step, None, form, f"NBME {step} · Form {form}")
    subject = mid
    return BankInfo(f"cms-{_slugify_subject(subject)}-{form}", db_file, "cms", None, subject, form, f"{subject} · Form {form}")


def _classify_amboss_qbank(folder: Path) -> Optional[BankInfo]:
    """Map a `data/Amboss - …` folder into a BankInfo, or None if not one.

    Each bundle holds a single `ambossqb-*.db` (UWorld-shaped schema, v2 crypto).
    The step number is read from `title.txt` ("…Step 1 - 2025" / "…Step 2 CK…"),
    falling back to the folder name. Keys are stable per step: amboss1/2/3.
    """
    name = folder.name
    if not name.lower().startswith("amboss"):
        return None
    db_file = next((p for p in sorted(folder.glob("ambossqb-*.db"))), None)
    if db_file is None:
        return None
    title_txt = folder / "title.txt"
    label_src = ""
    if title_txt.exists():
        try:
            label_src = title_txt.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            label_src = ""
    hay = label_src or name
    m = re.search(r"step\s*([123])", hay, re.IGNORECASE)
    if not m:
        return None
    step = int(m.group(1))
    label = f"AMBOSS {_AMBOSS_STEP_LABELS.get(step, f'Step {step}')}"
    return BankInfo(f"amboss{step}", db_file, "amboss", step, None, str(step), label)


def _clean_mehlman_title(raw: str, folder_name: str) -> str:
    """Human label for a Mehlman bank. Prefer title.txt; discard the junk value
    ('System.Object[]') some exports leave behind, and fall back to a prettified
    folder name."""
    t = (raw or "").strip()
    if t and t.lower() != "system.object[]":
        return t if t.lower().startswith(("hy ", "step")) else t
    # e.g. "mehlman-8-2025" -> "Mehlman 8 · 2025"
    body = folder_name[len("mehlman-"):] if folder_name.lower().startswith("mehlman-") else folder_name
    return "Mehlman " + body.replace("-", " · ")


def _classify_mehlman(folder: Path) -> Optional[BankInfo]:
    """Map a `data/mehlman-…` folder into a BankInfo, or None if not a usable
    bundle (missing/empty `.db`). The folder name is the stable bank key so
    per-user progress survives a title edit; the title is display-only."""
    name = folder.name
    if not _MEHLMAN_DIR_RE.match(name):
        return None
    db_file = folder / f"{name}.db"
    if not db_file.exists():
        db_file = next((p for p in sorted(folder.glob("*.db"))), None)  # tolerate a renamed db
    if db_file is None or not db_file.exists() or db_file.stat().st_size == 0:
        return None
    title_txt = folder / "title.txt"
    raw_title = ""
    if title_txt.exists():
        try:
            raw_title = title_txt.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            raw_title = ""
    label = _clean_mehlman_title(raw_title, name)
    return BankInfo(name, db_file, "mehlman", None, label, None, label)


def _discover_mehlman_qbanks() -> list[BankInfo]:
    """Scan for `mehlman-…` bundles. Sorted by folder name for a stable order."""
    root = _MEHLMAN_ROOT
    if not root.exists():
        return []
    found: list[BankInfo] = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue
        info = _classify_mehlman(folder)
        if info:
            found.append(info)
    return found


def _discover_amboss_qbanks() -> list[BankInfo]:
    """Scan the AMBOSS-qbank root for `Amboss - …` bundles. Newest-installed
    wins if two folders resolve to the same step key (sorted, last write)."""
    root = _AMBOSS_QBANK_ROOT
    found: dict[str, BankInfo] = {}
    if not root.exists():
        return []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue
        info = _classify_amboss_qbank(folder)
        if info:
            found[info.key] = info
    return list(found.values())


def _classify_additional_qbank(folder: Path) -> Optional[BankInfo]:
    """Classify source-specific desktop banks without guessing their schema."""
    name = folder.name
    if _BOARDVITALS_DIR_RE.match(name):
        db_file = folder / f"{name}.db"
        if not db_file.exists():
            db_file = next((p for p in sorted(folder.glob("*.db"))), None)
        if db_file is None or not db_file.exists() or db_file.stat().st_size == 0:
            return None
        years = re.findall(r"(?:19|20)\d{2}", name)
        label = f"BoardVitals {years[-1]}" if years else "BoardVitals"
        return BankInfo(name, db_file, "boardvitals", None, None, None, label)
    if _MKSAP_DIR_RE.match(name):
        db_file = folder / "medos-mksap19-qbank.db"
        if not db_file.exists() or db_file.stat().st_size == 0:
            return None
        return BankInfo("mksap19", db_file, "mksap", None, None, "19", "MKSAP 19")
    if _AMBOSS_ABIM_DIR_RE.fullmatch(name):
        db_file = folder / "ambossqb-Internal Medicine (ABIM)2025.db"
        if not db_file.exists() or db_file.stat().st_size == 0:
            return None
        return BankInfo(
            "amboss-abim-2025",
            db_file,
            "amboss_abim",
            None,
            None,
            "2025",
            "AMBOSS Internal Medicine (ABIM) 2025",
        )
    if _UWORLD_ABIM_DIR_RE.fullmatch(name):
        db_file = folder / "uworldINTERNAL-2026-march.db"
        if not db_file.exists() or db_file.stat().st_size == 0:
            return None
        return BankInfo(
            "uworld-abim-2026-march",
            db_file,
            "uworld_abim",
            None,
            None,
            "2026-march",
            "UWorld Internal Medicine (ABIM) 2026",
        )
    return None


def _discover_additional_qbanks() -> list[BankInfo]:
    root = _ADDITIONAL_QBANK_ROOT
    if not root.exists():
        return []
    found: list[BankInfo] = []
    for folder in sorted(root.iterdir()):
        if not folder.is_dir():
            continue
        info = _classify_additional_qbank(folder)
        if info:
            found.append(info)
    return found


def _classify_imported_qbank(folder: Path) -> Optional[BankInfo]:
    """Map a `data/qbanks-imported/imported-*` folder into a BankInfo.

    The sidecar `imported.json` is the marker that distinguishes an importer
    bank from any other SQLite folder; the DB filename is always the folder
    name so a rename keeps per-user progress attached to the same key.
    """
    if not folder.is_dir() or not _IMPORTED_DIR_RE.match(folder.name):
        return None
    meta_file = folder / "imported.json"
    db_file = folder / f"{folder.name}.db"
    if not meta_file.is_file() or not db_file.is_file() or db_file.stat().st_size == 0:
        return None
    label = folder.name
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8", errors="replace"))
        label = str(meta.get("name") or meta.get("label") or label).strip() or label
    except Exception:
        pass
    return BankInfo(folder.name, db_file, "imported", None, None, None, label)


def _discover_imported_qbanks() -> list[BankInfo]:
    root = _IMPORTED_QBANK_ROOT
    if not root.exists():
        return []
    found: list[BankInfo] = []
    for folder in sorted(root.iterdir()):
        info = _classify_imported_qbank(folder)
        if info:
            found.append(info)
    return found


@lru_cache(maxsize=1)
def _bank_registry() -> dict[str, BankInfo]:
    """Build the bank key → BankInfo map once. Cached for process lifetime, so
    forms added on disk after boot need a backend restart to appear (same as the
    UWorld banks)."""
    reg: dict[str, BankInfo] = {}
    for k in _UWORLD_KEYS:
        try:
            p = _uworld_db_path(k)
        except HTTPException:
            continue  # not installed; resolved lazily (still 503s with config hint)
        reg[k] = BankInfo(k, p, "uworld", _UWORLD_STEPS[k], None, str(_UWORLD_STEPS[k]), _UWORLD_LABELS[k])
    for info in _discover_amboss_qbanks():
        reg[info.key] = info
    for info in _discover_mehlman_qbanks():
        reg[info.key] = info
    for info in _discover_additional_qbanks():
        reg[info.key] = info
    for info in _discover_imported_qbanks():
        reg[info.key] = info
    if ASSESSMENT_DIR.exists():
        for folder in sorted(ASSESSMENT_DIR.iterdir()):
            if not folder.is_dir():
                continue
            info = _classify_assessment(folder)
            if info:
                reg[info.key] = info
    return reg


def reset_bank_registry() -> dict[str, int]:
    """Re-scan banks after the Content Manager points us at newly-added/updated
    qbank folders (e.g. a MEHLMAN_DIR/AMBOSS_QBANK_DIR override), so the new
    banks appear without a full backend restart. Re-reads the env-driven roots,
    clears the memoized registry + counts, and returns a per-category tally."""
    global _MEHLMAN_ROOT, _AMBOSS_QBANK_ROOT, _ADDITIONAL_QBANK_ROOT, _IMPORTED_QBANK_ROOT  # noqa: PLW0603
    _MEHLMAN_ROOT = Path(os.environ.get("MEHLMAN_DIR", "").strip() or (ROOT / "data"))
    _AMBOSS_QBANK_ROOT = Path(os.environ.get("AMBOSS_QBANK_DIR", "").strip() or (ROOT / "data"))
    _ADDITIONAL_QBANK_ROOT = Path(os.environ.get("ADDITIONAL_QBANK_DIR", "").strip() or (ROOT / "data"))
    _IMPORTED_QBANK_ROOT = Path(
        os.environ.get("IMPORTED_QBANK_ROOT", "").strip() or _CONFIG_IMPORTED_QBANK_ROOT
    )
    _bank_registry.cache_clear()
    _BANK_COUNT_CACHE.clear()
    # Valid-id sets are cached in memory *and* on disk, keyed by the bank key.
    # A rebuilt imported bank reuses its key, so drop that memo or the new
    # questions stay hidden behind the old answer/media sweep. Other banks keep
    # their disk cache (the UWorld sweep is expensive); the on-disk signature
    # check already catches anything else that changed.
    _VALID_IDS_CACHE.clear()
    _VALID_IDS_DB_LOCKS.clear()
    try:
        if _VALID_IDS_DISK_DIR.is_dir():
            for child in _VALID_IDS_DISK_DIR.glob("imported-*.json"):
                child.unlink()
    except OSError:
        pass
    reg = _bank_registry()
    tally: dict[str, int] = {}
    for info in reg.values():
        tally[info.category] = tally.get(info.category, 0) + 1
    return tally


def _resolve_bank(db: str) -> BankInfo:
    info = _bank_registry().get(db)
    if info is not None:
        return info
    if db in _UWORLD_KEYS:
        # Optional UWorld bank absent at boot — preserve the 503 + config hint.
        p = _uworld_db_path(db)
        return BankInfo(db, p, "uworld", _UWORLD_STEPS[db], None, str(_UWORLD_STEPS[db]), _UWORLD_LABELS[db])
    raise HTTPException(404, f"Unknown Q-bank: {db}")


def _is_known_bank(db: str) -> bool:
    if db in _bank_registry() or db in _UWORLD_KEYS:
        return True
    return False


def _db_path(db: DB_KEY) -> Path:
    return _resolve_bank(db).db_path


def _bank_dir(db: DB_KEY) -> Path:
    return _db_path(db).parent


def _bank_media_dir(db: DB_KEY) -> Path:
    """MKSAP keeps named source assets in figure-images; iMD banks use media-E."""
    return _bank_dir(db) / ("figure-images" if _resolve_bank(db).category == "mksap" else "media-E")


def _conn(db: DB_KEY) -> sqlite3.Connection:
    p = _db_path(db)
    c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


_BANK_COUNT_CACHE: dict[str, int] = {}


def _bank_count(db: str) -> int:
    """Total question count for a bank (cheap COUNT(*), no decryption), memoized."""
    if db in _BANK_COUNT_CACHE:
        return _BANK_COUNT_CACHE[db]
    try:
        c = _conn(db)
        try:
            n = int(c.execute("SELECT COUNT(*) FROM Questions").fetchone()[0])
        finally:
            c.close()
    except Exception:
        n = 0
    _BANK_COUNT_CACHE[db] = n
    return n


# ── Boot warm-up ─────────────────────────────────────────────────────────────
_STEP_SIBLINGS = {
    "step1": "amboss1", "step2": "amboss2", "step3": "amboss3",
    "amboss1": "step1", "amboss2": "step2", "amboss3": "step3",
}
_CORE_BANK_ORDER = ("step2", "amboss2", "step1", "amboss1", "step3", "amboss3")


def _priority_banks() -> list[str]:
    """Every installed bank, most-important first.

    "Important" = the banks the user actually studies: most recent progress or
    session activity wins (this is how the backend knows which USMLE step the
    user is preparing for without any new plumbing), each paired with its
    UWorld/AMBOSS sibling of the same step. Core banks follow, NBME/CMS forms
    last (they're small and on-demand).
    """
    reg = _bank_registry()
    order: list[str] = []

    def _push(db: str) -> None:
        if db in reg and db not in order:
            order.append(db)

    try:
        c = _state_conn()
        try:
            rows = c.execute(
                "SELECT db, MAX(updated_at) AS ts FROM ("
                "  SELECT db, updated_at FROM qbank_progress"
                "  UNION ALL SELECT db, updated_at FROM qbank_sessions"
                ") GROUP BY db ORDER BY ts DESC"
            ).fetchall()
        finally:
            c.close()
        for row in rows:
            _push(row["db"])
            sibling = _STEP_SIBLINGS.get(row["db"])
            if sibling:
                _push(sibling)
    except Exception:
        pass
    for db in _CORE_BANK_ORDER:
        _push(db)
    for db in reg:
        _push(db)
    return order


def warm_qbank_boot(deep_banks: int = 6) -> None:
    """Make the Q-bank page interactive fast after a cold boot.

    Q-bank is the app's main feature, so this runs FIRST at boot — main.py holds
    the other heavy warm-ups (reference index, search, RAG) until it finishes.
    Counts warm for every bank (so /qbank/banks renders instantly), then the
    top-priority banks get the expensive pieces the first "Start block" needs:
    _valid_ids (full-bank decryption sweep — disk-cached after the first run)
    and the Questions/Subjects/Systems pages /qbank/list touches.
    """
    t0 = time.time()
    order = _priority_banks()
    for db in order:
        _bank_count(db)
    for db in order[:deep_banks]:
        t1 = time.time()
        try:
            _valid_ids(db)
            c = _conn(db)
            try:
                where, params = _question_where(db, None, None, "", "", "", True)
                c.execute(
                    "SELECT COUNT(*) FROM Questions q "
                    "LEFT JOIN Subjects subj ON subj.id=q.subId "
                    "LEFT JOIN Systems sys ON sys.id=q.sysId "
                    f"{where}", params
                ).fetchone()
                c.execute("SELECT id, name FROM Subjects").fetchall()
                c.execute("SELECT id, name FROM Systems").fetchall()
            finally:
                c.close()
            print(f"[qbank] warmed {db} in {time.time() - t1:.1f}s")
        except Exception as e:
            print(f"[qbank] warm skipped for {db}: {e}")
    print(f"[qbank] boot warm-up done ({len(order)} banks, deep {min(deep_banks, len(order))}) in {time.time() - t0:.1f}s")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# Identity used to backfill rows that existed before per-user scoping landed.
# Matches auth.LEGACY_USER_EMAIL so dev-mode reads/writes line up with the
# pre-migration data.
_LEGACY_USER_EMAIL = "legacy@medos"


def _has_column(c: sqlite3.Connection, table: str, column: str) -> bool:
    rows = c.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def _migrate_qbank_state(c: sqlite3.Connection) -> None:
    """Idempotently bring the qbank_state.sqlite3 schema up to the per-user shape.

    Runs on every backend boot; pragma-checks are cheap and the ALTER/rebuild
    paths are no-ops once a column exists.
    """
    # qbank_sessions: simple ADD COLUMN
    if not _has_column(c, "qbank_sessions", "user_email"):
        c.execute(
            f"ALTER TABLE qbank_sessions ADD COLUMN user_email TEXT NOT NULL DEFAULT '{_LEGACY_USER_EMAIL}'"
        )
    # Always ensure index exists — safe whether column was just added or already present.
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_qbank_sessions_user_updated "
        "ON qbank_sessions(user_email, updated_at DESC)"
    )

    # qbank_activity: ADD COLUMN; denormalized so /qbank/activity can filter by user
    # without joining through qbank_sessions on every row.
    if not _has_column(c, "qbank_activity", "user_email"):
        c.execute(
            f"ALTER TABLE qbank_activity ADD COLUMN user_email TEXT NOT NULL DEFAULT '{_LEGACY_USER_EMAIL}'"
        )
    # Always ensure index exists.
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_qbank_activity_user_created "
        "ON qbank_activity(user_email, created_at DESC)"
    )

    # qbank_progress: PRIMARY KEY change requires a table rebuild because
    # SQLite can't ALTER the primary key in place.
    if not _has_column(c, "qbank_progress", "user_email"):
        c.executescript(
            f"""
            CREATE TABLE qbank_progress_new (
                user_email TEXT NOT NULL,
                db TEXT NOT NULL,
                used_ids TEXT NOT NULL DEFAULT '[]',
                marked_ids TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_email, db)
            );
            INSERT INTO qbank_progress_new (user_email, db, used_ids, marked_ids, updated_at)
                SELECT '{_LEGACY_USER_EMAIL}', db, used_ids, marked_ids, updated_at FROM qbank_progress;
            DROP TABLE qbank_progress;
            ALTER TABLE qbank_progress_new RENAME TO qbank_progress;
            """
        )


_STATE_SCHEMA_READY = False


def _state_conn() -> sqlite3.Connection:
    # busy_timeout makes concurrent writers wait for the WAL lock instead of
    # immediately raising "database is locked". Those errors were swallowed by
    # the fire-and-forget activity client (lib/activity.ts), silently dropping
    # progress/scroll/search writes and contributing to the boot-time
    # /activity/* failure flood. The schema + migration only need to run once
    # per process, so gate them behind a flag rather than re-executing the
    # multi-statement script on every single request (which starved the event
    # loop while uvicorn was still warming up).
    global _STATE_SCHEMA_READY
    _QBANK_STATE_DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(_QBANK_STATE_DB, timeout=5.0)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA busy_timeout=5000")
    if _STATE_SCHEMA_READY:
        return c
    c.executescript(
        """
        -- Fresh installs get the per-user shape directly. Existing installs
        -- are upgraded by _migrate_qbank_state() below.
        CREATE TABLE IF NOT EXISTS qbank_sessions (
            id TEXT PRIMARY KEY,
            db TEXT NOT NULL,
            mode TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            question_count INTEGER NOT NULL DEFAULT 0,
            answered_count INTEGER NOT NULL DEFAULT 0,
            score INTEGER,
            payload TEXT NOT NULL,
            user_email TEXT NOT NULL DEFAULT 'legacy@medos'
        );
        CREATE INDEX IF NOT EXISTS idx_qbank_sessions_db_updated
            ON qbank_sessions(db, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_qbank_sessions_status
            ON qbank_sessions(status, updated_at DESC);
        -- idx_qbank_sessions_user_updated is created by _migrate_qbank_state
        -- so it can be added safely whether this is a fresh or existing DB.

        CREATE TABLE IF NOT EXISTS qbank_progress (
            user_email TEXT NOT NULL,
            db TEXT NOT NULL,
            used_ids TEXT NOT NULL DEFAULT '[]',
            marked_ids TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_email, db)
        );

        CREATE TABLE IF NOT EXISTS qbank_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS qbank_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            db TEXT NOT NULL,
            qid INTEGER,
            question_index INTEGER,
            event TEXT NOT NULL,
            answered_choice INTEGER,
            correct_choice INTEGER,
            elapsed_sec INTEGER,
            remaining_sec INTEGER,
            created_at TEXT NOT NULL,
            payload TEXT NOT NULL,
            user_email TEXT NOT NULL DEFAULT 'legacy@medos'
        );
        CREATE INDEX IF NOT EXISTS idx_qbank_activity_session
            ON qbank_activity(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_qbank_activity_db_qid
            ON qbank_activity(db, qid);
        -- idx_qbank_activity_user_created is created by _migrate_qbank_state.
        """
    )
    _migrate_qbank_state(c)
    c.commit()
    _STATE_SCHEMA_READY = True
    return c


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _normalize_id_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    ids: set[int] = set()
    for item in value:
        try:
            qid = int(item)
        except (TypeError, ValueError):
            continue
        if qid > 0:
            ids.add(qid)
    return sorted(ids)


def _normalize_progress_map(value: Any) -> dict[str, list[int]]:
    raw = value if isinstance(value, dict) else {}
    keys = set(_ALL_DBS) | {str(k) for k in raw.keys()}
    return {db: _normalize_id_list(raw.get(db)) for db in keys}


def _session_score(session: dict[str, Any]) -> int | None:
    questions = session.get("questions")
    answers = session.get("answers")
    if not isinstance(questions, list) or not isinstance(answers, dict):
        return None
    score = 0
    for raw_index, raw_answer in answers.items():
        try:
            index = int(raw_index)
            answer = int(raw_answer)
        except (TypeError, ValueError):
            continue
        if 0 <= index < len(questions):
            question = questions[index]
            if isinstance(question, dict) and int(question.get("correct") or 0) - 1 == answer:
                score += 1
    return score


def _session_metadata(session: dict[str, Any]) -> dict[str, Any]:
    session_id = str(session.get("id") or "").strip()
    if not session_id:
        raise ValueError("session.id is required")
    db = str(session.get("db") or "step2")
    if not _is_known_bank(db):
        raise ValueError("session.db is invalid")
    questions = session.get("questions") if isinstance(session.get("questions"), list) else []
    answers = session.get("answers") if isinstance(session.get("answers"), dict) else {}
    completed_at = session.get("completedAt") if isinstance(session.get("completedAt"), str) else None
    created_at = session.get("createdAt") if isinstance(session.get("createdAt"), str) else _utc_now()
    updated_at = session.get("updatedAt") if isinstance(session.get("updatedAt"), str) else created_at
    mode = str(session.get("mode") or "tutor")
    return {
        "id": session_id,
        "db": db,
        "mode": mode if mode in {"tutor", "exam"} else "tutor",
        "status": "completed" if completed_at else "active",
        "created_at": created_at,
        "updated_at": updated_at,
        "completed_at": completed_at,
        "question_count": len(questions),
        "answered_count": len(answers),
        "score": _session_score(session),
    }


def _upsert_session(c: sqlite3.Connection, session: dict[str, Any], user_email: str) -> None:
    if session.get("transient"):
        return
    meta = _session_metadata(session)
    # Enforce ownership: if a row with this id already exists under a different
    # user, refuse the write rather than silently steal it.
    existing = c.execute(
        "SELECT user_email FROM qbank_sessions WHERE id=?", (meta["id"],)
    ).fetchone()
    if existing and existing["user_email"] and existing["user_email"] != user_email:
        raise ValueError(f"session {meta['id']} already belongs to another user")
    c.execute(
        """
        INSERT INTO qbank_sessions (
            id, db, mode, status, created_at, updated_at, completed_at,
            question_count, answered_count, score, payload, user_email
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            db=excluded.db,
            mode=excluded.mode,
            status=excluded.status,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at,
            completed_at=excluded.completed_at,
            question_count=excluded.question_count,
            answered_count=excluded.answered_count,
            score=excluded.score,
            payload=excluded.payload,
            user_email=excluded.user_email
        """,
        (
            meta["id"],
            meta["db"],
            meta["mode"],
            meta["status"],
            meta["created_at"],
            meta["updated_at"],
            meta["completed_at"],
            meta["question_count"],
            meta["answered_count"],
            meta["score"],
            _json_dumps(session),
            user_email,
        ),
    )
    _replace_session_activity(c, session, meta["db"], meta["id"], user_email)


def _activity_from_answer_meta(session: dict[str, Any]) -> list[dict[str, Any]]:
    answer_meta = session.get("answerMeta")
    if not isinstance(answer_meta, dict):
        return []
    out: list[dict[str, Any]] = []
    for raw_index, meta in answer_meta.items():
        if not isinstance(meta, dict):
            continue
        try:
            question_index = int(raw_index)
        except (TypeError, ValueError):
            question_index = int(meta.get("questionIndex") or 0)
        out.append({
            "event": "answer",
            "qid": meta.get("qid"),
            "questionIndex": question_index,
            "answeredChoice": meta.get("choiceIndex"),
            "correctChoice": meta.get("correctIndex"),
            "elapsedSec": meta.get("elapsedSec"),
            "remainingSec": meta.get("remainingSec"),
            "createdAt": meta.get("answeredAt") or session.get("updatedAt") or _utc_now(),
        })
    return out


def _replace_session_activity(
    c: sqlite3.Connection,
    session: dict[str, Any],
    db: str,
    session_id: str,
    user_email: str,
) -> None:
    # Scope the delete to this user so we can't accidentally clear another
    # tester's activity if a session_id collision ever sneaks in.
    c.execute(
        "DELETE FROM qbank_activity WHERE session_id=? AND user_email=?",
        (session_id, user_email),
    )
    events = session.get("activity") if isinstance(session.get("activity"), list) else []
    combined = [event for event in events if isinstance(event, dict)] + _activity_from_answer_meta(session)
    seen: set[str] = set()
    rows = []
    for event in combined[-2000:]:
        payload = _json_dumps(event)
        dedupe_key = hashlib.sha1(payload.encode("utf-8", "ignore")).hexdigest()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        rows.append(
            (
                session_id,
                db,
                _safe_int(event.get("qid")),
                _safe_int(event.get("questionIndex")),
                str(event.get("event") or "activity")[:60],
                _safe_int(event.get("answeredChoice")),
                _safe_int(event.get("correctChoice")),
                _safe_int(event.get("elapsedSec")),
                _safe_int(event.get("remainingSec")),
                str(event.get("createdAt") or _utc_now()),
                payload,
                user_email,
            )
        )
    if rows:
        c.executemany(
            """
            INSERT INTO qbank_activity (
                session_id, db, qid, question_index, event, answered_choice,
                correct_choice, elapsed_sec, remaining_sec, created_at, payload, user_email
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _save_progress(
    c: sqlite3.Connection,
    user_email: str,
    used_by_db: dict[str, list[int]] | None = None,
    marked_by_db: dict[str, list[int]] | None = None,
) -> None:
    now = _utc_now()
    used = _normalize_progress_map(used_by_db) if used_by_db is not None else None
    marked = _normalize_progress_map(marked_by_db) if marked_by_db is not None else None
    keys = set(_ALL_DBS)
    if used is not None:
        keys |= set(used)
    if marked is not None:
        keys |= set(marked)
    for db in sorted(keys):
        current = c.execute(
            "SELECT used_ids, marked_ids FROM qbank_progress WHERE user_email=? AND db=?",
            (user_email, db),
        ).fetchone()
        current_used = _json_loads(current["used_ids"], []) if current else []
        current_marked = _json_loads(current["marked_ids"], []) if current else []
        # used_ids only ever GROW on this hot save path — a question can't be
        # un-answered here (the dedicated /reset endpoint is the only way to
        # clear them) — so UNION with the existing row. This makes the save
        # idempotent and race-safe: two tabs/devices posting stale-but-partial
        # maps can no longer clobber each other's newer answered QIDs.
        if used is not None and db in used:
            next_used = _normalize_id_list(list(current_used) + list(used[db]))
        else:
            next_used = _normalize_id_list(current_used)
        # marked_ids CAN shrink: the client persists an un-flag by PUTting the
        # reduced set (QuizEngine setQuestionMarkedForRevision), so this side
        # must REPLACE with the posted set, not union — otherwise un-flagging
        # would never stick. Cross-device marks are reconciled by the client's
        # load-time union instead.
        if marked is not None and db in marked:
            next_marked = _normalize_id_list(marked[db])
        else:
            next_marked = _normalize_id_list(current_marked)
        c.execute(
            """
            INSERT INTO qbank_progress (user_email, db, used_ids, marked_ids, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_email, db) DO UPDATE SET
                used_ids=excluded.used_ids,
                marked_ids=excluded.marked_ids,
                updated_at=excluded.updated_at
            """,
            (user_email, db, _json_dumps(next_used), _json_dumps(next_marked), now),
        )


def _read_user_state(c: sqlite3.Connection, user_email: str, limit: int = 200) -> dict[str, Any]:
    progress_rows = c.execute(
        "SELECT db, used_ids, marked_ids FROM qbank_progress WHERE user_email=?",
        (user_email,),
    ).fetchall()
    used: dict[str, list[int]] = {db: [] for db in _ALL_DBS}
    marked: dict[str, list[int]] = {db: [] for db in _ALL_DBS}
    for row in progress_rows:
        db = row["db"]
        used[db] = _normalize_id_list(_json_loads(row["used_ids"], []))
        marked[db] = _normalize_id_list(_json_loads(row["marked_ids"], []))
    # trackingPref is a UI preference that stays global — it's per-deploy, not
    # per-tester (testers shouldn't toggle each other's preference, but neither
    # is it sensitive). Keeping it global avoids growing the qbank_settings shape.
    setting = c.execute("SELECT value FROM qbank_settings WHERE key='trackingPref'").fetchone()
    tracking_pref = True if not setting else setting["value"] != "practice"
    session_rows = c.execute(
        "SELECT payload FROM qbank_sessions WHERE user_email=? ORDER BY updated_at DESC LIMIT ?",
        (user_email, limit),
    ).fetchall()
    sessions = []
    for row in session_rows:
        payload = _json_loads(row["payload"], None)
        if isinstance(payload, dict):
            sessions.append(payload)
    return {
        "sessions": sessions,
        "usedIdsByDb": used,
        "markedIdsByDb": marked,
        "trackingPref": tracking_pref,
        "trackingPrefStored": bool(setting),
        "storage": str(_QBANK_STATE_DB),
    }


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _split_media(value: str | None) -> list[str]:
    if not value:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for token in re.split(r"[,;|\s]+", value):
        name = token.strip().strip("\"'")
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        out.append(name)
    return out


def _clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


# <style>/<script> blocks must be dropped *with their content* before tag
# stripping — AMBOSS qbank HTML embeds a scoped <style> block whose CSS would
# otherwise leak into the plaintext stem/explanation (and into FTS/quality).
_RE_STYLE_SCRIPT = re.compile(r"(?is)<(style|script)\b[^>]*>.*?</\1>")


def _plain_from_html(value: str | None) -> str:
    if not value:
        return ""
    text = _RE_STYLE_SCRIPT.sub(" ", value)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(?:p|div|li|tr|table|ul|ol|h[1-6])>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    return _clean_text(html.unescape(text))


def _plain_inline_html(value: str | None) -> str:
    if not value:
        return ""
    text = _RE_STYLE_SCRIPT.sub(" ", value)
    return _clean_text(html.unescape(re.sub(r"<[^>]+>", " ", text)))


def _salt_min8(value: int | str) -> bytes:
    salt = str(value)
    while len(salt) < 8:
        salt += " "
    return salt.encode("utf-8")


# ── v2 content scheme (NBME self-assessments + CMS clinical forms) ──────────
# Reverse-engineered from net.imedicaldoctor.imd.crypto.ContentEncryptionV2:
#   value  = "v2:" + base64(blob)
#   blob   = [0]=version(2) [1]=flags [2:14]=12-byte GCM nonce
#            [14:-16]=ciphertext  [-16:]=16-byte GCM tag
#   key    = SHA-256("YHYZYNVLBEKPQCGDWFNPDAAIO")   (the fixed activation secret
#            ActivationSchemeV2.o() always resolves to; device-independent)
#   AAD    = (str(qid) + "|128").encode()           (per-cell binding to the row id)
#   flags & 1  → gzip-compressed plaintext
_V2_PREFIX = "v2:"
_V2_SECRET = "YHYZYNVLBEKPQCGDWFNPDAAIO"
_V2_KEY = hashlib.sha256(_V2_SECRET.encode("utf-8")).digest()
MAX_DECOMPRESSED_HTML_BYTES = 4 * 1024 * 1024


def _safe_gzip_decompress(raw: bytes) -> bytes:
    try:
        out = bytearray()
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
            while True:
                chunk = gz.read(64 * 1024)
                if not chunk:
                    break
                out.extend(chunk)
                if len(out) > MAX_DECOMPRESSED_HTML_BYTES:
                    return b""
        return bytes(out)
    except Exception:
        return b""


def _decrypt_v2(aad_base: str, payload: str) -> str:
    """Decrypt an AES-256-GCM 'v2:' content cell. Returns '' on any failure."""
    try:
        blob = base64.b64decode(payload[len(_V2_PREFIX):].strip())
        if len(blob) < 31 or blob[0] != 2:
            return ""
        flags = blob[1]
        nonce = blob[2:14]
        tag = blob[-16:]
        ct = blob[14:-16]
        cipher = AES.new(_V2_KEY, AES.MODE_GCM, nonce=nonce)
        cipher.update((aad_base + "|128").encode("utf-8"))
        raw = cipher.decrypt_and_verify(ct, tag)
        if flags & 1:
            raw = _safe_gzip_decompress(raw)
            if not raw:
                return ""
        return raw.decode("utf-8", "replace")
    except Exception:
        return ""


@lru_cache(maxsize=4096)
def _decrypt_qbank_html(qid: int, payload: str | None) -> str:
    if not payload:
        return ""
    # Generated source adapters use an explicit marker. Unmarked payloads keep
    # following the vendor encryption paths, so accepting MKSAP plaintext does
    # not accidentally treat corrupt encrypted content as trusted HTML.
    if payload.startswith("medos-plain:"):
        return payload[len("medos-plain:"):]
    if payload.startswith(_V2_PREFIX):
        return _decrypt_v2(str(qid), payload)
    try:
        key = hashlib.pbkdf2_hmac("sha1", _content_password().encode("utf-8"), _salt_min8(qid), 19, 16)
        raw = AES.new(key, AES.MODE_CBC, _PAYLOAD_IV).decrypt(base64.b64decode(payload))
        try:
            raw = unpad(raw, 16)
        except ValueError:
            pass
        inflated = _safe_gzip_decompress(raw)
        if not inflated:
            return ""
        return inflated.decode("utf-8", "replace")
    except Exception:
        return ""


_RE_HINT_BLOCK = re.compile(
    r"""(?isx)
    <button\b[^>]*>\s*Show\s+Hint\s*</button>
    \s*
    <div\b(?=[^>]*\bid\s*=\s*["']hintdiv["'])[^>]*>
    (?P<body>.*?)
    </div>
    """
)


def _rewrite_hint_blocks(value: str) -> str:
    def repl(match: re.Match) -> str:
        body = match.group("body").strip()
        return (
            '<details class="qbank-hint">'
            "<summary>Show Hint</summary>"
            f'<div class="qbank-hint-body">{body}</div>'
            "</details>"
        )

    return _RE_HINT_BLOCK.sub(repl, value)


def _clean_html(value: str | None) -> str:
    if not value:
        return ""
    cleaned = _rewrite_hint_blocks(value)
    cleaned = re.sub(r"(?is)<script\b[^>]*>.*?</script>", "", cleaned)
    cleaned = re.sub(r"(?is)<iframe\b[^>]*>.*?</iframe>", "", cleaned)
    cleaned = re.sub(r"\s+on[a-z]+\s*=\s*(['\"]).*?\1", "", cleaned)
    cleaned = re.sub(r"\s+href\s*=\s*(['\"])\s*javascript:[^'\"]*\1", "", cleaned, flags=re.I)
    return cleaned


def _html_media_names(value: str | None) -> list[str]:
    if not value:
        return []
    names: list[str] = []
    for match in re.finditer(
        r"""(?ix)
        (?:src|href)\s*=\s*["']
        (?:
          https?://[^"']+/(?:webmedia|media)/|
          (?:\.\./)*media/
        )?
        (?P<name>[^"'/?#]+\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|m4v|mp3))
        """,
        value,
    ):
        names.append(match.group("name"))
    return names


def _rewrite_media_links(qid: int, value: str | None) -> str:
    if not value:
        return ""

    def repl(match: re.Match) -> str:
        attr = match.group("attr")
        quote = match.group("quote")
        name = Path(match.group("name")).name
        return f'{attr}={quote}/qbank/media/{qid}/{name}{quote}'

    rewritten = re.sub(
        r"""(?ix)
        (?P<attr>src|href)\s*=\s*(?P<quote>["'])
        (?:
          https?://[^"']+/(?:webmedia|media)/|
          (?:\.\./)*media/
        )?
        (?P<name>[^"'/?#]+\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|m4v|mp3))
        (?P=quote)
        """,
        repl,
        value,
    )
    return re.sub(
        r"""(?ix)
        (?P<attr>href)\s*=\s*(?P<quote>["'])
        (?P<id>\d{3,8})\.html
        (?P=quote)
        """,
        lambda m: (
            # Carry the linking question's id as a fast-path HINT. NOTE: in the
            # UWorld schema the exhibit fragment usually lives in a DIFFERENT
            # question than the one linking to it, so this hint often misses — the
            # authoritative O(1) lookup is the exhibit_id->owner-qid index in
            # _exhibit_html (_exhibit_qid_map). The hint is cheap (one row) and is a
            # correct shortcut for the cases where the fragment IS co-located.
            f'{m.group("attr")}={m.group("quote")}/qbank/exhibit/{m.group("id")}?srcqid={qid}'
            f'{m.group("quote")} target="_blank" rel="noopener noreferrer"'
        ),
        rewritten,
    )


def _derive_tags(title: str, subject: str, system: str) -> list[str]:
    tags: list[str] = []
    for raw in (subject, system, title):
        if re.fullmatch(r"\s*Question\s*-\s*\d+\s*", raw or "", re.IGNORECASE):
            continue
        for part in re.split(r"[(),/&;:]+", raw or ""):
            token = _clean_text(part)
            if len(token) < 3:
                continue
            if token.lower() not in {t.lower() for t in tags}:
                tags.append(token)
    return tags[:10]


def _system_group(system: str) -> str:
    return _clean_text(re.sub(r"\s*\([^)]*\)\s*$", "", system or ""))


def _system_detail(system: str) -> str:
    m = re.search(r"\(([^)]*)\)\s*$", system or "")
    return _clean_text(m.group(1) if m else "")


_AMBOSS_TAXONOMY_CACHE: dict[tuple[str, str], dict[int, str]] = {}


def _is_amboss_category(category: str) -> bool:
    """AMBOSS exam and ABIM bundles share comma-separated taxonomy IDs."""
    return category == "amboss" or category.startswith("amboss_")


def _is_amboss_qbank(db: DB_KEY | None) -> bool:
    if not db:
        return False
    try:
        return _is_amboss_category(_resolve_bank(str(db)).category)
    except Exception:
        return False


def _parse_amboss_taxonomy_ids(value: Any) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for part in re.split(r"[^0-9]+", str(value or "")):
        if not part:
            continue
        try:
            item = int(part)
        except ValueError:
            continue
        if item <= 0 or item in seen:
            continue
        seen.add(item)
        ids.append(item)
    return ids


def _amboss_taxonomy_map(db: DB_KEY, table: str) -> dict[int, str]:
    key = (str(db), table)
    cached = _AMBOSS_TAXONOMY_CACHE.get(key)
    if cached is not None:
        return cached
    if table not in {"Subjects", "Systems"}:
        return {}
    c = _conn(db)
    try:
        rows = c.execute(f"SELECT id, name FROM {table}").fetchall()
    finally:
        c.close()
    mapping = {int(r["id"]): _clean_text(r["name"] or "") for r in rows if _clean_text(r["name"] or "")}
    _AMBOSS_TAXONOMY_CACHE[key] = mapping
    return mapping


def _amboss_taxonomy_names(db: DB_KEY, table: str, value: Any) -> str:
    mapping = _amboss_taxonomy_map(db, table)
    names = [mapping[item] for item in _parse_amboss_taxonomy_ids(value) if item in mapping]
    return ", ".join(names)


def _csv_membership_sql(column: str) -> str:
    return f"(',' || REPLACE(COALESCE({column}, ''), ' ', '') || ',') LIKE ?"


def _csv_membership_param(value: int) -> str:
    return f"%,{int(value)},%"


def _amboss_subsystem_token(system_id: int, subject_id: int) -> int:
    return _AMBOSS_SUBSYSTEM_ID_BASE + int(system_id) * _AMBOSS_SUBSYSTEM_ID_FACTOR + int(subject_id)


def _amboss_subsystem_pair(value: Any) -> tuple[int, int] | None:
    try:
        token = int(value)
    except (TypeError, ValueError):
        return None
    if token < _AMBOSS_SUBSYSTEM_ID_BASE:
        return None
    raw = token - _AMBOSS_SUBSYSTEM_ID_BASE
    system_id = raw // _AMBOSS_SUBSYSTEM_ID_FACTOR
    subject_id = raw % _AMBOSS_SUBSYSTEM_ID_FACTOR
    if system_id <= 0 or subject_id <= 0:
        return None
    return system_id, subject_id


def _amboss_system_filter_clause(system_id: int) -> tuple[str, list[str]]:
    return _csv_membership_sql("q.sysId"), [_csv_membership_param(system_id)]


def _amboss_subsystem_filter_clause(system_id: int, subject_id: int) -> tuple[str, list[str]]:
    return (
        f"({_csv_membership_sql('q.sysId')} AND {_csv_membership_sql('q.subId')})",
        [_csv_membership_param(system_id), _csv_membership_param(subject_id)],
    )


def _fts_query(value: str) -> str:
    terms = re.findall(r"[A-Za-z0-9]+", value)
    if not terms:
        return ""
    return " ".join(f"{term}*" for term in terms[:8])


def _quality(choices: list[str], stem: str, correct: int | None) -> dict:
    nonempty = sum(1 for c in choices if _clean_text(c))
    correct_index = int(correct or 0) - 1
    correct_visible = 0 <= correct_index < len(choices) and bool(_clean_text(choices[correct_index]))
    all_answers_visible = len(choices) >= 2 and nonempty == len(choices)
    valid = bool(_clean_text(stem)) and all_answers_visible and correct_visible
    issues: list[str] = []
    if not _clean_text(stem):
        issues.append("missing_stem")
    if nonempty < 2:
        issues.append("missing_answers")
    elif nonempty != len(choices):
        issues.append("hidden_answer_choice")
    if not correct or int(correct) < 1 or int(correct) > max(1, len(choices)):
        issues.append("invalid_correct_answer")
    elif not correct_visible:
        issues.append("hidden_correct_answer")
    return {"valid": valid, "answer_count": nonempty, "issues": issues}


def _build_question(row: sqlite3.Row, fts_rows: list[sqlite3.Row], answer_rows: list[sqlite3.Row], db: DB_KEY | None = None) -> dict:
    """Assemble a complete question dict from Questions row + rich encrypted HTML."""
    stem_html = _clean_html(_rewrite_media_links(row["id"], _decrypt_qbank_html(row["id"], row["question"])))
    explanation_html = _clean_html(_rewrite_media_links(row["id"], _decrypt_qbank_html(row["id"], row["explanation"])))
    choices_html = [
        _clean_html(_rewrite_media_links(row["id"], _decrypt_qbank_html(row["id"], a["answerText"])))
        for a in answer_rows
    ]

    stem = _plain_from_html(stem_html)
    explanation = _plain_from_html(explanation_html)
    choices = [_plain_from_html(choice) for choice in choices_html]
    fts_choices: list[str] = []

    for f in fts_rows:
        t = f["c2type"]
        if t == 1 and not stem:
            stem = _clean_text(f["c1content"])
        elif t == 2 and not explanation:
            explanation = _clean_text(f["c1content"])
        elif t == 3:
            fts_choices.append(_clean_text(f["c1content"]))
    for i, fallback in enumerate(fts_choices):
        if i >= len(choices):
            choices.append(fallback)
            choices_html.append(html.escape(fallback))
        elif not choices[i] and fallback:
            choices[i] = fallback
            choices_html[i] = html.escape(fallback)
    for i, choice_html in enumerate(choices_html):
        if i < len(choices) and not choices[i] and re.search(r"(?i)<(?:img|video|audio)\b", choice_html):
            choices[i] = "Image answer"

    # q.media = only the declared primary question media (mediaName).
    # Stem-embedded images are intentionally excluded: the frontend exhibit panel
    # already surfaces them via mediaLinksFromHtml(stem_html), and including them
    # here would render the image twice (once inline in the stem, once in the grid).
    q_media_names = _split_media(row["mediaName"])
    deduped_media: list[str] = []
    seen_media: set[str] = set()
    for name in q_media_names:
        key = name.lower()
        if key in seen_media:
            continue
        seen_media.add(key)
        deduped_media.append(name)

    # explanation_media = supplementary media shown AFTER the user answers.
    # We only include otherMedias items that are NOT already embedded inline in
    # explanation_html — those render via the HTML renderer and need no grid entry.
    expl_html_set = set(n.lower() for n in _html_media_names(explanation_html))
    deduped_expl_media: list[str] = []
    seen_expl: set[str] = set()
    for name in _split_media(row["otherMedias"]):
        key = name.lower()
        if key in seen_expl or key in expl_html_set:
            continue
        seen_expl.add(key)
        deduped_expl_media.append(name)
    subject = row["subject_name"] if "subject_name" in row.keys() else ""
    system = row["system_name"] if "system_name" in row.keys() else ""
    if _is_amboss_qbank(db):
        subject = _amboss_taxonomy_names(db, "Subjects", row["subId"]) or subject
        system = _amboss_taxonomy_names(db, "Systems", row["sysId"]) or system
    tags = _derive_tags(row["title"] or "", subject or "", system or "")
    group = _system_group(system or "")
    detail = _system_detail(system or "")

    # Consecutive question metadata: parentQId == id means this is a series parent;
    # parentQId != id means this must follow its parent in order.
    parent_qid = None
    question_type = None
    if "parentQId" in row.keys():
        raw_parent = row["parentQId"]
        parent_qid = int(raw_parent) if raw_parent else None
    if "questionType" in row.keys():
        question_type = int(row["questionType"]) if row["questionType"] else 1

    return {
        "id":          row["id"],
        "title":       row["title"] or "",
        "stem":        stem,
        "stem_html":   stem_html,
        "choices":     choices,
        "choices_html": choices_html,
        "correct":     row["corrAns"],        # 1-based index
        "explanation": explanation,
        "explanation_html": explanation_html,
        "subject_id":  row["subId"],
        "system_id":   row["sysId"],
        "subject":     subject or "",
        "system":      system or "",
        "system_group": group,
        "system_detail": detail,
        "tags":        tags,
        "parentQId":   parent_qid,
        "questionType": question_type,
        "media": [
            {"name": name, "url": f"/qbank/media/{row['id']}/{name}"}
            for name in deduped_media
        ],
        "explanation_media": [
            {"name": name, "url": f"/qbank/media/{row['id']}/{name}"}
            for name in deduped_expl_media
        ],
        "answer_stats": {
            "taken": row["pplTaken"] if "pplTaken" in row.keys() else None,
            "correct": row["corrTaken"] if "corrTaken" in row.keys() else None,
            "percent_correct": round((float(row["corrTaken"]) / float(row["pplTaken"])) * 100)
            if ("pplTaken" in row.keys() and "corrTaken" in row.keys() and row["pplTaken"]) else None,
        },
        "quality": _quality(choices, stem, row["corrAns"]),
    }


def _attach_source_metadata(
    question: dict,
    c: sqlite3.Connection,
    db: DB_KEY | None,
) -> dict:
    """Add adapter-only provenance without changing the shared qbank schema."""
    if not question or not db:
        return question
    try:
        if _resolve_bank(str(db)).category not in ("mksap", "imported"):
            return question
        row = c.execute(
            "SELECT sourceId, sourceKind, tags FROM SourceMetadata WHERE qId=?",
            (question["id"],),
        ).fetchone()
    except (HTTPException, sqlite3.Error):
        return question
    if not row:
        return question
    question["source_id"] = row["sourceId"] or ""
    question["source_kind"] = row["sourceKind"] or ""
    try:
        source_tags = json.loads(row["tags"] or "[]")
    except (TypeError, json.JSONDecodeError):
        source_tags = []
    seen = {str(tag).lower() for tag in question.get("tags", [])}
    for tag in source_tags if isinstance(source_tags, list) else []:
        clean = _clean_text(str(tag))
        if clean and clean.lower() not in seen:
            question.setdefault("tags", []).append(clean)
            seen.add(clean.lower())
    return question


def _fetch_full_question(c: sqlite3.Connection, qid: int, db: DB_KEY | None = None) -> dict:
    qrow = c.execute(
        "SELECT q.id, q.question, q.explanation, q.title, q.corrAns, q.subId, q.sysId, q.pplTaken, q.corrTaken, "
        "q.mediaName, q.otherMedias, q.parentQId, q.questionType, q.questionFormatType, "
        "subj.name AS subject_name, sys.name AS system_name "
        "FROM Questions q "
        "LEFT JOIN Subjects subj ON subj.id=q.subId "
        "LEFT JOIN Systems sys ON sys.id=q.sysId "
        "WHERE q.id=?",
        (qid,)
    ).fetchone()
    if not qrow:
        return {}
    fts = c.execute(
        "SELECT c2type, c1content FROM Search_content "
        "WHERE c4contentId=? AND c2type IN (1,2,3) ORDER BY c2type, docid",
        (qid,)
    ).fetchall()
    answers = c.execute(
        "SELECT answerId, answerText FROM Answers WHERE qId=? ORDER BY answerId",
        (qid,),
    ).fetchall()
    return _attach_source_metadata(_build_question(qrow, fts, answers, db), c, db)


def _bank_cache_signature(db: DB_KEY) -> str:
    st = _db_path(db).stat()
    parts = ["media-aware-v1", str(st.st_size), str(st.st_mtime_ns)]
    media_dirs = [_bank_media_dir(db)]
    if _is_amboss_qbank(db):
        shared = _shared_amboss_images_dir()
        if shared is not None:
            media_dirs.append(shared)
        media_dirs.extend(
            info.db_path.parent / "media-E"
            for info in _bank_registry().values()
            if _is_amboss_category(info.category) and info.key != str(db)
        )
    for directory in media_dirs:
        try:
            info = directory.stat()
            parts.extend((str(directory), str(info.st_mtime_ns)))
        except OSError:
            parts.extend((str(directory), "missing"))
    return ":".join(parts)


def _valid_ids_disk_load(db: DB_KEY) -> set[int] | None:
    try:
        path = _VALID_IDS_DISK_DIR / f"{db}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("sig") != _bank_cache_signature(db):
            return None
        return {int(i) for i in data["ids"]}
    except Exception:
        return None


def _valid_ids_disk_store(db: DB_KEY, ids: set[int]) -> None:
    try:
        _VALID_IDS_DISK_DIR.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"sig": _bank_cache_signature(db), "ids": sorted(ids)})
        tmp = _VALID_IDS_DISK_DIR / f"{db}.json.tmp"
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(_VALID_IDS_DISK_DIR / f"{db}.json")
    except Exception:
        pass  # cache is best-effort; recompute next boot


def _valid_ids(db: DB_KEY) -> set[int]:
    cached = _VALID_IDS_CACHE.get(db)
    if cached is not None:
        return cached
    with _VALID_IDS_LOCK:
        db_lock = _VALID_IDS_DB_LOCKS.setdefault(db, threading.Lock())
    with db_lock:
        cached = _VALID_IDS_CACHE.get(db)
        if cached is not None:
            return cached
        disk = _valid_ids_disk_load(db)
        if disk is not None:
            _VALID_IDS_CACHE[db] = disk
            return disk
        return _compute_valid_ids(db)


def _compute_valid_ids(db: DB_KEY) -> set[int]:
    c = _conn(db)
    try:
        stems: dict[int, str] = {}
        correct: dict[int, int] = {}
        required_media: dict[int, set[str]] = {}
        for r in c.execute("SELECT id, question, corrAns, mediaName FROM Questions"):
            qid = int(r["id"])
            stem_html = _decrypt_qbank_html(qid, r["question"])
            stems[qid] = _plain_from_html(stem_html)
            correct[qid] = int(r["corrAns"] or 0)
            required_media[qid] = set(
                _split_media(r["mediaName"]) + _html_media_names(stem_html)
            )
        choices: dict[int, list[str]] = {}
        for r in c.execute(
            "SELECT qId, answerId, answerText FROM Answers ORDER BY qId, answerId"
        ):
            qid = int(r["qId"])
            choice_html = _decrypt_qbank_html(qid, r["answerText"])
            required_media.setdefault(qid, set()).update(_html_media_names(choice_html))
            choice_text = _plain_from_html(choice_html)
            if not choice_text and re.search(r"(?i)<(?:img|video|audio)\b", choice_html):
                choice_text = "Image answer"
            choices.setdefault(qid, []).append(choice_text)
        # NBME/CMS banks store the encrypted columns in a format _decrypt_qbank_html
        # can't read (v2: prefix), so the decrypted stem/choices come back empty.
        # Mirror _build_question's fallback: fill blanks from the plaintext FTS
        # Search_content (type 1 = stem, type 3 = answer choices in order).
        fts_stems: dict[int, str] = {}
        fts_choices: dict[int, list[str]] = {}
        for r in c.execute(
            "SELECT c4contentId AS qid, c2type AS t, c1content AS content "
            "FROM Search_content WHERE c2type IN (1,3) ORDER BY c4contentId, c2type, docid"
        ):
            qid = int(r["qid"])
            if r["t"] == 1:
                fts_stems.setdefault(qid, _clean_text(r["content"]))
            else:  # t == 3 → one answer choice, in order
                fts_choices.setdefault(qid, []).append(_clean_text(r["content"]))
        for qid, fb in fts_stems.items():
            if not stems.get(qid):
                stems[qid] = fb
        for qid, fb_list in fts_choices.items():
            lst = choices.setdefault(qid, [])
            for i, fallback in enumerate(fb_list):
                if i >= len(lst):
                    lst.append(fallback)
                elif not lst[i] and fallback:
                    lst[i] = fallback
        valid = {
            qid for qid, q_choices in choices.items()
            if qid in stems
            and _quality(q_choices, stems[qid], correct.get(qid)).get("valid")
            and all(
                _resolve_qbank_media_path(db, qid, name) is not None
                for name in required_media.get(qid, ())
            )
        }
    finally:
        c.close()
    _VALID_IDS_CACHE[db] = valid
    _valid_ids_disk_store(db, valid)
    return valid


def _question_where(
    db: DB_KEY,
    subject_id: Optional[int],
    system_id: Optional[int],
    system_group: str | None,
    q: str | None,
    tag: str | None,
    valid_only: bool,
    system_ids: Optional[list[int]] = None,
    subject_ids: Optional[list[int]] = None,
    images_only: bool = False,
) -> tuple[str, list]:
    where_parts = []
    params: list = []
    is_amboss = _is_amboss_qbank(db)
    # Multi-select takes precedence over the single-id params so the Create Test
    # tree can build a block across several systems/subjects at once.
    if subject_ids:
        if is_amboss:
            where_parts.append("(" + " OR ".join(_csv_membership_sql("q.subId") for _ in subject_ids) + ")")
            params.extend(_csv_membership_param(item) for item in subject_ids)
        else:
            placeholders = ",".join("?" for _ in subject_ids)
            where_parts.append(f"q.subId IN ({placeholders})")
            params.extend(subject_ids)
    elif subject_id is not None:
        if is_amboss:
            where_parts.append(_csv_membership_sql("q.subId"))
            params.append(_csv_membership_param(subject_id))
        else:
            where_parts.append("q.subId=?")
            params.append(subject_id)
    if system_ids:
        if is_amboss:
            clauses: list[str] = []
            for item in system_ids:
                pair = _amboss_subsystem_pair(item)
                if pair:
                    clause, clause_params = _amboss_subsystem_filter_clause(pair[0], pair[1])
                else:
                    clause, clause_params = _amboss_system_filter_clause(item)
                clauses.append(clause)
                params.extend(clause_params)
            where_parts.append("(" + " OR ".join(clauses) + ")")
        else:
            placeholders = ",".join("?" for _ in system_ids)
            where_parts.append(f"q.sysId IN ({placeholders})")
            params.extend(system_ids)
    elif system_id is not None:
        if is_amboss:
            pair = _amboss_subsystem_pair(system_id)
            if pair:
                clause, clause_params = _amboss_subsystem_filter_clause(pair[0], pair[1])
            else:
                clause, clause_params = _amboss_system_filter_clause(system_id)
            where_parts.append(clause)
            params.extend(clause_params)
        else:
            where_parts.append("q.sysId=?")
            params.append(system_id)
    group_query = _clean_text(system_group)
    if group_query:
        where_parts.append("(sys.name=? OR sys.name LIKE ?)")
        params.extend([group_query, f"{group_query} (%"])
    query = _clean_text(q)
    if query:
        fts = _fts_query(query)
        like = f"%{query}%"
        if is_amboss:
            where_parts.append(
                "(q.title LIKE ? OR sys.name LIKE ? OR "
                "EXISTS (SELECT 1 FROM Subjects subj_filter "
                "WHERE (',' || REPLACE(COALESCE(q.subId, ''), ' ', '') || ',') LIKE '%,' || subj_filter.id || ',%' "
                "AND subj_filter.name LIKE ?) OR "
                "q.id IN (SELECT DISTINCT contentId FROM Search WHERE Search MATCH ?))"
            )
            params.extend([like, like, like, fts or query])
        else:
            where_parts.append(
                "(q.title LIKE ? OR subj.name LIKE ? OR sys.name LIKE ? OR "
                "q.id IN (SELECT DISTINCT contentId FROM Search WHERE Search MATCH ?))"
            )
            params.extend([like, like, like, fts or query])
    tag_query = _clean_text(tag)
    if tag_query:
        like = f"%{tag_query}%"
        if is_amboss:
            where_parts.append(
                "(q.title LIKE ? OR sys.name LIKE ? OR "
                "EXISTS (SELECT 1 FROM Subjects subj_filter "
                "WHERE (',' || REPLACE(COALESCE(q.subId, ''), ' ', '') || ',') LIKE '%,' || subj_filter.id || ',%' "
                "AND subj_filter.name LIKE ?))"
            )
            params.extend([like, like, like])
        else:
            where_parts.append("(q.title LIKE ? OR subj.name LIKE ? OR sys.name LIKE ?)")
            params.extend([like, like, like])
    if images_only:
        where_parts.append(
            "(COALESCE(q.mediaName, '') != '' OR COALESCE(q.otherMedias, '') != '')"
        )
    if valid_only:
        ids = sorted(_valid_ids(db))
        if not ids:
            where_parts.append("1=0")
        else:
            where_parts.append(f"q.id IN ({','.join('?' for _ in ids)})")
            params.extend(ids)
    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    return where, params


def _parse_exclude_ids(value: str | None) -> list[int]:
    if not value:
        return []
    ids: set[int] = set()
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            qid = int(item)
        except ValueError:
            continue
        if qid > 0:
            ids.add(qid)
    return sorted(ids)


def _append_excluded_ids(where: str, exclude_ids: str | None) -> str:
    ids = _parse_exclude_ids(exclude_ids)
    if not ids:
        return where
    clause = f"q.id NOT IN ({','.join(str(qid) for qid in ids)})"
    if where:
        return f"{where} AND {clause}"
    return f"WHERE {clause}"


def _append_included_ids(where: str, include_ids: str | None) -> str:
    ids = _parse_exclude_ids(include_ids)
    if not include_ids:
        return where
    clause = f"q.id IN ({','.join(str(qid) for qid in ids)})" if ids else "1=0"
    if where:
        return f"{where} AND {clause}"
    return f"WHERE {clause}"


def _question_select(where: str, order: str) -> str:
    return (
        "SELECT q.id, q.question, q.explanation, q.title, q.corrAns, q.subId, q.sysId, q.pplTaken, q.corrTaken, "
        "q.mediaName, q.otherMedias, q.parentQId, q.questionType, q.questionFormatType, "
        "subj.name AS subject_name, sys.name AS system_name "
        "FROM Questions q "
        "LEFT JOIN Subjects subj ON subj.id=q.subId "
        "LEFT JOIN Systems sys ON sys.id=q.sysId "
        f"{where} {order}"
    )


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/state")
def qbank_state(
    limit: int = Query(default=200, ge=1, le=1000),
    user_email: str = Depends(require_user),
):
    """Return this tester's QBank progress persisted outside browser storage."""
    c = _state_conn()
    try:
        _save_progress(c, user_email)
        c.commit()
        return _read_user_state(c, user_email, limit)
    finally:
        c.close()


@router.put("/state")
def save_qbank_state(
    req: QBankUserState,
    user_email: str = Depends(require_user),
):
    c = _state_conn()
    try:
        _save_progress(c, user_email, req.usedIdsByDb, req.markedIdsByDb)
        if req.trackingPref is not None:
            c.execute(
                """
                INSERT INTO qbank_settings (key, value, updated_at)
                VALUES ('trackingPref', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value=excluded.value,
                    updated_at=excluded.updated_at
                """,
                ("prep" if req.trackingPref else "practice", _utc_now()),
            )
        for session in req.sessions or []:
            try:
                _upsert_session(c, session, user_email)
            except ValueError:
                # Either malformed payload OR session belongs to a different
                # user — both are silently skipped on a bulk save.
                continue
        c.commit()
        return _read_user_state(c, user_email)
    finally:
        c.close()


@router.put("/sessions/{session_id}")
def save_qbank_session(
    session_id: str,
    req: QBankSessionBody,
    user_email: str = Depends(require_user),
):
    session = dict(req.session)
    if not session.get("id"):
        session["id"] = session_id
    if str(session.get("id")) != session_id:
        raise HTTPException(400, "Session ID in path and body do not match")
    c = _state_conn()
    try:
        _upsert_session(c, session, user_email)
        c.commit()
        return {"ok": True, "session_id": session_id}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    finally:
        c.close()


@router.delete("/sessions/{session_id}")
def delete_qbank_session(
    session_id: str,
    user_email: str = Depends(require_user),
):
    c = _state_conn()
    try:
        # Only delete rows owned by the caller, even if the id collides.
        c.execute(
            "DELETE FROM qbank_activity WHERE session_id=? AND user_email=?",
            (session_id, user_email),
        )
        c.execute(
            "DELETE FROM qbank_sessions WHERE id=? AND user_email=?",
            (session_id, user_email),
        )
        c.commit()
        return _read_user_state(c, user_email)
    finally:
        c.close()


@router.post("/reset")
def reset_qbank_state(
    req: QBankResetRequest,
    user_email: str = Depends(require_user),
):
    c = _state_conn()
    try:
        now = _utc_now()
        if req.sessions:
            rows = c.execute(
                "SELECT id FROM qbank_sessions WHERE user_email=? AND db=?",
                (user_email, req.db),
            ).fetchall()
            session_ids = [row["id"] for row in rows]
            if session_ids:
                placeholders = ",".join("?" for _ in session_ids)
                c.execute(
                    f"DELETE FROM qbank_activity WHERE session_id IN ({placeholders}) AND user_email=?",
                    session_ids + [user_email],
                )
            c.execute(
                "DELETE FROM qbank_sessions WHERE user_email=? AND db=?",
                (user_email, req.db),
            )
        current = c.execute(
            "SELECT used_ids, marked_ids FROM qbank_progress WHERE user_email=? AND db=?",
            (user_email, req.db),
        ).fetchone()
        used_ids = [] if req.used_ids else _normalize_id_list(_json_loads(current["used_ids"], []) if current else [])
        marked_ids = [] if req.marked_ids else _normalize_id_list(_json_loads(current["marked_ids"], []) if current else [])
        c.execute(
            """
            INSERT INTO qbank_progress (user_email, db, used_ids, marked_ids, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_email, db) DO UPDATE SET
                used_ids=excluded.used_ids,
                marked_ids=excluded.marked_ids,
                updated_at=excluded.updated_at
            """,
            (user_email, req.db, _json_dumps(used_ids), _json_dumps(marked_ids), now),
        )
        c.commit()
        return _read_user_state(c, user_email)
    finally:
        c.close()


@router.get("/activity")
def qbank_activity(
    db: Optional[DB_KEY] = Query(default=None),
    session_id: str = Query(default=""),
    limit: int = Query(default=300, ge=1, le=2000),
    user_email: str = Depends(require_user),
):
    c = _state_conn()
    try:
        # user_email is always part of the filter — testers never see each other's activity.
        where: list[str] = ["user_email=?"]
        params: list[Any] = [user_email]
        if db:
            where.append("db=?")
            params.append(db)
        if session_id:
            where.append("session_id=?")
            params.append(session_id)
        clause = "WHERE " + " AND ".join(where)
        rows = c.execute(
            "SELECT session_id, db, qid, question_index, event, answered_choice, "
            "correct_choice, elapsed_sec, remaining_sec, created_at, payload "
            f"FROM qbank_activity {clause} ORDER BY created_at DESC, id DESC LIMIT ?",
            params + [limit],
        ).fetchall()
        return {
            "activity": [
                {
                    "session_id": row["session_id"],
                    "db": row["db"],
                    "qid": row["qid"],
                    "question_index": row["question_index"],
                    "event": row["event"],
                    "answered_choice": row["answered_choice"],
                    "correct_choice": row["correct_choice"],
                    "elapsed_sec": row["elapsed_sec"],
                    "remaining_sec": row["remaining_sec"],
                    "created_at": row["created_at"],
                    "payload": _json_loads(row["payload"], {}),
                }
                for row in rows
            ]
        }
    finally:
        c.close()


def _form_sort_key(form: Optional[str]) -> tuple[int, str]:
    s = (form or "").strip()
    return (int(s), "") if s.isdigit() else (10**9, s.lower())


@router.get("/banks")
def banks():
    """Hierarchical catalog of every installed bank, grouped for the builder UI:
    UWorld steps · NBME steps→forms · CMS subjects→forms. Counts are cheap
    COUNT(*) values, memoized in _BANK_COUNT_CACHE."""
    reg = _bank_registry()

    uworld_steps = []
    for k in _UWORLD_KEYS:
        info = reg.get(k)
        if not info:
            continue
        uworld_steps.append({"step": info.step, "key": k, "label": f"STEP {info.step}", "count": _bank_count(k)})

    amboss_steps = []
    for info in reg.values():
        if info.category == "amboss":
            amboss_steps.append({
                "step": info.step, "key": info.key,
                "label": _AMBOSS_STEP_LABELS.get(info.step or 0, f"Step {info.step}"),
                "count": _bank_count(info.key),
            })
    amboss_steps.sort(key=lambda s: s["step"] or 0)

    mehlman_banks = []
    for info in reg.values():
        if info.category == "mehlman":
            mehlman_banks.append({"key": info.key, "label": info.label, "count": _bank_count(info.key)})
    # HY subjects first (alpha), then Step N qbanks — keeps the Mehlman section
    # readable as the set grows (user can drop mehlman-1 / Step 1 later).
    def _mehlman_sort(b: dict) -> tuple:
        label = (b.get("label") or "").lower()
        is_step = label.startswith("step")
        m = re.search(r"mehlman-(\d+)", b.get("key") or "", re.I)
        num = int(m.group(1)) if m else 999
        return (1 if is_step else 0, label, num)
    mehlman_banks.sort(key=_mehlman_sort)

    source_banks: dict[str, list[dict]] = {
        "boardvitals": [],
        "mksap": [],
        "amboss_abim": [],
        "uworld_abim": [],
    }
    for info in reg.values():
        if info.category in source_banks:
            source_banks[info.category].append(
                {"key": info.key, "label": info.label, "count": _bank_count(info.key)}
            )
    for entries in source_banks.values():
        entries.sort(key=lambda item: (item["label"].lower(), item["key"]))

    nbme: dict[int, list[dict]] = {}
    cms: dict[str, list[dict]] = {}
    for info in reg.values():
        if info.category == "nbme":
            nbme.setdefault(info.step, []).append(
                {"key": info.key, "label": f"Form {info.form}", "form": info.form, "count": _bank_count(info.key)}
            )
        elif info.category == "cms":
            cms.setdefault(info.subject, []).append(
                {"key": info.key, "label": f"Form {info.form}", "form": info.form, "count": _bank_count(info.key)}
            )

    for forms in nbme.values():
        forms.sort(key=lambda f: _form_sort_key(f["form"]))
    for forms in cms.values():
        forms.sort(key=lambda f: _form_sort_key(f["form"]))

    categories: list[dict] = []
    if uworld_steps:
        categories.append({"id": "uworld", "label": "UWorld Qbank", "steps": uworld_steps})
    if amboss_steps:
        categories.append({"id": "amboss", "label": "AMBOSS Qbank", "steps": amboss_steps})
    if mehlman_banks:
        categories.append({"id": "mehlman", "label": "Mehlman HY", "banks": mehlman_banks})
    if source_banks["boardvitals"]:
        categories.append({
            "id": "boardvitals", "label": "BoardVitals", "banks": source_banks["boardvitals"]
        })
    if source_banks["mksap"]:
        categories.append({"id": "mksap", "label": "MKSAP", "banks": source_banks["mksap"]})
    abim_banks = sorted(
        source_banks["amboss_abim"] + source_banks["uworld_abim"],
        key=lambda item: (item["label"].lower(), item["key"]),
    )
    if abim_banks:
        categories.append({"id": "abim", "label": "ABIM / Internal Medicine", "banks": abim_banks})
    imported_banks = [
        {"key": info.key, "label": info.label, "count": _bank_count(info.key)}
        for info in reg.values()
        if info.category == "imported"
    ]
    imported_banks.sort(key=lambda item: (item["label"].lower(), item["key"]))
    if imported_banks:
        categories.append({
            "id": "imported",
            "label": "Imported Q-Banks (PDF)",
            "banks": imported_banks,
        })
    if nbme:
        categories.append({
            "id": "nbme",
            "label": "NBME Self-Assessments",
            "steps": [{"step": s, "forms": nbme[s]} for s in sorted(nbme)],
        })
    if cms:
        categories.append({
            "id": "cms",
            "label": "CMS Forms",
            "subjects": [
                {"subject": subj, "count": len(cms[subj]), "forms": cms[subj]}
                for subj in sorted(cms, key=str.lower)
            ],
        })
    return {"categories": categories}


@router.get("/subjects")
def subjects(db: DB_KEY = Query(default="step2")):
    c = _conn(db)
    try:
        rows = c.execute(
            "SELECT id, name, count FROM Subjects ORDER BY name"
        ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "name": r["name"] or "", "count": r["count"]} for r in rows]


@router.get("/systems")
def systems(
    db: DB_KEY = Query(default="step2"),
    subject_id: Optional[int] = Query(default=None),
    group: str = Query(default=""),
):
    c = _conn(db)
    try:
        group_clean = _clean_text(group)
        if _is_amboss_qbank(db) and subject_id is None:
            if group_clean:
                rows = c.execute(
                    "SELECT sys.id AS system_id, sys.name AS system_name, sys.count AS group_count, "
                    "subj.id AS subject_id, subj.name AS subject_name, ss.count "
                    "FROM SubjectsSystems ss "
                    "JOIN Systems sys ON sys.id=ss.sysId "
                    "JOIN Subjects subj ON subj.id=ss.subId "
                    "WHERE ss.count > 0 AND (sys.name=? OR sys.name LIKE ?) "
                    "ORDER BY sys.name, ss.count DESC, subj.name",
                    (group_clean, f"{group_clean} (%"),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT sys.id AS system_id, sys.name AS system_name, sys.count AS group_count, "
                    "subj.id AS subject_id, subj.name AS subject_name, ss.count "
                    "FROM SubjectsSystems ss "
                    "JOIN Systems sys ON sys.id=ss.sysId "
                    "JOIN Subjects subj ON subj.id=ss.subId "
                    "WHERE ss.count > 0 "
                    "ORDER BY sys.name, ss.count DESC, subj.name",
                ).fetchall()
            return [
                {
                    "id": _amboss_subsystem_token(r["system_id"], r["subject_id"]),
                    "name": f"{r['system_name'] or ''} ({r['subject_name'] or ''})",
                    "count": r["count"],
                    "group_count": r["group_count"],
                }
                for r in rows
            ]
        if subject_id is not None and group_clean:
            rows = c.execute(
                "SELECT s.id, s.name, ss.count "
                "FROM Systems s "
                "JOIN SubjectsSystems ss ON ss.sysId=s.id "
                "WHERE ss.subId=? AND (s.name=? OR s.name LIKE ?) ORDER BY s.name",
                (subject_id, group_clean, f"{group_clean} (%"),
            ).fetchall()
        elif subject_id is not None:
            rows = c.execute(
                "SELECT s.id, s.name, ss.count "
                "FROM Systems s "
                "JOIN SubjectsSystems ss ON ss.sysId=s.id "
                "WHERE ss.subId=? ORDER BY s.name",
                (subject_id,)
            ).fetchall()
        elif group_clean:
            rows = c.execute(
                "SELECT id, name, count FROM Systems "
                "WHERE name=? OR name LIKE ? ORDER BY name",
                (group_clean, f"{group_clean} (%"),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT id, name, count FROM Systems ORDER BY name"
            ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "name": r["name"] or "", "count": r["count"]} for r in rows]


@router.get("/system-groups")
def system_groups(
    db: DB_KEY = Query(default="step2"),
    subject_id: Optional[int] = Query(default=None),
):
    c = _conn(db)
    try:
        if subject_id is not None:
            rows = c.execute(
                "SELECT s.name, ss.count FROM Systems s "
                "JOIN SubjectsSystems ss ON ss.sysId=s.id "
                "WHERE ss.subId=? ORDER BY s.name",
                (subject_id,),
            ).fetchall()
        else:
            rows = c.execute("SELECT name, count FROM Systems ORDER BY name").fetchall()
    finally:
        c.close()
    counts: dict[str, int] = {}
    for r in rows:
        group = _system_group(r["name"] or "")
        if not group:
            continue
        counts[group] = counts.get(group, 0) + int(r["count"] or 0)
    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: item[0].lower())
    ]


@router.get("/topics")
def topics(
    db: DB_KEY = Query(default="step2"),
    subject_id: Optional[int] = Query(default=None),
):
    """Per-topic totals: aggregate the Systems table by the parenthetical
    `_system_detail` (e.g. "Cardiology (Murmurs)" → topic "Murmurs"), mirroring
    /system-groups. Drives the Review tab's "of N available" topic counts."""
    c = _conn(db)
    try:
        if subject_id is not None:
            rows = c.execute(
                "SELECT s.name, ss.count FROM Systems s "
                "JOIN SubjectsSystems ss ON ss.sysId=s.id "
                "WHERE ss.subId=? ORDER BY s.name",
                (subject_id,),
            ).fetchall()
        else:
            rows = c.execute("SELECT name, count FROM Systems ORDER BY name").fetchall()
    finally:
        c.close()
    counts: dict[str, int] = {}
    for r in rows:
        detail = _system_detail(r["name"] or "")
        if not detail:
            continue
        counts[detail] = counts.get(detail, 0) + int(r["count"] or 0)
    return [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=lambda item: item[0].lower())
    ]


@router.get("/question/{qid}")
def question(qid: int, db: DB_KEY = Query(default="step2")):
    c = _conn(db)
    try:
        q = _fetch_full_question(c, qid, db)
    finally:
        c.close()
    if not q:
        raise HTTPException(404, f"Question {qid} not found")
    return q


@router.get("/questions/batch")
def questions_batch(
    ids: str = Query(..., min_length=1, max_length=2000),
    db: DB_KEY = Query(default="step2"),
):
    """Fetch multiple questions by ID in a single request.

    Used by the frontend to bulk-prefetch explanation HTML for completed blocks
    so navigating through review mode doesn't require a per-question round-trip.
    """
    qids: list[int] = []
    seen: set[int] = set()
    for part in ids.split(","):
        part = part.strip()
        if part.isdigit():
            qid = int(part)
            if qid > 0 and qid not in seen:
                seen.add(qid)
                qids.append(qid)
        if len(qids) >= 50:
            break
    c = _conn(db)
    try:
        result = [_fetch_full_question(c, qid, db) for qid in qids]
    finally:
        c.close()
    return [q for q in result if q]


# ── Related library articles (qbank → reference library) ────────────────────
# AMBOSS qbanks link to AMBOSS articles via `data-learningcard-id` attrs embedded
# in the (decrypted) explanation; UWorld qbanks link to the UWorld library via
# their Refs table (refType=18 = related-topic titles), matched to library
# articles by exact title. Both surface as a unified "Related articles" list.
_RE_LEARNINGCARD = re.compile(r'data-learningcard-id="([^"]+)"')
_AMBOSS_RELATED_CAP = 16


@lru_cache(maxsize=1)
def _amboss_lib_db() -> Optional[str]:
    try:
        from config import AMBOSS_DIR
    except Exception:
        return None
    p = Path(AMBOSS_DIR) / "amboss-2025.db"
    return str(p) if p.exists() else None


def _amboss_titles_for_ids(doc_ids: list[int]) -> dict[int, str]:
    db = _amboss_lib_db()
    if not db or not doc_ids:
        return {}
    out: dict[int, str] = {}
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            qmarks = ",".join("?" * len(doc_ids))
            for row in c.execute(f"SELECT id, title FROM Docs WHERE id IN ({qmarks})", doc_ids):
                out[int(row[0])] = row[1]
        finally:
            c.close()
    except Exception:
        return {}
    return out


def _amboss_related(db: str, qid: int) -> list[dict]:
    """Resolve a question's in-explanation learning-card refs to AMBOSS articles."""
    from amboss_crypto import lcid_to_id
    amboss_db = _amboss_lib_db()
    if not amboss_db:
        return []
    c = _conn(db)
    try:
        row = c.execute("SELECT explanation FROM Questions WHERE id=?", (qid,)).fetchone()
    finally:
        c.close()
    if not row:
        return []
    html_doc = _decrypt_qbank_html(qid, row["explanation"])
    # First-appearance order, deduped.
    seen: set[str] = set()
    lcids: list[str] = []
    for lc in _RE_LEARNINGCARD.findall(html_doc):
        if lc not in seen:
            seen.add(lc)
            lcids.append(lc)
    resolved: list[tuple[str, int]] = []
    for lc in lcids:
        doc_id = lcid_to_id(amboss_db, lc)
        if doc_id is not None:
            resolved.append((lc, int(doc_id)))
        if len(resolved) >= _AMBOSS_RELATED_CAP:
            break
    titles = _amboss_titles_for_ids([d for _, d in resolved])
    items: list[dict] = []
    seen_docs: set[int] = set()
    for lc, doc_id in resolved:
        if doc_id in seen_docs:
            continue
        seen_docs.add(doc_id)
        items.append({
            "source": "amboss",
            "docId": doc_id,
            "title": titles.get(doc_id) or f"AMBOSS article #{doc_id}",
            "url": f"/amboss/article/{doc_id}",
        })
    return items


def _uworld_related(db: str, qid: int) -> list[dict]:
    """Resolve a UWorld question's Refs (refType=18) topic titles to library docs."""
    c = _conn(db)
    try:
        rows = c.execute(
            "SELECT DISTINCT refTitle FROM Refs WHERE qId=? AND refType=18 AND refTitle<>''",
            (qid,),
        ).fetchall()
    finally:
        c.close()
    titles = [r["refTitle"].strip() for r in rows if r["refTitle"]]
    if not titles:
        return []
    try:
        import uworld_library_reader as uwlib
        lib_db = str(uwlib._db_path())
    except Exception:
        return []
    items: list[dict] = []
    seen: set[int] = set()
    try:
        lc = sqlite3.connect(f"file:{lib_db}?mode=ro", uri=True)
        lc.row_factory = sqlite3.Row
        try:
            for title in titles:
                hit = lc.execute(
                    "SELECT id, title FROM Docs WHERE lower(title)=lower(?) LIMIT 1",
                    (title,),
                ).fetchone()
                if hit and int(hit["id"]) not in seen:
                    seen.add(int(hit["id"]))
                    items.append({
                        "source": "uworld-library",
                        "docId": int(hit["id"]),
                        "title": hit["title"],
                        "url": f"/uworld-library/article/{hit['id']}",
                    })
        finally:
            lc.close()
    except Exception:
        return []
    return items


@router.get("/related")
def related_articles(qid: int, db: DB_KEY = Query(default="step2")):
    """Library articles related to a question, for the explanation's side panel."""
    info = _resolve_bank(db)
    if info.category == "amboss":
        return {"source": "amboss", "items": _amboss_related(db, qid)}
    if info.category == "uworld":
        return {"source": "uworld-library", "items": _uworld_related(db, qid)}
    return {"source": None, "items": []}


@router.get("/random")
def random_question(
    db: DB_KEY = Query(default="step2"),
    subject_id: Optional[int] = Query(default=None),
    system_id: Optional[int] = Query(default=None),
    system_group: str = Query(default=""),
    q: str = Query(default=""),
    tag: str = Query(default=""),
    valid_only: bool = Query(default=True),
    system_ids: str = Query(default=""),
    subject_ids: str = Query(default=""),
    images_only: bool = Query(default=False),
):
    c = _conn(db)
    try:
        where, params = _question_where(
            db, subject_id, system_id, system_group, q, tag, valid_only,
            system_ids=_parse_exclude_ids(system_ids),
            subject_ids=_parse_exclude_ids(subject_ids),
            images_only=images_only,
        )
        ids = c.execute(
            f"SELECT q.id FROM Questions q "
            "LEFT JOIN Subjects subj ON subj.id=q.subId "
            "LEFT JOIN Systems sys ON sys.id=q.sysId "
            f"{where}", params
        ).fetchall()
        if not ids:
            raise HTTPException(404, "No questions match the selected filters")
        qid = random.choice(ids)["id"]
        q = _fetch_full_question(c, qid, db)
    finally:
        c.close()
    return q


@router.get("/list")
def question_list(
    db: DB_KEY = Query(default="step2"),
    subject_id: Optional[int] = Query(default=None),
    system_id: Optional[int] = Query(default=None),
    system_group: str = Query(default=""),
    q: str = Query(default=""),
    tag: str = Query(default=""),
    include_ids: str = Query(default=""),
    exclude_ids: str = Query(default=""),
    valid_only: bool = Query(default=True),
    sort: Literal["id", "random", "difficulty", "newest"] = Query(default="id"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    system_ids: str = Query(default=""),
    subject_ids: str = Query(default=""),
    images_only: bool = Query(default=False),
):
    c = _conn(db)
    try:
        where, params = _question_where(
            db, subject_id, system_id, system_group, q, tag, valid_only,
            system_ids=_parse_exclude_ids(system_ids),
            subject_ids=_parse_exclude_ids(subject_ids),
            images_only=images_only,
        )
        where = _append_included_ids(where, include_ids)
        where = _append_excluded_ids(where, exclude_ids)

        # Exclude child questions from top-level selection so they don't appear
        # as standalone questions — children are appended right after their parent below.
        # Skip this filter when include_ids is set (explicit ID list from user/dashboard).
        if not _parse_exclude_ids(include_ids):
            child_filter = "(q.parentQId IS NULL OR q.parentQId = 0 OR q.parentQId = q.id)"
            where = f"{where} AND {child_filter}" if where.startswith("WHERE") else f"WHERE {child_filter}"

        total = c.execute(
            "SELECT COUNT(*) FROM Questions q "
            "LEFT JOIN Subjects subj ON subj.id=q.subId "
            "LEFT JOIN Systems sys ON sys.id=q.sysId "
            f"{where}", params
        ).fetchone()[0]

        offset = (page - 1) * limit
        order = {
            "id": "ORDER BY q.id",
            "newest": "ORDER BY q.lastUpdated DESC, q.id DESC",
            "difficulty": "ORDER BY CASE WHEN q.pplTaken THEN (q.corrTaken / q.pplTaken) ELSE 1 END ASC, q.id",
            "random": "ORDER BY RANDOM()",
        }[sort]
        rows = c.execute(_question_select(where, f"{order} LIMIT ? OFFSET ?"), params + [limit, offset]).fetchall()

        def _build_with_fts(r: sqlite3.Row) -> dict:
            fts = c.execute(
                "SELECT c2type, c1content FROM Search_content "
                "WHERE c4contentId=? AND c2type IN (1,2,3) ORDER BY c2type, docid",
                (r["id"],)
            ).fetchall()
            answers = c.execute(
                "SELECT answerId, answerText FROM Answers WHERE qId=? ORDER BY answerId",
                (r["id"],),
            ).fetchall()
            return _attach_source_metadata(_build_question(r, fts, answers, db), c, db)

        questions = []
        for r in rows:
            q_dict = _build_with_fts(r)
            questions.append(q_dict)

            # If this is a series parent (parentQId == id), fetch its children
            # in order and append them immediately so they follow the parent.
            qid = r["id"]
            parent_qid = r["parentQId"]
            if parent_qid and int(parent_qid) == qid:
                child_rows = c.execute(
                    _question_select(
                        "WHERE q.parentQId=? AND q.id != ?",
                        "ORDER BY q.id",
                    ),
                    (qid, qid),
                ).fetchall()
                for cr in child_rows:
                    questions.append(_build_with_fts(cr))
    finally:
        c.close()

    return {"total": total, "page": page, "limit": limit, "questions": questions}


@router.get("/tags")
def tags(
    db: DB_KEY = Query(default="step2"),
    q: str = Query(default=""),
    limit: int = Query(default=80, ge=1, le=200),
):
    c = _conn(db)
    try:
        like = f"%{_clean_text(q)}%" if q else "%"
        rows = c.execute(
            "SELECT q.title, subj.name AS subject_name, sys.name AS system_name, COUNT(*) AS count "
            "FROM Questions q "
            "LEFT JOIN Subjects subj ON subj.id=q.subId "
            "LEFT JOIN Systems sys ON sys.id=q.sysId "
            "WHERE q.title LIKE ? OR subj.name LIKE ? OR sys.name LIKE ? "
            "GROUP BY q.title, subj.name, sys.name "
            "ORDER BY count DESC LIMIT ?",
            (like, like, like, limit),
        ).fetchall()
    finally:
        c.close()
    counts: dict[str, int] = {}
    for r in rows:
        for tag in _derive_tags(r["title"] or "", r["subject_name"] or "", r["system_name"] or ""):
            counts[tag] = counts.get(tag, 0) + int(r["count"] or 0)
    return [
        {"tag": tag, "count": count}
        for tag, count in sorted(counts.items(), key=lambda item: (-item[1], item[0].lower()))[:limit]
    ]


@router.get("/stats")
def stats(db: Optional[DB_KEY] = Query(default=None)):
    """Return question + valid-question counts, keyed by bank.

    With ?db=<key> returns just that bank (cheap — only one DB is decrypted to
    compute valid_count). Without a db, returns the 3 core UWorld banks so the
    legacy callers keep working without scanning all NBME/CMS forms.
    """
    keys = [db] if db else list(_UWORLD_KEYS)
    result = {}
    for key in keys:
        try:
            c = _conn(key)
            count = c.execute("SELECT COUNT(*) FROM Questions").fetchone()[0]
            valid = len(_valid_ids(key))
            c.close()
            result[key] = {"available": True, "count": count, "valid_count": valid}
        except HTTPException:
            result[key] = {"available": False, "count": 0, "valid_count": 0}
    return result


def _content_password() -> str:
    return os.environ.get("UWORLD_CONTENT_PW") or os.environ.get("IMD_CONTENT_PW") or _DEFAULT_CONTENT_PW


def _derive_payload_key(password: str, salt_raw: str) -> bytes:
    salt = salt_raw
    while len(salt) < 8:
        salt += " "
    return hashlib.pbkdf2_hmac("sha1", password.encode("utf-8"), salt.encode("utf-8"), 19, 16)


def _media_type(name: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".gif":
        return "image/gif"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".svg":
        return "image/svg+xml"
    if suffix == ".mp4":
        return "video/mp4"
    if suffix == ".webm":
        return "video/webm"
    if suffix in {".mov", ".m4v"}:
        return "video/quicktime" if suffix == ".mov" else "video/x-m4v"
    if suffix == ".mp3":
        return "audio/mpeg"
    return "application/octet-stream"


def _shared_amboss_images_dir() -> Path | None:
    candidates: list[Path] = []
    raw = os.environ.get("AMBOSS_DIR", "").strip()
    if raw:
        candidates.append(Path(raw) / "Images")
    candidates.extend([
        Path(_CONFIG_AMBOSS_DIR) / "Images",
        ROOT / "data" / "amboss" / "Images",
    ])
    for candidate in candidates:
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return None


def _amboss_qbank_shared_media_path(db: DB_KEY, name: str, qid: int | None = None) -> Path | None:
    try:
        if not _is_amboss_category(_resolve_bank(db).category):
            return None
    except HTTPException:
        raise
    except Exception:
        return None
    images_dir = _shared_amboss_images_dir()
    if images_dir is None:
        return None
    try:
        actual = _dir_case_map(str(images_dir)).get(name.lower())
        if actual:
            candidate = images_dir / actual
            if candidate.exists():
                return candidate
        if qid is None:
            return None
        alias = _AMBOSS_QBANK_MEDIA_ALIASES.get((str(db).lower(), int(qid), name.lower()))
        if not alias:
            return None
        alias_actual = _dir_case_map(str(images_dir)).get(alias.lower()) or alias
        alias_candidate = images_dir / alias_actual
        return alias_candidate if alias_candidate.exists() else None
    except OSError:
        return None


def _amboss_qbank_sibling_media_path(db: DB_KEY, name: str) -> Path | None:
    try:
        info = _resolve_bank(db)
        if not _is_amboss_category(info.category):
            return None
    except HTTPException:
        raise
    except Exception:
        return None
    safe = Path(name).name
    if not safe or safe != name:
        return None
    for sibling in _bank_registry().values():
        if not _is_amboss_category(sibling.category) or sibling.key == info.key:
            continue
        media_dir = sibling.db_path.parent / "media-E"
        actual = _dir_case_map(str(media_dir)).get(safe.lower())
        if not actual:
            continue
        candidate = media_dir / actual
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return None


@lru_cache(maxsize=64)
def _dir_case_map(dir_path: str) -> dict[str, str]:
    """Map lowercased filename -> real on-disk filename for one media directory.

    A UWorld bank's media-E folder holds 3,000-4,500 encrypted files. Scanning it
    on every single media request (the old _disk_name did `iterdir()` per call) is
    pathologically slow on a fresh install — cold filesystem cache plus Windows
    Defender stat-ing each file made one image take minutes to appear. media-E is
    static shipped data, so we scan each directory ONCE per process and reuse the
    listing. os.scandir avoids a per-entry stat, unlike iterdir()."""
    out: dict[str, str] = {}
    try:
        with os.scandir(dir_path) as it:
            for entry in it:
                out[entry.name.lower()] = entry.name
    except OSError:
        pass
    return out


def _disk_name(p: Path) -> str:
    """Return the actual on-disk filename, preserving its real case.

    Media files are encrypted with a key derived from their filename. The HTML
    may embed a different case (e.g. U28042.PNG vs U28042.png), so we resolve the
    true name from a cached per-directory listing before decrypting.
    """
    return _dir_case_map(str(p.parent)).get(p.name.lower()) or p.name


def _highres_media_path(db: DB_KEY, name: str) -> Path | None:
    """Resolve the alternate filename shipped by some UWorld exports.

    Their HTML links to ``L123.png`` while the bundle intentionally contains
    only ``highresdefault_L123.png``. The alternate remains in the source
    folder and is decrypted with its real on-disk filename.
    """
    safe = Path(name).name
    if not safe or safe != name:
        return None
    media_dir = _bank_media_dir(db)
    wanted = f"highresdefault_{safe}"
    actual = _dir_case_map(str(media_dir)).get(wanted.lower())
    if not actual:
        return None
    candidate = media_dir / actual
    try:
        return candidate if candidate.exists() else None
    except OSError:
        return None


def _resolve_qbank_media_path(db: DB_KEY, qid: int, name: str) -> Path | None:
    """Resolve one exact shipped asset; never substitute a similar clinical image."""

    safe = Path(name).name
    if not safe or safe != name:
        return None
    media_dir = _bank_media_dir(db)
    actual = _dir_case_map(str(media_dir)).get(safe.lower())
    if actual:
        candidate = media_dir / actual
        try:
            if candidate.exists():
                return candidate
        except OSError:
            pass
    return (
        _highres_media_path(db, safe)
        or _amboss_qbank_shared_media_path(db, safe, qid=qid)
        or _amboss_qbank_sibling_media_path(db, safe)
    )


def _decrypt_media(name: str, data: bytes) -> bytes:
    prefix = data.lstrip()[:64].lower()
    if data.startswith((b"\xff\xd8\xff", b"\x89PNG", b"GIF", b"RIFF", b"\x1aE\xdf\xa3", b"\x00\x00\x00")):
        return data
    if prefix.startswith((b"<svg", b"<?xml")):
        return data
    if len(data) % 16 != 0:
        return data
    key = _derive_payload_key(_content_password(), name)
    plain = AES.new(key, AES.MODE_CBC, _PAYLOAD_IV).decrypt(data)
    try:
        plain = unpad(plain, 16)
    except ValueError:
        pass
    return plain


@lru_cache(maxsize=4096)
def _exhibit_patterns(exhibit_id: str) -> tuple[re.Pattern[str], re.Pattern[str]]:
    return (
        re.compile(
            rf'(?is)<div\b[^>]*\bid=["\']div_[tT]{re.escape(exhibit_id)}["\'][^>]*>.*?</div>'
        ),
        re.compile(
            rf'(?is)<table\b[^>]*\bid=["\'][^"\']*[tT]{re.escape(exhibit_id)}[^"\']*["\'][^>]*>.*?</table>'
        ),
    )


def _extract_exhibit_fragment(db: DB_KEY, exhibit_id: str, qid: int, payloads: tuple[str, str]) -> tuple[int, str] | None:
    patterns = _exhibit_patterns(exhibit_id)
    for payload in payloads:
        source = _decrypt_qbank_html(qid, payload)
        if f"{exhibit_id}" not in source:
            continue
        for pattern in patterns:
            match = pattern.search(source)
            if match:
                return qid, _clean_html(_rewrite_media_links(qid, match.group(0)))
    return None


def _extract_linked_base_exhibit(
    db: DB_KEY,
    exhibit_id: str,
    qid: int,
    payloads: tuple[str, str],
) -> tuple[int, str] | None:
    """Load a source-shipped ``base/<id>.html`` only when this question links it."""
    link_pattern = re.compile(
        rf"(?i)\bhref\s*=\s*(['\"])(?:\./)?{re.escape(exhibit_id)}\.html(?:[?#][^'\"]*)?\1"
    )
    linked = False
    for payload in payloads:
        source = _decrypt_qbank_html(qid, payload)
        if link_pattern.search(source):
            linked = True
            break
    if not linked:
        return None

    base_dir = _bank_dir(db) / "base"
    exhibit_path = base_dir / f"{exhibit_id}.html"
    try:
        if not exhibit_path.is_file():
            return None
        source_html = exhibit_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    return qid, _clean_html(_rewrite_media_links(qid, source_html))


@lru_cache(maxsize=4096)
def _exhibit_html_for_qid(db: DB_KEY, exhibit_id: str, qid: int) -> tuple[int, str] | None:
    if not re.fullmatch(r"\d{3,8}", exhibit_id):
        return None
    c = _conn(db)
    try:
        row = c.execute(
            "SELECT id, question, explanation FROM Questions WHERE id=?",
            (qid,),
        ).fetchone()
    finally:
        c.close()
    if not row:
        return None
    source_qid = int(row["id"])
    payloads = (row["question"], row["explanation"])
    return _extract_exhibit_fragment(db, exhibit_id, source_qid, payloads) or _extract_linked_base_exhibit(
        db, exhibit_id, source_qid, payloads
    )


_EXHIBIT_QID_MAP_CACHE: dict[str, dict[str, int]] = {}


def _exhibit_qid_map(db: DB_KEY) -> dict[str, int]:
    """Map exhibit_id -> the qid whose decrypted HTML actually CONTAINS that
    exhibit's <div>/<table> fragment.

    Critical data-model fact (measured): in the UWorld schema the exhibit fragment
    lives in a DIFFERENT question than the one LINKING to it (usually adjacent,
    sometimes far away) — so the linking question's id can NOT be used to find it.
    The visual index has already located every embedded exhibit div and recorded
    its OWNING qid, so we reuse that for an O(1) lookup instead of decrypt-scanning
    the entire bank on every first exhibit open (the multi-minute hang).

    Reads the PERSISTED visual index only — it never triggers a (slow) build from
    the exhibit request path. If the index isn't built yet the map is empty and the
    caller falls back to the full scan, then self-heals once the index exists.
    """
    cached = _EXHIBIT_QID_MAP_CACHE.get(db)
    if cached is not None:
        return cached
    mapping: dict[str, int] = {}
    for item in _read_visual_index_db(db):
        if item.get("kind") != "exhibit":
            continue
        ex = item.get("exhibit_id")
        qid = item.get("qid")
        if ex and qid:
            mapping.setdefault(str(ex), int(qid))
    # Only memoize a populated map, so an index that appears later isn't masked by
    # a cached-empty result for the rest of the process lifetime.
    if mapping:
        _EXHIBIT_QID_MAP_CACHE[db] = mapping
    return mapping


@lru_cache(maxsize=4096)
def _exhibit_html(db: DB_KEY, exhibit_id: str) -> tuple[int, str] | None:
    if not re.fullmatch(r"\d{3,8}", exhibit_id):
        return None
    # Fast path: the prebuilt index knows which question owns this exhibit fragment,
    # so we decrypt just that single row instead of the whole bank.
    owner = _exhibit_qid_map(db).get(exhibit_id)
    if owner:
        found = _exhibit_html_for_qid(db, exhibit_id, owner)
        if found:
            return found
    # Fallback: index missing/stale (or an exhibit it didn't capture) — scan the
    # bank. The result is @lru_cache'd per (db, exhibit_id), so any given exhibit
    # pays this at most once per process.
    c = _conn(db)
    try:
        rows = c.execute(
            "SELECT id, question, explanation FROM Questions ORDER BY id"
        ).fetchall()
    finally:
        c.close()
    for row in rows:
        qid = int(row["id"])
        payloads = (row["question"], row["explanation"])
        found = _extract_exhibit_fragment(db, exhibit_id, qid, payloads) or _extract_linked_base_exhibit(
            db, exhibit_id, qid, payloads
        )
        if found:
            return found
    return None


_VISUAL_STOP_TERMS = {
    "left", "right", "image", "figure", "table", "parameters", "findings",
    "management", "diagnosis", "treatment", "current guidelines", "choice",
    "this patient", "the patient", "these patients", "patients", "patient",
    "this disease", "the disease", "this condition", "the condition",
    "this finding", "the finding", "this disorder", "the disorder",
}

_VISUAL_ABBREVIATION_EXPANSIONS = {
    "pe": "pulmonary embolism",
    "dvt": "deep vein thrombosis",
    "vte": "venous thromboembolism",
}


def _visual_term_ok(term: str) -> bool:
    key = _clean_text(term).strip("()[]{}:;,. ").lower()
    if len(key) < 7 or len(key) > 90:
        return False
    if key in _VISUAL_STOP_TERMS:
        return False
    if re.fullmatch(r"(?:this|the|these|those)\s+\w+(?:\s+\w+)?", key):
        return False
    if re.fullmatch(r"(?:left|right|upper|lower|medial|lateral)(?:\s+\w+)?", key):
        return False
    words = re.findall(r"[a-z0-9]+", key)
    if len(words) == 1 and len(words[0]) < 8:
        return False
    return bool(words)


def _visual_aliases(term: str) -> list[str]:
    base = _clean_text(term).strip()
    candidates = {base}
    lower = base.lower()
    replacements = {
        " infarcts": " infarct",
        " strokes": " stroke",
        " medications": " medication",
        " arteries": " artery",
        " reflexes": " reflex",
    }
    for old, new in replacements.items():
        if lower.endswith(old):
            candidates.add(base[: -len(old)] + new)
    return [candidate for candidate in candidates if _visual_term_ok(candidate)]


def _visual_norm(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (value or "").lower())).strip()


def _enrich_visual_index(items: tuple[dict, ...]) -> tuple[dict, ...]:
    out = list(items)
    seen = {
        (item.get("term", "").lower(), item.get("kind", ""), item.get("url", ""), item.get("qid"))
        for item in out
    }
    for abbr, expansion in _VISUAL_ABBREVIATION_EXPANSIONS.items():
        expansion_norm = _visual_norm(expansion)
        for item in items:
            term_norm = _visual_norm(item.get("term", ""))
            title_norm = _visual_norm(item.get("title", ""))
            if term_norm != expansion_norm and title_norm != expansion_norm:
                continue
            alias_item = {**item, "term": abbr.upper()}
            key = (alias_item["term"].lower(), alias_item.get("kind", ""), alias_item.get("url", ""), alias_item.get("qid"))
            if key in seen:
                continue
            seen.add(key)
            out.append(alias_item)
    return tuple(sorted(out, key=lambda item: (-len(item.get("term", "")), item.get("term", "").lower())))


def _visual_index_path(db: DB_KEY) -> Path:
    return BASE / f"qbank_visual_index_{db}.sqlite3"


def _read_visual_index_db(db: DB_KEY) -> tuple[dict, ...]:
    path = _visual_index_path(db)
    if not path.exists():
        return ()
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT payload FROM visual_terms ORDER BY length(term) DESC, term").fetchall()
    except sqlite3.OperationalError:
        return ()
    finally:
        c.close()
    out: list[dict] = []
    for row in rows:
        try:
            out.append(json.loads(row["payload"]))
        except Exception:
            continue
    return _enrich_visual_index(tuple(out))


def _write_visual_index_db(db: DB_KEY, items: tuple[dict, ...]) -> None:
    path = _visual_index_path(db)
    c = sqlite3.connect(path)
    try:
        c.execute("DROP TABLE IF EXISTS visual_terms")
        c.execute(
            "CREATE TABLE visual_terms ("
            "term TEXT NOT NULL, term_lc TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL)"
        )
        c.executemany(
            "INSERT INTO visual_terms(term, term_lc, kind, payload) VALUES(?, ?, ?, ?)",
            [
                (
                    item["term"],
                    item["term"].lower(),
                    item.get("kind", ""),
                    json.dumps(item, ensure_ascii=False),
                )
                for item in items
            ],
        )
        c.execute("CREATE INDEX idx_visual_terms_lc ON visual_terms(term_lc)")
        c.commit()
    finally:
        c.close()


@lru_cache(maxsize=4)
def _visual_index(db: DB_KEY) -> tuple[dict, ...]:
    cached = _read_visual_index_db(db)
    if cached:
        return cached

    items: dict[tuple[str, str, str], dict] = {}
    exhibit_ids: set[str] = set()
    exhibit_qids: dict[str, int] = {}
    exhibit_anchor_candidates: list[tuple[str, str]] = []
    c = _conn(db)
    try:
        rows = c.execute("SELECT id, question, explanation FROM Questions ORDER BY id").fetchall()
    finally:
        c.close()

    for row in rows:
        qid = int(row["id"])
        for payload in (row["question"], row["explanation"]):
            source = _decrypt_qbank_html(qid, payload)
            if not source:
                continue

            for match in re.finditer(
                r'(?is)<a\b[^>]*href=["\'](?:\.\./)*media/(?P<name>[^"\']+)["\'][^>]*>(?P<label>.*?)</a>',
                source,
            ):
                name = Path(match.group("name")).name
                label = _plain_inline_html(match.group("label"))
                for alias in _visual_aliases(label):
                    key = (alias.lower(), "image", f"{qid}/{name}")
                    items.setdefault(
                        key,
                        {
                            "term": alias,
                            "title": label,
                            "kind": "image",
                            "qid": qid,
                            "name": name,
                            "url": f"/qbank/media/{qid}/{name}",
                        },
                    )

            for match in re.finditer(
                r'(?is)<a\b[^>]*href=["\'](?P<id>\d{3,8})\.html["\'][^>]*>(?P<label>.*?)</a>',
                source,
            ):
                exhibit_id = match.group("id")
                label = _plain_inline_html(match.group("label"))
                exhibit_anchor_candidates.append((exhibit_id, label))

            for match in re.finditer(
                r'(?is)<div\b[^>]*\bid=["\']div_[tT](?P<id>\d{3,8})["\'][^>]*>(?P<body>.*?)</div>',
                source,
            ):
                exhibit_ids.add(match.group("id"))
                exhibit_qids[match.group("id")] = qid
                title_match = re.search(r"(?is)<strong[^>]*>(.*?)</strong>", match.group("body"))
                title = _plain_inline_html(title_match.group(1) if title_match else match.group("body"))
                exhibit_id = match.group("id")
                for alias in _visual_aliases(title):
                    key = (alias.lower(), "exhibit", exhibit_id)
                    items.setdefault(
                        key,
                        {
                            "term": alias,
                            "title": title,
                            "kind": "exhibit",
                            "qid": qid,
                            "exhibit_id": exhibit_id,
                            "url": f"/qbank/exhibit/{exhibit_id}",
                        },
                    )
    for exhibit_id, label in exhibit_anchor_candidates:
        if exhibit_id not in exhibit_ids:
            continue
        for alias in _visual_aliases(label):
            key = (alias.lower(), "exhibit", exhibit_id)
            items.setdefault(
                key,
                {
                    "term": alias,
                    "title": label,
                    "kind": "exhibit",
                    "qid": exhibit_qids.get(exhibit_id),
                    "exhibit_id": exhibit_id,
                    "url": f"/qbank/exhibit/{exhibit_id}",
                },
            )
    result = _enrich_visual_index(tuple(items.values()))
    _write_visual_index_db(db, result)
    return result


@lru_cache(maxsize=4)
def _visual_index_by_term(db: DB_KEY) -> dict[str, dict]:
    by_term: dict[str, dict] = {}
    for item in _visual_index(db):
        by_term.setdefault((item.get("term") or "").lower(), item)
    return by_term


def _is_visual_boundary(ch: str) -> bool:
    return not (ch.isalnum() or ch in "_+-")


@router.post("/visual-scan")
def visual_scan(req: ScanRequest, db: DB_KEY = Query(default="step2")):
    text = req.text
    lower = text.lower()
    hits: list[dict] = []
    occupied: list[tuple[int, int]] = []
    entries = sorted(_visual_index(db), key=lambda item: (-len(item["term"]), item["term"].lower()))
    for item in entries:
        needle = item["term"].lower()
        start = 0
        while True:
            idx = lower.find(needle, start)
            if idx < 0:
                break
            end = idx + len(needle)
            before_ok = idx == 0 or _is_visual_boundary(lower[idx - 1])
            after_ok = end == len(lower) or _is_visual_boundary(lower[end])
            overlaps = any(idx < e and end > s for s, e in occupied)
            if before_ok and after_ok and not overlaps:
                hits.append({
                    "start": idx,
                    "end": end,
                    "term": item["term"],
                    "source": "qbank",
                    "kind": item.get("kind", ""),
                })
                occupied.append((idx, end))
            start = end
    hits.sort(key=lambda h: (h["start"], -(h["end"] - h["start"])))
    return {"matches": hits[: req.limit]}


@router.get("/visual-tooltip")
def visual_tooltip(
    term: str = Query(..., min_length=1, max_length=120),
    db: DB_KEY = Query(default="step2"),
):
    key = _clean_text(term).lower()
    item = _visual_index_by_term(db).get(key)
    if not item:
        return {"term": term, "source": "qbank", "matches": []}
    media = []
    html_fragment = ""
    separator = "&" if "?" in item["url"] else "?"
    href = f'{item["url"]}{separator}db={db}'
    qid = item.get("qid")
    if item["kind"] == "image":
        media = [{"title": item["title"], "url": href}]
    elif item["kind"] == "exhibit":
        found = _exhibit_html_for_qid(db, item["exhibit_id"], int(qid)) if qid else None
        if not found:
            found = _exhibit_html(db, item["exhibit_id"])
        html_fragment = found[1] if found else ""
        if found and not item.get("qid"):
            item = {**item, "qid": found[0]}
    matches = []
    qid = item.get("qid")
    if item["kind"] == "exhibit":
        # Carry the source qid so the hover-opened exhibit hits the same O(1)
        # single-row decrypt as inline links instead of the full-bank scan. The
        # qid is resolved above (from the index, or backfilled from _exhibit_html),
        # and `href` already ends in ?db=… so we append with &.
        exhibit_href = f"{href}&srcqid={int(qid)}" if qid else href
        matches.append({"id": 0, "title": item["title"], "href": exhibit_href, "source": "qbank", "kind": "exhibit"})
    if item["kind"] == "image" and qid:
        matches.append({
            "id": int(qid),
            "title": f"Open source question QID {qid}",
            "href": f"/qbank?db={db}&qid={qid}",
            "source": "qbank",
            "kind": "question",
        })
    if item["kind"] == "image":
        matches.append({"id": 0, "title": item["title"], "href": href, "source": "qbank", "kind": "image"})
    if qid:
        source_question = {
            "id": int(qid),
            "title": f"Open source question QID {qid}",
            "href": f"/qbank?db={db}&qid={qid}",
            "source": "qbank",
            "kind": "question",
        }
        if all(match["href"] != source_question["href"] for match in matches):
            matches.append(source_question)
    return {
        "term": term,
        "title": item["title"],
        "source": "qbank",
        "kind": item["kind"],
        "matches": matches,
        "abstract": "UWorld exhibit" if item["kind"] == "exhibit" else "UWorld image",
        "media": media,
        "html": html_fragment,
    }


@router.get("/exhibit/{exhibit_id}", response_class=HTMLResponse)
def exhibit(
    exhibit_id: str,
    db: DB_KEY = Query(default="step2"),
    theme: str = Query(default="light"),
    # Accept as a string and coerce ourselves: a malformed/legacy srcqid (e.g.
    # "abc") must degrade to the full-scan fallback, NOT be rejected with a 422
    # that leaves the exhibit unopenable.
    srcqid: Optional[str] = Query(default=None),
):
    # Fast path: the exhibit fragment lives in its source question's HTML, so when
    # the caller tells us which question the link came from we decrypt that single
    # row instead of scanning the entire bank (which took minutes on a cold/large
    # bank and is why exhibits "wouldn't open"). Fall back to the full scan only
    # when no/STALE/garbage source id is supplied or the fragment isn't found there.
    found = None
    try:
        src_id = int(srcqid) if srcqid is not None else 0
    except (TypeError, ValueError):
        src_id = 0
    if src_id > 0:
        found = _exhibit_html_for_qid(db, exhibit_id, src_id)
    if not found:
        found = _exhibit_html(db, exhibit_id)
    if not found:
        raise HTTPException(404, "Exhibit not found")
    _qid, fragment = found
    dark = str(theme).lower() == "dark"
    theme_css = """
    :root { color-scheme: dark; }
    body {
      color: #e5edf8;
      background: #0b1020;
    }
    .wrap {
      background: #111827;
      border-color: #3b4d66;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.46);
    }
    table, tbody, thead, tfoot, tr {
      background: #111827 !important;
      color: #e5edf8 !important;
      border-color: #3b4d66 !important;
    }
    td, th {
      background: #111827 !important;
      border-color: #3b4d66 !important;
      color: #e5edf8 !important;
    }
    tr:nth-child(even) td {
      background: #162033 !important;
    }
    p, div, span, strong, em, li {
      color: inherit !important;
    }
    a { color: #7dd3fc; }
    img { background: #ffffff; }
""" if dark else ""
    return HTMLResponse(
        f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UWorld Exhibit {html.escape(exhibit_id)}</title>
  {media_interop_head("UWorld", f"UWorld Exhibit {exhibit_id}", f"/qbank/exhibit/{exhibit_id}?db={db}")}
  <style>
    :root {{ color-scheme: light; }}
    body {{
      margin: 0;
      padding: 24px;
      font-family: Arial, Helvetica, sans-serif;
      color: #111827;
      background: #f8fafc;
      font-size: 16px;
      line-height: 1.45;
    }}
    .wrap {{
      max-width: 1040px;
      margin: 0 auto;
      background: white;
      border: 1px solid #dbe3ef;
      border-radius: 8px;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.12);
      padding: 18px;
      overflow: auto;
    }}
    table {{ border-collapse: collapse; width: 100%; }}
    td, th {{ border: 1px solid #1f2937; padding: 10px 12px; vertical-align: top; }}
    img {{ max-width: 100%; height: auto; }}
    a {{ color: #2563eb; }}
{theme_css}
  </style>
</head>
<body><main class="wrap">{fragment}</main></body>
</html>"""
    )


@router.get("/media/{qid}/{name}")
def media(qid: int, name: str, db: DB_KEY = Query(default="step2")):
    safe = Path(name).name
    if not safe or safe != name:
        raise HTTPException(404, "Media not found")
    c = _conn(db)
    try:
        row = c.execute(
            "SELECT mediaName, otherMedias, question, explanation FROM Questions WHERE id=?",
            (qid,),
        ).fetchone()
    finally:
        c.close()
    media_path = _resolve_qbank_media_path(db, qid, safe)
    if not row and media_path is None:
        raise HTTPException(404, "Question not found")
    if media_path is None:
        raise HTTPException(404, "Media file missing")
    # Some imported visual indexes reference a valid bank media file through a
    # stale source QID. The file is encrypted by filename, not by question, so a
    # safe existing media filename is enough to serve the preview reliably.
    # Use the actual on-disk filename for key derivation; the HTML may embed a
    # different case (e.g. U28042.PNG) than the stored file (U28042.png).
    data = _decrypt_media(_disk_name(media_path), media_path.read_bytes())
    return Response(
        content=data,
        media_type=_media_type(safe),
        # Decrypted media is immutable shipped content and the request URL carries
        # a `_v` version token (bump it to bust), so let the browser cache it hard.
        # The old `no-store` forced a re-fetch — and a fresh re-decrypt + directory
        # scan — on every redisplay, which is why images reloaded slowly each view.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )

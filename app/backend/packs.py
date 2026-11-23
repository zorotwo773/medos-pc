"""
Content pack registry — the single source of truth for "what parts of MedOS
are installed and actually working" (packs.py).

MedOS ships as ~20 GB+ of optional content (UpToDate, books, qbanks, UMLS,
Anki, …) split into separately-downloadable 7z archives ("packs") so a torrent
seed set can shrink to whatever a given user actually needs. This module:

  1. Defines the pack catalog (PACKS) — one entry per shippable 7z, with the
     marker files that prove it was extracted and the global-search `source`
     keys it feeds.
  2. Detects install state from the filesystem alone, so pre-pack full
     installs (every file present, no `.packs/*.json` stamp) are recognized
     exactly like a freshly-extracted pack ("pre-packs" version).
  3. Runs a cheap functional probe per pack (open the DB, run one real query)
     rather than trusting file existence — a truncated/corrupt download must
     not silently "count" as installed.
  4. Exposes `installed_search_sources()` — the ONLY function search.py may
     consult to decide which sources are eligible. Everything else in search
     (ranking, intent, weights) is untouched; see docs/ADDING_A_DATABASE.md.

State machine per pack: grey (missing) -> yellow (present, unverified) ->
green (probe passed) -> red (probe failed, reason kept for the UI).
"""
from __future__ import annotations

import json
import os
import sqlite3
import stat
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import pack_paths

from config import (
    ROOT,
    AMBOSS_DIR,
    ANKI_COLLECTION,
    AO_DATA_PATH,
    ANATOMY_DEFS_PATH,
    ASSESSMENT_DIR,
    CONCEPT_LINKS_DB,
    DRUG_REF_DB,
    FAISS_DIR,
    FIRSTAID_INDEX_DB,
    FIRSTAID_PDF,
    GLOSSARY_DB,
    GLOBAL_SEARCH_DB as _GLOBAL_SEARCH_DB,
    IMPORTED_QBANK_ROOT,
    LEXI_CALC_DB,
    LIBRARY_PATH,
    MICROMEDEX_DB,
    MODELS_DIR,
    BM25_DIR,
    REFERENCE_ENTITIES_DB,
    RXNORM_DB,
    SANFORD_DIR,
    SANFORD_DB,
    STEP1_DB_PATH,
    STEP2_DB_PATH,
    STEP3_DB_PATH,
    UMLS_DB,
    UTDDDX_DIR,
    UTDDDX_DB,
    UTD_DB_PATH,
    UWORLD_LIBRARY_DIR,
    PATHWAYS_DB,
    PATHWAYS_DIR,
    VECTORSTORE_PATH,
)

try:
    from config import UMLS_LITE_DB
except ImportError:  # config.py predates this change
    UMLS_LITE_DB = ROOT / "data" / "umls_lite.sqlite"

_PACKS_DIR = ROOT / "data" / ".packs"
_STATUS_CACHE = _PACKS_DIR / "status.json"

# Schema version this build of the app understands per pack id. Bump when a
# pack's on-disk shape changes in a way the reader must know about; packs.py
# then warns instead of silently mis-reading an old/new archive.
SUPPORTED_SCHEMA: dict[str, int] = {
    "core": 1,
    "umls-full": 1,
    "uptodate": 1,
    "books": 1,
    "firstaid": 1,
    "firstaid-index": 1,
    "rag": 1,
    "uworld-step1": 1,
    "uworld-step2": 1,
    "uworld-step3": 1,
    "amboss": 1,
    "drugs-pro": 1,
    "mehlman": 1,
    "mksap19": 1,
    "boardvitals": 1,
    "amboss-abim": 1,
    "uworld-abim": 1,
    "qbanks-imported": 1,
    "anki": 1,
}


def _sqlite_probe(path: Path, query: str) -> tuple[bool, str]:
    if not path.exists():
        return False, f"missing: {path.name}"
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=3)
        try:
            row = c.execute(query).fetchone()
        finally:
            c.close()
        return True, f"ok ({row[0] if row else 0} rows probed)"
    except sqlite3.Error as exc:
        return False, f"sqlite error on {path.name}: {exc}"


def _any_pdf_opens(root: Path) -> tuple[bool, str]:
    if not root.exists():
        return False, "library folder missing"
    sample = next((p for p in root.rglob("*.pdf")), None)
    if sample is None:
        return False, "no PDFs found under library folder"
    try:
        import fitz  # PyMuPDF — already a hard backend dependency (main.py)

        doc = fitz.open(str(sample))
        page_count = doc.page_count
        doc.close()
    except Exception as exc:
        return False, f"could not open {sample.name}: {exc}"
    if page_count > 0:
        return True, f"opened {sample.name} ({page_count} pages)"
    return False, f"opened {sample.name} but it has 0 pages"


def _utd_probe() -> tuple[bool, str]:
    from utd_content import configured_bundle_dir, content_status
    bundle = configured_bundle_dir(UTD_DB_PATH)
    idx = bundle / "unidex.en.sqlite"
    ok, detail = _sqlite_probe(idx, "SELECT count(*) FROM topic")
    if not ok:
        return ok, detail
    status = content_status(bundle)
    return status["ready"], f"{detail}; {status['detail']}"


def _umls_full_probe() -> tuple[bool, str]:
    ok, detail = _sqlite_probe(UMLS_DB, "SELECT count(*) FROM umls_concepts")
    if not ok:
        return ok, detail
    has_relations, _ = _sqlite_probe(UMLS_DB, "SELECT count(*) FROM umls_relations")
    if not has_relations:
        return False, "umls.sqlite present but missing umls_relations table (corrupt/partial download?)"
    return True, detail


def _anki_probe() -> tuple[bool, str]:
    if not ANKI_COLLECTION.exists():
        return False, "collection.anki2 not found"
    return _sqlite_probe(ANKI_COLLECTION, "SELECT count(*) FROM col")


def _qbank_probe(db_path: Path | None) -> Callable[[], tuple[bool, str]]:
    def probe() -> tuple[bool, str]:
        if db_path is None or not db_path.exists():
            return False, "qbank .db not found"
        return _sqlite_probe(db_path, "SELECT count(*) FROM Search_content")
    return probe


def _amboss_probe() -> tuple[bool, str]:
    return _sqlite_probe(AMBOSS_DIR / "amboss-2025.db", "SELECT count(*) FROM Docs")


def _drugs_pro_probe() -> tuple[bool, str]:
    return _sqlite_probe(MICROMEDEX_DB, "SELECT count(*) FROM sqlite_master")


def _core_probe() -> tuple[bool, str]:
    return _sqlite_probe(_GLOBAL_SEARCH_DB, "SELECT count(*) FROM entries")


def _mehlman_root() -> Path:
    """Respect MEHLMAN_DIR override (Content Manager / user_content.json) so a
    user can point at an external folder of mehlman-* bundles and still green
    the pack + pick up newly-dropped Step 1 / HY folders without a restart."""
    raw = (os.environ.get("MEHLMAN_DIR") or "").strip()
    return Path(raw) if raw else (ROOT / "data")


def _mehlman_dirs() -> list[Path]:
    root = _mehlman_root()
    if not root.exists():
        return []
    return [p for p in sorted(root.glob("mehlman-*")) if p.is_dir()]


def _mehlman_probe() -> tuple[bool, str]:
    """Green if at least one Mehlman bundle has a non-empty, openable qbank DB
    (they share the UWorld Questions schema)."""
    dirs = _mehlman_dirs()
    if not dirs:
        return False, "no mehlman-* folders found"
    ok_count = 0
    first_err = ""
    for d in dirs:
        db = d / f"{d.name}.db"
        if not db.exists():
            db = next((p for p in sorted(d.glob("*.db"))), None)
        if db is None or not db.exists() or db.stat().st_size == 0:
            continue
        good, detail = _sqlite_probe(db, "SELECT count(*) FROM Questions")
        if good:
            ok_count += 1
        elif not first_err:
            first_err = detail
    if ok_count:
        return True, f"{ok_count} Mehlman bank(s) verified"
    return False, first_err or "no usable Mehlman qbank DB found"


def _mksap19_probe() -> tuple[bool, str]:
    return _sqlite_probe(
        ROOT / "data" / "mksap19part2db" / "medos-mksap19-qbank.db",
        "SELECT count(*) FROM Questions",
    )


def _boardvitals_probe() -> tuple[bool, str]:
    return _sqlite_probe(
        ROOT / "data" / "boardvitals-15-2025" / "boardvitals-15-2025.db",
        "SELECT count(*) FROM Questions",
    )


def _amboss_abim_probe() -> tuple[bool, str]:
    return _sqlite_probe(
        ROOT
        / "data"
        / "Amboss - Internal Medicine (ABIM)2025"
        / "ambossqb-Internal Medicine (ABIM)2025.db",
        "SELECT count(*) FROM Questions",
    )


def _uworld_abim_probe() -> tuple[bool, str]:
    return _sqlite_probe(
        ROOT / "data" / "INTERNAL-2026-march" / "uworldINTERNAL-2026-march.db",
        "SELECT count(*) FROM Questions",
    )


def _imported_qbanks_probe() -> tuple[bool, str]:
    """Green when at least one user-imported PDF bank has a readable DB."""
    if not IMPORTED_QBANK_ROOT.exists():
        return False, "no imported Q-Banks yet"
    total = 0
    banks = 0
    first_error = ""
    for folder in sorted(IMPORTED_QBANK_ROOT.iterdir()):
        if not folder.is_dir():
            continue
        db = folder / f"{folder.name}.db"
        if not db.exists() or db.stat().st_size == 0:
            continue
        ok, detail = _sqlite_probe(db, "SELECT count(*) FROM Questions")
        if ok:
            banks += 1
            try:
                c = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=3)
                try:
                    total += int(c.execute("SELECT count(*) FROM Questions").fetchone()[0])
                finally:
                    c.close()
            except sqlite3.Error:
                pass
        elif not first_error:
            first_error = detail
    if banks:
        return True, f"{total} question(s) across {banks} imported bank(s)"
    return False, first_error or "no usable imported Q-Bank DB found"


def _books_probe() -> tuple[bool, str]:
    return _any_pdf_opens(LIBRARY_PATH)


def _firstaid_pdf_probe() -> tuple[bool, str]:
    if not FIRSTAID_PDF.exists():
        return False, f"missing: {FIRSTAID_PDF.name}"
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(str(FIRSTAID_PDF))
        try:
            pages = doc.page_count
        finally:
            doc.close()
    except Exception as exc:
        return False, f"could not open {FIRSTAID_PDF.name}: {exc}"
    if pages > 0:
        return True, f"opened {FIRSTAID_PDF.name} ({pages} pages)"
    return False, f"opened {FIRSTAID_PDF.name} but it has 0 pages"


def _firstaid_index_probe() -> tuple[bool, str]:
    ok, detail = _sqlite_probe(FIRSTAID_INDEX_DB, "SELECT count(*) FROM firstaid_regions")
    if not ok:
        return ok, detail
    fts_ok, _ = _sqlite_probe(FIRSTAID_INDEX_DB, "SELECT count(*) FROM firstaid_fts")
    if not fts_ok:
        return False, "firstaid_index.sqlite present but missing firstaid_fts (partial download?)"
    return True, detail


def _rag_probe() -> tuple[bool, str]:
    for candidate in (VECTORSTORE_PATH, FAISS_DIR / "books_v1"):
        index = candidate / "index.faiss"
        try:
            if index.is_file() and index.stat().st_size > 0:
                if (candidate / "bm25.pkl").is_file():
                    return True, f"FAISS + BM25 index found in {candidate.name}"
                return True, f"FAISS index found in {candidate.name} (no bm25.pkl)"
        except OSError:
            continue
    if BM25_DIR.is_dir():
        for path in BM25_DIR.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".pkl", ".json", ".bm25"}:
                return True, f"BM25 index found in {BM25_DIR.name}"
    try:
        if MODELS_DIR.is_dir() and any(MODELS_DIR.iterdir()):
            return False, "embedding models present but no FAISS/BM25 index"
    except OSError:
        pass
    return False, "no FAISS or BM25 index built yet"


@dataclass(frozen=True)
class Pack:
    id: str
    name: str
    description: str
    approx_size_gb: float
    required: bool
    markers: tuple[Path, ...]
    search_sources: tuple[str, ...]
    probe: Callable[[], tuple[bool, str]]


PACKS: tuple[Pack, ...] = (
    Pack(
        id="core",
        name="Core",
        description="App, tools, launchers, small always-on references (Sanford, DDx, drug reference, ACLS, AO, anatomy, global search index).",
        approx_size_gb=3.5,
        required=True,
        markers=(_GLOBAL_SEARCH_DB, SANFORD_DB, UTDDDX_DB, DRUG_REF_DB),
        search_sources=("sanford", "utdddx", "drugs", "anatomy", "calc", "diseases"),
        probe=_core_probe,
    ),
    Pack(
        id="umls-full",
        name="UMLS (full)",
        description="Full concept graph, phenotype differential ('symptom, symptom' search), and 'mimics'. Without it, term resolve/codes still work via the lite copy bundled in core.",
        approx_size_gb=4.2,
        required=False,
        markers=(UMLS_DB,),
        search_sources=("umls",),
        probe=_umls_full_probe,
    ),
    Pack(
        id="uptodate",
        name="UpToDate",
        description="UpToDate topics, images, and quick-find. Articles open straight from the encrypted bundle; Content Manager can optionally build the faster full-article cache.",
        approx_size_gb=4.3,
        required=False,
        markers=(UTD_DB_PATH / "utdtoc.db", UTD_DB_PATH / "unidex.en.sqlite"),
        search_sources=("utd",),
        probe=_utd_probe,
    ),
    Pack(
        id="books",
        name="Books",
        description="PDF library (every shelf) plus the chapter index used by book search.",
        approx_size_gb=22.26,
        required=False,
        markers=(LIBRARY_PATH,),
        search_sources=("books",),
        probe=_books_probe,
    ),
    Pack(
        id="firstaid",
        name="First Aid (book)",
        description="First Aid for the USMLE Step 1 2026 PDF.",
        approx_size_gb=0.0597,
        required=False,
        markers=(FIRSTAID_PDF,),
        search_sources=(),
        probe=_firstaid_pdf_probe,
    ),
    Pack(
        id="firstaid-index",
        name="First Aid index",
        description="Indexed First Aid headings and regions that power First Aid search, smart cards, and highlights.",
        approx_size_gb=0.0128,
        required=False,
        markers=(FIRSTAID_INDEX_DB,),
        search_sources=("firstaid",),
        probe=_firstaid_index_probe,
    ),
    Pack(
        id="rag",
        name="FAISS / BM25 retrieval",
        description="Vector and keyword indexes (plus embedding models) that AI chat uses to retrieve from the library.",
        approx_size_gb=0.5,
        required=False,
        markers=(VECTORSTORE_PATH, FAISS_DIR / "books_v1", BM25_DIR),
        search_sources=(),
        probe=_rag_probe,
    ),
    Pack(
        id="uworld-step1",
        name="UWorld Step 1 + Library",
        description="UWorld Step 1 qbank and the Step 1 reference library.",
        approx_size_gb=2.5,
        required=False,
        markers=(STEP1_DB_PATH,) if STEP1_DB_PATH else (),
        search_sources=("qbank", "uworld"),
        probe=_qbank_probe(STEP1_DB_PATH),
    ),
    Pack(
        id="uworld-step2",
        name="UWorld Step 2 CK",
        description="UWorld Step 2 CK qbank.",
        approx_size_gb=2.0,
        required=False,
        markers=(STEP2_DB_PATH,) if STEP2_DB_PATH else (),
        search_sources=("qbank",),
        probe=_qbank_probe(STEP2_DB_PATH),
    ),
    Pack(
        id="uworld-step3",
        name="UWorld Step 3",
        description="UWorld Step 3 qbank.",
        approx_size_gb=1.3,
        required=False,
        markers=(STEP3_DB_PATH,) if STEP3_DB_PATH else (),
        search_sources=("qbank",),
        probe=_qbank_probe(STEP3_DB_PATH),
    ),
    Pack(
        id="amboss",
        name="AMBOSS",
        description="AMBOSS article library and Step 1/2/3 qbanks.",
        approx_size_gb=2.0,
        required=False,
        markers=(AMBOSS_DIR / "amboss-2025.db",),
        search_sources=("amboss",),
        probe=_amboss_probe,
    ),
    Pack(
        id="drugs-pro",
        name="Drugs Pro (Lexi / Micromedex / RxNorm)",
        description="Lexicomp, Micromedex drug/interaction data, and full RxNorm.",
        approx_size_gb=2.5,
        required=False,
        markers=(MICROMEDEX_DB, RXNORM_DB),
        search_sources=("lexi",),
        probe=_drugs_pro_probe,
    ),
    Pack(
        id="mehlman",
        name="Mehlman HY",
        description="Mehlman High-Yield subject qbanks (Psychiatry, Peds, ObGyn, Surgery, IM, Family Med) + Step 3. Each is a standard qbank you can study in tutor or timed mode.",
        approx_size_gb=3.9,
        required=False,
        markers=tuple(_mehlman_dirs()) or (_mehlman_root() / "mehlman-8-2025",),
        search_sources=("qbank",),
        probe=_mehlman_probe,
    ),
    Pack(
        id="mksap19",
        name="MKSAP 19",
        description="MKSAP 19 Core, Quick Qs, and Virtual Dx questions with source taxonomy and rich media preserved.",
        approx_size_gb=0.4,
        required=False,
        markers=(ROOT / "data" / "mksap19part2db" / "medos-mksap19-qbank.db",),
        search_sources=("qbank",),
        probe=_mksap19_probe,
    ),
    Pack(
        id="boardvitals",
        name="BoardVitals 2025",
        description="BoardVitals 2025 question bank and its bundled question media.",
        approx_size_gb=0.1,
        required=False,
        markers=(ROOT / "data" / "boardvitals-15-2025" / "boardvitals-15-2025.db",),
        search_sources=("qbank",),
        probe=_boardvitals_probe,
    ),
    Pack(
        id="amboss-abim",
        name="AMBOSS Internal Medicine (ABIM) 2025",
        description="AMBOSS Internal Medicine/ABIM questions with native taxonomy and bundled media preserved.",
        approx_size_gb=0.06,
        required=False,
        markers=(
            ROOT
            / "data"
            / "Amboss - Internal Medicine (ABIM)2025"
            / "ambossqb-Internal Medicine (ABIM)2025.db",
        ),
        search_sources=("qbank",),
        probe=_amboss_abim_probe,
    ),
    Pack(
        id="uworld-abim",
        name="UWorld Internal Medicine (ABIM) 2026",
        description="UWorld Internal Medicine/ABIM questions with care-setting taxonomy, media, and linked exhibits preserved.",
        approx_size_gb=0.18,
        required=False,
        markers=(
            ROOT / "data" / "INTERNAL-2026-march" / "uworldINTERNAL-2026-march.db",
        ),
        search_sources=("qbank",),
        probe=_uworld_abim_probe,
    ),
    Pack(
        id="qbanks-imported",
        name="Imported Q-Banks",
        description="Question banks created from your own Q-Bank PDFs with the PDF importer.",
        approx_size_gb=0.05,
        required=False,
        markers=(IMPORTED_QBANK_ROOT,),
        search_sources=("qbank",),
        probe=_imported_qbanks_probe,
    ),
    Pack(
        id="anki",
        name="Anki",
        description="Flashcard decks and media.",
        approx_size_gb=9.9,
        required=False,
        markers=(ANKI_COLLECTION,),
        search_sources=(),
        probe=_anki_probe,
    ),
)

_PACKS_BY_ID: dict[str, Pack] = {p.id: p for p in PACKS}


def get_pack(pack_id: str) -> Optional[Pack]:
    return _PACKS_BY_ID.get(pack_id)


def all_packs() -> tuple[Pack, ...]:
    return PACKS


# ── Version stamps ──────────────────────────────────────────────────────────

def _stamp_path(pack_id: str) -> Path:
    return _PACKS_DIR / f"{pack_id}.json"


def read_stamp(pack_id: str) -> dict:
    p = _stamp_path(pack_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_stamp(pack_id: str, version: str, schema: int, built_at: str | None = None) -> None:
    _PACKS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": pack_id,
        "version": version,
        "schema": schema,
        "built_at": built_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _stamp_path(pack_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _markers_present(pack: Pack) -> bool:
    if not pack.markers:
        return False
    return any(m.exists() for m in pack.markers)


def _fingerprint(pack: Pack) -> str:
    """Cheap content-change signature (size+mtime of every marker that exists).
    Verification only re-runs when this changes — a probe is not free."""
    parts: list[str] = []
    for m in pack.markers:
        try:
            if m.is_file():
                st = m.stat()
                parts.append(f"{m}:{st.st_size}:{int(st.st_mtime)}")
            elif m.is_dir():
                parts.append(f"{m}:dir")
        except OSError:
            continue
    return "|".join(parts)


def _load_status_cache() -> dict:
    if not _STATUS_CACHE.exists():
        return {}
    try:
        return json.loads(_STATUS_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_status_cache(cache: dict) -> None:
    _PACKS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _STATUS_CACHE.write_text(json.dumps(cache, indent=2), encoding="utf-8")
    except OSError:
        pass


def _schema_warning(pack: Pack, stamp: dict) -> str | None:
    stamp_schema = stamp.get("schema")
    if stamp_schema is None:
        return None
    supported = SUPPORTED_SCHEMA.get(pack.id)
    if supported is None or stamp_schema == supported:
        return None
    if stamp_schema > supported:
        return f"This pack (schema {stamp_schema}) is newer than this app supports (schema {supported}) — update MedOS."
    return f"This pack (schema {stamp_schema}) is older than this app expects (schema {supported}) — consider re-downloading it."


def verify_pack(pack: Pack, force: bool = False) -> dict:
    """Run (or reuse the cached result of) the functional probe for one pack."""
    cache = _load_status_cache()
    entry = cache.get(pack.id, {})
    fp = _fingerprint(pack)

    if not _markers_present(pack):
        result = {"state": "grey", "detail": "not installed", "fingerprint": fp, "checked_at": time.time()}
        cache[pack.id] = result
        _save_status_cache(cache)
        return result

    if not force and entry.get("fingerprint") == fp and entry.get("state") in ("green", "red"):
        return entry

    try:
        ok, detail = pack.probe()
    except Exception as exc:  # a probe must never take the whole endpoint down
        ok, detail = False, f"probe raised: {exc}"
    result = {
        "state": "green" if ok else "red",
        "detail": detail,
        "fingerprint": fp,
        "checked_at": time.time(),
    }
    cache[pack.id] = result
    _save_status_cache(cache)
    return result


def pack_status(pack: Pack, force: bool = False) -> dict:
    verified = verify_pack(pack, force=force)
    stamp = read_stamp(pack.id)
    version = stamp.get("version") if stamp else ("pre-packs" if _markers_present(pack) else None)
    return {
        "id": pack.id,
        "name": pack.name,
        "description": pack.description,
        "approx_size_gb": pack.approx_size_gb,
        "required": pack.required,
        "installed": _markers_present(pack),
        "state": verified["state"],
        "detail": verified["detail"],
        "version": version,
        "search_sources": list(pack.search_sources),
        "warning": _schema_warning(pack, stamp),
        "checked_at": verified["checked_at"],
    }


def all_pack_status(force: bool = False) -> list[dict]:
    return [pack_status(p, force=force) for p in PACKS]


def qbank_pack_completion(root: Path, pack_id: str) -> tuple[bool, str]:
    """Boundedly validate one declared additional-Qbank export pack."""
    records = pack_paths.required_marker_records_for_pack(pack_id)
    if not records or get_pack(pack_id) is None:
        return False, f"unknown additional Qbank pack: {pack_id}"
    for record, marker in zip(
        records, pack_paths.required_markers_for_pack(pack_id, root), strict=True
    ):
        try:
            metadata = marker.lstat()
        except FileNotFoundError:
            return False, f"missing marker: {record}"
        if marker.is_symlink() or not stat.S_ISREG(metadata.st_mode):
            return False, f"unsafe marker: {record}"
        if metadata.st_size <= 0:
            return False, f"empty marker: {record}"
    return True, "complete"


def installed_qbank_packs(root: Path) -> tuple[Pack, ...]:
    """Return completed additional Qbanks in stable registry order."""
    installed: list[Pack] = []
    for pack_id in pack_paths.ADDITIONAL_QBANK_PACK_IDS:
        complete, _reason = qbank_pack_completion(root, pack_id)
        pack = get_pack(pack_id)
        if complete and pack is not None:
            installed.append(pack)
    return tuple(installed)


def refresh(pack_id: str | None = None) -> list[dict]:
    if pack_id:
        pack = get_pack(pack_id)
        if pack is None:
            return []
        # Mehlman (and any other scan-based qbank pack) can grow when the user
        # drops a new folder into MEHLMAN_DIR — clear the quiz engine's bank
        # registry so the new banks appear without a backend restart.
        if pack_id in (
            "mehlman",
            "amboss",
            "mksap19",
            "boardvitals",
            "amboss-abim",
            "uworld-abim",
            "qbanks-imported",
        ):
            try:
                import qbank_reader
                qbank_reader.reset_bank_registry()
            except Exception as exc:
                print(f"[packs] qbank registry refresh after {pack_id}: {exc}")
        return [pack_status(pack, force=True)]
    return all_pack_status(force=True)


# ── The one function search.py is allowed to call ─────────────────────────

_SOURCES_CACHE: dict[str, object] = {"at": 0.0, "sources": frozenset()}
_SOURCES_TTL_SECONDS = 30.0


def installed_search_sources() -> frozenset[str]:
    """Union of `search_sources` for every GREEN pack. This is the single seam
    routers/search.py uses to gate results — see the "search must not regress"
    rules in docs/ADDING_A_DATABASE.md before touching this function."""
    now = time.time()
    if now - float(_SOURCES_CACHE["at"]) < _SOURCES_TTL_SECONDS:
        return _SOURCES_CACHE["sources"]  # type: ignore[return-value]
    sources: set[str] = set()
    for pack in PACKS:
        status = pack_status(pack)
        if status["state"] == "green":
            sources.update(pack.search_sources)
    frozen = frozenset(sources)
    _SOURCES_CACHE["at"] = now
    _SOURCES_CACHE["sources"] = frozen
    return frozen

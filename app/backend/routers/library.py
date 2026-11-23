"""
Library router — books, PDF streaming with HTTP Range support, thumbnails.

Key design decisions:
- /library/pdf returns 206 Partial Content with Accept-Ranges: bytes so that
  pdf.js never has to download the entire file before rendering page 1.
- Thumbnails are generated once as WebP (10× smaller than JPEG), stored in
  LIBRARY_PATH/_thumbs/, and served with a 1-year immutable cache header.
- ETag is sha1(path + mtime + size) so browsers get instant cache hits on
  repeat opens without a round-trip to disk.
- Book listing is paginated (default page_size=24) to keep the first paint
  under 200 ms even with 137+ books.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional
from urllib.parse import quote, unquote

import fitz  # PyMuPDF
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from config import BOOK_CHAPTER_INDEX_DB, LIBRARY_INDEX_DB, LIBRARY_PATH, THUMB_DIR, THUMB_SIZE
from scripts.build_library_index import _signature as _library_signature
from scripts.build_library_index import build_library_index

router = APIRouter(prefix="/library", tags=["library"])

_reindex_lock = threading.Lock()
_import_lock = threading.Lock()
_import_job: dict = {"status": "idle"}

# Deep-index (chapter outline + global search) reconciliation after a scan.
_search_index_lock = threading.Lock()
_search_index_rerun = threading.Event()
_index_state_lock = threading.Lock()
_search_index_state: dict = {"status": "idle"}

# In-memory book cache — loaded once at boot, O(1) reads on every request.
_books_cache: list[dict] = []


def _set_search_index_state(values: dict) -> None:
    with _index_state_lock:
        _search_index_state.update(values)


def search_index_status() -> dict:
    with _index_state_lock:
        return dict(_search_index_state)


def _import_index_builders():
    """Import the offline index builders for in-process incremental use."""
    scripts_dir = str(Path(__file__).resolve().parents[1] / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    import build_book_chapter_index as bci
    import build_global_search_index as bgs
    return bci, bgs


def _run_search_index_sync(only_paths: list[str] | None, full: bool, force_search: bool = False) -> None:
    """Bring the chapter index + global search index in line with the library.

    Refreshes the book-level index first (so a freshly dropped file is picked up
    even at boot), then reconciles chapter deep-links and the global search index.
    Cheap when nothing changed: the global-search refresh only runs if the chapter
    sync actually (re)indexed or pruned a book, a full rebuild was requested, or
    the caller forces it (e.g. after a delete), so a no-op boot sync costs little.
    """
    global _books_cache
    # Catch files dropped straight into the library folder (signature-checked).
    try:
        _ensure_library_index(force=False)
        refreshed = _load_books_from_db()
        if refreshed:
            _books_cache = refreshed
    except Exception as exc:
        print(f"[library] book-level reindex skipped: {exc}")

    bci, bgs = _import_index_builders()
    _set_search_index_state({
        "status": "indexing_chapters", "phase": "chapters",
        "processed": 0, "total": 0, "current": "", "started_at": int(time.time()),
        "error": "",
    })

    def _progress(done: int, total: int, rel: str) -> None:
        _set_search_index_state({"processed": done, "total": total, "current": rel})

    chapter = bci.sync_library(library=LIBRARY_PATH, only_paths=only_paths, rebuild=full, progress=_progress)
    changed = bool(full or force_search or chapter.get("indexed") or chapter.get("removed"))
    if changed:
        _set_search_index_state({"status": "indexing_search", "phase": "search", "chapter": chapter})
        if full:
            bgs.rebuild()
        else:
            bgs.rebuild_books_only()
        _clear_search_caches()
        try:
            import book_priority
            book_priority.refresh()
        except Exception:
            pass
    _set_search_index_state({
        "status": "completed", "completed_at": int(time.time()), "chapter": chapter,
    })


def _sync_search_indexes_bg(only_paths: list[str] | None = None, full: bool = False,
                            force_search: bool = False) -> None:
    """Background, coalesced chapter + global-search reindex after a scan.

    If a sync is already running, the request is coalesced: the in-flight run is
    flagged to make one more (broadened) pass when it finishes, so books added
    mid-run are not missed and rebuilds never pile up.
    """
    def _work():
        if not _search_index_lock.acquire(blocking=False):
            _search_index_rerun.set()
            return
        try:
            cur_paths, cur_full, cur_force = only_paths, full, force_search
            while True:
                _search_index_rerun.clear()
                try:
                    _run_search_index_sync(cur_paths, cur_full, cur_force)
                except Exception as exc:
                    _set_search_index_state({"status": "failed", "error": str(exc), "completed_at": int(time.time())})
                    print(f"[library] search index sync error: {exc}")
                if _search_index_rerun.is_set():
                    # Catch anything scanned mid-run with a full incremental pass.
                    cur_paths, cur_full, cur_force = None, False, True
                    continue
                break
        finally:
            _search_index_lock.release()

    threading.Thread(target=_work, daemon=True).start()

BOOK_SYSTEM_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("Cardiology", ("cardio", "heart", "ecg", "ekg", "braunwald")),
    ("Pulmonology", ("pulmonary", "respiratory", "lung", "chest")),
    ("Gastroenterology", ("gastro", "hepat", "liver", "gi ", "sleisenger")),
    ("Nephrology", ("renal", "kidney", "nephro")),
    ("Endocrinology", ("endocr", "diabetes", "thyroid")),
    ("Hematology-Oncology", ("hemat", "haemat", "oncolog", "cancer")),
    ("Infectious Disease", ("infectious", "infection", "mandell")),
    ("Rheumatology", ("rheumat", "arthritis")),
    ("Dermatology", ("dermat", "skin")),
    ("Neurology", ("neuro", "brain", "adams", "victor", "eeg")),
    ("Psychiatry", ("psychiatr", "dsm", "kaplan")),
    ("Pediatrics", ("pediatric", "paediatric", "nelson")),
    ("Obstetrics & Gynecology", ("obgy", "ob gyn", "obstetric", "gynecology", "gynaecology", "williams", "dutta", "shaws")),
    ("Surgery", ("surgery", "surgical", "sabiston", "bailey", "zollinger", "operative")),
    ("Orthopedics", ("ortho", "fracture", "bone", "campbell")),
    ("Emergency Medicine", ("emergency", "tintinalli", "critical care", "icu", "disaster")),
    ("Radiology", ("radiology", "imaging", "ct ", "mri", "ultrasound")),
    ("Anesthesiology", ("anesthesia", "anaesthesia", "anesthesiology")),
    ("Anatomy", ("anatomy", "netter", "gray", "grays", "moore")),
    ("Physiology", ("physiology", "guyton", "ganong", "boron")),
    ("Biochemistry", ("biochem", "lehninger", "harper", "lippincott biochemistry")),
    ("Pathology", ("pathology", "robbins", "virchow", "pathoma")),
    ("Pharmacology", ("pharma", "pharmacology", "goodman", "gilman", "katzung")),
    ("Microbiology", ("micro", "microbiology", "immunology", "immune", "murray")),
    ("Internal Medicine", ("medicine", "internal", "harrison", "davidson", "bates", "washington", "current medical")),
    ("USMLE", ("usmle", "first aid", "boards", "step 1", "step1", "step 2", "step2", "step 3", "step3")),
]

# ── SQLite helpers ─────────────────────────────────────────────────────────

def _library_index_conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(LIBRARY_INDEX_DB), timeout=5, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def _library_index_init() -> None:
    """Create the live shelf schema before status, delete, or boot reads it."""
    c = _library_index_conn()
    try:
        c.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        c.execute("""CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, href TEXT,
            scope TEXT, kind TEXT, search_text TEXT)""")
        c.execute("""CREATE TABLE IF NOT EXISTS chapters (
            id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, href TEXT,
            scope TEXT, kind TEXT, search_text TEXT)""")
        c.commit()
    finally:
        c.close()


def _copy_chapters(source: Path, candidate: Path) -> None:
    if not source.exists():
        return
    source_connection = sqlite3.connect(str(source))
    try:
        try:
            chapters = source_connection.execute(
                "SELECT id, title, subtitle, href, scope, kind, search_text FROM chapters"
            ).fetchall()
        except sqlite3.OperationalError as exc:
            if "no such table: chapters" in str(exc).lower():
                return
            raise
    finally:
        source_connection.close()

    candidate_connection = sqlite3.connect(str(candidate))
    try:
        candidate_connection.executemany(
            """INSERT INTO chapters (id, title, subtitle, href, scope, kind, search_text)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            chapters,
        )
        candidate_connection.commit()
        integrity = candidate_connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"Library index integrity check failed: {integrity}")
    finally:
        candidate_connection.close()

    with candidate.open("r+b") as handle:
        os.fsync(handle.fileno())


def _ensure_library_index(force: bool = False) -> None:
    if not LIBRARY_PATH.exists():
        return
    stored_signature = None
    if LIBRARY_INDEX_DB.exists():
        c = _library_index_conn()
        try:
            row = c.execute(
                "SELECT value FROM meta WHERE key='library_signature'"
            ).fetchone()
            stored_signature = row["value"] if row else None
        except sqlite3.Error:
            pass
        finally:
            c.close()
    if not force and stored_signature == _library_signature(LIBRARY_PATH):
        return
    candidate = LIBRARY_INDEX_DB.with_name(
        f".{LIBRARY_INDEX_DB.name}.candidate-{uuid.uuid4().hex}"
    )
    try:
        build_library_index(LIBRARY_PATH, candidate)
        _copy_chapters(LIBRARY_INDEX_DB, candidate)
        os.replace(candidate, LIBRARY_INDEX_DB)
    except Exception:
        candidate.unlink(missing_ok=True)
        raise


def _reindex_bg(force: bool = False) -> None:
    if _reindex_lock.locked():
        return
    def _work():
        global _books_cache
        with _reindex_lock:
            try:
                _ensure_library_index(force=force)
                # Refresh in-memory cache after rebuild
                books = _load_books_from_db()
                if books:
                    _books_cache = books
                    _clear_search_caches()
                    print(f"[library] Cache refreshed: {len(books)} books.")
            except Exception as e:
                print(f"[library] background reindex error: {e}")
    threading.Thread(target=_work, daemon=True).start()


def _load_books_from_db() -> list[dict]:
    """Read all books from SQLite into memory. Called once at boot."""
    c = _library_index_conn()
    try:
        rows = c.execute(
            "SELECT id, title, subtitle FROM books ORDER BY lower(title)"
        ).fetchall()
    except Exception as e:
        print(f"[library] SQLite read error: {e}")
        return []
    finally:
        c.close()

    out: list[dict] = []
    for r in rows:
        rel = r["id"] or ""
        subtitle = r["subtitle"] or ""
        # subtitle stored as "FolderName book" by rebuild_index.py, or raw folder by router
        folder = subtitle.removesuffix(" book").strip() if subtitle.endswith(" book") else subtitle
        folder = folder or Path(rel).parent.name or "General"
        out.append({
            "id": rel,
            "title": r["title"] or Path(rel).stem,
            "filename": Path(rel).name,
            "folder": folder,
        })
    return out


def _resolve_user_dir(raw_path: str) -> Path:
    cleaned = (raw_path or "").strip().strip('"').strip("'")
    if not cleaned:
        raise HTTPException(status_code=422, detail="Source folder is required")
    return Path(os.path.expandvars(cleaned)).expanduser().resolve()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _safe_pdf_filename(name: str) -> str:
    safe = Path(name or "book.pdf").name
    safe = "".join(ch for ch in safe if ch not in '<>:"/\\|?*').strip()
    if not safe:
        safe = "book.pdf"
    if not safe.lower().endswith(".pdf"):
        safe += ".pdf"
    return safe


def _book_system_for(pdf_path: Path) -> str:
    parent_text = " ".join(part for part in pdf_path.parts[-4:-1] if part)
    text = f" {parent_text} {pdf_path.stem} ".lower().replace("_", " ").replace("-", " ")
    text = " ".join(text.split())
    padded = f" {text} "
    for system, keywords in BOOK_SYSTEM_KEYWORDS:
        if any(keyword in padded for keyword in keywords):
            return system
    return "Miscellaneous"


def _iter_source_pdfs(source: Path, recursive: bool) -> list[Path]:
    iterator = source.rglob("*.pdf") if recursive else source.glob("*.pdf")
    pdfs: list[Path] = []
    for pdf in iterator:
        if not pdf.is_file() or pdf.name.startswith("."):
            continue
        parts = {p.lower() for p in pdf.parts}
        if "_thumbs" in parts or ".thumbnails" in parts:
            continue
        pdfs.append(pdf)
    return sorted(pdfs, key=lambda p: str(p).lower())


def _destination_for(source_pdf: Path, system: str, overwrite: bool) -> Path:
    dest_dir = LIBRARY_PATH / system
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / _safe_pdf_filename(source_pdf.name)
    if overwrite or not dest.exists():
        return dest
    if _same_file(source_pdf, dest) or source_pdf.stat().st_size == dest.stat().st_size:
        return dest

    stem = dest.stem
    suffix = dest.suffix
    for i in range(2, 1000):
        candidate = dest_dir / f"{stem} ({i}){suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Too many duplicate filenames for {dest.name}")


def _same_file(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve() or os.path.samefile(a, b)
    except OSError:
        return False


def _copy_or_move_book(source_pdf: Path, dest: Path, mode: str, overwrite: bool) -> str:
    if _same_file(source_pdf, dest):
        return "skipped"

    if dest.exists():
        if overwrite:
            dest.unlink()
        elif source_pdf.stat().st_size == dest.stat().st_size:
            return "skipped"

    source_in_library = _is_relative_to(source_pdf, LIBRARY_PATH)
    if mode == "move" or source_in_library:
        shutil.move(str(source_pdf), str(dest))
        return "moved"

    shutil.copy2(source_pdf, dest)
    return "copied"


class FolderImportRequest(BaseModel):
    source_path: str = Field(..., min_length=1, max_length=1000)
    mode: Literal["copy", "move"] = "copy"
    recursive: bool = True
    overwrite: bool = False


def _import_job_snapshot() -> dict:
    with _import_lock:
        return dict(_import_job)


def _set_import_job(values: dict) -> None:
    with _import_lock:
        _import_job.update(values)


def _run_folder_import(job_id: str, req: FolderImportRequest) -> None:
    global _books_cache
    try:
        source = _resolve_user_dir(req.source_path)
        LIBRARY_PATH.mkdir(parents=True, exist_ok=True)
        pdfs = _iter_source_pdfs(source, req.recursive)
        _set_import_job({
            "status": "running",
            "job_id": job_id,
            "source_path": str(source),
            "library_path": str(LIBRARY_PATH),
            "scanned": len(pdfs),
            "processed": 0,
        })

        copied = moved = skipped = failed = 0
        categories: dict[str, int] = {}
        failures: list[dict] = []

        for index, pdf in enumerate(pdfs, start=1):
            system = _book_system_for(pdf)
            categories[system] = categories.get(system, 0) + 1
            _set_import_job({
                "processed": index - 1,
                "current": str(pdf),
                "current_system": system,
                "copied": copied,
                "moved": moved,
                "skipped": skipped,
                "failed": failed,
                "categories": categories,
            })
            try:
                dest = _destination_for(pdf, system, req.overwrite)
                result = _copy_or_move_book(pdf, dest, req.mode, req.overwrite)
                if result == "copied":
                    copied += 1
                elif result == "moved":
                    moved += 1
                else:
                    skipped += 1
            except Exception as exc:
                failed += 1
                if len(failures) < 30:
                    failures.append({"path": str(pdf), "error": str(exc)})

        _set_import_job({
            "status": "indexing",
            "processed": len(pdfs),
            "copied": copied,
            "moved": moved,
            "skipped": skipped,
            "failed": failed,
            "categories": categories,
            "failures": failures,
            "current": "",
        })

        _ensure_library_index(force=True)
        books = _load_books_from_db()
        _books_cache = books
        # Build chapter deep-links + refresh global search so the imported books
        # are searchable to the page/chapter level, not just listed on the shelf.
        _sync_search_indexes_bg(only_paths=None, full=False)
        _set_import_job({
            "status": "completed",
            "completed_at": int(time.time()),
            "books": len(books),
            "search_indexing": True,
        })
    except Exception as exc:
        _set_import_job({
            "status": "failed",
            "error": str(exc),
            "completed_at": int(time.time()),
        })


# ── ETag helper ────────────────────────────────────────────────────────────

def _etag(path: Path) -> str:
    st = path.stat()
    raw = f"{path}:{st.st_mtime}:{st.st_size}"
    return '"' + hashlib.sha1(raw.encode()).hexdigest()[:20] + '"'


# ── Thumbnail helper ───────────────────────────────────────────────────────

def _thumb_path(rel: str) -> Path:
    safe = rel.replace("/", "_").replace("\\", "_")
    return THUMB_DIR / (safe + ".webp")


def _library_book_path(raw_path: str, action: str = "accessed") -> tuple[str, Path]:
    rel = unquote(raw_path or "").replace("\\", "/").lstrip("/")
    if not rel:
        raise HTTPException(status_code=422, detail="Book path is required")
    if Path(rel).suffix.lower() != ".pdf":
        raise HTTPException(status_code=422, detail=f"Only PDF books can be {action}")
    full_path = (LIBRARY_PATH / rel).resolve()
    if not _is_relative_to(full_path, LIBRARY_PATH):
        raise HTTPException(status_code=403, detail="Access denied")
    return rel, full_path


def _content_disposition(filename: str) -> str:
    """
    Starlette encodes headers as latin-1. Keep the legacy filename parameter
    ASCII-only and put the real Unicode filename in RFC 5987 filename*.
    """
    fallback = filename.encode("ascii", "ignore").decode("ascii")
    fallback = fallback.replace("\\", "_").replace("/", "_").replace('"', "'")
    fallback = "".join(ch if 32 <= ord(ch) < 127 else "_" for ch in fallback).strip(" .")
    if not fallback:
        fallback = "book.pdf"
    elif filename.lower().endswith(".pdf") and not fallback.lower().endswith(".pdf"):
        fallback += ".pdf"
    return f"inline; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def _heading_fts_has_content_mismatch(c: sqlite3.Connection) -> bool:
    row = c.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='heading_fts'"
    ).fetchone()
    sql = str(row[0] if row else "").lower()
    if "content='headings'" not in sql and 'content="headings"' not in sql:
        return False

    heading_cols = {str(r[1]) for r in c.execute("PRAGMA table_info(headings)").fetchall()}
    fts_cols = {str(r[1]) for r in c.execute("PRAGMA table_info(heading_fts)").fetchall()}
    return any(col not in heading_cols for col in fts_cols)


def _delete_thumb_files(rel: str) -> list[str]:
    candidates = {
        _thumb_path(rel),
        _thumb_path(rel).with_suffix(".jpg"),
        _thumb_path(rel).with_suffix(".jpeg"),
    }
    legacy_safe = rel.replace("/", "_").replace("\\", "_")
    candidates.add(LIBRARY_PATH / ".thumbnails" / f"{legacy_safe}.jpg")

    deleted: list[str] = []
    for thumb in candidates:
        try:
            if thumb.exists() and thumb.is_file():
                thumb.unlink()
                deleted.append(str(thumb))
        except Exception as exc:
            print(f"[library] thumbnail delete failed for {thumb}: {exc}")
    return deleted


def _delete_from_library_index(rel: str) -> dict[str, int]:
    _library_index_init()
    c = _library_index_conn()
    try:
        c.execute("BEGIN")
        books_deleted = c.execute("DELETE FROM books WHERE id=?", (rel,)).rowcount
        chapters_deleted = c.execute(
            "DELETE FROM chapters WHERE id=? OR id LIKE ?",
            (rel, f"{rel}:%"),
        ).rowcount
        c.commit()
        return {"books": max(books_deleted, 0), "chapters": max(chapters_deleted, 0)}
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def _delete_from_chapter_index(rel: str) -> dict[str, int]:
    if not BOOK_CHAPTER_INDEX_DB.exists():
        return {"books": 0, "headings": 0}

    c = sqlite3.connect(str(BOOK_CHAPTER_INDEX_DB), timeout=10)
    c.row_factory = sqlite3.Row
    try:
        book = c.execute("SELECT id FROM books WHERE id=?", (rel,)).fetchone()
        if not book:
            return {"books": 0, "headings": 0}

        heading_ids = [
            int(r["id"])
            for r in c.execute("SELECT id FROM headings WHERE book_id=?", (rel,)).fetchall()
        ]
        skip_fts_delete = _heading_fts_has_content_mismatch(c)
        c.execute("BEGIN")
        if heading_ids and not skip_fts_delete:
            c.executemany("DELETE FROM heading_fts WHERE rowid=?", [(hid,) for hid in heading_ids])
        headings_deleted = c.execute("DELETE FROM headings WHERE book_id=?", (rel,)).rowcount
        books_deleted = c.execute("DELETE FROM books WHERE id=?", (rel,)).rowcount
        c.commit()
        return {"books": max(books_deleted, 0), "headings": max(headings_deleted, 0)}
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def _chapter_index_counts() -> dict[str, int | str]:
    if not BOOK_CHAPTER_INDEX_DB.exists():
        return {"books": 0, "headings": 0, "path": str(BOOK_CHAPTER_INDEX_DB)}

    c = sqlite3.connect(f"file:{BOOK_CHAPTER_INDEX_DB}?mode=ro", uri=True, timeout=5)
    try:
        books = c.execute("SELECT count(*) FROM books").fetchone()[0]
        headings = c.execute("SELECT count(*) FROM headings").fetchone()[0]
        return {
            "books": int(books or 0),
            "headings": int(headings or 0),
            "path": str(BOOK_CHAPTER_INDEX_DB),
        }
    except Exception:
        return {"books": 0, "headings": 0, "path": str(BOOK_CHAPTER_INDEX_DB)}
    finally:
        c.close()


def _remove_book_from_state(rel: str) -> bool:
    state_file = LIBRARY_PATH / "library_state.json"
    if not state_file.exists():
        return False
    try:
        state: Any = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(state, dict):
        return False

    changed = False
    books = state.get("books")
    if isinstance(books, dict) and rel in books:
        books.pop(rel, None)
        changed = True
    elif isinstance(books, list):
        next_books = [
            item for item in books
            if not (
                item == rel
                or (isinstance(item, dict) and item.get("id") == rel)
            )
        ]
        if len(next_books) != len(books):
            state["books"] = next_books
            changed = True

    if changed:
        state_file.write_text(json.dumps(state, indent=2), encoding="utf-8")
    return changed


def _clear_search_caches() -> None:
    try:
        import importlib

        search_router = importlib.import_module("routers.search")
        for name in ("_query_books", "_query_book_chapters", "_ensure_book_chapter_search_indexes"):
            fn = getattr(search_router, name, None)
            if hasattr(fn, "cache_clear"):
                fn.cache_clear()
        # Endpoint-level result cache, so reranked book priority shows immediately.
        unified = getattr(search_router, "_unified_search_cache", None)
        if hasattr(unified, "clear"):
            unified.clear()
    except Exception as exc:
        print(f"[library] search cache clear skipped: {exc}")


def _generate_thumb(full_path: Path, thumb: Path) -> None:
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(full_path)
    try:
        page = doc.load_page(0)
        # Scale to fit THUMB_SIZE maintaining aspect ratio
        vp = page.rect
        scale = min(THUMB_SIZE[0] / max(vp.width, 1), THUMB_SIZE[1] / max(vp.height, 1))
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        # Save as WebP via PIL if available, else JPEG fallback
        try:
            from PIL import Image
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            img.save(str(thumb), "WEBP", quality=75, method=4)
        except ImportError:
            # Pillow not installed — use JPEG
            jpeg_thumb = thumb.with_suffix(".jpg")
            jpeg_thumb.write_bytes(pix.tobytes("jpeg", jpg_quality=75))
    finally:
        doc.close()


# ── Routes ─────────────────────────────────────────────────────────────────

@router.get("/books")
def list_library_books():
    # Serve from the in-memory cache — zero SQLite I/O per request.
    books = _books_cache
    if not books:
        _reindex_bg()
    return {"books": books, "total": len(books)}


@router.get("/thumb")
def get_library_thumb(path: str, request: Request):
    rel, _ = _library_book_path(path, action="previewed")

    # Check cheap local thumbnail paths ONLY — never hit E: drive here.
    # Thumbnails are pre-generated at boot by _pregen_thumbs_bg().
    # If not ready yet, return 404; the frontend retries with backoff.
    thumb = _thumb_path(rel)
    thumb_jpeg = thumb.with_suffix(".jpg")

    if thumb.exists():
        chosen = thumb
    elif thumb_jpeg.exists():
        chosen = thumb_jpeg
    else:
        raise HTTPException(status_code=404, detail="Thumbnail not ready yet")

    media = "image/webp" if chosen.suffix == ".webp" else "image/jpeg"
    etag = _etag(chosen)
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(
        content=chosen.read_bytes(),
        media_type=media,
        headers={
            "ETag": etag,
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.get("/pdf")
def get_library_pdf(path: str, request: Request):
    """
    Streams PDF with proper HTTP Range support so pdf.js loads the first page
    immediately without downloading the whole file.

    Returns 206 Partial Content for Range requests, 200 for full downloads.
    """
    _rel, full_path = _library_book_path(path, action="opened")
    if not full_path.exists() or full_path.suffix.lower() != ".pdf":
        raise HTTPException(status_code=404, detail="PDF not found")

    file_size = full_path.stat().st_size
    etag = _etag(full_path)
    fname = full_path.name

    # ETag cache check
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)

    range_header = request.headers.get("range")

    base_headers = {
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "Cache-Control": "public, max-age=86400, immutable",
        "Content-Disposition": _content_disposition(fname),
    }

    CHUNK = 1 << 20  # 1 MB streaming chunks

    if range_header:
        # Parse "bytes=start-end"
        try:
            unit, _, rng = range_header.partition("=")
            if unit.strip().lower() != "bytes" or not rng:
                raise ValueError
            start_s, _, end_s = rng.strip().partition("-")
            start = int(start_s) if start_s else 0
            end   = int(end_s)   if end_s   else file_size - 1
        except (ValueError, IndexError):
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

        if start > end or end >= file_size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

        length = end - start + 1

        def _stream_range():
            with open(full_path, "rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    data = fh.read(min(CHUNK, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            _stream_range(),
            status_code=206,
            media_type="application/pdf",
            headers={
                **base_headers,
                "Content-Length": str(length),
                "Content-Range": f"bytes {start}-{end}/{file_size}",
            },
        )

    # Full download (no Range header)
    def _stream_full():
        with open(full_path, "rb") as fh:
            while True:
                data = fh.read(CHUNK)
                if not data:
                    break
                yield data

    return StreamingResponse(
        _stream_full(),
        status_code=200,
        media_type="application/pdf",
        headers={**base_headers, "Content-Length": str(file_size)},
    )


@router.delete("/book")
def delete_library_book(path: str = Query(..., min_length=1)):
    """
    Delete a PDF from the local bookshelf and remove its searchable rows.

    This intentionally accepts a query parameter rather than a path segment so
    nested relative paths such as "Cardiology/foo.pdf" do not fight routing.
    """
    global _books_cache

    rel, full_path = _library_book_path(path, action="deleted")
    file_deleted = False

    if full_path.exists():
        if not full_path.is_file():
            raise HTTPException(status_code=422, detail="Book path is not a file")
        full_path.unlink()
        file_deleted = True

    thumbs_deleted = _delete_thumb_files(rel)
    library_rows = _delete_from_library_index(rel)
    chapter_rows = _delete_from_chapter_index(rel)
    state_changed = _remove_book_from_state(rel)

    if not file_deleted and not any(library_rows.values()) and not any(chapter_rows.values()):
        raise HTTPException(status_code=404, detail="Book not found")

    _ensure_library_index(force=True)
    _books_cache = _load_books_from_db()
    _clear_search_caches()
    # Drop the deleted book's rows from the global search index too.
    _sync_search_indexes_bg(only_paths=None, full=False, force_search=True)

    return {
        "status": "ok",
        "deleted": rel,
        "file_deleted": file_deleted,
        "thumbnails_deleted": len(thumbs_deleted),
        "library_index": library_rows,
        "chapter_index": chapter_rows,
        "state_changed": state_changed,
        "books": len(_books_cache),
    }


# ── State persistence ──────────────────────────────────────────────────────

class ShelfState(BaseModel):
    shelves: list = Field(default_factory=list)
    books: dict | list = Field(default_factory=dict)
    # Optional: omitted by the shelf UI, preserved across saves; managed by the
    # dedicated /library/priority endpoint (the ★ toggle).
    priority_books: dict | None = None


class PriorityRequest(BaseModel):
    book_id: str = Field(..., min_length=1, max_length=1000)
    priority: bool = True
    tier: str = "gold"


def _read_library_state() -> dict:
    state_file = LIBRARY_PATH / "library_state.json"
    if state_file.exists():
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


@router.get("/state")
def get_library_state():
    state = _read_library_state()
    if state:
        return state
    return {"shelves": [], "books": []}


@router.post("/state")
def save_library_state(state: ShelfState):
    state_file = LIBRARY_PATH / "library_state.json"
    payload = state.model_dump()
    # Preserve the ★ priority overrides when the shelf UI saves without them.
    if payload.get("priority_books") is None:
        existing = _read_library_state().get("priority_books")
        payload["priority_books"] = existing if isinstance(existing, dict) else {}
    state_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"status": "ok"}


@router.post("/priority")
def set_book_priority(req: PriorityRequest):
    """Mark/unmark a book as a priority (gold-standard) reference. Persisted in
    the library state and read by the search ranker's priority registry."""
    rel = req.book_id.replace("\\", "/").lstrip("/")
    state = _read_library_state()
    pb = state.get("priority_books")
    if not isinstance(pb, dict):
        pb = {}
    if req.priority:
        pb[rel] = req.tier if req.tier in ("universal", "gold", "authority") else True
    else:
        pb.pop(rel, None)
    state["priority_books"] = pb
    (LIBRARY_PATH / "library_state.json").write_text(json.dumps(state, indent=2), encoding="utf-8")
    try:
        import book_priority
        book_priority.refresh()
    except Exception:
        pass
    _clear_search_caches()
    return {"status": "ok", "book_id": rel, "priority": bool(req.priority), "priority_books": pb}


@router.post("/import-folder")
def import_library_folder(req: FolderImportRequest):
    source = _resolve_user_dir(req.source_path)
    if not source.exists() or not source.is_dir():
        raise HTTPException(status_code=404, detail=f"Source folder not found: {source}")

    current = _import_job_snapshot()
    if current.get("status") in {"running", "indexing"}:
        raise HTTPException(status_code=409, detail="A library folder import is already running")

    job_id = uuid.uuid4().hex[:12]
    now = int(time.time())
    with _import_lock:
        _import_job.clear()
        _import_job.update({
            "status": "queued",
            "job_id": job_id,
            "source_path": str(source),
            "library_path": str(LIBRARY_PATH),
            "mode": req.mode,
            "recursive": req.recursive,
            "overwrite": req.overwrite,
            "started_at": now,
            "scanned": 0,
            "processed": 0,
            "copied": 0,
            "moved": 0,
            "skipped": 0,
            "failed": 0,
            "categories": {},
            "failures": [],
            "current": "",
            "books": len(_books_cache),
        })

    threading.Thread(target=_run_folder_import, args=(job_id, req), daemon=True).start()
    return _import_job_snapshot()


@router.get("/import-folder/status")
def import_library_folder_status():
    return _import_job_snapshot()


@router.post("/upload")
async def upload_library_pdf(file: UploadFile = File(...), folder: str = Form("General")):
    if not LIBRARY_PATH.exists():
        LIBRARY_PATH.mkdir(parents=True, exist_ok=True)

    target_dir = LIBRARY_PATH / folder
    target_dir.mkdir(exist_ok=True)

    safe_name = Path(file.filename or "unknown.pdf").name
    if not safe_name.lower().endswith(".pdf"):
        safe_name += ".pdf"

    target_path = target_dir / safe_name
    content = await file.read()
    target_path.write_bytes(content)

    rel = target_path.relative_to(LIBRARY_PATH).as_posix()
    _reindex_bg(force=True)
    # Index this book's chapters + refresh search so its topics are searchable
    # and open to the right page, not just listed on the shelf.
    _sync_search_indexes_bg(only_paths=[rel], full=False)

    return {"status": "ok", "id": rel, "filename": safe_name, "folder": folder,
            "title": Path(safe_name).stem, "search_indexing": True}


@router.post("/reindex")
def reindex_library(force: bool = Query(default=True), deep: bool = Query(default=True)):
    """Rebuild the book-level index, and (deep=True) the chapter + global search
    indexes too. The deep reindex runs in the background; poll /library/index-status."""
    _ensure_library_index(force=force)
    _clear_search_caches()
    if deep:
        _sync_search_indexes_bg(only_paths=None, full=True)
    c = _library_index_conn()
    try:
        b = c.execute("SELECT count(*) AS n FROM books").fetchone()["n"]
    finally:
        c.close()
    return {"status": "ok", "books": int(b), "deep_indexing": bool(deep)}


@router.get("/index-status")
def library_index_status():
    _library_index_init()
    chapter_index = _chapter_index_counts()
    c = _library_index_conn()
    try:
        b  = c.execute("SELECT count(*) AS n FROM books").fetchone()["n"]
        legacy_ch = c.execute("SELECT count(*) AS n FROM chapters").fetchone()["n"]
        sig = c.execute("SELECT value FROM meta WHERE key='library_signature'").fetchone()
        upd = c.execute("SELECT value FROM meta WHERE key='library_index_updated_at'").fetchone()
    finally:
        c.close()
    return {
        "books": int(b or 0),
        "chapters": int(chapter_index.get("headings") or legacy_ch or 0),
        "book_chapter_index": chapter_index,
        "signature": sig["value"] if sig else "",
        "updated_at": int(upd["value"]) if upd and str(upd["value"]).isdigit() else None,
        "library_path": str(LIBRARY_PATH),
        "library_exists": LIBRARY_PATH.exists(),
        "search_index": search_index_status(),
    }


# ── Per-book index status / one-book indexing ──────────────────────────────
# The Content Manager Books room lists every PDF separately so a user can see
# which books are already deep-indexed (chapter outlines + global search) and
# kick off indexing for a single book instead of the whole library.

_BOOK_INDEX_TTL = 15.0
_book_index_cache: dict[str, Any] = {"at": 0.0, "payload": None}


def _pdf_signature(pdf: Path) -> str:
    """Same identity string build_book_chapter_index uses (absolute-path form)."""
    try:
        st = pdf.stat()
    except OSError:
        return ""
    raw = f"{pdf}:{st.st_mtime_ns}:{st.st_size}".encode("utf-8", "ignore")
    return hashlib.sha1(raw).hexdigest()


def _book_index_payload() -> dict:
    """Every library PDF with its chapter-index state, grouped by shelf."""
    now = time.time()
    cached = _book_index_cache.get("payload")
    if cached is not None and now - float(_book_index_cache.get("at") or 0.0) < _BOOK_INDEX_TTL:
        return cached

    rows: dict[str, dict] = {}
    if BOOK_CHAPTER_INDEX_DB.exists():
        try:
            c = sqlite3.connect(f"file:{BOOK_CHAPTER_INDEX_DB}?mode=ro", uri=True, timeout=5)
            c.row_factory = sqlite3.Row
            try:
                for r in c.execute(
                    "SELECT id, page_count, useful_heading_count, status, error, signature FROM books"
                ):
                    rows[str(r["id"])] = dict(r)
            finally:
                c.close()
        except Exception as exc:
            print(f"[library] per-book index read failed: {exc}")

    counts = {"total": 0, "indexed": 0, "missing": 0, "empty": 0, "failed": 0, "stale": 0}
    shelves: dict[str, list[dict]] = {}
    for pdf in _iter_source_pdfs(LIBRARY_PATH, True):
        try:
            rel = pdf.relative_to(LIBRARY_PATH).as_posix()
            size = pdf.stat().st_size
        except OSError:
            continue
        row = rows.get(rel)
        if row is None:
            state = "missing"
        elif row.get("signature") and row["signature"] != _pdf_signature(pdf):
            state = "stale"
        else:
            state = str(row.get("status") or "ok")
        if state not in ("ok", "missing", "empty", "failed", "stale"):
            state = "ok"

        counts["total"] += 1
        if state == "ok":
            counts["indexed"] += 1
        elif state in counts:
            counts[state] += 1

        folder = rel.split("/", 1)[0] if "/" in rel else "General"
        shelves.setdefault(folder, []).append({
            "id": rel,
            "title": Path(rel).stem,
            "folder": folder,
            "size": size,
            "state": state,
            "headings": int(row.get("useful_heading_count") or 0) if row else 0,
            "pages": int(row.get("page_count") or 0) if row else 0,
            "error": str(row.get("error") or "") if row else "",
        })

    payload = {
        "library": str(LIBRARY_PATH),
        "counts": counts,
        "shelves": [
            {
                "name": name,
                "count": len(books),
                "size": sum(b["size"] for b in books),
                "books": sorted(books, key=lambda b: b["title"].lower()),
            }
            for name, books in sorted(shelves.items(), key=lambda kv: kv[0].lower())
        ],
        "indexing": search_index_status(),
        "cache_seconds": int(_BOOK_INDEX_TTL),
    }
    # Don't cache mid-build: the panel polls for live progress and finished rows.
    if payload["indexing"].get("status") not in ("indexing_chapters", "indexing_search"):
        _book_index_cache.update({"at": now, "payload": payload})
    return payload


class BookIndexRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=1024)


@router.get("/index/books")
def book_index_status():
    """Per-book chapter/search index state for the Content Manager."""
    return _book_index_payload()


@router.post("/index/book")
def index_library_book(req: BookIndexRequest):
    """Index a single book (chapter outlines + global-search rows)."""
    raw = (req.path or "").strip()
    library = LIBRARY_PATH.resolve()
    target = Path(raw)
    if not target.is_absolute():
        target = library / target
    try:
        target = target.resolve()
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"bad path: {exc}") from exc
    if not _is_relative_to(target, library):
        raise HTTPException(status_code=403, detail="path is outside the library")
    if target.suffix.lower() != ".pdf":
        raise HTTPException(status_code=422, detail="not a PDF")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="book not found")

    rel = target.relative_to(library).as_posix()
    running = str(search_index_status().get("status") or "")
    if running in ("indexing_chapters", "indexing_search"):
        return {"status": "busy", "path": rel, "detail": "another index build is already running"}

    _book_index_cache.update({"at": 0.0, "payload": None})
    _sync_search_indexes_bg([rel], full=False)
    return {"status": "queued", "path": rel}


# ── Boot helper (called by main lifespan) ──────────────────────────────────

def boot_library_index() -> None:
    """Called at startup in a background thread.
    Loads the in-memory book cache from SQLite — fast (<100 ms), no I/O beyond SQLite.
    Thumbnails are NOT pre-generated here; fitz.open() in background threads holds
    the GIL and freezes the uvicorn event loop.  The frontend renders colored
    placeholder covers when /library/thumb returns 404."""
    global _books_cache
    _library_index_init()
    books = _load_books_from_db()
    if books:
        _books_cache = books
        print(f"[library] Loaded {len(books)} books into memory cache.")
    else:
        print("[library] Index empty — scheduling background rebuild.")
        _reindex_bg()

    # Auto-index books dropped straight into the library folder while the app was
    # off: reconcile chapter deep-links + global search in the background. Cheap
    # no-op when the library is unchanged. Delayed so it never contends with boot
    # or the search warm-up (which reads the same global_search index). Opt out
    # with MEDOS_SKIP_BOOK_AUTOINDEX.
    if os.environ.get("MEDOS_SKIP_BOOK_AUTOINDEX", "").lower() not in {"1", "true", "yes"}:
        def _delayed_autoindex() -> None:
            time.sleep(25)
            _sync_search_indexes_bg(only_paths=None, full=False)
        threading.Thread(target=_delayed_autoindex, daemon=True).start()

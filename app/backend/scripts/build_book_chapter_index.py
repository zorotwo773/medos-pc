"""
Build a searchable chapter/heading SQLite index from the PDF outlines in the
MedOS book library.

This is intentionally cheap: it uses embedded PDF outlines/bookmarks only.
It does not OCR pages or ask an LLM. The script filters front matter and
page-only bookmark noise, keeps clinically useful hierarchy, stores page
numbers, and builds an FTS5 table for search.

Run from the repo root:

    .\\.venv\\Scripts\\python.exe app\\backend\\scripts\\build_book_chapter_index.py

Useful options:

    --rebuild
    --verbose
    --limit 10
    --output D:\\MedOS\\data\\book_chapter_index.sqlite
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote


BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = Path(__file__).resolve().parents[3]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from config import BOOK_CHAPTER_INDEX_DB, LIBRARY_PATH  # noqa: E402


DEFAULT_OUTPUT = BOOK_CHAPTER_INDEX_DB


FRONT_MATTER_TERMS = {
    "about the author",
    "about the authors",
    "about the editors",
    "acknowledgement",
    "acknowledgements",
    "acknowledgment",
    "acknowledgments",
    "also by",
    "author",
    "authors",
    "back cover",
    "bibliography",
    "book cover",
    "cover",
    "copyright",
    "copyright page",
    "dedication",
    "disclaimer",
    "editor",
    "editors",
    "foreword",
    "front cover",
    "front matter",
    "half title",
    "half title page",
    "how to use this book",
    "index",
    "notice",
    "notices",
    "preface",
    "preface to the first edition",
    "preface to the second edition",
    "preface to the third edition",
    "reviewers",
    "selected references",
    "table of contents",
    "title page",
}

NOISE_TERMS = {
    "abbreviations",
    "acronyms",
    "advisory board",
    "answer key",
    "answers",
    "appendices",
    "book",
    "bookmarks",
    "chapter objectives",
    "chapter outline",
    "contents",
    "contents at a glance",
    "contributors",
    "errata",
    "further reading",
    "glossary",
    "online resources",
    "other resources",
    "questions",
    "references",
    "review questions",
    "resources",
    "self assessment",
    "self-assessment",
    "untitled",
}

LEADING_LABEL_RE = re.compile(
    r"^\s*(?:(chapter|chap|section|sect|part|unit|book)\s*)?"
    r"([0-9]+|[ivxlcdm]+)\s*[\.\):\-–—]?\s*$",
    re.IGNORECASE,
)
PAGE_ONLY_RE = re.compile(
    r"^\s*(?:p(?:age)?\.?\s*)?(?:[0-9]+|[ivxlcdm]+)\s*$",
    re.IGNORECASE,
)
PAGE_RANGE_ONLY_RE = re.compile(
    r"^\s*(?:p(?:age)?s?\.?\s*)?(?:[0-9]+|[ivxlcdm]+)\s*[-–—]\s*(?:[0-9]+|[ivxlcdm]+)\s*$",
    re.IGNORECASE,
)
TRAILING_AUTHORS_RE = re.compile(r"\b(authors?|editors?|contributors?)\b", re.IGNORECASE)
WEBSITE_RE = re.compile(r"\b(?:www\.|\.com|\.net|\.org|pdfdrive|booktree|medicalstudyzone)\b", re.IGNORECASE)
CHAPTER_TITLE_RE = re.compile(
    r"^\s*(chapter|chap|section|sect|part|unit)\s+([0-9]+|[ivxlcdm]+)\b\s*[:\.\-–—]?\s+(.+)$",
    re.IGNORECASE,
)


@dataclass
class RawHeading:
    level: int
    title: str
    page: int


@dataclass
class BookResult:
    rel: str
    title: str
    folder: str
    page_count: int
    raw_outline_count: int
    status: str
    error: str
    headings: list[RawHeading]


@dataclass(frozen=True, slots=True)
class ChapterBuildProgress:
    """Detailed in-process progress while preserving the legacy callback shape."""

    processed: int
    total: int
    rate: float | None
    eta_seconds: float | None
    current_path: str


def fold(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return value.lower()


def norm_key(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", fold(value))).strip()


def clean_title(value: str) -> str:
    text = unicodedata.normalize("NFKC", value or "")
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text).strip(" \t\r\n-–—:;,.")
    return text


def is_noise_heading(title: str, page: int, book_title: str = "") -> bool:
    clean = clean_title(title)
    key = norm_key(clean)
    book_key = norm_key(book_title)
    if not clean or not key:
        return True
    if book_key and key == book_key:
        return True
    if page <= 5 and book_key:
        key_tokens = set(key.split())
        book_tokens = set(book_key.split())
        if key_tokens and key_tokens.issubset(book_tokens):
            return True
    if page <= 5 and len(key.split()) <= 5 and not re.match(r"^(chapter|section|part|unit|[0-9]+)\b", key):
        return True
    if len(key) < 3:
        return True
    if WEBSITE_RE.search(clean):
        return True
    if PAGE_ONLY_RE.match(clean) or PAGE_RANGE_ONLY_RE.match(clean):
        return True
    if key in FRONT_MATTER_TERMS or key in NOISE_TERMS:
        return True
    if key.startswith("copyright "):
        return True
    if key.startswith("contents "):
        return True
    if "table of contents" in key:
        return True
    if key.startswith("bibliography"):
        return True
    if key == "historical introduction":
        return True
    if "international standard book number" in key or "isbn" == key:
        return True
    if "acronym" in key or "abbreviation" in key:
        return True
    if "preface" in key or "foreword" in key:
        return True
    if "acknowledg" in key:
        return True
    if key.startswith("marketing ad"):
        return True
    if key.startswith("about the "):
        return True
    if page <= 10 and (" edition" in f" {key}" or " title page" in key):
        return True
    if page <= 12 and "collection of medical illustrations" in key:
        return True
    if page <= 15 and key.startswith("introduction"):
        return True
    if key.startswith("introduction to the first edition") or key.startswith("introductions to the first edition"):
        return True
    if TRAILING_AUTHORS_RE.search(clean) and len(key.split()) <= 8:
        return True
    if LEADING_LABEL_RE.match(clean):
        return True
    # References are useful inside a reader, but not useful as app search targets.
    if key.endswith(" references") or key.startswith("references "):
        return True
    # Early roman-numeral front-matter bookmarks are usually not clinical headings.
    if page <= 20 and key in {"introduction", "overview"}:
        return True
    return False


def is_noise_subtree(title: str) -> bool:
    key = norm_key(title)
    if not key:
        return False
    if key in {
        "advisory board",
        "bibliography of selected titles",
        "chapter objectives",
        "chapter outline",
        "historical introduction",
        "review questions",
        "selected references",
    }:
        return True
    if key.startswith("about the "):
        return True
    if key.startswith("bibliography"):
        return True
    if key.startswith("references"):
        return True
    if key.startswith("review questions"):
        return True
    if key.startswith("marketing ad"):
        return True
    return False


def title_kind(title: str) -> str:
    key = norm_key(title)
    if key.startswith("part "):
        return "part"
    if key.startswith("section "):
        return "section"
    if key.startswith("chapter ") or re.match(r"^[0-9]+ ", key):
        return "chapter"
    if "appendix" in key:
        return "appendix"
    return "heading"


def iter_pdfs(library: Path) -> list[Path]:
    pdfs: list[Path] = []
    for pdf in sorted(library.rglob("*.pdf"), key=lambda p: str(p).lower()):
        if pdf.name.startswith("."):
            continue
        if any(part.lower() in {"_thumbs", ".thumbnails"} for part in pdf.parts):
            continue
        pdfs.append(pdf)
    return pdfs


PDF_OUTLINE_HELPER = r"""
import json
import sys
from pathlib import Path

import fitz

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

pdf = Path(sys.argv[1])
with fitz.open(pdf) as doc:
    toc = doc.get_toc(simple=True) or []
    out = {
        "page_count": int(doc.page_count or 0),
        "toc": [
            [int(level or 1), str(title or ""), int(page or 1)]
            for level, title, page in toc
        ],
    }
print(json.dumps(out, ensure_ascii=False))
"""


def extract_outline(pdf: Path, timeout: int) -> tuple[int, list[RawHeading], str]:
    try:
        proc = subprocess.run(
            [sys.executable, "-c", PDF_OUTLINE_HELPER, str(pdf)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return 0, [], f"outline extraction timed out after {timeout}s"
    except Exception as exc:
        return 0, [], str(exc)

    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
        return 0, [], message.splitlines()[-1] if message else f"exit {proc.returncode}"

    stdout = proc.stdout.strip()
    json_start = stdout.find('{"page_count"')
    if json_start > 0:
        stdout = stdout[json_start:]
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return 0, [], f"invalid outline JSON: {exc}"

    page_count = int(payload.get("page_count") or 0)
    headings: list[RawHeading] = []
    seen: set[tuple[int, str, int]] = set()
    for row in payload.get("toc") or []:
        if not isinstance(row, list) or len(row) < 3:
            continue
        level = max(1, int(row[0] or 1))
        title = clean_title(str(row[1] or ""))
        page = max(1, int(row[2] or 1))
        if page_count:
            page = min(page, page_count)
        key = (level, norm_key(title), page)
        if not title or key in seen:
            continue
        seen.add(key)
        headings.append(RawHeading(level=level, title=title, page=page))
    return page_count, headings, ""


def book_signature(pdf: Path, library: Path | None = None) -> str:
    st = pdf.stat()
    identity = pdf.relative_to(library).as_posix() if library is not None else str(pdf)
    raw = f"{identity}:{st.st_mtime_ns}:{st.st_size}".encode("utf-8", "ignore")
    return hashlib.sha1(raw).hexdigest()


def init_db(conn: sqlite3.Connection, rebuild: bool) -> None:
    if rebuild:
        conn.executescript(
            """
            DROP TABLE IF EXISTS heading_fts;
            DROP TABLE IF EXISTS headings;
            DROP TABLE IF EXISTS books;
            DROP TABLE IF EXISTS meta;
            """
        )

    conn.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            folder TEXT NOT NULL,
            path TEXT NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 0,
            raw_outline_count INTEGER NOT NULL DEFAULT 0,
            useful_heading_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            signature TEXT NOT NULL,
            mtime_ns INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS headings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id TEXT NOT NULL,
            parent_id INTEGER,
            position INTEGER NOT NULL,
            depth INTEGER NOT NULL,
            source_level INTEGER NOT NULL,
            title TEXT NOT NULL,
            title_norm TEXT NOT NULL,
            kind TEXT NOT NULL,
            page INTEGER NOT NULL,
            page_end INTEGER,
            href TEXT NOT NULL,
            hierarchy TEXT NOT NULL,
            search_text TEXT NOT NULL,
            FOREIGN KEY(book_id) REFERENCES books(id) ON DELETE CASCADE,
            FOREIGN KEY(parent_id) REFERENCES headings(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_headings_book_position
            ON headings(book_id, position);
        CREATE INDEX IF NOT EXISTS idx_headings_book_page
            ON headings(book_id, page);
        CREATE INDEX IF NOT EXISTS idx_headings_title_norm
            ON headings(title_norm);
        CREATE INDEX IF NOT EXISTS idx_headings_parent
            ON headings(parent_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS heading_fts USING fts5(
            title,
            book_title,
            folder,
            hierarchy,
            search_text,
            content='headings',
            content_rowid='id'
        );
        """
    )


def heading_fts_has_content_mismatch(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='heading_fts'"
    ).fetchone()
    sql = str(row[0] if row else "").lower()
    if "content='headings'" not in sql and 'content="headings"' not in sql:
        return False

    heading_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(headings)").fetchall()}
    fts_cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(heading_fts)").fetchall()}
    return any(col not in heading_cols for col in fts_cols)


def delete_book_rows(conn: sqlite3.Connection, book_id: str) -> None:
    row_ids = [r[0] for r in conn.execute("SELECT id FROM headings WHERE book_id=?", (book_id,))]
    if row_ids and not heading_fts_has_content_mismatch(conn):
        conn.executemany("DELETE FROM heading_fts WHERE rowid=?", [(row_id,) for row_id in row_ids])
    conn.execute("DELETE FROM headings WHERE book_id=?", (book_id,))
    conn.execute("DELETE FROM books WHERE id=?", (book_id,))


def insert_book(
    conn: sqlite3.Connection,
    library: Path,
    pdf: Path,
    result: BookResult,
    *,
    portable_paths: bool = False,
) -> int:
    rel = pdf.relative_to(library).as_posix()
    stat = pdf.stat()
    signature = book_signature(pdf, library if portable_paths else None)
    delete_book_rows(conn, rel)
    conn.execute(
        """
        INSERT INTO books (
            id, title, folder, path, page_count, raw_outline_count,
            useful_heading_count, status, error, signature, mtime_ns, size_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            rel,
            result.title,
            result.folder,
            rel if portable_paths else str(pdf),
            result.page_count,
            result.raw_outline_count,
            0,
            result.status,
            result.error[:1000],
            signature,
            int(stat.st_mtime_ns),
            int(stat.st_size),
        ),
    )

    kept_count = 0
    stack: list[dict] = []
    inserted_by_position: list[dict] = []
    skip_subtree_level: int | None = None
    for raw in result.headings:
        if skip_subtree_level is not None:
            if raw.level > skip_subtree_level:
                continue
            skip_subtree_level = None
        while stack and stack[-1]["source_level"] >= raw.level:
            stack.pop()
        if is_noise_heading(raw.title, raw.page, result.title):
            if is_noise_subtree(raw.title):
                skip_subtree_level = raw.level
            continue

        parent = stack[-1] if stack else None
        depth = (parent["depth"] + 1) if parent else 0
        hierarchy_titles = [*(parent["hierarchy_titles"] if parent else []), raw.title]
        hierarchy = " > ".join(hierarchy_titles)
        search_text = f"{raw.title} {result.title} {result.folder} {hierarchy}"
        href = f"/library?path={quote(rel)}&page={raw.page}"
        cursor = conn.execute(
            """
            INSERT INTO headings (
                book_id, parent_id, position, depth, source_level, title,
                title_norm, kind, page, page_end, href, hierarchy, search_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
            """,
            (
                rel,
                parent["id"] if parent else None,
                kept_count,
                depth,
                raw.level,
                raw.title,
                norm_key(raw.title),
                title_kind(raw.title),
                raw.page,
                href,
                hierarchy,
                search_text,
            ),
        )
        row_id = int(cursor.lastrowid)
        conn.execute(
            """
            INSERT INTO heading_fts(rowid, title, book_title, folder, hierarchy, search_text)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (row_id, raw.title, result.title, result.folder, hierarchy, search_text),
        )
        node = {
            "id": row_id,
            "source_level": raw.level,
            "depth": depth,
            "page": raw.page,
            "hierarchy_titles": hierarchy_titles,
        }
        stack.append(node)
        inserted_by_position.append(node)
        kept_count += 1

    for index, node in enumerate(inserted_by_position):
        page_end = result.page_count or None
        for later in inserted_by_position[index + 1 :]:
            if later["page"] > node["page"]:
                page_end = later["page"] - 1
                break
        conn.execute("UPDATE headings SET page_end=? WHERE id=?", (page_end, node["id"]))

    final_status = "ok" if kept_count else "failed" if result.error else "empty"
    conn.execute(
        "UPDATE books SET useful_heading_count=?, status=? WHERE id=?",
        (kept_count, final_status, rel),
    )
    return kept_count


def _process_pdf(
    conn: sqlite3.Connection,
    library: Path,
    pdf: Path,
    timeout: int,
    *,
    portable_paths: bool = False,
) -> int:
    """Extract one PDF's outline and (re)insert its rows. Returns kept headings."""
    rel = pdf.relative_to(library).as_posix()
    folder = pdf.parent.relative_to(library).as_posix()
    if folder == ".":
        folder = "General"
    page_count, raw_headings, error = extract_outline(pdf, timeout)
    status = "failed" if error else "empty" if not raw_headings else "ok"
    result = BookResult(
        rel=rel,
        title=pdf.stem,
        folder=folder,
        page_count=page_count,
        raw_outline_count=len(raw_headings),
        status=status,
        error=error,
        headings=raw_headings,
    )
    return insert_book(
        conn,
        library,
        pdf,
        result,
        portable_paths=portable_paths,
    )


def sync_library(
    library: Path | str | None = None,
    only_paths: list[str] | None = None,
    timeout: int = 20,
    rebuild: bool = False,
    progress=None,
    output: Path | str | None = None,
    portable_paths: bool = False,
) -> dict:
    """Incrementally reconcile the chapter index with the PDFs on disk.

    Designed to be called in-process by the library router after a scan. Only
    new/changed books (by signature) are reprocessed; books removed from disk are
    pruned. Pass ``only_paths`` to force-reindex specific files (e.g. a single
    freshly uploaded book) and skip the prune sweep. Returns a summary dict.
    """
    library = Path(library).expanduser().resolve() if library else LIBRARY_PATH.resolve()
    output = Path(output).expanduser().resolve() if output else DEFAULT_OUTPUT
    if not library.exists() or not library.is_dir():
        return {"status": "skipped", "reason": "library missing", "library": str(library)}
    output.parent.mkdir(parents=True, exist_ok=True)

    only_rel: set[str] | None = None
    if only_paths is not None:
        only_rel = set()
        for p in only_paths:
            pp = Path(p)
            try:
                rel = (pp if pp.is_absolute() else (library / pp)).resolve().relative_to(library).as_posix()
            except ValueError:
                rel = pp.as_posix().replace("\\", "/").lstrip("/")
            only_rel.add(rel)

    conn = sqlite3.connect(str(output))
    indexed = skipped = removed = failed = total_headings = 0
    try:
        init_db(conn, rebuild=rebuild)
        existing = {r[0]: r[1] for r in conn.execute("SELECT id, signature FROM books")}
        disk_rel = {p.relative_to(library).as_posix(): p for p in iter_pdfs(library)}

        conn.execute("BEGIN")
        # Prune books that no longer exist on disk (skip when scoped to a subset).
        if only_rel is None:
            for rel in list(existing):
                if rel not in disk_rel:
                    delete_book_rows(conn, rel)
                    removed += 1

        targets: list[tuple[str, Path]] = []
        for rel, pdf in disk_rel.items():
            if only_rel is not None and rel not in only_rel:
                continue
            signature = book_signature(pdf, library if portable_paths else None)
            if not rebuild and only_rel is None and existing.get(rel) == signature:
                skipped += 1
                continue
            targets.append((rel, pdf))

        progress_started = time.perf_counter()
        for i, (rel, pdf) in enumerate(targets, start=1):
            try:
                total_headings += _process_pdf(
                    conn,
                    library,
                    pdf,
                    timeout,
                    portable_paths=portable_paths,
                )
                indexed += 1
            except Exception:
                failed += 1
            if progress:
                elapsed = max(0.0, time.perf_counter() - progress_started)
                rate = i / elapsed if elapsed else None
                remaining = len(targets) - i
                eta = remaining / rate if rate and remaining else 0.0
                update = ChapterBuildProgress(
                    processed=i,
                    total=len(targets),
                    rate=rate,
                    eta_seconds=eta,
                    current_path=rel,
                )
                try:
                    progress(update)
                except TypeError:
                    try:
                        progress(i, len(targets), rel)
                    except Exception:
                        pass
                except Exception:
                    pass

        stored_library = "data/books" if portable_paths else str(library)
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('library_path', ?)",
            (stored_library,),
        )
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('built_at', ?)", (str(int(time.time())),))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('script_version', '1')")
        conn.commit()
    finally:
        conn.close()
    return {
        "status": "ok", "library": str(library), "indexed": indexed,
        "skipped": skipped, "removed": removed, "failed": failed,
        "headings": total_headings, "targets": indexed + failed,
    }


def build(args: argparse.Namespace) -> int:
    library = Path(args.library).expanduser().resolve() if args.library else LIBRARY_PATH.resolve()
    output = Path(args.output).expanduser().resolve()
    if not library.exists() or not library.is_dir():
        raise SystemExit(f"Library folder not found: {library}")

    pdfs = iter_pdfs(library)
    if args.limit:
        pdfs = pdfs[: args.limit]
    output.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(output))
    try:
        init_db(conn, rebuild=args.rebuild)
        started = time.time()
        total_headings = 0
        ok_books = empty_books = failed_books = 0

        conn.execute("BEGIN")
        for index, pdf in enumerate(pdfs, start=1):
            rel = pdf.relative_to(library).as_posix()
            folder = pdf.parent.relative_to(library).as_posix()
            if folder == ".":
                folder = "General"
            page_count, raw_headings, error = extract_outline(pdf, args.timeout)
            status = "failed" if error else "empty" if not raw_headings else "ok"
            result = BookResult(
                rel=rel,
                title=pdf.stem,
                folder=folder,
                page_count=page_count,
                raw_outline_count=len(raw_headings),
                status=status,
                error=error,
                headings=raw_headings,
            )
            kept = insert_book(conn, library, pdf, result)
            total_headings += kept
            if error:
                failed_books += 1
            elif kept:
                ok_books += 1
            else:
                empty_books += 1

            if args.verbose or index % 20 == 0 or index == len(pdfs):
                print(
                    f"{index:3}/{len(pdfs)} {kept:4} headings "
                    f"({len(raw_headings):4} raw) {rel}",
                    flush=True,
                )

        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('library_path', ?)",
            (str(library),),
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('built_at', ?)",
            (str(int(time.time())),),
        )
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES ('script_version', '1')",
        )
        conn.commit()
    finally:
        conn.close()

    elapsed = time.time() - started
    print()
    print(f"Output: {output}")
    print(f"Books scanned: {len(pdfs)}")
    print(f"Books with useful headings: {ok_books}")
    print(f"Books with no useful outline headings: {empty_books}")
    print(f"Books failed: {failed_books}")
    print(f"Useful headings indexed: {total_headings}")
    print(f"Elapsed: {elapsed:.1f}s")
    print()
    print("Example search:")
    print(
        f"  sqlite3 \"{output}\" "
        "\"SELECT h.title, h.page, h.href FROM heading_fts f "
        "JOIN headings h ON h.id=f.rowid WHERE heading_fts MATCH 'heart failure' LIMIT 20;\""
    )
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a meaningful searchable chapter heading index from MedOS book PDF outlines."
    )
    parser.add_argument("--library", default=str(LIBRARY_PATH), help="PDF library folder")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="SQLite output path")
    parser.add_argument("--rebuild", action="store_true", help="Drop/recreate index tables first")
    parser.add_argument("--limit", type=int, default=0, help="Only scan the first N PDFs")
    parser.add_argument("--timeout", type=int, default=20, help="Per-PDF outline extraction timeout in seconds")
    parser.add_argument("--verbose", action="store_true", help="Print every scanned book")
    return parser.parse_args(argv)


if __name__ == "__main__":
    raise SystemExit(build(parse_args(sys.argv[1:])))

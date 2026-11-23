"""
Build the First Aid topic-region index.

The builder reuses data/book_chapter_index.sqlite for the heading tree and
stores only page rectangles plus extracted text. Snippet images are rendered
later on demand by the API.

Run from app/backend:
    python scripts/firstaid/build_firstaid_index.py --audit asthma
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import fitz

_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import BOOK_CHAPTER_INDEX_DB, FIRSTAID_EDITION, FIRSTAID_INDEX_DB, FIRSTAID_PDF  # noqa: E402

FIRSTAID_TITLE = "First Aid for the USMLE Step 1 2026"


DDL = """
CREATE TABLE IF NOT EXISTS firstaid_regions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heading_id INTEGER NOT NULL,
    book_id TEXT NOT NULL,
    page INTEGER NOT NULL,
    page_end INTEGER NOT NULL,
    x0 REAL NOT NULL,
    y0 REAL NOT NULL,
    x1 REAL NOT NULL,
    y1 REAL NOT NULL,
    title TEXT NOT NULL,
    hierarchy TEXT NOT NULL DEFAULT '',
    body_text TEXT NOT NULL DEFAULT '',
    figure_refs TEXT NOT NULL DEFAULT '[]',
    keywords TEXT NOT NULL DEFAULT '',
    edition TEXT NOT NULL,
    href TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(heading_id, edition)
);
CREATE INDEX IF NOT EXISTS idx_firstaid_regions_heading ON firstaid_regions(heading_id, edition);
CREATE INDEX IF NOT EXISTS idx_firstaid_regions_title ON firstaid_regions(title);
CREATE INDEX IF NOT EXISTS idx_firstaid_regions_page ON firstaid_regions(page);
CREATE VIRTUAL TABLE IF NOT EXISTS firstaid_fts USING fts5(
    title,
    hierarchy,
    body_text,
    keywords,
    content='firstaid_regions',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2',
    prefix='2 3 4'
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class Heading:
    id: int
    book_id: str
    parent_id: int | None
    position: int
    depth: int
    title: str
    hierarchy: str
    page: int
    page_end: int
    href: str


def _norm(value: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (value or "").lower())).strip()


def _clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _pdf_title_candidates(title: str) -> list[str]:
    clean_title = _clean(title)
    candidates = [clean_title]
    compact_subscripts = [
        re.sub(
            r"\bUpper\s+([A-Za-z])\s+Subscript\s+([0-9]+)\b",
            lambda m: f"{m.group(1).upper()}{m.group(2)}",
            clean_title,
            flags=re.IGNORECASE,
        ),
        re.sub(
            r"\bupper\s+([A-Za-z])\s+subscript\s+([0-9]+)\b",
            lambda m: f"{m.group(1).upper()}{m.group(2)}",
            clean_title,
            flags=re.IGNORECASE,
        ),
    ]
    for candidate in compact_subscripts:
        if candidate and candidate != clean_title:
            candidates.append(candidate)
            candidates.append(re.sub(r"([A-Za-z])([0-9]+)\b", r"\1 \2", candidate))
    stripped = re.sub(r"^\d+\s+", "", clean_title).strip()
    if stripped and stripped != clean_title:
        candidates.append(stripped)
    if "-" in clean_title:
        candidates.append(clean_title.replace("-", " "))
    return [candidate for candidate in dict.fromkeys(candidates) if candidate]


def _open_chapter_db() -> sqlite3.Connection:
    if not BOOK_CHAPTER_INDEX_DB.exists():
        raise FileNotFoundError(f"Book chapter index not found: {BOOK_CHAPTER_INDEX_DB}")
    c = sqlite3.connect(f"file:{BOOK_CHAPTER_INDEX_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _find_firstaid_book_id(c: sqlite3.Connection, pdf_path: Path) -> str:
    candidates = c.execute(
        """
        SELECT id, title, path
        FROM books
        WHERE lower(title)=lower(?)
           OR lower(id) LIKE '%first aid%usmle%step%1%2026%'
           OR lower(path) LIKE '%first aid%usmle%step%1%2026%'
        ORDER BY
          CASE WHEN lower(title)=lower(?) THEN 0 ELSE 1 END,
          length(id)
        LIMIT 10
        """,
        (FIRSTAID_TITLE, FIRSTAID_TITLE),
    ).fetchall()
    if candidates:
        return str(candidates[0]["id"])

    pdf_norm = str(pdf_path).lower().replace("\\", "/")
    row = c.execute("SELECT id, path FROM books").fetchall()
    for item in row:
        if str(item["path"] or "").lower().replace("\\", "/") == pdf_norm:
            return str(item["id"])
    raise RuntimeError("Could not find First Aid in book_chapter_index.sqlite")


def _load_headings(book_id: str, limit: int | None = None) -> list[Heading]:
    c = _open_chapter_db()
    try:
        sql = """
            SELECT id, book_id, parent_id, position, depth, title, hierarchy,
                   page, COALESCE(page_end, page) AS page_end, href
            FROM headings
            WHERE book_id=?
            ORDER BY position ASC, id ASC
        """
        rows = c.execute(sql, (book_id,)).fetchall()
    finally:
        c.close()
    headings = [
        Heading(
            id=int(r["id"]),
            book_id=str(r["book_id"]),
            parent_id=int(r["parent_id"]) if r["parent_id"] is not None else None,
            position=int(r["position"]),
            depth=int(r["depth"]),
            title=_clean(r["title"]),
            hierarchy=_clean(r["hierarchy"]),
            page=max(1, int(r["page"] or 1)),
            page_end=max(1, int(r["page_end"] or r["page"] or 1)),
            href=str(r["href"] or ""),
        )
        for r in rows
        if _clean(r["title"])
    ]
    return headings[:limit] if limit else headings


def _next_boundary(headings: list[Heading], index: int) -> Heading | None:
    current = headings[index]
    for candidate in headings[index + 1:]:
        if candidate.depth <= current.depth:
            return candidate
    return None


def _page_for(doc: fitz.Document, page: int) -> fitz.Page:
    return doc.load_page(max(0, min(page - 1, doc.page_count - 1)))


def _search_title_rect(page: fitz.Page, title: str) -> fitz.Rect | None:
    rects: list[fitz.Rect] = []
    for candidate in _pdf_title_candidates(title):
        try:
            rects.extend(page.search_for(candidate, quads=False))
        except Exception:
            continue
    rects = [rect for rect in rects if rect.width > 4 and rect.height > 3]
    if rects:
        rects.sort(key=lambda r: (round(r.y0, 1), round(r.x0, 1), r.width))
        return rects[0]

    title_norm = _norm(_pdf_title_candidates(title)[-1] if _pdf_title_candidates(title) else title)
    if not title_norm:
        return None
    blocks = page.get_text("blocks")
    matches: list[fitz.Rect] = []
    for block in blocks:
        if len(block) < 5:
            continue
        text = _norm(str(block[4]))
        if title_norm and title_norm in text:
            matches.append(fitz.Rect(block[:4]))
    if matches:
        matches.sort(key=lambda r: (round(r.y0, 1), round(r.x0, 1)))
        return matches[0]
    return None


def _region_rect(
    page: fitz.Page,
    title_rect: fitz.Rect | None,
    boundary_rect: fitz.Rect | None,
    same_page_boundary: bool,
) -> fitz.Rect:
    page_rect = page.rect
    margin_x = max(14.0, page_rect.width * 0.025)
    top = (title_rect.y0 - 6.0) if title_rect else 28.0
    if same_page_boundary and boundary_rect and boundary_rect.y0 > top + 18:
        bottom = boundary_rect.y0 - 4.0
    else:
        bottom = page_rect.height - max(18.0, page_rect.height * 0.025)
    if bottom <= top + 18:
        bottom = min(page_rect.height, top + 130)
    return fitz.Rect(margin_x, max(0.0, top), page_rect.width - margin_x, min(page_rect.height, bottom))


def _body_text(page: fitz.Page, rect: fitz.Rect) -> str:
    text = page.get_text("text", clip=rect) or ""
    return _clean(text)


def _bold_terms(page: fitz.Page, rect: fitz.Rect, limit: int = 40) -> list[str]:
    try:
        data: dict[str, Any] = page.get_text("dict", clip=rect)
    except Exception:
        return []
    terms: list[str] = []
    seen: set[str] = set()
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = _clean(span.get("text") or "")
                if len(text) < 3 or len(text) > 80:
                    continue
                font = str(span.get("font") or "").lower()
                flags = int(span.get("flags") or 0)
                if "bold" not in font and not (flags & 16):
                    continue
                key = _norm(text)
                if key and key not in seen:
                    seen.add(key)
                    terms.append(text)
                    if len(terms) >= limit:
                        return terms
    return terms


def _keywords(heading: Heading, body_text: str, bold_terms: list[str]) -> str:
    bits = [heading.title, heading.hierarchy, *bold_terms]
    title_norm = _norm(heading.title)
    if title_norm:
        bits.extend(title_norm.split())
    body_words = [
        word for word in re.findall(r"[A-Za-z][A-Za-z0-9-]{3,}", body_text[:800])
        if word.lower() not in {"with", "from", "that", "this", "these", "into", "than"}
    ][:40]
    bits.extend(body_words)
    return _clean(" ".join(dict.fromkeys(bit for bit in bits if bit)))


def _open_out_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(path))
    c.row_factory = sqlite3.Row
    c.executescript(DDL)
    c.commit()
    return c


def build_index(
    *,
    pdf_path: Path,
    out_path: Path,
    edition: str,
    limit: int | None = None,
) -> int:
    if not pdf_path.exists():
        raise FileNotFoundError(f"First Aid PDF not found: {pdf_path}")

    chapter_db = _open_chapter_db()
    try:
        book_id = _find_firstaid_book_id(chapter_db, pdf_path)
    finally:
        chapter_db.close()

    headings = _load_headings(book_id, limit)
    if not headings:
        raise RuntimeError(f"No First Aid headings found for {book_id}")

    started = time.perf_counter()
    print(f"[firstaid] pdf: {pdf_path}")
    print(f"[firstaid] book_id: {book_id}")
    print(f"[firstaid] headings: {len(headings):,}")

    conn = _open_out_db(out_path)
    doc = fitz.open(pdf_path)
    rect_cache: dict[int, fitz.Rect | None] = {}
    rows: list[tuple[Any, ...]] = []
    now = int(time.time())
    try:
        for index, heading in enumerate(headings):
            page = _page_for(doc, heading.page)
            title_rect = rect_cache.get(heading.id)
            if heading.id not in rect_cache:
                title_rect = _search_title_rect(page, heading.title)
                rect_cache[heading.id] = title_rect

            boundary = _next_boundary(headings, index)
            same_page_boundary = bool(boundary and boundary.page == heading.page)
            boundary_rect = None
            if same_page_boundary and boundary:
                if boundary.id in rect_cache:
                    boundary_rect = rect_cache[boundary.id]
                else:
                    boundary_rect = _search_title_rect(page, boundary.title)
                    rect_cache[boundary.id] = boundary_rect

            rect = _region_rect(page, title_rect, boundary_rect, same_page_boundary)
            text = _body_text(page, rect)
            bold = _bold_terms(page, rect)
            page_end = heading.page if same_page_boundary else max(heading.page, heading.page_end)
            rows.append((
                heading.id,
                heading.book_id,
                heading.page,
                page_end,
                float(rect.x0),
                float(rect.y0),
                float(rect.x1),
                float(rect.y1),
                heading.title,
                heading.hierarchy,
                text,
                "[]",
                _keywords(heading, text, bold),
                edition,
                heading.href,
                now,
            ))

            if (index + 1) % 100 == 0:
                print(f"[firstaid] processed {index + 1:,}/{len(headings):,}")

        conn.execute("BEGIN")
        conn.execute("DELETE FROM firstaid_regions WHERE edition=?", (edition,))
        conn.execute("DELETE FROM firstaid_fts")
        conn.executemany(
            """
            INSERT INTO firstaid_regions (
                heading_id, book_id, page, page_end, x0, y0, x1, y1,
                title, hierarchy, body_text, figure_refs, keywords,
                edition, href, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.execute("INSERT INTO firstaid_fts(firstaid_fts) VALUES('rebuild')")
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('edition', ?)", (edition,))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('pdf_path', ?)", (str(pdf_path),))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('book_id', ?)", (book_id,))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)", (str(now),))
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('row_count', ?)", (str(len(rows)),))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        doc.close()
        conn.close()

    elapsed = time.perf_counter() - started
    print(f"[firstaid] wrote {len(rows):,} rows to {out_path} in {elapsed:.1f}s")
    return len(rows)


def audit(term: str, out_path: Path, image_zoom: int = 2) -> None:
    if str(_BACKEND) not in sys.path:
        sys.path.insert(0, str(_BACKEND))
    import firstaid

    firstaid.clear_caches()
    matches = firstaid.search_regions(term, 5)
    if not matches:
        print(f"[firstaid] audit: no match for {term!r}")
        return
    print(f"[firstaid] audit matches for {term!r}:")
    for item in matches:
        print(f"  h={item['heading_id']} p={item['page']} {item['title']} :: {item['hierarchy']}")
    image_path = firstaid.render_snippet_image(int(matches[0]["heading_id"]), zoom=image_zoom)
    target = Path(__file__).with_name(f"audit_{_norm(term).replace(' ', '_') or 'firstaid'}.webp")
    target.write_bytes(image_path.read_bytes())
    print(f"[firstaid] audit image: {target}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build First Aid indexed snippet regions")
    parser.add_argument("--pdf", default=str(FIRSTAID_PDF), help="First Aid PDF path")
    parser.add_argument("--out", default=str(FIRSTAID_INDEX_DB), help="Output firstaid_index.sqlite path")
    parser.add_argument("--edition", default=FIRSTAID_EDITION, help="Edition label")
    parser.add_argument("--limit", type=int, default=0, help="Limit headings for a quick development build")
    parser.add_argument("--audit", default="", help="Search term to audit after building")
    parser.add_argument("--audit-only", action="store_true", help="Skip build and only run --audit")
    args = parser.parse_args()

    pdf_path = Path(args.pdf).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    if not args.audit_only:
        build_index(
            pdf_path=pdf_path,
            out_path=out_path,
            edition=args.edition,
            limit=args.limit if args.limit > 0 else None,
        )
    if args.audit:
        audit(args.audit, out_path)


if __name__ == "__main__":
    main()

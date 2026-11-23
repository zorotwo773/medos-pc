"""
First Aid indexed-region helpers.

The index stores PDF page rectangles, not rendered crops. This module is the
shared runtime layer used by search, reference hover cards, and the snippet API.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Any

import fitz

from config import (
    BOOK_CHAPTER_INDEX_DB,
    FA_SNIPPET_CACHE_DIR,
    FIRSTAID_EDITION,
    FIRSTAID_INDEX_DB,
    FIRSTAID_PDF,
    LIBRARY_PATH,
)

FIRSTAID_BOOK_ID = "USMLE/First Aid for the USMLE Step 1 2026.pdf"

_NON_KEY_CHARS_RE = re.compile(r"[^a-z0-9]+")
_WHITESPACE_RE = re.compile(r"\s+")
_GENERIC_SCAN_TERMS = {
    "about", "adverse effect", "adverse effects", "after", "assessment",
    "before", "cause", "causes", "classification", "clinical",
    "clinical manifestations", "clinical presentation", "clinical use",
    "clinical uses", "complication", "complications", "definition",
    "diagnosis", "differential diagnosis", "etiology", "evaluation",
    "excess", "features", "finding", "findings", "function", "functions",
    "general", "image", "inheritance", "introduction", "lab", "laboratory",
    "labs", "management", "mechanism", "mechanism of action",
    "mechanism of resistance", "morphology", "note", "notes", "overview",
    "pathogenesis", "pathology", "pathophysiology", "patients",
    "presentation", "prevention", "prognosis", "regulation", "risk factor",
    "risk factors", "screening", "sign", "signs", "source", "summary",
    "symptom", "symptoms", "table", "testing", "tests", "therapy",
    "treatment", "type", "types", "workup",
    "acute", "chronic", "communicating", "noncommunicating", "obstructive",
    "palpable", "postprandial", "visible",
}

_FIRSTAID_TITLE_ALIASES = {
    "acute kidney injury": ("AKI",),
    "chronic kidney disease": ("CKD", "chronic renal failure"),
    "gastroesophageal reflux disease": ("GERD",),
    "hypertrophic pyloric stenosis": (
        "pyloric stenosis",
        "HPS",
        "infantile hypertrophic pyloric stenosis",
    ),
    "kidney stones": (
        "nephrolithiasis",
        "renal calculi",
        "urinary calculi",
        "urolithiasis",
        "calcium oxalate",
        "calcium oxalate stones",
        "struvite stones",
        "uric acid stones",
        "cystine stones",
    ),
    "myocardial infarction": ("MI", "heart attack"),
    "peptic ulcer disease": ("PUD",),
    "sickle cell disease": ("sickle cell anemia",),
    "wolff parkinson white syndrome": ("WPW", "WPW syndrome"),
}

_PARENTHETICAL_SINGLE_STOP = _GENERIC_SCAN_TERMS | {
    "adult", "benign", "congenital", "high", "low", "mild", "moderate",
    "severe", "primary", "secondary",
}
_MICROBIOLOGY_HINTS = ("bacteriology", "microbiology", "mycology", "parasitology")


def normalize(value: str | None) -> str:
    return _WHITESPACE_RE.sub(" ", _NON_KEY_CHARS_RE.sub(" ", (value or "").lower())).strip()


def _conn(readonly: bool = True) -> sqlite3.Connection:
    if readonly:
        c = sqlite3.connect(f"file:{FIRSTAID_INDEX_DB}?mode=ro", uri=True, timeout=10)
    else:
        FIRSTAID_INDEX_DB.parent.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(FIRSTAID_INDEX_DB), timeout=30)
    c.row_factory = sqlite3.Row
    return c


def index_exists() -> bool:
    return FIRSTAID_INDEX_DB.exists()


def fts_query(value: str) -> str:
    tokens = re.findall(r"[a-z0-9]+", normalize(value))
    tokens = [token for token in tokens if len(token) >= 2][:8]
    return " ".join(f"{token}*" for token in tokens)


def _query_variants(value: str) -> tuple[str, ...]:
    variants: list[str] = []
    seen: set[str] = set()

    def add(candidate: str | None) -> None:
        text = (candidate or "").strip()
        key = normalize(text)
        if not key or key in seen:
            return
        seen.add(key)
        variants.append(text)

    add(value)
    key = normalize(value)
    if re.search(r"\bdiabetic mellitus\b", key):
        add(re.sub(r"\bdiabetic mellitus\b", "diabetes mellitus", key))
    return tuple(variants)


def _contains_norm_phrase(text_norm: str, phrase_norm: str) -> bool:
    if not text_norm or not phrase_norm:
        return False
    return bool(re.search(rf"(?:^|\s){re.escape(phrase_norm)}(?:\s|$)", text_norm))


def _hierarchy_segments(value: str | None) -> list[str]:
    return [normalize(part) for part in (value or "").split(">") if normalize(part)]


def _common_prefix_len(left: list[str], right: list[str]) -> int:
    count = 0
    for a, b in zip(left, right):
        if a != b:
            break
        count += 1
    return count


def _row_to_region(row: sqlite3.Row) -> dict[str, Any]:
    figure_refs_raw = row["figure_refs"] if "figure_refs" in row.keys() else "[]"
    try:
        figure_refs = json.loads(figure_refs_raw or "[]")
    except Exception:
        figure_refs = []
    return {
        "id": int(row["id"]),
        "heading_id": int(row["heading_id"]),
        "book_id": row["book_id"] or FIRSTAID_BOOK_ID,
        "page": int(row["page"] or 1),
        "page_end": int(row["page_end"] or row["page"] or 1),
        "x0": float(row["x0"] or 0),
        "y0": float(row["y0"] or 0),
        "x1": float(row["x1"] or 0),
        "y1": float(row["y1"] or 0),
        "title": row["title"] or "",
        "hierarchy": row["hierarchy"] or "",
        "body_text": row["body_text"] or "",
        "figure_refs": figure_refs,
        "keywords": row["keywords"] or "",
        "edition": row["edition"] or FIRSTAID_EDITION,
        "href": row["href"] or _library_href(row["book_id"] or FIRSTAID_BOOK_ID, int(row["page"] or 1)),
        "rank": float(row["rank"]) if "rank" in row.keys() and row["rank"] is not None else 0.0,
    }


def _library_href(book_id: str, page: int) -> str:
    from urllib.parse import quote

    return f"/library?path={quote(book_id)}&page={max(1, int(page or 1))}"


@lru_cache(maxsize=512)
def search_regions(query: str, limit: int = 8) -> tuple[dict[str, Any], ...]:
    if not query.strip() or not FIRSTAID_INDEX_DB.exists():
        return ()

    query_variants = _query_variants(query)
    match_queries: list[tuple[str, str]] = []
    seen_matches: set[str] = set()
    for variant in query_variants:
        match = fts_query(variant)
        if match and match not in seen_matches:
            seen_matches.add(match)
            match_queries.append((variant, match))
    if not match_queries:
        return ()

    c = _conn()
    try:
        rows: list[sqlite3.Row] = []
        for variant, match in match_queries[:4]:
            exact = normalize(variant)
            prefix = f"{exact}%"
            rows.extend(c.execute(
                """
                SELECT r.*, bm25(firstaid_fts, 8.0, 2.5, 1.0, 7.0) AS rank
                FROM firstaid_fts
                JOIN firstaid_regions r ON r.id = firstaid_fts.rowid
                WHERE firstaid_fts MATCH ?
                ORDER BY
                  CASE
                    WHEN lower(r.title)=lower(?) THEN 0
                    WHEN lower(r.title) LIKE lower(?) THEN 1
                    ELSE 2
                  END,
                  rank ASC,
                  r.page ASC,
                  length(r.title) ASC
                LIMIT ?
                """,
                (match, variant.strip(), prefix, max(limit * 5, 40)),
            ).fetchall())
    except sqlite3.Error:
        like = f"%{query.strip()}%"
        rows = c.execute(
            """
            SELECT r.*, 0.0 AS rank
            FROM firstaid_regions r
            WHERE lower(r.title) LIKE lower(?)
               OR lower(r.hierarchy) LIKE lower(?)
               OR lower(r.body_text) LIKE lower(?)
               OR lower(r.keywords) LIKE lower(?)
            ORDER BY
              CASE
                WHEN lower(r.title)=lower(?) THEN 0
                WHEN lower(r.title) LIKE lower(?) THEN 1
                ELSE 2
              END,
              r.page ASC,
              length(r.title) ASC
            LIMIT ?
            """,
            (like, like, like, like, query.strip(), f"{query.strip()}%", max(limit * 3, 24)),
        ).fetchall()
    finally:
        c.close()

    regions = [_row_to_region(row) for row in rows]
    query_keys = [normalize(variant) for variant in query_variants if normalize(variant)]
    if not query_keys:
        return ()
    query_tokens = [tok for key in query_keys for tok in key.split() if tok]

    exact_anchors = [
        item for item in regions
        if normalize(item.get("title", "")) in query_keys
    ]
    exact_anchors.sort(key=lambda item: (
        int(item.get("page") or 999999),
        len(str(item.get("title") or "")),
    ))
    anchor_segments = _hierarchy_segments(exact_anchors[0].get("hierarchy")) if exact_anchors else []
    anchor_page = int(exact_anchors[0].get("page") or 0) if exact_anchors else 0

    def title_bucket(title_norm: str) -> int:
        if title_norm in query_keys:
            return 0
        if any(title_norm.startswith(f"{key} ") for key in query_keys):
            return 1
        if any(_contains_norm_phrase(title_norm, key) for key in query_keys):
            return 2
        return 5

    def coverage_bucket(item: dict[str, Any]) -> int:
        title_norm = normalize(item.get("title", ""))
        hierarchy_norm = normalize(item.get("hierarchy", ""))
        keywords_norm = normalize(item.get("keywords", ""))
        body_norm = normalize(item.get("body_text", ""))
        for haystack, bucket in (
            (title_norm, 0),
            (f"{title_norm} {hierarchy_norm}", 1),
            (f"{title_norm} {hierarchy_norm} {keywords_norm}", 2),
            (f"{title_norm} {hierarchy_norm} {keywords_norm} {body_norm}", 3),
        ):
            if all(token in haystack for token in query_tokens):
                return bucket
        return 4

    def anchor_bucket(item: dict[str, Any]) -> int:
        if not anchor_segments:
            return 0
        title_norm = normalize(item.get("title", ""))
        if title_norm in query_keys:
            return 0
        segments = _hierarchy_segments(item.get("hierarchy"))
        if any(segment in query_keys for segment in segments[:-1]):
            return 1
        if _common_prefix_len(anchor_segments, segments) >= 2:
            return 2
        page = int(item.get("page") or 0)
        if anchor_page and page and 0 <= page - anchor_page <= 12:
            return 3
        return 4

    def relation_bucket(item: dict[str, Any]) -> int:
        tb = title_bucket(normalize(item.get("title", "")))
        ab = anchor_bucket(item)
        if tb == 0:
            return 0
        if tb == 1:
            return 1
        if ab == 1:
            return 2
        if ab == 2 and tb <= 2:
            return 3
        if ab == 2:
            return 4
        if tb == 2:
            return 5
        if ab == 3:
            return 6
        return 7

    def score_key(item: dict[str, Any]) -> tuple[int, int, int, int, float, int, str]:
        title_norm = normalize(item.get("title", ""))
        return (
            relation_bucket(item),
            title_bucket(title_norm),
            coverage_bucket(item),
            len(title_norm),
            float(item.get("rank") or 0.0),
            int(item.get("page") or 999999),
            str(item.get("title") or "").lower(),
        )

    seen: set[int] = set()
    out: list[dict[str, Any]] = []
    for item in sorted(regions, key=score_key):
        hid = int(item["heading_id"])
        if hid in seen:
            continue
        seen.add(hid)
        out.append(item)
        if len(out) >= limit:
            break
    return tuple(out)


@lru_cache(maxsize=2048)
def get_region(heading_id: int, edition: str = FIRSTAID_EDITION) -> dict[str, Any] | None:
    if not FIRSTAID_INDEX_DB.exists():
        return None
    c = _conn()
    try:
        row = c.execute(
            """
            SELECT r.*, 0.0 AS rank
            FROM firstaid_regions r
            WHERE r.heading_id=? AND r.edition=?
            LIMIT 1
            """,
            (int(heading_id), edition),
        ).fetchone()
    finally:
        c.close()
    return _row_to_region(row) if row else None


def _scan_term_ok(term: str) -> bool:
    key = normalize(term)
    if not key or key in _GENERIC_SCAN_TERMS:
        return False
    tokens = key.split()
    if not tokens:
        return False
    if len(key) < 3 or len(key) > 90:
        return False
    if len(tokens) == 1 and len(tokens[0]) < 5 and not term.strip().isupper():
        return False
    if all(token in _GENERIC_SCAN_TERMS for token in tokens):
        return False
    return True


def _clean_region_title(term: str | None) -> str:
    return re.sub(r"^\d+\s+", "", term or "").strip()


def _parenthetical_term_ok(term: str) -> bool:
    key = normalize(term)
    tokens = key.split()
    if not tokens or key in _PARENTHETICAL_SINGLE_STOP:
        return False
    if len(tokens) == 1:
        raw = term.strip()
        return raw.isupper() and 2 <= len(key) <= 12 and _scan_term_ok(raw)
    return _scan_term_ok(term)


def _title_aliases(title: str, hierarchy: str | None) -> tuple[str, ...]:
    aliases = list(_FIRSTAID_TITLE_ALIASES.get(normalize(title), ()))
    hierarchy_key = normalize(hierarchy)
    if any(hint in hierarchy_key for hint in _MICROBIOLOGY_HINTS):
        match = re.match(r"^([A-Z][a-z]{3,})\s+([a-z][a-z-]{2,})(?:\b|$)", title)
        if match:
            genus, species = match.groups()
            aliases.append(f"{genus[0]}. {species}")
            aliases.append(f"{genus[0]} {species}")
    return tuple(dict.fromkeys(aliases))


def scan_terms_for_region(
    title: str | None,
    hierarchy: str | None = None,
    body_text: str | None = None,
    keywords: str | None = None,
) -> tuple[str, ...]:
    """Return the vetted scan/lookup terms for one First Aid indexed region."""
    del body_text, keywords

    terms: list[str] = []
    seen: set[str] = set()

    def add(term: str | None) -> None:
        clean = _clean_region_title(term)
        key = normalize(clean)
        if key in seen or not _scan_term_ok(clean):
            return
        seen.add(key)
        terms.append(clean)

    clean_title = _clean_region_title(title)
    add(clean_title)

    for parenthetical in re.findall(r"\(([^()]{2,30})\)", clean_title):
        if _parenthetical_term_ok(parenthetical):
            add(parenthetical)

    for alias in _title_aliases(clean_title, hierarchy):
        add(alias)

    return tuple(terms)


@lru_cache(maxsize=1)
def scan_entries() -> tuple[dict[str, str], ...]:
    if not FIRSTAID_INDEX_DB.exists():
        return ()
    c = _conn()
    try:
        rows = c.execute(
            """
            SELECT heading_id, title, hierarchy, body_text, keywords
            FROM firstaid_regions
            WHERE edition=? AND title != ''
            ORDER BY length(title) DESC, lower(title)
            """,
            (FIRSTAID_EDITION,),
        ).fetchall()
    finally:
        c.close()

    seen: set[str] = set()
    entries: list[dict[str, str]] = []
    for row in rows:
        for term in scan_terms_for_region(row["title"], row["hierarchy"], row["body_text"], row["keywords"]):
            key = normalize(term)
            if key in seen:
                continue
            seen.add(key)
            entries.append({"term": term, "source": "firstaid", "kind": "region"})
    return tuple(entries)


def resolve_pdf_path(region: dict[str, Any] | None = None) -> Path:
    candidates: list[Path] = [FIRSTAID_PDF]
    book_id = str((region or {}).get("book_id") or FIRSTAID_BOOK_ID)
    candidates.append((LIBRARY_PATH / book_id).resolve())

    if BOOK_CHAPTER_INDEX_DB.exists():
        try:
            c = sqlite3.connect(f"file:{BOOK_CHAPTER_INDEX_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                row = c.execute("SELECT path FROM books WHERE id=? LIMIT 1", (book_id,)).fetchone()
            finally:
                c.close()
            if row and row["path"]:
                candidates.append(Path(row["path"]))
        except Exception:
            pass

    for path in candidates:
        try:
            if path.exists() and path.is_file():
                return path
        except OSError:
            continue
    return candidates[0]


def snippet_cache_path(region: dict[str, Any], zoom: int) -> Path:
    zoom = max(1, min(4, int(zoom or 2)))
    coord = "_".join(f"{float(region[key]):.1f}" for key in ("x0", "y0", "x1", "y1"))
    digest = hashlib.sha1(coord.encode("ascii")).hexdigest()[:12]
    safe_edition = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(region.get("edition") or FIRSTAID_EDITION))
    return FA_SNIPPET_CACHE_DIR / f"h_{int(region['heading_id'])}_{safe_edition}_{digest}@{zoom}x.webp"


def page_cache_path(region: dict[str, Any], zoom: int) -> Path:
    zoom = max(1, min(4, int(zoom or 2)))
    page = int(region.get("page") or 1)
    book_id = str(region.get("book_id") or FIRSTAID_BOOK_ID)
    digest = hashlib.sha1(book_id.encode("utf-8", "ignore")).hexdigest()[:10]
    safe_edition = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(region.get("edition") or FIRSTAID_EDITION))
    return FA_SNIPPET_CACHE_DIR / f"p_{page}_{safe_edition}_{digest}@{zoom}x.webp"


def _highlight_terms(value: str | None) -> tuple[str, ...]:
    text = re.sub(r"^first aid:\s*", "", value or "", flags=re.I).strip()
    text = re.sub(r"\s+", " ", text)
    if not text:
        return ()

    generic = _GENERIC_SCAN_TERMS | {
        "aid", "disease", "disorder", "first", "page", "pages", "snippet", "snippets", "syndrome",
    }
    terms: list[str] = []

    def add(term: str) -> None:
        clean = re.sub(r"\s+", " ", term or "").strip(" -:;,.")
        key = normalize(clean)
        if not key or key in generic or clean.lower().startswith("fa 2026"):
            return
        tokens = key.split()
        if len(tokens) == 1 and len(tokens[0]) < 5 and not clean.isupper():
            return
        if all(token in generic for token in tokens):
            return
        if clean.lower() not in {item.lower() for item in terms}:
            terms.append(clean)

    add(text)
    text_without_parens = re.sub(r"\([^)]*\)", " ", text)
    if text_without_parens != text:
        add(text_without_parens)
    for token in re.findall(r"[A-Za-z][A-Za-z-]{3,}", text):
        add(token)
    return tuple(terms[:8])


def _highlight_cache_path(cache_path: Path, terms: tuple[str, ...]) -> Path:
    if not terms:
        return cache_path
    digest = hashlib.sha1("\n".join(normalize(term) for term in terms).encode("utf-8", "ignore")).hexdigest()[:12]
    return cache_path.with_name(f"{cache_path.stem}_hl_{digest}{cache_path.suffix}")


def _pixmap_to_image(pix: fitz.Pixmap):
    from PIL import Image

    mode = "RGBA" if pix.alpha else "RGB"
    image = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
    if image.mode == "RGBA":
        bg = Image.new("RGB", image.size, "white")
        bg.paste(image, mask=image.split()[-1])
        image = bg
    return image


def _save_pixmap(
    pix: fitz.Pixmap,
    cache_path: Path,
    *,
    page: fitz.Page | None = None,
    clip: fitz.Rect | None = None,
    zoom: int = 2,
    highlight_terms: tuple[str, ...] = (),
) -> None:
    try:
        from PIL import Image, ImageDraw

        image = _pixmap_to_image(pix)
        if page is not None and clip is not None and highlight_terms:
            overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
            seen_rects: set[tuple[int, int, int, int]] = set()
            for term in highlight_terms:
                try:
                    rects = page.search_for(term)
                except Exception:
                    rects = []
                for found in rects:
                    rect = fitz.Rect(found) & clip
                    if rect.is_empty or rect.width < 1 or rect.height < 1:
                        continue
                    x0 = max(0, int((rect.x0 - clip.x0) * zoom) - 2)
                    y0 = max(0, int((rect.y0 - clip.y0) * zoom) - 2)
                    x1 = min(image.width, int((rect.x1 - clip.x0) * zoom) + 2)
                    y1 = min(image.height, int((rect.y1 - clip.y0) * zoom) + 2)
                    if x1 <= x0 or y1 <= y0:
                        continue
                    key = (x0, y0, x1, y1)
                    if key in seen_rects:
                        continue
                    seen_rects.add(key)
                    draw.rounded_rectangle(key, radius=max(2, zoom * 2), fill=(255, 226, 76, 92), outline=(217, 119, 6, 120))
            if seen_rects:
                image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
        image.save(str(cache_path), "WEBP", quality=82, method=4)
    except ImportError:
        cache_path.write_bytes(pix.tobytes("png"))


def render_snippet_image(heading_id: int, zoom: int = 2, highlight: str | None = None) -> Path:
    region = get_region(int(heading_id))
    if not region:
        raise FileNotFoundError(f"First Aid heading {heading_id} is not indexed")

    zoom = max(1, min(4, int(zoom or 2)))
    terms = _highlight_terms(highlight)
    cache_path = _highlight_cache_path(snippet_cache_path(region, zoom), terms)
    if cache_path.exists():
        return cache_path

    pdf_path = resolve_pdf_path(region)
    if not pdf_path.exists():
        raise FileNotFoundError(f"First Aid PDF not found: {pdf_path}")

    FA_SNIPPET_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    try:
        page_num = max(0, min(int(region["page"]) - 1, doc.page_count - 1))
        page = doc.load_page(page_num)
        page_rect = page.rect
        rect = fitz.Rect(region["x0"], region["y0"], region["x1"], region["y1"])
        rect = rect & page_rect
        if rect.is_empty or rect.height < 8 or rect.width < 8:
            rect = page_rect
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False)
        _save_pixmap(pix, cache_path, page=page, clip=rect, zoom=zoom, highlight_terms=terms)
    finally:
        doc.close()

    return cache_path


def render_page_image(heading_id: int, zoom: int = 2, highlight: str | None = None) -> Path:
    region = get_region(int(heading_id))
    if not region:
        raise FileNotFoundError(f"First Aid heading {heading_id} is not indexed")

    zoom = max(1, min(4, int(zoom or 2)))
    terms = _highlight_terms(highlight)
    cache_path = _highlight_cache_path(page_cache_path(region, zoom), terms)
    if cache_path.exists():
        return cache_path

    pdf_path = resolve_pdf_path(region)
    if not pdf_path.exists():
        raise FileNotFoundError(f"First Aid PDF not found: {pdf_path}")

    FA_SNIPPET_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    try:
        page_num = max(0, min(int(region["page"]) - 1, doc.page_count - 1))
        page = doc.load_page(page_num)
        clip = page.rect
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
        _save_pixmap(pix, cache_path, page=page, clip=clip, zoom=zoom, highlight_terms=terms)
    finally:
        doc.close()

    return cache_path


def etag_for(path: Path) -> str:
    stat = path.stat()
    raw = f"{path}:{stat.st_mtime_ns}:{stat.st_size}"
    return '"' + hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()[:20] + '"'


def clear_caches() -> None:
    search_regions.cache_clear()
    get_region.cache_clear()
    scan_entries.cache_clear()

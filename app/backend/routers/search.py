"""
Unified search router — grouped, concept-aware results.

Endpoint: GET /search?q=CHF&scopes=all&grouped=true
Returns results grouped by source (UpToDate / AMBOSS / Books / Q-Bank),
with an optional definition chip from glossary.db at the top when the
query matches a known abbreviation or term.

Also exposes GET /search/related?source=amboss&id=<doc_id> which returns
parallel titles in other sources (used by RelatedRail).
"""
from __future__ import annotations

import difflib
import html
import json
import re
import sqlite3
import struct
from functools import lru_cache
from pathlib import Path
from typing import Optional
from urllib.parse import quote, unquote

from fastapi import APIRouter, HTTPException, Query

from config import (
    AMBOSS_DIR,
    ANATOMY_DEFS_PATH,
    CONCEPT_LINKS_DB,
    DRUG_REF_DB,
    GLOSSARY_DB,
    GLOBAL_SEARCH_DB as _GLOBAL_SEARCH_DB,
    HARRISONS_PATH,
    LEXI_DB_PATH,
    LEXI_CALC_DB,
    BOOK_CHAPTER_INDEX_DB,
    LIBRARY_INDEX_DB,
    ROOT,
    STEP1_DB_PATH,
    STEP2_DB_PATH,
    STEP3_DB_PATH,
    UWORLD_LIBRARY_DIR,
    UMLS_DB,
    UTD_DB_PATH,
)
import firstaid
import umls_reader
import book_priority
import packs

router = APIRouter(prefix="/search", tags=["search"])

# Endpoint-level result cache. Keyed by (q_lower, scopes, grouped, limit, fast).
# Repeated identical queries return instantly (sub-millisecond) regardless of
# how heavy the underlying FTS5 work was on the first call.
import collections
_UNIFIED_CACHE_MAX = 512
_unified_search_cache: "collections.OrderedDict[tuple, dict]" = collections.OrderedDict()

_SEARCH_PAGE_OFFSET_MAX = 500
_SEARCH_PAGE_LIMIT_MAX = 50
_SEARCH_PAGE_CANDIDATE_MAX = _SEARCH_PAGE_OFFSET_MAX + _SEARCH_PAGE_LIMIT_MAX + 1
_SEARCH_PAGE_FTS_LIMIT_MAX = _SEARCH_PAGE_CANDIDATE_MAX * 8

_SEARCH_PAGE_KIND_ALIASES: dict[str, frozenset[str] | None] = {
    "all": None,
    "article": frozenset({"article"}),
    "articles": frozenset({"article", "topic"}),
    "topic": frozenset({"topic"}),
    "book": frozenset({"book"}),
    "books": frozenset({"book", "chapter"}),
    "chapter": frozenset({"chapter"}),
    "region": frozenset({"region"}),
    "packet": frozenset({"packet"}),
    "image": frozenset({"clinic_image"}),
    "images": frozenset({"clinic_image"}),
    "clinic_image": frozenset({"clinic_image"}),
    "table": frozenset({"uworld_table"}),
    "tables": frozenset({"uworld_table"}),
    "uworld_table": frozenset({"uworld_table"}),
    "concept": frozenset({"concept", "disease", "finding", "pathology", "lab", "procedure", "anatomy", "chemical", "gene", "organism", "physiology", "cell", "device"}),
    "concepts": frozenset({"concept", "disease", "finding", "pathology", "lab", "procedure", "anatomy", "chemical", "gene", "organism", "physiology", "cell", "device"}),
    "drug": frozenset({"drug"}),
    "drugs": frozenset({"drug"}),
    "question": frozenset({"question"}),
    "questions": frozenset({"question"}),
    "calculator": frozenset({"calculator"}),
    "term": frozenset({"term"}),
    "structure": frozenset({"structure"}),
    "disease": frozenset({"disease"}),
    "finding": frozenset({"finding"}),
    "pathology": frozenset({"pathology"}),
    "lab": frozenset({"lab"}),
    "procedure": frozenset({"procedure"}),
    "anatomy": frozenset({"anatomy"}),
    "chemical": frozenset({"chemical"}),
    "gene": frozenset({"gene"}),
    "organism": frozenset({"organism"}),
    "physiology": frozenset({"physiology"}),
    "cell": frozenset({"cell"}),
    "device": frozenset({"device"}),
    "ddx": frozenset({"ddx"}),
    "phenotype_bundle": frozenset({"phenotype_bundle"}),
}

def _cache_get(key):
    if key in _unified_search_cache:
        _unified_search_cache.move_to_end(key)
        return _unified_search_cache[key]
    return None

def _cache_put(key, value):
    if key in _unified_search_cache:
        _unified_search_cache.move_to_end(key)
        return
    _unified_search_cache[key] = value
    if len(_unified_search_cache) > _UNIFIED_CACHE_MAX:
        _unified_search_cache.popitem(last=False)

# ── Text helpers (shared across the module) ────────────────────────────────

_MEDICAL_NORMALIZATION = {
    "haem": "hem", "haemo": "hemo", "anaemia": "anemia",
    "paediatric": "pediatric", "oesophagus": "esophagus",
    "foetus": "fetus", "diarrhoea": "diarrhea",
    "tumour": "tumor", "oedema": "edema", "leukaemia": "leukemia",
    "glycaemia": "glycemia", "glycaemic": "glycemic",
}

_DASHBOARD_SCOPE_ALIASES = {
    "all": "all", "uptodate": "uptodate", "utd": "uptodate", "amboss": "amboss",
    "books": "books", "anatomy": "anatomy", "calc": "calc",
    "calculators": "calc", "meds": "drugs", "diseases": "diseases",
    "disease": "diseases", "dx": "diseases",
    "drugs": "drugs", "drug": "drugs", "medications": "drugs",
    "lexi": "lexi", "lexicomp": "lexi", "databases": "all",
    "qbank": "qbank", "q-bank": "qbank",
    "firstaid": "firstaid", "first-aid": "firstaid", "fa": "firstaid",
    "uworld": "uworld", "uworld-library": "uworld", "uworldlib": "uworld",
    "uwlib": "uworld",
    "umls": "umls", "concepts": "umls", "concept": "umls",
    "sanford": "sanford", "sanfordguide": "sanford",
    "utdddx": "utdddx", "ddx": "utdddx",
}

_CALCULATOR_INDEX = [
    {"id": "egfr",       "title": "eGFR (CKD-EPI)",      "subtitle": "Renal function · drug dosing",  "href": "/calculators?q=eGFR",        "search_text": "egfr ckd epi kidney renal creatinine"},
    {"id": "creatinine", "title": "Creatinine Clearance", "subtitle": "Cockcroft-Gault",               "href": "/calculators?q=Creatinine+Clearance", "search_text": "creatinine clearance cockcroft gault renal dosing"},
    {"id": "meld-na",    "title": "MELD-Na",              "subtitle": "Liver disease severity",         "href": "/calculators?q=MELD",         "search_text": "meld na cirrhosis liver transplant"},
    {"id": "curb-65",    "title": "CURB-65",              "subtitle": "Pneumonia severity",             "href": "/calculators?q=CURB",         "search_text": "curb 65 pneumonia cap severity"},
    {"id": "bmi",        "title": "BMI",                  "subtitle": "Body mass index",                "href": "/calculators?q=BMI",          "search_text": "bmi body mass index obesity"},
    {"id": "chads-vasc", "title": "CHA₂DS₂-VASc",        "subtitle": "AF stroke risk",                 "href": "/calculators?q=CHA2DS2",      "search_text": "cha2ds2 vasc af atrial fibrillation stroke anticoagulation"},
    {"id": "wells-dvt",  "title": "Wells DVT",            "subtitle": "Pre-test probability",           "href": "/calculators?q=Wells+DVT",    "search_text": "wells dvt deep vein thrombosis pre-test"},
    {"id": "sofa",       "title": "SOFA Score",           "subtitle": "Organ failure · sepsis",         "href": "/calculators?q=SOFA",         "search_text": "sofa sequential organ failure sepsis icu"},
]

_ACRONYM_STOPWORDS = {"and", "of", "in", "to", "for", "the", "a", "an", "with"}
_UTD_PREF_RANK = {"X": 0, "A": 1, "P": 2, "I": 3}

_GROUP_MAP = {
    "uptodate": "utd", "utd": "utd", "amboss": "amboss",
    "firstaid": "firstaid", "uworld": "uworld", "books": "books", "calc": "calc", "qbank": "qbank",
    "abbrev": "abbrev", "drugs": "drugs", "lexi": "lexi",
    "anatomy": "anatomy", "diseases": "diseases", "umls": "umls",
    "sanford": "sanford", "utdddx": "utdddx",
}

_SOURCE_DIVERSITY_ORDER = [
    "umls", "sanford", "firstaid", "drugs", "utd", "amboss", "uworld", "utdddx", "books", "calc", "lexi", "anatomy", "diseases", "qbank"
]

_QBANK_DEFAULTS = {
    "step1": ROOT / "data" / "uworld" / "STEP-1-2026-march" / "uworldSTEP1-2026-march.db",
    "step2": ROOT / "data" / "uworld" / "STEP2-2026-march" / "uworldSTEP2-2026-march.db",
    "step3": ROOT / "data" / "uworld" / "STEP3-2026-march" / "uworldSTEP3-2026-march.db",
}
_CLINICCONS_REFERENCE_DB = ROOT / "data" / "cliniccons_disease_reference.sqlite"
_CONTENT_CONCEPTS_DB = ROOT / "data" / "content_concepts.sqlite"
_PARAGRAPH_CONCEPTS_DB = ROOT / "data" / "paragraph_concepts.sqlite"


def _uworld_library_db() -> Path | None:
    bundle = Path(UWORLD_LIBRARY_DIR) if UWORLD_LIBRARY_DIR else None
    if not bundle or not bundle.exists():
        data = ROOT / "data"
        bundle = next(
            (p for p in sorted(data.glob("uworld*library*")) if p.is_dir()),
            None,
        ) if data.exists() else None
    if not bundle:
        return None
    return next((p for p in sorted(bundle.glob("*.db"))), None)


def _norm_book_path(p: str | None) -> str:
    return (p or "").replace("\\", "/").strip().lower()


def _book_id_from_index_row(external_id: str | None, href: str | None) -> str:
    """Owning book's rel-path for a global-index book/chapter row.

    Whole-book rows carry the book path directly as `external_id`, but CHAPTER rows
    carry `chapter:<N>` — the book path lives only in the `/library?path=<path>&page=`
    href. The presence filter must resolve to the book path either way, otherwise
    every chapter result (i.e. nearly all book hits) is wrongly dropped."""
    eid = str(external_id or "")
    if eid and not eid.startswith("chapter:") and ("/" in eid or eid.lower().endswith(".pdf")):
        return eid
    m = re.search(r"[?&]path=([^&]+)", str(href or ""))
    if m:
        return unquote(m.group(1))
    return eid


@lru_cache(maxsize=4)
def _present_book_paths(sig: str) -> frozenset[str]:
    """Book ids (relative paths) currently in the live library. Keyed by the
    library index mtime so it refreshes when books are added/removed."""
    del sig
    if not LIBRARY_INDEX_DB.exists():
        return frozenset()
    c = sqlite3.connect(f"file:{LIBRARY_INDEX_DB}?mode=ro", uri=True)
    try:
        rows = c.execute("SELECT id FROM books").fetchall()
    finally:
        c.close()
    return frozenset(_norm_book_path(r[0]) for r in rows if r[0])


def _library_present_set() -> frozenset[str]:
    try:
        sig = str(LIBRARY_INDEX_DB.stat().st_mtime_ns)
    except OSError:
        sig = "0"
    return _present_book_paths(sig)


def _normalize(text: str) -> str:
    v = (text or "").lower()
    for src, dst in _MEDICAL_NORMALIZATION.items():
        v = v.replace(src, dst)
    v = re.sub(r"[^a-z0-9]+", " ", v)
    return re.sub(r"\s+", " ", v).strip()


# Textbook chapter headings are often prefixed with the chapter number
# ("379 Sarcoidosis", "286 ST-Segment Elevation Myocardial Infarction"). That
# prefix tanks title-relevance scoring vs. a cleanly-titled book, which is a big
# reason Harrison (whose outline numbers every chapter) ranked poorly. Strip a
# leading chapter number for relevance/sort/subject matching (not for display).
_CHAPTER_NUM_PREFIX_RE = re.compile(
    r"^\s*(?:chapter|chap|section|sect|part|unit)?\s*\d+(?:\.\d+)*\s+(?=\S)",
    re.IGNORECASE,
)


def _strip_chapter_number(title: str) -> str:
    cleaned = _CHAPTER_NUM_PREFIX_RE.sub("", title or "").strip()
    return cleaned or (title or "")


def _chapter_title_norm(title: str) -> str:
    return _normalize(_strip_chapter_number(title))


def _like_escape(text: str) -> str:
    return (text or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _prefix_upper_bound(text: str) -> str | None:
    if not text:
        return None
    return text[:-1] + chr(ord(text[-1]) + 1)


def _source_group(item: dict) -> str:
    return _GROUP_MAP.get(str(item.get("scope") or ""), str(item.get("scope") or ""))


def _book_authority_bonus(*parts: str) -> float:
    """Back-compat: priority bonus from a blob of book text (no folder context).

    Prefer _book_priority_bonus() with structured fields when available; this is
    kept for callers that only have free text. Delegates to the gold-standard
    registry (Harrison, Brenner, Braunwald, Robbins, ...).
    """
    return book_priority.bonus_for_text(" ".join(p for p in parts if p))


def _book_item_fields(item: dict) -> tuple[str, str, str]:
    """Extract (book-identity title, subject folder, book_id) from a book or
    chapter search result, for the gold-standard priority registry. Works for
    both the live grouped path (carries book_id) and the global-index path
    (book_id recovered from the /library?path= href)."""
    book_id = str(item.get("book_id") or "").replace("\\", "/").lstrip("/")
    if not book_id:
        m = re.search(r"[?&]path=([^&]+)", str(item.get("href") or ""))
        if m:
            book_id = unquote(m.group(1)).replace("\\", "/").lstrip("/")
        else:
            eid = str(item.get("id") or "")
            if eid and not eid.startswith("chapter:") and "/" in eid:
                book_id = eid.replace("\\", "/").lstrip("/")
    id_title = str(item.get("book_title") or item.get("title") or "")
    folder = book_id.split("/")[0] if "/" in book_id else str(item.get("folder") or "")
    return id_title, folder, book_id


def _book_priority_bonus(item: dict, query_subject: str = "") -> float:
    id_title, folder, book_id = _book_item_fields(item)
    return book_priority.tier_bonus(id_title, folder, book_id, query_subject)


def _infer_query_subject(qn: str, candidates: list[dict]) -> str:
    """High-confidence topic→specialty signal for book ranking.

    Counts strong title matches from the field's *clinical* gold-standard texts,
    weighted by match quality and capped per book, and returns a specialty only
    when one clearly dominates. Otherwise returns "" so Harrison (the general
    default) leads. This stays robust on cross-cutting topics: a lone off-topic
    chapter (a Surgery atlas's one "Myocardial Infarction" page) cannot outvote
    the specialty that actually owns the topic, basic-science encyclopedias
    (Robbins, Guyton) and non-standard books are ignored, and a genuinely
    multi-system topic (lupus, sarcoidosis) yields no winner → Harrison stays
    first."""
    if not qn:
        return ""
    qn_tokens = set(qn.split())
    votes: dict[str, float] = {}
    per_book: dict[str, int] = {}
    for item in candidates:
        if item.get("scope") != "books":
            continue
        # Cheap strong-title gate FIRST (no difflib, no registry lookup) so most
        # candidates are skipped before any expensive work.
        title_n = _chapter_title_norm(item.get("title") or "")
        if not title_n:
            continue
        if qn == title_n:
            bucket = 2
        elif qn in title_n or (qn_tokens and qn_tokens <= set(title_n.split())):
            bucket = 1
        else:
            continue
        id_title, folder, book_id = _book_item_fields(item)
        if per_book.get(book_id, 0) >= 5:
            continue
        entry = book_priority.classify(id_title, folder, book_id)
        if not entry or entry["tier"] != "gold":
            continue
        subject = book_priority.subject_of(id_title, folder, book_id)
        if book_priority.subject_specificity(subject) < 3:  # clinical specialties only
            continue
        per_book[book_id] = per_book.get(book_id, 0) + 1
        votes[subject] = votes.get(subject, 0.0) + 1.0 + bucket
    if not votes:
        return ""
    ranked = sorted(votes.items(), key=lambda kv: -kv[1])
    if len(ranked) == 1 or ranked[0][1] >= ranked[1][1] + 2.0:
        return ranked[0][0]
    return ""


def _simple_fts_query(query_norm: str) -> str:
    tokens = re.findall(r"[a-z0-9]+", query_norm or "")
    tokens = [tok for tok in tokens if len(tok) >= 2][:8]
    return " ".join(f"{tok}*" for tok in tokens)


def _has_meaningful_token_coverage(query_norm: str, text_norm: str) -> bool:
    tokens = [tok for tok in query_norm.split() if len(tok) >= 3]
    if len(tokens) <= 1:
        return True
    text_tokens = set(text_norm.split())
    hits = sum(1 for tok in tokens if tok in text_tokens or tok in text_norm)
    return hits >= max(2, len(tokens) - 1)


def _load_json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        data = json.loads(value)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _plain_preview_text(value: str | None) -> str:
    if not value:
        return ""
    text = re.sub(r"(?i)<br\s*/?>", " ", value)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _index_scope_allowed(scopes: set[str], source: str) -> bool:
    # Pack gate FIRST: a source whose pack isn't installed/green never surfaces,
    # regardless of what the caller asked for. This is the ONE seam content-pack
    # filtering uses — everything below (requested scopes) is unchanged from
    # before packs existed. See docs/ADDING_A_DATABASE.md "content packs" section.
    if not _source_pack_allowed(source):
        return False
    if "all" in scopes:
        return True
    alias = "uptodate" if source == "utd" else source
    return alias in scopes or source in scopes


def _source_pack_allowed(source: str) -> bool:
    try:
        installed = packs.installed_search_sources()
    except Exception:
        return True  # pack registry unavailable — fail open, never break search
    if not installed:
        return True  # no packs.py data yet (e.g. brand-new dev checkout) — fail open
    return source in installed


def _preview_from_json(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        data = json.loads(value)
    except Exception:
        return None
    return data if isinstance(data, dict) and data else None


def _display_suggestion(term: str | None) -> str | None:
    if not term:
        return None
    clean = term.strip()
    return clean[:1].upper() + clean[1:] if clean.islower() else clean


def _american_spelling_variant(value: str) -> str | None:
    """Return a common US-medical spelling variant for glossary expansions."""
    text = value or ""
    replacements = (
        ("Haem", "Hem"), ("haem", "hem"),
        ("Anaem", "Anem"), ("anaem", "anem"),
        ("Uraem", "Urem"), ("uraem", "urem"),
        ("Leukaem", "Leukem"), ("leukaem", "leukem"),
        ("Oesoph", "Esoph"), ("oesoph", "esoph"),
        ("Paed", "Ped"), ("paed", "ped"),
        ("Foet", "Fet"), ("foet", "fet"),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    return text if text != value else None


def _medical_query_variants(value: str) -> tuple[str, ...]:
    key = _normalize(value)
    variants: list[str] = []
    if re.search(r"\bdiabetic mellitus\b", key):
        variants.append(re.sub(r"\bdiabetic mellitus\b", "diabetes mellitus", key))
    return tuple(variants)


def _abbr_suggestion(query: str) -> str | None:
    suggestions = _abbr_suggestions(query, 1)
    return suggestions[0] if suggestions else None


def _looks_like_abbreviation_token(query: str) -> bool:
    compact = re.sub(r"[^A-Za-z0-9]", "", query or "")
    return bool(compact and 2 <= len(compact) <= 8 and " " not in (query or "").strip())


def _could_be_abbrev_query(query: str) -> bool:
    compact = re.sub(r"[^A-Za-z0-9]", "", query or "")
    if not compact or len(compact) < 2 or len(compact) > 6:
        return False
    return " " not in (query or "").strip()


def _allow_glossary_abbrev_scan(query: str) -> bool:
    clean = (query or "").strip()
    compact = re.sub(r"[^A-Za-z0-9]", "", clean)
    if not compact or " " in clean:
        return False
    if any(ch.isdigit() for ch in compact):
        return True
    letters = re.sub(r"[^A-Za-z]", "", compact)
    return len(compact) <= 3 or bool(letters and letters.upper() == letters)


def _phrase_acronym(value: str) -> str:
    stop = {"a", "an", "and", "for", "in", "of", "or", "the", "to", "with"}
    clean = re.sub(r"\([^)]*\)", " ", value or "")
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z-]*", clean) if w.lower() not in stop]
    return "".join(word[0].upper() for word in words[:8])


def _normal_abbr(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


_ABBR_SUGGESTION_SOURCES = ("glossary", "firstaid", "amboss", "utd", "drugs", "calc", "qbank", "lexi", "diseases")


def _abbr_suggestions_from_index(query: str, limit: int) -> list[str]:
    abbr = _normal_abbr(query)
    if not abbr or not _GLOBAL_SEARCH_DB.exists():
        return []
    # "glossary" isn't pack-gated (small always-shipped file); every other
    # source only contributes suggestions while its pack is green — same rule
    # as full search results, applied here so an abbreviation never points at
    # content the user hasn't downloaded.
    allowed_sources = tuple(
        s for s in _ABBR_SUGGESTION_SOURCES if s == "glossary" or _source_pack_allowed(s)
    )
    if not allowed_sources:
        return []
    try:
        c = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" for _ in allowed_sources)
            rows = c.execute(
                f"""
                SELECT expansion, source
                FROM abbr_suggestions
                WHERE abbr_norm=?
                  AND source IN ({placeholders})
                ORDER BY weight DESC, length(expansion), expansion
                LIMIT ?
                """,
                (abbr, *allowed_sources, max(limit, 1)),
            ).fetchall()
        finally:
            c.close()
    except sqlite3.Error:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        suggestion = _display_suggestion(row["expansion"]) or row["expansion"]
        key = _normalize(suggestion)
        if key and key not in seen:
            seen.add(key)
            out.append(suggestion)
    return out


@lru_cache(maxsize=1)
def _abbr_suggestion_map() -> dict[str, tuple[str, ...]]:
    if not GLOSSARY_DB.exists():
        return {}
    scored: dict[str, dict[str, tuple[int, int, str]]] = {}

    def add(abbr: str, value: str, score: int) -> None:
        abbr_norm = _normal_abbr(abbr)
        if not abbr_norm or not _could_be_abbrev_query(abbr_norm):
            return
        candidate = (value or "").strip()
        if not candidate or len(candidate) > 90:
            return
        candidate = re.sub(r"^patient perspective:\s*", "", candidate, flags=re.I).strip()
        candidate = re.sub(r"\s*\([A-Z0-9-]{2,8}\)\s*$", "", candidate).strip()
        candidate = re.sub(r"^calculator:\s*", "", candidate, flags=re.I).strip()
        us = _american_spelling_variant(candidate)
        if us:
            candidate = us
        key = _normalize(candidate)
        if not key or key == _normalize(abbr_norm):
            return
        bucket = scored.setdefault(abbr_norm, {})
        prev = bucket.get(key)
        item = (score, len(key), candidate)
        if not prev or item[0] > prev[0] or (item[0] == prev[0] and item[1] < prev[1]):
            bucket[key] = item

    try:
        c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT term, expansion, source_rank
                FROM glossary
                WHERE expansion != ''
                """
            ).fetchall()
        finally:
            c.close()
    except Exception:
        return {}

    for row in rows:
        term = row["term"] or ""
        expansion = row["expansion"] or ""
        rank_penalty = int(row["source_rank"] or 0) * 8
        if _looks_like_abbreviation_token(term):
            add(term, expansion, 240 - rank_penalty)
        term_acr = _phrase_acronym(term)
        if term_acr:
            add(term_acr, term, 210 - rank_penalty)
        expansion_acr = _phrase_acronym(expansion)
        if expansion_acr:
            add(expansion_acr, expansion, 190 - rank_penalty)

    out: dict[str, tuple[str, ...]] = {}
    for abbr, candidates in scored.items():
        ranked = sorted(candidates.values(), key=lambda item: (-item[0], item[1], item[2].lower()))
        out[abbr] = tuple((_display_suggestion(item[2]) or item[2]) for item in ranked[:8])
    return out


@lru_cache(maxsize=512)
def _abbr_suggestions(query: str, limit: int = 5) -> list[str]:
    q = (query or "").strip()
    if not q or not _could_be_abbrev_query(q):
        return []
    indexed = _abbr_suggestions_from_index(q, limit)
    if indexed:
        return indexed[:limit]
    if not _allow_glossary_abbrev_scan(q):
        return []
    if not GLOSSARY_DB.exists():
        return []
    cached = list(_abbr_suggestion_map().get(_normal_abbr(q), ()))
    if cached:
        return cached[:limit]
    q_upper = q.upper()
    seen: set[str] = {_normalize(q)}
    scored: list[tuple[int, int, str]] = []

    def add(value: str, score: int) -> None:
        candidate = (value or "").strip()
        if not candidate:
            return
        if candidate.lower().startswith("patient perspective: "):
            candidate = re.sub(r"^patient perspective:\s*", "", candidate, flags=re.I).strip()
        candidate = re.sub(r"\s*\([A-Z0-9-]{2,8}\)\s*$", "", candidate).strip()
        candidate = re.sub(r"^calculator:\s*", "", candidate, flags=re.I).strip()
        if len(candidate) > 80:
            return
        us = _american_spelling_variant(candidate)
        if us:
            candidate = us
        key = _normalize(candidate)
        if not key or key in seen or key == _normalize(q):
            return
        seen.add(key)
        scored.append((-score, len(key), candidate))

    try:
        c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            exact_rows = c.execute(
                """
                SELECT term, expansion, source_rank
                FROM glossary
                WHERE lower(term)=lower(?)
                   OR lower(term) LIKE lower(?)
                   OR lower(expansion) LIKE lower(?)
                ORDER BY source_rank ASC, length(expansion) ASC
                LIMIT 20
                """,
                (q, f"%({q})%", f"%({q})%"),
            ).fetchall()
            for row in exact_rows:
                add(row["expansion"] or row["term"], 240 - int(row["source_rank"] or 0) * 8)

            rows = c.execute(
                """
                SELECT term, expansion, source_rank
                FROM glossary
                WHERE expansion != ''
                  AND length(term) BETWEEN 4 AND 140
                ORDER BY source_rank ASC, length(term) ASC
                LIMIT 40000
                """
            ).fetchall()
        finally:
            c.close()
    except Exception:
        return []

    for row in rows:
        term = row["term"] or ""
        expansion = row["expansion"] or ""
        if _phrase_acronym(term) == q_upper:
            add(term, 210 - int(row["source_rank"] or 0) * 8)
        elif _phrase_acronym(expansion) == q_upper:
            add(expansion, 190 - int(row["source_rank"] or 0) * 8)
        if len(scored) >= limit * 8:
            break

    scored.sort()
    return [_display_suggestion(item[2]) or item[2] for item in scored[:limit]]


def _index_suggestion(qn: str, scopes: set[str]) -> str | None:
    if not qn or not _GLOBAL_SEARCH_DB.exists():
        return None
    try:
        c = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            if " " not in qn and len(qn) >= 2:
                exact_token = c.execute(
                    "SELECT 1 FROM suggestions WHERE term_norm=? LIMIT 1",
                    (qn,),
                ).fetchone()
                if exact_token:
                    return None
                token_rows = c.execute(
                    """
                    SELECT term
                    FROM suggestions
                    WHERE term_norm LIKE ?
                      AND term_norm != ?
                    ORDER BY length(term_norm), weight DESC, term
                    LIMIT 8
                    """,
                    (f"{_like_escape(qn)}%", qn),
                ).fetchall()
                if token_rows:
                    return _display_suggestion(token_rows[0]["term"])

            title_rows = c.execute(
                """
                SELECT title, source, weight
                FROM entries
                WHERE title_norm LIKE ?
                  AND title_norm != ?
                  AND title_norm NOT LIKE ?
                ORDER BY length(title_norm), weight DESC, title
                LIMIT 16
                """,
                (f"{_like_escape(qn)}%", qn, f"{_like_escape(qn)} %"),
            ).fetchall()
            for r in title_rows:
                if _index_scope_allowed(scopes, r["source"]):
                    return _display_suggestion(r["title"])
        finally:
            c.close()
    except Exception:
        return None
    return None


def _index_suggestions(qn: str, scopes: set[str], limit: int = 5) -> list[str]:
    if not qn or not _GLOBAL_SEARCH_DB.exists():
        return []
    upper = _prefix_upper_bound(qn)
    if not upper:
        return []
    out: list[str] = []
    seen: set[str] = {qn}

    def add(value: str | None) -> None:
        suggestion = _display_suggestion(value)
        key = _normalize(suggestion or "")
        if not suggestion or not key or key in seen:
            return
        seen.add(key)
        out.append(suggestion)

    try:
        c = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            for r in c.execute(
                """
                SELECT title, source, weight
                FROM entries
                WHERE title_norm >= ?
                  AND title_norm < ?
                  AND title_norm != ?
                ORDER BY
                  CASE source
                    WHEN 'firstaid' THEN 0
                    WHEN 'drugs' THEN 1
                    WHEN 'utd' THEN 2
                    WHEN 'amboss' THEN 3
                    ELSE 4
                  END,
                  length(title_norm),
                  weight DESC,
                  title
                LIMIT ?
                """,
                (qn, upper, qn, max(limit * 5, 25)),
            ).fetchall():
                if not _index_scope_allowed(scopes, r["source"]):
                    continue
                add(r["title"])
                if len(out) >= limit:
                    return out

            if len(qn) >= 2:
                for r in c.execute(
                    """
                    SELECT term, weight
                    FROM suggestions
                    WHERE term_norm >= ?
                      AND term_norm < ?
                      AND term_norm != ?
                    ORDER BY length(term_norm), weight DESC, term
                    LIMIT ?
                    """,
                    (qn, upper, qn, max(limit * 2, 10)),
                ).fetchall():
                    add(r["term"])
                    if len(out) >= limit:
                        return out
        finally:
            c.close()
    except Exception:
        return out
    return out


def _search_suggestions(query: str, qn: str, scopes: set[str], limit: int = 5, fast: bool = False) -> list[str]:
    out: list[str] = []
    seen: set[str] = {_normalize(query)}
    compact = re.sub(r"[^A-Za-z0-9]", "", query or "")
    code_like = _looks_like_code_query(query)
    abbr_first = _looks_like_abbreviation(query) or any(ch.isdigit() for ch in compact)
    # Fast (autocomplete) mode skips the cold UMLS lookup and the cold glossary
    # scan, but still surfaces abbreviation expansions via the warm in-index
    # abbr table — so "chf"/"fsgs" show their full forms instantly as you type.
    if code_like:
        abbr_values: tuple[str, ...] | list[str] = ()
    elif fast:
        abbr_values = _abbr_suggestions_from_index(query, limit)
    else:
        abbr_values = _abbr_suggestions(query, limit)
    umls_values = () if fast else _umls_expansions(query, limit)
    index_values = [] if code_like and umls_values else _index_suggestions(qn, scopes, limit)
    values = (
        [*abbr_values, *umls_values, *index_values]
        if abbr_first
        else [*index_values, *abbr_values, *umls_values]
    )
    for value in values:
        key = _normalize(value)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(value)
        if len(out) >= limit:
            break
    return out


_CLINICAL_DEF_GROUPS = {
    "disease", "finding", "pathology", "lab", "procedure", "anatomy",
    "chemical", "drug", "gene", "organism", "physiology", "cell", "device",
}


def _with_definition_expansion(suggestions: list[str], definition: dict | None, query: str) -> list[str]:
    """Lead the navigable suggestion list with the canonical abbreviation
    expansion (CHF → Congestive heart failure) — but ONLY when that expansion is
    a clinical concept. UMLS resolves some abbreviations to non-medical concepts
    (MI → "Michigan (geographic location)"); leading with those is worse than the
    medical candidates already in the list, so we skip them. The other candidate
    expansions stay so the user can arrow to a different one (UMLS noise)."""
    if not isinstance(definition, dict):
        return suggestions
    exp = str(definition.get("expansion") or "").strip()
    if not exp or _normalize(exp) == _normalize(query):
        return suggestions
    group = _normalize(definition.get("semantic_group") or "")
    is_clinical = bool(definition.get("icd10cm_codes")) or group in _CLINICAL_DEF_GROUPS
    if not is_clinical:
        return suggestions
    return [exp] + [s for s in suggestions if _normalize(s) != _normalize(exp)]


# Canonical clinical expansion for the most common medical abbreviations, where
# UMLS/glossary ranking otherwise buries the obvious one (MI → Mentzer index,
# not Myocardial infarction). The expansion leads the suggestion list so the
# user lands on it immediately; the other candidates stay below it.
_PREFERRED_ABBR = {
    "mi": "Myocardial infarction", "chf": "Congestive heart failure",
    "copd": "Chronic obstructive pulmonary disease", "dka": "Diabetic ketoacidosis",
    "aki": "Acute kidney injury", "ckd": "Chronic kidney disease",
    "gbs": "Guillain-Barré syndrome", "pe": "Pulmonary embolism",
    "dvt": "Deep vein thrombosis", "afib": "Atrial fibrillation",
    "htn": "Hypertension", "dm": "Diabetes mellitus", "t2dm": "Type 2 diabetes mellitus",
    "uti": "Urinary tract infection", "cad": "Coronary artery disease",
    "ards": "Acute respiratory distress syndrome", "sle": "Systemic lupus erythematosus",
    "ra": "Rheumatoid arthritis", "ibd": "Inflammatory bowel disease",
    "gerd": "Gastroesophageal reflux disease", "tb": "Tuberculosis",
    "fsgs": "Focal segmental glomerulosclerosis", "afl": "Atrial flutter",
    "sah": "Subarachnoid hemorrhage", "ich": "Intracerebral hemorrhage",
    "pud": "Peptic ulcer disease", "bph": "Benign prostatic hyperplasia",
    "cap": "Community-acquired pneumonia", "hf": "Heart failure",
    "pcos": "Polycystic ovary syndrome", "tia": "Transient ischemic attack",
}


def _prefer_known_abbreviation(suggestions: list[str], query: str) -> list[str]:
    pref = _PREFERRED_ABBR.get(_normalize(query))
    if not pref:
        return suggestions
    return [pref] + [s for s in suggestions if _normalize(s) != _normalize(pref)]


@lru_cache(maxsize=1024)
def _umls_expansions(query: str, limit: int = 6) -> tuple[str, ...]:
    if not UMLS_DB.exists():
        return ()
    try:
        return umls_reader.query_variants(query, limit=limit)
    except Exception:
        return ()


@lru_cache(maxsize=1024)
def _umls_search_concepts(query: str, limit: int = 8) -> tuple[dict, ...]:
    if not UMLS_DB.exists() or len(_normalize(query)) < 2:
        return ()
    try:
        return tuple(umls_reader.search(query, limit=max(1, min(limit, 16))))
    except Exception:
        return ()


def _umls_scope_enabled(scopes: set[str]) -> bool:
    return "all" in scopes or "umls" in scopes or "diseases" in scopes


def _query_umls_concepts(query: str, qn: str, limit: int = 8) -> list[dict]:
    if not UMLS_DB.exists() or len(qn) < 2:
        return []
    rows = _umls_search_concepts(query, limit=max(limit * 2, 10))
    out: list[dict] = []
    seen: set[str] = set()
    code_like = _looks_like_code_query(query)
    query_code_key = re.sub(r"[^A-Za-z0-9]", "", query or "").upper()
    for row in rows:
        matched_code = str(row.get("matched_code") or "").strip()
        if code_like:
            matched_code_key = re.sub(r"[^A-Za-z0-9]", "", matched_code).upper()
            if not matched_code_key or matched_code_key != query_code_key:
                continue
        cui = str(row.get("cui") or "")
        if not cui or cui in seen:
            continue
        seen.add(cui)
        title = str(row.get("preferred_name") or row.get("matched_term") or cui).strip()
        matched = str(row.get("matched_term") or "").strip()
        group = str(row.get("semantic_group") or "").strip()
        context = _umls_context_by_cui(cui) or {
            "cui": cui,
            "preferred_name": title,
            "semantic_group": group,
            "definition": row.get("definition") or title,
            "href": f"/umls?cui={cui}",
            "icd10cm_codes": [],
        }
        definition = str(context.get("definition") or row.get("definition") or title).strip()
        label_bits = ["UMLS"]
        if group:
            label_bits.append(group.title())
        source_label = str(row.get("matched_source_label") or row.get("source_label") or "").strip()
        if source_label:
            label_bits.append(source_label)
        if matched and _normalize(matched) != _normalize(title):
            label_bits.append(f"matched {matched}")
        search_text = " ".join(str(v or "") for v in (
            title,
            matched,
            matched_code,
            group,
            definition,
            cui,
        ))
        sc = float(row.get("score") or 0.0)
        title_n = _normalize(title)
        matched_n = _normalize(matched)
        if title_n == qn or matched_n == qn:
            sc += 620.0
        elif title_n.startswith(qn) or matched_n.startswith(qn):
            sc += 470.0
        elif qn in title_n or (matched_n and qn in matched_n):
            sc += 260.0
        if group in {"disease", "finding", "pathology"}:
            sc += 320.0
        elif group in {"lab", "procedure", "anatomy"}:
            sc += 120.0
        if code_like and matched_code:
            sc += 900.0
        out.append({
            "id": cui,
            "cui": cui,
            "title": title,
            "subtitle": " · ".join(label_bits),
            "href": f"/umls?cui={cui}",
            "scope": "umls",
            "kind": group or "concept",
            "search_text": search_text,
            "score": round(sc, 2),
            "umls": context,
            "icd10cm_codes": context.get("icd10cm_codes") or [],
        })
        if len(out) >= limit:
            break
    return out


def _search_concept_payload(value: dict | None) -> dict | None:
    if not isinstance(value, dict):
        return None
    nested = value.get("umls") if isinstance(value.get("umls"), dict) else {}
    cui = str(nested.get("cui") or value.get("cui") or value.get("id") or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", cui):
        return None
    preferred_name = str(
        nested.get("preferred_name") or value.get("preferred_name") or value.get("title") or cui
    ).strip()
    semantic_group = str(
        nested.get("semantic_group") or value.get("semantic_group") or value.get("kind") or "concept"
    ).strip().lower()
    return {
        "cui": cui,
        "preferred_name": preferred_name,
        "semantic_group": semantic_group,
        "href": f"/umls?cui={cui}",
    }


@lru_cache(maxsize=1024)
def _resolve_search_concept(query: str) -> dict | None:
    """Resolve one query for graph/media enrichment without enriching every card."""
    clean = re.sub(r"\s+", " ", query or "").strip()
    qn = _normalize(clean)
    if len(qn) < 2:
        return None

    lookup = _PREFERRED_ABBR.get(qn, clean)
    try:
        direct = _search_concept_payload(umls_reader.resolve(lookup))
    except Exception:
        direct = None
    if direct and direct["semantic_group"] in _CLINICAL_DEF_GROUPS:
        return direct

    try:
        ranked = _query_umls_concepts(lookup, _normalize(lookup), limit=6)
    except Exception:
        ranked = []
    candidates = [_search_concept_payload(item) for item in ranked]
    for candidate in candidates:
        if candidate and candidate["semantic_group"] in _CLINICAL_DEF_GROUPS:
            return candidate
    return direct


def _umls_definition_chip(term: str) -> Optional[dict]:
    if not UMLS_DB.exists():
        return None
    try:
        return umls_reader.definition_chip(term)
    except Exception:
        return None


def _phenotype_bundle_parts(query: str) -> tuple[str, ...]:
    text = re.sub(r"\s+", " ", query or "").strip()
    if not text or not re.search(r"[+,;]", text):
        return ()
    parts = [
        re.sub(r"^(?:and|with)\s+", "", part.strip(), flags=re.IGNORECASE)
        for part in re.split(r"\s*(?:\+|,|;)\s*", text)
    ]
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        key = _normalize(part)
        if not key or key in seen or len(part) > 80:
            continue
        seen.add(key)
        out.append(part)
    if 1 <= len(out) <= 8:
        return tuple(out)
    return ()


@lru_cache(maxsize=512)
def _resolve_phenotype_part(term: str) -> dict | None:
    if not UMLS_DB.exists():
        return None
    try:
        hit = umls_reader.resolve(term)
    except Exception:
        return None
    if not hit or not hit.get("cui"):
        return None
    group = str(hit.get("semantic_group") or "")
    source = str(hit.get("preferred_source") or "")
    if group not in {"finding", "disease", "pathology"} and source not in {"HPO", "OMIM", "ORPHANET"}:
        return None
    return {
        "cui": hit["cui"],
        "preferred_name": hit.get("preferred_name") or term,
        "semantic_group": group,
        "definition": hit.get("definition") or "",
        "href": f"/umls?cui={hit['cui']}",
        "icd10cm_codes": [],
    }


def _phenotype_bundle_action(query: str, include_conditions: bool = False) -> dict | None:
    parts = _phenotype_bundle_parts(query)
    if not parts:
        return None
    concepts = [_resolve_phenotype_part(part) for part in parts]
    if any(item is None for item in concepts):
        return None
    resolved = [item for item in concepts if item]
    if len(resolved) < 1:
        return None
    names = [str(item.get("preferred_name") or "").strip() for item in resolved]
    href = "/differential?p=" + "%7C".join(quote(name, safe="") for name in names if name)
    cui_label = ", ".join(str(item.get("cui") or "") for item in resolved[:4] if item.get("cui"))
    top_conditions: list[str] = []
    next_findings: list[str] = []
    if include_conditions:
        try:
            preview = umls_reader.phenotype_differential_preview(names, limit=3)
            top_conditions = [
                str(row.get("preferred_name") or "").strip()
                for row in preview.get("results", [])
                if row.get("preferred_name")
            ][:3]
        except Exception:
            top_conditions = []
        try:
            suggestions = umls_reader.phenotype_cofinding_suggestions(names, limit=4)
            next_findings = [
                str(row.get("preferred_name") or "").strip()
                for row in suggestions.get("suggestions", [])
                if row.get("preferred_name")
            ][:4]
        except Exception:
            next_findings = []
    subtitle_bits = [f"{len(resolved)} UMLS/HPO finding" + ("" if len(resolved) == 1 else "s")]
    if top_conditions:
        subtitle_bits.append("Top: " + "; ".join(top_conditions))
    else:
        subtitle_bits.append("IC-weighted disease ranking")
    if next_findings:
        subtitle_bits.append("Try adding: " + ", ".join(next_findings))
    if cui_label:
        subtitle_bits.append(cui_label)
    title_prefix = "HPO differential" if len(resolved) == 1 else "Run HPO differential"
    return {
        "id": "phenotype:" + "|".join(str(item.get("cui") or "") for item in resolved),
        "title": f"{title_prefix}: " + " + ".join([*names, "..."] if len(resolved) == 1 else names),
        "subtitle": " · ".join(subtitle_bits),
        "href": href,
        "scope": "differential",
        "kind": "phenotype_bundle",
        "search_text": " ".join([query, *names, *top_conditions, *next_findings, "phenotype hpo differential diagnosis"]),
        "score": 9999.0,
    }


@lru_cache(maxsize=8192)
def _content_concept_cui(source: str, source_id: str) -> str:
    if not _CONTENT_CONCEPTS_DB.exists() or not source or not source_id:
        return ""
    src = "utd" if source == "uptodate" else source
    try:
        c = sqlite3.connect(f"file:{_CONTENT_CONCEPTS_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            row = c.execute(
                """
                SELECT cui
                FROM content_concepts
                WHERE source=? AND source_id=?
                ORDER BY confidence DESC
                LIMIT 1
                """,
                (src, str(source_id)),
            ).fetchone()
        finally:
            c.close()
    except sqlite3.Error:
        return ""
    return str(row["cui"] or "") if row else ""


@lru_cache(maxsize=8192)
def _umls_context_by_cui(cui: str) -> dict | None:
    try:
        return umls_reader.concept_context_for_cui(cui)
    except Exception:
        return None


@lru_cache(maxsize=8192)
def _umls_context_by_title(title: str) -> dict | None:
    try:
        return umls_reader.concept_context(title)
    except Exception:
        return None


def _umls_context_for_result(item: dict) -> dict | None:
    if not UMLS_DB.exists():
        return None
    source = str(item.get("scope") or "")
    if source == "differential":
        return None
    source_id = str(item.get("id") or "")
    cui = str(item.get("cui") or "") or _content_concept_cui(source, source_id)
    context = _umls_context_by_cui(cui) if cui else None
    if context:
        if context.get("icd10cm_codes"):
            return context
    title = re.sub(r"^first aid:\s*", "", str(item.get("title") or ""), flags=re.IGNORECASE).strip()
    title_context = _umls_context_by_title(title) if title else None
    if title_context and (title_context.get("icd10cm_codes") or not context):
        return title_context
    return context


def _with_umls_context(item: dict) -> dict:
    context = item.get("umls") or _umls_context_for_result(item)
    if not context:
        return item
    codes = context.get("icd10cm_codes") or []
    return {
        **item,
        "umls": context,
        "icd10cm_codes": codes,
    }


def _result_payload(item: dict, with_umls: bool = True) -> dict:
    # The UMLS context enrichment (ICD-10 codes per result) is a per-result
    # database lookup and the dominant cost of a cold query. Skip it in fast
    # (autocomplete) mode — the follow-up full search adds it back.
    enriched = _with_umls_context(item) if with_umls else item
    out = {
        "id": enriched["id"],
        "title": enriched["title"],
        "subtitle": enriched["subtitle"],
        "href": enriched["href"],
        "scope": enriched["scope"],
        "kind": enriched["kind"],
        "score": enriched["score"],
    }
    if enriched.get("preview"):
        out["preview"] = enriched["preview"]
    if enriched.get("firstaid_refs"):
        out["firstaid_refs"] = enriched["firstaid_refs"]
    if enriched.get("umls"):
        out["umls"] = enriched["umls"]
        out["icd10cm_codes"] = enriched.get("icd10cm_codes") or []
    return out


def _query_global_index(
    query: str,
    qn: str,
    scopes: set[str],
    limit: int,
    fast: bool = False,
    *,
    page: bool = False,
    candidate_window: int | None = None,
    kinds: set[str] | None = None,
) -> list[dict] | None:
    if not qn or not _GLOBAL_SEARCH_DB.exists():
        return None
    # Fast (autocomplete) mode uses only cheap in-memory query variants and skips
    # the glossary/UMLS expansion, whose cold database lookups dominate latency.
    if fast:
        variants = [query, *_medical_query_variants(query)]
    else:
        variants = _query_variants(query)
    variant_norms: list[str] = []
    for variant in variants:
        vn = _normalize(variant)
        if vn and vn not in variant_norms:
            variant_norms.append(vn)
    if qn not in variant_norms:
        variant_norms.insert(0, qn)
    if len(variant_norms) > 1 and _looks_like_abbreviation(query):
        variant_norms = [vn for vn in variant_norms if vn != qn] + [qn]
    match_queries = [(vn, _simple_fts_query(vn)) for vn in variant_norms]
    match_queries = [(vn, mq) for vn, mq in match_queries if mq]
    if not match_queries:
        return []

    ranking_limit = limit
    page_index_sources: set[str] | None = None
    page_index_kinds: set[str] | None = None
    if page:
        ranking_limit = max(1, min(candidate_window or limit, _SEARCH_PAGE_CANDIDATE_MAX))
        page_index_sources = _page_index_sources(scopes)
        page_index_kinds = set(kinds) if kinds is not None else None
        if page_index_kinds is not None and "packet" in page_index_kinds:
            page_index_kinds.add("region")
    fetch_limit = _SEARCH_PAGE_FTS_LIMIT_MAX if page else max(limit * 8, 120)
    row_packets: list[tuple[sqlite3.Row, str, int]] = []
    try:
        c = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            for variant_index, (variant_norm, match_query) in enumerate(match_queries[:4]):
                if page:
                    predicates = ["entries_fts MATCH ?"]
                    parameters: list[object] = [match_query]
                    if page_index_sources is not None:
                        placeholders = ",".join("?" for _ in page_index_sources)
                        predicates.append(f"e.source IN ({placeholders})")
                        parameters.extend(sorted(page_index_sources))
                    if page_index_kinds is not None:
                        placeholders = ",".join("?" for _ in page_index_kinds)
                        predicates.append(f"e.kind IN ({placeholders})")
                        parameters.extend(sorted(page_index_kinds))
                    parameters.append(fetch_limit)
                    rows = c.execute(
                        f"""
                        SELECT e.*, bm25(entries_fts, 8.0, 2.5, 1.0) AS fts_rank
                        FROM entries_fts
                        JOIN entries e ON e.id = entries_fts.rowid
                        WHERE {' AND '.join(predicates)}
                        ORDER BY fts_rank, e.id
                        LIMIT ?
                        """,
                        parameters,
                    ).fetchall()
                else:
                    rows = c.execute(
                        """
                        SELECT e.*, bm25(entries_fts, 8.0, 2.5, 1.0) AS fts_rank
                        FROM entries_fts
                        JOIN entries e ON e.id = entries_fts.rowid
                        WHERE entries_fts MATCH ?
                        ORDER BY fts_rank
                        LIMIT ?
                        """,
                        (match_query, fetch_limit),
                    ).fetchall()
                row_packets.extend((row, variant_norm, variant_index) for row in rows)
        finally:
            c.close()
    except sqlite3.Error:
        return None

    ranked: list[dict] = []
    exact = qn
    q_tokens = [tok for tok in qn.split() if tok]
    present_books = _library_present_set()
    seen_entry_keys: set[tuple[str, str, str]] = set()
    for r, matched_norm, variant_index in row_packets:
        source = r["source"]
        if not _index_scope_allowed(scopes, source):
            continue
        allowed_kinds = page_index_kinds if page else kinds
        if allowed_kinds is not None and str(r["kind"] or "") not in allowed_kinds:
            continue
        # Only surface books that are actually present in the library folder, so a
        # stale index can never offer a book the user has offloaded/removed. Resolve
        # to the OWNING book path (chapter rows carry 'chapter:N', not the book path).
        if source == "books" and present_books and _norm_book_path(_book_id_from_index_row(r["external_id"], r["href"])) not in present_books:
            continue
        entry_key = (str(source), str(r["kind"] or ""), str(r["external_id"] or r["title"] or ""))
        if entry_key in seen_entry_keys:
            continue
        seen_entry_keys.add(entry_key)
        # Book chapter titles carry a chapter-number prefix that hurts relevance;
        # strip it for scoring so "379 Sarcoidosis" matches "sarcoidosis" cleanly.
        title_n = _chapter_title_norm(r["title"] or "") if source == "books" else _normalize(r["title"] or "")
        text_n = _normalize(" ".join(str(r[k] or "") for k in ("title", "subtitle", "search_text")))
        effective_qn = matched_norm or qn
        effective_tokens = [tok for tok in effective_qn.split() if tok]
        token_prefix_hit = all(
            any(tt == qt or tt.startswith(qt) for tt in text_n.split())
            for qt in effective_tokens
        ) if effective_tokens else True
        if not token_prefix_hit and len(effective_tokens) > 1:
            continue

        sc = float(r["weight"] or 0.0)
        sc += max(_score(qn, title_n), _score(effective_qn, title_n) + (35.0 if variant_index else 0.0)) * 1.8
        sc += max(_score(qn, text_n), _score(effective_qn, text_n) + (25.0 if variant_index else 0.0)) * 0.45
        if title_n == exact or title_n == effective_qn:
            sc += 320.0
        elif title_n.startswith(exact) or title_n.startswith(effective_qn):
            sc += 180.0
            sc += max(0.0, 90.0 - (len(title_n) - len(effective_qn)) * 4.0)
        elif exact in title_n or effective_qn in title_n:
            sc += 80.0
        if len(q_tokens) == 1 and title_n.startswith(q_tokens[0]):
            sc += max(0.0, 70.0 - (len(title_n) - len(q_tokens[0])) * 3.0)
        sc -= min(abs(float(r["fts_rank"] or 0.0)) * 4.0, 80.0)
        if source == "firstaid":
            sc += 430.0
            if title_n == exact:
                sc += 220.0
            elif title_n.startswith(exact):
                sc += 150.0
        elif source == "uworld":
            sc += 185.0
        if r["kind"] == "question":
            sc -= 180.0
        elif r["kind"] == "uworld_table":
            sc += 40.0
        elif r["kind"] == "clinic_image":
            sc += 30.0

        item = {
            "id": r["external_id"],
            "title": r["title"],
            "subtitle": r["subtitle"],
            "href": r["href"],
            "scope": source,
            "kind": r["kind"],
            "search_text": r["search_text"],
            "score": round(sc, 2),
        }
        preview = _preview_from_json(r["preview_json"])
        if preview:
            item["preview"] = preview
        ranked.append(item)

    if _index_scope_allowed(scopes, "firstaid") and (
        kinds is None or bool({"region", "packet"} & kinds)
    ):
        existing_firstaid_ids = {
            str(item.get("id"))
            for item in ranked
            if item.get("scope") == "firstaid"
        }
        for variant_norm in variant_norms[:4]:
            region_limit = 16 if page else min(max(limit, 8), 16)
            for region in firstaid.search_regions(variant_norm or query, region_limit):
                heading_id = str(region["heading_id"])
                if heading_id in existing_firstaid_ids:
                    continue
                existing_firstaid_ids.add(heading_id)
                title_n = _normalize(region.get("title") or "")
                body_n = _normalize(region.get("body_text") or "")
                sc = 1500.0 + max(_score(qn, title_n), _score(variant_norm, title_n) + 20.0) * 2.2
                sc += max(_score(qn, body_n), _score(variant_norm, body_n)) * 0.35
                if title_n == exact or title_n == variant_norm:
                    sc += 420.0
                elif title_n.startswith(exact) or title_n.startswith(variant_norm):
                    sc += 260.0
                page = int(region.get("page") or 1)
                ranked.append({
                    "id": heading_id,
                    "title": region.get("title") or "",
                    "subtitle": f"FA {region.get('edition') or '2026'} · p. {page}",
                    "href": f"#firstaid-{heading_id}",
                    "scope": "firstaid",
                    "kind": "region",
                    "search_text": " ".join(str(v or "") for v in (
                        region.get("title"),
                        region.get("hierarchy"),
                        region.get("body_text"),
                    )),
                    "heading_id": int(region["heading_id"]),
                    "page": page,
                    "hierarchy": region.get("hierarchy") or "",
                    "score": round(sc, 2),
                })

    # Gold-standard priority for book results in the fast (global-index) path,
    # mirroring the grouped path: Harrison leads most topics, and the specialty
    # standard (Brenner for kidney) surges past it for a topic its field owns.
    book_subject = _infer_query_subject(qn, ranked)
    for item in ranked:
        if item.get("scope") == "books":
            item["score"] = round(float(item.get("score") or 0) + _book_priority_bonus(item, book_subject), 2)

    ranked.sort(key=lambda item: (-float(item.get("score") or 0), item["title"].lower()))
    deduped: list[dict] = []
    seen_qbank_titles: set[tuple[str, str]] = set()
    for item in ranked:
        if item.get("scope") == "qbank":
            key = (str(item.get("kind") or ""), _normalize(item.get("title", "")))
            if key in seen_qbank_titles:
                continue
            seen_qbank_titles.add(key)
        deduped.append(item)
    if page:
        return _rank_page_results(deduped, query, qn, ranking_limit)
    return _rank_flat_results(deduped, query, qn, limit)


def _scope_set(raw: str) -> set[str]:
    parts = {
        _DASHBOARD_SCOPE_ALIASES.get(s.strip().lower(), "")
        for s in (raw or "all").split(",")
    }
    parts.discard("")
    return parts or {"all"}


def _validated_page_scopes(raw: str) -> set[str]:
    tokens = [value.strip().lower() for value in (raw or "all").split(",") if value.strip()]
    unknown = sorted({value for value in tokens if value not in _DASHBOARD_SCOPE_ALIASES})
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown search scope: {unknown[0]}")
    scopes = {_DASHBOARD_SCOPE_ALIASES[value] for value in tokens} if tokens else {"all"}
    return {"all"} if "all" in scopes else scopes


def _page_index_sources(scopes: set[str]) -> set[str] | None:
    if "all" in scopes:
        return None
    return {"utd" if scope == "uptodate" else scope for scope in scopes}


def _validated_page_kinds(raw: str) -> set[str] | None:
    tokens = [value.strip().lower() for value in (raw or "all").split(",") if value.strip()]
    unknown = sorted({value for value in tokens if value not in _SEARCH_PAGE_KIND_ALIASES})
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown search kind: {unknown[0]}")
    if not tokens or "all" in tokens:
        return None
    kinds: set[str] = set()
    for value in tokens:
        kinds.update(_SEARCH_PAGE_KIND_ALIASES[value] or ())
    return kinds


def _enabled(scopes: set[str], scope: str) -> bool:
    return "all" in scopes or scope in scopes


def _score(query_norm: str, text_norm: str) -> float:
    if not query_norm or not text_norm:
        return 0.0
    s = 0.0
    if query_norm == text_norm:          s += 140.0
    if text_norm.startswith(query_norm): s += 50.0
    if query_norm in text_norm:          s += 65.0
    q_toks = query_norm.split()
    t_toks = set(text_norm.split())
    hits = sum(1 for t in q_toks if t in t_toks)
    s += hits * 18.0
    if q_toks and hits == len(q_toks):
        s += 16.0
    s += difflib.SequenceMatcher(None, query_norm, text_norm).ratio() * 45.0
    return s


def _looks_like_abbreviation(term: str) -> bool:
    clean = (term or "").strip()
    compact = re.sub(r"[^A-Za-z0-9]", "", clean)
    if not compact or len(compact) > 12:
        return False
    letters = re.sub(r"[^A-Za-z]", "", compact)
    if not letters:
        return any(ch.isdigit() for ch in compact)
    return letters.upper() == letters and len(letters) <= 8


def _looks_like_code_query(term: str) -> bool:
    clean = (term or "").strip()
    compact = re.sub(r"[^A-Za-z0-9]", "", clean)
    if not compact or len(compact) > 16 or re.search(r"\s", clean):
        return False
    return any(ch.isdigit() for ch in compact)


def _decode_utd_topic_hits(blob: bytes | None, max_topics: int = 80) -> list[int]:
    """Decode UpToDate's query_topic.topic_hits blob into topic IDs.

    The blob starts with a two-byte count, followed by four-byte big-endian
    topic IDs. Some bundles include extra trailing values; callers dedupe and
    verify against the topic table before returning rows.
    """
    if not blob or len(blob) < 6:
        return []
    count = int.from_bytes(blob[:2], "big", signed=False)
    ids: list[int] = []
    upper = min(len(blob), 2 + (min(count, max_topics) * 4))
    for i in range(2, upper, 4):
        if i + 4 > len(blob):
            break
        tid = struct.unpack(">I", blob[i:i + 4])[0]
        if tid > 0:
            ids.append(tid)
    return ids


@lru_cache(maxsize=512)
def _glossary_expansions(q: str, limit: int = 6) -> list[str]:
    """Return useful hidden query expansions from glossary.db.

    Exact abbreviation matches are preferred. Prefix matches are allowed only
    when they look like real searchable medical terms, so the glossary can
    complete "hypocal" to "Hypocalcemia" without exposing glossary-only rows.
    """
    query = q.strip()
    if not query or not GLOSSARY_DB.exists():
        return []
    query_is_abbrev = _looks_like_abbreviation(query)
    out: list[str] = []
    seen: set[str] = {_normalize(query)}
    try:
        c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT term, expansion, source_rank
                FROM glossary
                WHERE (
                    lower(term)=lower(?)
                    OR lower(term) LIKE lower(?)
                    OR lower(expansion) LIKE lower(?)
                )
                  AND expansion != ''
                ORDER BY
                  CASE WHEN lower(term)=lower(?) THEN 0 ELSE 1 END,
                  source_rank ASC,
                  length(expansion) ASC
                LIMIT ?
                """,
                (query, f"{query}%", f"{query}%", query, limit * 4),
            ).fetchall()
        finally:
            c.close()
    except Exception:
        return []

    for r in rows:
        term = (r["term"] or "").strip()
        expansion = (r["expansion"] or "").strip()
        if not expansion:
            continue
        exact_abbrev = term.lower() == query.lower() and _looks_like_abbreviation(term)
        query_norm = _normalize(query)
        prefix_term = len(query_norm) >= 6 and " " not in query_norm and _normalize(expansion).startswith(query_norm)
        if not exact_abbrev and not prefix_term:
            continue
        key = _normalize(expansion)
        if key and key not in seen:
            seen.add(key)
            out.append(expansion)
        if not query_is_abbrev and out:
            break
        if len(out) >= limit:
            break
    return out


def _query_variants(query: str) -> list[str]:
    variants = [query]
    seen = {_normalize(query)}
    for variant in _medical_query_variants(query):
        key = _normalize(variant)
        if key and key not in seen:
            seen.add(key)
            variants.append(variant)
    if _looks_like_code_query(query):
        expansions = []
    else:
        abbr_expansions = _abbr_suggestions(query)
        expansions = abbr_expansions if abbr_expansions else _glossary_expansions(query)
    for expansion in expansions:
        pieces = [expansion]
        if "/" in expansion:
            m = re.match(r"^([^/\s]+)/([^/\s]+)(\s+.+)$", expansion)
            if m:
                left, right, rest = m.groups()
                pieces.extend([f"{left}{rest}", f"{right}{rest}"])
        expanded_pieces = list(pieces)
        for piece in pieces:
            us_piece = _american_spelling_variant(piece)
            if us_piece:
                expanded_pieces.append(us_piece)
        for piece in expanded_pieces:
            key = _normalize(piece)
            if key and key not in seen:
                seen.add(key)
                variants.append(piece)
    for expansion in _umls_expansions(query, 6):
        key = _normalize(expansion)
        if key and key not in seen:
            seen.add(key)
            variants.append(expansion)
    if len(_normalize(query)) >= 3 and not _looks_like_code_query(query):
        for concept in _umls_search_concepts(query, 5):
            for value in (concept.get("preferred_name"), concept.get("matched_term")):
                text = str(value or "").strip()
                key = _normalize(text)
                if key and key not in seen and len(key.split()) <= 8:
                    seen.add(key)
                    variants.append(text)
    return variants


# ── Source queries ─────────────────────────────────────────────────────────

@lru_cache(maxsize=512)
def _query_amboss(q: str, qn: str, limit: int) -> list[dict]:
    if not AMBOSS_DIR:
        return []
    db = AMBOSS_DIR / "amboss-2025.db"
    if not db.exists():
        return []
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        seen: set[int] = set()
        seen_titles: set[str] = set()
        out: list[dict] = []
        escaped = _like_escape(q.strip())
        for pat in (f"{escaped}%", f"%{escaped}%"):
            rows = c.execute(
                "SELECT id, title FROM Docs WHERE title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?",
                (pat, limit * 2),
            ).fetchall()
            for r in rows:
                rid = int(r["id"])
                title = (r["title"] or "").strip()
                title_key = _normalize(title)
                if rid in seen or not title or title_key in seen_titles:
                    continue
                seen.add(rid)
                seen_titles.add(title_key)
                out.append({"id": rid, "title": title, "subtitle": "AMBOSS article",
                             "href": f"/amboss?doc={rid}", "scope": "amboss", "kind": "article",
                             "search_text": title})
                if len(out) >= limit:
                    return out

        toc_rows = c.execute(
            """
            SELECT id, name, docId
            FROM TOC
            WHERE docId > 0 AND name LIKE ? ESCAPE '\\'
            ORDER BY name
            LIMIT ?
            """,
            (f"{escaped}%", max(4, limit // 2)),
        ).fetchall()
        for r in toc_rows:
            doc_id = int(r["docId"])
            title = (r["name"] or "").strip()
            title_key = _normalize(title)
            if doc_id in seen or not title or title_key in seen_titles:
                continue
            seen.add(doc_id)
            seen_titles.add(title_key)
            out.append({
                "id": f"toc:{int(r['id'])}",
                "title": title,
                "subtitle": "AMBOSS chapter",
                "href": f"/amboss?doc={doc_id}",
                "scope": "amboss",
                "kind": "chapter",
                "search_text": title,
            })
            if len(out) >= limit:
                return out
        return out
    finally:
        c.close()


@lru_cache(maxsize=512)
def _query_uworld_library(q: str, qn: str, limit: int) -> list[dict]:
    db = _uworld_library_db()
    if not db or not db.exists():
        return []
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        seen: set[str] = set()
        out: list[dict] = []
        escaped = _like_escape(q.strip())
        for pat in (f"{escaped}%", f"%{escaped}%"):
            rows = c.execute(
                "SELECT id, title FROM Docs WHERE title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?",
                (pat, limit * 2),
            ).fetchall()
            for r in rows:
                doc_id = int(r["id"])
                title = (r["title"] or "").strip()
                title_key = _normalize(title)
                if not title or title_key in seen:
                    continue
                seen.add(title_key)
                out.append({
                    "id": doc_id,
                    "title": title,
                    "subtitle": "UWorld article",
                    "href": f"/library/uworld?doc={doc_id}",
                    "scope": "uworld",
                    "kind": "article",
                    "search_text": title,
                })
                if len(out) >= limit:
                    return out

        toc_rows = c.execute(
            """
            SELECT id, name, docId
            FROM TOC
            WHERE leaf=1 AND docId >= 0 AND name LIKE ? ESCAPE '\\'
            ORDER BY name
            LIMIT ?
            """,
            (f"{escaped}%", max(4, limit // 2)),
        ).fetchall()
        for r in toc_rows:
            doc_id = int(r["docId"])
            title = (r["name"] or "").strip()
            title_key = _normalize(title)
            if not title or title_key in seen:
                continue
            seen.add(title_key)
            out.append({
                "id": f"toc:{int(r['id'])}",
                "title": title,
                "subtitle": "UWorld chapter",
                "href": f"/library/uworld?doc={doc_id}",
                "scope": "uworld",
                "kind": "chapter",
                "search_text": title,
            })
            if len(out) >= limit:
                return out
        return out
    except sqlite3.Error:
        return []
    finally:
        c.close()


@lru_cache(maxsize=512)
def _query_utd(q: str, qn: str, limit: int) -> list[dict]:
    if not UTD_DB_PATH:
        return []
    qf = UTD_DB_PATH / "utdqf.sqlite"
    idx = UTD_DB_PATH / "unidex.en.sqlite"
    out: list[dict] = []
    seen: set[int] = set()
    escaped_qn = _like_escape(qn)

    def append_topic(tid: int, title: str) -> None:
        if tid in seen or not title:
            return
        seen.add(tid)
        out.append({"id": tid, "title": title.strip(), "subtitle": "UpToDate topic",
                    "href": f"/uptodate?t={tid}", "scope": "utd", "kind": "topic",
                    "search_text": title.strip()})

    if idx.exists():
        c = sqlite3.connect(f"file:{idx}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT topic_id, title
                FROM topic
                WHERE lower(title) LIKE ?
                ORDER BY
                  CASE WHEN lower(title) LIKE ? THEN 0 ELSE 1 END,
                  lower(title)
                LIMIT ?
                """,
                (f"%{escaped_qn}%", f"{escaped_qn}%", limit),
            ).fetchall()
            for r in rows:
                append_topic(int(r["topic_id"]), r["title"] or "")
                if len(out) >= limit:
                    return out
        finally:
            c.close()

    if qf.exists() and len(out) == 0:
        c = sqlite3.connect(f"file:{qf}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                "SELECT t, xp, f FROM qf WHERE lower(u) LIKE ? ORDER BY f DESC LIMIT ?",
                (f"{escaped_qn}%", limit),
            ).fetchall()
            for r in rows:
                xp = (r["xp"] or "").strip()
                if not xp.isdigit():
                    continue
                tid = int(xp)
                if tid in seen:
                    continue
                append_topic(tid, r["t"] or "")
        finally:
            c.close()

    if idx.exists() and len(out) == 0 and len(qn) >= 5:
        c = sqlite3.connect(f"file:{idx}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT qt.pref, qt.topic_hits, q.weight
                FROM query q
                JOIN query_topic qt ON qt.nqid = q.nqid
                WHERE lower(q.disp) LIKE ?
                   OR lower(coalesce(q.engl, '')) LIKE ?
                ORDER BY q.weight DESC,
                         CASE qt.pref
                           WHEN 'X' THEN 0 WHEN 'A' THEN 1
                           WHEN 'P' THEN 2 WHEN 'I' THEN 3 ELSE 4
                         END
                LIMIT 12
                """,
                (f"{escaped_qn}%", f"{escaped_qn}%"),
            ).fetchall()
            topic_order: list[int] = []
            for r in rows:
                for tid in _decode_utd_topic_hits(r["topic_hits"]):
                    if tid not in seen and tid not in topic_order:
                        topic_order.append(tid)
                    if len(topic_order) >= limit:
                        break
                if len(topic_order) >= limit:
                    break
            if topic_order:
                placeholders = ",".join("?" for _ in topic_order)
                topic_rows = c.execute(
                    f"SELECT topic_id, title FROM topic WHERE topic_id IN ({placeholders})",
                    topic_order,
                ).fetchall()
                titles = {int(r["topic_id"]): r["title"] or "" for r in topic_rows}
                for tid in topic_order:
                    append_topic(tid, titles.get(tid, ""))
                    if len(out) >= limit:
                        return out
        finally:
            c.close()
    return out


@lru_cache(maxsize=512)
def _query_books(qn: str, limit: int) -> list[dict]:
    if not LIBRARY_INDEX_DB.exists():
        return []
    c = sqlite3.connect(str(LIBRARY_INDEX_DB))
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            "SELECT id, title, subtitle FROM books WHERE lower(title) LIKE ? ORDER BY lower(title) LIMIT ?",
            (f"%{_like_escape(qn)}%", limit),
        ).fetchall()
    finally:
        c.close()
    out: list[dict] = []
    for r in rows:
        rel = r["id"] or ""
        raw_title = r["title"] or Path(rel).stem
        folder = rel.replace("\\", "/").split("/")[0] if "/" in (rel or "") else ""
        # Clean split/oddly-named files (e.g. Harrison "Part 25" → readable name).
        display = book_priority.display_title(raw_title, folder, rel)
        out.append({
            "id": rel, "title": display,
            "subtitle": r["subtitle"] or "Book", "href": f"/library?path={quote(rel)}",
            "scope": "books", "kind": "book",
            "search_text": " ".join(filter(None, (raw_title, display, folder))),
            "book_title": raw_title, "book_id": rel,
        })
    return out


def _book_chapter_match_query(qn: str) -> str:
    tokens = re.findall(r"[a-z0-9]+", qn or "")
    tokens = [tok for tok in tokens if len(tok) >= 2][:8]
    return " ".join(f"{tok}*" for tok in tokens)


@lru_cache(maxsize=4)
def _ensure_book_chapter_search_indexes(db_path: str, mtime_ns: int) -> None:
    del mtime_ns
    c = sqlite3.connect(db_path, timeout=10)
    try:
        c.execute("CREATE INDEX IF NOT EXISTS idx_headings_parent ON headings(parent_id)")
        c.commit()
    finally:
        c.close()


def _chapter_subtitle(book_title: str, hierarchy: str, page: int | None) -> str:
    parts = [p.strip() for p in (hierarchy or "").split(" > ") if p.strip()]
    parent_path = " > ".join(parts[:-1][-2:])
    bits = [book_title or "Book"]
    if page:
        bits.append(f"p. {page}")
    if parent_path:
        bits.append(parent_path)
    return " · ".join(bits)


@lru_cache(maxsize=512)
def _query_book_chapters(qn: str, limit: int) -> list[dict]:
    if not BOOK_CHAPTER_INDEX_DB.exists():
        return []

    match_query = _book_chapter_match_query(qn)
    if not match_query:
        return []
    fetch_limit = max(limit * 4, 60)
    try:
        db_stat = BOOK_CHAPTER_INDEX_DB.stat()
        _ensure_book_chapter_search_indexes(str(BOOK_CHAPTER_INDEX_DB), db_stat.st_mtime_ns)
    except Exception:
        pass

    def to_result(r: sqlite3.Row) -> dict:
        page = int(r["page"] or 0) or None
        book_title = r["book_title"] or ""
        folder = r["folder"] or ""
        # Readable book label for the subtitle (Harrison "Part 25" → its name).
        book_label = book_priority.display_title(book_title, folder, r["book_id"])
        return {
            "id": f"chapter:{r['id']}",
            "title": r["title"] or "",
            "subtitle": _chapter_subtitle(book_label, r["hierarchy"] or "", page),
            "href": r["href"] or f"/library?path={quote(r['book_id'])}" + (f"&page={page}" if page else ""),
            "scope": "books",
            "kind": "chapter",
            "search_text": " ".join(
                str(v or "")
                for v in (r["title"], r["hierarchy"], r["book_title"], r["folder"])
            ),
            "book_id": r["book_id"],
            "folder": folder,
            "page": page,
            "page_end": int(r["page_end"] or 0) or None,
            "depth": int(r["depth"] or 0),
            "hierarchy": r["hierarchy"] or "",
            "has_children": bool(r["has_children"]),
            "book_title": book_title,
            "book_label": book_label,
            "fts_rank": float(r["rank"]) if "rank" in r.keys() and r["rank"] is not None else 0.0,
        }

    c = sqlite3.connect(f"file:{BOOK_CHAPTER_INDEX_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        exact = qn.strip().lower()
        prefix = f"{exact}%"
        rows = c.execute(
            """
            SELECT h.id, h.book_id, h.title, h.hierarchy, h.page, h.page_end,
                   h.href, h.depth, b.title AS book_title, b.folder,
                   EXISTS(SELECT 1 FROM headings child WHERE child.parent_id=h.id) AS has_children,
                   bm25(heading_fts) AS rank
            FROM heading_fts
            JOIN headings h ON h.id = heading_fts.rowid
            JOIN books b ON b.id = h.book_id
            WHERE heading_fts MATCH ?
            ORDER BY
              CASE
                WHEN lower(h.title)=? THEN 0
                WHEN lower(h.title) LIKE ? THEN 1
                ELSE 2
              END,
              CASE WHEN EXISTS(SELECT 1 FROM headings child WHERE child.parent_id=h.id) THEN 0 ELSE 1 END,
              h.depth ASC,
              rank ASC,
              h.page ASC
            LIMIT ?
            """,
            (match_query, exact, prefix, fetch_limit),
        ).fetchall()
    except sqlite3.Error:
        like = f"%{_like_escape(qn)}%"
        rows = c.execute(
            """
            SELECT h.id, h.book_id, h.title, h.hierarchy, h.page, h.page_end,
                   h.href, h.depth, b.title AS book_title, b.folder,
                   EXISTS(SELECT 1 FROM headings child WHERE child.parent_id=h.id) AS has_children
            FROM headings h
            JOIN books b ON b.id = h.book_id
            WHERE lower(h.search_text) LIKE ?
            ORDER BY h.depth ASC, h.page ASC
            LIMIT ?
            """,
            (like, fetch_limit),
        ).fetchall()
    finally:
        c.close()

    results = [to_result(r) for r in rows]
    # Drop chapters whose book is no longer in the library folder.
    present_books = _library_present_set()
    if present_books:
        results = [r for r in results if _norm_book_path(r.get("book_id")) in present_books]
    if not results:
        return []

    exact = qn.strip().lower()

    def sort_key(item: dict) -> tuple:
        title_norm = _chapter_title_norm(item.get("title", ""))
        starts = 0 if title_norm.startswith(exact) else 1
        exact_hit = 0 if title_norm == exact else 1
        authority = _book_priority_bonus(item)
        return (
            exact_hit,
            starts,
            -authority,
            int(item.get("depth") or 0),
            item.get("fts_rank", 0.0),
            int(item.get("page") or 999999),
            item.get("title", "").lower(),
        )

    results.sort(key=sort_key)
    diversified: list[dict] = []
    per_book_count: dict[str, int] = {}
    seen_title_book: set[tuple[str, str]] = set()
    for pass_cap in (1, 2, 4):
        for item in results:
            key = (str(item.get("book_id") or ""), _normalize(item.get("title", "")))
            if key in seen_title_book:
                continue
            book_id = str(item.get("book_id") or "")
            if per_book_count.get(book_id, 0) >= pass_cap:
                continue
            seen_title_book.add(key)
            per_book_count[book_id] = per_book_count.get(book_id, 0) + 1
            diversified.append(item)
            if len(diversified) >= limit:
                return diversified
    return diversified[:limit]


@lru_cache(maxsize=512)
def _query_firstaid(qn: str, limit: int) -> list[dict]:
    regions = firstaid.search_regions(qn, limit)
    out: list[dict] = []
    for region in regions:
        page = int(region.get("page") or 1)
        heading_id = int(region["heading_id"])
        out.append({
            "id": heading_id,
            "title": region.get("title") or "",
            "subtitle": " · ".join(filter(None, [
                f"FA {region.get('edition') or '2026'}",
                f"p. {page}",
                str(region.get("hierarchy") or "").split(" > ")[-2] if " > " in str(region.get("hierarchy") or "") else "",
            ])),
            "href": f"#firstaid-{heading_id}",
            "scope": "firstaid",
            "kind": "region",
            "search_text": " ".join(str(v or "") for v in (
                region.get("title"),
                region.get("hierarchy"),
                region.get("body_text"),
                region.get("keywords"),
            )),
            "heading_id": heading_id,
            "page": page,
            "hierarchy": region.get("hierarchy") or "",
        })
    return out


@lru_cache(maxsize=512)
def _query_drugs(qn: str, limit: int) -> list[dict]:
    """Query drug_reference.sqlite FTS5 for drugs matching qn."""
    if not DRUG_REF_DB.exists():
        return []
    try:
        c = sqlite3.connect(f"file:{DRUG_REF_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        out: list[dict] = []
        seen: set[int] = set()
        try:
            fts_q = re.sub(r"[^\w\s]", "", qn).strip() + "*"
            if fts_q != "*":
                rows = c.execute(
                    """
                    SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                           qi.drug_class, qi.dose_snippet, d.has_black_box
                    FROM drug_fts
                    JOIN drug_quick_info qi ON qi.drug_id = drug_fts.drug_id
                    JOIN drugs d ON d.drug_id = qi.drug_id
                    WHERE drug_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (fts_q, limit * 2),
                ).fetchall()
                for r in rows:
                    did = int(r["drug_id"])
                    if did in seen:
                        continue
                    seen.add(did)
                    brands   = r["brand_names"] or ""
                    dc       = r["drug_class"] or ""
                    dose     = r["dose_snippet"] or ""
                    subtitle = " · ".join(filter(None, [
                        brands.split(",")[0].strip() if brands else "",
                        dc.split("|")[0].strip()[:30] if dc else "",
                        dose[:60] if dose else "",
                    ])) or "Drug reference"
                    out.append({
                        "id": did, "title": r["generic_name"] or "",
                        "subtitle": subtitle,
                        "href": f"/drugs?id={did}",
                        "scope": "drugs", "kind": "drug",
                        "search_text": f"{r['generic_name']} {brands} {dc}",
                        "has_black_box": bool(r["has_black_box"]),
                        "dose_snippet": dose[:80],
                        "brand_names": brands,
                        "drug_class": dc,
                    })
                    if len(out) >= limit * 2:
                        break
            rows2 = c.execute(
                """
                SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                       qi.drug_class, qi.dose_snippet, d.has_black_box
                FROM drug_quick_info qi
                JOIN drugs d ON d.drug_id = qi.drug_id
                WHERE lower(qi.generic_name) LIKE ?
                   OR lower(qi.brand_names)  LIKE ?
                ORDER BY
                  CASE WHEN lower(qi.generic_name) LIKE ? THEN 0 ELSE 1 END,
                  lower(qi.generic_name)
                LIMIT ?
                """,
                (f"{qn}%", f"%{qn}%", f"{qn}%", limit),
            ).fetchall()
            for r in rows2:
                did = int(r["drug_id"])
                if did in seen:
                    continue
                seen.add(did)
                brands   = r["brand_names"] or ""
                dc       = r["drug_class"] or ""
                dose     = r["dose_snippet"] or ""
                subtitle = " · ".join(filter(None, [
                    brands.split(",")[0].strip() if brands else "",
                    dc.split("|")[0].strip()[:30] if dc else "",
                ])) or "Drug reference"
                out.append({
                    "id": did, "title": r["generic_name"] or "",
                    "subtitle": subtitle,
                    "href": f"/drugs?id={did}",
                    "scope": "drugs", "kind": "drug",
                    "search_text": f"{r['generic_name']} {brands} {dc}",
                    "has_black_box": bool(r["has_black_box"]),
                    "dose_snippet": dose[:80],
                    "brand_names": brands,
                    "drug_class": dc,
                })
                if len(out) >= limit * 2:
                    break
        finally:
            c.close()
        return out
    except Exception:
        return []


def _fts_prefix_query(qn: str) -> str:
    """Turn a normalized string into a safe FTS5 prefix query (per-token)."""
    toks = re.findall(r"[\w]+", (qn or "").lower())
    return " ".join(f'"{t}"*' for t in toks)


def _query_sanford(qn: str, limit: int) -> list[dict]:
    """Live Sanford Guide search. Antimicrobial (drug) + organism topics lead —
    the whole point of Sanford's antibiotic authority."""
    from config import SANFORD_DB
    if not Path(SANFORD_DB).exists() or not qn:
        return []
    match = _fts_prefix_query(qn)
    if not match:
        return []
    try:
        c = sqlite3.connect(f"file:{SANFORD_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
    except sqlite3.OperationalError:
        return []
    try:
        rows = c.execute(
            """
            SELECT t.id, t.title, t.kind, t.content_label, t.trade_name, t.is_drug
            FROM sanford_fts f JOIN sanford_topics t ON t.id = f.rowid
            WHERE sanford_fts MATCH ?
            ORDER BY (rank - CASE WHEN t.kind='drug' THEN 8 WHEN t.kind='organism' THEN 4 ELSE 0 END)
            LIMIT ?
            """,
            (match, limit),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "subtitle": r["trade_name"] or f"Sanford · {r['content_label']}",
                "search_text": f"{r['title']} {r['trade_name'] or ''}",
                "href": f"/sanford?id={r['id']}",
                "scope": "sanford",
                "kind": r["kind"] or "topic",
                "is_drug": bool(r["is_drug"]),
            }
            for r in rows
        ]
    except sqlite3.OperationalError:
        return []
    finally:
        c.close()


def _query_utdddx(qn: str, limit: int) -> list[dict]:
    """Live UpToDate DDx search over presenting diagnoses (main topics lead)."""
    from config import UTDDDX_DB
    if not Path(UTDDDX_DB).exists() or not qn:
        return []
    match = _fts_prefix_query(qn)
    if not match:
        return []
    try:
        c = sqlite3.connect(f"file:{UTDDDX_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
    except sqlite3.OperationalError:
        return []
    try:
        rows = c.execute(
            """
            SELECT t.id, t.title, t.is_main, t.differential_count
            FROM ddx_fts f JOIN ddx_topics t ON t.id = f.rowid
            WHERE ddx_fts MATCH ?
            ORDER BY (rank - CASE WHEN t.is_main=1 THEN 6 ELSE 0 END)
            LIMIT ?
            """,
            (match, limit),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "subtitle": f"DDx · {r['differential_count']} differentials" if r["is_main"] else "UpToDate DDx",
                "search_text": r["title"],
                "href": f"/utdddx?id={r['id']}",
                "scope": "utdddx",
                "kind": "ddx",
                "is_main": bool(r["is_main"]),
            }
            for r in rows
        ]
    except sqlite3.OperationalError:
        return []
    finally:
        c.close()


def _quote_identifier(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


@lru_cache(maxsize=1)
def _lexi_search_tables() -> tuple[tuple[str, str], ...]:
    if not LEXI_DB_PATH or not LEXI_DB_PATH.exists():
        return tuple()
    c = sqlite3.connect(f"file:{LEXI_DB_PATH}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        out: list[tuple[str, str]] = []
        candidates = ("title", "name", "term", "display_name", "generic_name", "brand_name")
        for table in tables:
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({_quote_identifier(table)})").fetchall()]
            for col in candidates:
                if col in cols:
                    out.append((table, col))
                    break
        return tuple(out)
    finally:
        c.close()


@lru_cache(maxsize=256)
def _query_lexi(q: str, qn: str, limit: int) -> list[dict]:
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
        escaped = _like_escape(q.strip())
        patterns = (f"{escaped}%", f"%{escaped}%") if len(qn) >= 4 else (f"{escaped}%",)
        for pattern in patterns:
            for table, col in table_cols[:24]:
                rows = c.execute(
                    f"SELECT {_quote_identifier(col)} AS term FROM {_quote_identifier(table)} "
                    f"WHERE {_quote_identifier(col)} LIKE ? ESCAPE '\\' LIMIT ?",
                    (pattern, min(8, limit)),
                ).fetchall()
                for r in rows:
                    term = (r["term"] or "").strip()
                    key = _normalize(term)
                    if not key or key in seen:
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


@lru_cache(maxsize=1)
def _lexi_calc_catalog() -> tuple[dict, ...]:
    out: list[dict] = []
    seen: set[str] = set()
    if not LEXI_CALC_DB.exists():
        lexi_rows: list[sqlite3.Row] = []
    else:
        c = sqlite3.connect(f"file:{LEXI_CALC_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            lexi_rows = c.execute(
                """
                SELECT d.id, d.title, group_concat(ii.name, ' ') AS categories
                FROM document d
                JOIN chapter c ON c.id = d.chapter_id
                LEFT JOIN indexitem_document iid ON iid.document_id = d.id
                LEFT JOIN indexitem ii ON ii.id = iid.indexitem_id
                WHERE c.title = 'Calculator'
                GROUP BY d.id, d.title
                ORDER BY lower(d.title)
                """
            ).fetchall()
        finally:
            c.close()
    for r in lexi_rows:
        title = (r["title"] or "").strip()
        if not title:
            continue
        key = _normalize(title)
        seen.add(key)
        out.append({
            "id": str(r["id"]),
            "title": title,
            "categories": r["categories"] or "",
            "description": "",
            "source": "lexi",
        })

    catalog_path = ROOT / "data" / "WSA" / "mdcalc-live" / "catalog" / "mdcalc-live-catalog.compact.json"
    try:
        raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    for calc in raw.get("calculators") or []:
        if not isinstance(calc, dict):
            continue
        title = str(calc.get("title") or calc.get("shortTitle") or "").strip()
        if not title:
            continue
        key = _normalize(title)
        if key in seen:
            continue
        seen.add(key)
        systems = calc.get("systems") if isinstance(calc.get("systems"), list) else []
        diseases = calc.get("diseases") if isinstance(calc.get("diseases"), list) else []
        categories = " ".join(str(v) for v in [*systems, *diseases] if v)
        description = str(calc.get("description") or calc.get("mediumDescription") or calc.get("shortDescription") or "")
        abbrev = " ".join(str(v) for v in (calc.get("searchAbbreviations") or []) if v)
        out.append({
            "id": f"mdcalc_{calc.get('id')}",
            "title": title,
            "categories": categories,
            "description": description,
            "source": "mdcalc-live",
            "search_text": " ".join([title, str(calc.get("shortTitle") or ""), categories, description, abbrev]),
        })
    return tuple(out)


@lru_cache(maxsize=256)
def _query_lexi_calcs(qn: str, limit: int) -> list[dict]:
    out: list[dict] = []
    for calc in _lexi_calc_catalog():
        title = calc["title"]
        categories = calc.get("categories") or ""
        search_text = calc.get("search_text") or f"{title} {categories} {calc.get('description') or ''}"
        text = _normalize(search_text)
        if not qn or not _has_meaningful_token_coverage(qn, text) or _score(qn, text) < 35:
            continue
        is_mdcalc = calc.get("source") == "mdcalc-live"
        out.append({
            "id": f"lexi-calc:{calc['id']}",
            "title": title,
            "subtitle": ("MDCalc calculator" if is_mdcalc else "Lexi calculator") + (f" · {categories.split(' ')[0]}" if categories else ""),
            "href": f"/calculators?q={quote(title)}",
            "scope": "calc",
            "kind": "calculator",
            "search_text": search_text,
        })
    out.sort(key=lambda item: (-_score(qn, _normalize(item["search_text"])), item["title"].lower()))
    return out[:limit]


@lru_cache(maxsize=1)
def _anatomy_catalog() -> tuple[dict, ...]:
    candidates: list[dict] = []
    if ANATOMY_DEFS_PATH.exists() and ANATOMY_DEFS_PATH.is_dir():
        for f in ANATOMY_DEFS_PATH.glob("*.txt"):
            title = f.stem.replace("_", " ")
            candidates.append({
                "id": f.stem,
                "title": title,
                "subtitle": "Anatomy structure",
                "href": f"/anatomy?structure={quote(title)}",
                "scope": "anatomy",
                "kind": "structure",
                "search_text": title,
            })

    public_defs = Path(__file__).resolve().parents[2] / "public" / "anatomy_defs.json"
    if public_defs.exists():
        try:
            raw = json.loads(public_defs.read_text(encoding="utf-8"))
        except Exception:
            raw = {}
        if isinstance(raw, dict):
            seen = {_normalize(item["title"]) for item in candidates}
            for title, definition in raw.items():
                clean = str(title or "").strip()
                key = _normalize(clean)
                if not clean or key in seen:
                    continue
                seen.add(key)
                candidates.append({
                    "id": clean,
                    "title": clean,
                    "subtitle": "Anatomy structure",
                    "href": f"/anatomy?structure={quote(clean)}",
                    "scope": "anatomy",
                    "kind": "structure",
                    "search_text": f"{clean} {str(definition or '')[:240]}",
                })
    return tuple(candidates)


@lru_cache(maxsize=256)
def _query_anatomy(qn: str, limit: int) -> list[dict]:
    hits = [item for item in _anatomy_catalog() if _score(qn, _normalize(item["search_text"])) >= 45]
    hits.sort(key=lambda item: (-_score(qn, _normalize(item["search_text"])), item["title"].lower()))
    return hits[:limit]


@lru_cache(maxsize=1)
def _disease_catalog() -> tuple[dict, ...]:
    if not HARRISONS_PATH.exists():
        return tuple()
    try:
        raw = json.loads(HARRISONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return tuple()
    rows = raw if isinstance(raw, list) else raw.get("diseases", [])
    out: list[dict] = []
    iter_rows = rows if isinstance(rows, list) else []
    for d in iter_rows:
        if not isinstance(d, dict):
            continue
        name = (d.get("disease_name") or d.get("name") or "").strip()
        if not name:
            continue
        points = d.get("clinical_synthesis")
        if not isinstance(points, list):
            points = d.get("harrisons_synthesis")
        point_text = " ".join(str(p) for p in points[:3]) if isinstance(points, list) else ""
        organ = d.get("primary_organ") or ""
        system = d.get("primary_system") or ""
        subtitle = " · ".join(str(v) for v in (system, organ) if v) or "Disease reference"
        out.append({
            "id": name,
            "title": name,
            "subtitle": subtitle,
            "href": f"/diseases?disease={quote(name)}",
            "scope": "diseases",
            "kind": "disease",
            "search_text": f"{name} {system} {organ} {point_text}",
        })
    return tuple(out)


@lru_cache(maxsize=256)
def _query_diseases(qn: str, limit: int) -> list[dict]:
    hits = [item for item in _disease_catalog() if _score(qn, _normalize(item["search_text"])) >= 45]
    hits.sort(key=lambda item: (-_score(qn, _normalize(item["search_text"])), item["title"].lower()))
    return hits[:limit]


def _cliniccons_image_payloads(images_json: str | None) -> list[dict]:
    out: list[dict] = []
    for item in _load_json_list(images_json):
        if not isinstance(item, dict):
            continue
        filename = Path(str(item.get("filename") or "")).name
        if not filename:
            continue
        title = str(item.get("title") or Path(filename).stem.replace("_", " ")).strip()
        try:
            match_score = float(item.get("match_score")) if item.get("match_score") is not None else None
        except (TypeError, ValueError):
            match_score = None
        out.append({
            "title": title,
            "url": f"/cliniccons/image/{filename}",
            "filename": filename,
            "match_score": match_score,
        })
    return out


@lru_cache(maxsize=1)
def _cliniccons_image_catalog() -> tuple[dict, ...]:
    if not _CLINICCONS_REFERENCE_DB.exists():
        return tuple()

    c = sqlite3.connect(f"file:{_CLINICCONS_REFERENCE_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            """
            SELECT 'algorithm' AS row_kind, a.document_id AS doc_id, a.title,
                   '' AS disease_name, a.content_preview, '' AS primary_system,
                   '' AS primary_organ, a.images_json
            FROM algorithms a
            WHERE a.images_json IS NOT NULL AND a.images_json != ''
            UNION ALL
            SELECT 'disease_algorithm' AS row_kind,
                   COALESCE(da.algorithm_document_id, da.disease_document_id) AS doc_id,
                   da.title, d.disease_name, d.content_preview, d.primary_system,
                   d.primary_organ, da.images_json
            FROM disease_algorithms da
            LEFT JOIN diseases d ON d.document_id = da.disease_document_id
            WHERE da.images_json IS NOT NULL AND da.images_json != ''
            """
        ).fetchall()
    finally:
        c.close()

    out: list[dict] = []
    for r in rows:
        title = (r["title"] or "").strip()
        disease = (r["disease_name"] or "").strip()
        system = (r["primary_system"] or "").strip()
        organ = (r["primary_organ"] or "").strip()
        preview = (r["content_preview"] or "").strip()
        parent_text = " ".join([title, disease, system, organ, preview])

        for image in _cliniccons_image_payloads(r["images_json"]):
            image_title = str(image.get("title") or "").strip()
            filename = str(image.get("filename") or "")
            combined_text = " ".join([parent_text, image_title, Path(filename).stem])

            raw_match = image.get("match_score")
            display = image_title or title
            display = display or disease or Path(filename).stem.replace("_", " ")
            if "algorithm" not in display.lower() and "image" not in display.lower():
                display = f"{display} algorithm image"
            subtitle_bits = ["Clinic Consult image"]
            if disease and disease.lower() not in display.lower():
                subtitle_bits.append(disease)
            elif system:
                subtitle_bits.append(system)
            out.append({
                "id": f"clinic-image:{filename}",
                "title": display,
                "subtitle": " · ".join(subtitle_bits),
                "href": image["url"],
                "scope": "diseases",
                "kind": "clinic_image",
                "search_text": combined_text,
                "preview": {
                    "type": "image",
                    "title": display,
                    "url": image["url"],
                    "caption": " · ".join(filter(None, [disease, system or organ])),
                    "source": "Clinic Consult",
                },
                "image_title": image_title,
                "filename": filename,
                "raw_match": raw_match,
            })
    return tuple(out)


@lru_cache(maxsize=256)
def _query_cliniccons_images(qn: str, limit: int) -> list[dict]:
    if len(qn) < 2:
        return []

    scored: list[tuple[float, dict]] = []
    for item in _cliniccons_image_catalog():
        combined_text = item.get("search_text") or item.get("title") or ""
        combined_norm = _normalize(combined_text)
        image_norm = _normalize(f"{item.get('image_title') or ''} {Path(str(item.get('filename') or '')).stem}")
        combined_score = max(_score(qn, combined_norm), _score(qn, image_norm))
        if combined_score < 38 and qn not in combined_norm:
            continue
        if not _has_meaningful_token_coverage(qn, combined_norm) and combined_score < 95:
            continue

        raw_match = item.get("raw_match")
        if isinstance(raw_match, (int, float)) and raw_match < 0.7 and _score(qn, image_norm) < 90:
            continue
        scored.append((combined_score + (float(raw_match or 0) * 12.0), item))

    scored.sort(key=lambda pair: (-pair[0], pair[1]["title"].lower()))
    out: list[dict] = []
    seen_files: set[str] = set()
    for _score_value, item in scored:
        filename = str(item["id"]).split("clinic-image:", 1)[-1].lower()
        if filename in seen_files:
            continue
        seen_files.add(filename)
        out.append({k: v for k, v in item.items() if k not in {"image_title", "filename", "raw_match"}})
        if len(out) >= limit:
            break
    return out


def _qbank_paths() -> tuple[tuple[str, Path], ...]:
    configured = {
        "step1": STEP1_DB_PATH,
        "step2": STEP2_DB_PATH,
        "step3": STEP3_DB_PATH,
    }
    out: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for key in ("step2", "step1", "step3"):
        path = configured.get(key) or _QBANK_DEFAULTS[key]
        if path and path.exists():
            resolved = path.resolve(strict=True)
            out.append((key, resolved))
            seen.add(resolved.as_posix().casefold())

    # The reader registry is the authoritative inventory for additional banks
    # (MKSAP, BoardVitals, AMBOSS ABIM, UWorld ABIM, and future completed
    # sources). Keep the configured Step banks first and de-duplicate aliases
    # by their resolved database path.
    try:
        from qbank_reader import _bank_registry

        registry = _bank_registry()
    except (ImportError, OSError, RuntimeError, sqlite3.Error):
        registry = {}
    for key, info in sorted(registry.items(), key=lambda item: item[0].casefold()):
        path = Path(info.db_path)
        try:
            resolved = path.resolve(strict=True)
        except OSError:
            continue
        identity = resolved.as_posix().casefold()
        if identity in seen or not resolved.is_file():
            continue
        out.append((key, resolved))
        seen.add(identity)
    return tuple(out)


def _qbank_visual_index_path(bank: str) -> Path:
    return Path(__file__).resolve().parents[1] / f"qbank_visual_index_{bank}.sqlite3"


@lru_cache(maxsize=1)
def _uworld_exhibit_catalog() -> tuple[dict, ...]:
    out: list[dict] = []
    for bank, _db_path in _qbank_paths():
        index_path = _qbank_visual_index_path(bank)
        if not index_path.exists():
            continue
        c = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                "SELECT term, payload FROM visual_terms WHERE kind='exhibit'"
            ).fetchall()
        except sqlite3.Error:
            rows = []
        finally:
            c.close()

        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except Exception:
                continue
            if not isinstance(payload, dict) or payload.get("kind") != "exhibit":
                continue
            exhibit_id = str(payload.get("exhibit_id") or "").strip()
            if not re.fullmatch(r"\d{3,8}", exhibit_id):
                continue
            out.append({
                **payload,
                "db": bank,
                "term": payload.get("term") or row["term"] or "",
                "title": payload.get("title") or payload.get("term") or row["term"] or f"UWorld table {exhibit_id}",
                "exhibit_id": exhibit_id,
            })
    return tuple(out)


@lru_cache(maxsize=4096)
def _qbank_exhibit_table_html(bank: str, exhibit_id: str, qid: int | None) -> str:
    if bank not in {"step1", "step2", "step3"} or not qid:
        return ""
    try:
        from qbank_reader import _clean_html, _decrypt_qbank_html, _rewrite_media_links
    except Exception:
        return ""

    db_path = dict(_qbank_paths()).get(bank)
    if not db_path or not db_path.exists():
        return ""

    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        row = c.execute(
            "SELECT question, explanation FROM Questions WHERE id=?",
            (qid,),
        ).fetchone()
    except sqlite3.Error:
        row = None
    finally:
        c.close()
    if not row:
        return ""

    patterns = [
        re.compile(
            rf'(?is)<div\b[^>]*\bid=["\']div_[tT]{re.escape(exhibit_id)}["\'][^>]*>.*?</div>'
        ),
        re.compile(
            rf'(?is)<table\b[^>]*\bid=["\'][^"\']*[tT]{re.escape(exhibit_id)}[^"\']*["\'][^>]*>.*?</table>'
        ),
    ]
    for payload in (row["question"], row["explanation"]):
        source = _decrypt_qbank_html(int(qid), payload)
        if not source or exhibit_id not in source:
            continue
        for pattern in patterns:
            match = pattern.search(source)
            if not match:
                continue
            fragment = _clean_html(_rewrite_media_links(int(qid), match.group(0)))
            table_match = re.search(r"(?is)<table\b.*?</table>", fragment)
            if table_match:
                return table_match.group(0)
    return ""


@lru_cache(maxsize=256)
def _query_uworld_tables(qn: str, limit: int) -> list[dict]:
    if len(qn) < 2:
        return []

    candidates: list[tuple[float, dict]] = []
    for item in _uworld_exhibit_catalog():
        text = " ".join(str(item.get(k) or "") for k in ("term", "title", "db"))
        text_norm = _normalize(text)
        sc = _score(qn, text_norm)
        if sc < 38 and qn not in text_norm:
            continue
        if not _has_meaningful_token_coverage(qn, text_norm) and sc < 90:
            continue
        candidates.append((sc, item))

    candidates.sort(key=lambda pair: (-pair[0], str(pair[1].get("title") or "").lower()))
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    seen_titles: set[str] = set()
    for _candidate_score, item in candidates[: max(limit * 8, 48)]:
        bank = str(item.get("db") or "")
        exhibit_id = str(item.get("exhibit_id") or "")
        key = (bank, exhibit_id)
        if key in seen:
            continue
        seen.add(key)
        qid_raw = item.get("qid")
        try:
            qid = int(qid_raw) if qid_raw else None
        except (TypeError, ValueError):
            qid = None
        title = str(item.get("title") or item.get("term") or f"UWorld table {exhibit_id}").strip()
        title_key = _normalize(title)
        if title_key in seen_titles:
            continue
        seen_titles.add(title_key)
        href = f"/qbank/exhibit/{exhibit_id}?db={bank}"
        out.append({
            "id": f"uworld-table:{bank}:{exhibit_id}",
            "title": title,
            "subtitle": f"UWorld table · {bank.upper()}",
            "href": href,
            "scope": "qbank",
            "kind": "uworld_table",
            "search_text": f"{title} {item.get('term') or ''} {bank} {qid or ''}",
            "preview": {
                "type": "frame",
                "title": title,
                "url": href,
                "caption": f"UWorld table · {bank.upper()}",
                "source": "UWorld",
            },
        })
        if len(out) >= limit:
            break
    return out


@lru_cache(maxsize=256)
def _query_qbank(qn: str, limit: int) -> list[dict]:
    match_query = _simple_fts_query(qn)
    if not match_query:
        return []

    out: list[dict] = []
    seen_question_titles: set[str] = set()
    per_bank = max(3, min(10, limit // 2))
    for bank, db_path in _qbank_paths():
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        seen_ids: set[int] = set()
        snippets: dict[int, str] = {}
        try:
            try:
                fts_rows = c.execute(
                    """
                    SELECT contentId, content, typeText
                    FROM Search
                    WHERE Search MATCH ?
                    LIMIT ?
                    """,
                    (match_query, per_bank * 8),
                ).fetchall()
            except sqlite3.Error:
                fts_rows = []

            ids: list[int] = []
            for r in fts_rows:
                qid = int(r["contentId"] or 0)
                if qid <= 0 or qid in seen_ids:
                    continue
                seen_ids.add(qid)
                ids.append(qid)
                snippet = re.sub(r"\s+", " ", str(r["content"] or "")).strip()
                if snippet:
                    snippets[qid] = snippet[:180]
                if len(ids) >= per_bank:
                    break

            if ids:
                placeholders = ",".join("?" for _ in ids)
                q_rows = c.execute(
                    f"""
                    SELECT q.id, q.title, subj.name AS subject_name, sys.name AS system_name
                    FROM Questions q
                    LEFT JOIN Subjects subj ON subj.id=q.subId
                    LEFT JOIN Systems sys ON sys.id=q.sysId
                    WHERE q.id IN ({placeholders})
                    """,
                    ids,
                ).fetchall()
                by_id = {int(r["id"]): r for r in q_rows}
                for qid in ids:
                    r = by_id.get(qid)
                    if not r:
                        continue
                    subject = r["subject_name"] or ""
                    system = r["system_name"] or ""
                    snippet = snippets.get(qid, "")
                    title = (r["title"] or f"Question {qid}").strip()
                    title_key = _normalize(title)
                    if title_key in seen_question_titles:
                        continue
                    seen_question_titles.add(title_key)
                    out.append({
                        "id": f"{bank}:{qid}",
                        "title": title,
                        "subtitle": " · ".join(filter(None, [bank.upper(), subject, system])),
                        "href": f"/qbank?db={bank}&qid={qid}",
                        "scope": "qbank",
                        "kind": "question",
                        "search_text": f"{title} {subject} {system} {snippet}",
                    })

            if len(out) >= limit:
                break

            like = f"%{_like_escape(qn)}%"
            fallback_rows = c.execute(
                """
                SELECT q.id, q.title, subj.name AS subject_name, sys.name AS system_name
                FROM Questions q
                LEFT JOIN Subjects subj ON subj.id=q.subId
                LEFT JOIN Systems sys ON sys.id=q.sysId
                WHERE q.title LIKE ? ESCAPE '\\'
                   OR subj.name LIKE ? ESCAPE '\\'
                   OR sys.name LIKE ? ESCAPE '\\'
                ORDER BY q.id
                LIMIT ?
                """,
                (like, like, like, per_bank),
            ).fetchall()
            for r in fallback_rows:
                qid = int(r["id"])
                key = f"{bank}:{qid}"
                if any(item["id"] == key for item in out):
                    continue
                subject = r["subject_name"] or ""
                system = r["system_name"] or ""
                title = (r["title"] or f"Question {qid}").strip()
                title_key = _normalize(title)
                if title_key in seen_question_titles:
                    continue
                seen_question_titles.add(title_key)
                out.append({
                    "id": key,
                    "title": title,
                    "subtitle": " · ".join(filter(None, [bank.upper(), subject, system])),
                    "href": f"/qbank?db={bank}&qid={qid}",
                    "scope": "qbank",
                    "kind": "question",
                    "search_text": f"{title} {subject} {system}",
                })
                if len(out) >= limit:
                    break
        finally:
            c.close()
        if len(out) >= limit:
            break

    out.sort(key=lambda item: (-_score(qn, _normalize(item["search_text"])), item["title"].lower()))
    return out[:limit]


def _query_calcs(qn: str, limit: int) -> list[dict]:
    native = [
        {**c, "scope": "calc", "kind": "calculator"}
        for c in _CALCULATOR_INDEX
        if _has_meaningful_token_coverage(qn, _normalize(c["search_text"]))
        and (qn in _normalize(c["search_text"]) or _score(qn, _normalize(c["search_text"])) >= 35)
    ]
    combined = native + _query_lexi_calcs(qn, max(limit - len(native), 0) or limit)
    seen: set[str] = set()
    out: list[dict] = []
    for item in sorted(combined, key=lambda x: (-_score(qn, _normalize(x["search_text"])), x["title"].lower())):
        key = _normalize(item["title"])
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _query_abbreviations(q: str, limit: int = 8) -> list[dict]:
    """
    Prefix-match query against the SESLHDPR glossary abbreviations.
    Returns result items to show in the 'abbrev' search group.
    Only returns rows that have a non-empty expansion so the result is useful.
    """
    if not GLOSSARY_DB.exists():
        return []
    try:
        c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT term, expansion, definition, source_rank
                FROM glossary
                WHERE lower(term) LIKE lower(?)
                  AND expansion != ''
                ORDER BY source_rank ASC, length(term) ASC
                LIMIT ?
                """,
                (f"{q.strip()}%", limit),
            ).fetchall()
        finally:
            c.close()
        out: list[dict] = []
        seen: set[str] = set()
        for r in rows:
            if not _looks_like_abbreviation(r["term"]):
                continue
            key = r["term"].upper()
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "id": r["term"],
                "title": r["term"],
                "subtitle": r["expansion"],
                "href": f"#abbrev-{r['term']}",
                "scope": "abbrev",
                "kind": "abbreviation",
                "search_text": f"{r['term']} {r['expansion']}",
            })
        return out
    except Exception:
        return []


def _glossary_chip(term: str) -> Optional[dict]:
    """Return a glossary definition chip if the term matches, or None."""
    if GLOSSARY_DB.exists():
        try:
            c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                row = c.execute(
                    """
                    SELECT term, expansion, definition, source, source_id
                    FROM glossary
                    WHERE lower(term)=lower(?)
                    ORDER BY source_rank ASC, CASE lower(source) WHEN 'seslhdpr' THEN 0 ELSE 1 END
                    LIMIT 1
                    """,
                    (term.strip(),),
                ).fetchone()
            finally:
                c.close()
            if row:
                return dict(row)
        except Exception:
            pass
    try:
        return umls_reader.definition_chip(term)
    except Exception:
        return None


def warm_search_indexes() -> None:
    """Light warm-up - cheap catalogs + OS page cache for every search SQLite.
    Runs synchronously at boot (~1-2s) so the backend is responsive quickly.
    The heavier query-level warm-up is dispatched to a background thread."""
    try:
        _disease_catalog()
        _cliniccons_image_catalog()
        _uworld_exhibit_catalog()
        _anatomy_catalog()
        _lexi_calc_catalog()
    except Exception:
        pass

    # Touch every per-source SQLite with a tiny query so its pages are hot.
    _touch_queries: list[tuple[Path, str]] = [
        (GLOSSARY_DB,            "SELECT term FROM glossary LIMIT 1"),
        (BOOK_CHAPTER_INDEX_DB,  "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (LIBRARY_INDEX_DB,       "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (CONCEPT_LINKS_DB,       "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (DRUG_REF_DB,            "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (LEXI_CALC_DB,           "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (STEP1_DB_PATH,          "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (STEP2_DB_PATH,          "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (STEP3_DB_PATH,          "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (ROOT / "data" / "global_search.sqlite",
                                 "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (ROOT / "data" / "firstaid_index.sqlite",
                                 "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
        (UMLS_DB,                "SELECT name FROM sqlite_master WHERE type='table' LIMIT 1"),
    ]
    for db_path, sql in _touch_queries:
        try:
            if not db_path or not Path(db_path).exists():
                continue
            con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
            try:
                con.execute(sql).fetchone()
            finally:
                con.close()
        except Exception:
            pass

    # Heavy warming runs in the BACKGROUND, not inline. Doing it synchronously
    # here blocks the lifespan, so uvicorn has the port bound but serves nothing
    # until it finishes — the status page redirects, the app loads, and its first
    # /me and /activity calls race the warm-up and get ECONNRESET ("site not
    # live"). Backgrounding it lets the backend serve immediately; first searches
    # are only marginally slower (fast-mode autocomplete is already ~100ms cold).
    def _warm_heavy() -> None:
        # Page the big FTS indexes into the OS file cache with one sequential read
        # each (far cheaper than faulting random FTS pages in on the first query).
        for big_db in (ROOT / "data" / "global_search.sqlite",
                       ROOT / "data" / "firstaid_index.sqlite"):
            try:
                if big_db.exists():
                    with open(big_db, "rb", buffering=0) as fh:
                        while fh.read(1 << 20):
                            pass
            except Exception:
                pass
        # One full + one fast end-to-end search to warm the FTS query path.
        try:
            unified_search(q="diabetes", scopes="all", grouped=False, limit=36, fast=False)
            unified_search(q="diabetes", scopes="all", grouped=False, limit=12, fast=True)
        except Exception:
            pass
        try:
            _warm_full_async()
        except Exception:
            pass

    import threading
    threading.Thread(target=_warm_heavy, daemon=True, name="search-warm").start()


def _warm_full_async() -> None:
    """Background-thread warm-up. Pre-runs the most common medical queries
    against the EXACT parameter shapes the frontend home-page search uses
    (grouped=false + both fast=true,limit=12 AND fast=false,limit=36), so the
    first user keystroke hits a warm cache and returns in single-digit ms."""
    _common_queries = (
        "diabetes", "hypertension", "myocardial infarction", "sepsis",
        "asthma", "pneumonia", "thyroid", "metformin", "aspirin",
        "lupus", "chf", "uti",
    )
    # Frontend home page hits both shapes per keystroke - warm both.
    _shapes = (
        {"grouped": False, "limit": 12, "fast": True},
        {"grouped": False, "limit": 36, "fast": False},
    )
    for warm_query in _common_queries:
        for shape in _shapes:
            try:
                unified_search(q=warm_query, scopes="all", **shape)
            except Exception:
                pass


def _firstaid_ref_from_item(item: dict) -> dict:
    heading_id = int(item.get("heading_id") or item.get("id") or 0)
    return {
        "heading_id": heading_id,
        "title": item.get("title") or "First Aid",
        "page": int(item.get("page") or _page_from_subtitle(str(item.get("subtitle") or "")) or 1),
        "hierarchy": item.get("hierarchy") or "",
    }


def _page_from_subtitle(value: str) -> int | None:
    match = re.search(r"\bp\.\s*(\d+)", value or "")
    return int(match.group(1)) if match else None


def _collapse_firstaid_results(ranked: list[dict], query_label: str, max_refs: int = 3) -> list[dict]:
    firstaid_items = [item for item in ranked if item.get("scope") == "firstaid" and item.get("kind") in {"region", "packet"}]
    if not firstaid_items:
        return ranked

    if _looks_like_code_query(query_label):
        suggestion = next(iter(_umls_expansions(query_label, 1)), None) or query_label
    else:
        suggestion = _abbr_suggestion(query_label) or query_label
    preferred_query = suggestion or query_label
    refs: list[dict] = []
    seen: set[int] = set()
    seen_pages: set[int] = set()

    def add_ref(ref: dict) -> bool:
        heading_id = int(ref.get("heading_id") or 0)
        page = int(ref.get("page") or 1)
        if heading_id <= 0 or heading_id in seen or page in seen_pages:
            return False
        seen.add(heading_id)
        seen_pages.add(page)
        refs.append({
            "heading_id": heading_id,
            "title": ref.get("title") or "First Aid",
            "page": page,
            "hierarchy": ref.get("hierarchy") or "",
        })
        return True

    try:
        primary_regions = list(firstaid.search_regions(preferred_query, max(max_refs * 3, 8)))
        for region in primary_regions:
            add_ref({
                "heading_id": int(region.get("heading_id") or 0),
                "title": region.get("title") or "First Aid",
                "page": int(region.get("page") or 1),
                "hierarchy": region.get("hierarchy") or "",
            })
            if len(refs) >= max_refs:
                break
    except Exception:
        pass
    for item in sorted(firstaid_items, key=lambda x: (-float(x.get("score") or 0), str(x.get("title") or "").lower())):
        if len(refs) >= max_refs:
            break
        if item.get("kind") == "packet" and isinstance(item.get("firstaid_refs"), list):
            source_refs = item["firstaid_refs"]
        else:
            source_refs = [_firstaid_ref_from_item(item)]
        for ref in source_refs:
            add_ref(ref)
            if len(refs) >= max_refs:
                break
        if len(refs) >= max_refs:
            break

    if not refs:
        return [item for item in ranked if item not in firstaid_items]

    display = _display_suggestion(suggestion) or "First Aid"
    pages = ", ".join(str(ref["page"]) for ref in refs[:4])
    page_label = "page" if len(refs) == 1 else "pages"
    page_prefix = "p." if len(refs) == 1 else "pp."
    best_score = max(float(item.get("score") or 0) for item in firstaid_items)
    packet = {
        "id": "firstaid:" + ",".join(str(ref["heading_id"]) for ref in refs),
        "title": f"First Aid: {display}",
        "subtitle": f"{len(refs)} {page_label} · FA 2026 · {page_prefix} {pages}",
        "href": f"#firstaid-{refs[0]['heading_id']}",
        "scope": "firstaid",
        "kind": "packet",
        "search_text": " ".join(ref["title"] for ref in refs),
        "score": round(best_score + 260.0, 2),
        "firstaid_refs": refs,
    }
    return [packet] + [item for item in ranked if not (item.get("scope") == "firstaid" and item.get("kind") in {"region", "packet"})]


def _exactish_source_hit(item: dict, qn: str) -> bool:
    title_n = _normalize(item.get("title") or "")
    if not qn or not title_n:
        return False
    if title_n == qn:
        return True
    if len(qn) >= 4 and title_n.startswith(qn):
        return True
    tokens = qn.split()
    title_tokens = title_n.split()
    return bool(tokens) and all(any(tt == qt or tt.startswith(qt) for tt in title_tokens) for qt in tokens)


def _search_intent(qn: str, ranked: list[dict]) -> str:
    drug_hit = any(item.get("scope") == "drugs" and _exactish_source_hit(item, qn) for item in ranked[:12])
    if drug_hit:
        return "drug"
    calc_hit = any(item.get("scope") in {"calc", "lexi"} and _exactish_source_hit(item, qn) for item in ranked[:12])
    if calc_hit:
        return "calc"
    return "clinical"


def _flat_priority(item: dict, intent: str) -> int:
    scope = _source_group(item)
    kind = item.get("kind") or ""
    if scope == "differential":
        return 0
    # Sanford Guide is THE antimicrobial authority. Its drug (antimicrobial) and
    # organism (pathogen-directed therapy) topics LEAD every search — the user's
    # explicit "antibiotics → Sanford above all, everywhere" requirement. Sanford's
    # live querier only returns FTS matches, so a Sanford candidate present at all
    # means the query is antimicrobial/organism in nature.
    if scope == "sanford" and kind in {"drug", "organism"}:
        return -1
    if intent == "drug":
        if scope == "sanford": return 0          # Sanford conditions/tools stay top-tier
        if scope == "drugs": return 0
        if scope in {"utd", "amboss", "uworld"}: return 1
        if scope in {"calc", "lexi"}: return 3
        if scope == "umls": return 3
        if scope == "qbank" and kind == "uworld_table": return 3
        if scope == "utdddx": return 4
        if scope == "firstaid": return 4
        if scope == "books": return 5
        if scope == "qbank": return 7
        return 8
    if intent == "calc":
        if scope in {"calc", "lexi"}: return 0
        if scope == "drugs": return 1
        if scope == "sanford": return 2
        if scope == "umls": return 2
        if scope in {"utd", "amboss", "uworld"}: return 3
        if scope == "qbank" and kind == "uworld_table": return 3
        if scope == "utdddx": return 4
        if scope == "firstaid": return 4
        if scope == "books": return 5
        if scope == "qbank": return 7
        return 8
    if scope == "sanford": return 1              # Sanford ID conditions, alongside First Aid
    if scope == "firstaid": return 1
    if scope == "umls": return 2
    if scope == "qbank" and kind == "uworld_table": return 3
    if scope in {"utd", "amboss", "uworld"}: return 4
    # DDx is a pivot tool, not primary reading — it must never outrank topic articles.
    if scope == "utdddx": return 5
    if scope == "drugs": return 5
    if scope == "books": return 6
    if scope in {"diseases", "anatomy"}: return 7
    if scope == "qbank": return 7
    if scope in {"calc", "lexi"}: return 8
    return 8


def _rank_flat_results(ranked: list[dict], query_label: str, qn: str, limit: int) -> list[dict]:
    if limit <= 0 or not ranked:
        return []
    collapsed = _collapse_firstaid_results(ranked, query_label)
    intent = _search_intent(qn, collapsed)
    collapsed.sort(key=lambda item: (
        _flat_priority(item, intent),
        -float(item.get("score") or 0),
        str(item.get("title") or "").lower(),
    ))
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    per_source: dict[str, int] = {}
    for item in collapsed:
        source = _source_group(item)
        key = (source, str(item.get("id") or item.get("href") or item.get("title") or ""))
        if key in seen:
            continue
        seen.add(key)
        if source == "umls" and per_source.get(source, 0) >= 4:
            continue
        if source == "utdddx" and per_source.get(source, 0) >= 3:
            continue
        if source == "qbank" and item.get("kind") == "question" and per_source.get(source, 0) >= 3:
            continue
        if source == "books" and per_source.get(source, 0) >= 5:
            continue
        per_source[source] = per_source.get(source, 0) + 1
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _page_result_identity(item: dict) -> tuple[str, str, str]:
    source = _source_group(item)
    kind = str(item.get("kind") or "")
    stable_value = str(item.get("id") or item.get("href") or _normalize(item.get("title") or ""))
    return source, kind, stable_value


def _rank_page_results(ranked: list[dict], query_label: str, qn: str, limit: int) -> list[dict]:
    if limit <= 0 or not ranked:
        return []
    collapsed = _collapse_firstaid_results(ranked, query_label)
    intent = _search_intent(qn, collapsed)
    ordered = sorted(
        collapsed,
        key=lambda item: (
            _flat_priority(item, intent),
            -float(item.get("score") or 0),
            _normalize(item.get("title") or ""),
            _source_group(item).casefold(),
            str(item.get("id") or "").casefold(),
            str(item.get("href") or "").casefold(),
            str(item.get("title") or "").casefold(),
        ),
    )
    out: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for item in ordered:
        identity = _page_result_identity(item)
        if identity in seen:
            continue
        seen.add(identity)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def _diversify_flat_results(ranked: list[dict], limit: int) -> list[dict]:
    """Weighted round-robin over ranked results so one source cannot bury all others."""
    if limit <= 0 or not ranked:
        return []

    buckets: dict[str, list[dict]] = {}
    source_rank: dict[str, int] = {}
    for index, item in enumerate(ranked):
        source = _source_group(item)
        buckets.setdefault(source, []).append(item)
        source_rank.setdefault(source, index)

    out: list[dict] = []
    counts: dict[str, int] = {source: 0 for source in buckets}
    used_ids: set[tuple[str, str]] = set()

    def next_choice() -> tuple[str, dict] | None:
        last_two = [_source_group(item) for item in out[-2:]]
        choices: list[tuple[float, int, str, dict]] = []
        for source, items in buckets.items():
            while items and (source, str(items[0].get("id"))) in used_ids:
                items.pop(0)
            if not items:
                continue
            if len(last_two) == 2 and last_two[0] == last_two[1] == source:
                continue
            item = items[0]
            diversity_penalty = counts.get(source, 0) * 42.0
            priority_penalty = _SOURCE_DIVERSITY_ORDER.index(source) if source in _SOURCE_DIVERSITY_ORDER else 99
            value = float(item.get("score") or 0.0) - diversity_penalty - (priority_penalty * 0.5)
            choices.append((value, -source_rank.get(source, 9999), source, item))
        if not choices:
            for source, items in buckets.items():
                if items:
                    return source, items[0]
            return None
        choices.sort(key=lambda x: (-x[0], -x[1], x[2]))
        _, _, source, item = choices[0]
        return source, item

    while len(out) < limit:
        choice = next_choice()
        if not choice:
            break
        source, item = choice
        buckets[source].pop(0)
        used_ids.add((source, str(item.get("id"))))
        counts[source] = counts.get(source, 0) + 1
        out.append(item)

    return out


# ── Concept links ──────────────────────────────────────────────────────────

def _related_for(source: str, doc_id: str | int, limit: int = 20) -> list[dict]:
    """
    Given a source + doc_id, return parallel titles in other sources.
    Uses concept_links.sqlite (built by scripts/concepts/build_links.py).
    Falls back to empty list if DB not built yet.
    """
    if not CONCEPT_LINKS_DB.exists() and not _CONTENT_CONCEPTS_DB.exists():
        return []
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    try:
        if CONCEPT_LINKS_DB.exists():
            c = sqlite3.connect(f"file:{CONCEPT_LINKS_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                rows = c.execute(
                    """
                    SELECT source_b AS src, id_b AS eid, title_b AS title, similarity
                    FROM concept_links
                    WHERE source_a=? AND id_a=?
                    UNION ALL
                    SELECT source_a AS src, id_a AS eid, title_a AS title, similarity
                    FROM concept_links
                    WHERE source_b=? AND id_b=?
                    ORDER BY similarity DESC
                    LIMIT ?
                    """,
                    (source, str(doc_id), source, str(doc_id), limit),
                ).fetchall()
            finally:
                c.close()
            for r in rows:
                src = r["src"]
                eid = r["eid"]
                href = (
                    f"/amboss?doc={eid}"   if src == "amboss"   else
                    f"/uptodate?t={eid}"   if src == "utd"      else
                    f"/library/uworld?doc={eid}" if src == "uworld" else
                    f"/library?path={eid}" if src == "books"    else
                    f"#{eid}"
                )
                key = (src, str(eid))
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "source": src,
                    "id": eid,
                    "title": r["title"] or "",
                    "href": href,
                    "similarity": round(float(r["similarity"]), 3),
                })
        for item in _related_for_cui(source, doc_id, max(limit - len(out), 0)):
            key = (item["source"], str(item["id"]))
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
            if len(out) >= limit:
                break
        return out[:limit]
    except Exception:
        return out[:limit]


def _related_for_cui(source: str, doc_id: str | int, limit: int) -> list[dict]:
    """Find content related by shared UMLS CUI.

    Primary signal: title-level content_concepts (high confidence, curated).
    Fallback / supplement: paragraph_concepts which has 10x coverage from body-text
    scanning. We dedup by (source, source_id) so a doc with both signals shows once.
    """
    if limit <= 0:
        return []
    cuis: list[str] = []
    if _CONTENT_CONCEPTS_DB.exists():
        try:
            c = sqlite3.connect(f"file:{_CONTENT_CONCEPTS_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                rows = c.execute(
                    "SELECT cui FROM content_concepts WHERE source=? AND source_id=? ORDER BY confidence DESC LIMIT 8",
                    (source, str(doc_id)),
                ).fetchall()
                cuis = [row["cui"] for row in rows if row["cui"]]
            finally:
                c.close()
        except sqlite3.Error:
            pass

    # If title-level missed (very common — content_concepts only has 57K rows),
    # fall back to paragraph_concepts which tagged the body text.
    if not cuis and _PARAGRAPH_CONCEPTS_DB.exists():
        try:
            p = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True)
            p.row_factory = sqlite3.Row
            try:
                rows = p.execute(
                    """
                    SELECT cui FROM paragraph_concepts
                    WHERE source=? AND source_id=?
                      AND semantic_group IN ('disease','finding','pathology','drug','procedure')
                    ORDER BY hit_count DESC, confidence DESC
                    LIMIT 6
                    """,
                    (source, str(doc_id)),
                ).fetchall()
                cuis = [row["cui"] for row in rows if row["cui"]]
            finally:
                p.close()
        except sqlite3.Error:
            pass

    if not cuis:
        return []

    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    seen.add((source, str(doc_id)))

    # Pull from content_concepts first (high-confidence title matches)
    if _CONTENT_CONCEPTS_DB.exists():
        try:
            c = sqlite3.connect(f"file:{_CONTENT_CONCEPTS_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                placeholders = ",".join("?" for _ in cuis)
                rows = c.execute(
                    f"""
                    SELECT source, source_id, title, href, preferred_name, confidence
                    FROM content_concepts
                    WHERE cui IN ({placeholders})
                    ORDER BY confidence DESC, source, title
                    LIMIT ?
                    """,
                    (*cuis, limit * 3),
                ).fetchall()
                for row in rows:
                    key = (row["source"], row["source_id"])
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append({
                        "source": row["source"],
                        "id": row["source_id"],
                        "title": row["title"] or row["preferred_name"] or "",
                        "href": row["href"] or "#",
                        "similarity": round(float(row["confidence"] or 0.0), 3),
                    })
                    if len(out) >= limit:
                        return out
            finally:
                c.close()
        except sqlite3.Error:
            pass

    # Top up from paragraph_concepts + global_search titles
    if len(out) < limit and _PARAGRAPH_CONCEPTS_DB.exists() and _GLOBAL_SEARCH_DB.exists():
        try:
            p = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True)
            p.row_factory = sqlite3.Row
            gs = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True)
            gs.row_factory = sqlite3.Row
            try:
                placeholders = ",".join("?" for _ in cuis)
                rows = p.execute(
                    f"""
                    SELECT source, source_id, MAX(hit_count) AS hit_count, AVG(confidence) AS confidence
                    FROM paragraph_concepts
                    WHERE cui IN ({placeholders})
                      AND source != 'firstaid_full'
                    GROUP BY source, source_id
                    ORDER BY hit_count DESC, confidence DESC
                    LIMIT ?
                    """,
                    (*cuis, (limit - len(out)) * 4),
                ).fetchall()
                # Batch lookup titles
                by_source: dict[str, list[str]] = {}
                for row in rows:
                    by_source.setdefault(row["source"], []).append(str(row["source_id"]))
                title_map: dict[tuple[str, str], dict] = {}
                for src, ids in by_source.items():
                    ph = ",".join("?" for _ in ids)
                    gs_rows = gs.execute(
                        f"SELECT source, external_id, title, href FROM entries WHERE source=? AND external_id IN ({ph})",
                        (src, *ids),
                    ).fetchall()
                    for gr in gs_rows:
                        title_map[(gr["source"], str(gr["external_id"]))] = dict(gr)
                for row in rows:
                    key = (row["source"], str(row["source_id"]))
                    if key in seen:
                        continue
                    info = title_map.get(key)
                    if not info:
                        continue
                    seen.add(key)
                    out.append({
                        "source": row["source"],
                        "id": str(row["source_id"]),
                        "title": info.get("title") or "",
                        "href": info.get("href") or "#",
                        "similarity": round(float(row["confidence"] or 0.6), 3),
                    })
                    if len(out) >= limit:
                        return out
            finally:
                p.close()
                gs.close()
        except sqlite3.Error:
            pass

    return out


def _doc_cuis(source: str, doc_id: str | int) -> list[str]:
    """The UMLS CUIs tagged to one document — content_concepts first (curated
    title matches), paragraph_concepts as the broader-coverage fallback."""
    cuis: list[str] = []
    if _CONTENT_CONCEPTS_DB.exists():
        try:
            c = sqlite3.connect(f"file:{_CONTENT_CONCEPTS_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                rows = c.execute(
                    "SELECT cui FROM content_concepts WHERE source=? AND source_id=? ORDER BY confidence DESC LIMIT 8",
                    (source, str(doc_id)),
                ).fetchall()
                cuis = [r["cui"] for r in rows if r["cui"]]
            finally:
                c.close()
        except sqlite3.Error:
            pass
    if not cuis and _PARAGRAPH_CONCEPTS_DB.exists():
        try:
            p = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True)
            p.row_factory = sqlite3.Row
            try:
                rows = p.execute(
                    """
                    SELECT cui FROM paragraph_concepts
                    WHERE source=? AND source_id=?
                      AND semantic_group IN ('disease','finding','pathology','drug','procedure')
                    ORDER BY hit_count DESC, confidence DESC LIMIT 6
                    """,
                    (source, str(doc_id)),
                ).fetchall()
                cuis = [r["cui"] for r in rows if r["cui"]]
            finally:
                p.close()
        except sqlite3.Error:
            pass
    return cuis


def _related_balanced(source: str, doc_id: str | int, per_source: int = 6) -> dict[str, list[dict]]:
    """Related content in EVERY source that shares a UMLS concept with this doc.

    Balanced top-N per source (a window over paragraph_concepts) so a high-volume
    source like books can't crowd the others out. Being CUI-based, it spans every
    source in the hub — including the ones concept_links never covered (uworld,
    qbank, drugs, firstaid, diseases). concept_links is folded in afterwards purely
    as a quality boost for the amboss↔utd title-embedding pairs.
    """
    cuis = _doc_cuis(source, doc_id)
    groups: dict[str, list[dict]] = {}
    seen: set[tuple[str, str]] = {(source, str(doc_id))}

    if cuis and _PARAGRAPH_CONCEPTS_DB.exists() and _GLOBAL_SEARCH_DB.exists():
        try:
            p = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True)
            p.row_factory = sqlite3.Row
            try:
                p.execute("ATTACH DATABASE ? AS gs", (f"file:{_GLOBAL_SEARCH_DB.as_posix()}?mode=ro",))
                placeholders = ",".join("?" for _ in cuis)
                rows = p.execute(
                    f"""
                    WITH shared AS (
                      SELECT source, source_id,
                             MAX(hit_count) AS hit_count, AVG(confidence) AS confidence
                      FROM paragraph_concepts
                      WHERE cui IN ({placeholders}) AND source != 'firstaid_full'
                        AND NOT (source=? AND source_id=?)
                      GROUP BY source, source_id
                    ),
                    ranked AS (
                      SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY source ORDER BY hit_count DESC, confidence DESC
                      ) AS rn FROM shared
                    )
                    SELECT r.source AS source, r.source_id AS source_id,
                           e.title AS title, e.href AS href,
                           r.hit_count AS hit_count, r.confidence AS confidence
                    FROM ranked r
                    JOIN gs.entries e ON e.source=r.source AND e.external_id=r.source_id
                    WHERE r.rn <= ?
                    ORDER BY r.source, r.hit_count DESC
                    """,
                    (*cuis, source, str(doc_id), per_source),
                ).fetchall()
                for r in rows:
                    key = (r["source"], str(r["source_id"]))
                    if key in seen:
                        continue
                    seen.add(key)
                    groups.setdefault(r["source"], []).append({
                        "source": r["source"],
                        "id": str(r["source_id"]),
                        "title": r["title"] or "",
                        "href": r["href"] or "#",
                        "similarity": round(float(r["confidence"] or 0.6), 3),
                    })
            finally:
                p.close()
        except sqlite3.Error:
            pass

    if CONCEPT_LINKS_DB.exists():
        try:
            c = sqlite3.connect(f"file:{CONCEPT_LINKS_DB}?mode=ro", uri=True)
            c.row_factory = sqlite3.Row
            try:
                rows = c.execute(
                    """
                    SELECT source_b AS src, id_b AS eid, title_b AS title, similarity
                    FROM concept_links WHERE source_a=? AND id_a=?
                    UNION ALL
                    SELECT source_a AS src, id_a AS eid, title_a AS title, similarity
                    FROM concept_links WHERE source_b=? AND id_b=?
                    ORDER BY similarity DESC LIMIT ?
                    """,
                    (source, str(doc_id), source, str(doc_id), per_source * 3),
                ).fetchall()
            finally:
                c.close()
            for r in rows:
                src = r["src"]
                eid = str(r["eid"])
                key = (src, eid)
                if key in seen:
                    continue
                grp = groups.setdefault(src, [])
                if len(grp) >= per_source:
                    continue
                seen.add(key)
                href = (
                    f"/amboss?doc={eid}"   if src == "amboss"  else
                    f"/uptodate?t={eid}"   if src == "utd"     else
                    f"/library/uworld?doc={eid}" if src == "uworld" else
                    f"/library?path={eid}" if src == "books"   else
                    f"#{eid}"
                )
                grp.append({
                    "source": src,
                    "id": eid,
                    "title": r["title"] or "",
                    "href": href,
                    "similarity": round(float(r["similarity"]), 3),
                })
        except Exception:
            pass

    for src in list(groups.keys()):
        groups[src].sort(key=lambda it: -float(it.get("similarity") or 0))
        groups[src] = groups[src][:per_source]
    return groups


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("")
def unified_search(
    q: str         = Query(..., min_length=1, max_length=200),
    scopes: str    = Query(default="all"),
    grouped: bool  = Query(default=True),
    limit: int     = Query(default=30, ge=1, le=100),
    fast: bool      = Query(default=False),
):
    """
    Unified search across all sources.

    When grouped=true (default) returns:
      { definition, groups: {utd:[...], amboss:[...], books:[...], calc:[...]} }
    When grouped=false returns flat list (legacy dashboard format).
    """
    query   = q.strip()
    qn      = _normalize(query)
    scope_s = _scope_set(scopes)

    cache_key = (query.lower(), scopes, grouped, limit, fast)
    _cached = _cache_get(cache_key)
    if _cached is not None:
        return _cached

    # Definition chip (from abbreviation / exact term match). Skipped in fast
    # (autocomplete) mode — its UMLS/glossary database lookups are a cold-cache
    # cost; the follow-up full search fills it in.
    definition = None if fast else (
        _umls_definition_chip(query)
        or _umls_definition_chip(qn)
        or _glossary_chip(query)
        or _glossary_chip(qn)
    )
    phenotype_action = _phenotype_bundle_action(query, include_conditions=not fast)

    if not grouped:
        index_results = _query_global_index(query, qn, scope_s, limit, fast=fast)
        if index_results is not None:
            suggestions = _search_suggestions(query, qn, scope_s, fast=fast)
            suggestions = _with_definition_expansion(suggestions, definition, query)
            suggestions = _prefer_known_abbreviation(suggestions, query)
            if _enabled(scope_s, "uworld"):
                seen_source_items = {
                    (
                        str(item.get("scope") or ""),
                        str(item.get("kind") or ""),
                        str(item.get("id") or item.get("href") or item.get("title") or ""),
                    )
                    for item in index_results
                }
                uworld_hits = _query_uworld_library(query, qn, min(max(limit, 8), 24))
                for item in uworld_hits:
                    item_key = (
                        str(item.get("scope") or ""),
                        str(item.get("kind") or ""),
                        str(item.get("id") or item.get("href") or item.get("title") or ""),
                    )
                    if item_key in seen_source_items:
                        continue
                    seen_source_items.add(item_key)
                    text_n = _normalize(item.get("search_text") or item.get("title") or "")
                    index_results.append({**item, "score": round(_score(qn, text_n) + 185.0, 2)})
                if uworld_hits:
                    index_results = _rank_flat_results(index_results, query, qn, limit)
            if _umls_scope_enabled(scope_s) and not fast:
                index_results = _rank_flat_results(
                    [*index_results, *_query_umls_concepts(query, qn, min(max(limit // 2, 6), 12))],
                    query,
                    qn,
                    limit,
                )
            if phenotype_action:
                index_results = [
                    phenotype_action,
                    *[
                        item for item in index_results
                        if not (item.get("scope") == "differential" and item.get("kind") == "phenotype_bundle")
                    ],
                ][:limit]
            _result = {
                "query": query,
                "suggestion": suggestions[0] if suggestions else (None if fast else _index_suggestion(qn, scope_s)),
                "suggestions": suggestions,
                "definition": definition,
                "results": [_result_payload(r, with_umls=not fast) for r in index_results],
            }
            _cache_put(cache_key, _result)
            return _result

    query_variants = _query_variants(query)
    if fast and not _looks_like_abbreviation(query):
        query_variants = [query]

    candidates: list[dict] = []
    source_limit = max(8, min(limit, 14 if fast else 36))
    if phenotype_action:
        candidates.append(phenotype_action)
    if _umls_scope_enabled(scope_s):
        candidates.extend(_query_umls_concepts(query, qn, min(source_limit, 12)))

    for variant in query_variants:
        vn = _normalize(variant)
        if _enabled(scope_s, "amboss"):
            candidates.extend(_query_amboss(variant, vn, source_limit))
        if _enabled(scope_s, "uworld"):
            candidates.extend(_query_uworld_library(variant, vn, source_limit))
        if _enabled(scope_s, "uptodate"):
            candidates.extend(_query_utd(variant, vn, source_limit))
        if _enabled(scope_s, "firstaid"):
            candidates.extend(_query_firstaid(vn, source_limit))
    if _enabled(scope_s, "books"):
        candidates.extend(_query_books(qn, source_limit))
        candidates.extend(_query_book_chapters(qn, max(limit * (2 if fast else 3), 24 if fast else 42)))
    if _enabled(scope_s, "drugs"):
        candidates.extend(_query_drugs(qn, max(source_limit, 10)))
    if _enabled(scope_s, "sanford"):
        candidates.extend(_query_sanford(qn, max(source_limit, 10)))
    if _enabled(scope_s, "utdddx"):
        candidates.extend(_query_utdddx(qn, max(source_limit, 10)))
    if _enabled(scope_s, "calc"):
        candidates.extend(_query_calcs(qn, source_limit))
    if _enabled(scope_s, "lexi"):
        candidates.extend(_query_lexi(query, qn, source_limit))
    if _enabled(scope_s, "anatomy") and (not fast or scope_s == {"anatomy"}):
        candidates.extend(_query_anatomy(qn, source_limit))
    if _enabled(scope_s, "diseases") and (not fast or scope_s == {"diseases"}):
        candidates.extend(_query_diseases(qn, source_limit))
        if not fast or scope_s == {"diseases"}:
            for variant in query_variants:
                vn = _normalize(variant)
                if vn:
                    candidates.extend(_query_cliniccons_images(vn, source_limit))
    if _enabled(scope_s, "qbank"):
        if not fast or scope_s == {"qbank"}:
            for variant in query_variants:
                vn = _normalize(variant)
                if vn:
                    candidates.extend(_query_uworld_tables(vn, source_limit))
        if not fast:
            candidates.extend(_query_qbank(qn, source_limit))
    # Glossary/abbreviation rows intentionally stay out of the result list.
    # They power the definition chip and query expansion above; clicking them
    # led to "#abbrev" dead-ends in the dashboard.
    candidates = [item for item in candidates if item.get("scope") != "abbrev"]

    # High-confidence topic→specialty signal: Harrison leads by default, the
    # owning specialty's standard (Brenner for kidney) surges for its topics.
    query_subject = _infer_query_subject(qn, candidates)

    # Score, deduplicate
    ranked: list[dict] = []
    seen: set[tuple] = set()
    for item in candidates:
        text_n = _normalize(item.get("search_text") or item.get("title") or "")
        sc = _score(qn, text_n)
        for variant in query_variants[1:]:
            vn = _normalize(variant)
            if not vn:
                continue
            variant_tokens = [tok for tok in vn.split() if len(tok) > 2]
            if variant_tokens and not any(tok in text_n.split() for tok in variant_tokens):
                continue
            sc = max(sc, _score(vn, text_n) + 35.0)
            if vn in text_n:
                sc += 35.0
        if sc < 20:
            continue
        if item["scope"] == "drugs":
            q_tokens = [tok for tok in qn.split() if tok]
            text_tokens = text_n.split()
            token_prefix_hit = all(
                any(tt == qt or tt.startswith(qt) for tt in text_tokens)
                for qt in q_tokens
            ) if q_tokens else True
            if not token_prefix_hit:
                sc -= 240.0
            # Medication lookups should put the local drug database ahead of
            # article hits when a generic or brand name is available.
            sc += 360.0 if token_prefix_hit else 80.0
            title_n = _normalize(item.get("title", ""))
            if token_prefix_hit and (title_n == qn or title_n.startswith(qn)):
                sc += 170.0
        elif item["scope"] in {"uptodate", "utd"}:
            sc += 210.0
        elif item["scope"] == "amboss":
            sc += 190.0
        elif item["scope"] == "uworld":
            sc += 185.0
        elif item["scope"] == "firstaid":
            sc += 360.0
            title_n = _normalize(item.get("title", ""))
            if title_n == qn:
                sc += 240.0
            elif title_n.startswith(qn):
                sc += 150.0
        elif item["scope"] == "differential":
            sc += 900.0
        elif item["scope"] == "umls":
            sc += 460.0
            group = str(item.get("kind") or item.get("semantic_group") or "")
            if group in {"disease", "finding", "pathology"}:
                sc += 160.0
            title_n = _normalize(item.get("title", ""))
            if title_n == qn:
                sc += 260.0
            elif title_n.startswith(qn):
                sc += 180.0
        elif item["scope"] == "books" and item.get("kind") == "chapter":
            depth = int(item.get("depth") or 0)
            sc += 24.0
            sc += max(0.0, 34.0 - (depth * 7.0))
            # Gold-standard priority: Harrison leads most topics; the owning
            # specialty's standard (Brenner for kidney) surges for its own topics.
            sc += _book_priority_bonus(item, query_subject)
            if item.get("has_children"):
                sc += 18.0
        elif item["scope"] == "books":
            sc -= 15.0
            sc += _book_priority_bonus(item, query_subject)
        elif item["scope"] == "calc":
            sc += 110.0
        elif item["scope"] == "lexi":
            sc += 95.0
        elif item["scope"] == "anatomy":
            sc += 70.0
        elif item["scope"] == "diseases":
            sc += 85.0
        elif item["scope"] == "qbank":
            if item.get("kind") == "uworld_table":
                sc += 135.0
            elif item.get("kind") == "question":
                sc -= 90.0
            else:
                sc += 10.0
        if sc < 20:
            continue
        key = (
            item["scope"],
            item.get("kind", ""),
            str(item.get("id") or item.get("href") or ""),
            item["title"].lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        ranked.append({**item, "score": round(sc, 2)})

    ranked.sort(key=lambda x: (-x["score"], x["title"].lower()))

    # Spell suggestion
    suggestion = _abbr_suggestion(query)
    titles_n = [_normalize(i["title"]) for i in candidates]
    if not suggestion and qn not in titles_n:
        token_suggestions = sorted(
            {
                word
                for cand in candidates
                for word in re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", cand.get("title", ""))
                if len(qn) >= 2 and _normalize(word).startswith(qn) and _normalize(word) != qn
            },
            key=lambda title: (len(title), title.lower()),
        )
        prefix_suggestions = sorted(
            [
                cand["title"]
                for cand in candidates
                if _normalize(cand.get("title", "")).startswith(qn)
                and _normalize(cand.get("title", "")) != qn
                and not (" " not in qn and _normalize(cand.get("title", "")).startswith(f"{qn} "))
            ],
            key=lambda title: (len(title), title.lower()),
        )
        if token_suggestions:
            suggestion = token_suggestions[0]
        elif prefix_suggestions:
            suggestion = prefix_suggestions[0]
        else:
            close = difflib.get_close_matches(qn, titles_n, n=1, cutoff=0.74)
            close_value = close[0] if close else ""
            for cand in candidates:
                if _normalize(cand["title"]) == close_value:
                    suggestion = cand["title"]
                    break
        if suggestion:
            for cand in candidates:
                if _normalize(cand["title"]) == _normalize(suggestion):
                    suggestion = cand["title"]
                    break

    if not grouped:
        flat_ranked = _rank_flat_results(ranked, query, qn, limit)
        chapter_hits = [r for r in ranked if r.get("scope") == "books" and r.get("kind") == "chapter"]
        if chapter_hits and not any(r.get("kind") == "chapter" for r in flat_ranked):
            reserve = min(3, len(chapter_hits), max(limit // 5, 1))
            non_chapter = [
                r for r in flat_ranked
                if not (r.get("scope") == "books" and r.get("kind") == "chapter")
            ][:max(limit - reserve, 0)]
            flat_ranked = (non_chapter + chapter_hits[:reserve])[:limit]
        _result = {
            "query": query,
            "suggestion": suggestion,
            "suggestions": _search_suggestions(query, qn, scope_s),
            "definition": definition,
            "results": [_result_payload(r) for r in flat_ranked],
        }
        _cache_put(cache_key, _result)
        return _result

    # Group by source
    groups: dict[str, list[dict]] = {
        "umls": [], "sanford": [], "firstaid": [], "drugs": [], "utdddx": [], "utd": [], "amboss": [], "uworld": [], "books": [], "calc": [],
        "lexi": [], "anatomy": [], "diseases": [], "differential": [], "qbank": [], "abbrev": [],
    }
    for item in ranked:
        grp = _source_group(item)
        if grp in groups and len(groups[grp]) < 10:
            entry: dict = _result_payload(item)
            if item["scope"] == "drugs":
                entry["has_black_box"] = item.get("has_black_box", False)
                entry["dose_snippet"]  = item.get("dose_snippet", "")
                entry["brand_names"]   = item.get("brand_names", "")
                entry["drug_class"]    = item.get("drug_class", "")
            if item.get("preview"):
                entry["preview"] = item["preview"]
            groups[grp].append(entry)

    _result = {
        "query": query,
        "suggestion": suggestion,
        "suggestions": _search_suggestions(query, qn, scope_s),
        "definition": definition,
        "groups": groups,
        "total": sum(len(v) for v in groups.values()),
    }
    _cache_put(cache_key, _result)
    return _result


@router.get("/concept")
def search_concept(q: str = Query(..., min_length=1, max_length=200)):
    """Resolve the page query for Concept Graph and cross-library media panels."""
    query = re.sub(r"\s+", " ", q or "").strip()
    concept = _resolve_search_concept(query)
    if not concept:
        raise HTTPException(status_code=404, detail="Clinical concept not found")
    return {"query": query, "concept": concept}


@router.get("/page")
def search_page(
    q: str = Query(..., min_length=1, max_length=200),
    offset: int = Query(default=0, ge=0, le=_SEARCH_PAGE_OFFSET_MAX),
    limit: int = Query(default=20, ge=1, le=_SEARCH_PAGE_LIMIT_MAX),
    scopes: str = Query(default="all"),
    kinds: str = Query(default="all"),
):
    """Return one stable, bounded page from the flat global search index."""
    query = q.strip()
    qn = _normalize(query)
    if not qn:
        raise HTTPException(status_code=422, detail="Search query must contain letters or numbers")

    scope_set = _validated_page_scopes(scopes)
    kind_set = _validated_page_kinds(kinds)
    normalized_scopes = tuple(sorted(scope_set))
    normalized_kinds = tuple(sorted(kind_set)) if kind_set is not None else ("all",)
    cache_key = ("page", qn, normalized_scopes, normalized_kinds, offset, limit)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    candidate_window = offset + limit + 1
    candidates = _query_global_index(
        query,
        qn,
        scope_set,
        candidate_window,
        page=True,
        candidate_window=candidate_window,
        kinds=kind_set,
    ) or []

    source_facets: dict[str, int] = {}
    kind_facets: dict[str, int] = {}
    for item in candidates:
        source = _source_group(item)
        kind = str(item.get("kind") or "")
        source_facets[source] = source_facets.get(source, 0) + 1
        kind_facets[kind] = kind_facets.get(kind, 0) + 1

    page_results = candidates[offset:offset + limit]
    result = {
        "query": qn,
        "offset": offset,
        "limit": limit,
        "results": [_result_payload(item, with_umls=False) for item in page_results],
        "has_more": len(candidates) > offset + limit,
        "facets": {
            "sources": dict(sorted(source_facets.items())),
            "kinds": dict(sorted(kind_facets.items())),
        },
    }
    _cache_put(cache_key, result)
    return result


@router.get("/related")
def related_sources(
    source: str     = Query(..., description="Source of the current article: utd | amboss | uworld | qbank | books ..."),
    id: str         = Query(..., description="Article / topic ID in that source"),
    per_source: int = Query(default=6, ge=1, le=20, description="Max related items returned per source"),
    limit: int      = Query(default=20, ge=1, le=80, description="Deprecated; kept for back-compat, no longer trims per-source coverage"),
):
    """
    Return parallel titles in EVERY source that shares a UMLS concept with this
    article — balanced per source so each database is represented. Powers the
    RelatedRail component in the reader views.
    """
    grouped = _related_balanced(source, id, per_source=per_source)
    return {
        "source": source,
        "id": id,
        "related": grouped,
        "total": sum(len(v) for v in grouped.values()),
    }


# ── Cross-library "same article" link (AMBOSS lib ⇄ UWorld lib) ──────────────
# 289 articles share an exact title between the two reference libraries. While
# reading one, this resolves the identical article in the other so the reader can
# offer a direct "open the same article over there" jump (distinct from the
# CUI-based RelatedRail, which surfaces *related* — not identical — topics).

def _amboss_lib_db() -> Path | None:
    p = AMBOSS_DIR / "amboss-2025.db"
    return p if p.exists() else None


@lru_cache(maxsize=1)
def _uworld_lib_title_to_id() -> dict[str, int]:
    db = _uworld_library_db()
    if not db:
        return {}
    out: dict[str, int] = {}
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        for did, title in c.execute("SELECT id, title FROM Docs WHERE title IS NOT NULL"):
            n = _normalize(title)
            if n and n not in out:
                out[n] = int(did)
    finally:
        c.close()
    return out


@lru_cache(maxsize=1)
def _amboss_lib_title_to_id() -> dict[str, int]:
    db = _amboss_lib_db()
    if not db:
        return {}
    out: dict[str, int] = {}
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        for did, title in c.execute("SELECT id, title FROM Docs WHERE title IS NOT NULL"):
            n = _normalize(title)
            if n and n not in out:
                out[n] = int(did)
    finally:
        c.close()
    return out


def _doc_title(db: Path | None, doc_id: str | int) -> str | None:
    if not db:
        return None
    try:
        did = int(str(doc_id).strip())
    except (TypeError, ValueError):
        return None
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = c.execute("SELECT title FROM Docs WHERE id=?", (did,)).fetchone()
    finally:
        c.close()
    return row[0] if row and row[0] else None


@router.get("/counterpart")
def article_counterpart(
    source: str = Query(..., description="amboss | uworld"),
    id: str     = Query(..., description="Article (Docs.id) in that source"),
):
    """The same article (exact normalized title) in the sibling reference library."""
    s = (source or "").lower()
    if s == "amboss":
        title = _doc_title(_amboss_lib_db(), id)
        did = _uworld_lib_title_to_id().get(_normalize(title or "")) if title else None
        if did is not None:
            return {"counterpart": {
                "source": "uworld", "id": did, "title": title,
                "href": f"/library/uworld?doc={did}", "label": "UWorld Library",
            }}
    elif s in ("uworld", "uworld-library"):
        title = _doc_title(_uworld_library_db(), id)
        did = _amboss_lib_title_to_id().get(_normalize(title or "")) if title else None
        if did is not None:
            return {"counterpart": {
                "source": "amboss", "id": did, "title": title,
                "href": f"/amboss?doc={did}", "label": "AMBOSS",
            }}
    return {"counterpart": None}


@router.get("/legacy")
def dashboard_search_legacy(
    q: str     = Query(..., min_length=1, max_length=200),
    scopes: str = Query(default="all"),
    limit: int  = Query(default=18, ge=1, le=50),
):
    """
    Drop-in replacement for the old /dashboard/search endpoint.
    Keeps the flat {results, suggestion} shape the current frontend expects.
    """
    result = unified_search(q=q, scopes=scopes, grouped=False, limit=limit, fast=True)
    return {
        "query": result["query"],
        "suggestion": result.get("suggestion"),
        "suggestions": result.get("suggestions", []),
        "results": result.get("results", []),
    }

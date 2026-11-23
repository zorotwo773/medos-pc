"""
Central reference scanner for MedOS hover boxes.

This route builds a single in-memory term map from the persistent reference
entity graph, scans rendered text once, and returns a source-balanced tooltip
payload for hover cards. Source-specific tooltip/article routes are used as
rich-content enrichment by the frontend.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import threading
import unicodedata
from html import escape, unescape
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

import amboss_reader
import cliniccons_reader
import firstaid
import qbank_reader
import utd_reader
import umls_reader
from config import DRUG_REF_DB, GLOBAL_SEARCH_DB, UMLS_DB
from config import REFERENCE_ENTITIES_DB, REFERENCE_LOOKUP_DB


router = APIRouter(prefix="/reference", tags=["Reference Hover"])

QBankDb = Literal["step1", "step2", "step3"]
ROOT = Path(__file__).resolve().parents[2]
REFERENCE_DB = REFERENCE_ENTITIES_DB
PARAGRAPH_CONCEPTS_DB = ROOT / "data" / "paragraph_concepts.sqlite"
CONTENT_CONCEPTS_DB = ROOT / "data" / "content_concepts.sqlite"


class ScanRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=120000)
    limit: int = Field(default=160, ge=1, le=500)


_TOKEN_RE = re.compile(r"[A-Za-z0-9À-ÖØ-öø-ÿ]+")
_NON_KEY_CHARS_RE = re.compile(r"[^a-z0-9]+")
_WHITESPACE_RE = re.compile(r"\s+")
_SCAN_STOP_TERMS = {
    "algorithm", "article", "choice", "current", "diagnosis", "disease",
    "disorder", "evaluation", "exposure", "factor", "factors", "image",
    "management", "patient", "patients", "risk", "syndrome", "table",
    "therapy", "treatment",
}
_ABBREVIATION_EXPANSIONS = {
    "dvt": ["deep vein thrombosis", "deep venous thrombosis"],
    "gbs": ["guillain-barré syndrome", "guillain-barre syndrome"],
    "pe": ["pulmonary embolism"],
    "sids": ["sudden infant death syndrome"],
    "tia": ["transient ischemic attack"],
    "vte": ["venous thromboembolism"],
}


@lru_cache(maxsize=262144)
def _fold(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return value.lower()


@lru_cache(maxsize=262144)
def _norm_key(value: str) -> str:
    return _WHITESPACE_RE.sub(" ", _NON_KEY_CHARS_RE.sub(" ", _fold(value))).strip()


@lru_cache(maxsize=262144)
def _term_tokens(value: str) -> tuple[str, ...]:
    return tuple(_norm_key(match.group(0)) for match in _TOKEN_RE.finditer(value or "") if _norm_key(match.group(0)))


def _text_tokens(value: str) -> list[dict]:
    return [
        {"norm": _norm_key(match.group(0)), "raw": match.group(0), "start": match.start(), "end": match.end()}
        for match in _TOKEN_RE.finditer(value or "")
        if _norm_key(match.group(0))
    ]


def _priority(entry: dict) -> int:
    if entry["source"] == "drug":
        return 0
    if entry["source"] == "qbank" and entry.get("kind") == "exhibit":
        return 1
    if entry["source"] == "amboss":
        return 2
    if entry["source"] == "firstaid":
        return 3
    if entry["source"] == "qbank":
        return 4
    if entry["source"] == "cliniccons":
        return 5
    if entry["source"] == "utd":
        return 6
    if entry["source"] == "umls":
        return 7
    return 9


def _reference_conn() -> sqlite3.Connection | None:
    if not REFERENCE_DB.exists():
        return None
    c = sqlite3.connect(f"file:{REFERENCE_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _drug_conn() -> sqlite3.Connection | None:
    if not DRUG_REF_DB.exists():
        return None
    c = sqlite3.connect(f"file:{DRUG_REF_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _lookup_conn() -> sqlite3.Connection | None:
    if not REFERENCE_LOOKUP_DB.exists():
        return None
    c = sqlite3.connect(f"file:{REFERENCE_LOOKUP_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _paragraph_concepts_conn() -> sqlite3.Connection | None:
    if not PARAGRAPH_CONCEPTS_DB.exists():
        return None
    c = sqlite3.connect(f"file:{PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True, timeout=2)
    c.row_factory = sqlite3.Row
    return c


def _json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        data = json.loads(value)
    except Exception:
        return []
    return data if isinstance(data, list) else []


@lru_cache(maxsize=262144)
def _scan_term_ok(term: str, case_sensitive: bool = False) -> bool:
    if re.search(r"\([^)]{1,30}\)", term or ""):
        return False
    key = _norm_key(term)
    if not key or key in _SCAN_STOP_TERMS:
        return False
    tokens = key.split()
    if not tokens:
        return False
    if len(key) < 3 or len(key) > 90:
        return False
    raw = (term or "").strip()
    if len(tokens) == 1 and len(tokens[0]) < 5:
        return bool(case_sensitive or raw.isupper() or key in _ABBREVIATION_EXPANSIONS)
    if all(token in _SCAN_STOP_TERMS for token in tokens):
        return False
    return True


_DRUG_SALT_SUFFIX_RE = re.compile(
    r"\b("
    r"hydrochloride|hcl|hydrobromide|mesylate|besylate|tosylate|tartrate|bitartrate|"
    r"succinate|fumarate|maleate|sulfate|sulphate|phosphate|nitrate|acetate|citrate|"
    r"lactate|gluconate|sodium|potassium|calcium|magnesium|disodium|monohydrate|"
    r"dihydrate|extended release|delayed release"
    r")\b\.?",
    re.IGNORECASE,
)


def _drug_clean_name(value: str) -> str:
    text = unescape(value or "")
    text = re.sub(r"\[[^\]]+\]", " ", text)
    text = re.sub(r"\([^)]*(?:dsc|otc|rx|canada|uk|us)[^)]*\)", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text.replace("&rsquo;", "'")).strip(" ,;")
    return text


def _drug_brand_list(value: str, limit: int = 6) -> list[str]:
    decoded = unescape(value or "")
    brands = [_drug_clean_name(item) for item in re.split(r"[;,]", decoded) if _drug_clean_name(item)]
    return list(dict.fromkeys(brands))[:limit]


def _drug_display_name(generic: str) -> str:
    cleaned = _drug_clean_name(generic)
    without_salt = _DRUG_SALT_SUFFIX_RE.sub(" ", cleaned)
    without_salt = re.sub(r"\s+", " ", without_salt).strip(" ,;/")
    return without_salt if without_salt and len(without_salt) >= 5 else cleaned


def _drug_aliases_from_generic(generic: str) -> list[str]:
    cleaned = _drug_clean_name(generic)
    aliases = [cleaned]
    display = _drug_display_name(cleaned)
    if display and display != cleaned:
        aliases.append(display)
    if "/" in display:
        aliases.extend(part.strip() for part in display.split("/") if part.strip())
    return list(dict.fromkeys(alias for alias in aliases if alias))


def _drug_abstract(
    generic_name: str,
    brand_names: str,
    drug_class: str,
    dose_snippet: str,
    indications: str,
    bbw_snippet: str | None,
    has_black_box: bool,
) -> str:
    bits: list[str] = []
    brands = _drug_brand_list(brand_names, 4)
    title_bits = [generic_name]
    if brands:
        title_bits.append(f"({', '.join(brands[:4])})")
    if drug_class:
        bits.append(f"Class: {drug_class.split('|')[0].strip()}")
    if indications:
        bits.append(f"Indications: {indications[:260]}")
    if dose_snippet:
        bits.append(f"Dose/frequency: {dose_snippet[:280]}")
    if has_black_box or bbw_snippet:
        bits.append(f"Black box warning: {(bbw_snippet or 'Present in drug reference database')[:260]}")
    if not bits:
        bits.append("Drug reference profile available in the local MedOS drug database.")
    return " ".join(bits)


def _compact_text(value: str, max_len: int = 260) -> str:
    text = re.sub(r"\s+", " ", value or "").strip(" ;,-")
    if len(text) <= max_len:
        return text
    clipped = text[:max_len].rsplit(" ", 1)[0].strip(" ;,-")
    return f"{clipped}..."


def _drug_phrase_list(value: str, max_items: int = 5) -> list[str]:
    text = re.sub(r"\bFDA-Labeled Indications\b", " ", value or "", flags=re.IGNORECASE)
    text = re.sub(r"\bNon-FDA Labeled Indications\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip(" ;,")
    if not text:
        return []
    pieces = re.split(r";|\n|(?<!to)\s+(?=[A-Z][A-Za-z/-]{3,})", text)
    out: list[str] = []
    for piece in pieces:
        cleaned = re.sub(r"\s+", " ", piece).strip(" ;,-")
        if not cleaned or len(cleaned) < 4:
            continue
        if cleaned.lower() in {"diagnosis", "prophylaxis", "treatment"}:
            continue
        out.append(_compact_text(cleaned, 90))
        if len(out) >= max_items:
            break
    return list(dict.fromkeys(out))


def _drug_card_html(
    *,
    drug_class: str,
    indications: str,
    dose_snippet: str,
    bbw_snippet: str | None,
    has_black_box: bool,
) -> str:
    class_items = [item.strip() for item in re.split(r"[|;]", drug_class or "") if item.strip()]
    indication_items = _drug_phrase_list(indications, 5)
    dose = _compact_text(dose_snippet, 260)
    bbw = _compact_text(bbw_snippet or "", 240)

    parts: list[str] = ['<div class="medos-drug-card">']
    if class_items:
        parts.append(
            '<section class="medos-drug-row medos-drug-class">'
            '<span class="medos-drug-label">Class:</span>'
            f'<strong>{escape(class_items[0])}</strong>'
            '</section>'
        )
    if dose:
        parts.append(
            '<section class="medos-drug-row medos-drug-dose">'
            '<span class="medos-drug-label">Adult dose:</span>'
            f'<p>{escape(dose)}</p>'
            '</section>'
        )
    if indication_items:
        parts.append(
            '<section class="medos-drug-row medos-drug-uses">'
            '<span class="medos-drug-label">Common uses:</span>'
            '<ul>'
            + ''.join(f'<li>{escape(item)}</li>' for item in indication_items)
            + '</ul>'
            '</section>'
        )
    if has_black_box or bbw:
        parts.append(
            '<section class="medos-drug-row medos-drug-warning">'
            '<span class="medos-drug-label">Black box:</span>'
            f'<p>{escape(bbw or "Black-box warning present in the local drug reference database.")}</p>'
            '</section>'
        )
    parts.append('</div>')
    return ''.join(parts)


def _drug_card_payload(
    *,
    drug_class: str,
    indications: str,
    dose_snippet: str,
    bbw_snippet: str | None,
    has_black_box: bool,
) -> dict:
    class_items = [item.strip() for item in re.split(r"[|;]", drug_class or "") if item.strip()]
    return {
        "drug_class": class_items[0] if class_items else "",
        "adult_dose": _compact_text(dose_snippet, 260),
        "common_uses": _drug_phrase_list(indications, 5),
        "black_box": _compact_text(bbw_snippet or "", 240) if (has_black_box or bbw_snippet) else "",
        "has_black_box": bool(has_black_box or bbw_snippet),
    }


@lru_cache(maxsize=1)
def _drug_scan_entries() -> tuple[dict, ...]:
    c = _drug_conn()
    if c is None:
        return ()
    entries: dict[tuple[str, str, str], dict] = {}
    try:
        rows = c.execute(
            """
            SELECT d.drug_id, d.generic_name, COALESCE(qi.brand_names, '') AS brand_names
            FROM drugs d
            LEFT JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
            WHERE COALESCE(TRIM(d.generic_name), '') <> ''
            """
        ).fetchall()
        brand_rows = c.execute(
            """
            SELECT d.drug_id, d.generic_name, b.brand_name
            FROM drug_brands b
            JOIN drugs d ON d.drug_id = b.drug_id
            WHERE COALESCE(TRIM(b.brand_name), '') <> ''
            """
        ).fetchall()
    finally:
        c.close()

    for row in rows:
        for alias in _drug_aliases_from_generic(row["generic_name"] or ""):
            _add_entry(entries, alias, "drug", "drug")
        for cleaned in _drug_brand_list(row["brand_names"] or "", 20):
            _add_entry(entries, cleaned, "drug", "brand")

    for row in brand_rows:
        cleaned = _drug_clean_name(row["brand_name"] or "")
        if cleaned:
            _add_entry(entries, cleaned, "drug", "brand")

    return tuple(entries.values())


def _link_sort_key_for_scan(link: dict, db: QBankDb) -> tuple[int, int]:
    source = link.get("source") or ""
    kind = link.get("kind") or ""
    current_db_penalty = 0
    if source == "qbank":
        href = link.get("href") or ""
        current_db_penalty = 0 if f"db={db}" in href else 2
    return (_priority({"source": source, "kind": kind}) + current_db_penalty, len(link.get("title") or ""))


@lru_cache(maxsize=4)
def _central_scan_entries(db: QBankDb) -> tuple[dict, ...]:
    c = _reference_conn()
    if c is None:
        return ()
    try:
        alias_rows = c.execute(
            """
            SELECT a.entity_id, a.alias, a.case_sensitive, e.primary_source
            FROM aliases a
            JOIN entities e ON e.entity_id=a.entity_id
            """
        ).fetchall()
        link_rows = c.execute("SELECT entity_id, source, kind, title, href FROM links").fetchall()
    finally:
        c.close()

    links_by_entity: dict[str, list[dict]] = {}
    for row in link_rows:
        links_by_entity.setdefault(row["entity_id"], []).append(dict(row))

    best_by_entity: dict[str, dict] = {}
    for entity_id, links in links_by_entity.items():
        best_by_entity[entity_id] = sorted(links, key=lambda item: _link_sort_key_for_scan(item, db))[0]

    entries: dict[tuple[str, str, str], dict] = {}
    for row in alias_rows:
        alias = row["alias"] or ""
        if not _scan_term_ok(alias, bool(row["case_sensitive"])):
            continue
        best = best_by_entity.get(row["entity_id"]) or {"source": "amboss", "kind": "article"}
        _add_entry(entries, alias, best.get("source") or "amboss", best.get("kind") or "article", bool(row["case_sensitive"]))

    return tuple(entries.values())


def _add_entry(entries: dict[tuple[str, str, str], dict], term: str, source: str, kind: str, case_sensitive: bool = False) -> None:
    if not _scan_term_ok(term, case_sensitive):
        return
    tokens = _term_tokens(term)
    if not tokens:
        return
    key = (" ".join(tokens), source, kind)
    entries.setdefault(
        key,
        {
            "term": term,
            "tokens": tokens,
            "source": source,
            "kind": kind,
            "case_sensitive": bool(case_sensitive),
        },
    )


@lru_cache(maxsize=4)
def _reference_entries(db: QBankDb) -> tuple[dict, ...]:
    entries: dict[tuple[str, str, str], dict] = {}

    for item in _drug_scan_entries():
        _add_entry(entries, item.get("term") or "", "drug", item.get("kind") or "drug")

    for item in firstaid.scan_entries():
        _add_entry(entries, item.get("term") or "", "firstaid", item.get("kind") or "region")

    for item in _central_scan_entries(db):
        _add_entry(entries, item.get("term") or "", item.get("source") or "amboss", item.get("kind") or "article", bool(item.get("case_sensitive")))

    for item in umls_reader.scan_entries():
        _add_entry(
            entries,
            item.get("term") or "",
            "umls",
            item.get("kind") or "concept",
            bool(item.get("case_sensitive")),
        )

    if entries:
        return tuple(sorted(entries.values(), key=lambda item: (-len(item["tokens"]), _priority(item), item["term"].lower())))

    for item in qbank_reader._visual_index(db):  # source index is already filtered.
        _add_entry(entries, item.get("term") or "", "qbank", item.get("kind") or "image")

    # Use the CRX-derived phrase dictionary directly. Calling AMBOSS tooltip
    # validation for every phrase is too expensive during central index build.
    for key, display, case_sensitive in amboss_reader._scan_terms():
        _add_entry(entries, display or key, "amboss", "article", case_sensitive)

    for item in cliniccons_reader._reference_index():
        _add_entry(
            entries,
            item.get("term") or "",
            "cliniccons",
            item.get("kind") or "algorithm",
            bool(item.get("case_sensitive")),
        )

    # UTD topics are broad enough for primary green underlines. Graphics remain
    # available through UTD tooltip enrichment without overwhelming scans.
    for item in utd_reader._topic_index():
        title = item.get("title") or ""
        if utd_reader._hide_from_hover_topic(title):
            continue
        _add_entry(entries, item.get("term") or "", "utd", "topic")

    return tuple(sorted(entries.values(), key=lambda item: (-len(item["tokens"]), _priority(item), item["term"].lower())))


@lru_cache(maxsize=4)
def _entries_by_first_token(db: QBankDb) -> dict[str, tuple[dict, ...]]:
    grouped: dict[str, list[dict]] = {}
    for entry in _reference_entries(db):
        grouped.setdefault(entry["tokens"][0], []).append(entry)
    return {
        token: tuple(sorted(items, key=lambda item: (-len(item["tokens"]), _priority(item), item["term"].lower())))
        for token, items in grouped.items()
    }


# ── Single-flight index build ───────────────────────────────────────────────
# Building the term map costs ~8s of CPU+IO per bank. lru_cache alone does NOT
# deduplicate concurrent cold calls: on app boot the frontend hover warm-up
# fires dozens of /reference/scan requests at once, and every request thread
# ran the same build simultaneously — GIL-thrashing each build into minutes
# and occupying the whole uvicorn threadpool, which starved /qbank/* (bank
# counts crawled, "Start block" hung for minutes). Exactly one thread may
# build per bank; /reference/scan returns {"warming": true} instantly until
# the index is ready, and the frontend already retries un-cached empty scans.
_REF_INDEX_LOCK = threading.Lock()
_REF_INDEX_EVENTS: dict[str, threading.Event] = {}


def _enter_background_thread_mode() -> None:
    """Drop the CURRENT thread to background CPU/IO priority (Windows only).

    Warm-up builders contend with interactive queries for a cold disk at boot;
    background mode makes Windows schedule them behind user-facing work. No-op
    (best-effort) elsewhere.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        THREAD_MODE_BACKGROUND_BEGIN = 0x00010000
        kernel32 = ctypes.windll.kernel32
        kernel32.SetThreadPriority(kernel32.GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN)
    except Exception:
        pass


def reference_index_ready(db: QBankDb) -> bool:
    with _REF_INDEX_LOCK:
        event = _REF_INDEX_EVENTS.get(db)
    return event is not None and event.is_set()


def warm_reference_index(db: QBankDb = "step2") -> None:
    """Build the reference index for one bank, exactly once per process.

    The first caller becomes the builder; concurrent callers block until the
    build finishes. On builder failure the slot is released so a later call
    can retry instead of serving a permanently-empty index.
    """
    with _REF_INDEX_LOCK:
        event = _REF_INDEX_EVENTS.get(db)
        if event is None:
            event = threading.Event()
            _REF_INDEX_EVENTS[db] = event
            is_builder = True
        else:
            is_builder = False
    if not is_builder:
        event.wait()
        return
    try:
        _entries_by_first_token(db)
    except Exception:
        with _REF_INDEX_LOCK:
            _REF_INDEX_EVENTS.pop(db, None)
        event.set()
        raise
    event.set()


def _start_reference_index_build(db: QBankDb) -> None:
    """Kick off a background build unless one is underway (or done) already."""
    with _REF_INDEX_LOCK:
        if db in _REF_INDEX_EVENTS:
            return

    def _build() -> None:
        _enter_background_thread_mode()
        try:
            warm_reference_index(db)
        except Exception as e:
            print(f"[reference] background index build failed for {db}: {e}")

    threading.Thread(target=_build, name=f"ref-index-{db}", daemon=True).start()


def _title_relevance(query: str, title: str) -> int:
    q = _norm_key(query)
    t = _norm_key(title)
    if not q or not t:
        return 0
    if q == t:
        return 240
    if t.startswith(q + " "):
        return 190
    if q in t:
        return 160
    q_words = q.split()
    if not q_words:
        return 0
    hits = sum(1 for word in q_words if word in t)
    return int(115 * hits / len(q_words))


def _lookup_terms(term: str) -> list[str]:
    raw = re.sub(r"\s+", " ", term or "").strip()
    terms = [raw] if raw else []
    for expansion in _ABBREVIATION_EXPANSIONS.get(_norm_key(raw), []):
        terms.append(expansion)
    return list(dict.fromkeys(item for item in terms if item))


def _drug_row_to_match(row: sqlite3.Row) -> dict:
    return {
        "id": int(row["drug_id"]),
        "title": _drug_title(row),
        "href": f"/drugs?id={int(row['drug_id'])}",
        "source": "drug",
        "kind": "drug",
        "subtitle": "Drug reference",
    }


def _drug_title(row: sqlite3.Row) -> str:
    generic = _drug_display_name(row["generic_name"] or "")
    brands = _drug_brand_list(row["brand_names"] or "", 3)
    if brands:
        return f"{generic} ({', '.join(brands[:3])})"
    return generic


def _drug_lookup_score(term: str, row: sqlite3.Row) -> int:
    q = _norm_key(term)
    if not q:
        return 0
    generic = _norm_key(row["generic_name"] or "")
    generic_display = _norm_key(_drug_display_name(row["generic_name"] or ""))
    brands = [_norm_key(item) for item in _drug_brand_list(row["brand_names"] or "", 20)]
    score = 0
    if q == generic or q == generic_display:
        score = max(score, 300)
    if generic.startswith(q + " ") or generic_display.startswith(q + " "):
        score = max(score, 250)
    if q in brands:
        score = max(score, 280)
    if any(brand.startswith(q + " ") for brand in brands):
        score = max(score, 230)
    if q in generic or q in generic_display:
        score = max(score, 170)
    if any(q in brand for brand in brands):
        score = max(score, 175)
    if len(q) < 5 and score < 280:
        score -= 100
    return score


def _drug_candidates(term: str, limit: int = 4) -> list[sqlite3.Row]:
    c = _drug_conn()
    if c is None:
        return []
    query = _drug_clean_name(term)
    qn = _norm_key(query)
    if not qn:
        c.close()
        return []
    rows: list[sqlite3.Row] = []
    seen: set[int] = set()
    try:
        def add_candidates(items: list[sqlite3.Row]) -> None:
            for item in items:
                did = int(item["drug_id"])
                if did in seen:
                    continue
                seen.add(did)
                rows.append(item)

        add_candidates(c.execute(
            """
            SELECT d.drug_id, d.generic_name, COALESCE(qi.brand_names, '') AS brand_names,
                   COALESCE(qi.drug_class, d.drug_class, '') AS drug_class,
                   COALESCE(qi.dose_snippet, '') AS dose_snippet,
                   qi.bbw_snippet, d.has_black_box, d.utd_topic_id
            FROM drugs d
            LEFT JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
            WHERE lower(d.generic_name) = lower(?)
               OR lower(d.generic_name) LIKE lower(?)
            LIMIT 12
            """,
            (query, f"{query} %"),
        ).fetchall())
        add_candidates(c.execute(
            """
            SELECT d.drug_id, d.generic_name, COALESCE(qi.brand_names, '') AS brand_names,
                   COALESCE(qi.drug_class, d.drug_class, '') AS drug_class,
                   COALESCE(qi.dose_snippet, '') AS dose_snippet,
                   qi.bbw_snippet, d.has_black_box, d.utd_topic_id
            FROM drug_brands b
            JOIN drugs d ON d.drug_id = b.drug_id
            LEFT JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
            WHERE lower(b.brand_name) = lower(?)
               OR lower(b.brand_name) LIKE lower(?)
            LIMIT 12
            """,
            (query, f"{query} %"),
        ).fetchall())
        if len(rows) < limit:
            fts_q = re.sub(r"[^\w\s]", "", query).strip()
            if fts_q:
                try:
                    add_candidates(c.execute(
                        """
                        SELECT d.drug_id, d.generic_name, COALESCE(qi.brand_names, '') AS brand_names,
                               COALESCE(qi.drug_class, d.drug_class, '') AS drug_class,
                               COALESCE(qi.dose_snippet, '') AS dose_snippet,
                               qi.bbw_snippet, d.has_black_box, d.utd_topic_id
                        FROM drug_fts
                        JOIN drugs d ON d.drug_id = drug_fts.drug_id
                        LEFT JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
                        WHERE drug_fts MATCH ?
                        ORDER BY rank
                        LIMIT 24
                        """,
                        (fts_q + "*",),
                    ).fetchall())
                except sqlite3.OperationalError:
                    pass
    finally:
        c.close()

    scored = [(score, row) for row in rows if (score := _drug_lookup_score(term, row)) > 0]
    scored.sort(key=lambda item: (-item[0], len(item[1]["generic_name"] or "")))
    return [row for _score, row in scored[:limit]]


def _drug_section_text(drug_id: int, section_keys: tuple[str, ...]) -> str:
    c = _drug_conn()
    if c is None:
        return ""
    try:
        placeholders = ",".join("?" for _ in section_keys)
        rows = c.execute(
            f"""
            SELECT section_key, content_text
            FROM drug_sections
            WHERE drug_id = ? AND section_key IN ({placeholders})
            ORDER BY CASE section_key
              WHEN 'indications' THEN 0
              WHEN 'adult_dosing' THEN 1
              WHEN 'black_box_warning' THEN 2
              ELSE 3
            END
            """,
            (drug_id, *section_keys),
        ).fetchall()
    finally:
        c.close()
    for row in rows:
        text = re.sub(r"\s+", " ", row["content_text"] or "").strip()
        if text:
            return text
    return ""


def _drug_tooltip(term: str, limit: int) -> dict | None:
    rows = _drug_candidates(term, max(4, min(limit, 8)))
    if not rows:
        return None
    primary = rows[0]
    drug_id = int(primary["drug_id"])
    indications = _drug_section_text(drug_id, ("indications",))
    dose = primary["dose_snippet"] or _drug_section_text(drug_id, ("adult_dosing", "pediatric_dosing"))
    bbw = primary["bbw_snippet"] or _drug_section_text(drug_id, ("black_box_warning",))
    matches: list[dict] = []
    seen_match_titles: set[str] = set()
    for row in rows:
        match = _drug_row_to_match(row)
        title_key = _norm_key(match["title"])
        if title_key in seen_match_titles:
            continue
        seen_match_titles.add(title_key)
        matches.append(match)
    if primary["utd_topic_id"]:
        matches.append({
            "id": int(primary["utd_topic_id"]),
            "title": f"{_drug_display_name(primary['generic_name'] or '')}: UpToDate drug information",
            "href": f"/uptodate?t={int(primary['utd_topic_id'])}",
            "source": "utd",
            "kind": "topic",
        })
    return {
        "term": term,
        "title": _drug_title(primary),
        "source": "drug",
        "kind": "drug",
        "matches": matches[:limit],
        "abstract": "",
        "drug_card": _drug_card_payload(
            drug_class=primary["drug_class"] or "",
            indications=indications,
            dose_snippet=dose,
            bbw_snippet=bbw,
            has_black_box=bool(primary["has_black_box"]),
        ),
        "html": _drug_card_html(
            drug_class=primary["drug_class"] or "",
            indications=indications,
            dose_snippet=dose,
            bbw_snippet=bbw,
            has_black_box=bool(primary["has_black_box"]),
        ),
        "media": [],
    }


def _firstaid_match(region: dict) -> dict:
    heading_id = int(region["heading_id"])
    return {
        "id": heading_id,
        "title": region.get("title") or "First Aid",
        "href": f"#firstaid-{heading_id}",
        "source": "firstaid",
        "kind": "region",
    }


def _firstaid_tooltip(term: str, limit: int) -> dict | None:
    regions = list(firstaid.search_regions(term, max(1, min(limit, 8))))
    if not regions:
        return None
    primary = regions[0]
    abstract = re.sub(r"\s+", " ", primary.get("body_text") or "").strip()
    page = int(primary.get("page") or 1)
    return {
        "term": term,
        "title": primary.get("title") or term,
        "source": "firstaid",
        "kind": "region",
        "matches": [_firstaid_match(region) for region in regions[:limit]],
        "abstract": (abstract[:420] + "...") if len(abstract) > 420 else abstract,
        "media": [],
    }


@lru_cache(maxsize=8192)
def _lookup_tooltip(term: str, db: QBankDb, limit: int) -> dict | None:
    key = _norm_key(term)
    if not key:
        return None
    c = _lookup_conn()
    if c is None:
        return None
    try:
        row = c.execute(
            """
            SELECT term, title, primary_source, primary_kind, primary_id, primary_href,
                   primary_def, expansions_json, source_links_json, image_urls_json,
                   related_ids_json
            FROM lookup
            WHERE term_key=?
            LIMIT 1
            """,
            (key,),
        ).fetchone()
    finally:
        c.close()
    if not row:
        return None

    raw_source_links = _json_list(row["source_links_json"])
    source_links: list[dict] = []
    seen_sources: set[str] = set()
    for item in raw_source_links:
        if not isinstance(item, dict):
            continue
        source_name = str(item.get("source") or "")
        dedupe_key = source_name or str(item.get("href") or item.get("title") or "")
        if dedupe_key in seen_sources:
            continue
        seen_sources.add(dedupe_key)
        source_links.append(item)
    matches = [
        {
            "id": _row_id(item.get("id") or item.get("source_id") or item.get("href")),
            "title": item.get("title") or "",
            "href": item.get("href") or "",
            "source": item.get("source") or "",
            "kind": item.get("kind") or "",
        }
        for item in source_links
        if isinstance(item, dict) and (item.get("href") or item.get("title"))
    ][:limit]

    primary_href = row["primary_href"] or ""
    primary_source = row["primary_source"] or "amboss"
    if primary_href and not any(match.get("href") == primary_href for match in matches):
        matches.insert(0, {
            "id": _row_id(row["primary_id"] or primary_href),
            "title": row["title"] or row["term"] or term,
            "href": primary_href,
            "source": primary_source,
            "kind": row["primary_kind"] or "article",
        })

    media = [
        {"title": item.get("title") or "", "url": item.get("url") or ""}
        for item in _json_list(row["image_urls_json"])
        if isinstance(item, dict) and item.get("url")
    ]
    expansions = [str(item) for item in _json_list(row["expansions_json"]) if str(item).strip()]
    abstract = row["primary_def"] or ""
    return {
        "term": term,
        "title": row["title"] or row["term"] or term,
        "source": primary_source,
        "kind": row["primary_kind"] or "article",
        "matches": matches[:limit],
        "abstract": abstract,
        "expansions": expansions,
        "media": media,
        "source_links": source_links[:limit],
        "image_urls": [item["url"] for item in media],
        "primary_source": primary_source,
        "primary_def": abstract,
        "related_ids": _json_list(row["related_ids_json"]),
    }


def _entity_candidates(term: str, max_entities: int = 8) -> list[dict]:
    c = _reference_conn()
    if c is None:
        return []
    norms = [_norm_key(item) for item in _lookup_terms(term)]
    norms = [item for item in dict.fromkeys(norms) if item]
    if not norms:
        return []
    rows: list[sqlite3.Row] = []
    try:
        for key in norms:
            rows.extend(
                c.execute(
                    """
                    SELECT e.entity_id, e.canonical, e.primary_source, e.abstract,
                           a.alias, a.source AS alias_source
                    FROM aliases a
                    JOIN entities e ON e.entity_id=a.entity_id
                    WHERE a.alias_lc=?
                    """,
                    (key,),
                ).fetchall()
            )
        if not rows:
            for key in norms:
                if len(key) < 5:
                    continue
                rows.extend(
                    c.execute(
                        """
                        SELECT entity_id, canonical, primary_source, abstract,
                               canonical AS alias, primary_source AS alias_source
                        FROM entities
                        WHERE canonical_lc=? OR canonical_lc LIKE ? OR canonical_lc LIKE ?
                        LIMIT 30
                        """,
                        (key, f"{key} %", f"% {key}%"),
                    ).fetchall()
                )
    finally:
        c.close()

    qnorm = norms[0]
    scored: dict[str, dict] = {}
    for row in rows:
        canonical = row["canonical"] or ""
        alias = row["alias"] or ""
        canonical_norm = _norm_key(canonical)
        score = max(_title_relevance(term, canonical), _title_relevance(term, alias))
        if _norm_key(alias) in norms:
            score += 120
        if canonical_norm in norms:
            score += 80
        if len(qnorm) <= 4 and canonical_norm == qnorm and canonical_norm not in {"pe", "dvt", "tia", "sids"}:
            score -= 55
        if len(canonical_norm) > len(qnorm) + 4:
            score += 10
        current = scored.get(row["entity_id"])
        if not current or score > current["score"]:
            scored[row["entity_id"]] = {
                "entity_id": row["entity_id"],
                "canonical": canonical,
                "primary_source": row["primary_source"],
                "abstract": row["abstract"] or "",
                "score": score,
            }
    return sorted(scored.values(), key=lambda item: (-item["score"], len(item["canonical"])))[:max_entities]


def _row_id(value: str | int | None) -> int:
    try:
        return int(value or 0)
    except Exception:
        match = re.search(r"\d+", str(value or ""))
        return int(match.group(0)) if match else 0


def _link_relevance(link: dict, entity: dict, term: str, db: QBankDb) -> int:
    source = link.get("source") or ""
    kind = link.get("kind") or ""
    title = link.get("title") or ""
    canonical = entity.get("canonical") or term
    score = int(entity.get("score") or 0)
    score += max(_title_relevance(term, title), _title_relevance(canonical, title))
    if source == "qbank":
        if kind == "exhibit":
            score += 120
        elif kind == "image":
            score += 90
        elif kind == "question":
            score -= 35
        if f"db={db}" in (link.get("href") or ""):
            score += 20
    elif source == "amboss":
        score += 95
    elif source == "cliniccons":
        score += 70 if kind == "algorithm" else 55
        if kind == "algorithm" and _title_relevance(canonical, title) < 80:
            score -= 30
    elif source == "utd":
        score += 65
        score += utd_reader._topic_score(canonical, title)
        if re.search(r"\bcalculator\b", title, re.I):
            score -= 45
        canonical_rel = _title_relevance(canonical, title)
        term_rel = _title_relevance(term, title)
        if _norm_key(term) == "gbs" and _norm_key(canonical) != "gbs" and canonical_rel < 70:
            score -= 400
        elif canonical_rel < 55 and term_rel < 120:
            score -= 180
    return score


def _dynamic_links(entity: dict, term: str, db: QBankDb) -> list[dict]:
    canonical = entity.get("canonical") or term
    out: list[dict] = []
    for lookup in dict.fromkeys([canonical, *_lookup_terms(term)]):
        if not lookup:
            continue
        for doc_id, title, score in amboss_reader._ranked_title_matches(lookup, 3):
            if score >= 68 and _title_relevance(canonical, title) >= 55:
                out.append({
                    "entity_id": entity["entity_id"],
                    "source": "amboss",
                    "source_id": str(doc_id),
                    "kind": "article",
                    "title": title,
                    "href": f"/amboss?doc={doc_id}",
                    "payload_json": "{}",
                })
        for item in utd_reader._topic_matches_for_term(lookup, 6):
            title = item.get("title") or ""
            canonical_rel = _title_relevance(canonical, title)
            term_rel = _title_relevance(term, title)
            if _norm_key(term) == "gbs" and _norm_key(canonical) != "gbs" and canonical_rel < 70:
                continue
            if canonical_rel < 55 and term_rel < 120:
                continue
            out.append({
                "entity_id": entity["entity_id"],
                "source": "utd",
                "source_id": str(item.get("id") or 0),
                "kind": "topic",
                "title": title,
                "href": f"/uptodate?t={int(item.get('id') or 0)}",
                "payload_json": json.dumps(item, ensure_ascii=False),
            })
    return out


def _entity_links(entities: list[dict], term: str, db: QBankDb) -> list[dict]:
    if not entities:
        return []
    c = _reference_conn()
    stored: list[dict] = []
    if c is not None:
        try:
            placeholders = ",".join("?" for _ in entities)
            stored = [
                dict(row)
                for row in c.execute(
                    f"SELECT entity_id, source, source_id, kind, title, href, payload_json FROM links WHERE entity_id IN ({placeholders})",
                    tuple(entity["entity_id"] for entity in entities),
                ).fetchall()
            ]
        finally:
            c.close()
    by_id = {entity["entity_id"]: entity for entity in entities}
    all_links = stored[:]
    if len(stored) < 2:
        for entity in entities:
            all_links.extend(_dynamic_links(entity, term, db))

    seen: set[tuple[str, str, str, str]] = set()
    scored: list[tuple[int, dict]] = []
    for link in all_links:
        entity = by_id.get(link.get("entity_id"))
        if not entity:
            continue
        source = link.get("source") or ""
        href = link.get("href") or ""
        kind = link.get("kind") or ""
        if source == "qbank" and "db=" in href and f"db={db}" not in href:
            # Keep cross-database UWorld visuals only if this concept has no
            # current-database visual; that is better than hiding a useful table.
            has_current = any(
                other.get("source") == "qbank" and f"db={db}" in (other.get("href") or "")
                for other in all_links
            )
            if has_current:
                continue
        if source == "utd" and _link_relevance(link, entity, term, db) < int(entity.get("score") or 0) + 40:
            continue
        key = (source, kind, href, link.get("title") or "")
        if key in seen:
            continue
        seen.add(key)
        scored.append((_link_relevance(link, entity, term, db), link))
    scored.sort(key=lambda item: (-item[0], _priority(item[1]), len(item[1].get("title") or "")))
    return [link for _score, link in scored]


def _balanced_matches(links: list[dict], limit: int) -> list[dict]:
    source_order = ["drug", "qbank", "amboss", "firstaid", "cliniccons", "utd", "umls"]
    chosen: list[dict] = []
    used: set[int] = set()
    for source in source_order:
        for idx, link in enumerate(links):
            if idx in used or link.get("source") != source:
                continue
            if source == "qbank" and link.get("kind") == "question":
                continue
            chosen.append(link)
            used.add(idx)
            break
    for idx, link in enumerate(links):
        if len(chosen) >= limit:
            break
        if idx in used:
            continue
        source = link.get("source")
        kind = link.get("kind")
        if source in {"amboss", "cliniccons", "utd"} and any(item.get("source") == source for item in chosen):
            continue
        if source == "qbank" and any(item.get("source") == "qbank" for item in chosen):
            if kind != "question" or any(item.get("source") == "qbank" and item.get("kind") == "question" for item in chosen):
                continue
        if source == "utd" and any(item.get("source") == "utd" for item in chosen):
            continue
        chosen.append(link)
        used.add(idx)
    return [
        {
            "id": _row_id(link.get("source_id")),
            "title": link.get("title") or "",
            "href": link.get("href") or "",
            "source": link.get("source") or "",
            "kind": link.get("kind") or "",
        }
        for link in chosen
        if link.get("href")
    ]


def _entity_media(entities: list[dict], term: str, db: QBankDb, limit: int = 4) -> list[dict]:
    if not entities:
        return []
    c = _reference_conn()
    if c is None:
        return []
    try:
        placeholders = ",".join("?" for _ in entities)
        rows = [
            dict(row)
            for row in c.execute(
                f"SELECT entity_id, source, title, url FROM media WHERE entity_id IN ({placeholders})",
                tuple(entity["entity_id"] for entity in entities),
            ).fetchall()
        ]
    finally:
        c.close()
    by_id = {entity["entity_id"]: entity for entity in entities}
    scored: list[tuple[int, dict]] = []
    for row in rows:
        entity = by_id.get(row["entity_id"])
        if not entity:
            continue
        if row["source"] == "qbank" and "db=" in row["url"] and f"db={db}" not in row["url"]:
            has_current = any(item["source"] == "qbank" and f"db={db}" in item["url"] for item in rows)
            if has_current:
                continue
        relevance = max(_title_relevance(term, row["title"]), _title_relevance(entity["canonical"], row["title"]))
        if row["source"] == "cliniccons" and relevance < 70:
            continue
        score = relevance
        if row["source"] == "qbank":
            score += 90
        elif row["source"] == "amboss":
            score += 75
        elif row["source"] == "cliniccons":
            score += 30
        scored.append((score, row))
    scored.sort(key=lambda item: (-item[0], item[1]["source"], item[1]["title"]))
    seen: set[str] = set()
    media: list[dict] = []
    for _score, row in scored:
        if row["url"] in seen:
            continue
        seen.add(row["url"])
        media.append({"title": row["title"], "url": row["url"]})
        if len(media) >= limit:
            break
    return media


@router.get("/tooltip")
def tooltip(
    term: str = Query(..., min_length=1, max_length=140),
    db: QBankDb = Query(default="step2"),
    source: str | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=24),
):
    drug_payload = _drug_tooltip(term, limit)
    if drug_payload:
        return drug_payload

    if source == "umls":
        umls_payload = umls_reader.tooltip(term, limit)
        if umls_payload.get("matches") or umls_payload.get("abstract"):
            return umls_payload

    lookup_payload = _lookup_tooltip(term, db, limit)
    if lookup_payload:
        return lookup_payload

    entities = _entity_candidates(term, 8)
    if entities:
        links = _entity_links(entities, term, db)
        matches = _balanced_matches(links, limit)
        primary = matches[0] if matches else None
        best_entity = entities[0]
        return {
            "term": term,
            "title": best_entity["canonical"],
            "source": (primary or {}).get("source") or best_entity.get("primary_source") or source or "amboss",
            "kind": (primary or {}).get("kind") or "article",
            "expansions": _ABBREVIATION_EXPANSIONS.get(_norm_key(term), []),
            "matches": matches,
            "abstract": best_entity.get("abstract") or "",
            "media": _entity_media(entities, term, db),
        }

    firstaid_payload = _firstaid_tooltip(term, limit)
    if firstaid_payload and source in {None, "", "firstaid", "amboss", "qbank", "utd", "cliniccons"}:
        return firstaid_payload

    umls_payload = umls_reader.tooltip(term, limit)
    if umls_payload.get("matches") or umls_payload.get("abstract"):
        return umls_payload

    return {"term": term, "source": source or "amboss", "matches": []}


@lru_cache(maxsize=128)
def _scan_text_cached(db: QBankDb, text: str, limit: int) -> tuple[tuple[int, int, str, str, str], ...]:
    tokens = _text_tokens(text)
    if not tokens:
        return ()

    grouped = _entries_by_first_token(db)
    raw: list[dict] = []

    for idx, token in enumerate(tokens):
        candidates = grouped.get(token["norm"])
        if not candidates:
            continue
        for entry in candidates:
            term_tokens = entry["tokens"]
            end_idx = idx + len(term_tokens)
            if end_idx > len(tokens):
                continue
            if tuple(item["norm"] for item in tokens[idx:end_idx]) != term_tokens:
                continue
            raw_text = text[tokens[idx]["start"]:tokens[end_idx - 1]["end"]]
            if entry.get("case_sensitive") and raw_text != entry["term"]:
                continue
            raw.append({
                "start": tokens[idx]["start"],
                "end": tokens[end_idx - 1]["end"],
                "term": entry["term"],
                "source": entry["source"],
                "kind": entry["kind"],
            })
            break

    raw.sort(key=lambda hit: (-(hit["end"] - hit["start"]), _priority(hit), hit["start"]))
    occupied: list[tuple[int, int]] = []
    matches: list[dict] = []
    for hit in raw:
        if any(hit["start"] < end and hit["end"] > start for start, end in occupied):
            continue
        occupied.append((hit["start"], hit["end"]))
        matches.append(hit)
        if len(matches) >= limit:
            break

    matches.sort(key=lambda hit: (hit["start"], -(hit["end"] - hit["start"])))
    return tuple(
        (hit["start"], hit["end"], hit["term"], hit["source"], hit["kind"])
        for hit in matches
    )


@router.post("/scan")
def scan(req: ScanRequest, db: QBankDb = Query(default="step2")):
    # Never build the index on a request thread: a cold boot fires dozens of
    # scans at once and they would monopolize the threadpool (see the
    # single-flight notes above). Answer "warming" instantly; the frontend
    # doesn't cache empty results, so these documents re-scan once ready.
    if not reference_index_ready(db):
        _start_reference_index_build(db)
        return {"matches": [], "warming": True}
    return {
        "matches": [
            {"start": start, "end": end, "term": term, "source": source, "kind": kind}
            for start, end, term, source, kind in _scan_text_cached(db, req.text, req.limit)
        ]
    }


# Generic UMLS concepts that are technically tagged but make poor underlines
# (they read as ordinary English, not a clickable medical term). Dropped on top
# of the shared _scan_term_ok() / _SCAN_STOP_TERMS rules so the precomputed set
# matches the precision of the live scan.
_DOC_TERM_STOP = {
    "related", "separation", "associated", "association", "history",
    "present", "presentation", "negative", "positive", "normal", "abnormal",
    "secondary", "primary", "complication", "complications", "general",
    "function", "structure", "process", "specific", "result", "results",
    "finding", "findings", "condition", "conditions", "type", "status",
}


@lru_cache(maxsize=8192)
def _doc_terms_cached(source: str, source_id: str, limit: int) -> tuple[dict, ...]:
    """Precomputed concept list for one document, from paragraph_concepts.sqlite.

    Rows are concept-resolved at build time (scripts/umls/tag_paragraphs.py); we
    dedupe by normalized term and apply the same scan-term precision filter the
    live scanner uses, so weak/generic concepts don't become noisy underlines.
    """
    src = (source or "").strip()
    sid = (source_id or "").strip()
    if not src or not sid:
        return ()
    c = _paragraph_concepts_conn()
    if c is None:
        return ()
    try:
        rows = c.execute(
            """
            SELECT matched_term, cui, semantic_group, hit_count
            FROM paragraph_concepts
            WHERE source=? AND source_id=?
            ORDER BY hit_count DESC, length(matched_term) DESC
            LIMIT ?
            """,
            (src, sid, limit),
        ).fetchall()
    except sqlite3.Error:
        return ()
    finally:
        c.close()

    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        term = (row["matched_term"] or "").strip()
        key = _norm_key(term)
        if not term or not key or key in seen:
            continue
        if key in _DOC_TERM_STOP or not _scan_term_ok(term):
            continue
        seen.add(key)
        out.append({
            "term": term,
            "cui": row["cui"] or "",
            "semantic_group": row["semantic_group"] or "",
            "hit_count": int(row["hit_count"] or 1),
        })
    return tuple(out)


@router.get("/doc-terms")
def doc_terms(
    source: str = Query(..., min_length=1, max_length=40),
    id: str = Query(..., min_length=1, max_length=120),
    limit: int = Query(default=80, ge=1, le=200),
):
    """Precomputed concept list for one document (source, source_id).

    Lets the client highlight only this document's known terms instead of POSTing
    the whole article body to /reference/scan. Each term carries its resolved CUI
    so the hover card can resolve in a single call. Returns an empty list when the
    document was never tagged (e.g. Anki cards, which are not in the hub yet).
    """
    # global_search stores UpToDate under the "utd" slug; accept either spelling.
    src = "utd" if source == "uptodate" else source
    return {
        "source": src,
        "source_id": id,
        "terms": list(_doc_terms_cached(src, id, limit)),
    }


# ---------------------------------------------------------------------------
# Centralized concept card (CUI -> the UMLS hub).
#
# The underline FIND step already resolves each term to a CUI (from
# paragraph_concepts, served by /reference/doc-terms). This endpoint turns that
# CUI into the hover CARD by reading the hub directly, so EVERY database that
# mentions the concept is offered as a suggestion — not just whatever the old
# AMBOSS-biased entity graph happened to store. UWorld library, books, diseases,
# etc. appear automatically because they are already tagged in the hub.
# ---------------------------------------------------------------------------

# High-yield surfaces first; the card keeps at most one row per source so the
# small hover box stays diverse (one per DB) instead of, say, six books.
_CARD_SOURCE_ORDER = [
    # 'sanford' sits high so an antibiotic/organism concept card leads with the
    # Sanford monograph (the frontend matchPriority also floats it to the top).
    "qbank", "sanford", "amboss", "uworld", "utd", "utdddx", "firstaid", "diseases", "cliniccons", "books", "drugs",
]
_CARD_DEF_RE = re.compile(r"\s*\[(?:https?://|[A-Z]{2,}[A-Z0-9_:.-]*)[^\]]*\]\s*$")


def _global_search_conn() -> sqlite3.Connection | None:
    if not GLOBAL_SEARCH_DB.exists():
        return None
    c = sqlite3.connect(f"file:{GLOBAL_SEARCH_DB}?mode=ro", uri=True, timeout=3)
    c.row_factory = sqlite3.Row
    return c


def _umls_conn() -> sqlite3.Connection | None:
    if not UMLS_DB.exists():
        return None
    c = sqlite3.connect(f"file:{UMLS_DB}?mode=ro", uri=True, timeout=3)
    c.row_factory = sqlite3.Row
    return c


def _content_concepts_conn() -> sqlite3.Connection | None:
    if not CONTENT_CONCEPTS_DB.exists():
        return None
    c = sqlite3.connect(f"file:{CONTENT_CONCEPTS_DB}?mode=ro", uri=True, timeout=3)
    c.row_factory = sqlite3.Row
    return c


def _kind_from_href(href: str) -> str:
    if "/qbank/exhibit/" in href:
        return "exhibit"
    if "/qbank?" in href:
        return "question"
    if "/uptodate?" in href:
        return "topic"
    if href.startswith("#firstaid-") or "/firstaid" in href:
        return "region"
    if "/diseases?" in href:
        return "disease"
    if "/utdddx?" in href:
        return "ddx"
    if "path=" in href:
        return "chapter"
    return "article"


@lru_cache(maxsize=16384)
def _concept_meta(cui: str) -> tuple[str, str, str]:
    """(preferred_name, cleaned_definition, semantic_group) for a CUI."""
    c = _umls_conn()
    if c is None:
        return ("", "", "")
    try:
        row = c.execute(
            "SELECT preferred_name, definition, semantic_group FROM umls_concepts WHERE cui=?",
            (cui,),
        ).fetchone()
    except sqlite3.Error:
        return ("", "", "")
    finally:
        c.close()
    if not row:
        return ("", "", "")
    definition = _CARD_DEF_RE.sub("", (row["definition"] or "").strip()).strip()
    if len(definition) > 460:
        definition = definition[:460].rsplit(" ", 1)[0].strip() + "..."
    return (row["preferred_name"] or "", definition, row["semantic_group"] or "")


@lru_cache(maxsize=1)
def _media_entries_map() -> dict[tuple[str, str], tuple[str, str, str]]:
    """One-time map of every media-kind global_search entry -> (title, href, kind).

    Mirrors routers/umls.py: lets us look the concept's tagged ids up in O(1)
    instead of joining paragraph_concepts to the un-indexed entries.external_id.
    """
    out: dict[tuple[str, str], tuple[str, str, str]] = {}
    c = _global_search_conn()
    if c is None:
        return out
    try:
        rows = c.execute(
            "SELECT source, external_id, title, href, kind FROM entries "
            "WHERE kind IN ('clinic_image', 'uworld_table')"
        ).fetchall()
    except sqlite3.Error:
        return out
    finally:
        c.close()
    for r in rows:
        out[(r["source"], str(r["external_id"]))] = (r["title"] or "", r["href"] or "", r["kind"] or "")
    return out


def _concept_tagged_pairs(cui: str, limit: int = 240) -> list[tuple[str, str, int]]:
    c = _paragraph_concepts_conn()
    if c is None:
        return []
    try:
        rows = c.execute(
            "SELECT source, source_id, MAX(hit_count) AS hc FROM paragraph_concepts "
            "WHERE cui=? GROUP BY source, source_id ORDER BY hc DESC LIMIT ?",
            (cui, limit),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        c.close()
    return [(r["source"], str(r["source_id"]), int(r["hc"] or 1)) for r in rows]


@lru_cache(maxsize=8192)
def _concept_card_cached(cui: str, db: QBankDb, limit: int) -> dict | None:
    cui = (cui or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", cui):
        return None
    name, definition, semantic_group = _concept_meta(cui)

    pc = _paragraph_concepts_conn()
    if pc is None:
        return None
    try:
        # Balanced: top-2 per source via a window, so rare DBs (UWorld library,
        # AMBOSS) appear next to high-volume ones (books). firstaid_full is the
        # rich-body twin of firstaid; it carries no global_search article row, so
        # we skip it here and rely on the plain `firstaid` source for the link.
        rows = pc.execute(
            """
            SELECT source, source_id, matched_term, hit_count, semantic_group
            FROM (
              SELECT source, source_id, matched_term, hit_count, semantic_group,
                     ROW_NUMBER() OVER (PARTITION BY source ORDER BY hit_count DESC) AS rn
              FROM paragraph_concepts
              WHERE cui=? AND source <> 'firstaid_full'
            )
            WHERE rn <= 2
            ORDER BY hit_count DESC
            """,
            (cui,),
        ).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        pc.close()

    ids_by_source: dict[str, list[str]] = {}
    hits: dict[tuple[str, str], int] = {}
    for row in rows:
        src = row["source"]
        sid = str(row["source_id"])
        ids_by_source.setdefault(src, []).append(sid)
        hits[(src, sid)] = int(row["hit_count"] or 1)

    # Pull titles/hrefs for the balanced set, routing each entry by kind:
    # clinic images -> media thumbnails, exhibits/questions/articles -> matches.
    article_by_source: dict[str, list[dict]] = {}
    exhibits: list[dict] = []
    gs = _global_search_conn()
    if gs is not None:
        try:
            for src, ids in ids_by_source.items():
                placeholders = ",".join("?" for _ in ids)
                erows = gs.execute(
                    f"SELECT source, external_id, title, subtitle, href, kind "
                    f"FROM entries WHERE source=? AND external_id IN ({placeholders})",
                    (src, *ids),
                ).fetchall()
                for er in erows:
                    sid = str(er["external_id"])
                    href = er["href"] or ""
                    kind = er["kind"] or ""
                    if not href or kind == "clinic_image":
                        continue  # clinic images surface as media, handled below
                    item = {
                        "id": _row_id(sid),
                        "title": er["title"] or "",
                        "href": href,
                        "source": src,
                        "kind": "exhibit" if kind == "uworld_table" else kind,
                        "_hit": hits.get((src, sid), 1),
                    }
                    if kind == "uworld_table":
                        exhibits.append(item)
                    else:
                        article_by_source.setdefault(src, []).append(item)
        finally:
            gs.close()

    # Robustness: fold in title-exact concept links (content_concepts.sqlite). These
    # catch any source where the concept IS a titled article but its body was never
    # paragraph-tagged — e.g. an UpToDate topic that exists but wasn't body-indexed.
    # Given a low synthetic hit so a genuinely body-tagged article still leads.
    cc = _content_concepts_conn()
    if cc is not None:
        try:
            cc_rows = cc.execute(
                "SELECT source, source_id, title, href, confidence FROM content_concepts "
                "WHERE cui=? ORDER BY confidence DESC LIMIT 80",
                (cui,),
            ).fetchall()
        except sqlite3.Error:
            cc_rows = []
        finally:
            cc.close()
        existing_hrefs = {it["href"] for items in article_by_source.values() for it in items}
        existing_hrefs.update(it["href"] for it in exhibits)
        for r in cc_rows:
            src = "firstaid" if r["source"] == "firstaid_full" else (r["source"] or "")
            href = r["href"] or ""
            if not src or not href or href in existing_hrefs:
                continue
            kind = _kind_from_href(href)
            # These are title-exact (the concept's canonical article in that source),
            # so lead the source ahead of merely body-tagged, possibly-tangential
            # articles (e.g. prefer the "Normal pressure hydrocephalus" disease page
            # over an "Alzheimer disease" page that just mentions it in a differential).
            item = {"id": _row_id(r["source_id"]), "title": r["title"] or "", "href": href,
                    "source": src, "kind": kind, "_hit": 100000 + int((r["confidence"] or 0) * 1000)}
            existing_hrefs.add(href)
            if kind == "exhibit":
                exhibits.append(item)
            else:
                article_by_source.setdefault(src, []).append(item)

    # One article per source, in clinical-yield order, then any remaining sources.
    matches: list[dict] = []
    seen_href: set[str] = set()

    def _take(item: dict) -> None:
        if item["href"] in seen_href:
            return
        seen_href.add(item["href"])
        matches.append({k: item[k] for k in ("id", "title", "href", "source", "kind")})

    # Lead with the single best UWorld exhibit (the q-bank visual the user wants
    # surfaced on hover, not only after a click).
    if exhibits:
        exhibits.sort(key=lambda it: -it["_hit"])
        _take(exhibits[0])
    for src in _CARD_SOURCE_ORDER:
        for item in sorted(article_by_source.get(src, []), key=lambda it: -it["_hit"]):
            _take(item)
            break
    for src, items in article_by_source.items():
        if len(matches) >= limit:
            break
        if src in _CARD_SOURCE_ORDER:
            continue
        for item in sorted(items, key=lambda it: -it["_hit"]):
            _take(item)
            break

    # Media: real concept images (clinical-consult diagrams) for the hover card.
    media: list[dict] = []
    media_map = _media_entries_map()
    if media_map:
        for src, sid, _hc in _concept_tagged_pairs(cui):
            hit = media_map.get((src, sid))
            if not hit:
                continue
            title, href, kind = hit
            if kind == "clinic_image" and href and href not in {m["url"] for m in media}:
                media.append({"title": title, "url": href})
            if len(media) >= 4:
                break

    if not matches and not media and not definition:
        return None

    return {
        "term": name or cui,
        "title": name or cui,
        "source": "umls",
        "kind": "concept",
        "cui": cui,
        "semantic_group": semantic_group,
        "abstract": definition,
        "expansions": [],
        "matches": matches[:limit],
        "media": media,
    }


@router.get("/concept-card")
def concept_card(
    cui: str = Query(..., min_length=8, max_length=12),
    db: QBankDb = Query(default="step2"),
    limit: int = Query(default=8, ge=1, le=16),
):
    """Centralized hover card for a resolved concept (by CUI).

    Reads the UMLS hub so every database that mentions the concept is offered as
    a suggestion (UWorld library, AMBOSS, UTD, First Aid, diseases, books, drugs,
    UWorld exhibits, clinical images). Returns the same shape as /reference/tooltip
    so the frontend hover renderer is unchanged. Empty when the CUI is unknown.
    """
    payload = _concept_card_cached(cui, db, limit)
    if payload is None:
        return {"term": cui, "source": "umls", "kind": "concept", "matches": [], "media": []}
    return payload

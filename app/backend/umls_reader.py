"""
Read-only helpers for the compact MedOS UMLS SQLite.

Runtime rules:
  - never parse raw UMLS RRF files in request paths
  - keep query expansion capped and cached
  - return empty payloads when data/umls.sqlite is absent
"""
from __future__ import annotations

import json
import re
import sqlite3
import unicodedata
from functools import lru_cache
from typing import Any

from config import UMLS_DB, UMLS_LITE_DB


_NON_KEY_RE = re.compile(r"[^a-z0-9]+")
_WS_RE = re.compile(r"\s+")
_CODE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.-]{1,14}$")
_CONTEXT_ANCHORS = {
    "anemia", "asthma", "cancer", "carcinoma", "diabetes", "disease", "disorder",
    "embolism", "failure", "fever", "hypertension", "infection", "infarction",
    "mellitus", "migraine", "pneumonia", "rash", "seizure", "sepsis", "stroke",
    "syndrome", "thrombosis", "colitis", "crohn", "bowel",
}
_CONTEXT_STOP = {
    "and", "for", "from", "into", "with", "without", "after", "before", "during",
    "initial", "management", "diagnosis", "diagnostic", "treatment", "therapy",
    "agents", "risk", "approach", "evaluation", "differentiating",
}

SEMANTIC_GROUPS = {
    "T047": "disease",
    "T048": "disease",
    "T049": "disease",
    "T019": "disease",
    "T020": "disease",
    "T033": "finding",
    "T034": "finding",
    "T184": "finding",
    "T046": "pathology",
    "T121": "drug",
    "T109": "drug",
    "T200": "drug",
    "T061": "procedure",
    "T060": "procedure",
    "T059": "lab",
    "T201": "lab",
    "T023": "anatomy",
    "T024": "anatomy",
    "T025": "anatomy",
    "T026": "anatomy",
    "T028": "gene",
    "T116": "substance",
    "T123": "substance",
}

SOURCE_LABELS = {
    "SNOMEDCT_US": "SNOMED CT",
    "ICD10CM": "ICD-10-CM",
    "RXNORM": "RxNorm",
    "LNC": "LOINC",
    "HPO": "HPO",
    "OMIM": "OMIM",
    "ORPHANET": "Orphanet",
    "MDR": "MedDRA",
    "NCI": "NCI",
    "MSH": "MeSH",
    "CHV": "CHV",
    "MED-RT": "MED-RT",
    "ATC": "ATC",
    "FMA": "FMA",
    "DRUGBANK": "DrugBank",
    "MTHSPL": "FDA SPL",
    "HGNC": "HGNC",
    "CVX": "CVX",
    "MTH": "UMLS",
}


def _active_db():
    """Prefer the full umls-full pack; fall back to the slim umls_lite.sqlite
    that ships in core. Both expose the same core table names (umls_concepts,
    umls_terms, umls_codes, umls_definitions, umls_scan_terms, umls_terms_fts),
    so resolve/search/autocomplete work unmodified against either — queries
    that touch lite-only-missing tables (umls_relations, HPO) already fail
    through the existing `except sqlite3.Error` paths and degrade to empty."""
    if UMLS_DB.exists():
        return UMLS_DB
    if UMLS_LITE_DB.exists():
        return UMLS_LITE_DB
    return None


def enabled() -> bool:
    return _active_db() is not None


def is_full() -> bool:
    return UMLS_DB.exists()


def active_db_path() -> str:
    db = _active_db()
    return str(db) if db else ""


@lru_cache(maxsize=1)
def metadata() -> dict[str, str]:
    con = _conn()
    if con is None:
        return {}
    try:
        rows = con.execute("SELECT key, value FROM meta").fetchall()
    except sqlite3.Error:
        return {}
    finally:
        con.close()
    return {str(row["key"]): str(row["value"]) for row in rows}


def norm(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    return _WS_RE.sub(" ", _NON_KEY_RE.sub(" ", text)).strip()


def _conn() -> sqlite3.Connection | None:
    db = _active_db()
    if db is None:
        return None
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
    con.row_factory = sqlite3.Row
    return con


def _looks_like_code(value: str | None) -> bool:
    clean = (value or "").strip()
    compact = re.sub(r"[^A-Za-z0-9]", "", clean)
    return bool(compact and len(compact) <= 16 and any(ch.isdigit() for ch in compact) and not re.search(r"\s", clean))


def _json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        data = json.loads(value)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _fts_query(query_norm: str) -> str:
    tokens = re.findall(r"[a-z0-9]+", query_norm or "")
    tokens = [token for token in tokens if len(token) >= 2][:8]
    return " ".join(f"{token}*" for token in tokens)


def _concept_from_row(row: sqlite3.Row) -> dict[str, Any]:
    sty = _json_list(row["semantic_types_json"] if "semantic_types_json" in row.keys() else None)
    return {
        "cui": row["cui"],
        "preferred_name": row["preferred_name"] or "",
        "semantic_group": row["semantic_group"] or "",
        "semantic_types": sty,
        "definition": row["definition"] or "",
        "preferred_source": row["preferred_source"] or "",
    }


def _source_label(sab: str | None) -> str:
    return SOURCE_LABELS.get(sab or "", sab or "")


_CLINICAL_SG = ("disease", "finding", "pathology", "drug", "procedure", "anatomy")


@lru_cache(maxsize=8192)
def autocomplete(prefix: str, limit: int = 8) -> list[dict[str, Any]]:
    """Type-ahead suggestions for a typed term, one row per concept.

    Index-friendly range scan over the (indexed) `umls_terms.term_norm`, deduped by
    CUI. Ranking surfaces what the user most likely means:
      1. EXACT term matches first — so an abbreviation like "PE" yields its
         expansions (Pulmonary embolism, Pleural effusion, …) before "Pea/Peak".
      2. Clinically-relevant semantic groups (disease/finding/drug/…) next.
      3. Defined / preferred / authoritative terms next.
    Falls back to an FTS token search when the prefix scan is sparse (word-order /
    multi-word queries).
    """
    key = norm(prefix)
    if not key or len(key) < 2:
        return []
    con = _conn()
    if con is None:
        return []
    hi = key + "￿"  # captures every term_norm starting with `key`
    clin = ",".join("'" + s + "'" for s in _CLINICAL_SG)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(r: sqlite3.Row) -> None:
        cui = r["cui"]
        if cui in seen:
            return
        seen.add(cui)
        out.append({
            "term": r["term"],
            "cui": cui,
            "semantic_group": r["semantic_group"] or "",
            "preferred_name": r["preferred_name"] or r["term"],
        })

    try:
        rows = con.execute(
            f"""
            SELECT t.term AS term, t.cui AS cui,
                   c.semantic_group AS semantic_group, c.preferred_name AS preferred_name,
                   (t.term_norm = ?) AS exact,
                   (c.semantic_group IN ({clin})) AS clinical,
                   (c.definition IS NOT NULL AND c.definition != '') AS has_def
            FROM umls_terms t
            JOIN umls_concepts c ON c.cui = t.cui
            WHERE t.term_norm >= ? AND t.term_norm < ?
            ORDER BY exact DESC, clinical DESC, has_def DESC, t.is_pref DESC,
                     t.source_rank ASC, length(t.term) ASC
            LIMIT ?
            """,
            (key, key, hi, max(limit, 1) * 10),
        ).fetchall()
        for r in rows:
            _add(r)
            if len(out) >= limit:
                break
    except sqlite3.Error:
        pass

    # FTS fallback (multi-word / out-of-order) when the prefix scan came up short.
    if len(out) < max(3, limit // 2):
        try:
            fts_q = " ".join(tok + "*" for tok in key.split() if len(tok) >= 2)
            if fts_q:
                rows = con.execute(
                    f"""
                    SELECT t.term AS term, t.cui AS cui,
                           c.semantic_group AS semantic_group, c.preferred_name AS preferred_name
                    FROM umls_terms_fts f
                    JOIN umls_terms t ON t.rowid = f.rowid
                    JOIN umls_concepts c ON c.cui = t.cui
                    WHERE umls_terms_fts MATCH ?
                    ORDER BY (c.semantic_group IN ({clin})) DESC,
                             (c.definition IS NOT NULL AND c.definition != '') DESC,
                             t.is_pref DESC, length(t.term) ASC
                    LIMIT ?
                    """,
                    (fts_q, max(limit, 1) * 6),
                ).fetchall()
                for r in rows:
                    _add(r)
                    if len(out) >= limit:
                        break
        except sqlite3.Error:
            pass

    return out[:limit]


@lru_cache(maxsize=8192)
def resolve(term: str) -> dict[str, Any] | None:
    key = norm(term)
    if not key:
        return None
    con = _conn()
    if con is None:
        return None
    try:
        if _looks_like_code(term) and _CODE_RE.match(term.strip()):
            code_row = con.execute(
                """
                SELECT c.*, cd.sab AS matched_sab
                FROM umls_codes cd
                JOIN umls_concepts c ON c.cui=cd.cui
                WHERE upper(cd.code)=upper(?)
                ORDER BY cd.source_rank ASC
                LIMIT 1
                """,
                (term.strip(),),
            ).fetchone()
            if code_row:
                concept = _concept_from_row(code_row)
                concept["preferred_source"] = code_row["matched_sab"] or concept.get("preferred_source") or ""
                return concept

        row = con.execute(
            """
            SELECT c.*
            FROM umls_terms t
            JOIN umls_concepts c ON c.cui=t.cui
            WHERE t.term_norm=?
            ORDER BY t.source_rank ASC, t.is_pref DESC, length(t.term) ASC
            LIMIT 1
            """,
            (key,),
        ).fetchone()
        if row:
            return _concept_from_row(row)

        if _CODE_RE.match(term.strip()):
            code_row = con.execute(
                """
                SELECT c.*, cd.sab AS matched_sab
                FROM umls_codes cd
                JOIN umls_concepts c ON c.cui=cd.cui
                WHERE upper(cd.code)=upper(?)
                ORDER BY cd.source_rank ASC
                LIMIT 1
                """,
                (term.strip(),),
            ).fetchone()
            if code_row:
                concept = _concept_from_row(code_row)
                concept["preferred_source"] = code_row["matched_sab"] or concept.get("preferred_source") or ""
                return concept
    except sqlite3.Error:
        return None
    finally:
        con.close()
    return None


@lru_cache(maxsize=4096)
def synonyms(cui: str, limit: int = 12) -> tuple[str, ...]:
    if not cui:
        return ()
    con = _conn()
    if con is None:
        return ()
    try:
        rows = con.execute(
            """
            SELECT term, sab, tty, is_pref, source_rank
            FROM umls_terms
            WHERE cui=?
              AND length(term) BETWEEN 2 AND 90
            ORDER BY source_rank ASC, is_pref DESC, length(term) ASC, term
            LIMIT ?
            """,
            (cui, max(limit * 4, limit)),
        ).fetchall()
    except sqlite3.Error:
        return ()
    finally:
        con.close()
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        value = re.sub(r"\s+", " ", row["term"] or "").strip()
        key = norm(value)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(value)
        if len(out) >= limit:
            break
    return tuple(out)


def _add_variant(out: list[str], seen: set[str], value: str | None, query_key: str, limit: int) -> bool:
    clean = re.sub(r"\s+", " ", value or "").strip(" ,;:-")
    if not clean:
        return False
    key = norm(clean)
    if not key or key == query_key or key in seen:
        return False
    if len(key.split()) > 8:
        return False
    seen.add(key)
    out.append(clean)
    return len(out) >= limit


def _search_friendly_variants(value: str, semantic_group: str, query_key: str, limit: int) -> tuple[str, ...]:
    clean = re.sub(r"\s+", " ", value or "").strip()
    if not clean:
        return ()

    out: list[str] = []
    seen: set[str] = set()

    def add(candidate: str | None) -> bool:
        return _add_variant(out, seen, candidate, query_key, limit)

    without_semantic_suffix = re.sub(
        r"\s+\((?:finding|disorder|procedure|substance|qualifier value|observable entity|situation|event)\)$",
        "",
        clean,
        flags=re.IGNORECASE,
    )
    if add(without_semantic_suffix):
        return tuple(out)

    # ICD/SNOMED labels often include coding qualifiers that make full-token FTS
    # too narrow for local clinical content. Keep the exact label above, then add
    # the core diagnosis/procedure name as a bounded fallback.
    split_markers = (
        " without ",
        " with ",
        " due to ",
        " secondary to ",
        " caused by ",
        " associated with ",
    )
    for marker in split_markers:
        idx = without_semantic_suffix.lower().find(marker)
        if idx > 0:
            prefix = without_semantic_suffix[:idx]
            if len(norm(prefix).split()) >= 2 and add(prefix):
                return tuple(out)

    qualifier_stripped = re.sub(
        r"(?i)(?:,\s*)?(?:unspecified|not otherwise specified|nos|nec|without complications?)$",
        "",
        without_semantic_suffix,
    ).strip(" ,;:-")
    if qualifier_stripped != without_semantic_suffix and add(qualifier_stripped):
        return tuple(out)

    if semantic_group in {"disease", "finding"}:
        key = norm(qualifier_stripped or without_semantic_suffix)
        if "diabetes mellitus" in key:
            if re.search(r"\btype\s+[12]\s+diabetes mellitus\b", key):
                diabetes_type = re.search(r"\btype\s+([12])\s+diabetes mellitus\b", key)
                if diabetes_type and add(f"Type {diabetes_type.group(1)} diabetes mellitus"):
                    return tuple(out)
            if add("Diabetes mellitus"):
                return tuple(out)
            if add("Diabetes"):
                return tuple(out)

    return tuple(out)


@lru_cache(maxsize=2048)
def query_variants(query: str, limit: int = 6) -> tuple[str, ...]:
    concept = resolve(query)
    if not concept:
        return ()
    compact = re.sub(r"[^A-Za-z0-9]", "", query or "")
    if (
        2 <= len(compact) <= 3
        and compact.upper() == compact
        and concept.get("semantic_group") not in {"disease", "finding", "drug", "lab", "procedure", "anatomy"}
    ):
        return ()
    query_key = norm(query)
    variants: list[str] = []
    seen: set[str] = set()
    for value in _search_friendly_variants(
        concept.get("preferred_name") or "",
        concept.get("semantic_group") or "",
        query_key,
        limit,
    ):
        key = norm(value)
        if key and key not in seen:
            seen.add(key)
            variants.append(value)
            if len(variants) >= limit:
                return tuple(variants)
    for value in synonyms(concept["cui"], max(limit + 4, 12)):
        for candidate in _search_friendly_variants(
            value,
            concept.get("semantic_group") or "",
            query_key,
            limit - len(variants),
        ):
            key = norm(candidate)
            if not key or key in seen:
                continue
            seen.add(key)
            variants.append(candidate)
            if len(variants) >= limit:
                return tuple(variants)
        if len(variants) >= limit:
            break
    return tuple(variants)


@lru_cache(maxsize=2048)
def definition_chip(term: str) -> dict[str, Any] | None:
    concept = resolve(term)
    if not concept:
        return None
    definition = concept.get("definition") or ""
    if not definition:
        con = _conn()
        if con is not None:
            try:
                row = con.execute(
                    """
                    SELECT definition, sab
                    FROM umls_definitions
                    WHERE cui=?
                    ORDER BY source_rank ASC, length(definition) DESC
                    LIMIT 1
                    """,
                    (concept["cui"],),
                ).fetchone()
                if row:
                    definition = row["definition"] or ""
                    concept["preferred_source"] = row["sab"] or concept.get("preferred_source") or ""
            finally:
                con.close()
    if not definition and (
        norm(term) != norm(concept["preferred_name"])
        or concept.get("semantic_group") in {"finding", "disease", "pathology"}
    ):
        definition = concept["preferred_name"]
    if not definition:
        return None
    return {
        "term": term,
        "expansion": concept["preferred_name"],
        "definition": definition,
        "source": "umls",
        "source_id": concept["cui"],
        "cui": concept["cui"],
        "href": f"/umls?cui={concept['cui']}",
        "semantic_group": concept.get("semantic_group") or "",
        "source_label": _source_label(concept.get("preferred_source")),
        "icd10cm_codes": list(icd10_codes(concept["cui"], 8)),
    }


@lru_cache(maxsize=4096)
def icd10_codes(cui: str, limit: int = 8) -> tuple[dict[str, str], ...]:
    value = (cui or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", value):
        return ()
    con = _conn()
    if con is None:
        return ()
    try:
        rows = con.execute(
            """
            SELECT code, term
            FROM umls_codes
            WHERE cui=? AND sab='ICD10CM' AND code != ''
            GROUP BY code
            ORDER BY length(code), code
            LIMIT ?
            """,
            (value, max(1, min(limit, 24))),
        ).fetchall()
    except sqlite3.Error:
        return ()
    finally:
        con.close()
    return tuple({"code": row["code"] or "", "term": row["term"] or ""} for row in rows if row["code"])


def _context_candidates(term: str) -> tuple[str, ...]:
    text = re.sub(r"\s+", " ", term or "").strip()
    if not text:
        return ()
    candidates: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        clean = re.sub(r"\s+", " ", value or "").strip(" -:;,")
        key = norm(clean)
        if not key or key in seen:
            return
        seen.add(key)
        candidates.append(clean)

    add(text)
    add(re.sub(r"^(?:first aid|amboss|uptodate|utd)\s*:\s*", "", text, flags=re.IGNORECASE))
    if ":" in text:
        left, right = text.split(":", 1)
        add(left)
        add(right)
        add(re.sub(r"\bof pregnancy\b", "in pregnancy", right, flags=re.IGNORECASE))

    base = re.sub(r"\([^)]*\)", " ", text)
    base = re.sub(r"\b(?:algorithm|image|table|figure|clinical chapter)\b", " ", base, flags=re.IGNORECASE)
    base = re.sub(r"\b\d{2,}\b", " ", base)
    base = re.sub(r"\s+", " ", base).strip()
    add(base)
    add(re.sub(r"\bof pregnancy\b", "in pregnancy", base, flags=re.IGNORECASE))
    if re.search(r"\bhypertensive disorders?\s+(?:of|in)\s+pregnancy\b", base, flags=re.IGNORECASE):
        add("Hypertensive disorders in pregnancy")
    if re.search(r"\bhypertension[-\s]+associated pregnancy disorder\b", base, flags=re.IGNORECASE):
        add("Hypertensive disorders in pregnancy")

    prefix_patterns = (
        r"^(?:approach to|approach to the|evaluation of|initial evaluation of|diagnosis of|diagnostic approach to|management of|treatment of|overview of|clinical manifestations of|clinical manifestations and diagnosis of|pathogenesis of|prevention of|screening for)\s+",
        r"^(?:adult|pediatric|paediatric)\s+",
    )
    stripped = base
    for pattern in prefix_patterns:
        stripped = re.sub(pattern, "", stripped, flags=re.IGNORECASE)
    add(stripped)

    suffix_patterns = (
        r"\s+(?:in|among)\s+(?:adults?|children|infants|pregnancy|older adults?|the elderly).*$",
        r"\s*[-–—]\s*(?:diagnosis|management|treatment|overview|clinical features).*$",
        r"\s*,\s*(?:unspecified|without complications?|with complications?).*$",
    )
    for pattern in suffix_patterns:
        add(re.sub(pattern, "", stripped, flags=re.IGNORECASE))

    words = re.findall(r"[A-Za-z0-9]+", text)
    lower_words = [word.lower() for word in words]
    single_anchor_terms = {
        "anemia", "asthma", "cancer", "carcinoma", "colitis", "diabetes",
        "embolism", "fever", "hypertension", "infection", "infarction",
        "migraine", "pneumonia", "rash", "seizure", "sepsis", "stroke",
        "thrombosis",
    }
    for index, word in enumerate(lower_words):
        if word not in _CONTEXT_ANCHORS:
            continue
        for width in range(min(5, index + 1), 1, -1):
            chunk_words = words[index - width + 1:index + 1]
            chunk_norm = [w.lower() for w in chunk_words]
            while chunk_norm and chunk_norm[0] in _CONTEXT_STOP:
                chunk_words = chunk_words[1:]
                chunk_norm = chunk_norm[1:]
            if len(chunk_words) >= 2:
                add(" ".join(chunk_words))
        if word == "mellitus" and index >= 1 and lower_words[index - 1] == "diabetes":
            add("Diabetes mellitus")
            if index >= 3 and lower_words[index - 3:index] == ["type", "2", "diabetes"]:
                add("Type 2 diabetes mellitus")
            if index >= 3 and lower_words[index - 3:index] == ["type", "1", "diabetes"]:
                add("Type 1 diabetes mellitus")
        if word == "colitis":
            if index >= 1 and lower_words[index - 1] == "ulcerative":
                add("Ulcerative colitis")
            if index >= 2 and lower_words[index - 2:index] == ["mild", "ulcerative"]:
                add("Ulcerative colitis")
        if word == "bowel" and index >= 1 and lower_words[index - 1] == "inflammatory":
            add("Inflammatory bowel disease")
        if word == "crohn":
            add("Crohn disease")
        if word in single_anchor_terms:
            add(words[index])

    return tuple(candidates[:16])


@lru_cache(maxsize=4096)
def concept_context(term: str, limit_codes: int = 8) -> dict[str, Any] | None:
    if not enabled():
        return None
    wanted_groups = {"disease", "finding", "pathology"}
    best: dict[str, Any] | None = None

    for candidate in _context_candidates(term):
        concept_row = resolve(candidate)
        if not concept_row:
            continue
        if _looks_like_code(candidate):
            best = concept_row
            break
        if concept_row.get("semantic_group") in wanted_groups:
            if not best or icd10_codes(concept_row["cui"], 1):
                best = concept_row
            if icd10_codes(concept_row["cui"], 1):
                break
            continue
        if not best:
            best = concept_row

    if not best or not icd10_codes(best["cui"], 1):
        for candidate in _context_candidates(term):
            if len(norm(candidate).split()) > 7:
                continue
            for item in search(candidate, limit=4):
                if item.get("semantic_group") in wanted_groups:
                    if not best or icd10_codes(item["cui"], 1):
                        best = item
                    if icd10_codes(item["cui"], 1):
                        break
            if best:
                if icd10_codes(best["cui"], 1):
                    break

    if not best:
        return None

    codes = icd10_codes(best["cui"], limit_codes)
    return {
        "cui": best["cui"],
        "preferred_name": best.get("preferred_name") or "",
        "semantic_group": best.get("semantic_group") or "",
        "definition": best.get("definition") or best.get("preferred_name") or "",
        "source_label": _source_label(best.get("preferred_source")),
        "href": f"/umls?cui={best['cui']}",
        "icd10cm_codes": list(codes),
    }


@lru_cache(maxsize=4096)
def concept_context_for_cui(cui: str, limit_codes: int = 8) -> dict[str, Any] | None:
    data = concept(cui)
    if not data:
        return None
    return {
        "cui": data["cui"],
        "preferred_name": data.get("preferred_name") or "",
        "semantic_group": data.get("semantic_group") or "",
        "definition": data.get("definition") or data.get("preferred_name") or "",
        "source_label": _source_label(data.get("preferred_source")),
        "href": f"/umls?cui={data['cui']}",
        "icd10cm_codes": list(icd10_codes(data["cui"], limit_codes)),
    }


@lru_cache(maxsize=512)
def search(
    query: str,
    limit: int = 20,
    source: str | None = None,
    semantic_group: str | None = None,
) -> tuple[dict[str, Any], ...]:
    qn = norm(query)
    if not qn:
        return ()
    con = _conn()
    if con is None:
        return ()
    params: list[Any] = []
    filters: list[str] = []
    if source:
        filters.append("t.sab=?")
        params.append(source.upper())
    if semantic_group:
        filters.append("c.semantic_group=?")
        params.append(semantic_group)
    where_filter = (" AND " + " AND ".join(filters)) if filters else ""
    rows: list[sqlite3.Row] = []
    seen: set[str] = set()
    try:
        if _CODE_RE.match(query.strip()):
            code_sql = (
                """
                SELECT c.*, cd.sab AS matched_source, cd.code AS matched_code,
                       cd.term AS matched_term, 0.0 AS fts_rank
                FROM umls_codes cd
                JOIN umls_concepts c ON c.cui=cd.cui
                JOIN umls_terms t ON t.cui=c.cui
                WHERE upper(cd.code)=upper(?)
                """
                + where_filter
                + """
                GROUP BY c.cui
                ORDER BY cd.source_rank ASC
                LIMIT ?
                """
            )
            rows.extend(con.execute(code_sql, [query.strip(), *params, limit]).fetchall())

        match_query = _fts_query(qn)
        if match_query:
            fts_sql = (
                """
                SELECT c.*, t.sab AS matched_source, t.code AS matched_code,
                       t.term AS matched_term,
                       bm25(umls_terms_fts, 8.0, 3.0, 0.7) AS fts_rank
                FROM umls_terms_fts
                JOIN umls_terms t ON t.rowid=umls_terms_fts.rowid
                JOIN umls_concepts c ON c.cui=t.cui
                WHERE umls_terms_fts MATCH ?
                """
                + where_filter
                + """
                ORDER BY fts_rank, t.source_rank ASC, t.is_pref DESC
                LIMIT ?
                """
            )
            rows.extend(con.execute(fts_sql, [match_query, *params, max(limit * 4, 40)]).fetchall())
    except sqlite3.Error:
        return ()
    finally:
        con.close()

    out: list[dict[str, Any]] = []
    for row in rows:
        cui = row["cui"]
        if cui in seen:
            continue
        seen.add(cui)
        title = row["preferred_name"] or row["matched_term"] or cui
        matched = row["matched_term"] or title
        score = 100.0
        title_key = norm(title)
        matched_key = norm(matched)
        if title_key == qn or matched_key == qn:
            score += 220.0
        elif title_key.startswith(qn) or matched_key.startswith(qn):
            score += 140.0
        elif qn in title_key or qn in matched_key:
            score += 80.0
        score -= min(abs(float(row["fts_rank"] or 0.0)) * 3.5, 70.0)
        out.append({
            **_concept_from_row(row),
            "matched_term": matched,
            "matched_source": row["matched_source"] or "",
            "matched_source_label": _source_label(row["matched_source"]),
            "matched_code": row["matched_code"] or "",
            "score": round(score, 2),
            "href": f"/umls?cui={cui}",
        })
    out.sort(key=lambda item: (-float(item.get("score") or 0.0), item.get("preferred_name", "").lower()))
    return tuple(out[:limit])


@lru_cache(maxsize=2048)
def concept(cui: str) -> dict[str, Any] | None:
    value = (cui or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", value):
        return None
    con = _conn()
    if con is None:
        return None
    try:
        row = con.execute("SELECT * FROM umls_concepts WHERE cui=?", (value,)).fetchone()
        if not row:
            return None
        terms = con.execute(
            """
            SELECT term, sab, tty, code, is_pref
            FROM umls_terms
            WHERE cui=?
            ORDER BY source_rank ASC, is_pref DESC, length(term) ASC
            LIMIT 80
            """,
            (value,),
        ).fetchall()
        definitions = con.execute(
            """
            SELECT sab, definition
            FROM umls_definitions
            WHERE cui=?
            ORDER BY source_rank ASC, length(definition) DESC
            LIMIT 8
            """,
            (value,),
        ).fetchall()
        codes = con.execute(
            """
            SELECT sab, code, term
            FROM umls_codes
            WHERE cui=?
            ORDER BY source_rank ASC, sab, code
            LIMIT 100
            """,
            (value,),
        ).fetchall()
        relations = con.execute(
            """
            SELECT r.cui2 AS cui, c.preferred_name, c.semantic_group, r.rel, r.rela, r.sab
            FROM umls_relations r
            JOIN umls_concepts c ON c.cui=r.cui2
            WHERE r.cui1=?
            ORDER BY r.source_rank ASC, r.rela, c.preferred_name
            LIMIT 80
            """,
            (value,),
        ).fetchall()
    except sqlite3.Error:
        return None
    finally:
        con.close()
    return {
        **_concept_from_row(row),
        "terms": [
            {
                "term": t["term"],
                "source": t["sab"],
                "source_label": _source_label(t["sab"]),
                "tty": t["tty"],
                "code": t["code"],
                "is_pref": bool(t["is_pref"]),
            }
            for t in terms
        ],
        "definitions": [
            {"source": d["sab"], "source_label": _source_label(d["sab"]), "definition": d["definition"]}
            for d in definitions
        ],
        "codes": [
            {"source": cd["sab"], "source_label": _source_label(cd["sab"]), "code": cd["code"], "term": cd["term"]}
            for cd in codes
        ],
        "relations": [
            {
                "cui": r["cui"],
                "preferred_name": r["preferred_name"],
                "semantic_group": r["semantic_group"],
                "rel": r["rel"],
                "rela": r["rela"],
                "source": r["sab"],
            }
            for r in relations
        ],
    }


@lru_cache(maxsize=1)
def scan_entries(limit: int = 45000) -> tuple[dict[str, Any], ...]:
    con = _conn()
    if con is None:
        return ()
    try:
        rows = con.execute(
            """
            SELECT term, cui, semantic_group, priority, case_sensitive
            FROM umls_scan_terms
            ORDER BY priority DESC, length(term) DESC, term
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except sqlite3.Error:
        return ()
    finally:
        con.close()
    return tuple(
        {
            "term": row["term"],
            "cui": row["cui"],
            "source": "umls",
            "kind": row["semantic_group"] or "concept",
            "case_sensitive": bool(row["case_sensitive"]),
        }
        for row in rows
    )


@lru_cache(maxsize=4096)
def tooltip(term: str, limit: int = 10) -> dict[str, Any]:
    concept_row = resolve(term)
    if not concept_row:
        return {"term": term, "source": "umls", "matches": []}
    cui = concept_row["cui"]
    data = concept(cui) or concept_row
    context = concept_context_for_cui(cui) or {}
    matches = [
        {
            "id": 0,
            "title": data.get("preferred_name") or term,
            "href": f"/umls?cui={cui}",
            "source": "umls",
            "kind": data.get("semantic_group") or "concept",
        }
    ]
    for rel in (data.get("relations") or [])[: max(0, limit - 1)]:
        matches.append({
            "id": 0,
            "title": rel.get("preferred_name") or rel.get("cui"),
            "href": f"/umls?cui={rel.get('cui')}",
            "source": "umls",
            "kind": rel.get("semantic_group") or "concept",
        })
    return {
        "term": term,
        "title": data.get("preferred_name") or term,
        "source": "umls",
        "kind": data.get("semantic_group") or "concept",
        "matches": matches[:limit],
        "abstract": data.get("definition") or "",
        "expansions": [s for s in synonyms(cui, 8) if norm(s) != norm(term)][:5],
        "cui": cui,
        "icd10cm_codes": context.get("icd10cm_codes") or [],
        "media": [],
    }


_PARAGRAPH_CONCEPTS_DB = UMLS_DB.parent / "paragraph_concepts.sqlite"
_LAY_DEFINITION_SOURCES = ("MEDLINEPLUS", "CHV", "MSHFRE", "NCI")
_CODE_SOURCE_BUCKETS = (
    ("icd10cm_codes", "ICD10CM"),
    ("snomed_codes",  "SNOMEDCT_US"),
    ("rxnorm_codes",  "RXNORM"),
    ("loinc_codes",   "LNC"),
)


def _paragraph_concepts_conn() -> sqlite3.Connection | None:
    if not _PARAGRAPH_CONCEPTS_DB.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        return con
    except sqlite3.Error:
        return None


@lru_cache(maxsize=4096)
def mention_count(cui: str) -> int:
    """Count distinct (source, source_id) entries that mention this CUI."""
    value = (cui or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", value):
        return 0
    con = _paragraph_concepts_conn()
    if con is None:
        return 0
    try:
        row = con.execute(
            "SELECT count(DISTINCT source || ':' || source_id) AS n FROM paragraph_concepts WHERE cui=?",
            (value,),
        ).fetchone()
    except sqlite3.Error:
        return 0
    finally:
        con.close()
    return int(row["n"] or 0) if row else 0


def tooltip_payload(term: str, prefer_lay: bool = False) -> dict[str, Any] | None:
    """Rich tooltip block: definitions, synonyms, codes by source, related concepts, mention count.

    Returned when the term resolves to a UMLS concept. Designed to be attached
    to /glossary/lookup responses as the `umls` field, OR used directly as the
    full payload when glossary.db has no row for the term.
    """
    resolved = resolve(term)
    if not resolved:
        return None
    cui = resolved["cui"]
    data = concept(cui) or resolved
    preferred_name = data.get("preferred_name") or term

    raw_defs = data.get("definitions") or []
    if prefer_lay:
        lay = [d for d in raw_defs if (d.get("source") or "").upper() in _LAY_DEFINITION_SOURCES]
        clin = [d for d in raw_defs if (d.get("source") or "").upper() not in _LAY_DEFINITION_SOURCES]
        ordered = lay + clin
    else:
        ordered = list(raw_defs)
    definitions = [
        {
            "source": d.get("source") or "",
            "source_label": d.get("source_label") or _source_label(d.get("source")),
            "text": d.get("definition") or "",
        }
        for d in ordered[:3]
        if d.get("definition")
    ]
    if not definitions and resolved.get("definition"):
        definitions.append({
            "source": resolved.get("preferred_source") or "",
            "source_label": _source_label(resolved.get("preferred_source")),
            "text": resolved.get("definition") or "",
        })

    pref_key = norm(preferred_name)
    term_key = norm(term)
    seen: set[str] = set(filter(None, (pref_key, term_key)))
    syn_out: list[str] = []
    for value in synonyms(cui, 16):
        key = norm(value)
        if not key or key in seen:
            continue
        seen.add(key)
        syn_out.append(value)
        if len(syn_out) >= 5:
            break

    codes_block: dict[str, list[dict[str, str]]] = {key: [] for key, _ in _CODE_SOURCE_BUCKETS}
    code_seen: set[tuple[str, str]] = set()
    for code in data.get("codes") or []:
        sab = (code.get("source") or "").upper()
        ccode = (code.get("code") or "").strip()
        if not sab or not ccode:
            continue
        for bucket_key, bucket_sab in _CODE_SOURCE_BUCKETS:
            if sab != bucket_sab:
                continue
            key = (bucket_key, ccode)
            if key in code_seen:
                break
            code_seen.add(key)
            if len(codes_block[bucket_key]) < 5:
                codes_block[bucket_key].append({"code": ccode, "term": code.get("term") or ""})
            break

    related_out: list[dict[str, str]] = []
    related_seen: set[str] = set()
    for rel in data.get("relations") or []:
        rcui = rel.get("cui") or ""
        if not rcui or rcui == cui or rcui in related_seen:
            continue
        related_seen.add(rcui)
        related_out.append({
            "cui": rcui,
            "preferred_name": rel.get("preferred_name") or rcui,
            "semantic_group": rel.get("semantic_group") or "",
            "rela": rel.get("rela") or rel.get("rel") or "",
        })
        if len(related_out) >= 6:
            break

    payload: dict[str, Any] = {
        "cui": cui,
        "preferred_name": preferred_name,
        "semantic_group": data.get("semantic_group") or "",
        "preferred_source": data.get("preferred_source") or resolved.get("preferred_source") or "",
        "href": f"/umls?cui={cui}",
        "definitions": definitions,
        "synonyms": syn_out,
        "related": related_out,
        "mention_count": mention_count(cui),
    }
    for bucket_key, _ in _CODE_SOURCE_BUCKETS:
        payload[bucket_key] = codes_block[bucket_key]
    return payload


@lru_cache(maxsize=2048)
def disease_mimics(cui: str, limit: int = 6) -> tuple[dict[str, Any], ...]:
    """Return the top `limit` phenotypically-similar diseases for a given disease CUI.

    Algorithm: IC-weighted Jaccard similarity over HPO phenotype sets.
      similarity = sum_IC(A ∩ B) / sum_IC(A ∪ B)

    Only disease-group concepts with at least 2 shared phenotypes are returned.
    Fast enough for per-request use (single disease → bounded candidate set).

    Returns a tuple of dicts with: cui, preferred_name, semantic_group,
    href, shared_phenotypes, total_phenotypes_A, total_phenotypes_B, jaccard.
    """
    value = (cui or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", value):
        return ()
    con = _conn()
    if con is None:
        return ()
    try:
        # 1. Get phenotype set A (for query disease) with IC weights
        pheno_rows = con.execute(
            """
            SELECT l.phenotype_cui, COALESCE(i.ic, 1.0) AS ic
            FROM umls_hpo_disease_links l
            LEFT JOIN umls_hpo_ic i ON i.phenotype_cui=l.phenotype_cui
            WHERE l.disease_cui=?
            """,
            (value,),
        ).fetchall()
        if not pheno_rows:
            return ()

        pheno_A: dict[str, float] = {r["phenotype_cui"]: float(r["ic"]) for r in pheno_rows}
        total_ic_A = sum(pheno_A.values())
        if total_ic_A == 0:
            return ()

        # 2. Find candidate diseases sharing at least one phenotype with A
        placeholders = ",".join("?" * len(pheno_A))
        candidate_rows = con.execute(
            f"""
            SELECT l.disease_cui,
                   COUNT(DISTINCT l.phenotype_cui) AS shared_count
            FROM umls_hpo_disease_links l
            JOIN umls_concepts c ON c.cui=l.disease_cui
            WHERE l.phenotype_cui IN ({placeholders})
              AND l.disease_cui != ?
              AND c.semantic_group IN ('disease', 'pathology')
            GROUP BY l.disease_cui
            HAVING shared_count >= 2
            ORDER BY shared_count DESC
            LIMIT 80
            """,
            (*pheno_A.keys(), value),
        ).fetchall()
        if not candidate_rows:
            return ()

        candidate_cuis = [r["disease_cui"] for r in candidate_rows]

        # 3. Load phenotype sets for each candidate with their IC
        placeholders_c = ",".join("?" * len(candidate_cuis))
        cand_pheno_rows = con.execute(
            f"""
            SELECT l.disease_cui, l.phenotype_cui, COALESCE(i.ic, 1.0) AS ic
            FROM umls_hpo_disease_links l
            LEFT JOIN umls_hpo_ic i ON i.phenotype_cui=l.phenotype_cui
            WHERE l.disease_cui IN ({placeholders_c})
            """,
            tuple(candidate_cuis),
        ).fetchall()

        # Build B sets per candidate
        pheno_B_map: dict[str, dict[str, float]] = {}
        for r in cand_pheno_rows:
            dc = r["disease_cui"]
            pc = r["phenotype_cui"]
            pheno_B_map.setdefault(dc, {})[pc] = float(r["ic"])

        # 4. Compute IC-weighted Jaccard for each candidate
        scored: list[tuple[float, int, str]] = []
        for dc, pheno_B in pheno_B_map.items():
            shared_ic = sum(pheno_A[p] for p in pheno_A if p in pheno_B)
            if shared_ic == 0:
                continue
            union_ic = sum(pheno_A.values()) + sum(ic for p, ic in pheno_B.items() if p not in pheno_A)
            if union_ic == 0:
                continue
            jaccard = shared_ic / union_ic
            n_shared = sum(1 for p in pheno_A if p in pheno_B)
            scored.append((jaccard, n_shared, dc))

        scored.sort(key=lambda t: (-t[0], -t[1]))
        top_cuis = [dc for _, _, dc in scored[:limit * 2]]

        # 5. Resolve preferred names for top candidates
        if not top_cuis:
            return ()
        placeholders_t = ",".join("?" * len(top_cuis))
        name_rows = con.execute(
            f"SELECT cui, preferred_name, semantic_group FROM umls_concepts WHERE cui IN ({placeholders_t})",
            tuple(top_cuis),
        ).fetchall()
        name_map: dict[str, dict[str, str]] = {r["cui"]: dict(r) for r in name_rows}

        out: list[dict[str, Any]] = []
        for jaccard, n_shared, dc in scored[:limit]:
            name_data = name_map.get(dc, {})
            pn = name_data.get("preferred_name") or dc
            sg = name_data.get("semantic_group") or ""
            out.append({
                "cui":               dc,
                "preferred_name":    pn,
                "semantic_group":    sg,
                "href":              f"/umls?cui={dc}",
                "shared_phenotypes": n_shared,
                "total_phenotypes":  len(pheno_B_map.get(dc, {})),
                "jaccard":           round(jaccard, 3),
            })
            if len(out) >= limit:
                break
    except sqlite3.Error:
        return ()
    finally:
        con.close()
    return tuple(out)


def labs_search(query: str, limit: int = 20) -> tuple[dict[str, Any], ...]:
    return search(query, limit=limit, source="LNC")


def adverse_event_search(query: str, limit: int = 20) -> tuple[dict[str, Any], ...]:
    return search(query, limit=limit, source="MDR")


def _expand_phenotype_cui(con: sqlite3.Connection, cui: str, preferred_name: str) -> list[str]:
    """Resolve a phenotype CUI to all linkable phenotype CUIs.

    Most canonical HPO term CUIs (e.g. Arachnodactyly C0003706) have NO rows in
    umls_hpo_disease_links because the disease-phenotype links in UMLS are
    keyed off OMIM/Orphanet's own free-text phenotype concepts. So if the
    direct CUI has no links, fall back to finding any phenotype concept with a
    similar preferred_name that DOES have links.
    """
    rows = con.execute(
        "SELECT 1 FROM umls_hpo_disease_links WHERE phenotype_cui=? LIMIT 1",
        (cui,),
    ).fetchone()
    if rows:
        return [cui]

    keys = [(preferred_name or "").strip(), *synonyms(cui, 12)]
    keys = list(dict.fromkeys(k for k in keys if k and k.strip()))
    if not keys:
        return [cui]
    out: list[str] = []
    seen: set[str] = set()
    for key in keys:
        needle = norm(key)
        if not needle:
            continue
        candidates = con.execute(
            """
            SELECT DISTINCT l.phenotype_cui, p.preferred_name
            FROM umls_hpo_disease_links l
            JOIN umls_terms t ON t.cui=l.phenotype_cui
            JOIN umls_concepts p ON p.cui=l.phenotype_cui
            WHERE t.term_norm = ?
               OR (t.term_norm >= ? AND t.term_norm < ?)
            LIMIT 8
            """,
            (needle, f"{needle} ", f"{needle} \uffff"),
        ).fetchall()
        if not candidates:
            match_query = _fts_query(needle)
            if match_query:
                candidates = con.execute(
                    """
                    SELECT DISTINCT l.phenotype_cui, p.preferred_name
                    FROM umls_terms_fts f
                    JOIN umls_terms t ON t.rowid=f.rowid
                    JOIN umls_hpo_disease_links l ON l.phenotype_cui=t.cui
                    JOIN umls_concepts p ON p.cui=l.phenotype_cui
                    WHERE umls_terms_fts MATCH ?
                    ORDER BY length(p.preferred_name)
                    LIMIT 8
                    """,
                    (match_query,),
                ).fetchall()
        for row in candidates:
            pcui = row["phenotype_cui"]
            if pcui and pcui not in seen:
                seen.add(pcui)
                out.append(pcui)
        if out:
            break
    return out or [cui]


def _phenotype_ic(con: sqlite3.Connection, cuis: list[str]) -> dict[str, float]:
    """Look up IC scores for the given phenotype CUIs."""
    if not cuis:
        return {}
    placeholders = ",".join("?" for _ in cuis)
    try:
        rows = con.execute(
            f"SELECT phenotype_cui, ic FROM umls_hpo_ic WHERE phenotype_cui IN ({placeholders})",
            tuple(cuis),
        ).fetchall()
    except sqlite3.Error:
        return {}
    return {row["phenotype_cui"]: float(row["ic"] or 0.0) for row in rows}


def _resolved_phenotype_expansions(
    con: sqlite3.Connection,
    phenotypes: list[str],
) -> tuple[list[dict[str, Any]], list[list[str]], list[str], dict[str, float]]:
    resolved = [resolve(item) for item in phenotypes if item and item.strip()]
    resolved_clean = [item for item in resolved if item and item.get("cui")]
    expanded_per_input: list[list[str]] = []
    all_expanded: list[str] = []
    for item in resolved_clean:
        expanded = _expand_phenotype_cui(con, item["cui"], item.get("preferred_name") or "")
        expanded_per_input.append(expanded)
        all_expanded.extend(expanded)
    all_expanded = list(dict.fromkeys(all_expanded))
    return resolved_clean, expanded_per_input, all_expanded, _phenotype_ic(con, all_expanded)


def phenotype_differential_preview(phenotypes: list[str], limit: int = 5) -> dict[str, Any]:
    """Fast search-row preview: top disease names without full coverage denominator."""
    con = _conn()
    if con is None:
        return {"phenotypes": [], "results": []}
    try:
        resolved_clean, _expanded_per_input, all_expanded, ic_map = _resolved_phenotype_expansions(con, phenotypes)
        if not resolved_clean or not all_expanded:
            return {"phenotypes": resolved_clean, "results": []}
        placeholders = ",".join("?" for _ in all_expanded)
        rows = con.execute(
            f"""
            SELECT l.disease_cui, c.preferred_name, c.semantic_group,
                   GROUP_CONCAT(DISTINCT p.preferred_name) AS matched_phenotypes,
                   GROUP_CONCAT(DISTINCT l.phenotype_cui)  AS matched_cuis,
                   GROUP_CONCAT(DISTINCT l.sab)            AS sources,
                   COUNT(DISTINCT l.phenotype_cui)         AS matched_count,
                   SUM(COALESCE(i.ic, 1.0))                AS matched_ic
            FROM umls_hpo_disease_links l
            JOIN umls_concepts c ON c.cui=l.disease_cui
            JOIN umls_concepts p ON p.cui=l.phenotype_cui
            LEFT JOIN umls_hpo_ic i ON i.phenotype_cui=l.phenotype_cui
            WHERE l.phenotype_cui IN ({placeholders})
              AND c.semantic_group='disease'
            GROUP BY l.disease_cui
            ORDER BY matched_count DESC, matched_ic DESC, c.preferred_name
            LIMIT ?
            """,
            (*all_expanded, max(1, min(limit, 12))),
        ).fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            matched_cuis = [c for c in str(row["matched_cuis"] or "").split(",") if c]
            match_ic = sum(ic_map.get(c, 1.0) for c in matched_cuis)
            out.append({
                "cui": row["disease_cui"],
                "preferred_name": row["preferred_name"],
                "semantic_group": row["semantic_group"],
                "matched_count": int(row["matched_count"] or 0),
                "match_ic": round(match_ic, 4),
                "matched_phenotypes": [x for x in str(row["matched_phenotypes"] or "").split(",") if x][:4],
                "sources": [x for x in str(row["sources"] or "").split(",") if x],
                "href": f"/umls?cui={row['disease_cui']}",
            })
        return {"phenotypes": resolved_clean, "results": out}
    except sqlite3.Error:
        return {"phenotypes": [], "results": []}
    finally:
        con.close()


def phenotype_cofinding_suggestions(phenotypes: list[str], limit: int = 8) -> dict[str, Any]:
    """Suggest additional HPO findings that commonly occur with the current chips."""
    con = _conn()
    if con is None:
        return {"phenotypes": [], "suggestions": []}
    try:
        resolved_clean, _expanded_per_input, all_expanded, _ic_map = _resolved_phenotype_expansions(con, phenotypes)
        if not resolved_clean or not all_expanded:
            return {"phenotypes": resolved_clean, "suggestions": []}
        placeholders = ",".join("?" for _ in all_expanded)
        seed_rows = con.execute(
            f"""
            SELECT DISTINCT disease_cui
            FROM umls_hpo_disease_links
            WHERE phenotype_cui IN ({placeholders})
            LIMIT 600
            """,
            tuple(all_expanded),
        ).fetchall()
        disease_cuis = [row["disease_cui"] for row in seed_rows if row["disease_cui"]]
        if not disease_cuis:
            return {"phenotypes": resolved_clean, "suggestions": []}
        suggestions = _cofinding_suggestions_for_diseases(con, disease_cuis, all_expanded, limit)
        return {"phenotypes": resolved_clean, "suggestions": suggestions}
    except sqlite3.Error:
        return {"phenotypes": [], "suggestions": []}
    finally:
        con.close()


_COFINDING_NOISE_RE = re.compile(
    r"\b(?:rare lesion|clinical modifier|phenotypic abnormality|finding|observable entity)\b",
    re.IGNORECASE,
)


def _useful_cofinding_name(name: str) -> bool:
    clean = " ".join(str(name or "").split())
    if len(clean) < 3 or len(clean) > 90:
        return False
    if _COFINDING_NOISE_RE.search(clean):
        return False
    lowered = clean.lower()
    if lowered in {"disease", "syndrome", "abnormality", "physical finding"}:
        return False
    return True


def _cofinding_suggestions_for_diseases(
    con: sqlite3.Connection,
    disease_cuis: list[str],
    excluded_phenotype_cuis: list[str],
    limit: int = 8,
) -> list[dict[str, Any]]:
    disease_cuis = list(dict.fromkeys(c for c in disease_cuis if c))[:80]
    excluded_phenotype_cuis = list(dict.fromkeys(c for c in excluded_phenotype_cuis if c))
    if not disease_cuis:
        return []
    disease_placeholders = ",".join("?" for _ in disease_cuis)
    exclude_sql = ""
    params: list[Any] = [*disease_cuis]
    if excluded_phenotype_cuis:
        exclude_placeholders = ",".join("?" for _ in excluded_phenotype_cuis)
        exclude_sql = f"AND l.phenotype_cui NOT IN ({exclude_placeholders})"
        params.extend(excluded_phenotype_cuis)
    rows = con.execute(
        f"""
        SELECT l.phenotype_cui, p.preferred_name,
               COUNT(DISTINCT l.disease_cui) AS disease_count,
               COALESCE(i.ic, 1.0) AS ic,
               COUNT(DISTINCT l.disease_cui) * COALESCE(i.ic, 1.0) AS suggestion_score
        FROM umls_hpo_disease_links l
        JOIN umls_concepts p ON p.cui=l.phenotype_cui
        LEFT JOIN umls_hpo_ic i ON i.phenotype_cui=l.phenotype_cui
        WHERE l.disease_cui IN ({disease_placeholders})
          {exclude_sql}
        GROUP BY l.phenotype_cui
        ORDER BY suggestion_score DESC, ic DESC, disease_count DESC, length(p.preferred_name)
        LIMIT ?
        """,
        (*params, max(limit * 8, 32)),
    ).fetchall()
    out: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for row in rows:
        name = str(row["preferred_name"] or "").strip()
        name_key = norm(name)
        if not _useful_cofinding_name(name) or name_key in seen_names:
            continue
        seen_names.add(name_key)
        out.append({
            "cui": row["phenotype_cui"],
            "preferred_name": name,
            "disease_count": int(row["disease_count"] or 0),
            "ic": round(float(row["ic"] or 0.0), 4),
            "score": round(float(row["suggestion_score"] or 0.0), 4),
        })
        if len(out) >= max(1, min(limit, 20)):
            break
    return out


def phenotype_differential(phenotypes: list[str], limit: int = 30) -> dict[str, Any]:
    """IC-weighted (Resnik) ranking of diseases given a list of phenotype names.

    Uses the umls_hpo_ic table built by scripts/umls/compute_hpo_ic.py.
    Falls back to count-based scoring when IC is unavailable.

    For each input phenotype name we (a) resolve to a CUI, (b) expand by
    preferred-name match to capture OMIM/Orphanet variant phenotype CUIs that
    actually have disease links, then (c) score diseases by:

        match_ic   = sum( IC(p) for p in matched_phenotypes )
        coverage   = match_ic / total_disease_ic
        score      = (1 - alpha) * match_ic + alpha * coverage * mean_input_ic
    """
    con = _conn()
    if con is None:
        return {"phenotypes": [], "results": [], "message": "UMLS DB not built."}
    try:
        resolved_clean, expanded_per_input, all_expanded, ic_map = _resolved_phenotype_expansions(con, phenotypes)
        if not resolved_clean:
            return {"phenotypes": [], "results": [], "message": "No HPO/UMLS phenotype concepts matched."}
        if not all_expanded:
            return {"phenotypes": resolved_clean, "results": [], "message": "No linkable phenotype CUIs."}

        mean_ic = sum(ic_map.values()) / max(len(ic_map), 1) if ic_map else 1.0

        # Per-input IC weight (max IC across the input's expansions, or fallback 1.0)
        input_weights: dict[str, float] = {}
        for input_item, expansions in zip(resolved_clean, expanded_per_input):
            best = max((ic_map.get(c, 0.0) for c in expansions), default=0.0)
            input_weights[input_item["cui"]] = best if best > 0 else 1.0

        placeholders = ",".join("?" for _ in all_expanded)
        rows = con.execute(
            f"""
            SELECT l.disease_cui, c.preferred_name, c.semantic_group,
                   GROUP_CONCAT(DISTINCT p.preferred_name) AS matched_phenotypes,
                   GROUP_CONCAT(DISTINCT l.phenotype_cui)  AS matched_cuis,
                   GROUP_CONCAT(DISTINCT l.sab)            AS sources,
                   COUNT(DISTINCT l.phenotype_cui)         AS matched_count
            FROM umls_hpo_disease_links l
            JOIN umls_concepts c ON c.cui=l.disease_cui
            JOIN umls_concepts p ON p.cui=l.phenotype_cui
            WHERE l.phenotype_cui IN ({placeholders})
              AND c.semantic_group='disease'
            GROUP BY l.disease_cui
            """,
            tuple(all_expanded),
        ).fetchall()

        disease_total_ic: dict[str, float] = {}
        disease_cuis = [str(row["disease_cui"] or "") for row in rows if row["disease_cui"]]
        for offset in range(0, len(disease_cuis), 900):
            chunk = disease_cuis[offset:offset + 900]
            if not chunk:
                continue
            chunk_placeholders = ",".join("?" for _ in chunk)
            totals = con.execute(
                f"""
                SELECT l.disease_cui, SUM(COALESCE(i.ic, 1.0)) AS total
                FROM umls_hpo_disease_links l
                LEFT JOIN umls_hpo_ic i ON i.phenotype_cui=l.phenotype_cui
                WHERE l.disease_cui IN ({chunk_placeholders})
                GROUP BY l.disease_cui
                """,
                tuple(chunk),
            ).fetchall()
            for total_row in totals:
                disease_total_ic[str(total_row["disease_cui"])] = float(total_row["total"] or 0.0)

        scored: list[dict[str, Any]] = []
        for row in rows:
            matched_cuis = [c for c in str(row["matched_cuis"] or "").split(",") if c]
            match_ic = sum(ic_map.get(c, 1.0) for c in matched_cuis)
            tot = disease_total_ic.get(str(row["disease_cui"] or ""), 0.0) or 1.0
            coverage = match_ic / tot if tot else 0.0
            count_bonus = float(row["matched_count"] or 0) / max(len(all_expanded), 1)
            # Blend: 60% absolute IC overlap + 30% per-disease coverage + 10% input fraction matched
            score = 0.6 * match_ic + 0.3 * coverage * mean_ic + 0.1 * count_bonus * mean_ic
            scored.append({
                "cui": row["disease_cui"],
                "preferred_name": row["preferred_name"],
                "semantic_group": row["semantic_group"],
                "matched_count": int(row["matched_count"] or 0),
                "score": round(score, 4),
                "match_ic": round(match_ic, 4),
                "coverage": round(coverage, 4),
                "matched_phenotypes": [x for x in str(row["matched_phenotypes"] or "").split(",") if x][:6],
                "sources": [x for x in str(row["sources"] or "").split(",") if x],
                "href": f"/umls?cui={row['disease_cui']}",
            })
        scored.sort(key=lambda item: (-float(item["score"]), -int(item["matched_count"]), item["preferred_name"]))
        top_disease_cuis = [str(item["cui"]) for item in scored[:60] if item.get("cui")]
        suggestions = _cofinding_suggestions_for_diseases(con, top_disease_cuis, all_expanded, limit=12)
        scored = scored[:limit]
    except sqlite3.Error as e:
        return {"phenotypes": [], "results": [], "message": f"DB error: {e}"}
    finally:
        con.close()
    return {
        "phenotypes": resolved_clean,
        "results": scored,
        "suggestions": suggestions,
        "summary": {
            "input_count": len(resolved_clean),
            "expanded_phenotype_count": len(all_expanded),
            "candidate_count": len(rows),
        },
        "message": "" if scored else "No diseases matched. Try common HPO findings (Seizure, Microcephaly, Short stature, Aortic root dilation).",
    }

"""
build_drug_reference.py — Phase B

Harmonizes Micromedex + UpToDate into a single drug_reference.sqlite
optimized for fast search and beautiful clinical display.

Usage:
    cd app/backend
    python scripts/build_drug_reference.py               # full build
    python scripts/build_drug_reference.py --limit 50    # test with 50 drugs
    python scripts/build_drug_reference.py --rebuild     # drop + recreate tables
    python scripts/build_drug_reference.py --skip-utd    # MM only (faster)

Environment overrides:
    MEDOS_ROOT, MICROMEDEX_DB, UTD_DB_PATH, UTD_ASSET_DB, UTD_INDEX_DB,
    REF_ENTITIES_DB, DRUG_REF_DB
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

# ── Paths ────────────────────────────────────────────────────────────────────
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import DRUG_REF_DB, MICROMEDEX_DB as CONFIG_MICROMEDEX_DB, ROOT


def _env_path(key: str, default: Path) -> Path:
    import os

    raw = (os.getenv(key) or "").strip()
    return Path(raw) if raw else default


UTD_DIR       = _env_path("UTD_DB_PATH", ROOT / "data" / "uptodate")
MICROMEDEX_DB = _env_path("MICROMEDEX_DB", CONFIG_MICROMEDEX_DB)
UTD_ASSET_DB  = _env_path("UTD_ASSET_DB", UTD_DIR / "utdasset_decrypted.sqlite")
UTD_INDEX_DB  = _env_path("UTD_INDEX_DB", UTD_DIR / "unidex.en.sqlite")
REF_ENTITIES  = _env_path("REF_ENTITIES_DB", ROOT / "data" / "reference_entities.sqlite")
OUT_DB        = _env_path("DRUG_REF_DB", DRUG_REF_DB)

# ── Micromedex sub_section_id map ────────────────────────────────────────────
MM_SUB = {
    "generic_name":               3,
    "adult_dosing":               4,
    "pediatric_dosing":           5,
    "dose_adjustments":           6,
    "indications":                7,
    "black_box_warning":          8,
    "contraindications":          9,
    "precautions":                10,
    "pregnancy":                  11,
    "breast_feeding":             12,
    "interactions_contraindicated": 13,
    "interactions_major":         14,
    "interactions_moderate":      15,
    "adverse_effects":            16,
    "us_trade_names":             17,
    "synonyms":                   18,
    "drug_class_mm":              19,
    "regulatory_status":          20,
    "generic_available":          21,
    "mechanism":                  22,
    "absorption":                 23,
    "distribution":               24,
    "metabolism":                 25,
    "excretion":                  26,
    "half_life":                  27,
    "administration":             28,
    "monitoring":                 29,
    "how_supplied":               30,
    "toxicology_effects":         31,
    "toxicology_treatment":       32,
}

# ── UTD drugH1 heading → section_key ────────────────────────────────────────
UTD_HEADING_MAP = {
    "ALERT: US Boxed Warning":              "black_box_warning",
    "Brand Names: US":                      "brand_names_us",
    "Brand Names: Canada":                  "brand_names_ca",
    "Pharmacologic Category":               "drug_class_utd",
    "Dosing: Adult":                        "adult_dosing",
    "Dosing: Kidney Impairment: Adult":     "renal_dosing",
    "Dosing: Liver Impairment: Adult":      "hepatic_dosing",
    "Dosing: Older Adult":                  "adult_dosing_elderly",
    "Dosing: Pediatric":                    "pediatric_dosing",
    "Dosing: Kidney Impairment: Pediatric": "renal_dosing_pediatric",
    "Dosing: Liver Impairment: Pediatric":  "hepatic_dosing_pediatric",
    "Adverse Reactions":                    "adverse_effects",
    "Adverse Reactions (Significant): Considerations": "adverse_effects_significant",
    "Contraindications":                    "contraindications",
    "Warnings/Precautions":                 "precautions",
    "Dosage Forms: US":                     "how_supplied",
    "Mechanism of Action":                  "mechanism",
    "Pharmacokinetics":                     "pharmacokinetics",
    "Use: Labeled Indications":             "indications",
    "Use: Off-Label":                       "indications_off_label",
    "Use: Off-Label: Adult":                "indications_off_label",
    "Use: Off-Label: Pediatric":            "indications_off_label_pediatric",
    "Use: Unsupported":                     "indications_unsupported",
    "Use: Unsupported: Adult":              "indications_unsupported",
    "Use: Unsupported: Pediatric":          "indications_unsupported_pediatric",
    "Monitoring Parameters":                "monitoring",
    "Reproductive Considerations":          "pregnancy",
    "Breastfeeding Considerations":         "breast_feeding",
}

# Source priority per section_key: first source with content_len > 20 wins
SECTION_PRIORITY: dict[str, list[str]] = {
    "adult_dosing":               ["utd", "mm"],
    "pediatric_dosing":           ["utd", "mm"],
    "renal_dosing":               ["utd", "mm"],
    "hepatic_dosing":             ["utd", "mm"],
    "renal_dosing_pediatric":     ["utd"],
    "hepatic_dosing_pediatric":   ["utd"],
    "adult_dosing_elderly":       ["utd", "mm"],
    "black_box_warning":          ["utd", "mm"],
    "precautions":                ["utd", "mm"],
    "adverse_effects":            ["mm", "utd"],
    "interactions_contraindicated": ["mm"],
    "interactions_major":         ["mm"],
    "interactions_moderate":      ["mm"],
    "contraindications":          ["mm", "utd"],
    "mechanism":                  ["mm", "utd"],
    "absorption":                 ["mm"],
    "distribution":               ["mm"],
    "metabolism":                 ["mm"],
    "excretion":                  ["mm"],
    "half_life":                  ["mm"],
    "administration":             ["mm"],
    "monitoring":                 ["mm"],
    "how_supplied":               ["mm", "utd"],
    "indications":                ["mm", "utd"],
    "indications_off_label":      ["utd"],
    "indications_off_label_pediatric": ["utd"],
    "indications_unsupported":    ["utd"],
    "indications_unsupported_pediatric": ["utd"],
    "toxicology_effects":         ["mm"],
    "toxicology_treatment":       ["mm"],
    "pregnancy":                  ["mm", "utd"],
    "breast_feeding":             ["mm", "utd"],
    "pharmacokinetics":           ["utd", "mm"],
}

# ── DDL ──────────────────────────────────────────────────────────────────────
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS drugs (
    drug_id               INTEGER PRIMARY KEY,
    generic_name          TEXT    NOT NULL,
    mm_drug_id            INTEGER,
    utd_topic_id          INTEGER,
    ref_entity_id         TEXT,
    rxcui                 TEXT,
    rxcui_tty             TEXT,
    drug_class            TEXT,
    is_generic_available  INTEGER DEFAULT 0,
    regulatory_status     TEXT,
    has_black_box         INTEGER DEFAULT 0,
    coverage_tier         INTEGER DEFAULT 0,
    coverage_status       TEXT,
    created_at            INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS drug_brands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id     INTEGER NOT NULL REFERENCES drugs(drug_id),
    brand_name  TEXT    NOT NULL,
    country     TEXT    DEFAULT 'US'
);

CREATE TABLE IF NOT EXISTS drug_quick_info (
    drug_id           INTEGER PRIMARY KEY REFERENCES drugs(drug_id),
    generic_name      TEXT NOT NULL,
    brand_names       TEXT,
    drug_class        TEXT,
    dose_snippet      TEXT,
    bbw_snippet       TEXT,
    regulatory_status TEXT,
    search_text       TEXT
);

CREATE TABLE IF NOT EXISTS drug_class_tags (
    drug_id     INTEGER NOT NULL REFERENCES drugs(drug_id),
    label       TEXT    NOT NULL,
    label_norm  TEXT    NOT NULL,
    PRIMARY KEY (drug_id, label_norm)
);
CREATE INDEX IF NOT EXISTS idx_drug_class_tags_norm ON drug_class_tags(label_norm, drug_id);

CREATE TABLE IF NOT EXISTS drug_sections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id      INTEGER NOT NULL REFERENCES drugs(drug_id),
    section_key  TEXT    NOT NULL,
    source       TEXT    NOT NULL,
    content_html TEXT,
    content_text TEXT,
    content_len  INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_drug_sections ON drug_sections(drug_id, section_key);
CREATE INDEX IF NOT EXISTS idx_drug_sections_drug ON drug_sections(drug_id);

CREATE TABLE IF NOT EXISTS drug_icd (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id     INTEGER NOT NULL REFERENCES drugs(drug_id),
    icd9        TEXT,
    icd10       TEXT,
    description TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS drug_fts USING fts5(
    drug_id   UNINDEXED,
    generic_name,
    brand_names,
    drug_class,
    indications,
    tokenize='unicode61 remove_diacritics 1'
);

CREATE TABLE IF NOT EXISTS build_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

DROP_SQL = """
DROP TABLE IF EXISTS drug_fts;
DROP TABLE IF EXISTS drug_review_queue;
DROP TABLE IF EXISTS clinical_extraction_issues;
DROP TABLE IF EXISTS clinical_extraction_runs;
DROP TABLE IF EXISTS drug_side_effects_quick;
DROP TABLE IF EXISTS drug_interactions_quick;
DROP TABLE IF EXISTS drug_warnings_quick;
DROP TABLE IF EXISTS drug_hepatic_adjust;
DROP TABLE IF EXISTS drug_renal_adjust;
DROP TABLE IF EXISTS drug_dosing_rules;
DROP TABLE IF EXISTS drug_indications;
DROP TABLE IF EXISTS drug_strengths;
DROP TABLE IF EXISTS drug_dose_forms;
DROP TABLE IF EXISTS drug_ndc;
DROP TABLE IF EXISTS drug_atc;
DROP TABLE IF EXISTS drug_aliases;
DROP TABLE IF EXISTS drug_ingredients;
DROP TABLE IF EXISTS drug_id_aliases;
DROP TABLE IF EXISTS drug_sections;
DROP TABLE IF EXISTS drug_icd;
DROP TABLE IF EXISTS drug_class_tags;
DROP TABLE IF EXISTS drug_quick_info;
DROP TABLE IF EXISTS drug_brands;
DROP TABLE IF EXISTS drugs;
DROP TABLE IF EXISTS build_meta;
"""

# ── Helpers ──────────────────────────────────────────────────────────────────

def html_to_text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html or "")
    for ent, rep in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                     ("&nbsp;", " "), ("&#160;", " "), ("&mdash;", "—"),
                     ("&ndash;", "–"), ("&ge;", "≥"), ("&le;", "≤")]:
        text = text.replace(ent, rep)
    return re.sub(r"\s+", " ", text).strip()


def extract_dose_snippet(adult_dose_html: str, max_len: int = 110) -> str:
    """Extract a concise dose string from adult dosing HTML for search snippets."""
    if not adult_dose_html:
        return ""
    text = html_to_text(adult_dose_html)
    # Look for sentence with numeric dose + unit
    dose_pattern = re.compile(
        r"[^.!?]*\d+(?:\.\d+)?\s*(?:to|-)\s*\d+(?:\.\d+)?\s*"
        r"(?:mg|mcg|g|mEq|units?|mL|tab|cap)[^.!?]*[.!?]",
        re.IGNORECASE,
    )
    m = dose_pattern.search(text)
    if m:
        snippet = m.group(0).strip()
        if len(snippet) <= max_len:
            return snippet
        return snippet[:max_len - 3] + "..."
    # Fallback: first sentence with any dose unit
    short_pattern = re.compile(
        r"\d+(?:\.\d+)?\s*(?:mg|mcg|g|mEq|units?|mL)",
        re.IGNORECASE,
    )
    for sentence in re.split(r"[.!?]", text):
        if short_pattern.search(sentence) and len(sentence.strip()) > 8:
            s = sentence.strip()
            return s[:max_len - 3] + "..." if len(s) > max_len else s
    # Last resort: first 80 chars of plain text
    return text[:80] + ("..." if len(text) > 80 else "")


def extract_utd_sections(body_html: str) -> dict[str, str]:
    """Split UTD bodyHtml by drugH1 class headings → section_key: inner_html."""
    pattern = re.compile(r'(<[^>]+class="drugH1"[^>]*>)(.*?)(</[^>]+>)', re.DOTALL)
    matches = list(pattern.finditer(body_html))
    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        heading_text = html_to_text(m.group(2)).strip()
        section_key  = UTD_HEADING_MAP.get(heading_text)
        if section_key is None:
            continue
        start = m.end()
        end   = matches[i + 1].start() if i + 1 < len(matches) else len(body_html)
        sections[section_key] = body_html[start:end]
    return sections


def parse_brands_from_html(html: str) -> list[str]:
    """Extract brand names from Micromedex sub_section_id=17 HTML."""
    return [html_to_text(m) for m in re.findall(r"<li>(.*?)</li>", html or "", re.DOTALL)
            if html_to_text(m).strip()]


_ANTIARRHYTHMIC_GROUP_RE = re.compile(
    r"\bAntiarrhythmic,\s*Group\s+(IA|IB|IC|II|III|IV)\b",
    re.IGNORECASE,
)


def class_labels(raw: str) -> list[str]:
    labels: list[str] = []
    for part in re.split(r"[|;]", raw or ""):
        text = re.sub(r"\s+", " ", part).strip(" ,")
        if not text:
            continue
        match = _ANTIARRHYTHMIC_GROUP_RE.search(text)
        labels.append(f"Antiarrhythmic, Group {match.group(1).upper()}" if match else text)
    return list(dict.fromkeys(labels))


def class_label_norm(label: str) -> str:
    return re.sub(r"\s+", " ", label or "").strip().lower()


def open_ro(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA cache_size=-16000")
    return c


def mm_mono(conn: sqlite3.Connection, drug_id: int, sub_id: int) -> str:
    row = conn.execute(
        "SELECT monograph FROM drug_mono WHERE drug_id = ? AND sub_section_id = ?",
        (drug_id, sub_id),
    ).fetchone()
    return (row[0] or "") if row else ""


def find_utd_topic(index_conn: sqlite3.Connection, generic_name: str) -> Optional[int]:
    """Multi-step fuzzy match: exact → prefix → LIKE."""
    tables = {r["name"] for r in index_conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    if "topic" in tables:
        id_col = "topic_id"
        table = "topic"
        subtype_filter = ""
    else:
        id_col = "id"
        table = "topics"
        subtype_filter = " AND subtype = 'drug_general'"

    # Try the exact Micromedex title, then common base-name variants after
    # removing trailing salt/ester qualifiers.
    names = [generic_name.strip()]
    base = re.sub(
        r"\s+(hydrochloride|sulfate|sodium|potassium|acetate|mesylate|maleate|tartrate|succinate|"
        r"fumarate|phosphate|nitrate|chloride|bromide|calcium|magnesium|hcl)$",
        "",
        generic_name,
        flags=re.IGNORECASE,
    ).strip()
    if base and base.lower() != generic_name.strip().lower():
        names.append(base)

    for name in names:
        row = index_conn.execute(
            f"SELECT {id_col} FROM {table} WHERE lower(title) = lower(?){subtype_filter}",
            (f"{name}: Drug information",),
        ).fetchone()
        if row:
            return int(row[0])

        row = index_conn.execute(
            f"SELECT {id_col} FROM {table} WHERE lower(title) LIKE lower(?){subtype_filter} LIMIT 1",
            (f"{name}%drug information%",),
        ).fetchone()
        if row:
            return int(row[0])

    return None


def get_utd_body(asset_conn: sqlite3.Connection, topic_id: int) -> str:
    """Return bodyHtml string from UTD asset DB for a given topic_id."""
    row = asset_conn.execute(
        "SELECT content FROM topic_content WHERE id = ?",
        (topic_id,),
    ).fetchone()
    if not row:
        return ""
    try:
        data = json.loads(row[0])
    except Exception:
        return ""
    # Try common key patterns
    body = data.get("bodyHtml") or data.get("body_html") or ""
    if not body:
        for key in ("topicContent", "content"):
            if isinstance(data.get(key), dict):
                body = data[key].get("bodyHtml", "") or data[key].get("body_html", "")
                if body:
                    break
    return body


def find_ref_entity(ref_conn: Optional[sqlite3.Connection], name: str) -> Optional[str]:
    if not ref_conn:
        return None
    row = ref_conn.execute(
        "SELECT entity_id FROM aliases WHERE lower(alias) = lower(?) LIMIT 1",
        (name,),
    ).fetchone()
    return row[0] if row else None


def get_icd_codes(ref_conn: Optional[sqlite3.Connection], entity_id: str) -> list[dict]:
    if not ref_conn or not entity_id:
        return []
    cols = {r["name"] for r in ref_conn.execute("PRAGMA table_info(icd_codes)").fetchall()}
    if {"code", "system", "description"}.issubset(cols):
        rows = ref_conn.execute(
            "SELECT code, system, description FROM icd_codes WHERE entity_id = ?",
            (entity_id,),
        ).fetchall()
        return [{
            "icd9": r["code"] if str(r["system"]).upper().startswith("ICD-9") else None,
            "icd10": r["code"] if str(r["system"]).upper().startswith("ICD-10") else None,
            "description": r["description"] or "",
        } for r in rows]

    if not {"icd9", "icd10", "description"}.issubset(cols):
        return []

    rows = ref_conn.execute(
        "SELECT icd9, icd10, description FROM icd_codes WHERE entity_id = ?",
        (entity_id,),
    ).fetchall()
    return [{"icd9": r["icd9"], "icd10": r["icd10"], "description": r["description"] or ""}
            for r in rows]


# ── Main build ────────────────────────────────────────────────────────────────

def build(limit: Optional[int], rebuild: bool, skip_utd: bool):
    t0 = time.time()

    for db_path in [MICROMEDEX_DB]:
        if not db_path.exists():
            print(f"ERROR: Required DB not found: {db_path}")
            sys.exit(1)

    print(f"\nOpening source databases…")
    mm    = open_ro(MICROMEDEX_DB)
    utd_i = open_ro(UTD_INDEX_DB) if UTD_INDEX_DB.exists() else None
    utd_a = open_ro(UTD_ASSET_DB) if (UTD_ASSET_DB.exists() and not skip_utd) else None
    ref   = open_ro(REF_ENTITIES) if REF_ENTITIES.exists() else None

    if utd_a:
        print(f"  UpToDate asset DB open ({UTD_ASSET_DB.stat().st_size / 1e9:.1f} GB)")
    else:
        print("  UpToDate asset DB: skipped")
    if ref:
        print("  Reference entities DB open")

    # ── Open / reset output DB ──────────────────────────────────────────────
    OUT_DB.parent.mkdir(parents=True, exist_ok=True)
    out = sqlite3.connect(str(OUT_DB))
    out.row_factory = sqlite3.Row
    out.execute("PRAGMA journal_mode=WAL")
    out.execute("PRAGMA synchronous=NORMAL")
    out.execute("PRAGMA cache_size=-32000")

    # FTS is fully rebuilt at the end; dropping it avoids stale external-content
    # schemas from older builds.
    out.execute("DROP TABLE IF EXISTS drug_fts")

    if rebuild:
        print("Dropping existing tables…")
        for stmt in DROP_SQL.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                out.execute(stmt)
        out.commit()

    for stmt in SCHEMA_SQL.strip().split(";"):
        stmt = stmt.strip()
        if stmt:
            out.execute(stmt)
    out.commit()

    # ── Fetch all MM generic drugs ──────────────────────────────────────────
    mm_drugs = mm.execute(
        "SELECT drug_id, title FROM drug_generic_name ORDER BY title"
    ).fetchall()
    if limit:
        mm_drugs = mm_drugs[:limit]

    total = len(mm_drugs)
    print(f"\nProcessing {total} drugs…\n")

    errors: list[str] = []
    section_count = 0

    for idx, mm_row in enumerate(mm_drugs, 1):
        drug_id   = int(mm_row["drug_id"])
        generic   = mm_row["title"].strip()

        try:
            # ── Find UTD match ──────────────────────────────────────────────
            utd_topic_id: Optional[int] = None
            if utd_i and not skip_utd:
                utd_topic_id = find_utd_topic(utd_i, generic)

            # ── Reference entity ────────────────────────────────────────────
            ref_entity_id = find_ref_entity(ref, generic)

            # ── Brand names from MM sub_id=17 ───────────────────────────────
            brand_html = mm_mono(mm, drug_id, MM_SUB["us_trade_names"])
            brands_mm  = parse_brands_from_html(brand_html)

            # ── Brand names from UTD body if available ─────────────────────
            utd_sections: dict[str, str] = {}
            if utd_a and utd_topic_id:
                body = get_utd_body(utd_a, utd_topic_id)
                if body:
                    utd_sections = extract_utd_sections(body)

            brands_utd_html = utd_sections.get("brand_names_us", "")
            brands_utd = [html_to_text(m) for m in re.findall(r"<li>(.*?)</li>",
                                                                brands_utd_html, re.DOTALL)
                          if html_to_text(m).strip()] if brands_utd_html else []

            # Merge, deduplicate, US brands first
            all_brands = list(dict.fromkeys(brands_utd + brands_mm))

            # ── Drug class ──────────────────────────────────────────────────
            class_html = mm_mono(mm, drug_id, MM_SUB["drug_class_mm"])
            drug_class_text = html_to_text(class_html).strip()

            # Fallback: UTD pharmacologic category
            if not drug_class_text and "drug_class_utd" in utd_sections:
                drug_class_text = html_to_text(utd_sections["drug_class_utd"]).strip()

            # ── Regulatory status ───────────────────────────────────────────
            reg_html = mm_mono(mm, drug_id, MM_SUB["regulatory_status"])
            reg_text = html_to_text(reg_html).strip()
            if "rems" in reg_text.lower():
                regulatory_status = "REMS"
            elif "otc" in reg_text.lower() or "over-the-counter" in reg_text.lower():
                regulatory_status = "OTC"
            else:
                regulatory_status = "RX"

            # ── Generic available ───────────────────────────────────────────
            gen_avail_html = mm_mono(mm, drug_id, MM_SUB["generic_available"])
            gen_avail_text = html_to_text(gen_avail_html).lower()
            is_generic_available = 1 if "yes" in gen_avail_text else 0

            # ── Black box warning ───────────────────────────────────────────
            bbw_html_mm  = mm_mono(mm, drug_id, MM_SUB["black_box_warning"])
            bbw_html_utd = utd_sections.get("black_box_warning", "")
            bbw_html     = bbw_html_utd if len(bbw_html_utd) > len(bbw_html_mm) else bbw_html_mm
            bbw_text     = html_to_text(bbw_html)
            has_black_box = 1 if len(bbw_text) > 10 else 0
            bbw_snippet   = bbw_text[:160] if has_black_box else None

            # ── INSERT core drug row ────────────────────────────────────────
            out.execute(
                """INSERT OR REPLACE INTO drugs
                   (drug_id, generic_name, mm_drug_id, utd_topic_id, ref_entity_id,
                    drug_class, is_generic_available, regulatory_status, has_black_box)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (drug_id, generic, drug_id, utd_topic_id, ref_entity_id,
                 drug_class_text, is_generic_available, regulatory_status, has_black_box),
            )

            out.execute("DELETE FROM drug_class_tags WHERE drug_id = ?", (drug_id,))
            for class_label in class_labels(drug_class_text):
                out.execute(
                    "INSERT OR IGNORE INTO drug_class_tags (drug_id, label, label_norm) VALUES (?,?,?)",
                    (drug_id, class_label, class_label_norm(class_label)),
                )

            # ── INSERT brand names ──────────────────────────────────────────
            out.execute("DELETE FROM drug_brands WHERE drug_id = ?", (drug_id,))
            for brand in all_brands[:20]:
                if brand.strip():
                    out.execute(
                        "INSERT INTO drug_brands (drug_id, brand_name, country) VALUES (?,?,?)",
                        (drug_id, brand.strip(), "US"),
                    )

            # ── INSERT ICD codes ────────────────────────────────────────────
            out.execute("DELETE FROM drug_icd WHERE drug_id = ?", (drug_id,))
            if ref_entity_id:
                icd_rows = get_icd_codes(ref, ref_entity_id)
                for r in icd_rows:
                    out.execute(
                        "INSERT INTO drug_icd (drug_id, icd9, icd10, description) VALUES (?,?,?,?)",
                        (drug_id, r["icd9"], r["icd10"], r["description"]),
                    )

            # ── BUILD SECTION POOL: gather html per section_key from both sources ──
            mm_pool: dict[str, str] = {}
            for sk, sub_id in MM_SUB.items():
                if sk in ("drug_class_mm", "regulatory_status", "generic_available",
                           "us_trade_names", "synonyms", "generic_name"):
                    continue
                html = mm_mono(mm, drug_id, sub_id)
                if html and len(html_to_text(html)) > 10:
                    mm_pool[sk] = html

            # Handle renal_dosing from dose_adjustments fallback
            if "renal_dosing" not in utd_sections and "dose_adjustments" in mm_pool:
                adj_text = html_to_text(mm_pool["dose_adjustments"])
                if re.search(r"renal|CrCl|creatinine|GFR|dialysis", adj_text, re.I):
                    mm_pool["renal_dosing"] = mm_pool["dose_adjustments"]
            if "hepatic_dosing" not in utd_sections and "dose_adjustments" in mm_pool:
                adj_text = html_to_text(mm_pool["dose_adjustments"])
                if re.search(r"hepatic|liver|cirrhosis|Child.Pugh", adj_text, re.I):
                    mm_pool["hepatic_dosing"] = mm_pool["dose_adjustments"]

            # UTD pool
            utd_pool: dict[str, str] = {k: v for k, v in utd_sections.items()
                                         if k not in ("brand_names_us", "brand_names_ca", "drug_class_utd")}

            # ── INSERT drug_sections using priority ─────────────────────────
            out.execute("DELETE FROM drug_sections WHERE drug_id = ?", (drug_id,))
            for section_key, source_order in SECTION_PRIORITY.items():
                pools = {"mm": mm_pool, "utd": utd_pool}
                for src in source_order:
                    html = pools[src].get(section_key, "")
                    text = html_to_text(html)
                    if len(text) > 20:
                        out.execute(
                            """INSERT OR REPLACE INTO drug_sections
                               (drug_id, section_key, source, content_html, content_text, content_len)
                               VALUES (?,?,?,?,?,?)""",
                            (drug_id, section_key, src, html, text, len(text)),
                        )
                        section_count += 1
                        break

            # ── dose_snippet for quick_info ─────────────────────────────────
            adult_html = (utd_pool.get("adult_dosing") or mm_pool.get("adult_dosing") or "")
            dose_snippet = extract_dose_snippet(adult_html)

            # ── quick_info ──────────────────────────────────────────────────
            brands_str  = ", ".join(all_brands[:3])
            dc_first    = drug_class_text.split("|")[0].split(";")[0].strip()[:60]
            search_text = f"{generic} {brands_str} {drug_class_text}"

            out.execute(
                """INSERT OR REPLACE INTO drug_quick_info
                   (drug_id, generic_name, brand_names, drug_class,
                    dose_snippet, bbw_snippet, regulatory_status, search_text)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (drug_id, generic, brands_str, dc_first,
                 dose_snippet, bbw_snippet, regulatory_status, search_text),
            )

        except Exception as exc:
            errors.append(f"{generic}: {exc}")

        if idx % 100 == 0 or idx == total:
            elapsed = time.time() - t0
            rate = idx / elapsed
            eta  = (total - idx) / rate if rate > 0 else 0
            print(f"  [{idx:>4}/{total}]  {generic:<40}  {elapsed:.0f}s elapsed  ETA {eta:.0f}s")
            out.commit()

    out.commit()

    # ── Populate FTS ────────────────────────────────────────────────────────
    print("\nBuilding FTS5 index…")
    out.execute("DELETE FROM drug_fts")
    out.execute("""
        INSERT INTO drug_fts (drug_id, generic_name, brand_names, drug_class, indications)
        SELECT
            qi.drug_id,
            qi.generic_name,
            COALESCE(qi.brand_names, ''),
            COALESCE(qi.drug_class, ''),
            COALESCE(
                (SELECT substr(ds.content_text, 1, 300)
                 FROM drug_sections ds
                 WHERE ds.drug_id = qi.drug_id AND ds.section_key = 'indications'
                 LIMIT 1),
                ''
            )
        FROM drug_quick_info qi
    """)
    out.commit()

    # ── Write build_meta ────────────────────────────────────────────────────
    drug_count = out.execute("SELECT COUNT(*) FROM drugs").fetchone()[0]
    out.executemany("INSERT OR REPLACE INTO build_meta (key, value) VALUES (?,?)", [
        ("built_at",       time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        ("drug_count",     str(drug_count)),
        ("section_count",  str(section_count)),
        ("mm_path",        str(MICROMEDEX_DB)),
        ("utd_asset_path", str(UTD_ASSET_DB)),
        ("utd_index_path", str(UTD_INDEX_DB)),
        ("utd_used",       "true" if utd_a else "false"),
        ("mm_version",     "v3661_2502112345"),
    ])
    out.commit()

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"  Done in {elapsed:.0f}s")
    print(f"  Drugs:    {drug_count}")
    print(f"  Sections: {section_count}")
    print(f"  Errors:   {len(errors)}")
    print(f"  Output:   {OUT_DB}")
    print(f"  Size:     {OUT_DB.stat().st_size / 1e6:.1f} MB")
    if errors[:5]:
        print("\n  First errors:")
        for e in errors[:5]:
            print(f"    {e}")
    print()

    for conn in [mm, utd_i, utd_a, ref, out]:
        if conn:
            conn.close()


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Build unified drug_reference.sqlite")
    p.add_argument("--limit",    type=int, default=None, help="Process only first N drugs")
    p.add_argument("--rebuild",  action="store_true", help="Drop and recreate all tables")
    p.add_argument("--skip-utd", action="store_true", help="Skip UTD enrichment (faster, MM-only)")
    args = p.parse_args()
    build(args.limit, args.rebuild, args.skip_utd)

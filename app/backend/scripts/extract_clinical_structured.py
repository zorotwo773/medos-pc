"""Extract structured clinical rows for every medication.

This is intentionally conservative: every drug gets an extraction attempt and
review-queue outcome, but prescription generation is only enabled when the
parsed rule has enough structure to be auditable.
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

try:
    from selectolax.parser import HTMLParser
except Exception:  # pragma: no cover - dependency is optional for script fallback
    HTMLParser = None
try:
    import yaml
except Exception:  # pragma: no cover - reviewed overlays are optional
    yaml = None

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import DRUG_REF_DB, MICROMEDEX_INTERACTION_DB


OVERLAY_DIR = _BACKEND / "dosing_overlay"


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS drug_indications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    indication_text TEXT NOT NULL,
    indication_rank INTEGER NOT NULL DEFAULT 0,
    label_status TEXT,
    snomed_code TEXT,
    source_section_id INTEGER,
    source_name TEXT,
    confidence TEXT DEFAULT 'low',
    review_status TEXT DEFAULT 'unreviewed',
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drug_indications_drug ON drug_indications(drug_id, indication_rank);

CREATE TABLE IF NOT EXISTS drug_dosing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    indication_id INTEGER,
    population TEXT NOT NULL,
    mg_per_kg_low REAL,
    mg_per_kg_high REAL,
    dose_basis TEXT,
    divisions_per_day REAL,
    max_mg_per_day REAL,
    max_mg_per_dose REAL,
    default_duration_days INTEGER,
    route TEXT,
    dose_form TEXT,
    notes TEXT,
    source_section_id INTEGER,
    source_name TEXT,
    source_priority INTEGER DEFAULT 0,
    confidence TEXT DEFAULT 'low',
    extraction_method TEXT DEFAULT 'regex',
    review_status TEXT DEFAULT 'unreviewed',
    parse_warnings TEXT,
    min_age_years REAL,
    max_age_years REAL,
    min_weight_kg REAL,
    max_weight_kg REAL,
    fixed_dose_low REAL,
    fixed_dose_high REAL,
    dose_unit TEXT,
    frequency_code TEXT,
    duration_low_days INTEGER,
    duration_high_days INTEGER,
    is_prn INTEGER DEFAULT 0,
    prn_reason TEXT,
    schedule_context TEXT,
    rx_ready INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_drug_dosing_rules_drug ON drug_dosing_rules(drug_id, population, indication_id);

CREATE TABLE IF NOT EXISTS drug_renal_adjust (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    crcl_min REAL,
    crcl_max REAL,
    adjustment_factor REAL,
    adjustment_text TEXT,
    source_section_id INTEGER,
    source_name TEXT,
    confidence TEXT DEFAULT 'low',
    review_status TEXT DEFAULT 'unreviewed'
);
CREATE INDEX IF NOT EXISTS idx_drug_renal_adjust_drug ON drug_renal_adjust(drug_id);

CREATE TABLE IF NOT EXISTS drug_hepatic_adjust (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    child_pugh_class TEXT,
    adjustment_factor REAL,
    adjustment_text TEXT,
    source_section_id INTEGER,
    source_name TEXT,
    confidence TEXT DEFAULT 'low',
    review_status TEXT DEFAULT 'unreviewed'
);
CREATE INDEX IF NOT EXISTS idx_drug_hepatic_adjust_drug ON drug_hepatic_adjust(drug_id);

CREATE TABLE IF NOT EXISTS drug_warnings_quick (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    warning_text TEXT NOT NULL,
    severity TEXT DEFAULT 'common',
    source_section_id INTEGER,
    source_name TEXT,
    confidence TEXT DEFAULT 'low',
    review_status TEXT DEFAULT 'unreviewed'
);
CREATE INDEX IF NOT EXISTS idx_drug_warnings_quick_drug ON drug_warnings_quick(drug_id);

CREATE TABLE IF NOT EXISTS drug_interactions_quick (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    interacting_rxcui TEXT,
    interacting_name TEXT NOT NULL,
    severity TEXT DEFAULT 'major',
    mechanism TEXT,
    source_section_id INTEGER,
    source_name TEXT,
    confidence TEXT DEFAULT 'low',
    review_status TEXT DEFAULT 'unreviewed'
);
CREATE INDEX IF NOT EXISTS idx_drug_interactions_quick_drug ON drug_interactions_quick(drug_id);

CREATE TABLE IF NOT EXISTS drug_side_effects_quick (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    effect_text TEXT NOT NULL,
    frequency TEXT DEFAULT 'common',
    source_section_id INTEGER,
    source_name TEXT,
    confidence TEXT DEFAULT 'low',
    review_status TEXT DEFAULT 'unreviewed'
);
CREATE INDEX IF NOT EXISTS idx_drug_side_effects_quick_drug ON drug_side_effects_quick(drug_id);

CREATE TABLE IF NOT EXISTS clinical_extraction_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT,
    completed_at TEXT,
    rxnorm_version TEXT,
    drug_reference_version TEXT,
    total_drugs INTEGER,
    linked_drugs INTEGER,
    drugs_with_any_dose INTEGER,
    drugs_with_rx_ready_dose INTEGER,
    warnings_count INTEGER,
    errors_count INTEGER
);

CREATE TABLE IF NOT EXISTS clinical_extraction_issues (
    issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    drug_id INTEGER,
    issue_type TEXT,
    severity TEXT,
    message TEXT,
    source_section_id INTEGER,
    suggested_action TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clinical_issues_drug ON clinical_extraction_issues(drug_id, resolved_at);

CREATE TABLE IF NOT EXISTS drug_review_queue (
    drug_id INTEGER PRIMARY KEY,
    priority_score REAL,
    reason TEXT,
    current_tier INTEGER,
    target_tier INTEGER,
    assigned_to TEXT,
    status TEXT DEFAULT 'open',
    updated_at INTEGER DEFAULT (strftime('%s','now'))
);
"""


SECTION_DELETE = [
    "drug_indications",
    "drug_dosing_rules",
    "drug_renal_adjust",
    "drug_hepatic_adjust",
    "drug_warnings_quick",
    "drug_interactions_quick",
    "drug_side_effects_quick",
    "drug_review_queue",
]


NUM = r"\d[\d,]*(?:\.\d+)?"

DOSE_RANGE_RE = re.compile(
    rf"(?P<low>{NUM})\s*(?:to|-|--|–|—)\s*(?P<high>{NUM})\s*"
    r"(?P<unit>mg|mcg|g|mEq|units?|mL|drops?|puffs?|sprays?|tabs?|tablets?|caps?|capsules?)",
    re.IGNORECASE,
)
DOSE_SINGLE_RE = re.compile(
    rf"(?P<low>{NUM})\s*(?P<unit>mg|mcg|g|mEq|units?|mL|drops?|puffs?|sprays?|tabs?|tablets?|caps?|capsules?)",
    re.IGNORECASE,
)
ROUTE_RE = re.compile(
    r"\b(oral|orally|PO|IV|intravenous|IM|intramuscular|subcutaneous|SC|SQ|topical|"
    r"ophthalmic|otic|inhalation|inhaled|nasal|rectal|vaginal|transdermal)\b",
    re.IGNORECASE,
)
MAX_RE = re.compile(
    rf"(?:maximum|max(?:imum)?(?: dose)?)[^.;:]{{0,80}}?({NUM})\s*(mg|mcg|g|mEq|units?)\s*/?\s*(day|dose|week)?",
    re.IGNORECASE,
)
STRENGTH_VALUE_RE = re.compile(
    rf"(?P<num>{NUM})\s*(?P<unit>MG|MCG|G|UNIT|UNITS|MEQ)"
    rf"(?:\s*/\s*(?P<denom_num>{NUM})?\s*(?P<denom_unit>ML|L))?",
    re.IGNORECASE,
)
DURATION_RE = re.compile(
    r"\b(?:for|x|duration(?:\s+(?:of|ranges?\s+from))?)\s*"
    r"(\d{1,3})(?:\s*(?:to|-|--|–|—)\s*(\d{1,3}))?\s*(?:days?|d)\b",
    re.IGNORECASE,
)


def _connect(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(str(path))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    return c


def _exec_script(c: sqlite3.Connection, sql: str) -> None:
    for stmt in sql.split(";"):
        stmt = stmt.strip()
        if stmt:
            c.execute(stmt)


def _columns(c: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in c.execute(f"PRAGMA table_info({table})")}


def has_table_local(c: sqlite3.Connection, table: str) -> bool:
    return bool(c.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
        (table,),
    ).fetchone())


def _add_column(c: sqlite3.Connection, table: str, definition: str) -> None:
    name = definition.split()[0]
    if name not in _columns(c, table):
        c.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "")
    return text.strip(" ;,.")


def _num(value: str) -> float:
    return float(value.replace(",", ""))


def _unit_to_base(value: float, unit: str) -> tuple[float, str]:
    unit_l = unit.lower()
    if unit_l == "g":
        return value * 1000.0, "mg"
    if unit_l in {"tablet", "tablets", "tab", "tabs"}:
        return value, "tablet"
    if unit_l in {"capsule", "capsules", "cap", "caps"}:
        return value, "capsule"
    if unit_l in {"unit", "units"}:
        return value, "unit"
    if unit_l in {"drop", "drops"}:
        return value, "drop"
    if unit_l in {"puff", "puffs"}:
        return value, "puff"
    if unit_l in {"spray", "sprays"}:
        return value, "spray"
    return value, unit_l


def _parse_frequency(text: str) -> tuple[Optional[str], Optional[float]]:
    lower = text.lower()
    qh = re.search(r"\bq\s*(\d{1,2})\s*h\b", lower)
    if qh:
        hours = int(qh.group(1))
        return f"q{hours}h", round(24 / hours, 2) if hours else None
    every = re.search(r"every\s+(\d{1,2})(?:\s*(?:to|-)\s*(\d{1,2}))?\s+hours?", lower)
    if every:
        hour = int(every.group(2) or every.group(1))
        return f"q{hour}h", round(24 / hour, 2) if hour else None
    times = re.search(r"\b(\d{1,2})(?:\s*(?:to|-|--|–|—)\s*(\d{1,2}))?\s+times\s+daily\b", lower)
    if times:
        low = int(times.group(1))
        high = int(times.group(2) or low)
        if low == high:
            return {
                1: "once_daily",
                2: "bid",
                3: "tid",
                4: "qid",
            }.get(high, f"{high}_times_daily"), float(high)
        return f"{low}_to_{high}_times_daily", float(high)
    patterns: list[tuple[str, float, str]] = [
        ("once daily", 1, "once_daily"),
        ("twice daily", 2, "bid"),
        ("three times daily", 3, "tid"),
        ("four times daily", 4, "qid"),
        ("bid", 2, "bid"),
        ("tid", 3, "tid"),
        ("qid", 4, "qid"),
        ("daily", 1, "daily"),
        ("weekly", 1 / 7, "weekly"),
    ]
    for needle, divisions, code in patterns:
        if re.search(rf"\b{re.escape(needle)}\b", lower, re.IGNORECASE):
            return code, divisions
    if "as needed" in lower or re.search(r"\bprn\b", lower):
        return "prn", None
    return None, None


def _parse_route(text: str) -> Optional[str]:
    match = ROUTE_RE.search(text)
    if not match:
        return None
    route = match.group(1).lower()
    return {
        "orally": "PO",
        "oral": "PO",
        "po": "PO",
        "intravenous": "IV",
        "iv": "IV",
        "intramuscular": "IM",
        "im": "IM",
        "subcutaneous": "SC",
        "sq": "SC",
        "sc": "SC",
    }.get(route, route)


def _extract_duration(text: str) -> tuple[Optional[int], Optional[int]]:
    match = DURATION_RE.search(text)
    if not match:
        return None, None
    low = int(match.group(1))
    high = int(match.group(2) or low)
    return low, high


def _parse_maxima(text: str) -> tuple[Optional[float], Optional[float]]:
    max_day = None
    max_dose = None
    for match in MAX_RE.finditer(text):
        value, unit = _unit_to_base(_num(match.group(1)), match.group(2))
        period = (match.group(3) or "").lower()
        if unit != "mg":
            continue
        if period == "dose":
            max_dose = value
        else:
            max_day = value
    return max_day, max_dose


def _context(text: str, start: int, end: int, radius: int = 180) -> str:
    left = max(0, start - radius)
    right = min(len(text), end + radius)
    ctx = text[left:right]
    # Trim to nearby sentence boundaries when possible.
    lead = max(ctx.rfind(". ", 0, radius), ctx.rfind("; ", 0, radius))
    if lead > 20:
        ctx = ctx[lead + 2 :]
    tail_dot = ctx.find(". ", min(len(ctx), radius))
    if tail_dot > 80:
        ctx = ctx[: tail_dot + 1]
    return _clean_text(ctx)


def _looks_high_risk(name: str, drug_class: str) -> bool:
    text = f"{name} {drug_class}".lower()
    return bool(re.search(
        r"warfarin|heparin|apixaban|rivaroxaban|dabigatran|edoxaban|insulin|"
        r"morphine|oxycodone|hydromorphone|fentanyl|methadone|chemotherapy|"
        r"antineoplastic|thrombolytic|alteplase|tenecteplase|vaccine",
        text,
    ))


def _parse_dosing_rules(
    drug: sqlite3.Row,
    section: sqlite3.Row,
    indication_id: Optional[int],
    has_strengths: bool,
    text_override: Optional[str] = None,
    extraction_method: str = "regex",
) -> list[dict]:
    text = text_override if text_override is not None else (section["content_text"] or "")
    population = "pediatric" if "pediatric" in section["section_key"] else "adult"
    matches = list(DOSE_RANGE_RE.finditer(text))
    if not matches:
        matches = list(DOSE_SINGLE_RE.finditer(text))

    rules: list[dict] = []
    seen: set[str] = set()
    high_risk = _looks_high_risk(drug["generic_name"], drug["drug_class"] or "")
    for match in matches[:12]:
        ctx = _context(text, match.start(), match.end())
        key = re.sub(r"\W+", " ", ctx.lower())[:180]
        if key in seen:
            continue
        seen.add(key)

        low, unit = _unit_to_base(_num(match.group("low")), match.group("unit"))
        high = low
        if "high" in match.groupdict() and match.groupdict().get("high"):
            high, unit = _unit_to_base(_num(match.group("high")), match.group("unit"))
        unit = unit.lower()

        near = text[max(0, match.start() - 60) : min(len(text), match.end() + 100)]
        per_kg = bool(re.search(r"(?:/\s*kg|per\s+kg|mg/kg|mcg/kg)", near, re.IGNORECASE))
        per_day = bool(re.search(r"(?:/\s*day|per\s+day|mg/kg/day|daily dose)", near, re.IGNORECASE))
        frequency_code, divisions = _parse_frequency(ctx)
        route = _parse_route(ctx) or _parse_route(text[: max(300, match.end())])
        duration_low, duration_high = _extract_duration(ctx)
        max_day, max_dose = _parse_maxima(ctx)
        warnings: list[str] = []

        if not route:
            warnings.append("missing_route")
        if not frequency_code:
            warnings.append("missing_frequency")
        if duration_low is None:
            warnings.append("missing_duration")
        if not _looks_high_risk(drug["generic_name"], drug["drug_class"] or "") and re.search(
            r"\bplus\b|\bfollowed by\b|\btaper\b|\bprednisone\b|\bprednisolone\b|\bdexamethasone\b",
            ctx,
            re.IGNORECASE,
        ):
            warnings.append("multi_drug_context")
        if per_kg and population == "adult":
            warnings.append("adult_weight_based")
        if high_risk:
            warnings.append("high_risk_requires_review")

        confidence = "high"
        if warnings:
            confidence = "medium" if len(warnings) <= 2 else "low"
        if high_risk:
            confidence = "low"

        rx_ready = (
            unit == "mg"
            and bool(route)
            and bool(frequency_code)
            and duration_low is not None
            and has_strengths
            and not high_risk
        )

        rules.append({
            "drug_id": drug["drug_id"],
            "indication_id": indication_id,
            "population": population,
            "mg_per_kg_low": low if per_kg and unit == "mg" else None,
            "mg_per_kg_high": high if per_kg and unit == "mg" else None,
            "dose_basis": "per_day" if per_day else ("per_dose" if per_kg else None),
            "divisions_per_day": divisions,
            "max_mg_per_day": max_day,
            "max_mg_per_dose": max_dose,
            "default_duration_days": duration_high,
            "route": route,
            "dose_form": None,
            "notes": ctx,
            "source_section_id": section["id"],
            "source_name": section["source"],
            "source_priority": 0 if section["source"] == "mm" else 1,
            "confidence": confidence,
            "extraction_method": extraction_method,
            "review_status": "needs_review" if high_risk or confidence == "low" else "unreviewed",
            "parse_warnings": json.dumps(warnings),
            "fixed_dose_low": None if per_kg else low,
            "fixed_dose_high": None if per_kg else high,
            "dose_unit": unit,
            "frequency_code": frequency_code,
            "duration_low_days": duration_low,
            "duration_high_days": duration_high,
            "is_prn": 1 if frequency_code == "prn" else 0,
            "prn_reason": None,
            "schedule_context": "loading" if "loading" in ctx.lower() else ("maintenance" if "maintenance" in ctx.lower() else None),
            "rx_ready": 1 if rx_ready else 0,
        })
    return rules


def _node_text(node) -> str:
    if node is None:
        return ""
    try:
        return _clean_text(node.text(separator=" ", strip=True))
    except TypeError:
        return _clean_text(node.text() if hasattr(node, "text") else "")


def _label_status_from_heading(heading: str) -> str:
    h = heading.lower()
    if "non-fda" in h or "off-label" in h or "off label" in h:
        return "off_label"
    if "unsupported" in h:
        return "unsupported"
    if "fda-labeled" in h or "labeled indication" in h or "labelled indication" in h:
        return "fda_labeled"
    return "source_listed"


def _norm_indication(text: str) -> str:
    text = _clean_text(text).lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\b(uncomplicated|complicated|mild|moderate|severe|acute|chronic)\b", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _dedupe_indication_rows(rows: list[dict], limit: int = 80) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        text = _clean_text(row.get("indication_text") or "")
        if not (3 <= len(text) <= 180):
            continue
        if re.search(r"contraindicat|warning", text, re.I):
            continue
        key = _norm_indication(text)
        if not key or key in seen:
            continue
        seen.add(key)
        row["indication_text"] = text
        out.append(row)
        if len(out) >= limit:
            break
    return out


def _extract_indications(text: str) -> list[str]:
    text = _clean_text(text)
    if not text:
        return []
    text = re.sub(r"\bFDA-Labeled Indications\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\bNon-FDA Labeled Indications\b", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\bUses?:\b", " ", text, flags=re.IGNORECASE)
    parts = re.split(r";|\n| {2,}", text)
    out: list[str] = []
    for part in parts:
        part = _clean_text(part)
        if not part:
            continue
        # Micromedex often stores a sequence of title-cased indications with
        # single spaces. Split when a new capitalized phrase likely begins.
        subparts = re.split(
            r"(?<=[a-z\)])\s+(?=(?:Acute|Chronic|Community|Lower|Upper|Skin|"
            r"Pain|Fever|Hypertension|Heart|Diabetes|Migraine|Infection|"
            r"Prophylaxis|Treatment|Prevention|Adjunct|Post|Preterm)\b)",
            part,
        )
        for sub in subparts:
            sub = _clean_text(sub)
            if 3 <= len(sub) <= 120 and not re.search(r"contraindicat|warning", sub, re.I):
                out.append(sub)
    deduped: list[str] = []
    seen: set[str] = set()
    for item in out:
        key = item.lower()
        if key not in seen:
            seen.add(key)
            deduped.append(item)
    return deduped[:40]


def _extract_indication_rows(
    content_html: str,
    content_text: str,
    source: Optional[str],
) -> list[dict]:
    rows: list[dict] = []
    if content_html and HTMLParser is not None:
        tree = HTMLParser(content_html)
        # Micromedex stores actual indication categories as:
        # <b>FDA-Labeled Indications</b><ul><li>...</li></ul>
        for bold in tree.css("b"):
            heading = _node_text(bold)
            if "indication" not in heading.lower() and "use:" not in heading.lower():
                continue
            label_status = _label_status_from_heading(heading)
            node = bold.next
            while node is not None and getattr(node, "tag", None) not in {"ul", "ol"}:
                node = node.next
            if node is None:
                continue
            for li in node.css("li"):
                text = _node_text(li)
                if text:
                    rows.append({
                        "indication_text": text,
                        "label_status": label_status,
                        "source_name": source,
                        "confidence": "high",
                    })

        # UTD/Lexidrug sections are often prose. Pull list items first; if no
        # list exists, fall back to the legacy text splitter below.
        if not rows:
            status = "fda_labeled" if source == "utd" else "source_listed"
            for li in tree.css("li"):
                text = _node_text(li)
                if text:
                    rows.append({
                        "indication_text": text,
                        "label_status": status,
                        "source_name": source,
                        "confidence": "medium",
                    })

    if not rows:
        rows.extend({
            "indication_text": text,
            "label_status": "source_listed",
            "source_name": source,
            "confidence": "medium",
        } for text in _extract_indications(content_text))
    return _dedupe_indication_rows(rows)


def _extract_dosing_blocks(section: sqlite3.Row) -> list[tuple[str, str]]:
    try:
        content_html = section["content_html"] or ""
    except (KeyError, IndexError):
        content_html = ""
    if not content_html or HTMLParser is None:
        return []

    tree = HTMLParser(content_html)
    blocks: list[tuple[str, str]] = []

    # UTD/Lexidrug: each indication has a collapsible wrapper and title.
    for div in tree.css("div.collapsible-indication"):
        title = _node_text(div.css_first(".collapsible-indication-title"))
        wrap = div.css_first(".collapsible-indication-wrap")
        text = _node_text(wrap) or _node_text(div)
        if title and len(text) >= 20:
            blocks.append((title, text))

    if blocks:
        return blocks

    # Micromedex: top-level list items are indication headings with nested dose
    # bullets. This keeps the heading-dose relationship intact.
    for li in tree.css("li"):
        nested = li.css_first("ul")
        bold = li.css_first("b")
        if not nested or not bold:
            continue
        title = _node_text(bold)
        text = _node_text(li)
        if title and len(text) >= 20:
            blocks.append((title, text))
    return blocks


def _dose_form_from_supply_label(label: str) -> Optional[str]:
    text = label.lower()
    if "suspension" in text or "powder" in text:
        return "suspension"
    if "chew" in text and "tablet" in text:
        return "chewable tablet"
    if "extended" in text and "tablet" in text:
        return "extended release tablet"
    if "tablet" in text:
        return "tablet"
    if "capsule" in text:
        return "capsule"
    if "solution" in text:
        return "solution"
    if "injection" in text:
        return "injection"
    return None


def _augment_strengths_from_how_supplied(c: sqlite3.Connection, drug_id: int) -> None:
    if not has_table_local(c, "drug_strengths") or HTMLParser is None:
        return
    row = c.execute(
        """
        SELECT content_html
        FROM drug_sections
        WHERE drug_id = ? AND section_key = 'how_supplied'
        """,
        (drug_id,),
    ).fetchone()
    if not row or not row["content_html"]:
        return

    tree = HTMLParser(row["content_html"])
    for li in tree.css("li"):
        if li.css_first("ul"):
            continue
        text = _node_text(li)
        if ":" not in text or not re.search(r"\d", text):
            continue
        label, values = text.split(":", 1)
        dose_form = _dose_form_from_supply_label(label)
        if not dose_form:
            continue
        for match in STRENGTH_VALUE_RE.finditer(values):
            num = _num(match.group("num"))
            unit = match.group("unit").upper()
            denom_num = match.group("denom_num")
            denom_unit = match.group("denom_unit")
            if unit == "G":
                num *= 1000
                unit = "MG"
            strength_text = f"{_format_strength_text(match.group(0))}"
            if denom_unit:
                denom = _num(denom_num) if denom_num else 1.0
                if denom > 0:
                    num = num / denom
                unit = f"{unit}/{denom_unit.upper()}"
            exists = c.execute(
                """
                SELECT 1
                FROM drug_strengths
                WHERE drug_id = ?
                  AND abs(strength_num - ?) < 0.0001
                  AND upper(COALESCE(strength_unit,'')) = ?
                  AND lower(COALESCE(dose_form,'')) = lower(COALESCE(?, ''))
                LIMIT 1
                """,
                (drug_id, num, unit, dose_form),
            ).fetchone()
            if exists:
                continue
            c.execute(
                """
                INSERT INTO drug_strengths
                    (drug_id, rxcui, strength_num, strength_unit, strength_text, dose_form, route)
                VALUES (?, NULL, ?, ?, ?, ?, ?)
                """,
                (drug_id, num, unit, strength_text, dose_form, "PO" if "oral" in label.lower() else None),
            )


def _format_strength_text(text: str) -> str:
    text = _clean_text(text).upper()
    text = re.sub(r"\s*/\s*", "/", text)
    return re.sub(r"\s+", " ", text)


def _extract_side_effects(text: str) -> list[str]:
    text = _clean_text(text)
    text = re.sub(r"\b(Common|Serious|Significant)\b", " ", text, flags=re.IGNORECASE)
    pieces = re.split(r";|,|\n|(?<=\))\s+(?=[A-Z][a-z]+:)", text)
    out: list[str] = []
    for piece in pieces:
        piece = re.sub(r"^[A-Za-z /-]+:\s*", "", _clean_text(piece))
        piece = re.sub(r"\([^)]*\)", "", piece).strip(" .")
        if 3 <= len(piece) <= 60 and not re.search(r"greater than|less than|overall", piece, re.I):
            out.append(piece)
    return list(dict.fromkeys(out))[:8]


def _extract_interactions(text: str) -> list[str]:
    text = _clean_text(text)
    parts = re.split(r"\)\s+|;|,", text)
    out: list[str] = []
    for part in parts:
        part = re.sub(r"\([^)]*$", "", _clean_text(part))
        if 3 <= len(part) <= 80 and not re.search(r"monitor|avoid|increase|decrease", part, re.I):
            out.append(part)
    return list(dict.fromkeys(out))[:8]


def _open_mm_interactions() -> Optional[sqlite3.Connection]:
    if not MICROMEDEX_INTERACTION_DB.exists():
        return None
    try:
        c = sqlite3.connect(f"file:{MICROMEDEX_INTERACTION_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA cache_size=-16000")
        return c
    except sqlite3.Error:
        return None


def _candidate_mm_drug_ids(c: sqlite3.Connection, drug_id: int) -> list[int]:
    ids = {drug_id}
    row = c.execute(
        "SELECT mm_drug_id FROM drugs WHERE drug_id = ?",
        (drug_id,),
    ).fetchone()
    if row and row["mm_drug_id"]:
        ids.add(int(row["mm_drug_id"]))
    if has_table_local(c, "drug_id_aliases"):
        for alias in c.execute(
            "SELECT old_drug_id FROM drug_id_aliases WHERE new_drug_id = ?",
            (drug_id,),
        ).fetchall():
            ids.add(int(alias["old_drug_id"]))
    return sorted(ids)


def _severity_label(value: str | None) -> str:
    text = (value or "").lower()
    if text.startswith("contra"):
        return "contraindicated"
    if text.startswith("major"):
        return "major"
    if text.startswith("moderate"):
        return "moderate"
    return "minor"


def _evidence_confidence(evidence_id: Optional[int], severity_id: Optional[int]) -> str:
    if severity_id in {1, 2} and evidence_id in {1, 2}:
        return "high"
    if evidence_id in {1, 2, 3}:
        return "medium"
    return "low"


def _display_interacting_name(value: str | None) -> str:
    text = _clean_text(value or "")
    if not text:
        return ""
    small = {"and", "or", "of", "with"}
    words = []
    for word in text.lower().split():
        words.append(word if word in small else word[:1].upper() + word[1:])
    return " ".join(words)


def _insert_mm_interactions_quick(
    c: sqlite3.Connection,
    mm: Optional[sqlite3.Connection],
    drug_id: int,
    limit: int = 6,
) -> int:
    if mm is None:
        return 0
    mm_ids = _candidate_mm_drug_ids(c, drug_id)
    placeholders = ",".join("?" for _ in mm_ids)
    screening_rows = mm.execute(
        f"""
        SELECT DISTINCT screening_item_id
        FROM int_drug_ingredients
        WHERE drug_id IN ({placeholders})
        """,
        tuple(mm_ids),
    ).fetchall()
    screening_ids = [int(row["screening_item_id"]) for row in screening_rows if row["screening_item_id"]]
    if not screening_ids:
        return 0

    own = set(screening_ids)
    placeholders = ",".join("?" for _ in screening_ids)
    rows = mm.execute(
        f"""
        SELECT x.screening_item_id_1, x.screening_item_id_2, x.doc_id,
               other.ingredient_name, other.gm_id AS other_gm_id,
               wm.severity AS severity_id, wm.evidence AS evidence_id, wm.onset AS onset_id,
               wm.monograph AS warning,
               sev.descrip AS severity_label,
               ev.descrip AS evidence_label,
               onset.descrip AS onset_label
        FROM int_xref x
        JOIN int_screen_items other
          ON other.screening_item_id =
             CASE
               WHEN x.screening_item_id_1 IN ({placeholders}) THEN x.screening_item_id_2
               ELSE x.screening_item_id_1
             END
        JOIN int_warn_mono wm ON wm.doc_id = x.doc_id
        LEFT JOIN dict_severity sev ON sev.id = wm.severity
        LEFT JOIN dict_evidence ev ON ev.id = wm.evidence
        LEFT JOIN dict_onset onset ON onset.id = wm.onset
        WHERE x.screening_item_id_1 IN ({placeholders})
           OR x.screening_item_id_2 IN ({placeholders})
        ORDER BY wm.severity, wm.evidence, x.doc_id
        LIMIT 80
        """,
        tuple(screening_ids + screening_ids + screening_ids),
    ).fetchall()

    inserted = 0
    seen: set[str] = set()
    for row in rows:
        other_id = int(row["screening_item_id_2"] if int(row["screening_item_id_1"]) in own else row["screening_item_id_1"])
        if other_id in own:
            continue
        name = _display_interacting_name(row["ingredient_name"])
        if not name or " measurement" in name.lower():
            continue
        key = f"gm:{row['other_gm_id']}" if row["other_gm_id"] else re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        severity = _severity_label(row["severity_label"])
        if severity == "minor":
            continue
        c.execute(
            """
            INSERT INTO drug_interactions_quick
                (drug_id, interacting_name, severity, mechanism, source_section_id,
                 source_name, confidence, review_status)
            VALUES (?,?,?,?,?,?,?,?)
            """,
            (
                drug_id,
                name,
                severity,
                _clean_text(row["warning"] or "")[:240],
                row["doc_id"],
                "mm_interaction",
                _evidence_confidence(row["evidence_id"], row["severity_id"]),
                "unreviewed",
            ),
        )
        inserted += 1
        if inserted >= limit:
            break
    return inserted


def _extract_warnings(c: sqlite3.Connection, drug_id: int) -> list[tuple[str, str, Optional[int], Optional[str]]]:
    out: list[tuple[str, str, Optional[int], Optional[str]]] = []
    rows = c.execute(
        """
        SELECT id, section_key, source, content_text
        FROM drug_sections
        WHERE drug_id = ?
          AND section_key IN ('black_box_warning','contraindications','precautions')
        ORDER BY CASE section_key
            WHEN 'black_box_warning' THEN 0 WHEN 'contraindications' THEN 1 ELSE 2 END
        """,
        (drug_id,),
    ).fetchall()
    for row in rows:
        text = _clean_text(row["content_text"] or "")
        if not text:
            continue
        severity = "boxed" if row["section_key"] == "black_box_warning" else "major"
        if row["section_key"] == "black_box_warning":
            out.append((text[:180], severity, row["id"], row["source"]))
            continue
        for sent in re.split(r"(?<=[.!?])\s+|;", text):
            sent = _clean_text(sent)
            if 12 <= len(sent) <= 180 and re.search(r"avoid|contraindicat|risk|caution|hypersensitivity|allergy", sent, re.I):
                out.append((sent, severity, row["id"], row["source"]))
                break
    return out[:5]


def _insert_issue(
    c: sqlite3.Connection,
    run_id: int,
    drug_id: int,
    issue_type: str,
    severity: str,
    message: str,
    source_section_id: Optional[int] = None,
    suggested_action: Optional[str] = None,
) -> None:
    c.execute(
        """
        INSERT INTO clinical_extraction_issues
            (run_id, drug_id, issue_type, severity, message, source_section_id, suggested_action)
        VALUES (?,?,?,?,?,?,?)
        """,
        (run_id, drug_id, issue_type, severity, message, source_section_id, suggested_action),
    )


def _review_queue(
    c: sqlite3.Connection,
    drug_id: int,
    current_tier: int,
    target_tier: int,
    reason: str,
    priority: float,
) -> None:
    c.execute(
        """
        INSERT OR REPLACE INTO drug_review_queue
            (drug_id, priority_score, reason, current_tier, target_tier, status, updated_at)
        VALUES (?,?,?,?,?,'open',strftime('%s','now'))
        """,
        (drug_id, priority, reason, current_tier, target_tier),
    )


def _ensure_indication(
    c: sqlite3.Connection,
    drug_id: int,
    text: str,
    lookup: dict[str, int],
    next_rank: int,
    source_section_id: Optional[int],
    source_name: Optional[str],
    label_status: str = "dosing_section",
    confidence: str = "medium",
) -> tuple[int, int]:
    key = _norm_indication(text)
    if key in lookup:
        return lookup[key], next_rank
    cur = c.execute(
        """
        INSERT INTO drug_indications
            (drug_id, indication_text, indication_rank, label_status, source_section_id,
             source_name, confidence, review_status)
        VALUES (?,?,?,?,?,?,?,?)
        """,
        (
            drug_id, _clean_text(text), next_rank, label_status, source_section_id,
            source_name, confidence, "unreviewed",
        ),
    )
    indication_id = int(cur.lastrowid)
    lookup[key] = indication_id
    return indication_id, next_rank + 1


def _load_dosing_overlays() -> list[dict]:
    if yaml is None or not OVERLAY_DIR.exists():
        return []
    overlays: list[dict] = []
    for path in sorted(OVERLAY_DIR.glob("*.yaml")):
        if path.name.startswith("_"):
            continue
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if isinstance(data.get("overlays"), list):
            overlays.extend(item for item in data["overlays"] if isinstance(item, dict))
        elif isinstance(data.get("drug"), dict):
            overlays.append(data)
    return overlays


def _overlay_matches(drug: sqlite3.Row, overlay: dict) -> bool:
    meta = overlay.get("drug") or {}
    overlay_rxcui = str(meta.get("rxcui") or "").strip()
    if overlay_rxcui and overlay_rxcui == str(drug["rxcui"] or "").strip():
        return True
    overlay_name = _clean_text(str(meta.get("generic_name") or "")).lower()
    return bool(overlay_name and overlay_name == _clean_text(drug["generic_name"]).lower())


def _ensure_overlay_indication(
    c: sqlite3.Connection,
    drug_id: int,
    text: str,
    lookup: dict[str, int],
    next_rank: int,
    rank: Optional[int] = None,
) -> tuple[int, int]:
    key = _norm_indication(text)
    if key in lookup:
        indication_id = lookup[key]
        c.execute(
            """
            UPDATE drug_indications
            SET label_status = 'reviewed',
                source_name = 'overlay',
                confidence = 'reviewed',
                review_status = 'reviewed'
            WHERE id = ?
            """,
            (indication_id,),
        )
        return indication_id, next_rank
    row_rank = int(rank or next_rank)
    cur = c.execute(
        """
        INSERT INTO drug_indications
            (drug_id, indication_text, indication_rank, label_status, source_section_id,
             source_name, confidence, review_status)
        VALUES (?,?,?,?,?,?,?,?)
        """,
        (
            drug_id,
            _clean_text(text),
            row_rank,
            "reviewed",
            None,
            "overlay",
            "reviewed",
            "reviewed",
        ),
    )
    indication_id = int(cur.lastrowid)
    lookup[key] = indication_id
    return indication_id, max(next_rank, row_rank + 1)


def _insert_overlay_rules(
    c: sqlite3.Connection,
    drug: sqlite3.Row,
    overlay: dict,
    indication_lookup: dict[str, int],
    next_indication_rank: int,
) -> tuple[int, int, int]:
    drug_id = int(drug["drug_id"])
    overlay_indications = overlay.get("indications") or []
    for item in overlay_indications:
        if not isinstance(item, dict) or not item.get("text"):
            continue
        _, next_indication_rank = _ensure_overlay_indication(
            c,
            drug_id,
            item["text"],
            indication_lookup,
            next_indication_rank,
            item.get("rank"),
        )

    inserted_rules = 0
    inserted_rx_ready = 0
    for item in overlay.get("dosing_rules") or []:
        if not isinstance(item, dict) or not item.get("indication"):
            continue
        indication_id, next_indication_rank = _ensure_overlay_indication(
            c,
            drug_id,
            item["indication"],
            indication_lookup,
            next_indication_rank,
            item.get("indication_rank"),
        )
        warnings = item.get("parse_warnings") or []
        rule = {
            "drug_id": drug_id,
            "indication_id": indication_id,
            "population": item.get("population") or "adult",
            "mg_per_kg_low": item.get("mg_per_kg_low"),
            "mg_per_kg_high": item.get("mg_per_kg_high"),
            "dose_basis": item.get("dose_basis"),
            "divisions_per_day": item.get("divisions_per_day"),
            "max_mg_per_day": item.get("max_mg_per_day"),
            "max_mg_per_dose": item.get("max_mg_per_dose"),
            "default_duration_days": item.get("default_duration_days"),
            "route": item.get("route"),
            "dose_form": item.get("dose_form"),
            "notes": item.get("notes"),
            "source_section_id": None,
            "source_name": "overlay",
            "source_priority": -10,
            "confidence": item.get("confidence") or "reviewed",
            "extraction_method": "overlay",
            "review_status": item.get("review_status") or "reviewed",
            "parse_warnings": json.dumps(warnings),
            "fixed_dose_low": item.get("fixed_dose_low"),
            "fixed_dose_high": item.get("fixed_dose_high"),
            "dose_unit": item.get("dose_unit") or "mg",
            "frequency_code": item.get("frequency_code"),
            "duration_low_days": item.get("duration_low_days") or item.get("default_duration_days"),
            "duration_high_days": item.get("duration_high_days") or item.get("default_duration_days"),
            "is_prn": 1 if item.get("frequency_code") == "prn" else 0,
            "prn_reason": item.get("prn_reason"),
            "schedule_context": item.get("schedule_context"),
            "rx_ready": 1 if item.get("rx_ready", True) else 0,
        }
        cols = ",".join(rule.keys())
        placeholders = ",".join("?" for _ in rule)
        c.execute(f"INSERT INTO drug_dosing_rules ({cols}) VALUES ({placeholders})", tuple(rule.values()))
        inserted_rules += 1
        inserted_rx_ready += int(rule["rx_ready"])
    return inserted_rules, inserted_rx_ready, next_indication_rank


def extract(db_path: Path, limit: Optional[int] = None) -> None:
    if not db_path.exists():
        raise SystemExit(f"Drug reference DB not found: {db_path}")

    c = _connect(db_path)
    _exec_script(c, SCHEMA_SQL)
    _add_column(c, "drugs", "coverage_tier INTEGER DEFAULT 0")
    _add_column(c, "drugs", "coverage_status TEXT")
    _add_column(c, "drugs", "rxcui TEXT")
    _add_column(c, "drugs", "rxcui_tty TEXT")
    _add_column(c, "drug_indications", "label_status TEXT")
    for table in SECTION_DELETE:
        c.execute(f"DELETE FROM {table}")
    c.commit()

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cur = c.execute(
        """
        INSERT INTO clinical_extraction_runs
            (started_at, total_drugs, linked_drugs, warnings_count, errors_count)
        VALUES (?,0,0,0,0)
        """,
        (started,),
    )
    run_id = int(cur.lastrowid)
    drugs = c.execute(
        """
        SELECT drug_id, generic_name, drug_class, rxcui
        FROM drugs
        ORDER BY lower(generic_name)
        """
    ).fetchall()
    if limit:
        drugs = drugs[:limit]

    any_dose = 0
    rx_ready_count = 0
    linked_count = 0
    warnings_count = 0
    mm_interaction_rows = 0
    errors_count = 0
    mm_interactions = _open_mm_interactions()
    dosing_overlays = _load_dosing_overlays()

    for idx, drug in enumerate(drugs, 1):
        drug_id = int(drug["drug_id"])
        linked = bool(drug["rxcui"])
        linked_count += 1 if linked else 0
        tier = 0 if linked else 0
        reasons: list[str] = []
        indication_ids: list[int] = []
        indication_lookup: dict[str, int] = {}
        next_indication_rank = 1

        try:
            ind_rows = c.execute(
                """
                SELECT id, section_key, source, content_html, content_text
                FROM drug_sections
                WHERE drug_id = ?
                  AND section_key IN (
                    'indications',
                    'indications_off_label',
                    'indications_off_label_pediatric',
                    'indications_unsupported',
                    'indications_unsupported_pediatric'
                  )
                ORDER BY CASE section_key
                    WHEN 'indications' THEN 0
                    WHEN 'indications_off_label' THEN 1
                    WHEN 'indications_off_label_pediatric' THEN 2
                    ELSE 3
                END
                """,
                (drug_id,),
            ).fetchall()
            indications: list[dict] = []
            for ind_row in ind_rows:
                row_indications = _extract_indication_rows(
                    ind_row["content_html"] or "",
                    ind_row["content_text"] or "",
                    ind_row["source"],
                )
                if ind_row["section_key"].startswith("indications_off_label"):
                    for item in row_indications:
                        item["label_status"] = "off_label"
                elif ind_row["section_key"].startswith("indications_unsupported"):
                    for item in row_indications:
                        item["label_status"] = "unsupported"
                for indication_row in row_indications:
                    indication = indication_row["indication_text"]
                    key = _norm_indication(indication)
                    if key in indication_lookup:
                        continue
                    cur = c.execute(
                        """
                        INSERT INTO drug_indications
                            (drug_id, indication_text, indication_rank, label_status, source_section_id,
                             source_name, confidence, review_status)
                        VALUES (?,?,?,?,?,?,?,?)
                        """,
                        (
                            drug_id,
                            indication,
                            next_indication_rank,
                            indication_row.get("label_status"),
                            ind_row["id"],
                            ind_row["source"],
                            indication_row.get("confidence") or "medium",
                            "unreviewed",
                        ),
                    )
                    indication_id = int(cur.lastrowid)
                    indication_ids.append(indication_id)
                    indication_lookup[key] = indication_id
                    indications.append(indication_row)
                    next_indication_rank += 1

            for text, severity, section_id, source in _extract_warnings(c, drug_id):
                c.execute(
                    """
                    INSERT INTO drug_warnings_quick
                        (drug_id, warning_text, severity, source_section_id, source_name, confidence, review_status)
                    VALUES (?,?,?,?,?,?,?)
                    """,
                    (drug_id, text, severity, section_id, source, "medium", "unreviewed"),
                )
                warnings_count += 1

            adverse = c.execute(
                """
                SELECT id, source, content_text
                FROM drug_sections
                WHERE drug_id = ? AND section_key = 'adverse_effects'
                """,
                (drug_id,),
            ).fetchone()
            if adverse:
                for effect in _extract_side_effects(adverse["content_text"] or "")[:5]:
                    c.execute(
                        """
                        INSERT INTO drug_side_effects_quick
                            (drug_id, effect_text, frequency, source_section_id, source_name, confidence, review_status)
                        VALUES (?,?,?,?,?,?,?)
                        """,
                        (drug_id, effect, "common", adverse["id"], adverse["source"], "medium", "unreviewed"),
                    )

            inserted_mm_interactions = _insert_mm_interactions_quick(c, mm_interactions, drug_id)
            mm_interaction_rows += inserted_mm_interactions
            if not inserted_mm_interactions:
                for section_key, severity in [
                    ("interactions_contraindicated", "contraindicated"),
                    ("interactions_major", "major"),
                    ("interactions_moderate", "moderate"),
                ]:
                    interaction_row = c.execute(
                        """
                        SELECT id, source, content_text
                        FROM drug_sections
                        WHERE drug_id = ? AND section_key = ?
                        """,
                        (drug_id, section_key),
                    ).fetchone()
                    if not interaction_row:
                        continue
                    for interaction in _extract_interactions(interaction_row["content_text"] or "")[:5]:
                        c.execute(
                            """
                            INSERT INTO drug_interactions_quick
                                (drug_id, interacting_name, severity, source_section_id, source_name, confidence, review_status)
                            VALUES (?,?,?,?,?,?,?)
                            """,
                            (drug_id, interaction, severity, interaction_row["id"], interaction_row["source"], "medium", "unreviewed"),
                        )
                    if section_key in {"interactions_contraindicated", "interactions_major"}:
                        break

            _augment_strengths_from_how_supplied(c, drug_id)
            strength_count = c.execute(
                "SELECT COUNT(*) FROM drug_strengths WHERE drug_id = ?",
                (drug_id,),
            ).fetchone()[0] if "drug_strengths" in {
                row["name"] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")
            } else 0

            dose_sections = c.execute(
                """
                SELECT id, section_key, source, content_html, content_text
                FROM drug_sections
                WHERE drug_id = ?
                  AND section_key IN ('adult_dosing','pediatric_dosing','adult_dosing_elderly')
                ORDER BY CASE section_key
                    WHEN 'adult_dosing' THEN 0 WHEN 'pediatric_dosing' THEN 1 ELSE 2 END
                """,
                (drug_id,),
            ).fetchall()
            inserted_rules = 0
            inserted_rx_ready = 0
            default_indication_id = indication_ids[0] if indication_ids else None
            for section in dose_sections:
                section_blocks = _extract_dosing_blocks(section)
                if section_blocks:
                    rules_for_section: list[dict] = []
                    for title, block_text in section_blocks[:30]:
                        indication_id, next_indication_rank = _ensure_indication(
                            c,
                            drug_id,
                            title,
                            indication_lookup,
                            next_indication_rank,
                            section["id"],
                            section["source"],
                            label_status="dosing_section",
                            confidence="medium",
                        )
                        if not default_indication_id:
                            default_indication_id = indication_id
                        rules_for_section.extend(_parse_dosing_rules(
                            drug,
                            section,
                            indication_id,
                            strength_count > 0,
                            text_override=block_text,
                            extraction_method="html_block",
                        ))
                    if not rules_for_section:
                        rules_for_section = _parse_dosing_rules(drug, section, default_indication_id, strength_count > 0)
                else:
                    rules_for_section = _parse_dosing_rules(drug, section, default_indication_id, strength_count > 0)

                for rule in rules_for_section:
                    cols = ",".join(rule.keys())
                    placeholders = ",".join("?" for _ in rule)
                    c.execute(
                        f"INSERT INTO drug_dosing_rules ({cols}) VALUES ({placeholders})",
                        tuple(rule.values()),
                    )
                    inserted_rules += 1
                    inserted_rx_ready += int(rule["rx_ready"])

            for overlay in dosing_overlays:
                if not _overlay_matches(drug, overlay):
                    continue
                overlay_rules, overlay_rx_ready, next_indication_rank = _insert_overlay_rules(
                    c,
                    drug,
                    overlay,
                    indication_lookup,
                    next_indication_rank,
                )
                inserted_rules += overlay_rules
                inserted_rx_ready += overlay_rx_ready

            if inserted_rules:
                any_dose += 1
                tier = 2
            if inserted_rx_ready:
                rx_ready_count += 1
                tier = 3

            renal = c.execute(
                """
                SELECT id, source, content_text
                FROM drug_sections
                WHERE drug_id = ? AND section_key IN ('renal_dosing','renal_dosing_pediatric')
                ORDER BY CASE section_key WHEN 'renal_dosing' THEN 0 ELSE 1 END
                LIMIT 1
                """,
                (drug_id,),
            ).fetchone()
            if renal and renal["content_text"]:
                text = _clean_text(renal["content_text"])
                adjust_factor = 1.0 if re.search(r"no\s+(dosage\s+)?adjustment", text, re.I) else None
                c.execute(
                    """
                    INSERT INTO drug_renal_adjust
                        (drug_id, crcl_min, crcl_max, adjustment_factor, adjustment_text,
                         source_section_id, source_name, confidence, review_status)
                    VALUES (?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        drug_id, None, None, adjust_factor, text[:500],
                        renal["id"], renal["source"], "low", "needs_review",
                    ),
                )

            hepatic = c.execute(
                """
                SELECT id, source, content_text
                FROM drug_sections
                WHERE drug_id = ? AND section_key IN ('hepatic_dosing','hepatic_dosing_pediatric')
                ORDER BY CASE section_key WHEN 'hepatic_dosing' THEN 0 ELSE 1 END
                LIMIT 1
                """,
                (drug_id,),
            ).fetchone()
            if hepatic and hepatic["content_text"]:
                text = _clean_text(hepatic["content_text"])
                c.execute(
                    """
                    INSERT INTO drug_hepatic_adjust
                        (drug_id, child_pugh_class, adjustment_factor, adjustment_text,
                         source_section_id, source_name, confidence, review_status)
                    VALUES (?,?,?,?,?,?,?,?)
                    """,
                    (drug_id, None, None, text[:500], hepatic["id"], hepatic["source"], "low", "needs_review"),
                )

            if indications and tier < 1:
                tier = 1
            if not linked:
                reasons.append("missing_rxcui")
                _insert_issue(c, run_id, drug_id, "identity", "medium", "No RxNorm match", suggested_action="review name/link manually")
            if not indications:
                reasons.append("missing_indications")
                _insert_issue(c, run_id, drug_id, "indications", "low", "No indications extracted")
            if not inserted_rules:
                reasons.append("missing_structured_dose")
                _insert_issue(c, run_id, drug_id, "dosing", "medium", "No structured dosing rule extracted", suggested_action="manual overlay or parser improvement")
            elif not inserted_rx_ready:
                reasons.append("dose_not_rx_ready")
                _insert_issue(c, run_id, drug_id, "prescription", "medium", "Dose parsed but prescription requirements are incomplete")

            if reasons:
                priority = 10 + (20 if _looks_high_risk(drug["generic_name"], drug["drug_class"] or "") else 0)
                priority += 8 if "missing_structured_dose" in reasons else 0
                priority += 5 if "dose_not_rx_ready" in reasons else 0
                _review_queue(c, drug_id, tier, 3, ", ".join(reasons), priority)

            status = "rx_ready" if tier >= 3 else ("parsed_dose" if tier == 2 else ("clinical_summary" if tier == 1 else "identity_only"))
            c.execute(
                "UPDATE drugs SET coverage_tier = ?, coverage_status = ? WHERE drug_id = ?",
                (tier, status, drug_id),
            )
        except Exception as exc:
            errors_count += 1
            _insert_issue(c, run_id, drug_id, "extract_error", "high", str(exc)[:500])
            c.execute(
                "UPDATE drugs SET coverage_tier = 0, coverage_status = ? WHERE drug_id = ?",
                ("extract_error", drug_id),
            )

        if idx % 250 == 0:
            c.commit()
            print(f"  [{idx:>4}/{len(drugs)}] structured extraction")

    completed = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    c.execute(
        """
        UPDATE clinical_extraction_runs
        SET completed_at = ?, total_drugs = ?, linked_drugs = ?,
            drugs_with_any_dose = ?, drugs_with_rx_ready_dose = ?,
            warnings_count = ?, errors_count = ?
        WHERE run_id = ?
        """,
        (
            completed, len(drugs), linked_count, any_dose, rx_ready_count,
            warnings_count, errors_count, run_id,
        ),
    )
    c.executemany(
        "INSERT OR REPLACE INTO build_meta (key, value) VALUES (?,?)",
        [
            ("clinical_extracted_at", completed),
            ("structured_dosing_count", str(any_dose)),
            ("structured_dosing_rate", f"{(any_dose / len(drugs) if drugs else 0):.4f}"),
            ("rx_ready_dosing_count", str(rx_ready_count)),
            ("rx_ready_dosing_rate", f"{(rx_ready_count / len(drugs) if drugs else 0):.4f}"),
            ("mm_interaction_db_used", str(bool(mm_interactions)).lower()),
            ("mm_interaction_quick_rows", str(mm_interaction_rows)),
        ],
    )
    c.commit()
    if mm_interactions:
        mm_interactions.close()
    c.close()
    print(f"Structured dose coverage: {any_dose}/{len(drugs)}")
    print(f"Rx-ready dose coverage: {rx_ready_count}/{len(drugs)}")
    print(f"Errors: {errors_count}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract structured clinical data for every drug")
    parser.add_argument("--drug-db", type=Path, default=DRUG_REF_DB)
    parser.add_argument("--limit", type=int, default=None)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    extract(args.drug_db, args.limit)

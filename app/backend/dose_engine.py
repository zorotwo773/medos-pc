"""Structured dose calculation and clinical popup assembly."""
from __future__ import annotations

import json
import math
import re
import sqlite3
from typing import Optional


DISCLAIMER = (
    "Dose data is source-derived and may be incomplete. Verify indication, "
    "patient factors, formulation, interactions, and current prescribing "
    "information before clinical use."
)
DEFAULT_ADULT_WEIGHT_KG = 60.0
COMBINATION_CONTEXT_RE = re.compile(
    r"\b(in combination with|combined with|combination therapy|dosing ratio|plus|"
    r"triple regimen|quadruple regimen|salvage regimen|followed by|adjunctive)\b",
    re.IGNORECASE,
)
DEFAULT_CHRONIC_SUPPLY_DAYS = 30


def has_table(c: sqlite3.Connection, name: str) -> bool:
    row = c.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
        (name,),
    ).fetchone()
    return bool(row)


def has_column(c: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        return column in {row["name"] for row in c.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return False


def resolve_drug_id(c: sqlite3.Connection, drug_id: int) -> int:
    row = c.execute("SELECT 1 FROM drugs WHERE drug_id = ?", (drug_id,)).fetchone()
    if row:
        return drug_id
    if has_table(c, "drug_id_aliases"):
        alias = c.execute(
            "SELECT new_drug_id FROM drug_id_aliases WHERE old_drug_id = ?",
            (drug_id,),
        ).fetchone()
        if alias:
            return int(alias["new_drug_id"])
    return drug_id


def _rows(c: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    try:
        return [dict(row) for row in c.execute(sql, params).fetchall()]
    except sqlite3.Error:
        return []


def _default_indication_row(c: sqlite3.Connection, drug_id: int, population: str = "adult") -> Optional[sqlite3.Row]:
    if not has_table(c, "drug_dosing_rules") or not has_table(c, "drug_indications"):
        return None
    return c.execute(
        """
        SELECT r.indication_id, r.id AS rule_id, r.rx_ready, r.confidence, r.review_status,
               i.indication_text, i.label_status, i.indication_rank
        FROM drug_dosing_rules r
        JOIN drug_indications i ON i.id = r.indication_id
        WHERE r.drug_id = ?
          AND r.indication_id IS NOT NULL
          AND r.population = ?
        ORDER BY
          r.rx_ready DESC,
          -- A rule the engine can actually schedule beats a frequency-less
          -- fragment, regardless of indication rank (furosemide's rank-1 CHF
          -- fragment '20 mg / SUBQ: refer to adult dosing' must not win over
          -- the clean '20-40 mg once daily' rule of a lower-ranked indication).
          CASE WHEN COALESCE(r.frequency_code, '') = '' THEN 1 ELSE 0 END,
          CASE
            WHEN lower(COALESCE(r.notes, '')) LIKE '%in combination with%' THEN 1
            WHEN lower(COALESCE(r.notes, '')) LIKE '% plus %' THEN 1
            WHEN lower(COALESCE(r.notes, '')) LIKE '%triple regimen%' THEN 1
            WHEN lower(COALESCE(r.notes, '')) LIKE '%quadruple regimen%' THEN 1
            WHEN lower(COALESCE(r.notes, '')) LIKE '%followed by%' THEN 1
            ELSE 0
          END,
          CASE r.confidence
            WHEN 'reviewed' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          CASE i.label_status
            WHEN 'fda_labeled' THEN 0
            WHEN 'dosing_section' THEN 1
            WHEN 'off_label' THEN 2
            WHEN 'source_listed' THEN 3
            ELSE 4
          END,
          i.indication_rank,
          r.id
        LIMIT 1
        """,
        (drug_id, population),
    ).fetchone()


def _form_options(c: sqlite3.Connection, drug_id: int) -> list[dict]:
    if not has_table(c, "drug_strengths"):
        return []
    rows = _rows(
        c,
        """
        SELECT dose_form, route, strength_unit, COUNT(*) AS strength_count,
               group_concat(DISTINCT strength_text) AS strengths
        FROM drug_strengths
        WHERE drug_id = ?
          AND COALESCE(dose_form, '') <> ''
        GROUP BY lower(dose_form), COALESCE(route, ''), COALESCE(strength_unit, '')
        ORDER BY CASE
            WHEN lower(dose_form) = 'oral tablet' THEN 0
            WHEN lower(dose_form) = 'tablet' THEN 1
            WHEN lower(dose_form) LIKE '%capsule%' THEN 2
            WHEN lower(dose_form) LIKE '%suspension%' THEN 3
            WHEN lower(dose_form) LIKE '%solution%' THEN 4
            WHEN lower(dose_form) LIKE '%extended%' THEN 8
            WHEN lower(dose_form) LIKE '%delayed%' THEN 8
            WHEN lower(dose_form) LIKE '%tablet%' THEN 5
            ELSE 4
          END,
          lower(dose_form)
        LIMIT 30
        """,
        (drug_id,),
    )
    out = []
    for row in rows:
        strengths = [part.strip() for part in (row.get("strengths") or "").split(",") if part.strip()]
        out.append({
            "dose_form": row.get("dose_form"),
            "route": row.get("route"),
            "strength_unit": row.get("strength_unit"),
            "strength_count": int(row.get("strength_count") or 0),
            "strengths": strengths[:8],
        })
    return out


def popup_payload(c: sqlite3.Connection, drug_id: int) -> dict:
    drug_id = resolve_drug_id(c, drug_id)
    d = c.execute(
        """
        SELECT d.*, qi.brand_names AS quick_brand_names, qi.dose_snippet, qi.bbw_snippet
        FROM drugs d
        LEFT JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
        WHERE d.drug_id = ?
        """,
        (drug_id,),
    ).fetchone()
    if not d:
        raise KeyError("Drug not found")

    brands = [
        row["brand_name"]
        for row in c.execute(
            "SELECT brand_name FROM drug_brands WHERE drug_id = ? ORDER BY country, brand_name LIMIT 10",
            (drug_id,),
        ).fetchall()
    ]
    if not brands and d["quick_brand_names"]:
        brands = [part.strip() for part in d["quick_brand_names"].split(",") if part.strip()]

    indications = []
    if has_table(c, "drug_indications"):
        label_select = "label_status" if has_column(c, "drug_indications", "label_status") else "NULL AS label_status"
        indications = _rows(
            c,
            f"""
            SELECT id, indication_text, indication_rank, {label_select}, source_name, confidence, review_status
            FROM drug_indications
            WHERE drug_id = ?
            ORDER BY indication_rank, id
            LIMIT 50
            """,
            (drug_id,),
        )
    warnings = _rows(
        c,
        """
        SELECT warning_text, severity, source_name, confidence, review_status
        FROM drug_warnings_quick
        WHERE drug_id = ?
        ORDER BY CASE severity WHEN 'boxed' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, id
        LIMIT 5
        """,
        (drug_id,),
    ) if has_table(c, "drug_warnings_quick") else []
    side_effects = _rows(
        c,
        """
        SELECT effect_text, frequency, source_name, confidence, review_status
        FROM drug_side_effects_quick
        WHERE drug_id = ?
        ORDER BY CASE frequency WHEN 'serious' THEN 0 ELSE 1 END, id
        LIMIT 6
        """,
        (drug_id,),
    ) if has_table(c, "drug_side_effects_quick") else []
    interactions = _rows(
        c,
        """
        SELECT interacting_rxcui, interacting_name, severity, mechanism, source_name, confidence, review_status
        FROM drug_interactions_quick
        WHERE drug_id = ?
        ORDER BY CASE severity WHEN 'contraindicated' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, id
        LIMIT 6
        """,
        (drug_id,),
    ) if has_table(c, "drug_interactions_quick") else []
    ingredients = _rows(
        c,
        """
        SELECT ingredient_rxcui, ingredient_name, strength, unit
        FROM drug_ingredients
        WHERE drug_id = ?
        ORDER BY lower(ingredient_name)
        LIMIT 20
        """,
        (drug_id,),
    ) if has_table(c, "drug_ingredients") else []
    strengths = _rows(
        c,
        """
        SELECT strength_num, strength_unit, strength_text, dose_form, route
        FROM drug_strengths
        WHERE drug_id = ?
        ORDER BY strength_unit, strength_num
        LIMIT 20
        """,
        (drug_id,),
    ) if has_table(c, "drug_strengths") else []
    dose_forms = _rows(
        c,
        """
        SELECT dose_form, route
        FROM drug_dose_forms
        WHERE drug_id = ?
        ORDER BY lower(dose_form)
        LIMIT 20
        """,
        (drug_id,),
    ) if has_table(c, "drug_dose_forms") else []
    atc = _rows(
        c,
        """
        SELECT atc_code, atc_name, level
        FROM drug_atc
        WHERE drug_id = ?
        ORDER BY level, atc_code
        LIMIT 20
        """,
        (drug_id,),
    ) if has_table(c, "drug_atc") else []
    ndcs = _rows(
        c,
        """
        SELECT ndc, package_desc
        FROM drug_ndc
        WHERE drug_id = ?
        ORDER BY ndc
        LIMIT 20
        """,
        (drug_id,),
    ) if has_table(c, "drug_ndc") else []

    rule_summary = c.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN rx_ready = 1 THEN 1 ELSE 0 END) AS rx_ready
        FROM drug_dosing_rules
        WHERE drug_id = ?
        """,
        (drug_id,),
    ).fetchone() if has_table(c, "drug_dosing_rules") else None
    renal_adjust_count = c.execute(
        "SELECT COUNT(*) FROM drug_renal_adjust WHERE drug_id = ?",
        (drug_id,),
    ).fetchone()[0] if has_table(c, "drug_renal_adjust") else 0
    hepatic_adjust_count = c.execute(
        "SELECT COUNT(*) FROM drug_hepatic_adjust WHERE drug_id = ?",
        (drug_id,),
    ).fetchone()[0] if has_table(c, "drug_hepatic_adjust") else 0
    default_indication_id = None
    default_indication_reason = None
    if indications and has_table(c, "drug_dosing_rules"):
        default_rule = _default_indication_row(c, drug_id, "adult")
        if default_rule and default_rule["indication_id"]:
            default_indication_id = int(default_rule["indication_id"])
            if default_rule["review_status"] == "reviewed" or default_rule["confidence"] == "reviewed":
                default_indication_reason = "primary reviewed source rule"
            elif default_rule["rx_ready"]:
                default_indication_reason = "primary rx-ready source rule"
            else:
                default_indication_reason = "primary parsed source rule"

    coverage_tier = d["coverage_tier"] if "coverage_tier" in d.keys() else 0
    coverage_status = d["coverage_status"] if "coverage_status" in d.keys() else None
    rxcui = d["rxcui"] if "rxcui" in d.keys() else None
    rxcui_tty = d["rxcui_tty"] if "rxcui_tty" in d.keys() else None

    return {
        "drug": {
            "drug_id": drug_id,
            "generic_name": d["generic_name"],
            "brand_names": brands,
            "drug_class": [part.strip() for part in (d["drug_class"] or "").split("|") if part.strip()],
            "regulatory_status": d["regulatory_status"] or "RX",
            "has_black_box": bool(d["has_black_box"]),
            "is_generic_available": bool(d["is_generic_available"]),
            "utd_topic_id": d["utd_topic_id"],
            "rxcui": rxcui,
            "rxcui_tty": rxcui_tty,
            "coverage_tier": int(coverage_tier or 0),
            "coverage_status": coverage_status or "identity_only",
            "dose_snippet": d["dose_snippet"] or "",
            "bbw_snippet": d["bbw_snippet"],
        },
        "indications": indications,
        "warnings_quick": warnings,
        "side_effects_quick": side_effects,
        "interactions_quick": interactions,
        "ingredients": ingredients,
        "default_indication_id": default_indication_id,
        "default_indication_reason": default_indication_reason,
        "default_weight_kg": DEFAULT_ADULT_WEIGHT_KG,
        "dosing": {
            "available": bool(rule_summary and rule_summary["total"]),
            "rx_ready": bool(rule_summary and rule_summary["rx_ready"]),
            "rule_count": int(rule_summary["total"] or 0) if rule_summary else 0,
            "rx_ready_rule_count": int(rule_summary["rx_ready"] or 0) if rule_summary else 0,
        },
        "adjustments": {
            "renal_available": renal_adjust_count > 0,
            "hepatic_available": hepatic_adjust_count > 0,
        },
        "identity": {
            "atc": atc,
            "ndcs": ndcs,
            "dose_forms": dose_forms,
            "strengths": strengths,
            "form_options": _form_options(c, drug_id),
        },
        "disclaimer": DISCLAIMER,
    }


def _confidence_rank(value: str | None) -> int:
    return {"reviewed": 0, "high": 1, "medium": 2, "low": 3}.get(value or "low", 4)


def _row_get(row: sqlite3.Row, key: str, default=None):
    """Column access that tolerates databases built before a column existed."""
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


# ── Runtime safety + selection scoring ──────────────────────────────────────
_SUSPECT_INFUSION_RE = re.compile(
    r"(?:mg|mcg)\s*/\s*(?:hour|hr|minute|min)\b|continuous\s+iv\s+infusion",
    re.IGNORECASE,
)


def _rule_is_suspect(rule: sqlite3.Row) -> bool:
    """Guard against extraction mis-parses that could produce dangerous doses.

    The extractor has stored IV infusion rates as weight-based doses (e.g.
    'usual adult dosing range: 10 to 40 mg/hour' parsed as 10-40 mg/kg PO).
    A suspect rule is only ever used when nothing else exists, and it never
    generates a prescription.
    """
    per_kg_high = rule["mg_per_kg_high"] or rule["mg_per_kg_low"]
    if per_kg_high is None:
        return False
    # The plausibility ceilings are mg-denominated; a 30 mcg/kg rule is fine.
    if (rule["dose_unit"] or "mg").lower() != "mg":
        return False
    # Curated sources state real high-dose regimens (amoxicillin 90 mg/kg/day
    # for AOM); the plausibility ceilings only police free-text scrapes.
    if (rule["source_name"] or "").lower() == "epocrates" or rule["confidence"] == "reviewed":
        return False
    if _SUSPECT_INFUSION_RE.search(rule["notes"] or ""):
        return True
    # Plausibility ceilings: per-dose mg/kg above 25 (real ceilings: vanc 20,
    # acyclovir 20) or per-day above 60 (amox 45, some abx 50-60) are almost
    # always parse errors, not real regimens.
    limit = 60.0 if rule["dose_basis"] == "per_day" else 25.0
    return float(per_kg_high) > limit


def _rule_parse_warning_set(rule: sqlite3.Row) -> set[str]:
    try:
        return set(json.loads(rule["parse_warnings"] or "[]"))
    except Exception:
        return set()


_TITRATION_CONTEXT_RE = re.compile(
    r"\b(?:incr(?:ease|\.)?(?:\s+dose)?\s+(?:by|in increments)|increments? of|titrat)",
    re.IGNORECASE,
)


def _rule_is_titration_fragment(rule: sqlite3.Row) -> bool:
    """A 'weekly' frequency scraped from titration language ('may increase by
    25-50 mg once weekly') is a schedule for dose ESCALATION, not administration.
    Real once-weekly drugs (alendronate, methotrexate) state the dose directly
    without increment context."""
    if rule["frequency_code"] != "weekly":
        return False
    if (rule["review_status"] == "reviewed") or (rule["confidence"] == "reviewed"):
        return False
    return bool(_TITRATION_CONTEXT_RE.search(rule["notes"] or ""))


def _rule_dose_is_lab_value(rule: sqlite3.Row) -> bool:
    """Guard against doses scraped from lab criteria text — e.g. apixaban rules
    storing 1.5 mg because the source says 'serum creatinine >=1.5 mg/dL'."""
    low, high = rule["fixed_dose_low"], rule["fixed_dose_high"]
    if low is None or high is None or low != high or float(low) > 5:
        return False
    value = float(low)
    text = rule["notes"] or ""
    formatted = f"{value:g}"
    return bool(re.search(
        rf"(?:creatinine|scr|inr|bilirubin|egfr|crcl|platelets?)\s*(?:is\s*)?[≥≤<>=]*\s*{re.escape(formatted)}\s*(?:mg/dl|micromole|mmol)?",
        text,
        re.IGNORECASE,
    ))


def _rule_age_weight_mismatch(
    rule: sqlite3.Row,
    age_years: Optional[float],
    weight_kg: Optional[float],
) -> bool:
    """True when the patient falls outside the rule's parsed age/weight bracket
    (e.g. a '12 yo and older' 650 mg acetaminophen rule for a 2-year-old)."""
    if age_years is not None:
        min_age = _row_get(rule, "min_age_years")
        max_age = _row_get(rule, "max_age_years")
        if min_age is not None and age_years < float(min_age):
            return True
        if max_age is not None and age_years > float(max_age):
            return True
    if weight_kg is not None:
        min_wt = _row_get(rule, "min_weight_kg")
        max_wt = _row_get(rule, "max_weight_kg")
        if min_wt is not None and weight_kg < float(min_wt):
            return True
        if max_wt is not None and weight_kg > float(max_wt):
            return True
    return False


_INDICATION_STOPWORDS = {"of", "the", "and", "or", "due", "to", "a", "in", "with", "for"}

# Clinical shorthand → expanded words, so 'DVT prophylaxis' overlaps
# 'deep vein thrombosis; Prophylaxis' when scoring indication similarity.
INDICATION_SYNONYMS: dict[str, tuple[str, ...]] = {
    "dvt": ("deep", "vein", "thrombosis"),
    "vte": ("venous", "thromboembolism"),
    "pe": ("pulmonary", "embolism"),
    "htn": ("hypertension",),
    "afib": ("atrial", "fibrillation"),
    "uti": ("urinary", "tract", "infection"),
    "gerd": ("gastroesophageal", "reflux"),
    "mi": ("myocardial", "infarction"),
    "hf": ("heart", "failure"),
    "chf": ("heart", "failure"),
    "copd": ("chronic", "obstructive", "pulmonary", "disease"),
    "aom": ("acute", "otitis", "media"),
    "tx": ("treatment",),
    "ppx": ("prophylaxis",),
    "dz": ("disease",),
    "sx": ("symptoms",),
}


def indication_words(text: str | None) -> set[str]:
    out: set[str] = set()
    for w in re.split(r"[^a-z0-9]+", (text or "").lower()):
        if not w or w in _INDICATION_STOPWORDS:
            continue
        expanded = INDICATION_SYNONYMS.get(w)
        if expanded:
            out.update(expanded)
        elif len(w) > 2:
            out.add(w)
    return out


def _indication_word_overlap(a: str | None, b: str | None) -> int:
    """Shared meaningful words between two indication texts — used so a
    cross-indication fallback prefers 'Edema or volume overload' over
    'Ascites due to cirrhosis' when the user asked for 'Edema - Renal failure'."""
    return len(indication_words(a) & indication_words(b))


def _rule_score(
    rule: sqlite3.Row,
    indication_id: Optional[int],
    route: Optional[str],
    requested_text: str | None = None,
    indication_texts: Optional[dict] = None,
    age_years: Optional[float] = None,
    weight_kg: Optional[float] = None,
) -> float:
    """Lower is better. Encodes the full clinical preference order so rule
    selection is transparent and testable (the old 60-line SQL ORDER BY missed
    parse quality entirely and picked frequency-less fragments)."""
    warnings = _rule_parse_warning_set(rule)
    score = 0.0
    if indication_id is not None:
        if rule["indication_id"] == indication_id:
            score += 0
        elif rule["indication_id"] is None:
            score += 40
        else:
            # Cross-indication fallback: allowed, ranked after — but a fallback
            # indication sharing words with the requested one ranks closer.
            candidate_text = (indication_texts or {}).get(rule["indication_id"])
            overlap = _indication_word_overlap(requested_text, candidate_text)
            score += 60 - min(18, overlap * 9)
    if _rule_is_suspect(rule):
        score += 1000
    if _rule_is_titration_fragment(rule):
        score += 900
    if _rule_dose_is_lab_value(rule):
        score += 900
    # A rule whose age/weight bracket excludes this patient must lose to any
    # applicable rule (a 2-year-old must never receive the '>=12 yo' dose).
    if _rule_age_weight_mismatch(rule, age_years, weight_kg):
        score += 400
    has_dose = any(
        rule[k] is not None
        for k in ("fixed_dose_low", "fixed_dose_high", "mg_per_kg_low", "mg_per_kg_high")
    )
    if not has_dose:
        score += 500
    if _is_combination_context(rule):
        score += 120
    if "missing_frequency" in warnings or not rule["frequency_code"]:
        score += 25
    if route and (rule["route"] or "").upper() not in ("", route.upper()):
        score += 200
    if not rule["rx_ready"]:
        score += 10
    if rule["review_status"] == "rejected":
        score += 800
    # Curated structured sources beat text-scraped rules of EQUAL confidence,
    # but never outrank a hand-reviewed rule (bonus < one confidence tier).
    if (rule["source_name"] or "").lower() == "epocrates":
        score -= 0.9
    score += _confidence_rank(rule["confidence"])
    return score


# ── Source adjustment-text parsing (renal / hepatic guidance) ───────────────
_ADJ_ANCHOR_RE = re.compile(
    r"(Altered kidney function|Kidney function|eGFR|CrCl\s*[<>≥≤\d]|GFR\s*[<>≥≤\d]|Note:|"
    r"Mild\s|Moderate\s|Severe\s|Oral:|IV, Oral|IV:|Hemodialysis|Impair|Liver|Hepatic|Child)"
)


def _clean_adjust_text(text: str | None) -> str:
    """Strip the UTD editorial preamble ('recommendations are based upon ...
    Senior Editorial Team: <names>') so guidance starts at the clinical content."""
    t = re.sub(r"\s+", " ", (text or "")).strip()
    marker = t.find("Senior Editorial Team:")
    if marker == -1 and "recommendations are based upon" not in t[:200]:
        return t
    m = _ADJ_ANCHOR_RE.search(t, marker + 22 if marker >= 0 else 0)
    return t[m.start():].strip() if m else t


_RENAL_SEG_RE = re.compile(
    r"(?:eGFR|CrCl|GFR|creatinine clearance)[^0-9<>≥≤]{0,24}([<>≥≤]?)\s*(\d+(?:\.\d+)?)"
    r"(?:\s*(?:to|-|–|—)\s*[<≤]?\s*(\d+(?:\.\d+)?))?"
    r"(\s*(?:mL/min(?:ute)?(?:/1\.73\s*m2)?)?\s*(?:or (?:less|lower|below)|or (?:more|greater|higher|above)|and (?:above|below))?)?",
    re.IGNORECASE,
)
# 'give 25-75% of usual dose ... if eGFR 10-50' — condition AFTER the action
_RENAL_TRAILING_COND_RE = re.compile(
    r"(?:^|;|:)\s*((?:give|administer|decr\.?|decrease|reduce|use)\b[^;]*?)\s+if\s+"
    r"(?:eGFR|CrCl|GFR)\s*([<>≥≤]?)\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?",
    re.IGNORECASE,
)


def _normalize_renal_ops(text: str) -> str:
    """Rewrite word/ASCII comparison operators to single-char forms."""
    t = re.sub(r">\s*=|greater than or equal to", "≥", text, flags=re.IGNORECASE)
    t = re.sub(r"<\s*=|less than or equal to", "≤", t, flags=re.IGNORECASE)
    t = re.sub(r"\bgreater than\b|\babove\b", ">", t, flags=re.IGNORECASE)
    t = re.sub(r"\bless than\b|\bbelow\b", "<", t, flags=re.IGNORECASE)
    return t


def _bracket_bounds(op: str, a: float, b: Optional[float], suffix: str = "") -> tuple[Optional[float], Optional[float]]:
    """(lo, hi) for [lo, hi) matching, preserving strict/inclusive semantics."""
    s = (suffix or "").lower()
    if b is not None:
        return min(a, b), max(a, b) + 1  # '30 to 59' covers [30, 60)
    if "or less" in s or "or lower" in s or "or below" in s or "and below" in s:
        return None, a + 0.001
    if "or more" in s or "or greater" in s or "or higher" in s or "or above" in s or "and above" in s:
        return a, None
    if op == "<":
        return None, a
    if op == "≤":
        return None, a + 0.001
    if op == ">":
        return a + 0.001, None
    if op == "≥":
        return a, None
    # bare number ('CrCl 15: ...') is that value's own bracket, NOT a lower bound
    return a, a + 1


def _parse_renal_segments(text: str) -> list[dict]:
    """Split cleaned renal text into (CrCl bracket → action text) segments."""
    text = _normalize_renal_ops(text)
    # 'if eGFR 10-50' clauses are trailing conditions of the PRECEDING action —
    # the bracket-header pass must not claim them (it would pair the bracket
    # with the NEXT clause's text: digoxin's eGFR 10-50 bracket would show the
    # eGFR <10 action).
    matches = [
        m for m in _RENAL_SEG_RE.finditer(text)
        if not re.search(r"\bif\s*$", text[max(0, m.start() - 6):m.start()], re.IGNORECASE)
    ]
    segments: list[dict] = []
    for i, m in enumerate(matches):
        op, a, b = m.group(1), float(m.group(2)), m.group(3)
        lo, hi = _bracket_bounds(op, a, float(b) if b is not None else None, m.group(4) or "")
        end = matches[i + 1].start() if i + 1 < len(matches) else min(len(text), m.end() + 320)
        action = re.sub(r"^[^A-Za-z]+", "", text[m.end():end]).strip(" ;,.")
        if action:
            segments.append({"lo": lo, "hi": hi, "action": action})
    for m in _RENAL_TRAILING_COND_RE.finditer(text):
        op = m.group(2) or ""
        a = float(m.group(3))
        b = float(m.group(4)) if m.group(4) else None
        lo, hi = _bracket_bounds(op, a, b)
        segments.append({"lo": lo, "hi": hi, "action": m.group(1).strip(" ;,.")})
    return segments


_HEPATIC_CLASS_RE = re.compile(
    r"Child[-\s]?Pugh\s+class(?:es)?\s+([ABC])"
    r"(?:\s*(?:,|and|or|to|through)\s*([ABC]))?"
    r"(?:\s*(?:,|and|or|to|through)\s*([ABC]))?",
    re.IGNORECASE,
)
_HEPATIC_SEVERITY_RE = re.compile(
    r"\b(mild|moderate|severe)(?:\s+(?:to|or)\s+(mild|moderate|severe))?\s+"
    r"(?:hepatic\s+|liver\s+)?impairment",
    re.IGNORECASE,
)
_SEVERITY_CLASS = {"mild": "A", "moderate": "B", "severe": "C"}


def _parse_hepatic_segments(text: str) -> list[dict]:
    """Split cleaned hepatic text into (Child-Pugh classes → action) segments.
    Falls back to mild/moderate/severe wording mapped to classes A/B/C, and to
    compensated (A) / decompensated (B-C) cirrhosis wording."""
    for m in re.finditer(r"decompensated cirrhosis[^:;]*:\s*([^;]+)", text, re.IGNORECASE):
        return [{"classes": {"B", "C"}, "action": m.group(1).strip()}]
    hits: list[tuple[int, int, set[str]]] = []
    for m in _HEPATIC_CLASS_RE.finditer(text):
        letters = [g.upper() for g in m.groups() if g]
        classes = set(letters)
        # "A to C" / "B through C" span the full range.
        span = m.group(0).lower()
        if len(letters) >= 2 and (" to " in span or "through" in span):
            lo, hi = min(letters), max(letters)
            classes = {chr(x) for x in range(ord(lo), ord(hi) + 1)}
        hits.append((m.start(), m.end(), classes))
    if not hits:
        for m in _HEPATIC_SEVERITY_RE.finditer(text):
            words = [w.lower() for w in m.groups() if w]
            classes = {_SEVERITY_CLASS[w] for w in words}
            if len(words) >= 2 and " to " in m.group(0).lower():
                lo, hi = min(_SEVERITY_CLASS[w] for w in words), max(_SEVERITY_CLASS[w] for w in words)
                classes = {chr(x) for x in range(ord(lo), ord(hi) + 1)}
            hits.append((m.start(), m.end(), classes))
    segments: list[dict] = []
    for i, (start, end, classes) in enumerate(hits):
        seg_end = hits[i + 1][0] if i + 1 < len(hits) else min(len(text), end + 320)
        action = re.sub(r"^[^A-Za-z]+", "", text[end:seg_end]).strip(" ;,.")
        if action:
            segments.append({"classes": classes, "action": action})
    return segments


_REPLACEMENT_REGIMEN_RE = re.compile(
    r"^(?:(?:start|give|use)\s+)?\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*(?:mg|mcg|g)\b"
    r"|^give usual dose\s+q\d",
    re.IGNORECASE,
)
_PERCENT_RANGE_RE = re.compile(r"\d{1,3}\s*-\s*\d{1,3}\s*%")


def _classify_adjustment_action(action: str) -> tuple[str, Optional[float]]:
    """Map source action text to (status, factor). Statuses:
    avoid | no_change | factor | replace | increase_possible | verify."""
    a = action.lower().strip()
    if re.search(r"contraindicat|avoid use|should not be used|do not use|not recommended for use", a):
        return "avoid", None
    if re.search(r"no (?:dosage |dose )?adjustment|no change (?:in|to) dos|dose adjustment (?:is )?not (?:necessary|required)", a):
        return "no_change", None
    if _PERCENT_RANGE_RE.search(a):
        # '25-75% of usual dose' — a judgment range, not a single factor
        return "replace", None
    m = re.search(r"(?:administer|give|reduce (?:dose )?to)\s*(\d{1,3})\s*%", a)
    if m:
        pct = float(m.group(1))
        if 10 <= pct <= 100:
            return "factor", pct / 100.0
    m = re.search(r"decr(?:ease|\.)?\s+(?:usual\s+)?dose\s+by\s+(\d{1,2})\s*%", a)
    if m:
        pct = float(m.group(1))
        if 10 <= pct <= 90:
            return "factor", (100.0 - pct) / 100.0
    if re.search(r"(?:reduce|decrease|decr\.?|lower)[^.]{0,60}(?:50\s*%|half)", a):
        return "factor", 0.5
    if _REPLACEMENT_REGIMEN_RE.search(action.strip()):
        # The source specifies a full replacement regimen for this bracket
        # ('200-700 mg qd', 'give usual dose q8h prn') — show it verbatim.
        return "replace", None
    if re.search(r"higher doses may be required|may require (?:a )?higher dos", a):
        return "increase_possible", None
    return "verify", None


_MAX_DAY_CAP_RE = re.compile(
    r"(?:do not exceed|maximum(?: daily)?(?: dose)?:?)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*mg(?:\s*/?\s*day|\s+daily|\s+per day)?",
    re.IGNORECASE,
)


def _action_day_cap_mg(action: str) -> Optional[float]:
    m = _MAX_DAY_CAP_RE.search(action)
    return float(m.group(1)) if m else None


def _choose_population(c: sqlite3.Connection, drug_id: int, age_years: Optional[float], weight_kg: Optional[float]) -> str:
    if age_years is not None:
        return "pediatric" if age_years < 18 else "adult"
    if weight_kg is not None and weight_kg < 40:
        row = c.execute(
            "SELECT 1 FROM drug_dosing_rules WHERE drug_id = ? AND population = 'pediatric' LIMIT 1",
            (drug_id,),
        ).fetchone()
        if row:
            return "pediatric"
    return "adult"


def _select_rule(
    c: sqlite3.Connection,
    drug_id: int,
    indication_id: Optional[int],
    population: str,
    route: Optional[str] = None,
    age_years: Optional[float] = None,
    weight_kg: Optional[float] = None,
) -> tuple[Optional[sqlite3.Row], bool]:
    """Pick the best rule for (drug, indication, population), scored in Python.

    Unlike the old SQL-only version, a requested indication with no parsed rule
    FALLS BACK to the drug's best rule from any sibling indication instead of
    dead-ending with 'no structured dosing rule' (the drug clearly has dosing —
    e.g. furosemide 'Edema - Renal failure' borrows the 'Edema or volume
    overload' rule). Returns (rule, used_cross_indication_fallback).
    """
    params: list[object] = [drug_id, population]
    where = "drug_id = ? AND population = ?"
    if route:
        where += " AND (upper(COALESCE(route, '')) = ? OR route IS NULL)"
        params.append(route.upper())
    rows = c.execute(
        f"SELECT * FROM drug_dosing_rules WHERE {where} ORDER BY id",
        tuple(params),
    ).fetchall()
    if not rows:
        if population != "adult":
            return _select_rule(c, drug_id, indication_id, "adult", route, age_years, weight_kg)
        return None, False
    indication_texts: dict = {}
    requested_text = None
    if indication_id is not None and has_table(c, "drug_indications"):
        indication_texts = {
            int(r["id"]): r["indication_text"]
            for r in c.execute("SELECT id, indication_text FROM drug_indications WHERE drug_id = ?", (drug_id,))
        }
        requested_text = indication_texts.get(int(indication_id))
    best = min(rows, key=lambda r: (
        _rule_score(r, indication_id, route, requested_text, indication_texts, age_years, weight_kg),
        r["id"],
    ))
    fallback = (
        indication_id is not None
        and best["indication_id"] is not None
        and best["indication_id"] != indication_id
    )
    return best, fallback


def _freq_phrase(code: str | None) -> str:
    return {
        "once_daily": "once daily",
        "daily": "once daily",
        "bid": "twice daily",
        "tid": "three times daily",
        "qid": "four times daily",
        "weekly": "once weekly",
        "every_other_day": "every other day",
        "tid-qid": "three to four times daily",
        "once": "as a single dose",
        "prn": "as needed",
        "q4-6h": "every 4 to 6 hours",
        "q6-8h": "every 6 to 8 hours",
        "q8-12h": "every 8 to 12 hours",
        "q12-24h": "every 12 to 24 hours",
    }.get(code or "", (code or "").replace("q", "every ").replace("h", " hours"))


def _route_phrase(route: str | None) -> str:
    return {
        "PO": "by mouth",
        "IV": "intravenously",
        "IM": "intramuscularly",
        "SC": "subcutaneously",
    }.get(route or "", route or "as directed")


def _dose_form_word(form: str | None) -> str:
    text = (form or "").lower()
    if "capsule" in text:
        return "capsule"
    if "tablet" in text or "tab" in text:
        return "tablet"
    if "solution" in text or "suspension" in text:
        return "mL"
    if "inhal" in text:
        return "puff"
    if "drop" in text or "ophthalmic" in text or "otic" in text:
        return "drop"
    return "unit"


def _doses_per_day(code: str | None, divisions: Optional[float]) -> Optional[float]:
    if divisions:
        return float(divisions)
    if code:
        m = re.match(r"^q(\d+)h$", code)
        if m and int(m.group(1)) > 0:
            return round(24.0 / float(m.group(1)), 2)
    return {
        "once_daily": 1.0,
        "daily": 1.0,
        "bid": 2.0,
        "tid": 3.0,
        "qid": 4.0,
        "every_other_day": 0.5,
        "weekly": 1.0 / 7.0,
        # range frequencies: conservative low end
        "q4-6h": 4.0,
        "q6-8h": 3.0,
        "q8-12h": 2.0,
        "q12-24h": 1.0,
        "tid-qid": 3.0,
    }.get(code or "")


def _dose_unit_conversion_factor(from_unit: str | None, to_unit: str) -> Optional[float]:
    src = (from_unit or "").upper()
    dst = to_unit.upper()
    if "/" in src:
        src = src.split("/", 1)[0]
    if src == dst:
        return 1.0
    if src == "MG" and dst == "MCG":
        return 1000.0
    if src == "MCG" and dst == "MG":
        return 0.001
    if src == "G" and dst == "MG":
        return 1000.0
    if src == "MG" and dst == "G":
        return 0.001
    return None


def _is_combination_context(rule: sqlite3.Row) -> bool:
    if (rule["review_status"] == "reviewed") or (rule["confidence"] == "reviewed"):
        return False
    return bool(COMBINATION_CONTEXT_RE.search(rule["notes"] or ""))


def _is_chronic_maintenance(rule: sqlite3.Row, indication_text: str | None) -> bool:
    if rule["default_duration_days"]:
        return False
    if rule["frequency_code"] in {None, "prn"}:
        return False
    if _row_get(rule, "is_prn"):
        return False
    text = f"{indication_text or ''} {rule['notes'] or ''}".lower()
    # NOTE: a bare "once" here used to match "40 mg ONCE daily" and veto the
    # 30-day maintenance supply for virtually every chronic once-daily regimen.
    # Only genuinely one-shot wordings count as acute now.
    if re.search(r"\b(acute|infection|infective|flare|migraine|fever|pain|postoperative|single[- ]dose|one[- ]time|as a single)\b", text):
        return False
    return bool(re.search(
        r"diabetes|hypertension|hyperlipidemia|cholesterol|hypothyroidism|maintenance|"
        r"cardiovascular|coronary|heart failure|angina|chronic|"
        # Common chronic conditions the old list missed — these are titrated
        # maintenance regimens that deserve a default 30-day supply, not an
        # rx-less dead end (furosemide edema was the canonical case).
        r"edema|volume overload|ascites|atrial fibrillation|gerd|reflux|"
        r"osteoporosis|glaucoma|copd|parkinson|epilep|seizure|depress|anxiet|"
        r"bipolar|schizo|thyroid|gout(?!y arthritis, acute)|prophylaxis of migraine",
        text,
    ))


def _apply_named_adjustments(
    drug_name: str,
    indication_text: str | None,
    dose_unit: str,
    computed_per_dose: Optional[float],
    total_per_day: Optional[float],
    doses_per_day: Optional[float],
    crcl: Optional[float],
    child_pugh: Optional[str],
    age_years: Optional[float] = None,
    weight_kg: Optional[float] = None,
    weight_entered: bool = False,
) -> tuple[Optional[float], Optional[float], list[str], list[str], bool]:
    """Small reviewed threshold guards for common chronic drugs.

    These do not replace the source renal/hepatic text. They handle clear
    dose-changing thresholds so UI toggles produce deterministic results.
    """
    name = drug_name.lower()
    indication = (indication_text or "").lower()
    unit = (dose_unit or "").lower()
    adjustments: list[str] = []
    needs: list[str] = []
    suppress = False

    if computed_per_dose is None:
        return computed_per_dose, total_per_day, adjustments, needs, suppress

    if "apixaban" in name and ("fibrillation" in indication or "flutter" in indication) and unit == "mg":
        # Label dose reduction: 2.5 mg BID when >=2 of (age >=80, weight <=60 kg,
        # SCr >=1.5 mg/dL). SCr is not collected by the calculator, so only the
        # two known criteria can trigger the reduction; one criterion plus an
        # unknown SCr gets a caution instead.
        met = []
        if age_years is not None and age_years >= 80:
            met.append("age ≥80")
        if weight_entered and weight_kg is not None and weight_kg <= 60:
            met.append("weight ≤60 kg")
        if len(met) >= 2 and computed_per_dose > 2.5:
            computed_per_dose = 2.5
            total_per_day = computed_per_dose * doses_per_day if doses_per_day else total_per_day
            adjustments.append(
                f"dose reduced to 2.5 mg twice daily ({' + '.join(met)}; label criteria: ≥2 of age ≥80, weight ≤60 kg, SCr ≥1.5 mg/dL)"
            )
        elif len(met) >= 2:
            adjustments.append(
                f"2.5 mg twice daily confirmed appropriate ({' + '.join(met)} meet the label's dose-reduction criteria)"
            )
        elif len(met) == 1:
            adjustments.append(
                f"{met[0]} meets 1 of 3 reduction criteria — if SCr ≥1.5 mg/dL, reduce to 2.5 mg twice daily"
            )
        return computed_per_dose, total_per_day, adjustments, needs, suppress

    if "metformin" in name:
        if crcl is not None:
            if crcl < 30:
                suppress = True
                needs.append("renal_contraindication")
                adjustments.append("renal: metformin contraindicated when eGFR/CrCl is below 30")
            elif crcl < 45:
                max_day = 1000.0
                if unit == "mg" and total_per_day and total_per_day > max_day and doses_per_day:
                    total_per_day = max_day
                    computed_per_dose = max_day / doses_per_day
                adjustments.append("renal: eGFR/CrCl 30-45, initiation generally not recommended; if continued, use reduced dose and monitor")
            else:
                adjustments.append(f"renal: no dose change parsed for eGFR/CrCl {crcl:g}")
        if child_pugh:
            cp = child_pugh.upper()
            if cp in {"B", "C"}:
                suppress = True
                needs.append("hepatic_avoid_use")
                adjustments.append(f"hepatic: Child-Pugh {cp}, avoid metformin in significant hepatic impairment")
            else:
                adjustments.append(f"hepatic: no dose change parsed for Child-Pugh {cp}")

    elif "lisinopril" in name and crcl is not None and unit == "mg":
        if crcl < 10:
            computed_per_dose = min(computed_per_dose, 2.5)
            total_per_day = computed_per_dose * doses_per_day if doses_per_day else total_per_day
            adjustments.append("renal: CrCl <10, consider alternative; if used, start 2.5 mg once daily")
        elif crcl <= 30:
            cap = 5.0 if "hypertension" in indication else 2.5
            computed_per_dose = min(computed_per_dose, cap)
            total_per_day = computed_per_dose * doses_per_day if doses_per_day else total_per_day
            adjustments.append(f"renal: CrCl 10-30, reduced initial dose to {cap:g} mg once daily")
        else:
            adjustments.append(f"renal: no dose change parsed for CrCl {crcl:g}")

    elif "atorvastatin" in name:
        if crcl is not None:
            adjustments.append("renal: no dosage adjustment necessary")
        if child_pugh and child_pugh.upper() in {"B", "C"}:
            # Label: contraindicated in active liver disease / decompensated
            # cirrhosis; exposure rises ~11-fold in Child-Pugh B.
            suppress = True
            needs.append("hepatic_avoid_use")
            adjustments.append(
                f"hepatic: Child-Pugh {child_pugh.upper()}, avoid atorvastatin — "
                "contraindicated in active liver disease/decompensated cirrhosis"
            )
        elif child_pugh:
            adjustments.append("hepatic: Child-Pugh A, use with caution and monitor transaminases")

    elif "amlodipine" in name:
        if crcl is not None:
            adjustments.append("renal: no dosage adjustment required")
        if child_pugh and unit == "mg":
            cap = 2.5 if "hypertension" in indication else 5.0
            if computed_per_dose > cap:
                computed_per_dose = cap
                total_per_day = computed_per_dose * doses_per_day if doses_per_day else total_per_day
            adjustments.append(f"hepatic: start {cap:g} mg once daily and titrate slowly")

    elif "levothyroxine" in name:
        if crcl is not None:
            adjustments.append("renal: no dosage adjustment necessary")
        if child_pugh:
            adjustments.append("hepatic: no manufacturer dosage adjustment provided")

    return computed_per_dose, total_per_day, adjustments, needs, suppress


def _renal_guidance(c: sqlite3.Connection, drug_id: int, crcl: float) -> dict:
    """CrCl-aware renal guidance from drug_renal_adjust.

    Selection order:
      1. a row whose crcl_min/crcl_max bracket matches the entered CrCl
         (its stored adjustment_factor is trusted — it was extracted per-bracket);
      2. otherwise the drug's generic text row, whose adjustment text is PARSED
         at runtime into eGFR/CrCl segments and matched to the entered value.
         Blanket stored factors on bracket-less rows are IGNORED — they were the
         source of 'renal: 1x (CrCl 20)' while the text said the opposite.
    """
    rows = _rows(c, "SELECT * FROM drug_renal_adjust WHERE drug_id = ? ORDER BY id", (drug_id,))
    if not rows:
        return {
            "input": crcl, "status": "none", "factor": None,
            "message": f"No renal dosing text available for CrCl {crcl:g} — verify with a pharmacist.",
            "source_text": "",
        }

    # Curated bracket rows (epocrates) rank ahead of scraped rows.
    rows.sort(key=lambda r: (0 if (r.get("source_name") or "").lower() == "epocrates" else 1, r.get("id") or 0))

    for row in rows:
        lo, hi = row.get("crcl_min"), row.get("crcl_max")
        if lo is None and hi is None:
            continue
        if (lo is None or crcl >= float(lo)) and (hi is None or crcl < float(hi)):
            factor = row.get("adjustment_factor")
            text = _clean_adjust_text(row.get("adjustment_text"))
            if factor is not None:
                status = "no_change" if abs(float(factor) - 1.0) < 1e-9 else "factor"
                message = (
                    f"renal (CrCl {crcl:g}): no dosage adjustment necessary"
                    if status == "no_change"
                    else f"renal (CrCl {crcl:g}): dose x{float(factor):g} per source bracket"
                )
                return {"input": crcl, "status": status, "factor": float(factor),
                        "message": message, "source_text": text[:320]}
            # No stored factor: classify the bracket's action text directly.
            status, factor = _classify_adjustment_action(text)
            messages = {
                "avoid": f"renal (CrCl {crcl:g}): source says avoid/contraindicated at this kidney function",
                "no_change": f"renal (CrCl {crcl:g}): no dosage adjustment necessary",
                "factor": f"renal (CrCl {crcl:g}): administer {factor:.0%} of the usual dose" if factor else "",
                "replace": f"renal (CrCl {crcl:g}): use the source's reduced regimen — {text[:160]}",
                "increase_possible": f"renal (CrCl {crcl:g}): higher doses may be required for effect",
                "verify": f"renal (CrCl {crcl:g}): verify source guidance",
            }
            return {"input": crcl, "status": status, "factor": factor,
                    "message": messages.get(status) or messages["verify"],
                    "source_text": text[:320]}

    # Text fallback: prefer the curated full-text row when one exists.
    text_rows = [r for r in rows if r.get("crcl_min") is None and r.get("crcl_max") is None]
    text_source = text_rows[0] if text_rows else rows[0]
    text = _clean_adjust_text(text_source.get("adjustment_text"))
    segments = _parse_renal_segments(text)
    matched = None
    for seg in segments:
        if (seg["lo"] is None or crcl >= seg["lo"]) and (seg["hi"] is None or crcl < seg["hi"]):
            matched = seg
            break
    if matched is None and segments:
        # Single ">= X: no adjustment"-style texts leave the low bracket implicit.
        open_low = [s for s in segments if s["lo"] is not None and s["hi"] is None and crcl < s["lo"]]
        if open_low:
            return {"input": crcl, "status": "verify", "factor": None,
                    "message": f"renal (CrCl {crcl:g}): below the parsed threshold — verify source guidance",
                    "source_text": text[:320]}
    if matched is None:
        # No numeric CrCl brackets in the text — many sources just state a
        # global action ("No dosage adjustment necessary in any degree of
        # impairment"). Classify the whole text; only trust the clear cases.
        if not segments:
            status, factor = _classify_adjustment_action(text)
            if status in {"no_change", "avoid"}:
                message = (
                    f"renal (CrCl {crcl:g}): no dosage adjustment necessary"
                    if status == "no_change"
                    else f"renal (CrCl {crcl:g}): source says avoid/contraindicated in kidney impairment"
                )
                return {"input": crcl, "status": status, "factor": factor,
                        "message": message, "source_text": text[:320]}
        return {"input": crcl, "status": "verify", "factor": None,
                "message": f"renal (CrCl {crcl:g}): no CrCl-specific rule parsed — verify source guidance",
                "source_text": text[:320]}

    status, factor = _classify_adjustment_action(matched["action"])
    messages = {
        "avoid": f"renal (CrCl {crcl:g}): source says avoid/contraindicated at this kidney function",
        "no_change": f"renal (CrCl {crcl:g}): no dosage adjustment necessary",
        "factor": f"renal (CrCl {crcl:g}): administer {factor:.0%} of the usual dose" if factor else "",
        "replace": f"renal (CrCl {crcl:g}): use the source's reduced regimen — {matched['action'][:160]}",
        "increase_possible": f"renal (CrCl {crcl:g}): higher doses may be required for effect (decreased tubular secretion)",
        "verify": f"renal (CrCl {crcl:g}): verify source guidance",
    }
    return {"input": crcl, "status": status, "factor": factor,
            "message": messages.get(status) or messages["verify"],
            "source_text": matched["action"][:320]}


def _hepatic_guidance(c: sqlite3.Connection, drug_id: int, child_pugh: str) -> dict:
    """Child-Pugh-aware hepatic guidance from drug_hepatic_adjust.

    The table has no usable structured factors (0 rows DB-wide), so the source
    text is parsed at runtime: Child-Pugh class segments (or mild/moderate/
    severe wording mapped to A/B/C) are matched to the entered class, and the
    action is classified (avoid / no change / % factor / day-cap / verify)."""
    cp = child_pugh.upper()
    rows = _rows(c, "SELECT * FROM drug_hepatic_adjust WHERE drug_id = ? ORDER BY id", (drug_id,))
    if not rows:
        return {
            "input": cp, "status": "none", "factor": None, "max_mg_per_day": None,
            "message": f"No hepatic dosing text available for Child-Pugh {cp} — verify with a pharmacist.",
            "source_text": "",
        }

    rows.sort(key=lambda r: (0 if (r.get("source_name") or "").lower() == "epocrates" else 1, r.get("id") or 0))

    for row in rows:
        row_class = (row.get("child_pugh_class") or "").strip().upper()
        if row_class and row_class == cp:
            text = _clean_adjust_text(row.get("adjustment_text"))
            if row.get("adjustment_factor") is not None:
                factor = float(row["adjustment_factor"])
                status = "no_change" if abs(factor - 1.0) < 1e-9 else "factor"
                return {"input": cp, "status": status, "factor": factor, "max_mg_per_day": None,
                        "message": f"hepatic (Child-Pugh {cp}): dose x{factor:g} per source",
                        "source_text": text[:320]}
            # Class row without a stored factor: classify its action text.
            status, factor = _classify_adjustment_action(text)
            day_cap = _action_day_cap_mg(text)
            if day_cap is not None and status in {"verify", "no_change"}:
                status = "day_cap"
            messages = {
                "avoid": f"hepatic (Child-Pugh {cp}): source says avoid/contraindicated in this degree of impairment",
                "no_change": f"hepatic (Child-Pugh {cp}): no dosage adjustment necessary",
                "factor": f"hepatic (Child-Pugh {cp}): administer {factor:.0%} of the usual dose" if factor else "",
                "replace": f"hepatic (Child-Pugh {cp}): use the source's adjusted regimen — {text[:160]}",
                "day_cap": f"hepatic (Child-Pugh {cp}): do not exceed {day_cap:g} mg/day" if day_cap else "",
                "verify": f"hepatic (Child-Pugh {cp}): verify source guidance",
            }
            return {"input": cp, "status": status, "factor": factor, "max_mg_per_day": day_cap,
                    "message": messages.get(status) or messages["verify"],
                    "source_text": text[:320]}

    text_rows = [r for r in rows if not (r.get("child_pugh_class") or "").strip()]
    text_source = text_rows[0] if text_rows else rows[0]
    text = _clean_adjust_text(text_source.get("adjustment_text"))
    segments = _parse_hepatic_segments(text)
    matched = next((seg for seg in segments if cp in seg["classes"]), None)
    if matched is None:
        if not segments:
            status, factor = _classify_adjustment_action(text)
            if status in {"no_change", "avoid"}:
                message = (
                    f"hepatic (Child-Pugh {cp}): no dosage adjustment necessary"
                    if status == "no_change"
                    else f"hepatic (Child-Pugh {cp}): source says avoid/contraindicated in hepatic impairment"
                )
                return {"input": cp, "status": status, "factor": factor, "max_mg_per_day": None,
                        "message": message, "source_text": text[:320]}
        return {"input": cp, "status": "verify", "factor": None, "max_mg_per_day": None,
                "message": f"hepatic (Child-Pugh {cp}): no class-specific rule parsed — verify source guidance",
                "source_text": text[:320]}

    status, factor = _classify_adjustment_action(matched["action"])
    day_cap = _action_day_cap_mg(matched["action"])
    if day_cap is not None and status in {"verify", "no_change"}:
        status = "day_cap"
    messages = {
        "avoid": f"hepatic (Child-Pugh {cp}): source says avoid/contraindicated in this degree of impairment",
        "no_change": f"hepatic (Child-Pugh {cp}): no dosage adjustment necessary",
        "factor": f"hepatic (Child-Pugh {cp}): administer {factor:.0%} of the usual dose" if factor else "",
        "day_cap": f"hepatic (Child-Pugh {cp}): do not exceed {day_cap:g} mg/day" if day_cap else "",
        "verify": f"hepatic (Child-Pugh {cp}): verify source guidance",
    }
    return {"input": cp, "status": status, "factor": factor, "max_mg_per_day": day_cap,
            "message": messages.get(status) or messages["verify"],
            "source_text": matched["action"][:320]}


def _best_strength(
    c: sqlite3.Connection,
    drug_id: int,
    target_dose: float,
    unit: str,
    route: str | None,
    preferred_dose_form: str | None = None,
    dose_range: Optional[tuple[float, float]] = None,
    prefer_liquid: bool = False,
) -> Optional[dict]:
    if not has_table(c, "drug_strengths"):
        return None
    unit = unit.upper()
    rows = _rows(
        c,
        """
        SELECT strength_num, strength_unit, strength_text, dose_form, route
        FROM drug_strengths
        WHERE drug_id = ?
          AND strength_num IS NOT NULL
        ORDER BY strength_num DESC
        LIMIT 100
        """,
        (drug_id,),
    )
    usable = []
    for idx, row in enumerate(rows):
        strength = float(row["strength_num"] or 0)
        if strength <= 0:
            continue
        strength_unit = str(row.get("strength_unit") or "").upper()
        # Multi-mL container strengths ('240 G/4000ML') have ambiguous
        # per-administration semantics — never build a sig from them.
        m_container = re.search(r"/\s*(\d+(?:\.\d+)?)\s*ML", strength_unit)
        if m_container and float(m_container.group(1)) != 1.0:
            continue
        conversion = _dose_unit_conversion_factor(strength_unit, unit)
        if conversion is None:
            continue
        dose_per_admin_unit = strength * conversion
        if dose_per_admin_unit <= 0:
            continue
        units = target_dose / dose_per_admin_unit
        strength_unit_upper = strength_unit
        row_form = str(row.get("dose_form") or "").lower()
        row_is_liquid = bool(re.search(r"solution|suspension|syrup|liquid", row_form)) or (
            "/" in strength_unit_upper and "ML" in strength_unit_upper
        )
        in_range_rounded = False
        if dose_range and dose_range[1] > dose_range[0]:
            # Prefer a practical whole-unit count whose dose stays INSIDE the
            # rule's allowed range: digoxin 357 mcg (5.1 mcg/kg upper bound)
            # becomes 1 × 0.25 mg tablet (3.6 mcg/kg — within 3.4-5.1), never
            # 'take 1.4 tablets'.
            lo, hi = dose_range[0] * 0.98, dose_range[1] * 1.02
            options = [1.0, 2.0, 0.5, 3.0, 1.5, 4.0]
            if row_is_liquid:
                # liquids measure fine in 0.5 mL steps
                options += [round(units), round(units * 2) / 2]
            candidates = [n for n in options if n > 0 and lo <= n * dose_per_admin_unit <= hi]
            if candidates:
                rounded = min(candidates, key=lambda n: (abs(n * dose_per_admin_unit - target_dose), n))
                if abs(rounded - units) > 0.05:
                    units = rounded
                    in_range_rounded = True
        max_units = 30.0 if row_is_liquid else 8.0
        if 0.25 <= units <= max_units:
            wholeish = abs(units - round(units)) < 0.05 or abs(units * 2 - round(units * 2)) < 0.05
            form = str(row.get("dose_form") or "").lower()
            strength_text = str(row.get("strength_text") or "").lower()
            preferred = (preferred_dose_form or "").lower().strip()
            if preferred and preferred not in form:
                continue
            release_penalty = 0
            if re.search(r"extended|delayed|sustained|modified|release", f"{form} {strength_text}"):
                release_penalty = 6
                if preferred and re.search(r"extended|delayed|sustained|modified|release", preferred):
                    release_penalty = 0
            form_penalty = 0 if form else 1
            if (route or "").upper() == "PO" and "injection" in form:
                form_penalty += 5
            is_liquid = bool(re.search(r"solution|suspension|syrup|liquid", form)) or (
                "/" in strength_unit and "ML" in strength_unit
            )
            if prefer_liquid:
                # Young children get suspensions, not split tablets.
                form_penalty += 0 if is_liquid else 3
            elif "/" in strength_unit:
                form_penalty += 1
            unit_penalty = abs(units - 1) if units <= 3 else 5 + units
            if "/" in strength_unit and "ML" in strength_unit:
                admin_unit = "mL"
            else:
                admin_unit = _dose_form_word(form)
                if admin_unit == "mL":
                    # absolute-MG 'solution'/'suspension' rows are whole
                    # containers/packets, not millilitres
                    admin_unit = "unit"
            usable.append((
                0 if wholeish else 1,
                release_penalty,
                form_penalty,
                unit_penalty,
                abs(round(units) - units),
                strength,
                str(row.get("strength_text") or ""),
                idx,
                row,
                units,
                admin_unit,
                dose_per_admin_unit,
                in_range_rounded,
            ))
    if not usable:
        return None
    usable.sort(key=lambda item: item[:8])
    chosen = usable[0]
    row = chosen[8]
    row["units"] = chosen[9]
    row["admin_unit"] = chosen[10]
    row["dispensed_dose"] = chosen[9] * chosen[11]
    row["in_range_rounded"] = chosen[12]
    return row


def _format_number(value: float) -> str:
    if abs(value - round(value)) < 0.05:
        return str(int(round(value)))
    return f"{value:.1f}".rstrip("0").rstrip(".")


def _display_units(value: float) -> float:
    for denominator in (1, 2, 4):
        rounded = round(value * denominator) / denominator
        if abs(value - rounded) < 0.05:
            return rounded
    return value


def format_prescription(
    drug_name: str,
    dose_value: float,
    dose_unit: str,
    frequency_code: str | None,
    divisions_per_day: Optional[float],
    duration_days: Optional[int],
    route: str | None,
    strength: Optional[dict],
    schedule_context: Optional[str] = None,
) -> Optional[dict]:
    if duration_days is None or duration_days <= 0:
        return None
    doses_day = _doses_per_day(frequency_code, divisions_per_day)
    if not doses_day:
        return None
    if dose_unit.lower() in {"mg", "mcg"} and not strength:
        return None

    include_duration = schedule_context != "maintenance"
    if strength and dose_unit.lower() in {"mg", "mcg"}:
        form = strength.get("admin_unit") or _dose_form_word(strength.get("dose_form"))
        units = _display_units(float(strength["units"]))
        unit_display = _format_number(units)
        plural = "" if form == "mL" or abs(units - 1) < 0.05 else "s"
        strength_text = strength.get("strength_text") or f"{_format_number(float(strength['strength_num']))} {strength['strength_unit']}"
        display_form = strength.get("dose_form") or _dose_form_word(strength.get("dose_form"))
        drug_display = f"{drug_name} {strength_text} {display_form}"
        injectable = (route or "").upper() in {"SC", "IV", "IM"}
        verb = "Inject" if injectable else "Take"
        dose_amount = f" ({_format_number(dose_value)} {dose_unit})" if injectable and form == "mL" else ""
        sig = (
            f"{verb} {unit_display} {form}{plural}{dose_amount} {_route_phrase(route)} "
            f"{_freq_phrase(frequency_code)}"
        )
        if include_duration:
            sig += f" for {duration_days} days"
        if injectable and form == "mL":
            # injectables dispense by syringe/vial count, not pooled volume
            dose_count = math.ceil(doses_day * duration_days)
            dispense = (
                f"#{dose_count} prefilled syringes/vials of {strength_text} — verify fill volume"
            )
        else:
            quantity = math.ceil(units * doses_day * duration_days)
            dispense = f"#{quantity} {form}{'' if form == 'mL' or quantity == 1 else 's'}"
    else:
        drug_display = drug_name
        sig = (
            f"Take {_format_number(dose_value)} {dose_unit} {_route_phrase(route)} "
            f"{_freq_phrase(frequency_code)}"
        )
        if include_duration:
            sig += f" for {duration_days} days"
        dispense = "Verify quantity"

    return {
        "drug_display": drug_display,
        "sig": sig,
        "dispense": dispense,
        "refills": 0,
        "duration_days": duration_days,
        "days_supply": duration_days,
        "schedule_context": schedule_context,
    }


def calculate_dose(
    c: sqlite3.Connection,
    drug_id: int,
    indication_id: Optional[int] = None,
    weight_kg: Optional[float] = None,
    age_years: Optional[float] = None,
    crcl: Optional[float] = None,
    child_pugh: Optional[str] = None,
    dose_form: Optional[str] = None,
    route: Optional[str] = None,
) -> dict:
    drug_id = resolve_drug_id(c, drug_id)
    drug = c.execute("SELECT * FROM drugs WHERE drug_id = ?", (drug_id,)).fetchone()
    if not drug:
        raise KeyError("Drug not found")
    if not has_table(c, "drug_dosing_rules"):
        return _no_rule_response(drug, "Structured dosing has not been extracted yet.")

    assumptions: list[str] = []
    effective_weight_kg = weight_kg
    if effective_weight_kg is None and age_years is None:
        effective_weight_kg = DEFAULT_ADULT_WEIGHT_KG
        assumptions.append(f"default adult weight {DEFAULT_ADULT_WEIGHT_KG:g} kg")

    population = _choose_population(c, drug_id, age_years, effective_weight_kg)
    default_indication_id = None
    requested_indication_id = indication_id
    if indication_id is None:
        default_row = _default_indication_row(c, drug_id, population)
        if default_row and default_row["indication_id"]:
            default_indication_id = int(default_row["indication_id"])
            indication_id = default_indication_id
            assumptions.append(f"default indication: {default_row['indication_text']}")
    rule, used_indication_fallback = _select_rule(
        c, drug_id, indication_id, population, route,
        age_years=age_years, weight_kg=effective_weight_kg,
    )
    if not rule:
        return _no_rule_response(drug, "No structured dosing rule is available for this medication.")

    indication = None
    if rule["indication_id"]:
        indication = c.execute(
            "SELECT id, indication_text FROM drug_indications WHERE id = ?",
            (rule["indication_id"],),
        ).fetchone()

    # The user asked for an indication that has no parsed rule of its own; the
    # engine borrowed the drug's best sibling-indication rule. Say so clearly
    # instead of the old hard "no structured dosing rule" dead end.
    indication_fallback = None
    if used_indication_fallback and requested_indication_id is not None:
        requested = c.execute(
            "SELECT indication_text FROM drug_indications WHERE id = ?",
            (requested_indication_id,),
        ).fetchone()
        indication_fallback = {
            "requested_id": requested_indication_id,
            "requested_text": requested["indication_text"] if requested else None,
            "used_text": indication["indication_text"] if indication else None,
        }
        assumptions.append(
            f"no parsed rule for '{indication_fallback['requested_text'] or 'selected indication'}'; "
            f"using the closest available rule ({indication_fallback['used_text'] or 'another indication'}) — verify applicability"
        )

    suspect_rule = _rule_is_suspect(rule)

    adjustments: list[str] = []
    steps: list[str] = []
    capped = False
    computed_per_dose = None
    total_per_day = None
    dose_range: Optional[tuple[float, float]] = None  # allowed per-dose window for strength rounding
    display = None
    needs: list[str] = []
    dose_unit = rule["dose_unit"] or "mg"
    doses_per_day = _doses_per_day(rule["frequency_code"], rule["divisions_per_day"])
    implausible_frequency = bool(
        doses_per_day and doses_per_day > 6.01
        and (dose_unit or "mg").lower() in {"mg", "mcg"}
        and (rule["route"] or "").upper() in {"", "PO", "IV", "IM", "SC"}
    )
    if implausible_frequency:
        # 'q1h'-style parses on systemic drugs are extraction noise, not sigs.
        doses_per_day = None
    indication_text = indication["indication_text"] if indication else None
    weight_based_rule = rule["mg_per_kg_low"] is not None or rule["mg_per_kg_high"] is not None
    rule_source = (rule["source_name"] or "source").strip() or "source"
    titration_rule = (rule["schedule_context"] == "titration") or bool(
        re.search(r"\bStart\s*:", rule["notes"] or "")
    )

    chronic_context = _is_chronic_maintenance(rule, indication_text)

    if weight_based_rule:
        if effective_weight_kg is None:
            needs.append("weight_kg")
        else:
            low = float(rule["mg_per_kg_low"] or rule["mg_per_kg_high"])
            high = float(rule["mg_per_kg_high"] or rule["mg_per_kg_low"])
            # Chronic maintenance ranges start at the LOW end (digoxin
            # 3.4-5.1 mcg/kg must not default to the top of the range);
            # acute/course regimens keep the guideline high end (amox AOM 90).
            use_low = (
                high > low
                and not rule["default_duration_days"]
                and (titration_rule or chronic_context)
            )
            anchor = low if use_low else high
            divisions = doses_per_day or 1.0
            if rule["dose_basis"] == "per_day":
                anchor_day = anchor * effective_weight_kg
                total_per_day = anchor_day
                display = (
                    f"{_format_number(low)}-{_format_number(high)} {dose_unit}/kg/day "
                    f"divided {_freq_phrase(rule['frequency_code'])}"
                )
                steps.append(f"Rule ({rule_source}): {display}" + (
                    " — starting at the low end (titrate per response)" if use_low else ""
                ))
                steps.append(
                    f"{_format_number(anchor)} {dose_unit}/kg/day × {_format_number(effective_weight_kg)} kg "
                    f"= {_format_number(anchor_day)} {dose_unit}/day"
                )
                if doses_per_day is None:
                    # frequency unparsed: never present the whole day as one dose
                    needs.append("dosing_frequency")
                    display += " (frequency not parsed — see source text)"
                else:
                    computed_per_dose = anchor_day / divisions
                    if high > low:
                        dose_range = (
                            low * effective_weight_kg / divisions,
                            high * effective_weight_kg / divisions,
                        )
                    if divisions != 1.0:
                        steps.append(
                            f"{_format_number(anchor_day)} {dose_unit}/day ÷ {_format_number(divisions)} doses "
                            f"= {_format_number(computed_per_dose)} {dose_unit} per dose"
                        )
            else:
                anchor_dose = anchor * effective_weight_kg
                computed_per_dose = anchor_dose
                total_per_day = anchor_dose * divisions if doses_per_day else None
                if high > low:
                    dose_range = (low * effective_weight_kg, high * effective_weight_kg)
                display = (
                    f"{_format_number(low)}-{_format_number(high)} {dose_unit}/kg/dose "
                    f"{_freq_phrase(rule['frequency_code'])}"
                )
                steps.append(f"Rule ({rule_source}): {display}" + (
                    " — starting at the low end (titrate per response)" if use_low else ""
                ))
                steps.append(
                    f"{_format_number(anchor)} {dose_unit}/kg/dose × {_format_number(effective_weight_kg)} kg "
                    f"= {_format_number(anchor_dose)} {dose_unit} per dose"
                )
                if doses_per_day:
                    steps.append(
                        f"{_format_number(anchor_dose)} {dose_unit} × {_format_number(divisions)} doses/day "
                        f"= {_format_number(total_per_day)} {dose_unit}/day"
                    )

            # Source per-kg caps (epocrates 'Max: 15 mg/kg/dose', 'Max: 75 mg/kg/day')
            max_kg_dose = _row_get(rule, "max_mg_per_kg_dose")
            max_kg_day = _row_get(rule, "max_mg_per_kg_day")
            if dose_unit.lower() == "mg" and computed_per_dose is not None:
                if max_kg_dose and computed_per_dose > float(max_kg_dose) * effective_weight_kg:
                    computed_per_dose = float(max_kg_dose) * effective_weight_kg
                    if doses_per_day:
                        total_per_day = computed_per_dose * doses_per_day
                    capped = True
                    steps.append(
                        f"Capped at source max {_format_number(float(max_kg_dose))} mg/kg/dose "
                        f"→ {_format_number(computed_per_dose)} mg per dose"
                    )
                if max_kg_day and total_per_day is not None and total_per_day > float(max_kg_day) * effective_weight_kg:
                    total_per_day = float(max_kg_day) * effective_weight_kg
                    computed_per_dose = total_per_day / (doses_per_day or 1.0)
                    capped = True
                    steps.append(
                        f"Capped at source max {_format_number(float(max_kg_day))} mg/kg/day "
                        f"→ {_format_number(total_per_day)} mg/day"
                    )
    else:
        low = float(rule["fixed_dose_low"] or rule["fixed_dose_high"] or 0)
        high = float(rule["fixed_dose_high"] or rule["fixed_dose_low"] or 0)
        if rule["dose_basis"] == "per_day" and not doses_per_day:
            # Daily-total rule with unparseable frequency ('1.8-3.6 g/day in
            # divided doses'): show it AS a daily total — presenting 3600 mg
            # as computed_dose (a per-dose field) is how the gabapentin
            # 3.6 g single dose almost shipped.
            total_per_day = high or low
            display = (
                f"{_format_number(low)}-{_format_number(high)} {dose_unit}/day in divided doses"
                if high and high != low else f"{_format_number(high or low)} {dose_unit}/day in divided doses"
            )
            steps.append(f"Rule ({rule_source}): {display}")
            steps.append("Dosing frequency was not parsed — per-dose amount not computed; see source text")
            needs.append("dosing_frequency")
        elif rule["dose_basis"] == "per_day" and doses_per_day:
            # The parsed numbers are a DAILY total ('1.8 to 3.6 g/day in divided
            # doses'), not a per-administration dose. Dividing here is the
            # difference between gabapentin 1200 mg tid and 3600 mg tid.
            day_value = high or low
            start_day_value = low or high
            if (titration_rule or chronic_context) and not rule["default_duration_days"] and low and high and high > low:
                day_value = start_day_value
                steps.append(
                    f"Rule ({rule_source}): {_format_number(low)}-{_format_number(high)} {dose_unit}/day "
                    f"divided {_freq_phrase(rule['frequency_code'])} — starting at the low end (titrate per response)"
                )
            else:
                steps.append(
                    f"Rule ({rule_source}): {_format_number(low)}-{_format_number(high)} {dose_unit}/day "
                    f"divided {_freq_phrase(rule['frequency_code'])}"
                )
            total_per_day = day_value
            computed_per_dose = day_value / doses_per_day
            if high > low and day_value == high:
                dose_range = (low / doses_per_day, computed_per_dose)
            if low == high:
                display = f"{_format_number(low)} {dose_unit}/day {_freq_phrase(rule['frequency_code'])}" \
                    if doses_per_day == 1.0 else \
                    f"{_format_number(low)} {dose_unit}/day divided {_freq_phrase(rule['frequency_code'])}"
            else:
                display = (
                    f"{_format_number(low)}-{_format_number(high)} {dose_unit}/day "
                    f"divided {_freq_phrase(rule['frequency_code'])}"
                )
            steps.append(
                f"{_format_number(day_value)} {dose_unit}/day ÷ {_format_number(doses_per_day)} doses "
                f"= {_format_number(computed_per_dose)} {dose_unit} per dose"
            )
        else:
            # For a range with an explicit starting dose and no fixed course
            # length (chronic/titrated drugs), the safe computed dose is the
            # STARTING dose, not the top of the range (sertraline 50-200 mg
            # once daily must compute 50, not 200).
            if (titration_rule or chronic_context) and not rule["default_duration_days"] and low and high > low:
                computed_per_dose = low
                steps.append(
                    f"Rule ({rule_source}): {_format_number(low)}-{_format_number(high)} {dose_unit} "
                    f"{_freq_phrase(rule['frequency_code'])} — starting at {_format_number(low)} {dose_unit} (titrate per response)"
                )
            else:
                computed_per_dose = high or low
                if high and high != low:
                    dose_range = (low, high)
                    steps.append(
                        f"Rule ({rule_source}): {_format_number(low)}-{_format_number(high)} {dose_unit} "
                        f"{_freq_phrase(rule['frequency_code'])} — using {_format_number(computed_per_dose)} {dose_unit}"
                    )
                else:
                    steps.append(
                        f"Rule ({rule_source}): {_format_number(computed_per_dose)} {dose_unit} "
                        f"{_freq_phrase(rule['frequency_code'])}"
                    )
            total_per_day = computed_per_dose * doses_per_day if doses_per_day else None
            display = (
                f"{_format_number(low)}-{_format_number(high)} {dose_unit}"
                if high and high != low else f"{_format_number(computed_per_dose)} {dose_unit}"
            )
            if total_per_day is not None and doses_per_day and doses_per_day != 1.0:
                steps.append(
                    f"{_format_number(computed_per_dose)} {dose_unit} × {_format_number(doses_per_day)} doses/day "
                    f"= {_format_number(total_per_day)} {dose_unit}/day"
                )
        if effective_weight_kg is not None and weight_kg is not None:
            assumptions.append("weight is not used by this fixed adult dose rule")

    if computed_per_dose is not None and dose_unit.lower() == "mg":
        if rule["max_mg_per_dose"] and computed_per_dose > float(rule["max_mg_per_dose"]):
            computed_per_dose = float(rule["max_mg_per_dose"])
            capped = True
            steps.append(f"Capped at source max {_format_number(float(rule['max_mg_per_dose']))} mg per dose")
        if total_per_day is not None and rule["max_mg_per_day"] and total_per_day > float(rule["max_mg_per_day"]):
            total_per_day = float(rule["max_mg_per_day"])
            computed_per_dose = total_per_day / (doses_per_day or 1.0)
            capped = True
            steps.append(
                f"Capped at source max {_format_number(float(rule['max_mg_per_day']))} mg/day "
                f"→ {_format_number(computed_per_dose)} mg per dose"
            )
        if capped and dose_range:
            dose_range = (min(dose_range[0], computed_per_dose), min(dose_range[1], computed_per_dose))

    # Explicit starting dose from the source ('Start: 100 mg PO qd') beats the
    # bottom of the maintenance range for chronic/titrated drugs (allopurinol
    # maintenance is 200-600 mg/day but treatment STARTS at 100 mg).
    if (
        computed_per_dose is not None
        and not weight_based_rule
        and (titration_rule or chronic_context)
        and not rule["default_duration_days"]
        and dose_unit.lower() == "mg"
    ):
        m_start = re.search(r"Start:\s*(\d+(?:\.\d+)?)\s*mg\b", rule["notes"] or "")
        if m_start:
            start_val = float(m_start.group(1))
            if 0 < start_val < computed_per_dose:
                computed_per_dose = start_val
                total_per_day = start_val * doses_per_day if doses_per_day else None
                dose_range = None  # the source mandates this exact starting dose
                steps.append(
                    f"Source starting dose: {_format_number(start_val)} mg (titrate per response)"
                )

    if re.search(r"\b(?:LBW|lean body|ideal body|IBW|ABW|adjusted body)\b", rule["notes"] or "", re.IGNORECASE):
        assumptions.append(
            "source doses by lean/ideal/adjusted body weight — the entered weight was used as-is; recalculate for obese patients"
        )

    if "multi_phase_regimen" in _rule_parse_warning_set(rule):
        steps.append(
            "Multi-phase regimen — the numbers above cover only the FIRST phase; follow the full schedule in the source text"
        )

    drug_name_lower = (drug["generic_name"] or "").lower()
    named_adjustment_drug = any(
        name in drug_name_lower
        for name in ("metformin", "lisinopril", "atorvastatin", "amlodipine", "levothyroxine")
    )

    renal_guidance = None
    hepatic_guidance = None
    guidance_suppresses_rx = False

    if crcl is not None and has_table(c, "drug_renal_adjust") and not named_adjustment_drug:
        renal_guidance = _renal_guidance(c, drug_id, crcl)
        adjustments.append(renal_guidance["message"])
        if renal_guidance["status"] == "factor" and renal_guidance["factor"] and computed_per_dose is not None:
            factor = float(renal_guidance["factor"])
            computed_per_dose *= factor
            if total_per_day is not None:
                total_per_day *= factor
            if dose_range:
                dose_range = (dose_range[0] * factor, dose_range[1] * factor)
            steps.append(
                f"Renal adjustment (CrCl {crcl:g}): × {factor:g} "
                f"→ {_format_number(computed_per_dose)} {dose_unit} per dose"
            )
        elif renal_guidance["status"] == "replace":
            guidance_suppresses_rx = True
            needs.append("renal_replacement_regimen")
            steps.append(f"Renal adjustment (CrCl {crcl:g}): source replaces the usual regimen — see renal guidance")
        elif renal_guidance["status"] == "avoid":
            guidance_suppresses_rx = True
            needs.append("renal_contraindication")
            steps.append(f"Renal adjustment (CrCl {crcl:g}): avoid/contraindicated — prescription withheld")
        elif renal_guidance["status"] in {"verify", "none"} and crcl < 60:
            # Unverifiable renal guidance at reduced kidney function: show the
            # numbers, never auto-write the prescription.
            guidance_suppresses_rx = True
            needs.append("renal_dosing_verification")
            steps.append(
                f"Renal adjustment (CrCl {crcl:g}): no parseable source rule — prescription withheld, verify manually"
            )

    if child_pugh and has_table(c, "drug_hepatic_adjust") and not named_adjustment_drug:
        hepatic_guidance = _hepatic_guidance(c, drug_id, child_pugh)
        adjustments.append(hepatic_guidance["message"])
        if hepatic_guidance["status"] == "factor" and hepatic_guidance["factor"] and computed_per_dose is not None:
            factor = float(hepatic_guidance["factor"])
            computed_per_dose *= factor
            if total_per_day is not None:
                total_per_day *= factor
            if dose_range:
                dose_range = (dose_range[0] * factor, dose_range[1] * factor)
            steps.append(
                f"Hepatic adjustment (Child-Pugh {child_pugh.upper()}): × {factor:g} "
                f"→ {_format_number(computed_per_dose)} {dose_unit} per dose"
            )
        elif hepatic_guidance["status"] == "day_cap" and hepatic_guidance["max_mg_per_day"] and dose_unit.lower() == "mg":
            cap = float(hepatic_guidance["max_mg_per_day"])
            if total_per_day is not None and total_per_day > cap:
                total_per_day = cap
                computed_per_dose = cap / (doses_per_day or 1.0)
                capped = True
                steps.append(
                    f"Hepatic adjustment (Child-Pugh {child_pugh.upper()}): capped at {_format_number(cap)} mg/day"
                )
        elif hepatic_guidance["status"] == "replace":
            guidance_suppresses_rx = True
            needs.append("hepatic_replacement_regimen")
            steps.append(
                f"Hepatic adjustment (Child-Pugh {child_pugh.upper()}): source replaces the usual regimen — see hepatic guidance"
            )
        elif hepatic_guidance["status"] == "avoid":
            guidance_suppresses_rx = True
            needs.append("hepatic_contraindication")
            steps.append(
                f"Hepatic adjustment (Child-Pugh {child_pugh.upper()}): avoid/contraindicated — prescription withheld"
            )
        elif hepatic_guidance["status"] in {"verify", "none"} and child_pugh.upper() in {"B", "C"}:
            guidance_suppresses_rx = True
            needs.append("hepatic_dosing_verification")
            steps.append(
                f"Hepatic adjustment (Child-Pugh {child_pugh.upper()}): no parseable source rule — "
                "prescription withheld, verify manually"
            )

    named_per_dose, named_total_day, named_adjustments, named_needs, suppress_prescription = _apply_named_adjustments(
        drug["generic_name"] or "",
        indication_text,
        dose_unit,
        computed_per_dose,
        total_per_day,
        doses_per_day,
        crcl,
        child_pugh,
        age_years=age_years,
        weight_kg=effective_weight_kg,
        weight_entered=weight_kg is not None,
    )
    if named_adjustments and named_per_dose is not None and named_per_dose != computed_per_dose:
        dose_range = None  # an exact adjusted dose is mandated; do not re-round
        steps.append(
            f"Adjusted to {_format_number(named_per_dose)} {dose_unit} per dose ({named_adjustments[-1]})"
        )
    elif named_adjustments:
        steps.extend(f"Note: {item}" for item in named_adjustments)
    computed_per_dose = named_per_dose
    total_per_day = named_total_day
    adjustments.extend(named_adjustments)
    needs.extend(named_needs)
    if computed_per_dose is not None and not weight_based_rule and adjustments:
        display = f"{_format_number(computed_per_dose)} {dose_unit}"

    # ── Safety ceiling: never exceed the curated max daily dose ─────────────
    ceiling_mg_day = None
    if computed_per_dose is not None and dose_unit.lower() == "mg" and has_table(c, "drug_dose_ceilings"):
        ceiling_rows = _rows(
            c,
            "SELECT * FROM drug_dose_ceilings WHERE drug_id = ? AND population = ?",
            (drug_id, rule["population"] or population),
        )
        rule_route = (rule["route"] or "").upper()
        candidates = []
        for row in ceiling_rows:
            row_route = (row.get("route") or "").upper()
            if row_route and rule_route and row_route != rule_route:
                continue
            cap = row.get("max_mg_per_day")
            if cap is None and row.get("max_mg_per_kg_day") and effective_weight_kg:
                cap = float(row["max_mg_per_kg_day"]) * effective_weight_kg
            if cap:
                candidates.append(float(cap))
        if candidates:
            ceiling_mg_day = max(candidates)
            if total_per_day is not None and total_per_day > ceiling_mg_day * 1.02:
                severe_overage = total_per_day > ceiling_mg_day * 1.5
                steps.append(
                    f"SAFETY CEILING: computed {_format_number(total_per_day)} mg/day exceeds the source "
                    f"maximum {_format_number(ceiling_mg_day)} mg/day — capped"
                )
                total_per_day = ceiling_mg_day
                computed_per_dose = ceiling_mg_day / (doses_per_day or 1.0)
                if dose_range:
                    # keep strength rounding from climbing back above the ceiling
                    dose_range = (
                        min(dose_range[0], computed_per_dose),
                        min(dose_range[1], computed_per_dose),
                    )
                capped = True
                adjustments.append(
                    f"capped at source maximum {_format_number(ceiling_mg_day)} mg/day"
                )
                if severe_overage:
                    guidance_suppresses_rx = True
                    needs.append("dose_exceeded_source_max")

    # ── Population / bracket guards ──────────────────────────────────────────
    population_mismatch = population == "pediatric" and (rule["population"] or "") == "adult"
    if population_mismatch:
        needs.append("pediatric_specific_rule")
        assumptions.append(
            "no pediatric rule parsed for this medication — an ADULT rule is shown; do not prescribe from it for a child"
        )
    bracket_mismatch = _rule_age_weight_mismatch(rule, age_years, weight_kg)
    if bracket_mismatch:
        needs.append("age_weight_bracket_match")
        assumptions.append(
            "patient falls outside the age/weight bracket of every parsed rule — verify dosing in the source text"
        )

    parse_warnings: list[str] = []
    try:
        parse_warnings = json.loads(rule["parse_warnings"] or "[]")
    except Exception:
        parse_warnings = []

    duration_days = rule["default_duration_days"]
    schedule_context = rule["schedule_context"]
    duration_assumed = False
    if duration_days is None and _is_chronic_maintenance(rule, indication_text):
        duration_days = DEFAULT_CHRONIC_SUPPLY_DAYS
        schedule_context = "maintenance"
        duration_assumed = True
        assumptions.append(f"no stop date parsed; using {DEFAULT_CHRONIC_SUPPLY_DAYS}-day maintenance supply")
        parse_warnings = [warning for warning in parse_warnings if warning != "missing_duration"]

    if _is_combination_context(rule) and "combination_regimen_requires_review" not in parse_warnings:
        parse_warnings.append("combination_regimen_requires_review")
        needs.append("reviewed_combination_regimen")

    if suspect_rule:
        # Only suspect rules existed for this drug/population — show the parsed
        # numbers with a hard warning, never a prescription (see _rule_is_suspect).
        if "suspect_parse_verify_source" not in parse_warnings:
            parse_warnings.append("suspect_parse_verify_source")
        needs.append("verified_dose_rule")

    if implausible_frequency and "implausible_frequency" not in parse_warnings:
        parse_warnings.append("implausible_frequency")
        needs.append("verified_dose_rule")

    titration_fragment = _rule_is_titration_fragment(rule)
    if titration_fragment and "titration_schedule_not_dosing_frequency" not in parse_warnings:
        parse_warnings.append("titration_schedule_not_dosing_frequency")
        needs.append("verified_dose_rule")
    lab_value_dose = _rule_dose_is_lab_value(rule)
    if lab_value_dose and "dose_may_be_lab_threshold" not in parse_warnings:
        parse_warnings.append("dose_may_be_lab_threshold")
        needs.append("verified_dose_rule")

    prescription = None
    strength = None
    reviewed_rule = rule["confidence"] == "reviewed" or rule["review_status"] == "reviewed"
    durable_source_rule = rule["confidence"] in {"reviewed", "high", "medium"} and rule["review_status"] != "rejected"
    structurally_ready = bool(rule["route"]) and bool(rule["frequency_code"]) and bool(duration_days)
    parenteral_route = (rule["route"] or "").upper() in {"IV", "IM"}
    if parenteral_route and computed_per_dose is not None:
        # IV/IM dosing is an administration order, not an outpatient sig.
        needs.append("parenteral_administration_order")
    # A per-day rule divided by a RANGE frequency ('divided q6-8h') computes
    # with the fewest doses/day; a sig quoting the full range would let the
    # fast end exceed the daily total by up to 50%. Display only.
    range_freq_per_day = (
        rule["dose_basis"] == "per_day"
        and "-" in (rule["frequency_code"] or "")
    )
    if range_freq_per_day and computed_per_dose is not None:
        needs.append("exact_frequency_selection")
    can_generate_prescription = (
        computed_per_dose is not None
        and structurally_ready
        and not suppress_prescription
        and not guidance_suppresses_rx
        and not suspect_rule
        and not titration_fragment
        and not lab_value_dose
        and not implausible_frequency
        and not population_mismatch
        and not bracket_mismatch
        and not parenteral_route
        and not range_freq_per_day
        and not _is_combination_context(rule)
        and (bool(rule["rx_ready"]) or reviewed_rule or (duration_assumed and durable_source_rule))
    )
    if computed_per_dose is not None and can_generate_prescription:
        preferred_form = dose_form or rule["dose_form"]
        strength = _best_strength(
            c, drug_id, computed_per_dose, dose_unit, rule["route"], preferred_form,
            dose_range=dose_range,
            prefer_liquid=(
                population == "pediatric"
                and (age_years is not None and age_years < 8)
                and (rule["route"] or "PO").upper() == "PO"
                and not dose_form
            ),
        )
        if dose_form and not strength:
            needs.append("selected_form_strength")
        elif dose_unit.lower() in {"mg", "mcg"} and not strength:
            needs.append("compatible_strength")
        if strength:
            # A sig must be practical and faithful: solid forms only in
            # half-unit steps up to 6, and the dispensed amount must match the
            # computed dose (no 'Take 0.7 tablets', no 17 g standing in for 238 g).
            units_val = float(strength.get("units") or 0)
            admin = strength.get("admin_unit") or ""
            dispensed_val = float(strength.get("dispensed_dose") or 0)
            if admin in {"tablet", "capsule"}:
                practical = any(
                    abs(units_val - n) < 0.05
                    for n in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0)
                )
            elif admin == "mL":
                practical = 0.25 <= units_val <= 60
            else:
                # ambiguous administration units (containers, packets, puffs)
                # never become an auto-generated sig
                practical = False
            faithful = (
                strength.get("in_range_rounded")
                or (computed_per_dose and abs(dispensed_val - computed_per_dose) / computed_per_dose <= 0.025)
            )
            if not practical or not faithful:
                strength = None
                needs.append("practical_strength")
        if strength and strength.get("in_range_rounded") and strength.get("dispensed_dose"):
            dispensed = float(strength["dispensed_dose"])
            if abs(dispensed - computed_per_dose) > 0.01:
                steps.append(
                    f"Rounded to a practical strength within the allowed range: "
                    f"{_format_number(dispensed)} {dose_unit} per dose"
                )
                computed_per_dose = dispensed
                if doses_per_day:
                    total_per_day = dispensed * doses_per_day
        prescription = format_prescription(
            drug["generic_name"],
            computed_per_dose,
            dose_unit,
            rule["frequency_code"],
            rule["divisions_per_day"],
            duration_days,
            rule["route"],
            strength,
            schedule_context,
        )
        if strength and prescription:
            units_txt = _format_number(_display_units(float(strength["units"])))
            steps.append(
                f"Dispensable form: {strength.get('strength_text') or ''} {strength.get('dose_form') or ''} "
                f"× {units_txt} per dose"
            )

    dose_notes: list[str] = []
    if has_table(c, "drug_dose_notes"):
        dose_notes = [
            r["note_text"] for r in _rows(
                c,
                "SELECT note_text FROM drug_dose_notes WHERE drug_id = ? ORDER BY id LIMIT 4",
                (drug_id,),
            )
        ]

    return {
        "drug_id": drug_id,
        "indication": {
            "id": indication["id"],
            "text": indication["indication_text"],
        } if indication else None,
        "indication_fallback": indication_fallback,
        "renal_guidance": renal_guidance,
        "hepatic_guidance": hepatic_guidance,
        "population": population,
        "route": rule["route"],
        "dose_form": rule["dose_form"] or (strength.get("dose_form") if strength else None),
        "computed_mg_per_dose": round(computed_per_dose, 3) if computed_per_dose is not None and dose_unit.lower() == "mg" else None,
        "computed_dose": round(computed_per_dose, 3) if computed_per_dose is not None else None,
        "dose_unit": dose_unit,
        "weight_kg": effective_weight_kg,
        "default_weight_used": weight_kg is None and effective_weight_kg == DEFAULT_ADULT_WEIGHT_KG,
        "default_indication_used": default_indication_id is not None,
        "doses_per_day": doses_per_day,
        "total_mg_per_day": round(total_per_day, 3) if total_per_day is not None and dose_unit.lower() == "mg" else None,
        "capped_by_max": capped,
        "adjustments_applied": adjustments or ["none"],
        "prescription": prescription,
        "confidence": rule["confidence"],
        "review_status": rule["review_status"],
        "source": {
            "section_id": rule["source_section_id"],
            "name": rule["source_name"],
            "method": rule["extraction_method"],
        },
        "rule_id": rule["id"],
        "rx_ready": bool(can_generate_prescription and prescription),
        "needs": needs,
        "assumptions": assumptions,
        "display": display,
        "notes": rule["notes"],
        "parse_warnings": parse_warnings,
        "calculation_steps": steps,
        "dose_notes": dose_notes,
        "max_mg_per_day_ceiling": ceiling_mg_day,
        "disclaimer": DISCLAIMER,
    }


def _no_rule_response(drug: sqlite3.Row, message: str) -> dict:
    return {
        "drug_id": int(drug["drug_id"]),
        "indication": None,
        "indication_fallback": None,
        "renal_guidance": None,
        "hepatic_guidance": None,
        "population": None,
        "route": None,
        "dose_form": None,
        "computed_mg_per_dose": None,
        "computed_dose": None,
        "dose_unit": None,
        "weight_kg": None,
        "default_weight_used": False,
        "default_indication_used": False,
        "doses_per_day": None,
        "total_mg_per_day": None,
        "capped_by_max": False,
        "adjustments_applied": [],
        "prescription": None,
        "confidence": "low",
        "review_status": "needs_review",
        "source": None,
        "rule_id": None,
        "rx_ready": False,
        "needs": ["structured_dose_rule"],
        "assumptions": [],
        "display": message,
        "notes": message,
        "parse_warnings": ["missing_structured_dose"],
        "calculation_steps": [],
        "dose_notes": [],
        "max_mg_per_day_ceiling": None,
        "disclaimer": DISCLAIMER,
    }

"""Import epocrates structured dosing into drug_reference.sqlite.

The epocrates RX.sqlite bundle stores professionally curated, compact dosing
strings with a highly regular grammar:

    ADULT_DOSING / PEDS_DOSING rows (per drug, DISPLAY_ORDER):
      INDICATION_STRING_ID -> "otitis media, acute" | "" (continuation)
                              | "renal dosing" | "hepatic dosing" | "Special Note"
      DOSING_STRING_ID     -> either the regimen itself ("300-1200 mg PO tid")
                              or a subgroup label ("6 mo-1 yo", "PO route,
                              immediate-release form", "BMI <40 kg/m^2")
      INFO_STRING_ID       -> "Dose: 850-1000 mg PO bid; Start: ...; Max: 2550
                              mg/day; Alt: ...; Info: ..."

This script parses those strings into drug_dosing_rules rows
(source_name='epocrates', confidence='high'), per-bracket renal/hepatic
adjustment rows, per-drug daily-max safety ceilings (drug_dose_ceilings), and
drug-level clinical dosing notes (drug_dose_notes).

Re-runnable: all previously imported epocrates rows are deleted first.

Usage:
    python scripts/build_epocrates_dosing.py [--epocrates PATH] [--db PATH] [--dry-run]
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import DRUG_REF_DB, ROOT  # noqa: E402
from dose_engine import indication_words  # noqa: E402

SOURCE = "epocrates"


def find_or_create_indication(
    c: sqlite3.Connection,
    drug_id: int,
    indication_text: str,
    now: int,
    cache: dict,
) -> int:
    """Reuse an existing indication row when it clearly names the same
    condition (synonym-aware Jaccard >= 0.7, or one word set contains the
    other). Duplicated indications previously kept curated rules from winning:
    the user would pick the old 'Acute otitis media, Uncomplicated' row and
    rule selection saw the epocrates 80-90 mg/kg rule as a cross-indication
    fallback behind the outdated 40-50 mg/kg scrape."""
    key = (drug_id, indication_text.lower().strip())
    if key in cache:
        return cache[key]

    rows = c.execute(
        "SELECT id, indication_text FROM drug_indications WHERE drug_id = ?",
        (drug_id,),
    ).fetchall()
    # Treatment intent must match exactly: merging 'DVT prophylaxis' into
    # 'Deep vein thrombosis' would file a 40 mg prophylaxis regimen under the
    # TREATMENT indication (gross underdose for an actual clot).
    MODALITY = {"prophylaxis", "prevention", "treatment", "maintenance",
                "acute", "chronic", "initial", "adjunct", "conversion"}
    new_words = indication_words(indication_text)
    new_modality = new_words & MODALITY
    best_id, best_score = None, 0.0
    for row in rows:
        if row["indication_text"].strip().lower() == indication_text.strip().lower():
            best_id, best_score = int(row["id"]), 2.0
            break
        old_words = indication_words(row["indication_text"])
        if not new_words or not old_words:
            continue
        if (old_words & MODALITY) != new_modality:
            continue
        inter = new_words & old_words
        union = new_words | old_words
        jaccard = len(inter) / len(union)
        subset = (
            (new_words <= old_words and len(new_words) >= 2)
            or (old_words <= new_words and len(old_words) >= 2)
        )
        score = 1.0 + jaccard if subset else jaccard
        if (jaccard >= 0.7 or subset) and score > best_score:
            best_id, best_score = int(row["id"]), score

    if best_id is None:
        cur = c.execute(
            """INSERT INTO drug_indications
               (drug_id, indication_text, indication_rank, source_name,
                confidence, review_status, created_at, label_status)
               VALUES (?,?,?,?,?,?,?,?)""",
            (drug_id, indication_text, 500, SOURCE, "high", "unreviewed", now,
             "off_label" if "off-label" in indication_text.lower() else "source_listed"),
        )
        best_id = int(cur.lastrowid)
    cache[key] = best_id
    return best_id

# ── name matching ────────────────────────────────────────────────────────────

_SALT_WORDS = (
    "hydrochloride|hcl|sodium|potassium|calcium|magnesium|tartrate|bitartrate|"
    "maleate|mesylate|besylate|fumarate|succinate|citrate|phosphate|diphosphate|"
    "acetate|dipropionate|propionate|valerate|palmitate|stearate|nitrate|"
    "bromide|chloride|carbonate|gluconate|lactate|salicylate|decanoate|"
    "enanthate|benzoate|pamoate|monohydrate|dihydrate|anhydrous|trihydrate|"
    "hemihydrate|disodium|dipotassium|hydrobromide|hbr|tosylate|oxalate|malate|"
    "sulfate|sulphate|sulfates"
)
_SALT_RE = re.compile(rf"(?:\s+(?:{_SALT_WORDS}))+$", re.IGNORECASE)
# Route-suffixed epocrates entries describe a different clinical product
# (different dosing); never map them onto the systemic drug row.
_ROUTE_SUFFIX_RE = re.compile(
    r"\b(topical|ophthalmic|otic|nasal|injection|inhaled|inhalation|rectal|"
    r"vaginal|buccal|transdermal|sublingual|urethral|irrigation)\b",
    re.IGNORECASE,
)


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9/ ]", "", (name or "").lower())).strip()


def _base(name: str) -> str:
    return _SALT_RE.sub("", _norm(name)).strip()


def _combo_key(name: str) -> str | None:
    if "/" not in (name or ""):
        return None
    parts = sorted(_base(p) for p in name.split("/") if p.strip())
    return "/".join(parts) if all(parts) else None


# ── regimen grammar ──────────────────────────────────────────────────────────

_NUM = r"\d+(?:[.,]\d+)?"
_REGIMEN_RE = re.compile(
    rf"""
    (?P<low>{_NUM})
    (?:\s*-\s*(?P<high>{_NUM}))?
    \s*(?P<unit>mcg|mg|g|units?|mEq)
    (?P<perkg>\s*/\s*kg)?
    (?:\s*/\s*(?P<basis>day|dose))?
    (?:\s+(?P<form>ER|XR|DR|SR|CR|LA|IR))?
    (?:\s+(?P<route>PO/NG|PO/IV|IV/PO|PO/SL|SL/PO|IM/IV|IV/IM|SC/IV|IV/SC|IV/IM/SC|PO|IV|IM|SC|SL|PR|NG))?
    (?:\s+(?P<divided>divided)\s+)?
    (?:\s*(?P<freq>q\d+(?:-\d+)?h|qd|qam|qpm|qhs|bid|tid-qid|tid|qid|qod|
        q24h|q48h|qwk|q\d+wk|qmo|x1)\b)?
    (?P<prn>\s+prn)?
    (?:\s+x\s*(?P<dur_lo>\d+)(?:\s*-\s*(?P<dur_hi>\d+))?\s*(?P<dur_unit>days?|wk|weeks?|mo|months?))?
    """,
    re.VERBOSE | re.IGNORECASE,
)

_FREQ_MAP = {
    "qd": ("once_daily", 1.0), "qam": ("once_daily", 1.0), "qpm": ("once_daily", 1.0),
    "qhs": ("once_daily", 1.0), "q24h": ("once_daily", 1.0),
    "bid": ("bid", 2.0), "q12h": ("bid", 2.0),
    "tid": ("tid", 3.0), "q8h": ("tid", 3.0),
    "qid": ("qid", 4.0), "q6h": ("qid", 4.0),
    "q4h": ("q4h", 6.0), "q3h": ("q3h", 8.0),
    "qod": ("every_other_day", 0.5), "q48h": ("every_other_day", 0.5),
    "qwk": ("weekly", 1.0 / 7.0),
    # range frequencies: keep the literal code, use the LOW division count so
    # computed totals stay conservative
    "q4-6h": ("q4-6h", 4.0), "q6-8h": ("q6-8h", 3.0), "q8-12h": ("q8-12h", 2.0),
    "q12-24h": ("q12-24h", 1.0), "q24-48h": ("q24-48h", 0.5),
    "tid-qid": ("tid-qid", 3.0),
}


def _to_mg(value: float, unit: str) -> float | None:
    u = unit.lower()
    if u == "mg":
        return value
    if u == "g":
        return value * 1000.0
    if u == "mcg":
        return value / 1000.0
    return None


def parse_regimen(text: str) -> dict | None:
    """Parse one epocrates regimen phrase into structured fields."""
    if not text:
        return None
    t = text.strip()
    if re.match(r"(?i)^(individualize|titrate|see |refer |use |apply|varies)", t):
        return None
    # BSA-based (mg/m^2) and infusion-rate (mcg/min, mg/hr) regimens cannot be
    # represented in the flat per-dose fields — never import them as if they were.
    if re.search(r"/\s*m\s*\^?\s*2", t, re.IGNORECASE):
        return None
    if re.search(r"(?:mcg|mg|units?)\s*/\s*(?:min|hr|hour|h)\b", t, re.IGNORECASE):
        return None
    m = _REGIMEN_RE.search(t)
    if not m or not m.group("unit"):
        return None
    low = float(m.group("low").replace(",", ""))
    high = float(m.group("high").replace(",", "")) if m.group("high") else None
    unit = m.group("unit").lower()
    if unit == "units" or unit == "unit":
        unit = "units"
    per_kg = bool(m.group("perkg"))
    basis = (m.group("basis") or "").lower() or None
    freq_raw = (m.group("freq") or "").lower()
    divided = bool(m.group("divided")) or "divided" in t.lower()
    if divided and basis is None and per_kg:
        basis = "day"
    prn = bool(m.group("prn")) or bool(re.search(r"\bprn\b", t, re.IGNORECASE))
    single_dose = freq_raw == "x1" or bool(re.search(r"\bx1\b(?!\d)", t))

    freq_code, divisions = None, None
    if freq_raw and freq_raw != "x1":
        mapped = _FREQ_MAP.get(freq_raw)
        if mapped:
            freq_code, divisions = mapped
        else:
            freq_code = freq_raw
            m2 = re.match(r"q(\d+)h", freq_raw)
            if m2:
                divisions = max(1.0, round(24.0 / float(m2.group(1)), 2))

    dur_lo = int(m.group("dur_lo")) if m.group("dur_lo") else None
    dur_hi = int(m.group("dur_hi")) if m.group("dur_hi") else None
    dur_unit = (m.group("dur_unit") or "").lower()
    factor = 7 if dur_unit.startswith(("wk", "week")) else 30 if dur_unit.startswith(("mo", "month")) else 1
    duration_low = dur_lo * factor if dur_lo is not None else None
    duration_high = (dur_hi or dur_lo) * factor if dur_lo is not None else None
    if duration_low is None:
        # 'for at least 3wk' / 'for up to 8wk' phrasings
        m_dur = re.search(
            r"for\s+(at least|up to)\s*(\d+)\s*(days?|wk|weeks?|mo|months?)",
            t, re.IGNORECASE,
        )
        if m_dur:
            n = int(m_dur.group(2))
            u = m_dur.group(3).lower()
            n *= 7 if u.startswith(("wk", "week")) else 30 if u.startswith(("mo", "month")) else 1
            if m_dur.group(1).lower() == "at least":
                duration_low = n
            else:
                duration_high = n
    if single_dose:
        duration_low = duration_high = 1

    multi_phase = bool(re.search(r"\bthen\b", t, re.IGNORECASE))
    route = (m.group("route") or "").upper() or None
    if route in {"PO/NG", "NG", "PO/IV", "IV/PO", "PO/SL", "SL/PO"}:
        route = "PO"
    if route in {"IM/IV", "IV/IM", "IV/IM/SC"}:
        route = "IV"
    if route in {"SC/IV", "IV/SC"}:
        route = "SC"

    return {
        "low": low, "high": high if high is not None else low,
        "unit": unit, "per_kg": per_kg,
        "basis": ("per_day" if basis == "day" else "per_dose" if basis == "dose" else
                  ("per_day" if divided else None)),
        "form": (m.group("form") or "").upper() or None,
        "route": route,
        "frequency_code": freq_code,
        "divisions": divisions,
        "is_prn": prn,
        "single_dose": single_dose,
        "duration_low": duration_low,
        "duration_high": duration_high,
        "multi_phase": multi_phase,
        "raw": t,
    }


_MAX_PART_RE = re.compile(
    rf"({_NUM})\s*(mcg|mg|g|units?)\s*(/\s*kg)?\s*/\s*(day|dose)",
    re.IGNORECASE,
)


def parse_max(text: str) -> dict:
    """Parse a Max: clause -> absolute and per-kg day/dose caps in mg."""
    out = {"max_mg_per_day": None, "max_mg_per_dose": None,
           "max_mg_per_kg_day": None, "max_mg_per_kg_dose": None}
    for m in _MAX_PART_RE.finditer(text or ""):
        value = float(m.group(1).replace(",", ""))
        mg = _to_mg(value, m.group(2))
        if mg is None:
            continue
        per_kg, basis = bool(m.group(3)), m.group(4).lower()
        key = (
            "max_mg_per_kg_day" if per_kg and basis == "day" else
            "max_mg_per_kg_dose" if per_kg else
            "max_mg_per_day" if basis == "day" else
            "max_mg_per_dose"
        )
        if out[key] is None or mg < out[key]:
            out[key] = mg
    return out


# ── age / weight bracket parsing (subgroup labels) ───────────────────────────

def _years(value: float, unit: str) -> float:
    u = unit.lower()
    if u.startswith("mo"):
        return value / 12.0
    if u.startswith("wk") or u.startswith("week"):
        return value / 52.0
    return value


def parse_brackets(label: str) -> dict:
    """Extract age/weight bounds from a subgroup label like '6 mo-1 yo',
    '12 yo and older, >40 kg', 'IV route, <50 kg'."""
    out = {"min_age": None, "max_age": None, "min_wt": None, "max_wt": None,
           "route": None, "form": None, "skip": False}
    t = (label or "").strip()
    if not t:
        return out
    if re.search(r"neonat|gestation|preterm|premature", t, re.IGNORECASE):
        out["skip"] = True
        return out
    m = re.search(r"(PO|IV|IM|SC|SL|PR)\s+route", t, re.IGNORECASE)
    if m:
        out["route"] = m.group(1).upper()
    if re.search(r"extended[- ]release|\bER\b|\bXR\b", t, re.IGNORECASE):
        out["form"] = "extended release"

    m = re.search(rf"({_NUM})\s*(yo|mo|wk)\s*-\s*({_NUM})\s*(yo|mo|wk)", t)
    if m:
        out["min_age"] = _years(float(m.group(1)), m.group(2))
        out["max_age"] = _years(float(m.group(3)), m.group(4))
    else:
        m = re.search(rf"({_NUM})\s*-\s*({_NUM})\s*(yo|mo|wk)\b", t)
        if m:
            out["min_age"] = _years(float(m.group(1)), m.group(3))
            out["max_age"] = _years(float(m.group(2)), m.group(3))
        else:
            m = re.search(rf"({_NUM})\s*(yo|mo|wk)\s+and\s+older", t)
            if m:
                out["min_age"] = _years(float(m.group(1)), m.group(2))
            m = re.search(rf">\s*({_NUM})\s*(yo|mo|wk)\b", t)
            if m:
                out["min_age"] = _years(float(m.group(1)), m.group(2))
            m = re.search(rf"<\s*({_NUM})\s*(yo|mo|wk)\b", t)
            if m:
                out["max_age"] = _years(float(m.group(1)), m.group(2))

    if not re.search(r"kg/m", t):  # ignore BMI expressions
        m = re.search(rf"({_NUM})\s*-\s*({_NUM})\s*kg\b", t)
        if m:
            out["min_wt"], out["max_wt"] = float(m.group(1)), float(m.group(2))
        else:
            m = re.search(rf">\s*({_NUM})\s*kg\b", t)
            if m:
                out["min_wt"] = float(m.group(1))
            m = re.search(rf"<\s*({_NUM})\s*kg\b", t)
            if m:
                out["max_wt"] = float(m.group(1))
    return out


# ── renal / hepatic text splitting ───────────────────────────────────────────

_CRCL_SEG_RE = re.compile(
    rf"(?:CrCl|eGFR|GFR)\s*(?P<op>[<>≥≤]?)\s*(?P<a>{_NUM})"
    rf"(?:\s*-\s*(?P<b>{_NUM}))?\s*:\s*(?P<action>[^;]+)",
    re.IGNORECASE,
)


def split_renal_brackets(text: str) -> list[dict]:
    """Engine matching is [lo, hi): keep the strict/inclusive distinction so a
    patient at exactly CrCl 30 falls in the '≤30' bracket, not the '>30' one."""
    out = []
    for m in _CRCL_SEG_RE.finditer(text or ""):
        op, a = m.group("op"), float(m.group("a"))
        b = float(m.group("b")) if m.group("b") else None
        if b is not None:
            lo, hi = min(a, b), max(a, b) + 1  # "30-59" covers [30, 60)
        elif op == "<":
            lo, hi = None, a
        elif op == "≤":
            lo, hi = None, a + 0.001
        elif op == ">":
            lo, hi = a + 0.001, None
        elif op == "≥":
            lo, hi = a, None
        else:
            lo, hi = a, a + 1
        out.append({"lo": lo, "hi": hi, "action": m.group("action").strip()})
    return out


_CP_SEG_RE = re.compile(
    r"Child-Pugh\s+Class(?:es)?\s+(?P<cls>[ABC](?:\s*(?:,|or|and|-|to|through)\s*[ABC])*)"
    r"\s*(?:\([^)]*\))?\s*:\s*(?P<action>[^;]+)",
    re.IGNORECASE,
)
_FACTOR_RE = re.compile(r"decr(?:ease|\.)?\s+(?:usual\s+)?dose\s+by\s+(\d{1,2})\s*%(?!\s*-)", re.IGNORECASE)


def split_hepatic_brackets(text: str) -> list[dict]:
    out = []
    for m in _CP_SEG_RE.finditer(text or ""):
        letters = re.findall(r"[ABC]", m.group("cls").upper())
        classes = set(letters)
        if len(letters) >= 2 and re.search(r"-|to|through", m.group("cls"), re.IGNORECASE):
            lo, hi = min(letters), max(letters)
            classes = {chr(x) for x in range(ord(lo), ord(hi) + 1)}
        out.append({"classes": classes, "action": m.group("action").strip()})
    if not out:
        m = re.search(r"decompensated cirrhosis[^:]*:\s*([^;]+)", text or "", re.IGNORECASE)
        if m:
            out.append({"classes": {"B", "C"}, "action": m.group(1).strip()})
    return out


def action_factor(action: str) -> float | None:
    """'decrease dose by X%' means GIVE (100-X)% of the usual dose."""
    m = _FACTOR_RE.search(action or "")
    if m:
        pct = float(m.group(1))
        if 10 <= pct <= 90:
            return (100.0 - pct) / 100.0
    return None


# ── epocrates reading ────────────────────────────────────────────────────────

def load_epocrates_rows(e: sqlite3.Connection, drug_id: int, table: str) -> list[dict]:
    rows = e.execute(
        f"""SELECT d.DISPLAY_ORDER AS ord,
                   gi.STRING AS indication, gd.STRING AS dosing, gn.STRING AS info
            FROM {table} d
            LEFT JOIN GENERAL_STRING gi ON gi.ID = d.INDICATION_STRING_ID
            LEFT JOIN GENERAL_STRING gd ON gd.ID = d.DOSING_STRING_ID
            LEFT JOIN GENERAL_STRING gn ON gn.ID = d.INFO_STRING_ID
            WHERE d.DRUG_ID = ?
            ORDER BY d.DISPLAY_ORDER""",
        (drug_id,),
    ).fetchall()
    out = []
    current = ""
    for r in rows:
        ind = (r["indication"] or "").strip()
        if ind:
            current = ind
        out.append({
            "indication": current,
            "subgroup": (r["dosing"] or "").strip(),
            "info": (r["info"] or "").strip(),
        })
    return out


_INFO_FIELD_RE = re.compile(r"\b(Dose|Start|Max|Alt|Info)\s*:\s*", re.IGNORECASE)


def split_info(info: str) -> dict:
    """Split 'Dose: ...; Start: ...; Max: ...; Info: ...' into fields."""
    fields: dict[str, str] = {}
    if not info:
        return fields
    parts = _INFO_FIELD_RE.split(info)
    # parts = [pre, key1, text1, key2, text2, ...]
    if parts[0].strip() and not fields.get("_pre"):
        fields["_pre"] = parts[0].strip().strip(";").strip()
    for i in range(1, len(parts) - 1, 2):
        key = parts[i].capitalize()
        val = parts[i + 1].strip().strip(";").strip()
        if key in fields:
            fields[key] += "; " + val
        else:
            fields[key] = val
    return fields


# ── main build ───────────────────────────────────────────────────────────────

def build(epocrates_path: Path, db_path: Path, dry_run: bool = False) -> None:
    e = sqlite3.connect(f"file:{epocrates_path}?mode=ro", uri=True)
    e.row_factory = sqlite3.Row
    c = sqlite3.connect(str(db_path))
    c.row_factory = sqlite3.Row

    # target-name lookup tables
    ref: dict[str, list[int]] = {}
    for r in c.execute("SELECT drug_id, generic_name FROM drugs"):
        for key in {_norm(r["generic_name"]), _base(r["generic_name"])}:
            if key:
                ref.setdefault(key, []).append(int(r["drug_id"]))
        ck = _combo_key(r["generic_name"])
        if ck:
            ref.setdefault(ck, []).append(int(r["drug_id"]))

    epo_drugs = e.execute(
        "SELECT ID, NAME FROM DRUG WHERE ACTIVE = 1 AND NAME IS NOT NULL"
    ).fetchall()

    matched: list[tuple[int, str, list[int]]] = []
    for d in epo_drugs:
        name = d["NAME"].strip()
        if _ROUTE_SUFFIX_RE.search(name):
            continue
        targets = ref.get(_norm(name)) or ref.get(_base(name))
        if not targets and "/" in name:
            ck = _combo_key(name)
            targets = ref.get(ck) if ck else None
        if targets:
            matched.append((int(d["ID"]), name, sorted(set(targets))))

    print(f"epocrates drugs matched to reference: {len(matched)}")

    # schema prep
    c.execute("""CREATE TABLE IF NOT EXISTS drug_dose_ceilings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drug_id INTEGER NOT NULL,
        population TEXT NOT NULL,
        route TEXT,
        max_mg_per_day REAL,
        max_mg_per_kg_day REAL,
        source_name TEXT NOT NULL DEFAULT 'epocrates')""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_dose_ceilings_drug ON drug_dose_ceilings(drug_id)")
    c.execute("""CREATE TABLE IF NOT EXISTS drug_dose_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drug_id INTEGER NOT NULL,
        note_text TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT 'epocrates')""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_dose_notes_drug ON drug_dose_notes(drug_id)")
    rule_cols = {r["name"] for r in c.execute("PRAGMA table_info(drug_dosing_rules)")}
    for col in ("max_mg_per_kg_day", "max_mg_per_kg_dose"):
        if col not in rule_cols:
            c.execute(f"ALTER TABLE drug_dosing_rules ADD COLUMN {col} REAL")

    # wipe previous import
    c.execute("DELETE FROM drug_dosing_rules WHERE source_name = ?", (SOURCE,))
    c.execute("DELETE FROM drug_renal_adjust WHERE source_name = ?", (SOURCE,))
    c.execute("DELETE FROM drug_hepatic_adjust WHERE source_name = ?", (SOURCE,))
    c.execute("DELETE FROM drug_dose_ceilings WHERE source_name = ?", (SOURCE,))
    c.execute("DELETE FROM drug_dose_notes WHERE source_name = ?", (SOURCE,))
    c.execute("DELETE FROM drug_indications WHERE source_name = ?", (SOURCE,))

    now = int(time.time())
    n_rules = n_renal = n_hepatic = n_notes = n_ceil = 0
    unparsed_samples: list[str] = []
    indication_cache: dict = {}

    for epo_id, epo_name, target_ids in matched:
        for table, population in (("ADULT_DOSING", "adult"), ("PEDS_DOSING", "pediatric")):
            rows = load_epocrates_rows(e, epo_id, table)
            if not rows:
                continue

            # ceilings accumulate across the whole drug/population
            ceil_day: dict[str | None, float] = {}
            ceil_kg_day: dict[str | None, float] = {}

            for row in rows:
                ind_low = row["indication"].lower()
                text_all = f"{row['subgroup']} {row['info']}".strip()

                if ind_low == "special note":
                    note = row["info"] or row["subgroup"]
                    note = re.sub(r"^Info\s*:\s*", "", note).strip()
                    if note and population == "adult":
                        for did in target_ids:
                            c.execute(
                                "INSERT INTO drug_dose_notes (drug_id, note_text, source_name) VALUES (?,?,?)",
                                (did, note[:600], SOURCE),
                            )
                            n_notes += 1
                    continue

                if ind_low == "renal dosing":
                    # renal guidance text (only import once, for adults;
                    # continuation rows carry the same indication forward)
                    if population != "adult":
                        continue
                    text = row["info"] or row["subgroup"]
                    if not text or text.lower() in {"see below"}:
                        text = f"{row['subgroup']}: {row['info']}".strip(": ")
                    brackets = split_renal_brackets(text)
                    for did in target_ids:
                        for b in brackets:
                            c.execute(
                                """INSERT INTO drug_renal_adjust
                                   (drug_id, crcl_min, crcl_max, adjustment_factor,
                                    adjustment_text, source_name, confidence, review_status)
                                   VALUES (?,?,?,?,?,?,?,?)""",
                                (did, b["lo"], b["hi"], None, b["action"][:500],
                                 SOURCE, "high", "unreviewed"),
                            )
                            n_renal += 1
                        if text and ind_low == "renal dosing":
                            c.execute(
                                """INSERT INTO drug_renal_adjust
                                   (drug_id, crcl_min, crcl_max, adjustment_factor,
                                    adjustment_text, source_name, confidence, review_status)
                                   VALUES (?,?,?,?,?,?,?,?)""",
                                (did, None, None, None, text[:800], SOURCE, "high", "unreviewed"),
                            )
                            n_renal += 1
                    continue

                if ind_low == "hepatic dosing":
                    if population != "adult":
                        continue
                    text = row["info"] or row["subgroup"]
                    if not text or text.lower() in {"see below"}:
                        text = f"{row['subgroup']}: {row['info']}".strip(": ")
                    segments = split_hepatic_brackets(text)
                    for did in target_ids:
                        for seg in segments:
                            factor = action_factor(seg["action"])
                            for cls in sorted(seg["classes"]):
                                c.execute(
                                    """INSERT INTO drug_hepatic_adjust
                                       (drug_id, child_pugh_class, adjustment_factor,
                                        adjustment_text, source_name, confidence, review_status)
                                       VALUES (?,?,?,?,?,?,?)""",
                                    (did, cls, factor, seg["action"][:500],
                                     SOURCE, "high", "unreviewed"),
                                )
                                n_hepatic += 1
                        if text:
                            c.execute(
                                """INSERT INTO drug_hepatic_adjust
                                   (drug_id, child_pugh_class, adjustment_factor,
                                    adjustment_text, source_name, confidence, review_status)
                                   VALUES (?,?,?,?,?,?,?)""",
                                (did, None, None, text[:800], SOURCE, "high", "unreviewed"),
                            )
                            n_hepatic += 1
                    continue

                # ── regular dosing row ──
                fields = split_info(row["info"])
                dose_text = fields.get("Dose")
                titration = False
                regimen = parse_regimen(dose_text) if dose_text else None
                if regimen is None:
                    # regimen may live in the subgroup label itself
                    regimen = parse_regimen(row["subgroup"])
                if regimen is None and fields.get("Start"):
                    # e.g. warfarin "Dose: individualize dose PO qd; Start: 2-5 mg PO qd"
                    regimen = parse_regimen(fields["Start"])
                    titration = regimen is not None
                if regimen is None:
                    if text_all and len(unparsed_samples) < 30 and re.search(r"\d", text_all):
                        unparsed_samples.append(f"{epo_name} [{row['indication']}] {text_all[:120]}")
                    continue

                # subgroup carries age/weight brackets whether or not Dose: is present
                brackets = parse_brackets(row["subgroup"])
                if brackets["skip"]:
                    continue

                maxes = parse_max(fields.get("Max", ""))
                multi_phase = regimen["multi_phase"] or bool(
                    re.search(r"\bthen\b", dose_text or "", re.IGNORECASE)
                )
                unit = regimen["unit"]
                if unit not in {"mg", "mcg", "g", "units", "unit", "meq"}:
                    continue
                store_unit = "mg" if unit == "g" else unit
                scale = 1000.0 if unit == "g" else 1.0
                low, high = regimen["low"] * scale, regimen["high"] * scale

                per_kg = regimen["per_kg"]
                basis = regimen["basis"] or ("per_dose" if not per_kg else None)
                if per_kg and basis is None:
                    # "15 mg/kg IV q6h" without /day or /dose -> per dose
                    basis = "per_dose"

                divisions = regimen["divisions"]
                freq_code = regimen["frequency_code"]
                if regimen["single_dose"]:
                    freq_code = freq_code or "once"
                    divisions = divisions or 1.0

                if regimen["route"] is None and brackets.get("route"):
                    regimen["route"] = brackets["route"]
                duration = regimen["duration_low"]
                rx_ready = int(bool(
                    regimen["route"] in {"PO", "IV", "IM", "SC"}
                    and freq_code and divisions
                    and not multi_phase
                    and not titration
                    and not regimen["is_prn"]
                ))

                indication_text = row["indication"].strip()
                if not indication_text:
                    continue

                note_bits = []
                if row["subgroup"] and not parse_regimen(row["subgroup"]):
                    note_bits.append(row["subgroup"])
                if multi_phase and dose_text:
                    note_bits.insert(0, f"Full schedule: {dose_text}")
                for key in ("Start", "Max", "Alt", "Info"):
                    if fields.get(key):
                        note_bits.append(f"{key}: {fields[key]}")
                if not dose_text and fields.get("Start") and titration:
                    note_bits.insert(0, "Starting dose shown; titrate per response")
                notes = "; ".join(note_bits)[:900]
                # A flattened multi-phase regimen must not present as a
                # confidently-parsed flat dose (azithromycin Z-pak, vanc taper).
                confidence = "medium" if (multi_phase or titration) else "high"
                warnings_json = '["multi_phase_regimen"]' if multi_phase else "[]"

                for did in target_ids:
                    ind_id = find_or_create_indication(c, did, indication_text, now, indication_cache)

                    c.execute(
                        """INSERT INTO drug_dosing_rules
                           (drug_id, indication_id, population,
                            mg_per_kg_low, mg_per_kg_high, dose_basis, divisions_per_day,
                            max_mg_per_day, max_mg_per_dose, max_mg_per_kg_day, max_mg_per_kg_dose,
                            default_duration_days, route, dose_form, notes,
                            source_name, source_priority, confidence, extraction_method,
                            review_status, parse_warnings,
                            min_age_years, max_age_years, min_weight_kg, max_weight_kg,
                            fixed_dose_low, fixed_dose_high, dose_unit, frequency_code,
                            duration_low_days, duration_high_days, is_prn, prn_reason,
                            schedule_context, rx_ready, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            did, ind_id, population,
                            low if per_kg else None, high if per_kg else None,
                            basis, divisions,
                            maxes["max_mg_per_day"], maxes["max_mg_per_dose"],
                            maxes["max_mg_per_kg_day"], maxes["max_mg_per_kg_dose"],
                            duration, regimen["route"],
                            "extended release" if (regimen["form"] in {"ER", "XR"} or brackets.get("form")) else None,
                            notes,
                            SOURCE, 1, confidence, "epocrates_v1", "unreviewed", warnings_json,
                            brackets["min_age"], brackets["max_age"],
                            brackets["min_wt"], brackets["max_wt"],
                            None if per_kg else low, None if per_kg else high,
                            store_unit, freq_code,
                            regimen["duration_low"], regimen["duration_high"],
                            1 if regimen["is_prn"] else 0,
                            None, "titration" if (titration or multi_phase) else None,
                            rx_ready, now,
                        ),
                    )
                    n_rules += 1

                # collect ceilings (mg only)
                if store_unit == "mg":
                    route_key = regimen["route"]
                    day_cap = maxes["max_mg_per_day"]
                    if day_cap is None and not per_kg and divisions:
                        day_cap = high * divisions if basis != "per_day" else high
                    if day_cap:
                        ceil_day[route_key] = max(ceil_day.get(route_key, 0.0), day_cap)
                    if maxes["max_mg_per_kg_day"]:
                        ceil_kg_day[route_key] = max(ceil_kg_day.get(route_key, 0.0), maxes["max_mg_per_kg_day"])
                    elif per_kg and divisions:
                        kg_day = high if basis == "per_day" else high * divisions
                        ceil_kg_day[route_key] = max(ceil_kg_day.get(route_key, 0.0), kg_day)

            for route_key in set(ceil_day) | set(ceil_kg_day):
                for did in target_ids:
                    c.execute(
                        """INSERT INTO drug_dose_ceilings
                           (drug_id, population, route, max_mg_per_day, max_mg_per_kg_day, source_name)
                           VALUES (?,?,?,?,?,?)""",
                        (did, population, route_key,
                         ceil_day.get(route_key), ceil_kg_day.get(route_key), SOURCE),
                    )
                    n_ceil += 1

    c.execute(
        "INSERT OR REPLACE INTO build_meta (key, value) VALUES ('epocrates_imported_at', ?)",
        (str(now),),
    )
    c.execute(
        "INSERT OR REPLACE INTO build_meta (key, value) VALUES ('epocrates_rule_count', ?)",
        (str(n_rules),),
    )

    print(f"rules={n_rules} renal={n_renal} hepatic={n_hepatic} notes={n_notes} ceilings={n_ceil}")
    if unparsed_samples:
        print("sample unparsed rows:")
        for s in unparsed_samples[:15]:
            print("  -", s)

    if dry_run:
        c.rollback()
        print("dry run: rolled back")
    else:
        c.commit()
        print("committed")
    c.close()
    e.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epocrates", type=Path, default=None)
    ap.add_argument("--db", type=Path, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    epo = args.epocrates
    if epo is None:
        for cand in (ROOT / "data" / "epocrates-imd" / "RX.sqlite",
                     ROOT / "epocrates-imd" / "RX.sqlite"):
            if cand.exists():
                epo = cand
                break
    if epo is None or not epo.exists():
        sys.exit("epocrates RX.sqlite not found; pass --epocrates PATH")

    db = args.db or DRUG_REF_DB
    if not Path(db).exists():
        sys.exit(f"drug reference DB not found at {db}")

    print(f"epocrates: {epo}")
    print(f"target DB: {db}")
    build(Path(epo), Path(db), dry_run=args.dry_run)


if __name__ == "__main__":
    main()

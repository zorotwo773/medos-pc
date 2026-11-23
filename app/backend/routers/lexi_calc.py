from __future__ import annotations

import re
import json
import sqlite3
from functools import lru_cache

from fastapi import APIRouter, Query

from config import LEXI_CALC_DB, ROOT

router = APIRouter(prefix="/lexi/calc", tags=["lexi-calculators"])


def _norm(value: str) -> str:
    if not isinstance(value, str):
        value = ""
    value = (value or "").lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _split_systems(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value or "").split(",") if v.strip()]


GENERIC_CATEGORIES = {"general", "adult", "international si units"}


def _has(text: str, *terms: str) -> bool:
    return any(term in text for term in terms)


def _clinical_categories(title: str, raw_categories: list[str]) -> list[str]:
    text = _norm(" ".join([title, *raw_categories]))
    cats: list[str] = []

    def add(name: str) -> None:
        if name not in cats:
            cats.append(name)

    if _has(text, "infusion", "infusions", "iv drip", "drip rate", "maintenance infusion") or title.lower() in {
        "amiodarone", "argatroban", "atracurium", "bivalirudin", "cisatracurium", "dexmedetomidine",
        "diltiazem", "dobutamine", "dopamine", "epinephrine", "eptifibatide", "esmolol", "fentanyl",
        "heparin maintenance infusion", "labetalol", "lidocaine", "magnesium sulfate", "milrinone",
    }:
        add("Dosing / Infusions")
    if _has(text, "pharmacokinetic", "level prediction", "aminoglycoside", "amikacin", "gentamicin", "tobramycin", "vancomycin"):
        add("Pharmacokinetics")
    if _has(text, "toxicity", "toxicology", "acetaminophen", "acetylcysteine", "ethanol", "fomepizole", "osmolar gap", "overdose"):
        add("Toxicology")
    if _has(text, "pediatric", "neonatal", "apgar", "cdc", "growth", "head circumference", "height for age", "weight for age", "weight for height", "weight for length", "schwartz"):
        add("Pediatrics / Growth")
    if _has(text, "gestational", "pregnancy", "obstetric", "neonatal", "apgar"):
        add("Obstetrics / Neonatology")
    if _has(text, "stroke", "nih", "glasgow coma", "gcs", "coma", "neurologic", "neurology"):
        add("Neurology")
    if _has(text, "cardiovascular", "cardiac", "heart", "framingham", "acc aha", "cha2ds2", "chads2", "has bled", "qt", "qtc", "diltiazem", "dobutamine", "dopamine", "epinephrine", "esmolol", "labetalol"):
        add("Cardiology")
    if _has(text, "creatinine", "glomerular", "gfr", "renal", "kidney", "fractional excretion", "fena", "urate"):
        add("Renal")
    if _has(text, "anion gap", "delta delta", "henderson", "hasselbach", "hyponatremia", "sodium", "calcium correction", "hypoalbumin", "osmolar"):
        add("Acid-Base / Electrolytes")
    if _has(text, "a a gradient", "pulmonary", "oxygen", "pe ", "pneumonia", "curb", "pulmonary embolism", "epoprostenol"):
        add("Pulmonology")
    if _has(text, "meld", "child pugh", "liver", "hepatic", "glascow blatchford", "glasgow blatchford", "gi bleed", "bilirubin", "albumin"):
        add("Gastroenterology / Hepatology")
    if _has(text, "bleeding", "heparin", "bivalirudin", "argatroban", "dvt", "thrombosis", "4t score", "platelet", "anc", "absolute neutrophil", "neutrophil"):
        add("Hematology / Coagulation")
    if _has(text, "diabetes", "glucose", "insulin", "steroid", "corticosteroid", "thyroid"):
        add("Endocrine / Metabolic")
    if _has(text, "bmi", "body mass", "body surface", "ideal body", "lean body", "adjusted body", "basal energy", "nutrition", "weight"):
        add("Body Metrics / Nutrition")
    if _has(text, "dose", "dosing", "carboplatin", "calvert", "opioid", "morphine milligram", "equianalgesic"):
        add("Dosing / Infusions")
    if _has(text, "conversion", "conversions", "metric", "temperature", "opioid", "corticosteroid"):
        add("Conversions")
    if _has(text, "apache", "sofa", "advanced life support", "emergency", "critical care", "sepsis"):
        add("Critical Care / Emergency")
    if _has(text, "dental", "amoxicillin dental", "azithromycin dental"):
        add("Dental")
    if _has(text, "clostridium", "c difficile", "infection"):
        add("Infectious Disease")
    if _has(text, "fracture", "bone mineral", "bmd"):
        add("Orthopedics / Bone")
    if _has(text, "carboplatin", "oncology"):
        add("Oncology")
    if _has(text, "fluid", "maintenance fluid", "infusate"):
        add("Fluids")

    for cat in raw_categories:
        key = _norm(cat)
        if key in GENERIC_CATEGORIES:
            continue
        mapped = {
            "infusions": "Dosing / Infusions",
            "pharmacokinetics": "Pharmacokinetics",
            "toxicology": "Toxicology",
            "pediatric": "Pediatrics / Growth",
            "dental": "Dental",
            "renal function estimation": "Renal",
            "conversions": "Conversions",
            "emergency drugs": "Critical Care / Emergency",
        }.get(key)
        add(mapped or cat)

    return cats or ["General / Other"]


def _description_for(title: str, categories: list[str]) -> str:
    text = _norm(" ".join([title, *categories]))
    clean_title = title.strip()

    if "nih stroke" in text:
        return "Scores neurologic deficits in suspected acute stroke and helps grade stroke severity."
    if "4t score" in text:
        return "Estimates pretest probability of heparin-induced thrombocytopenia using thrombocytopenia, timing, thrombosis, and alternate causes."
    if "fracture index" in text:
        return "Estimates fracture risk using clinical risk factors, with or without bone mineral density."
    if "framingham" in text and "stroke" in text:
        return "Estimates 10-year stroke risk from Framingham clinical risk factors."
    if "framingham" in text or "cardiovascular risk" in text or "acc aha" in text:
        return "Estimates cardiovascular event risk using demographic and clinical risk factors."
    if "body mass index" in text or "bmi" in text:
        return "Calculates body mass index from height and weight."
    if "body surface area" in text or "bsa" in text:
        return "Calculates body surface area for dosing, physiologic estimates, and oncology calculations."
    if "ideal body weight" in text:
        return "Calculates ideal or dosing body weight for medication dosing and clinical estimates."
    if "lean body weight" in text or "adjusted body weight" in text:
        return "Calculates an adjusted body-size estimate for dosing or nutrition calculations."
    if "basal energy" in text:
        return "Estimates basal energy expenditure for nutrition planning."
    if "anion gap" in text:
        return "Calculates anion gap and related acid-base values to evaluate metabolic acidosis."
    if "henderson" in text or "hasselbach" in text:
        return "Applies acid-base equation relationships for pH, bicarbonate, and carbon dioxide."
    if "calcium correction" in text:
        return "Corrects serum calcium for hypoalbuminemia."
    if "hyponatremia" in text:
        return "Estimates sodium correction or infusate rate for hyponatremia management."
    if "osmolar" in text:
        return "Calculates osmolar gap or related toxicology screening values."
    if "creatinine clearance" in text:
        return "Estimates creatinine clearance for renal function assessment and medication dosing."
    if "glomerular filtration" in text or "gfr" in text:
        return "Estimates glomerular filtration rate using the selected renal function equation."
    if "fractional excretion" in text:
        return "Calculates fractional excretion values to help evaluate kidney handling of electrolytes or solutes."
    if "meld" in text:
        return "Calculates MELD-based liver disease severity and short-term mortality risk."
    if "child pugh" in text:
        return "Classifies cirrhosis severity using Child-Pugh clinical and laboratory criteria."
    if "glasgow blatchford" in text:
        return "Estimates upper gastrointestinal bleeding risk and need for intervention."
    if "clostridium difficile" in text:
        return "Scores Clostridioides difficile disease severity from clinical and laboratory criteria."
    if "glasgow coma" in text:
        return "Scores level of consciousness using eye, verbal, and motor responses."
    if "apgar" in text:
        return "Scores neonatal transition using activity, pulse, grimace, appearance, and respiration."
    if "apache" in text:
        return "Calculates APACHE II critical illness severity and mortality risk."
    if "advanced life support" in text:
        return "Provides weight- or scenario-based emergency medication support for resuscitation."
    if "diabetes risk" in text:
        return "Estimates risk of type 2 diabetes using clinical risk factors."
    if "has bled" in text:
        return "Scores bleeding risk in patients with atrial fibrillation."
    if "cha2ds2" in text or "chads2" in text:
        return "Scores thromboembolic stroke risk in atrial fibrillation."
    if "wells" in text and "dvt" in text:
        return "Estimates pretest probability of deep vein thrombosis."
    if "wells" in text or "pulmonary embolism" in text:
        return "Estimates pretest probability of pulmonary embolism."
    if "a a gradient" in text:
        return "Calculates alveolar-arterial oxygen gradient to evaluate gas exchange."
    if "acetaminophen" in text:
        return "Assesses acetaminophen toxicity risk using dose, concentration, or timing inputs."
    if "acetylcysteine" in text:
        return "Supports acetylcysteine dosing for acetaminophen toxicity treatment."
    if "ethanol" in text:
        return "Estimates ethanol level, clearance, or related toxicology values."
    if "fomepizole" in text:
        return "Supports fomepizole dosing for toxic alcohol exposure."
    if "aminoglycoside" in text or "amikacin" in text or "gentamicin" in text or "tobramycin" in text:
        return "Supports aminoglycoside dosing, interval adjustment, or serum level interpretation."
    if "vancomycin" in text:
        return "Supports vancomycin dosing or serum level interpretation."
    if "heparin" in text:
        return "Supports heparin infusion dosing or anticoagulation adjustment."
    if "argatroban" in text or "bivalirudin" in text or "eptifibatide" in text:
        return "Supports anticoagulant or antiplatelet infusion dosing."
    if "amiodarone" in text or "diltiazem" in text or "esmolol" in text or "labetalol" in text:
        return "Supports cardiovascular medication infusion dosing."
    if "dopamine" in text or "dobutamine" in text or "epinephrine" in text or "milrinone" in text:
        return "Supports vasoactive medication infusion or weight-based dosing."
    if "fentanyl" in text or "morphine" in text or "opioid" in text or "equianalgesic" in text:
        return "Converts or estimates opioid dosing for analgesic equivalence or daily exposure."
    if "corticosteroid" in text:
        return "Converts corticosteroid doses by glucocorticoid or mineralocorticoid effect."
    if "carboplatin" in text or "calvert" in text:
        return "Calculates carboplatin dosing using target AUC and renal function."
    if "cdc" in text or "growth" in text or "percentile" in text:
        return "Calculates pediatric growth percentiles from age, sex, and anthropometric measurements."
    if "gestational age" in text:
        return "Estimates gestational age from pregnancy dating inputs."
    if "maintenance fluid" in text or "fluid calculation" in text:
        return "Calculates maintenance fluid needs, commonly for pediatric or weight-based care."
    if "dose" in text or "dosing" in text:
        return "Calculates a dose or dosing adjustment from patient and medication inputs."
    if "infusion" in text or "drip" in text:
        return "Calculates infusion rate, concentration, or weight-based IV medication delivery."
    if "conversion" in text or "metric" in text:
        return "Converts between clinical units or equivalent medication effects."
    if "dental" in text:
        return "Supports dental antimicrobial or medication dosing."

    primary = categories[0] if categories else "clinical"
    return f"{clean_title} calculator for {primary.lower()} assessment or dosing support."


def _connect() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{LEXI_CALC_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


@lru_cache(maxsize=1)
def _catalog() -> list[dict]:
    if not LEXI_CALC_DB.exists():
        return []

    c = _connect()
    try:
        rows = c.execute(
            """
            SELECT
              d.id,
              d.title,
              c.title AS chapter,
              group_concat(ii.name, '|||') AS categories
            FROM document d
            JOIN chapter c ON c.id = d.chapter_id
            LEFT JOIN indexitem_document iid ON iid.document_id = d.id
            LEFT JOIN indexitem ii ON ii.id = iid.indexitem_id
            WHERE c.title = 'Calculator'
            GROUP BY d.id, d.title, c.title
            ORDER BY lower(d.title)
            """
        ).fetchall()
    finally:
        c.close()

    out: list[dict] = []
    for r in rows:
        title = (r["title"] or "").strip()
        cats = [
            x.strip()
            for x in (r["categories"] or "").split("|||")
            if x.strip() and x.strip().lower() != title.lower()
        ]
        categories = []
        seen: set[str] = set()
        for cat in cats:
            key = cat.lower()
            if key in seen:
                continue
            seen.add(key)
            categories.append(cat)

        clinical_categories = _clinical_categories(title, categories)

        out.append({
            "id": str(r["id"]),
            "title": title,
            "category": clinical_categories[0],
            "categories": clinical_categories,
            "rawCategories": categories,
            "subtitle": "Lexi calculator" + (f" · {clinical_categories[0]}" if clinical_categories else ""),
            "description": _description_for(title, clinical_categories + categories),
            "searchText": _norm(" ".join([title, *categories, *clinical_categories])),
        })
    return out


@lru_cache(maxsize=1)
def _mdcalc_catalog() -> list[dict]:
    catalog_path = ROOT / "data" / "WSA" / "mdcalc-live" / "catalog" / "mdcalc-live-catalog.compact.json"
    if not catalog_path.exists():
        return []
    try:
        raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    out: list[dict] = []
    for item in raw.get("calculators") or []:
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        categories = _split_systems(item.get("systems") or item.get("system") or "MDCalc Live")
        primary = categories[0] if categories else "MDCalc Live"
        subtitle = " · ".join(
            str(v).strip()
            for v in [item.get("disease"), item.get("type"), item.get("slug")]
            if str(v or "").strip()
        )
        description = (
            item.get("description")
            or item.get("mediumDescription")
            or item.get("shortDescription")
            or f"Live MDCalc catalog entry from copied app data."
        )
        search_text = _norm(" ".join([
            title,
            str(item.get("shortTitle") or ""),
            str(item.get("slug") or ""),
            str(item.get("system") or ""),
            str(item.get("disease") or ""),
            str(description or ""),
            " ".join(str(v) for v in item.get("searchAbbreviations") or []),
            " ".join(categories),
        ]))
        out.append({
            "id": f"mdcalc_{item.get('id')}",
            "title": title,
            "category": primary,
            "categories": categories,
            "rawCategories": categories,
            "subtitle": subtitle,
            "description": description,
            "searchText": search_text,
            "inputs": item.get("inputs") or [],
            "formula": item.get("formula") or "",
            "equationLogicText": item.get("equationLogicText") or "",
            "details": item.get("details") or None,
            "references": item.get("references") or None,
            "source": "mdcalc-live",
        })
    return out


def _merged_catalog() -> list[dict]:
    seen: set[str] = set()
    rows: list[dict] = []
    for item in [*_catalog(), *_mdcalc_catalog()]:
        key = _norm(item.get("title", "")) or str(item.get("id") or "")
        if not key or key in seen:
            continue
        seen.add(key)
        rows.append(item)
    return rows


@router.get("/health")
def health():
    lexi_catalog = _catalog() if LEXI_CALC_DB.exists() else []
    mdcalc_catalog = _mdcalc_catalog()
    return {
        "configured": True,
        "exists": LEXI_CALC_DB.exists(),
        "path": str(LEXI_CALC_DB),
        "count": len(_merged_catalog()),
        "lexiCount": len(lexi_catalog),
        "mdcalcCount": len(mdcalc_catalog),
    }


@router.get("/list")
def list_calculators(
    q: str = Query(default="", max_length=120),
    category: str = Query(default="", max_length=80),
    limit: int = Query(default=250, ge=1, le=1500),
):
    query = _norm(q)
    category_norm = _norm(category)
    rows = _merged_catalog()
    if category_norm:
        rows = [
            r for r in rows
            if any(_norm(cat) == category_norm for cat in r.get("categories", []))
        ]
    if query:
        query_tokens = query.split()
        rows = [
            r for r in rows
            if all(token in r["searchText"] for token in query_tokens)
        ]
    return {
        "configured": True,
        "exists": LEXI_CALC_DB.exists(),
        "source": "lexi+mdcalc-live",
        "count": len(rows),
        "results": rows[:limit],
    }


@router.get("/categories")
def categories():
    counts: dict[str, int] = {}
    for item in _merged_catalog():
        for cat in item.get("categories", []) or ["Lexi Calculator"]:
            counts[cat] = counts.get(cat, 0) + 1
    return {
        "categories": [
            {"name": name, "count": count}
            for name, count in sorted(counts.items(), key=lambda x: (-x[1], x[0].lower()))
        ]
    }

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = ROOT / "app"
DEFAULT_SOURCE = ROOT / "data" / "Lexi" / "Cliniccons"
DEFAULT_JSON = APP_ROOT / "public" / "cliniccons_disease_database.json"
DEFAULT_SQLITE = ROOT / "data" / "cliniccons_disease_reference.sqlite"
DEFAULT_PUBLIC_IMG = APP_ROOT / "public" / "cliniccons" / "img"

CLINICAL_CHAPTER_ID = 4281
ALGORITHM_CHAPTER_ID = 33582

STOPWORDS = {
    "a",
    "acute",
    "algorithm",
    "and",
    "assessment",
    "chronic",
    "diagnosis",
    "diagnostic",
    "differential",
    "disease",
    "evaluation",
    "initial",
    "management",
    "of",
    "patient",
    "patients",
    "the",
    "therapy",
    "treatment",
    "with",
}

HEADINGS = [
    "DESCRIPTION",
    "EPIDEMIOLOGY",
    "ETIOLOGY",
    "COMMONLY ASSOCIATED CONDITIONS",
    "RISK FACTORS",
    "GENERAL PREVENTION",
    "DIAGNOSIS",
    "HISTORY",
    "PHYSICAL EXAM",
    "DIFFERENTIAL DIAGNOSIS",
    "DIAGNOSTIC TESTS",
    "TREATMENT",
    "MEDICATION",
    "SURGERY",
    "ADMISSION",
    "ONGOING CARE",
    "FOLLOW-UP",
    "PATIENT EDUCATION",
    "PROGNOSIS",
    "COMPLICATIONS",
    "REFERENCES",
]

ORGAN_RULES: list[tuple[str, str, list[str]]] = [
    ("Heart", "Cardiovascular", ["heart", "cardiac", "coronary", "myocard", "angina", "arrhythm", "atrial", "ventricular", "pericard", "endocard", "cardiomy", "hypertension", "tachycard", "bradycard", "syncope", "heart failure", "chf"]),
    ("Blood Vessels", "Cardiovascular", ["aorta", "aneurysm", "artery", "arterial", "venous", "vein", "vascular", "embolism", "thrombosis", "thrombo", "dvt", "ischemia", "carotid", "pulse"]),
    ("Lung", "Respiratory", ["lung", "pulmonary", "pneumonia", "asthma", "copd", "bronch", "respiratory", "pleural", "pleura", "dyspnea", "hemoptysis", "cough", "hypoxia", "tuberculosis"]),
    ("Kidney", "Renal", ["kidney", "renal", "nephro", "azotemia", "proteinuria", "hematuria", "urinalysis", "urinary tract", "aki", "arf", "glomerul"]),
    ("Liver", "Hepatobiliary", ["liver", "hepatic", "hepatitis", "cirrhosis", "portal hypertension", "jaundice", "biliary", "gallbladder", "cholang", "cholecyst"]),
    ("Pancreas", "Endocrine", ["pancreas", "pancreatic", "diabetes", "diabetic", "insulin", "hyperglycemia", "hypoglycemia", "ketoacidosis"]),
    ("Thyroid", "Endocrine", ["thyroid", "thyrotox", "hypothyroid", "hyperthyroid", "parathyroid"]),
    ("Adrenal", "Endocrine", ["adrenal", "cortisol", "aldoster", "cushing", "pheochromocytoma"]),
    ("Brain", "Neurologic", ["brain", "stroke", "cerebral", "cerebrovascular", "seizure", "headache", "migraine", "dementia", "delirium", "meningitis", "encephal", "ataxia", "vertigo", "syncope"]),
    ("Nerves", "Neurologic", ["nerve", "neuropathy", "neuralgia", "radicul", "spinal cord", "plexus", "carpal tunnel"]),
    ("Eye", "Ophthalmology", ["eye", "ocular", "vision", "retina", "cornea", "cataract", "glaucoma", "photophobia", "diplopia"]),
    ("ENT", "ENT", ["ear", "hearing", "otitis", "sinus", "nasal", "pharyng", "tonsil", "laryng", "vertigo", "epistaxis"]),
    ("Skin", "Dermatologic", ["skin", "dermat", "rash", "acne", "eczema", "psoriasis", "urticaria", "alopecia", "cellulitis", "lesion", "rosacea"]),
    ("Blood", "Hematologic", ["anemia", "hemoglobin", "platelet", "thrombocytopenia", "leukemia", "lymphoma", "coagulation", "bleeding", "neutropenia", "sickle"]),
    ("Bone", "Musculoskeletal", ["bone", "fracture", "arthritis", "osteoporosis", "osteomyelitis", "joint", "gout", "back pain", "scoliosis"]),
    ("Muscle", "Musculoskeletal", ["muscle", "myopathy", "myositis", "rhabdomyolysis", "sprain", "strain", "tendon"]),
    ("Intestine", "Gastrointestinal", ["intestinal", "intestine", "colon", "colitis", "crohn", "ulcerative colitis", "diverticul", "appendicitis", "diarrhea", "constipation", "rectal", "hematochezia"]),
    ("Stomach", "Gastrointestinal", ["stomach", "gastric", "gastro", "nausea", "vomiting", "peptic", "abdominal pain", "dyspepsia"]),
    ("Esophagus", "Gastrointestinal", ["esophag", "gerd", "dysphagia"]),
    ("Uterus", "Reproductive", ["uterine", "uterus", "pregnancy", "pregnant", "ovary", "ovarian", "vaginal", "cervix", "amenorrhea", "menstrual", "menopause", "pelvic inflammatory"]),
    ("Bladder", "Genitourinary", ["bladder", "prostate", "urinary", "urethra", "testicular", "erectile", "scrotal", "kidney stone"]),
    ("Psychiatric", "Psychiatry", ["anxiety", "depression", "psychosis", "bipolar", "suicide", "substance use", "withdrawal", "eating disorder", "panic"]),
    ("Immune", "Allergy/Immunology", ["allergy", "allergic", "anaphylaxis", "autoimmune", "immunodeficiency", "lupus", "rheumatoid", "vasculitis"]),
    ("Toxicology", "Toxicology", ["poison", "toxicity", "overdose", "envenomation", "carbon monoxide", "lead", "mercury"]),
    ("Infectious Disease", "Infectious Disease", ["infection", "fever", "sepsis", "bacterial", "viral", "fungal", "parasite", "influenza", "hiv", "salmonella", "lyme"]),
]

MODEL_BY_SYSTEM = {
    "Cardiovascular": "cardiovascular.glb",
    "Respiratory": "visceral.glb",
    "Renal": "visceral.glb",
    "Hepatobiliary": "visceral.glb",
    "Endocrine": "visceral.glb",
    "Neurologic": "nervous.glb",
    "Ophthalmology": "nervous.glb",
    "ENT": "visceral.glb",
    "Dermatologic": "visceral.glb",
    "Hematologic": "lymphoid.glb",
    "Musculoskeletal": "skeletal.glb",
    "Gastrointestinal": "visceral.glb",
    "Reproductive": "visceral.glb",
    "Genitourinary": "visceral.glb",
    "Psychiatry": "nervous.glb",
    "Allergy/Immunology": "lymphoid.glb",
    "Toxicology": "visceral.glb",
    "Infectious Disease": "lymphoid.glb",
    "General": "visceral.glb",
}


def connect(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def clean_title(value: str) -> str:
    value = re.sub(r"\([^)]*\)", " ", value or "")
    value = re.sub(r"\b(?:algorithm|diagnosis|diagnostic|treatment|differential|management|evaluation)\b", " ", value, flags=re.I)
    value = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return normalize_spaces(value)


def title_tokens(value: str) -> list[str]:
    return [t for t in clean_title(value).split() if t not in STOPWORDS and len(t) > 1]


def token_prefix_score(left: str, right: str) -> float:
    lt = title_tokens(left)
    rt = title_tokens(right)
    if not lt or not rt:
        return 0.0
    matches = 0
    for token in lt:
        for other in rt:
            if token == other or (len(token) >= 4 and other.startswith(token)) or (len(other) >= 4 and token.startswith(other)):
                matches += 1
                break
    return matches / max(len(lt), len(rt))


def title_similarity(left: str, right: str) -> float:
    a = clean_title(left)
    b = clean_title(right)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return max(0.82, min(len(a), len(b)) / max(len(a), len(b)))
    return max(SequenceMatcher(None, a, b).ratio(), token_prefix_score(left, right))


def section(content: str, heading: str) -> str:
    text = f" {normalize_spaces(content)} "
    start = text.find(f" {heading} ")
    if start < 0:
        return ""
    start += len(heading) + 2
    end = len(text)
    for candidate in HEADINGS:
        if candidate == heading:
            continue
        pos = text.find(f" {candidate} ", start)
        if pos >= 0:
            end = min(end, pos)
    return normalize_spaces(text[start:end])


def concise(value: str, max_len: int = 360) -> str:
    value = normalize_spaces(value)
    if len(value) <= max_len:
        return value
    cut = value[:max_len].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:") + "..."


def clinical_points(content: str, title: str) -> list[str]:
    points: list[str] = []
    for heading in ["DESCRIPTION", "ETIOLOGY", "DIAGNOSIS", "COMPLICATIONS"]:
        text = section(content, heading)
        if text:
            points.append(concise(text))
    if not points and content:
        without_title = normalize_spaces(content).replace(title, "", 1).strip()
        points.append(concise(without_title))
    if not points:
        points.append(f"Clinical condition entry from Lexicomp 5-Minute Clinical Consult: {title}.")
    return points[:4]


def treatment_points(content: str) -> list[str]:
    points = []
    for heading in ["TREATMENT", "MEDICATION", "SURGERY", "ONGOING CARE", "PATIENT EDUCATION"]:
        text = section(content, heading)
        if text:
            points.append(concise(text))
    return points[:4]


def classify_organ(title: str, content: str) -> tuple[str, str, str]:
    haystack = f"{title.lower()} {title.lower()} {title.lower()} {content[:2500].lower()}"
    best: tuple[int, str, str] = (0, "General", "General")
    for organ, system, keywords in ORGAN_RULES:
        score = 0
        for keyword in keywords:
            if keyword in haystack:
                score += 4 if keyword in title.lower() else 1
        if score > best[0]:
            best = (score, organ, system)
    organ, system = best[1], best[2]
    return organ, system, MODEL_BY_SYSTEM.get(system, "visceral.glb")


def parse_icd(name: str) -> dict[str, str]:
    match = re.match(r"^\s*([A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?|[0-9]{3}(?:\.[0-9A-Z]{1,4})?)\s+(.+)$", name)
    if match:
        code = match.group(1)
        code_system = "ICD-10-CM" if re.match(r"^[A-TV-Z]", code) else "ICD-9-CM"
        return {"code": code, "description": normalize_spaces(match.group(2)), "system": code_system}
    return {"code": "", "description": normalize_spaces(name), "system": "ICD"}


def image_title(filename: str) -> str:
    stem = Path(filename).stem
    stem = re.sub(r"\d{3,}$", "", stem)
    stem = stem.replace("_", " ")
    return normalize_spaces(stem)


def copy_images(source_img: Path, public_img: Path) -> list[dict[str, str]]:
    public_img.mkdir(parents=True, exist_ok=True)
    images = []
    for image in sorted(source_img.glob("*")):
        if not image.is_file() or image.suffix.lower() not in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
            continue
        target = public_img / image.name
        if not target.exists() or target.stat().st_size != image.stat().st_size:
            shutil.copy2(image, target)
        images.append({
            "filename": image.name,
            "title": image_title(image.name),
            "url": f"/cliniccons/img/{image.name}",
        })
    return images


def best_images_for_title(title: str, images: list[dict[str, str]], limit: int = 3) -> list[dict[str, str]]:
    scored = []
    for image in images:
        # Numeric-suffixed files are usually thumbnails or continuation panels.
        suffix_penalty = 0.08 if re.search(r"\d{3,}(?=\.)", image["filename"]) else 0.0
        score = title_similarity(title, image["title"]) - suffix_penalty
        if score >= 0.58:
            scored.append((score, image))
    scored.sort(key=lambda item: (-item[0], item[1]["filename"]))
    return [
        {"filename": image["filename"], "url": image["url"], "match_score": round(score, 3)}
        for score, image in scored[:limit]
    ]


def build(source: Path, output_json: Path, output_sqlite: Path, public_img: Path) -> dict[str, int]:
    main_db = source / "274_clincons.sqlite"
    fts_db = source / "fcontentsearch.db"
    image_dir = source / "img"
    images = copy_images(image_dir, public_img)

    con = connect(main_db)
    fts = connect(fts_db)
    try:
        docs = {
            row["id"]: dict(row)
            for row in con.execute("SELECT id, chapter_id, title FROM document ORDER BY lower(title), id")
        }
        fts_rows = {
            int(row["c2URL"]): dict(row)
            for row in fts.execute("SELECT c0Text, c1SubText, c2URL, c3content FROM Search_content")
            if str(row["c2URL"]).isdigit()
        }

        aliases: dict[int, list[str]] = defaultdict(list)
        icds: dict[int, list[dict[str, str]]] = defaultdict(list)
        for row in con.execute(
            """
            SELECT ii.indextype_id, ii.name, iid.document_id
            FROM indexitem ii
            JOIN indexitem_document iid ON iid.indexitem_id = ii.id
            ORDER BY lower(ii.name)
            """
        ):
            doc_id = int(row["document_id"])
            name = normalize_spaces(row["name"])
            if row["indextype_id"] == 1:
                if name and name not in aliases[doc_id] and name != docs.get(doc_id, {}).get("title"):
                    aliases[doc_id].append(name)
            elif row["indextype_id"] == 2:
                parsed = parse_icd(name)
                if parsed not in icds[doc_id]:
                    icds[doc_id].append(parsed)

        algorithms = []
        for doc_id, doc in docs.items():
            if int(doc["chapter_id"]) != ALGORITHM_CHAPTER_ID:
                continue
            content = normalize_spaces(fts_rows.get(doc_id, {}).get("c3content", ""))
            image_matches = best_images_for_title(doc["title"], images, limit=4)
            algorithms.append({
                "document_id": doc_id,
                "title": doc["title"],
                "aliases": aliases.get(doc_id, []),
                "content_preview": concise(content, 500) if content else "",
                "images": image_matches,
            })

        diseases = []
        for doc_id, doc in docs.items():
            if int(doc["chapter_id"]) != CLINICAL_CHAPTER_ID:
                continue
            content = normalize_spaces(fts_rows.get(doc_id, {}).get("c3content", ""))
            primary_organ, primary_system, anatomy_model = classify_organ(doc["title"], content)

            refs = []
            for algorithm in algorithms:
                score = max(
                    title_similarity(doc["title"], algorithm["title"]),
                    max((title_similarity(alias, algorithm["title"]) for alias in aliases.get(doc_id, [])), default=0.0),
                )
                if score >= 0.72:
                    refs.append({
                        "document_id": algorithm["document_id"],
                        "title": algorithm["title"],
                        "images": algorithm["images"],
                        "match_score": round(score, 3),
                    })
            for image in best_images_for_title(doc["title"], images, limit=2):
                if all(image["filename"] not in {img["filename"] for ref in refs for img in ref.get("images", [])} for ref in refs):
                    refs.append({
                        "document_id": None,
                        "title": f"{doc['title']} algorithm image",
                        "images": [image],
                        "match_score": image["match_score"],
                    })
            refs.sort(key=lambda item: (-item["match_score"], item["title"]))

            points = clinical_points(content, doc["title"])
            treatments = treatment_points(content)
            diseases.append({
                "disease_name": doc["title"],
                "document_id": doc_id,
                "source": "Lexicomp 5-Minute Clinical Consult",
                "primary_organ": primary_organ,
                "primary_system": primary_system,
                "anatomy_model": anatomy_model,
                "secondary_organs_involved": [],
                "clinical_synthesis": points,
                "treatment_pearls": treatments,
                "icd_codes": icds.get(doc_id, []),
                "aliases": aliases.get(doc_id, []),
                "algorithm_refs": refs[:8],
                "content_preview": concise(content, 900) if content else "",
                "citation": {
                    "chapter_title": "Lexicomp 5-Minute Clinical Consult",
                    "page_number": doc_id,
                },
            })

        diseases.sort(key=lambda item: item["disease_name"].lower())
        algorithms.sort(key=lambda item: item["title"].lower())

        payload = {
            "metadata": {
                "name": "Cliniccons Disease Reference",
                "source": str(source),
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "clinical_documents": len(diseases),
                "algorithm_documents": len(algorithms),
                "image_assets": len(images),
                "primary_tag_policy": "one primary organ/system tag per disease; secondary tags intentionally empty",
            },
            "diseases": diseases,
            "algorithms": algorithms,
        }
        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        write_sqlite(output_sqlite, payload)
        return {
            "diseases": len(diseases),
            "algorithms": len(algorithms),
            "images": len(images),
            "icd_mappings": sum(len(item["icd_codes"]) for item in diseases),
            "algorithm_links": sum(len(item["algorithm_refs"]) for item in diseases),
        }
    finally:
        con.close()
        fts.close()


def write_sqlite(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    try:
        con.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE diseases (
              document_id INTEGER PRIMARY KEY,
              disease_name TEXT NOT NULL,
              source TEXT NOT NULL,
              primary_organ TEXT NOT NULL,
              primary_system TEXT NOT NULL,
              anatomy_model TEXT NOT NULL,
              content_preview TEXT NOT NULL,
              clinical_synthesis_json TEXT NOT NULL,
              treatment_pearls_json TEXT NOT NULL
            );
            CREATE TABLE aliases (
              document_id INTEGER NOT NULL,
              alias TEXT NOT NULL,
              PRIMARY KEY (document_id, alias)
            );
            CREATE TABLE icd_codes (
              document_id INTEGER NOT NULL,
              code TEXT NOT NULL,
              description TEXT NOT NULL,
              system TEXT NOT NULL
            );
            CREATE TABLE algorithms (
              document_id INTEGER PRIMARY KEY,
              title TEXT NOT NULL,
              content_preview TEXT NOT NULL,
              images_json TEXT NOT NULL
            );
            CREATE TABLE disease_algorithms (
              disease_document_id INTEGER NOT NULL,
              algorithm_document_id INTEGER,
              title TEXT NOT NULL,
              match_score REAL NOT NULL,
              images_json TEXT NOT NULL
            );
            CREATE INDEX idx_diseases_primary_organ ON diseases(primary_organ);
            CREATE INDEX idx_diseases_primary_system ON diseases(primary_system);
            CREATE INDEX idx_icd_code ON icd_codes(code);
            """
        )
        for disease in payload["diseases"]:
            con.execute(
                """
                INSERT INTO diseases
                (document_id, disease_name, source, primary_organ, primary_system, anatomy_model, content_preview, clinical_synthesis_json, treatment_pearls_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    disease["document_id"],
                    disease["disease_name"],
                    disease["source"],
                    disease["primary_organ"],
                    disease["primary_system"],
                    disease["anatomy_model"],
                    disease["content_preview"],
                    json.dumps(disease["clinical_synthesis"], ensure_ascii=False),
                    json.dumps(disease["treatment_pearls"], ensure_ascii=False),
                ),
            )
            con.executemany(
                "INSERT OR IGNORE INTO aliases(document_id, alias) VALUES (?, ?)",
                [(disease["document_id"], alias) for alias in disease["aliases"]],
            )
            con.executemany(
                "INSERT INTO icd_codes(document_id, code, description, system) VALUES (?, ?, ?, ?)",
                [(disease["document_id"], icd["code"], icd["description"], icd["system"]) for icd in disease["icd_codes"]],
            )
            con.executemany(
                "INSERT INTO disease_algorithms(disease_document_id, algorithm_document_id, title, match_score, images_json) VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        disease["document_id"],
                        ref["document_id"],
                        ref["title"],
                        ref["match_score"],
                        json.dumps(ref["images"], ensure_ascii=False),
                    )
                    for ref in disease["algorithm_refs"]
                ],
            )
        for algorithm in payload["algorithms"]:
            con.execute(
                "INSERT INTO algorithms(document_id, title, content_preview, images_json) VALUES (?, ?, ?, ?)",
                (
                    algorithm["document_id"],
                    algorithm["title"],
                    algorithm["content_preview"],
                    json.dumps(algorithm["images"], ensure_ascii=False),
                ),
            )
        con.commit()
    finally:
        con.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the Cliniccons disease reference database.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--sqlite", type=Path, default=DEFAULT_SQLITE)
    parser.add_argument("--public-img", type=Path, default=DEFAULT_PUBLIC_IMG)
    args = parser.parse_args()
    summary = build(args.source, args.json, args.sqlite, args.public_img)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

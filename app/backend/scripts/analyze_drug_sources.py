"""
analyze_drug_sources.py — Phase A

Probes Micromedex and UpToDate for 5 common drugs and compares data quality
per clinical section.  Prints a comparison table and writes drug_source_priority.json.

Usage:
    python scripts/analyze_drug_sources.py
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Optional

MICROMEDEX_DB = Path("d:/MedOS/data/Lexi/mm/imdiMDX_DrugRef.sqlite")
UTD_ASSET_DB  = Path("d:/MedOS/data/uptodate/utdasset_decrypted.sqlite")
UTD_INDEX_DB  = Path("d:/MedOS/data/uptodate/unidex.en.sqlite")

# Sub-section IDs in Micromedex
MM_SECTIONS = {
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
    "drug_class":                 19,
    "regulatory_status":          20,
    "mechanism":                  22,
    "absorption":                 23,
    "distribution":               24,
    "metabolism":                 25,
    "excretion":                  26,
    "half_life":                  27,
    "administration":             28,
    "monitoring":                 29,
    "how_supplied":               30,
}

UTD_HEADING_MAP = {
    "ALERT: US Boxed Warning":             "black_box_warning",
    "Brand Names: US":                     "brand_names_us",
    "Brand Names: Canada":                 "brand_names_ca",
    "Pharmacologic Category":              "drug_class_utd",
    "Dosing: Adult":                       "adult_dosing",
    "Dosing: Kidney Impairment: Adult":    "renal_dosing",
    "Dosing: Liver Impairment: Adult":     "hepatic_dosing",
    "Dosing: Older Adult":                 "adult_dosing_elderly",
    "Dosing: Pediatric":                   "pediatric_dosing",
    "Dosing: Kidney Impairment: Pediatric": "renal_dosing_pediatric",
    "Adverse Reactions":                   "adverse_effects",
    "Contraindications":                   "contraindications",
    "Warnings/Precautions":                "precautions",
    "Dosage Forms: US":                    "how_supplied",
}


def html_to_text(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html or "")
    for ent, rep in [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " "), ("&#160;", " ")]:
        text = text.replace(ent, rep)
    return re.sub(r"\s+", " ", text).strip()


def open_ro(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def find_mm_drug_id(conn: sqlite3.Connection, name: str) -> Optional[int]:
    row = conn.execute(
        "SELECT drug_id FROM drug_generic_name WHERE lower(title) = lower(?)",
        (name,),
    ).fetchone()
    if row:
        return int(row[0])
    row = conn.execute(
        "SELECT drug_id FROM drug_generic_name WHERE lower(title) LIKE lower(?)",
        (f"{name}%",),
    ).fetchone()
    return int(row[0]) if row else None


def analyze_mm(conn: sqlite3.Connection, drug_id: int) -> dict:
    results = {}
    for section_name, sub_id in MM_SECTIONS.items():
        row = conn.execute(
            "SELECT monograph FROM drug_mono WHERE drug_id = ? AND sub_section_id = ?",
            (drug_id, sub_id),
        ).fetchone()
        html = row[0] if row else ""
        text = html_to_text(html)
        results[section_name] = {
            "present": len(text) > 10,
            "length":  len(text),
            "sample":  text[:120] if text else "",
        }
    return results


def find_utd_topic_id(index_conn: sqlite3.Connection, name: str) -> Optional[int]:
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

    names = [name.strip()]
    base = re.sub(
        r"\s+(hydrochloride|sulfate|sodium|potassium|acetate|mesylate|maleate|tartrate|succinate|"
        r"fumarate|phosphate|nitrate|chloride|bromide|calcium|magnesium|hcl)$",
        "",
        name,
        flags=re.IGNORECASE,
    ).strip()
    if base and base.lower() != name.strip().lower():
        names.append(base)

    for candidate in names:
        row = index_conn.execute(
            f"SELECT {id_col} FROM {table} WHERE lower(title) = lower(?){subtype_filter}",
            (f"{candidate}: Drug information",),
        ).fetchone()
        if row:
            return int(row[0])
        row = index_conn.execute(
            f"SELECT {id_col} FROM {table} WHERE lower(title) LIKE lower(?){subtype_filter} LIMIT 1",
            (f"{candidate}%drug information%",),
        ).fetchone()
        if row:
            return int(row[0])
    return None


def extract_utd_sections(body_html: str) -> dict[str, str]:
    """Split UTD bodyHtml on drugH1 boundaries."""
    pattern = re.compile(r'<[^>]+class="drugH1"[^>]*>(.*?)</[^>]+>', re.DOTALL)
    sections: dict[str, str] = {}
    matches = list(pattern.finditer(body_html))
    for i, m in enumerate(matches):
        heading_text = html_to_text(m.group(1)).strip()
        section_key = UTD_HEADING_MAP.get(heading_text, f"utd:{heading_text[:40]}")
        start = m.end()
        end   = matches[i + 1].start() if i + 1 < len(matches) else len(body_html)
        sections[section_key] = body_html[start:end]
    return sections


def analyze_utd(asset_conn: sqlite3.Connection, topic_id: int) -> dict:
    row = asset_conn.execute(
        "SELECT content FROM topic_content WHERE id = ?",
        (topic_id,),
    ).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row[0])
    except Exception:
        return {}
    body_html = data.get("bodyHtml") or data.get("body_html") or ""
    if not body_html:
        # Try nested structure
        for key in ("topicContent", "content"):
            if isinstance(data.get(key), dict):
                body_html = data[key].get("bodyHtml", "")
                if body_html:
                    break
    sections = extract_utd_sections(body_html)
    return {k: {"present": True, "length": len(html_to_text(v)), "sample": html_to_text(v)[:120]}
            for k, v in sections.items()}


def compare(mm_data: dict, utd_data: dict) -> list[dict]:
    all_keys = sorted(set(list(mm_data.keys()) + list(utd_data.keys())))
    rows = []
    for key in all_keys:
        mm = mm_data.get(key, {})
        utd = utd_data.get(key, {})
        mm_len = mm.get("length", 0)
        utd_len = utd.get("length", 0)
        if mm_len > 20 and utd_len > 20:
            winner = "UTD" if utd_len > mm_len * 1.2 else ("MM" if mm_len > utd_len * 1.2 else "TIE")
        elif mm_len > 20:
            winner = "MM"
        elif utd_len > 20:
            winner = "UTD"
        else:
            winner = "MISSING"
        rows.append({"section": key, "mm_chars": mm_len, "utd_chars": utd_len, "winner": winner})
    return rows


def main():
    test_drugs = [
        "Lisinopril",
        "Warfarin Sodium",
        "Metformin Hydrochloride",
        "Vancomycin Hydrochloride",
        "Morphine Sulfate",
    ]

    if not MICROMEDEX_DB.exists():
        print(f"ERROR: Micromedex DB not found at {MICROMEDEX_DB}")
        sys.exit(1)
    if not UTD_INDEX_DB.exists():
        print(f"ERROR: UTD Index DB not found at {UTD_INDEX_DB}")
        sys.exit(1)

    mm_conn   = open_ro(MICROMEDEX_DB)
    utd_idx   = open_ro(UTD_INDEX_DB)
    utd_asset = open_ro(UTD_ASSET_DB) if UTD_ASSET_DB.exists() else None

    priority_matrix: dict[str, dict] = {}
    summary_rows: list[dict] = []

    print(f"\n{'='*70}")
    print("  MedOS Drug Source Quality Analysis")
    print(f"{'='*70}\n")

    for drug_name in test_drugs:
        print(f"\n── {drug_name} ──")

        mm_id = find_mm_drug_id(mm_conn, drug_name)
        utd_id = find_utd_topic_id(utd_idx, drug_name)

        print(f"  MM drug_id: {mm_id}  |  UTD topic_id: {utd_id}")

        mm_data  = analyze_mm(mm_conn, mm_id)  if mm_id  else {}
        utd_data = analyze_utd(utd_asset, utd_id) if (utd_id and utd_asset) else {}

        rows = compare(mm_data, utd_data)
        summary_rows.extend([{**r, "drug": drug_name} for r in rows])

        print(f"  {'Section':<35} {'MM':>6} {'UTD':>7}  {'Winner'}")
        print(f"  {'-'*60}")
        for r in rows:
            print(f"  {r['section']:<35} {r['mm_chars']:>6} {r['utd_chars']:>7}  {r['winner']}")

        # Accumulate winner votes per section
        for r in rows:
            key = r["section"]
            if key not in priority_matrix:
                priority_matrix[key] = {"MM": 0, "UTD": 0, "TIE": 0, "MISSING": 0}
            priority_matrix[key][r["winner"]] += 1

    # Final priority recommendations
    print(f"\n{'='*70}")
    print("  Final Source Priority Matrix (across all test drugs)")
    print(f"{'='*70}\n")
    print(f"  {'Section':<35} {'MM wins':>8} {'UTD wins':>9}  {'Recommended'}")
    print(f"  {'-'*65}")

    final = {}
    for section, votes in sorted(priority_matrix.items()):
        mm_v   = votes["MM"]
        utd_v  = votes["UTD"]
        rec    = "utd" if utd_v > mm_v else ("mm" if mm_v > utd_v else "tie")
        final[section] = {"mm_wins": mm_v, "utd_wins": utd_v, "recommended": rec}
        print(f"  {section:<35} {mm_v:>8} {utd_v:>9}  {rec.upper()}")

    # Write JSON
    out_path = Path(__file__).parent / "drug_source_priority.json"
    out_path.write_text(json.dumps({
        "analyzed_at":   "2026-04-29",
        "drugs_tested":  len(test_drugs),
        "section_priority": final,
    }, indent=2))
    print(f"\n  Written: {out_path}\n")

    mm_conn.close()
    utd_idx.close()
    if utd_asset:
        utd_asset.close()


if __name__ == "__main__":
    main()

"""
UTD Corpus Extractor v2.0 - Ground Truth Edition
==================================================
Driven by utd_index.sqlite (master catalog) for reliable metadata.
Extracts bodyHtml from utdasset_decrypted.sqlite via BeautifulSoup.
Builds BM25-ready plain text from fcontentsearch.db as a parallel output.

Usage:
    python utd_extract_corpus_v2.py                     # full run
    python utd_extract_corpus_v2.py --sample 20         # test 20 topics
    python utd_extract_corpus_v2.py --types medical     # only medical_review
    python utd_extract_corpus_v2.py --resume            # resume from checkpoint
"""

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path

# ─── Configuration ─────────────────────────────────────────────────────────
BASE = Path("D:/ML/data/net.imedicaldoctor.imd/files/imduptodate2026-3-5")

DB_INDEX     = BASE / "utd_index.sqlite"          # master catalog (4.3 MB)
DB_CONTENT   = BASE / "utdasset_decrypted.sqlite" # full content (7.8 GB)
DB_FTS       = BASE / "fcontentsearch.db"         # pre-stripped text (838 MB)
DB_TOC       = BASE / "utdtoc.db"                 # specialty hierarchy

OUT_CORPUS   = Path("D:/ML/data/utd_corpus_v2.jsonl")
OUT_BM25     = Path("D:/ML/data/utd_bm25_texts.jsonl")
CHECKPOINT   = Path("D:/ML/data/utd_extract_v2_ckpt.json")
PROGRESS     = Path("D:/ML/data/utd_extract_v2_progress.json")
PAUSE_SIGNAL = Path("D:/ML/data/PIPELINE_PAUSE")  # create this file to pause
PAUSE_CHECK  = 100   # check pause every N topics

# Topic types to include. Remove 'drug_patient' to skip patient-education content.
INCLUDE_SUBTYPES = {"medical_review", "drug_general", "drug_patient"}
MIN_BODY_LEN = 2000  # skip stub articles shorter than this (chars)

# ─── Specialty ID → Name map (from TOC inspection) ─────────────────────────
# Built from utd_index.sqlite specialty_id values
SPECIALTY_MAP = {
    "1":  "Allergy and Immunology",
    "2":  "Cardiovascular Medicine",
    "3":  "Dermatology",
    "4":  "Emergency Medicine",
    "5":  "Endocrinology and Diabetes",
    "6":  "Family Medicine",
    "7":  "Gastroenterology and Hepatology",
    "8":  "Hematology",
    "9":  "Infectious Diseases",
    "10": "Nephrology and Hypertension",
    "11": "Neurology",
    "12": "Obstetrics and Gynecology",
    "13": "Oncology",
    "14": "Palliative Care",
    "15": "Pediatrics",
    "16": "Primary Care and General Medicine",
    "17": "Psychiatry and Behavioral Health",
    "18": "Pharmacology / Drug Information",
    "19": "Pulmonary and Critical Care Medicine",
    "20": "Surgery",
    "21": "Rheumatology",
    "22": "Urology",
    "23": "Hospital Medicine",
    "24": "Geriatrics",
    "25": "Sports Medicine",
}


# ─── HTML Parser ────────────────────────────────────────────────────────────
try:
    from bs4 import BeautifulSoup, Tag
    BS4_OK = True
except ImportError:
    BS4_OK = False
    print("[WARN] BeautifulSoup not found. Run: pip install beautifulsoup4 lxml")


def _tag_text(tag) -> str:
    """Get clean text from a BS4 tag."""
    return re.sub(r"\s+", " ", tag.get_text(" ", strip=True)).strip()


def parse_body_html(html: str, title: str) -> list[dict]:
    """
    Parse UpToDate bodyHtml into structured sections.
    
    Returns list of: {"heading": str, "text": str, "level": int}
    Level: 1=h3 (major), 2=h4 (sub), 3=h5 (sub-sub)
    """
    if not html or not BS4_OK:
        return []

    soup = BeautifulSoup(html, "lxml")

    # Remove non-content noise
    for tag in soup.find_all(["script", "style"]):
        tag.decompose()
    for cls in ["citationNumber", "visibleNever", "visiblePrintOnly",
                "pagenum", "collapsible-date"]:
        for tag in soup.find_all(class_=cls):
            tag.decompose()

    sections = []
    current_heading = "Introduction"
    current_level = 1
    current_lines = []
    current_grade = None  # Evidence grade (A, B, C, 1A, 2B etc.)

    def flush():
        nonlocal current_grade
        text = " ".join(current_lines).strip()
        text = re.sub(r"\s+", " ", text)
        if len(text) > 80:
            sec = {
                "heading": current_heading,
                "text": text,
                "level": current_level,
            }
            if current_grade:
                sec["evidence_grade"] = current_grade
            sections.append(sec)
        current_lines.clear()
        current_grade = None

    # Walk all elements in document order
    for element in soup.find_all(True):
        cls_list = element.get("class", [])
        cls = " ".join(cls_list)

        # ── Section headers ──────────────────────────────────────────────
        if "h3" in cls_list or "drugH1" in cls_list:
            flush()
            current_heading = _tag_text(element)
            current_level = 1
            continue
        if "h4" in cls_list or "drugH2" in cls_list:
            flush()
            current_heading = _tag_text(element)
            current_level = 2
            continue
        if "h5" in cls_list or "drugH3" in cls_list:
            flush()
            current_heading = _tag_text(element)
            current_level = 3
            continue

        # ── Evidence grade (clinical gold!) ──────────────────────────────
        if "grade" in cls_list:
            grade_text = _tag_text(element)
            if grade_text:
                current_grade = grade_text
            continue

        # ── Tables → pipe-delimited rows ─────────────────────────────────
        if element.name == "table" and element.parent and element.parent.name not in ["table", "tr", "td"]:
            rows = []
            for tr in element.find_all("tr"):
                cells = [re.sub(r"\s+", " ", td.get_text(" ", strip=True)).strip()
                         for td in tr.find_all(["td", "th"])]
                if any(cells):
                    rows.append(" | ".join(c for c in cells if c))
            if rows:
                current_lines.append("[TABLE] " + "; ".join(rows))
            continue

        # ── Bullet items ─────────────────────────────────────────────────
        bullet_classes = {"bulletIndent1", "bulletIndent2", "bulletIndent3",
                         "bullet", "bullet-block", "bulletCompact",
                         "bulletItem", "bulletItem2", "dashItem", "dashItem2",
                         "plainItem", "summaryItem"}
        if bullet_classes & set(cls_list):
            # Avoid double-counting nested bullets
            if not element.find_parent(class_=bullet_classes):
                txt = _tag_text(element)
                if txt:
                    indent = "  " * (1 if "Indent2" in cls or "Indent3" in cls else 0)
                    current_lines.append(f"{indent}• {txt}")
            continue

        # ── Regular paragraph / abstract text ────────────────────────────
        if element.name in ["p"] and not element.find_parent(["table"]):
            txt = _tag_text(element)
            if txt and len(txt) > 15:
                current_lines.append(txt)

    flush()
    return sections


# ─── Database helpers ───────────────────────────────────────────────────────
def open_ro(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def build_fts_map(fts_path: Path) -> dict[int, str]:
    """Load all pre-stripped plain texts from fcontentsearch.db keyed by topic_id."""
    print("[prep] Loading FTS plain-text map from fcontentsearch.db...")
    c = open_ro(fts_path)
    cur = c.cursor()
    fts = {}
    for row in cur.execute("SELECT c2URL, c7content FROM Search_content WHERE c7content IS NOT NULL"):
        url = row["c2URL"] or ""
        # c2URL format: "Topic-12345"
        if url.startswith("Topic-"):
            try:
                tid = int(url.split("-", 1)[1])
                text = row["c7content"] or ""
                if text:
                    fts[tid] = text
            except ValueError:
                pass
    c.close()
    print(f"[prep] FTS map loaded: {len(fts):,} topics with plain text.")
    return fts


def get_specialty(specialty_id: str) -> str:
    return SPECIALTY_MAP.get(str(specialty_id), f"Specialty-{specialty_id}")


# ─── Main extractor ─────────────────────────────────────────────────────────
def extract(sample: int = 0, types_filter: set = None, resume: bool = False):
    OUT_CORPUS.parent.mkdir(parents=True, exist_ok=True)

    # Validate databases
    for db in [DB_INDEX, DB_CONTENT, DB_TOC]:
        if not db.exists():
            print(f"[ERROR] Missing: {db}")
            return

    # Load FTS map for BM25 (optional — skip if not present)
    fts_map = {}
    if DB_FTS.exists():
        fts_map = build_fts_map(DB_FTS)

    # Open connections
    c_idx  = open_ro(DB_INDEX)
    c_con  = open_ro(DB_CONTENT)
    cur_con = c_con.cursor()

    # Get master topic list from utd_index.sqlite
    query = "SELECT id, title, url, type, subtype, specialty_id, has_patient_info, last_updated, body_len FROM topics"
    if types_filter:
        placeholders = ",".join("?" * len(types_filter))
        query += f" WHERE subtype IN ({placeholders})"
        all_topics = c_idx.execute(query, list(types_filter)).fetchall()
    else:
        all_topics = c_idx.execute(query).fetchall()

    # Filter by min body length
    all_topics = [t for t in all_topics if (t["body_len"] or 0) >= MIN_BODY_LEN]

    total = len(all_topics)
    print(f"[extract] {total:,} topics to process (min body_len={MIN_BODY_LEN})")

    if sample > 0:
        all_topics = all_topics[:sample]
        print(f"[extract] Sample mode: {sample} topics")

    # Resume from checkpoint
    start_idx = 0
    if resume and CHECKPOINT.exists():
        ckpt = json.loads(CHECKPOINT.read_text())
        start_idx = ckpt.get("last_idx", 0)
        print(f"[extract] Resuming from index {start_idx}")

    all_topics = all_topics[start_idx:]

    write_mode = "a" if resume and start_idx > 0 else "w"
    written = start_idx
    skipped = 0
    errors = 0
    t0 = time.time()

    with (open(OUT_CORPUS, write_mode, encoding="utf-8") as f_corpus,
          open(OUT_BM25,   write_mode, encoding="utf-8") as f_bm25):

        try:
          for i, topic in enumerate(all_topics):
            topic_id  = topic["id"]
            title     = topic["title"] or f"Topic {topic_id}"
            url       = topic["url"] or f"/contents/topic-{topic_id}"
            ttype     = topic["type"] or "medical"
            subtype   = topic["subtype"] or "medical_review"
            spec_id   = str(topic["specialty_id"] or "")
            specialty = get_specialty(spec_id)
            last_upd  = topic["last_updated"] or 0
            has_pt    = bool(topic["has_patient_info"])

            # ── Pause check ────────────────────────────────────────────
            if i % PAUSE_CHECK == 0 and PAUSE_SIGNAL.exists():
                print(f"\n[PAUSE] Pause signal at topic index {start_idx + i}.")
                CHECKPOINT.write_text(json.dumps({
                    "last_idx":  start_idx + i,
                    "written":   written,
                    "total":     total,
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                }))
                print(f"[PAUSE] Checkpoint saved. Re-run with --resume to continue.")
                c_idx.close(); c_con.close()
                return

            try:
                # Pull JSON blob from utdasset_decrypted
                row = cur_con.execute(
                    "SELECT content FROM topic_content WHERE id=?", (topic_id,)
                ).fetchone()

                if not row:
                    skipped += 1
                    continue

                data = json.loads(row["content"])
                body_html = data.get("bodyHtml", "")

                if not body_html or len(body_html) < MIN_BODY_LEN:
                    skipped += 1
                    continue

                # Parse sections from HTML
                sections = parse_body_html(body_html, title)

                if not sections:
                    # Fallback: use FTS plain text as single section
                    if topic_id in fts_map:
                        sections = [{"heading": "Content", "text": fts_map[topic_id], "level": 1}]
                    else:
                        skipped += 1
                        continue

                # Build full_text for chunking
                full_text = title + "\n\n"
                for s in sections:
                    if s["heading"] != "Content":
                        full_text += f"\n{s['heading']}\n"
                    full_text += s["text"] + "\n"

                # Related topics for sidebar metadata
                rt = data.get("relatedTopics", {})
                related_ids = []
                if isinstance(rt, dict):
                    related_ids = [int(t["id"]) for t in rt.get("topics", [])
                                   if t.get("id") and not t.get("hideInResults")]

                # Write corpus record
                corpus_record = {
                    "topic_id":    topic_id,
                    "title":       title,
                    "url":         url,
                    "utd_url":     f"/utd/topic/{topic_id}",
                    "type":        ttype,
                    "subtype":     subtype,
                    "specialty":   specialty,
                    "specialty_id": spec_id,
                    "has_patient_info": has_pt,
                    "last_updated": last_upd,
                    "sections":    sections,
                    "section_count": len(sections),
                    "char_count":  len(full_text),
                    "related_topic_ids": related_ids[:10],
                }
                f_corpus.write(json.dumps(corpus_record, ensure_ascii=False) + "\n")

                # Write BM25 plain-text record
                # Use FTS pre-stripped text if available (better quality), else stripped full_text
                plain_text = fts_map.get(topic_id, "") or re.sub(r"\s+", " ", full_text).strip()
                bm25_record = {
                    "topic_id": topic_id,
                    "title":    title,
                    "url":      url,
                    "utd_url":  f"/utd/topic/{topic_id}",
                    "specialty": specialty,
                    "type":     ttype,
                    "text":     plain_text,
                }
                f_bm25.write(json.dumps(bm25_record, ensure_ascii=False) + "\n")

                written += 1

                # Progress update every 200 topics
                if (i + 1) % 200 == 0:
                    elapsed = time.time() - t0
                    rate = (i + 1) / elapsed
                    eta_h = (len(all_topics) - i - 1) / rate / 3600
                    pct = (start_idx + i + 1) / total * 100
                    print(f"  [{time.strftime('%H:%M')}] {pct:.1f}% "
                          f"({start_idx+i+1:,}/{total:,}) | "
                          f"{rate:.1f}/s | ETA {eta_h:.1f}h | "
                          f"written={written:,} skip={skipped} err={errors}")
                    CHECKPOINT.write_text(json.dumps({
                        "last_idx": start_idx + i + 1,
                        "written": written,
                        "total": total,
                        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                    }))

            except json.JSONDecodeError as e:
                errors += 1
                if errors < 5:
                    print(f"  [JSON ERR] topic {topic_id}: {e}")
            except Exception as e:
                errors += 1
                if errors < 5:
                    print(f"  [ERR] topic {topic_id}: {type(e).__name__}: {e}")

        except KeyboardInterrupt:
            print(f"\n[INTERRUPT] Saving checkpoint...")
            CHECKPOINT.write_text(json.dumps({
                "last_idx":  start_idx + i,
                "written":   written,
                "total":     total,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            }))
            print(f"[INTERRUPT] Saved at index {start_idx + i}. Re-run with --resume.")
            c_idx.close(); c_con.close()
            return

    c_idx.close()
    c_con.close()

    elapsed = time.time() - t0
    print(f"\n[DONE] Written={written:,} | Skipped={skipped} | Errors={errors}")
    print(f"  Corpus : {OUT_CORPUS} ({OUT_CORPUS.stat().st_size/1e6:.1f} MB)")
    print(f"  BM25   : {OUT_BM25} ({OUT_BM25.stat().st_size/1e6:.1f} MB)")
    print(f"  Time   : {elapsed/60:.1f} min")

    # Final checkpoint
    CHECKPOINT.write_text(json.dumps({
        "done": True, "written": written, "total": total,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample",  type=int, default=0)
    parser.add_argument("--resume",  action="store_true")
    parser.add_argument("--types",   default="",
                        help="Comma-separated subtypes: medical_review,drug_general,drug_patient")
    args = parser.parse_args()

    types_filter = None
    if args.types:
        types_filter = set(t.strip() for t in args.types.split(","))

    extract(sample=args.sample, types_filter=types_filter, resume=args.resume)

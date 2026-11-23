"""
Phase 1 — UpToDate Corpus Extractor
====================================
Reads from the decrypted UTD SQLite bundle and produces a clean JSONL corpus
ready for chunking and embedding.

Output: D:\\ML\\data\\utd_corpus.jsonl

Usage:
    python utd_extract_corpus.py
    python utd_extract_corpus.py --sample 50   # dry-run on 50 topics
    python utd_extract_corpus.py --start 5000  # resume from topic index 5000
"""

import argparse
import json
import re
import sqlite3
import time
from pathlib import Path

# ─── Config ────────────────────────────────────────────────────────────────
UTD_DB_PATH = Path(r"D:\ML\data\net.imedicaldoctor.imd\files\imduptodate2026-3-5")
OUTPUT_FILE = Path(r"D:\ML\data\utd_corpus.jsonl")
PROGRESS_FILE = Path(r"D:\ML\data\utd_extract_progress.json")

# ─── HTML → Text parser ────────────────────────────────────────────────────
try:
    from bs4 import BeautifulSoup, NavigableString
    BS4_AVAILABLE = True
except ImportError:
    BS4_AVAILABLE = False
    print("[WARN] BeautifulSoup not installed. Using regex fallback.")
    print("       Run: pip install beautifulsoup4 lxml")


def html_to_structured_text(html: str) -> list[dict]:
    """
    Parse UTD bodyHtml into a list of sections: [{heading, text}].
    Preserves clinical structure — section headers, bullets, tables.
    """
    if not html:
        return []

    if not BS4_AVAILABLE:
        # Regex fallback — strips all tags
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text).strip()
        return [{"heading": "Content", "text": text}]

    soup = BeautifulSoup(html, "lxml")

    # Remove non-content elements
    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()
    for tag in soup.find_all(class_=["citationNumber", "visibleNever",
                                      "visiblePrintOnly", "pagenum"]):
        tag.decompose()

    sections = []
    current_heading = "Introduction"
    current_lines = []

    def flush():
        text = " ".join(current_lines).strip()
        text = re.sub(r"\s+", " ", text)
        if len(text) > 50:  # skip tiny sections
            sections.append({"heading": current_heading, "text": text})
        current_lines.clear()

    for element in soup.find_all(True):
        cls = " ".join(element.get("class", []))

        # Section headers → start new section
        if any(c in cls for c in ["h3", "h4", "h5", "drugH1", "drugH2"]):
            flush()
            current_heading = element.get_text(" ", strip=True)
            current_lines = []
            continue

        # Tables → convert rows to pipe-separated text
        if element.name == "table":
            rows = []
            for tr in element.find_all("tr"):
                cells = [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]
                if cells:
                    rows.append(" | ".join(cells))
            if rows:
                current_lines.append("[TABLE] " + "; ".join(rows))
            continue

        # Bullet items
        if any(c in cls for c in ["bulletIndent1", "bulletIndent2",
                                    "bulletIndent3", "bullet", "dashItem"]):
            txt = element.get_text(" ", strip=True)
            if txt:
                current_lines.append("• " + txt)
            continue

        # Regular paragraph text
        if element.name in ["p", "div", "span"] and element.string:
            txt = element.get_text(" ", strip=True)
            if txt and len(txt) > 10:
                current_lines.append(txt)

    flush()
    return sections


def _safe_json(content_blob) -> dict:
    """Parse topic_content JSON blob safely."""
    try:
        if isinstance(content_blob, bytes):
            return json.loads(content_blob.decode("utf-8", errors="replace"))
        return json.loads(content_blob)
    except Exception:
        return {}


def _breadcrumb(toc_conn: sqlite3.Connection, topic_id: int) -> list[str]:
    """Walk TOC hierarchy to get specialty breadcrumb."""
    mr = toc_conn.execute(
        "SELECT tocId FROM TOCMap WHERE topicId=? LIMIT 1", (topic_id,)
    ).fetchone()
    if not mr:
        return []
    node = mr[0]
    path = []
    for _ in range(8):
        r = toc_conn.execute(
            "SELECT title, parentId FROM TOC WHERE id=?", (node,)
        ).fetchone()
        if not r:
            break
        path.insert(0, r[0] or "")
        if r[1] == 0:
            break
        node = r[1]
    return path


# ─── Main extractor ────────────────────────────────────────────────────────
def extract_corpus(sample: int = 0, start: int = 0):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Open databases
    asset_db = UTD_DB_PATH / "utdasset_decrypted.sqlite"
    unidex_db = UTD_DB_PATH / "unidex.en.sqlite"
    toc_db = UTD_DB_PATH / "utdtoc.db"

    for db in [asset_db, unidex_db, toc_db]:
        if not db.exists():
            print(f"[ERROR] Missing: {db}")
            print(f"   Check UTD_DB_PATH in this script.")
            return

    conn_asset = sqlite3.connect(f"file:{asset_db}?mode=ro", uri=True)
    conn_uni   = sqlite3.connect(f"file:{unidex_db}?mode=ro", uri=True)
    conn_toc   = sqlite3.connect(f"file:{toc_db}?mode=ro", uri=True)

    # Get all topic IDs
    print("[extract] Counting topics...")
    all_ids = [r[0] for r in conn_asset.execute(
        "SELECT id FROM topic_content ORDER BY id"
    ).fetchall()]
    total = len(all_ids)
    print(f"[extract] Found {total} topics in decrypted DB.")

    if sample > 0:
        all_ids = all_ids[:sample]
        print(f"[extract] Sample mode: processing {sample} topics.")

    all_ids = all_ids[start:]

    # Write mode — append if resuming
    mode = "a" if start > 0 else "w"
    written = start
    errors = 0
    t0 = time.time()

    with open(OUTPUT_FILE, mode, encoding="utf-8") as out:
        for i, topic_id in enumerate(all_ids):
            try:
                # Get content JSON
                row = conn_asset.execute(
                    "SELECT content FROM topic_content WHERE id=?", (topic_id,)
                ).fetchone()
                if not row:
                    continue

                data = _safe_json(row[0])
                body_html = data.get("bodyHtml", "")

                # Get title from unidex
                tr = conn_uni.execute(
                    "SELECT title FROM topic WHERE topic_id=?", (topic_id,)
                ).fetchone()
                title = (tr[0] if tr else
                         data.get("topicInfo", {})
                             .get("translatedTopicInfos", [{}])[0]
                             .get("topicName", f"Topic {topic_id}"))

                # Get TOC breadcrumb
                toc_path = _breadcrumb(conn_toc, topic_id)
                specialty = toc_path[0] if toc_path else "General"

                # Parse HTML → sections
                sections = html_to_structured_text(body_html)
                if not sections:
                    continue  # skip empty articles

                # Assemble full_text (title + sections)
                full_text = f"{title}\n\n"
                for s in sections:
                    if s["heading"] != "Content":
                        full_text += f"\n{s['heading']}\n"
                    full_text += s["text"] + "\n"

                record = {
                    "topic_id": topic_id,
                    "title": title,
                    "specialty": specialty,
                    "toc_path": toc_path,
                    "sections": sections,
                    "full_text": full_text.strip(),
                    "char_count": len(full_text),
                }
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1

                # Progress log
                if (i + 1) % 500 == 0:
                    elapsed = time.time() - t0
                    rate = (i + 1) / elapsed
                    remaining = (len(all_ids) - i - 1) / rate / 3600
                    print(f"  [{time.strftime('%H:%M')}] {i+1}/{len(all_ids)} "
                          f"({rate:.1f}/s, ~{remaining:.1f}h left) | errors={errors}")
                    PROGRESS_FILE.write_text(json.dumps({
                        "phase": "extract",
                        "processed": start + i + 1,
                        "total": total,
                        "written": written,
                        "errors": errors,
                        "last_topic_id": topic_id,
                        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                    }, indent=2))

            except Exception as e:
                errors += 1
                if errors < 10:
                    print(f"  [ERROR] topic {topic_id}: {e}")

    conn_asset.close()
    conn_uni.close()
    conn_toc.close()

    elapsed = time.time() - t0
    print(f"\nDone! Written {written} articles to {OUTPUT_FILE}")
    print(f"   Errors: {errors} | Time: {elapsed/60:.1f} min")
    print(f"   File size: {OUTPUT_FILE.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="UTD corpus extractor")
    parser.add_argument("--sample", type=int, default=0,
                        help="Extract only N topics (for validation)")
    parser.add_argument("--start", type=int, default=0,
                        help="Resume from topic index N")
    args = parser.parse_args()
    extract_corpus(sample=args.sample, start=args.start)

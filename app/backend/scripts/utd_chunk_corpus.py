"""
Phase 2 — UTD Corpus Chunker
==============================
Reads utd_corpus.jsonl → produces utd_chunks.jsonl
Each chunk is 512 tokens, section-aware, with full metadata for FAISS.

Usage:
    python utd_chunk_corpus.py
"""

import json
import time
from pathlib import Path

# ─── Config ────────────────────────────────────────────────────────────────
INPUT_FILE  = Path("D:/ML/data/utd_corpus_v2.jsonl")
OUTPUT_FILE = Path("D:/ML/data/utd_chunks_v2.jsonl")
PROGRESS_FILE = Path("D:/ML/data/utd_chunk_progress.json")

CHUNK_TOKENS  = 512
OVERLAP_TOKENS = 64
MIN_TOKENS     = 100

# Rough token estimate: 1 token ≈ 4 chars (English medical text)
CHARS_PER_TOKEN = 4
CHUNK_CHARS     = CHUNK_TOKENS * CHARS_PER_TOKEN    # 2048 chars
OVERLAP_CHARS   = OVERLAP_TOKENS * CHARS_PER_TOKEN  # 256 chars
MIN_CHARS       = MIN_TOKENS * CHARS_PER_TOKEN      # 400 chars


def chunk_text(text: str, title: str, section: str) -> list[str]:
    """
    Split text into overlapping chunks with title+section prefix.
    Tries to split on sentence boundaries.
    """
    # Build prefix — always prepended to each chunk for retrieval quality
    prefix = f"{title}"
    if section and section not in ("Content", "Introduction"):
        prefix += f" — {section}"
    prefix += "\n\n"
    prefix_len = len(prefix)

    # Available chars per chunk (minus prefix)
    avail = CHUNK_CHARS - prefix_len

    if len(text) <= avail:
        # Entire section fits in one chunk
        return [prefix + text] if len(text) >= MIN_CHARS else []

    chunks = []
    pos = 0
    while pos < len(text):
        end = pos + avail

        if end < len(text):
            # Try to find sentence boundary near end
            for sep in [". ", ".\n", "! ", "? ", "\n\n", "\n"]:
                boundary = text.rfind(sep, pos, end)
                if boundary > pos + avail // 2:
                    end = boundary + len(sep)
                    break

        chunk = text[pos:end].strip()
        if len(chunk) >= MIN_CHARS:
            chunks.append(prefix + chunk)

        # Advance with overlap
        pos = max(pos + 1, end - OVERLAP_CHARS)

    return chunks


def chunk_corpus():
    if not INPUT_FILE.exists():
        print(f"❌ Input not found: {INPUT_FILE}")
        print("   Run utd_extract_corpus.py first.")
        return

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    total_articles = sum(1 for _ in open(INPUT_FILE, encoding="utf-8"))
    print(f"[chunk] {total_articles} articles to process...")

    total_chunks = 0
    t0 = time.time()

    with (open(INPUT_FILE, encoding="utf-8") as fin,
          open(OUTPUT_FILE, "w", encoding="utf-8") as fout):

        for i, line in enumerate(fin):
            article = json.loads(line)
            topic_id  = article["topic_id"]
            title     = article["title"]
            specialty = article["specialty"]
            ttype     = article.get("type", "medical")
            subtype   = article.get("subtype", "medical_review")
            spec_id   = article.get("specialty_id", "")
            url       = article.get("utd_url", f"/utd/topic/{topic_id}")
            last_upd  = article.get("last_updated", 0)
            has_pt    = article.get("has_patient_info", False)
            related   = article.get("related_topic_ids", [])
            sections  = article["sections"]

            chunk_idx = 0

            for section in sections:
                heading = section["heading"]
                text    = section["text"]

                raw_chunks = chunk_text(text, title, heading)

                for chunk_text_val in raw_chunks:
                    record = {
                        "text": chunk_text_val,
                        "metadata": {
                            "source":    "UpToDate",
                            "topic_id":  topic_id,
                            "title":     title,
                            "section":   heading,
                            "specialty": specialty,
                            "specialty_id": spec_id,
                            "type":      ttype,
                            "subtype":   subtype,
                            "page":      chunk_idx,
                            "url":       url,
                            "last_updated": last_upd,
                            "has_patient_info": has_pt,
                            "related_topic_ids": related[:5],
                        }
                    }
                    fout.write(json.dumps(record, ensure_ascii=False) + "\n")
                    chunk_idx += 1
                    total_chunks += 1

            if (i + 1) % 500 == 0:
                elapsed = time.time() - t0
                rate = (i + 1) / elapsed
                print(f"  [{time.strftime('%H:%M')}] {i+1}/{total_articles} articles | "
                      f"{total_chunks:,} chunks | {rate:.1f} art/s")
                PROGRESS_FILE.write_text(json.dumps({
                    "phase": "chunk",
                    "articles_processed": i + 1,
                    "total_articles": total_articles,
                    "total_chunks": total_chunks,
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                }, indent=2))

    elapsed = time.time() - t0
    print(f"\nDone! {total_chunks:,} chunks from {total_articles:,} articles")
    print(f"   Output: {OUTPUT_FILE} ({OUTPUT_FILE.stat().st_size / 1e6:.1f} MB)")
    print(f"   Time: {elapsed/60:.1f} min")
    print(f"   Avg chunks/article: {total_chunks/total_articles:.1f}")


if __name__ == "__main__":
    chunk_corpus()

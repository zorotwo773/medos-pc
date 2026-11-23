"""
Phase 4 — BM25 Keyword Index Builder
======================================
Builds a BM25 keyword index from the pre-stripped plain text in
fcontentsearch.db. This is the "exact term" search that complements FAISS.

When "Amiodarone" is queried, BM25 finds the Amiodarone article directly.
FAISS finds semantically similar content. The two are merged before re-ranking.

Usage:
    python utd_build_bm25.py
"""

import json
import pickle
import time
from pathlib import Path

DATA_DIR  = Path("D:/ML/data")
VSTORE    = Path("D:/ML/medos/backend/vectorstore")

BM25_TEXTS = DATA_DIR / "utd_bm25_texts.jsonl"  # from Phase 1
OUTPUT     = VSTORE / "bm25_index.pkl"           # pickled BM25 object + metadata
PROGRESS   = DATA_DIR / "utd_bm25_progress.json"
PAUSE      = DATA_DIR / "PIPELINE_PAUSE"


def tokenize(text: str) -> list[str]:
    """Clinical-aware tokenizer: lowercase, split on whitespace/punct."""
    import re
    text = text.lower()
    # Keep alphanumeric + hyphens (for drug names like "beta-blocker")
    tokens = re.findall(r"[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?", text)
    return [t for t in tokens if len(t) > 1]  # skip single chars


def build():
    if not BM25_TEXTS.exists():
        print(f"[ERROR] BM25 text file not found: {BM25_TEXTS}")
        print("  Run Phase 1 (utd_extract_corpus_v2.py) first.")
        return

    try:
        from rank_bm25 import BM25Okapi
    except ImportError:
        print("[ERROR] rank-bm25 not installed.")
        print("  Run: python utd_00_download_models.py")
        return

    VSTORE.mkdir(parents=True, exist_ok=True)

    print("[bm25] Loading documents...")
    t0 = time.time()

    docs     = []
    metadata = []

    with open(BM25_TEXTS, encoding="utf-8") as f:
        lines = f.readlines()

    total = len(lines)
    print(f"[bm25] {total:,} documents to index.")

    for i, line in enumerate(lines):
        if PAUSE.exists():
            print(f"\n[PAUSE] Paused at document {i}.")
            return
        try:
            rec = json.loads(line)
            tokens = tokenize(rec.get("text", ""))
            docs.append(tokens)
            metadata.append({
                "topic_id": rec["topic_id"],
                "title":    rec["title"],
                "url":      rec.get("url", ""),
                "utd_url":  rec.get("utd_url", f"/utd/topic/{rec['topic_id']}"),
                "specialty": rec.get("specialty", ""),
                "type":     rec.get("type", ""),
            })
        except Exception as e:
            print(f"  [WARN] line {i}: {e}")

        if (i + 1) % 5000 == 0:
            pct = (i + 1) / total * 100
            print(f"  [{time.strftime('%H:%M')}] Tokenizing {pct:.1f}% ({i+1:,}/{total:,})")
            json.dumps({"phase":"bm25","percent":round(pct,1),
                       "timestamp":time.strftime("%Y-%m-%d %H:%M:%S")})
            PROGRESS.write_text(json.dumps({
                "phase":     "bm25",
                "processed": i + 1,
                "total":     total,
                "percent":   round(pct, 1),
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            }))

    print(f"[bm25] Building BM25Okapi index ({total:,} docs)...")
    bm25 = BM25Okapi(docs)

    print(f"[bm25] Saving to {OUTPUT}...")
    payload = {
        "bm25":     bm25,
        "metadata": metadata,
        "total":    total,
        "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(OUTPUT, "wb") as f:
        pickle.dump(payload, f, protocol=4)

    elapsed = time.time() - t0
    size    = OUTPUT.stat().st_size / 1e6
    print(f"\n[DONE] BM25 index built!")
    print(f"  Documents : {total:,}")
    print(f"  Index size: {size:.0f} MB")
    print(f"  Time      : {elapsed/60:.1f} min")
    print(f"  Output    : {OUTPUT}")

    PROGRESS.write_text(json.dumps({
        "phase": "bm25", "done": True, "total": total,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }))


if __name__ == "__main__":
    build()

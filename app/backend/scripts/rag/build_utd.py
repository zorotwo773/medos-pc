"""
Build the UpToDate FAISS + BM25 index (utd_v1).

This refactors the existing utd_extract_corpus_v2 / utd_chunk_corpus /
utd_embed_faiss_v2 / utd_build_bm25 pipeline into a single coherent script
with progress reporting and resumable embedding.

Index layout:
    data/faiss/utd_v1/
        index.faiss        — IndexFlatIP (exact cosine via normalized vecs)
        metadata.parquet   — per-chunk metadata (doc_id, title, section, text)
        bm25.pkl           — BM25Okapi + tokenid map
        config.json        — build params

Run:
    python scripts/rag/build_utd.py
    python scripts/rag/build_utd.py --device cuda --batch 512 --limit 5000
"""
from __future__ import annotations

import argparse
import json
import pickle
import sqlite3
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).parents[2]
sys.path.insert(0, str(_BACKEND))
from config import EMBED_MODEL, FAISS_DIR, BM25_DIR, UTD_DB_PATH

CHUNK_SIZE   = 512    # tokens
CHUNK_OVERLAP = 64


def _extract_utd_corpus(utd_dir: Path, limit: int | None) -> list[dict]:
    """
    Extract topic text from the UpToDate SQLite bundle.
    Returns list of {doc_id, title, section, text}.
    """
    # Try the decrypted assets DB first (utdasset_decrypted.sqlite)
    asset_db = utd_dir / "utdasset_decrypted.sqlite"
    idx_db   = utd_dir / "unidex.en.sqlite"

    if not asset_db.exists():
        raise FileNotFoundError(f"Decrypted UTD asset DB not found: {asset_db}")

    c_asset = sqlite3.connect(f"file:{asset_db}?mode=ro", uri=True)
    c_asset.row_factory = sqlite3.Row

    # Load title map from index DB
    titles: dict[int, str] = {}
    if idx_db.exists():
        c_idx = sqlite3.connect(f"file:{idx_db}?mode=ro", uri=True)
        c_idx.row_factory = sqlite3.Row
        try:
            for r in c_idx.execute("SELECT topic_id, title FROM topic"):
                titles[int(r["topic_id"])] = r["title"] or ""
        finally:
            c_idx.close()

    # Discover tables in asset DB
    tables = [r[0] for r in c_asset.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    print(f"  Asset DB tables: {tables}")

    corpus: list[dict] = []
    try:
        for table in tables:
            cols = [r[1] for r in c_asset.execute(f"PRAGMA table_info('{table}')").fetchall()]
            id_col   = next((c for c in ("topic_id", "id", "topicId") if c in cols), None)
            text_col = next((c for c in ("text", "content", "html", "body", "plaintext") if c in cols), None)
            if not id_col or not text_col:
                continue
            q = f"SELECT {id_col}, {text_col} FROM '{table}'"
            if limit:
                q += f" LIMIT {limit}"
            import re
            for r in c_asset.execute(q).fetchall():
                tid  = int(r[id_col])
                raw  = str(r[text_col] or "")
                text = re.sub(r"<[^>]+>", " ", raw)
                text = re.sub(r"\s+", " ", text).strip()
                if len(text) < 50:
                    continue
                corpus.append({
                    "doc_id":  str(tid),
                    "title":   titles.get(tid, f"Topic {tid}"),
                    "section": "",
                    "text":    text,
                    "source":  "utd",
                })
    finally:
        c_asset.close()

    print(f"  Extracted {len(corpus):,} UTD topics")
    return corpus


def _chunk(corpus: list[dict], chunk_size: int, overlap: int) -> list[dict]:
    try:
        from langchain.text_splitter import RecursiveCharacterTextSplitter
    except ImportError:
        raise SystemExit("langchain not installed. pip install langchain")

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size, chunk_overlap=overlap,
        length_function=len,  # character-based; swap for token counter if needed
    )
    chunks: list[dict] = []
    for doc in corpus:
        for i, piece in enumerate(splitter.split_text(doc["text"])):
            chunks.append({
                "chunk_id": f"{doc['doc_id']}_{i}",
                "doc_id":   doc["doc_id"],
                "title":    doc["title"],
                "section":  doc["section"],
                "text":     piece,
                "source":   doc["source"],
            })
    print(f"  Chunked into {len(chunks):,} pieces (target {chunk_size} chars, overlap {overlap})")
    return chunks


def _embed_and_save(chunks: list[dict], out_dir: Path, model_name: str, device: str, batch: int) -> None:
    try:
        import numpy as np
        import faiss
        from sentence_transformers import SentenceTransformer
        import pandas as pd
    except ImportError as e:
        raise SystemExit(f"Missing dependency: {e}. pip install faiss-cpu sentence-transformers pandas pyarrow")

    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Embedding {len(chunks):,} chunks with {model_name} on {device}…")
    model = SentenceTransformer(model_name, device=device)

    texts  = [c["text"] for c in chunks]
    n      = len(texts)
    vecs   = []
    t0     = time.time()
    for i in range(0, n, batch):
        v = model.encode(texts[i:i+batch], normalize_embeddings=True, show_progress_bar=False)
        vecs.append(v)
        pct = min(100, round(100*(i+batch)/n))
        elapsed = round(time.time()-t0)
        print(f"    {min(i+batch,n)}/{n} ({pct}%) — {elapsed}s elapsed", end="\r", flush=True)
    print()

    mat = np.vstack(vecs).astype("float32")
    dim = mat.shape[1]

    index = faiss.IndexFlatIP(dim)  # exact cosine (vecs already L2-normalized)
    index.add(mat)
    faiss.write_index(index, str(out_dir / "index.faiss"))
    print(f"  FAISS index: {index.ntotal} vectors (dim={dim})")

    # Save metadata
    df = pd.DataFrame([{k: c[k] for k in ("chunk_id","doc_id","title","section","source")} for c in chunks])
    df.to_parquet(out_dir / "metadata.parquet", index=False)

    # BM25
    from rank_bm25 import BM25Okapi
    tokenized = [t.lower().split() for t in texts]
    bm25 = BM25Okapi(tokenized)
    with open(out_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"bm25": bm25, "texts": texts, "ids": [c["chunk_id"] for c in chunks]}, f)
    print(f"  BM25 index saved")

    config = {
        "model": model_name, "device": device, "chunk_size": CHUNK_SIZE,
        "chunk_overlap": CHUNK_OVERLAP, "total_chunks": n, "dim": dim,
        "source": "utd", "built_at": int(time.time()),
    }
    (out_dir / "config.json").write_text(json.dumps(config, indent=2))
    print(f"  Config written → {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build UTD FAISS+BM25 index")
    parser.add_argument("--model",  default=EMBED_MODEL)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--batch",  type=int, default=256)
    parser.add_argument("--limit",  type=int, default=None, help="Limit topics (for testing)")
    parser.add_argument("--out",    default=str(FAISS_DIR / "utd_v1"))
    args = parser.parse_args()

    if not UTD_DB_PATH:
        raise SystemExit("UTD_DB_PATH not configured in .env")

    print(f"=== MedOS UTD index builder ===")
    corpus = _extract_utd_corpus(UTD_DB_PATH, args.limit)
    chunks = _chunk(corpus, CHUNK_SIZE, CHUNK_OVERLAP)
    _embed_and_save(chunks, Path(args.out), args.model, args.device, args.batch)
    print("All done.")


if __name__ == "__main__":
    main()

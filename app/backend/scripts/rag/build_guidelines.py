"""
Build the Guidelines + Q-Bank explanations FAISS + BM25 index (guidelines_qbank_v1).

Sources:
  1. PDF guidelines from FAISS_DIR/../guidelines/ (IDSA, AHA, ACC, GOLD, KDIGO, etc.)
  2. UWorld Step 2 + Step 3 explanations from the SQLite Q-Bank databases.

Index layout:
    data/faiss/guidelines_qbank_v1/
        index.faiss
        metadata.parquet
        bm25.pkl
        config.json

Run:
    python scripts/rag/build_guidelines.py
    python scripts/rag/build_guidelines.py --device cuda
"""
from __future__ import annotations

import argparse
import json
import pickle
import re
import sqlite3
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).parents[2]
sys.path.insert(0, str(_BACKEND))
from config import EMBED_MODEL, FAISS_DIR, ROOT, STEP1_DB_PATH, STEP2_DB_PATH, STEP3_DB_PATH

CHUNK_SIZE    = 384
CHUNK_OVERLAP = 48
GUIDELINES_DIR = ROOT / "data" / "guidelines"


def _extract_guidelines(guidelines_dir: Path) -> list[dict]:
    """Extract text from guideline PDFs."""
    if not guidelines_dir.exists():
        print(f"  [WARN] Guidelines directory not found: {guidelines_dir}")
        return []

    try:
        import fitz
    except ImportError:
        raise SystemExit("PyMuPDF not installed. pip install pymupdf")

    import re
    pages: list[dict] = []
    pdfs = sorted(guidelines_dir.rglob("*.pdf"))
    for pdf in pdfs:
        try:
            doc = fitz.open(str(pdf))
            for pn in range(doc.page_count):
                text = re.sub(r"\s+", " ", doc.load_page(pn).get_text("text")).strip()
                if len(text) < 60:
                    continue
                pages.append({
                    "doc_id":  f"guideline_{pdf.stem}_p{pn+1}",
                    "title":   pdf.stem.replace("_", " "),
                    "section": "",
                    "text":    text,
                    "source":  "guidelines",
                })
            doc.close()
        except Exception as e:
            print(f"    [WARN] {pdf.name}: {e}")

    print(f"  Guidelines: {len(pages)} pages from {len(pdfs)} PDFs")
    return pages


def _extract_qbank(*banks: tuple[Path | None, str]) -> list[dict]:
    """Extract question explanations from UWorld SQLite DBs."""
    out: list[dict] = []
    for db_path, step in banks:
        if not db_path or not db_path.exists():
            continue
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
            # UWorld FTS table with type=0 is question stem; type=3 is explanation
            fts_tables = [t for t in tables if "Search_content" in t or "content" in t.lower()]
            for tbl in fts_tables:
                try:
                    cols = [r[1] for r in c.execute(f"PRAGMA table_info('{tbl}')").fetchall()]
                    has_type = "type" in cols
                    has_c0   = "c0content" in cols or "c0" in cols or "content" in cols
                    if not has_c0:
                        continue
                    content_col = "c0content" if "c0content" in cols else "c0" if "c0" in cols else "content"
                    q_type = f"WHERE type=3" if has_type else ""
                    rows = c.execute(f"SELECT {content_col} FROM '{tbl}' {q_type} LIMIT 10000").fetchall()
                    for r in rows:
                        text = re.sub(r"<[^>]+>", " ", str(r[0] or ""))
                        text = re.sub(r"\s+", " ", text).strip()
                        if len(text) < 60:
                            continue
                        out.append({
                            "doc_id":  f"qbank_{step}",
                            "title":   f"UWorld {step} explanation",
                            "section": "",
                            "text":    text,
                            "source":  "qbank",
                        })
                except Exception:
                    continue
        finally:
            c.close()

    print(f"  Q-Bank: {len(out)} explanations")
    return out


def _chunk_and_embed_save(pages: list[dict], out_dir: Path, model_name: str, device: str, batch: int) -> None:
    try:
        from langchain.text_splitter import RecursiveCharacterTextSplitter
        import numpy as np
        import faiss
        from sentence_transformers import SentenceTransformer
        import pandas as pd
        from rank_bm25 import BM25Okapi
    except ImportError as e:
        raise SystemExit(f"Missing dependency: {e}")

    splitter = RecursiveCharacterTextSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP, length_function=len)
    chunks: list[dict] = []
    for page in pages:
        for i, piece in enumerate(splitter.split_text(page["text"])):
            chunks.append({
                "chunk_id": f"{page['doc_id']}_{i}",
                "doc_id":   page["doc_id"],
                "title":    page["title"],
                "section":  page["section"],
                "text":     piece,
                "source":   page["source"],
            })

    print(f"  Chunked into {len(chunks):,} pieces")
    out_dir.mkdir(parents=True, exist_ok=True)
    model = SentenceTransformer(model_name, device=device)
    texts = [c["text"] for c in chunks]
    n = len(texts)
    vecs = []
    t0 = time.time()
    for i in range(0, n, batch):
        v = model.encode(texts[i:i+batch], normalize_embeddings=True, show_progress_bar=False)
        vecs.append(v)
        print(f"    {min(i+batch,n)}/{n} ({round(100*(i+batch)/n)}%)", end="\r", flush=True)
    print()

    mat = np.vstack(vecs).astype("float32")
    dim = mat.shape[1]
    index = faiss.IndexFlatIP(dim)
    index.add(mat)
    faiss.write_index(index, str(out_dir / "index.faiss"))

    df = pd.DataFrame([{k: c[k] for k in ("chunk_id","doc_id","title","section","source")} for c in chunks])
    df.to_parquet(out_dir / "metadata.parquet", index=False)

    bm25 = BM25Okapi([t.lower().split() for t in texts])
    with open(out_dir / "bm25.pkl", "wb") as f:
        pickle.dump({"bm25": bm25, "texts": texts, "ids": [c["chunk_id"] for c in chunks]}, f)

    config = {
        "model": model_name, "device": device, "chunk_size": CHUNK_SIZE,
        "chunk_overlap": CHUNK_OVERLAP, "total_chunks": n, "dim": dim,
        "source": "guidelines_qbank", "built_at": int(time.time()),
    }
    (out_dir / "config.json").write_text(json.dumps(config, indent=2))
    print(f"  Saved → {out_dir}  ({index.ntotal} vectors)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Guidelines+QBank FAISS index")
    parser.add_argument("--model",  default=EMBED_MODEL)
    parser.add_argument("--device", default="cpu", choices=["cpu","cuda","mps"])
    parser.add_argument("--batch",  type=int, default=256)
    parser.add_argument("--out",    default=str(FAISS_DIR / "guidelines_qbank_v1"))
    args = parser.parse_args()

    print("=== MedOS Guidelines+QBank index builder ===")
    pages: list[dict] = []
    pages.extend(_extract_guidelines(GUIDELINES_DIR))
    pages.extend(_extract_qbank((STEP1_DB_PATH, "Step1"), (STEP2_DB_PATH, "Step2"), (STEP3_DB_PATH, "Step3")))
    print(f"Total source pages: {len(pages):,}")

    if not pages:
        raise SystemExit("No source material found. Check data/guidelines/ and STEP1/2/3_DB_PATH in .env")

    _chunk_and_embed_save(pages, Path(args.out), args.model, args.device, args.batch)
    print("All done.")


if __name__ == "__main__":
    main()

"""
Phase 3 — UTD FAISS Embedder (Overnight Runner)
=================================================
Reads utd_chunks.jsonl → builds FAISS vector store
Safe to interrupt and resume — saves checkpoint every 5000 chunks.

Usage:
    python utd_embed_faiss.py
    python utd_embed_faiss.py --batch_size 16   # reduce if OOM
    python utd_embed_faiss.py --reset            # start fresh (ignore checkpoint)
"""

import argparse
import json
import time
from pathlib import Path

CHUNKS_FILE   = Path("D:/ML/data/utd_chunks_v2.jsonl")
OUTPUT_DIR    = Path("D:/ML/medos/backend/vectorstore/utd_faiss")
CHECKPOINT    = Path("D:/ML/data/utd_embed_checkpoint.json")
PROGRESS_FILE = Path("D:/ML/data/utd_embed_progress.json")

SAVE_EVERY    = 5000   # Save FAISS index every N chunks


def update_progress(processed: int, total: int, t0: float, errors: int):
    elapsed = time.time() - t0
    rate = processed / elapsed if elapsed > 0 else 1
    eta_h = (total - processed) / rate / 3600 if rate > 0 else 0
    pct = processed / total * 100

    msg = {
        "phase": "embed",
        "processed": processed,
        "total": total,
        "percent": round(pct, 1),
        "errors": errors,
        "rate_chunks_per_sec": round(rate, 2),
        "eta_hours": round(eta_h, 2),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    PROGRESS_FILE.write_text(json.dumps(msg, indent=2))

    progress_bar = "█" * int(pct / 5) + "░" * (20 - int(pct / 5))
    print(f"  [{time.strftime('%H:%M')}] [{progress_bar}] {pct:.1f}% "
          f"({processed:,}/{total:,}) | ETA: {eta_h:.1f}h | errors={errors}")


def run_embedder(batch_size: int = 32, reset: bool = False):
    # ── Validate input ────────────────────────────────────────────────────
    if not CHUNKS_FILE.exists():
        print(f"❌ Chunks file not found: {CHUNKS_FILE}")
        print("   Run utd_chunk_corpus.py first.")
        return

    print("[embed] Counting chunks...")
    with open(CHUNKS_FILE, encoding="utf-8") as f:
        total = sum(1 for _ in f)
    print(f"[embed] {total:,} chunks to embed.")

    # ── Load embedding model ──────────────────────────────────────────────
    print("[embed] Loading BAAI/bge-large-en-v1.5 (first run downloads ~1.3 GB)...")
    try:
        from langchain_community.vectorstores import FAISS
        from langchain_huggingface import HuggingFaceEmbeddings
        from langchain.docstore.document import Document
    except ImportError as e:
        print(f"❌ Missing dependency: {e}")
        print("   Run: pip install langchain langchain-community langchain-huggingface faiss-cpu")
        return

    embeddings = HuggingFaceEmbeddings(
        model_name="BAAI/bge-large-en-v1.5",
        model_kwargs={"device": "cpu"},
        encode_kwargs={"normalize_embeddings": True},
    )
    print("[embed] Model loaded ✓")

    # ── Resume logic ──────────────────────────────────────────────────────
    start_idx = 0
    vectorstore = None

    if not reset and CHECKPOINT.exists():
        ckpt = json.loads(CHECKPOINT.read_text())
        if ckpt.get("done"):
            print("✅ Embedding already complete! (checkpoint says done)")
            print(f"   Delete {CHECKPOINT} to re-run.")
            return
        start_idx = ckpt.get("last_idx", 0)
        if start_idx > 0 and OUTPUT_DIR.exists():
            print(f"[embed] Resuming from chunk {start_idx:,}...")
            try:
                vectorstore = FAISS.load_local(
                    str(OUTPUT_DIR), embeddings,
                    allow_dangerous_deserialization=True
                )
                print(f"[embed] Loaded existing index: {vectorstore.index.ntotal:,} vectors")
            except Exception as e:
                print(f"[WARN] Could not load existing index: {e} — starting fresh")
                start_idx = 0
                vectorstore = None

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── Stream and embed ──────────────────────────────────────────────────
    batch = []
    processed = start_idx
    errors = 0
    t0 = time.time()

    print(f"[embed] Starting from chunk {start_idx:,} | batch_size={batch_size}")
    print("[embed] Press Ctrl+C to safely interrupt (progress is saved every 5000 chunks)\n")

    with open(CHUNKS_FILE, encoding="utf-8") as f:
        # Skip already-processed chunks
        for _ in range(start_idx):
            f.readline()

        try:
            for i, line in enumerate(f, start=start_idx):
                chunk = json.loads(line)
                doc = Document(
                    page_content=chunk["text"],
                    metadata=chunk["metadata"]
                )
                batch.append(doc)

                if len(batch) >= batch_size:
                    try:
                        if vectorstore is None:
                            vectorstore = FAISS.from_documents(batch, embeddings)
                        else:
                            vectorstore.add_documents(batch)
                    except Exception as e:
                        errors += 1
                        print(f"  [ERROR] batch at chunk {i}: {e}")

                    batch = []
                    processed = i + 1

                    # Checkpoint save
                    if processed % SAVE_EVERY == 0:
                        vectorstore.save_local(str(OUTPUT_DIR))
                        CHECKPOINT.write_text(json.dumps({
                            "last_idx": processed,
                            "done": False,
                            "total": total,
                        }))
                        update_progress(processed, total, t0, errors)

        except KeyboardInterrupt:
            print("\n[interrupt] Saving checkpoint before exit...")
            if vectorstore and batch:
                try:
                    vectorstore.add_documents(batch)
                except Exception:
                    pass
            if vectorstore:
                vectorstore.save_local(str(OUTPUT_DIR))
                CHECKPOINT.write_text(json.dumps({
                    "last_idx": processed,
                    "done": False,
                    "total": total,
                }))
            print(f"[interrupt] Saved at chunk {processed}. Resume by re-running the script.")
            return

    # ── Final flush ───────────────────────────────────────────────────────
    if batch and vectorstore:
        try:
            vectorstore.add_documents(batch)
        except Exception as e:
            errors += 1
            print(f"  [ERROR] final batch: {e}")

    if vectorstore:
        vectorstore.save_local(str(OUTPUT_DIR))
        CHECKPOINT.write_text(json.dumps({
            "last_idx": total,
            "done": True,
            "total": total,
            "total_vectors": vectorstore.index.ntotal,
        }))

        elapsed = time.time() - t0
        print(f"\n✅ Embedding complete!")
        print(f"   Total vectors: {vectorstore.index.ntotal:,}")
        print(f"   Errors: {errors}")
        print(f"   Time: {elapsed/3600:.2f} hours")
        print(f"   Index saved to: {OUTPUT_DIR}")
        print(f"\n   Update backend/.env:")
        print(f"   VECTORSTORE_PATH={OUTPUT_DIR}")
    else:
        print("[WARN] No vectorstore was created. Check errors above.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch_size", type=int, default=32)
    parser.add_argument("--reset", action="store_true",
                        help="Ignore checkpoint and start fresh")
    args = parser.parse_args()
    run_embedder(batch_size=args.batch_size, reset=args.reset)

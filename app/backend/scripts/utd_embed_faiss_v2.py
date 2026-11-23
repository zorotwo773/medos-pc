"""
Phase 3 — FAISS Embedder v3 (Pure transformers, no network calls)
==================================================================
Uses PyTorch + HuggingFace transformers directly.
No LangChain. No SentenceTransformers hub checks.
100% offline after model download.

Checkpoints every 5000 chunks. Pause-signal safe. Ctrl+C safe.

Usage:
    python utd_embed_faiss_v2.py               # run / auto-resume
    python utd_embed_faiss_v2.py --batch 64    # default
    python utd_embed_faiss_v2.py --batch 32    # reduce if RAM issues
    python utd_embed_faiss_v2.py --reset       # start fresh
"""

import argparse
import json
import os
import pickle
import time

# Prevent PyTorch/FAISS/Tokenizer thread collisions on Windows
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import numpy as np
from pathlib import Path

DATA_DIR      = Path("D:/ML/data")
CHUNKS_FILE   = DATA_DIR / "utd_chunks_v2.jsonl"
OUTPUT_DIR    = Path("D:/ML/medos/backend/vectorstore/utd_faiss")
STATE_FILE    = DATA_DIR / "pipeline_state.json"
CHECKPOINT    = DATA_DIR / "utd_embed_checkpoint.json"
PROGRESS_FILE = DATA_DIR / "utd_embed_progress.json"
PAUSE_SIGNAL  = DATA_DIR / "PIPELINE_PAUSE"
DIM           = 1024
SAVE_EVERY    = 5000
PAUSE_CHECK   = 500


def _jload(p):
    try:
        if Path(p).exists():
            return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _jsave(p, d):
    Path(p).write_text(json.dumps(d, indent=2), encoding="utf-8")


def get_model_path():
    s = _jload(STATE_FILE)
    local = s.get("models", {}).get("embed_model_path", "")
    if local and (Path(local) / "config.json").exists():
        return local
    return "BAAI/bge-large-en-v1.5"


def mean_pool(token_embeddings, attention_mask):
    """Mean pooling over token dimension."""
    mask = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
    return (token_embeddings * mask).sum(1) / mask.sum(1).clamp(min=1e-9)


def build_embedder(model_path):
    """Return a callable: texts -> np.ndarray[N, 1024] (normalized)."""
    import torch
    from transformers import AutoTokenizer, AutoModel

    print(f"[embed] Loading tokenizer from: {model_path}")
    tok = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
    print(f"[embed] Loading model weights...")
    mdl = AutoModel.from_pretrained(model_path, local_files_only=True)
    mdl.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    mdl = mdl.to(device)
    print(f"[embed] Model ready on {device}.")

    def embed(texts: list[str]) -> np.ndarray:
        with torch.no_grad():
            enc = tok(texts, padding=True, truncation=True,
                      max_length=512, return_tensors="pt")
            enc = {k: v.to(device) for k, v in enc.items()}
            out = mdl(**enc)
            vecs = mean_pool(out.last_hidden_state, enc["attention_mask"])
            # L2 normalize
            norms = vecs.norm(dim=1, keepdim=True).clamp(min=1e-9)
            vecs = (vecs / norms).cpu().numpy().astype(np.float32)
        return vecs

    return embed


def save_index(index, metadata, idx, total, done):
    import faiss
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(OUTPUT_DIR / "index.faiss"))
    with open(OUTPUT_DIR / "metadata.pkl", "wb") as f:
        pickle.dump(metadata, f, protocol=4)
    _jsave(CHECKPOINT, {
        "last_idx": idx, "done": done, "total": total,
        "total_vectors": index.ntotal,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    })


def show_progress(processed, total, t0, errors):
    elapsed = time.time() - t0
    rate    = processed / max(elapsed, 1)
    eta_h   = (total - processed) / max(rate, 0.001) / 3600
    pct     = processed / max(total, 1) * 100
    _jsave(PROGRESS_FILE, {
        "phase": "embed", "processed": processed, "total": total,
        "percent": round(pct, 1), "errors": errors,
        "rate_chunks_per_sec": round(rate, 2),
        "eta_hours": round(eta_h, 2),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    bar = "#" * int(pct / 5) + "-" * (20 - int(pct / 5))
    paused = PAUSE_SIGNAL.exists()
    print(f"  [{time.strftime('%H:%M')}] [{bar}] {pct:.1f}% "
          f"({processed:,}/{total:,}) | {rate:.1f} c/s | ETA {eta_h:.1f}h"
          + (" [PAUSE PENDING]" if paused else ""))


def run(batch_size=64, reset=False):
    if not CHUNKS_FILE.exists():
        print(f"[ERROR] {CHUNKS_FILE} not found. Run RUN_NIGHT1.bat first.")
        return

    print("[embed] Counting chunks...")
    with open(CHUNKS_FILE, encoding="utf-8") as f:
        total = sum(1 for _ in f)
    print(f"[embed] {total:,} chunks  |  batch={batch_size}")

    try:
        import faiss
        faiss.omp_set_num_threads(1)
        import torch
    except ImportError as e:
        print(f"[ERROR] {e}\n  Run: python utd_00_download_models.py")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    est_h = total / batch_size / (15 if device == "cuda" else 3) / 3600
    print(f"[embed] Using device: {device.upper()}")
    print(f"[embed] Estimated time: {est_h:.1f} hours")

    embed = build_embedder(get_model_path())

    # Quick smoke test
    test = embed(["Heparin anticoagulation in pulmonary embolism"])
    assert test.shape == (1, DIM), f"Bad shape: {test.shape}"
    print(f"[embed] Smoke test passed. shape={test.shape}")

    # Resume or fresh start
    start_idx = 0
    metadata  = []
    index     = None

    if not reset and CHECKPOINT.exists():
        ckpt = _jload(CHECKPOINT)
        if ckpt.get("done"):
            print(f"[embed] Already complete ({ckpt.get('total_vectors',0):,} vectors).")
            print(f"  Use --reset to rebuild.")
            return
        start_idx = ckpt.get("last_idx", 0)
        if start_idx > 0:
            idx_f  = OUTPUT_DIR / "index.faiss"
            meta_f = OUTPUT_DIR / "metadata.pkl"
            if idx_f.exists() and meta_f.exists():
                print(f"[embed] Resuming from chunk {start_idx:,}...")
                try:
                    index    = faiss.read_index(str(idx_f))
                    with open(meta_f, "rb") as f:
                        metadata = pickle.load(f)
                    print(f"[embed] Loaded {index.ntotal:,} existing vectors.")
                except Exception as e:
                    print(f"[WARN] Could not load index ({e}). Starting fresh.")
                    start_idx = 0
            else:
                print("[WARN] Checkpoint found but no index files. Starting fresh.")
                start_idx = 0

    if index is None:
        index = faiss.IndexFlatIP(DIM)
        print(f"[embed] New index: IndexFlatIP(dim={DIM})")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    batch_texts = []
    batch_meta  = []
    processed   = start_idx
    errors      = 0
    t0          = time.time()

    print(f"[embed] Starting from chunk {start_idx:,}")
    print("[embed] Ctrl+C = safe stop | PAUSE_PIPELINE.bat = graceful pause\n")

    def flush():
        nonlocal errors
        if not batch_texts:
            return
        try:
            vecs = embed(batch_texts)
            index.add(vecs)
            metadata.extend(batch_meta)
        except Exception as e:
            errors += 1
            if errors <= 10:
                print(f"  [ERR] {e}")
        batch_texts.clear()
        batch_meta.clear()

    with open(CHUNKS_FILE, encoding="utf-8") as f:
        if start_idx > 0:
            print(f"[embed] Skipping {start_idx:,} chunks...")
            for _ in range(start_idx):
                f.readline()

        try:
            for i, line in enumerate(f, start=start_idx):
                # Pause check
                if (i - start_idx) % PAUSE_CHECK == 0 and PAUSE_SIGNAL.exists():
                    print(f"\n[PAUSE] Signal at chunk {i}.")
                    flush()
                    save_index(index, metadata, i, total, False)
                    show_progress(i, total, t0, errors)
                    print("[PAUSE] Saved. Delete PIPELINE_PAUSE and re-run to resume.")
                    return

                try:
                    chunk = json.loads(line)
                    batch_texts.append(chunk["text"])
                    batch_meta.append(chunk["metadata"])
                except Exception:
                    errors += 1
                    continue

                if len(batch_texts) >= batch_size:
                    flush()
                    processed = i + 1
                    
                    # Print progress on every batch
                    if processed % (batch_size * 5) == 0 or processed == total:
                         show_progress(processed, total, t0, errors)

                    # Save checkpoint every SAVE_EVERY chunks
                    if processed % SAVE_EVERY == 0:
                        save_index(index, metadata, processed, total, False)

        except KeyboardInterrupt:
            print(f"\n[INTERRUPT] Saving at {processed}...")
            flush()
            save_index(index, metadata, processed, total, False)
            show_progress(processed, total, t0, errors)
            print(f"[INTERRUPT] Saved. Re-run to resume.")
            return

    flush()
    save_index(index, metadata, total, total, True)
    show_progress(total, total, t0, errors)

    elapsed = time.time() - t0
    print(f"\n[DONE] {index.ntotal:,} vectors | errors={errors} | {elapsed/3600:.2f}h")
    print(f"  Index: {OUTPUT_DIR}")
    print(f"\n  Next step: Run RUN_NIGHT3.bat")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()
    run(batch_size=args.batch, reset=args.reset)

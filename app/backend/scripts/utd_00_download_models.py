"""
Phase 0 — Model Downloader
============================
Downloads ALL required models to local disk ONCE.
After this, the pipeline runs 100% offline — no internet, no API tokens.

Models downloaded:
  - BAAI/bge-large-en-v1.5      (embedding, 1.3 GB)
  - BAAI/bge-reranker-v2-m3     (re-ranking, 568 MB)

Usage:
    python utd_00_download_models.py

Takes ~10 minutes on a good connection. Run ONCE, never again.
"""
import sys
import time
from pathlib import Path

MODEL_DIR = Path("D:/ML/models")
MODEL_DIR.mkdir(parents=True, exist_ok=True)

EMBED_MODEL   = "BAAI/bge-large-en-v1.5"
RERANK_MODEL  = "BAAI/bge-reranker-v2-m3"

EMBED_LOCAL   = MODEL_DIR / "bge-large-en-v1.5"
RERANK_LOCAL  = MODEL_DIR / "bge-reranker-v2-m3"

STATE_FILE = Path("D:/ML/data/pipeline_state.json")

def banner(text):
    print()
    print("=" * 60)
    print(f"  {text}")
    print("=" * 60)

def check_install(*pkgs):
    import subprocess
    for pkg in pkgs:
        try:
            __import__(pkg.replace("-", "_"))
        except ImportError:
            print(f"  Installing {pkg}...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])

def download_embedding_model():
    banner(f"Embedding Model: {EMBED_MODEL}")

    if (EMBED_LOCAL / "config.json").exists():
        print(f"  [SKIP] Already downloaded at {EMBED_LOCAL}")
        return True

    print(f"  Downloading to: {EMBED_LOCAL}")
    print("  Size: ~1.3 GB — this takes 5-10 minutes...")
    try:
        from sentence_transformers import SentenceTransformer
        t0 = time.time()
        model = SentenceTransformer(EMBED_MODEL)
        model.save(str(EMBED_LOCAL))
        elapsed = time.time() - t0
        print(f"  [OK] Saved in {elapsed:.0f}s")

        # Verify it works
        print("  Verifying...")
        test_model = SentenceTransformer(str(EMBED_LOCAL))
        vec = test_model.encode(["test clinical sentence"])
        print(f"  [OK] Embedding shape: {vec.shape} (should be (1, 1024))")
        del test_model
        return True
    except Exception as e:
        print(f"  [ERROR] {e}")
        return False


def download_reranker_model():
    banner(f"Re-ranker Model: {RERANK_MODEL}")

    if (RERANK_LOCAL / "config.json").exists():
        print(f"  [SKIP] Already downloaded at {RERANK_LOCAL}")
        return True

    print(f"  Downloading to: {RERANK_LOCAL}")
    print("  Size: ~568 MB — this takes 2-4 minutes...")
    try:
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        t0 = time.time()

        tok = AutoTokenizer.from_pretrained(RERANK_MODEL)
        tok.save_pretrained(str(RERANK_LOCAL))

        mdl = AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL)
        mdl.save_pretrained(str(RERANK_LOCAL))

        elapsed = time.time() - t0
        print(f"  [OK] Saved in {elapsed:.0f}s")

        # Verify
        print("  Verifying...")
        tok2 = AutoTokenizer.from_pretrained(str(RERANK_LOCAL))
        inputs = tok2(["query"], ["document"], return_tensors="pt", truncation=True)
        import torch
        mdl2 = AutoModelForSequenceClassification.from_pretrained(str(RERANK_LOCAL))
        with torch.no_grad():
            score = mdl2(**inputs).logits[0].item()
        print(f"  [OK] Test score: {score:.4f}")
        del tok2, mdl2
        return True
    except Exception as e:
        print(f"  [ERROR] {e}")
        return False


def write_model_paths():
    """Write model paths to pipeline_state.json so all scripts find them."""
    import json
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    state = {}
    if STATE_FILE.exists():
        try:
            state = json.loads(STATE_FILE.read_text())
        except Exception:
            pass

    state["models"] = {
        "embed_model_path": str(EMBED_LOCAL),
        "rerank_model_path": str(RERANK_LOCAL),
        "embed_model_name": EMBED_MODEL,
        "rerank_model_name": RERANK_MODEL,
        "downloaded_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    STATE_FILE.write_text(json.dumps(state, indent=2))
    print(f"\n  Model paths saved to: {STATE_FILE}")


if __name__ == "__main__":
    banner("MedOS Pipeline — Model Download (Phase 0)")
    print("  This runs ONCE. After this, everything is 100% offline.")

    # Install required packages
    print("\n[1/3] Checking Python packages...")
    check_install("sentence-transformers", "transformers", "torch",
                  "faiss-cpu", "rank-bm25", "beautifulsoup4", "lxml",
                  "langchain", "langchain-community", "langchain-huggingface",
                  "tqdm")
    print("  [OK] All packages ready.")

    # Download models
    print("\n[2/3] Downloading embedding model...")
    ok1 = download_embedding_model()

    print("\n[3/3] Downloading re-ranker model...")
    ok2 = download_reranker_model()

    # Save paths
    if ok1:
        write_model_paths()

    # Summary
    banner("Download Complete")
    print(f"  Embedding model : {'OK' if ok1 else 'FAILED'} -> {EMBED_LOCAL}")
    print(f"  Re-ranker model : {'OK' if ok2 else 'FAILED'} -> {RERANK_LOCAL}")
    print()
    if ok1:
        print("  You can now run: RUN_NIGHT1.bat")
    else:
        print("  [!] Embedding model download failed. Check internet connection.")
    print()

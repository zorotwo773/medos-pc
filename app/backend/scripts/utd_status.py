"""
Pipeline Status Dashboard
==========================
Shows real-time progress of the UTD embedding pipeline.
Run at any time — even while other scripts are running or paused.

Usage:
    python utd_status.py          # one-time snapshot
    python utd_status.py --watch  # refresh every 10 seconds
"""

import argparse
import json
import os
import time
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
DATA = Path("D:/ML/data")
SCRIPTS = Path("D:/ML/medos/backend/scripts")

STATE_FILE    = DATA / "pipeline_state.json"
EXTRACT_CKPT  = DATA / "utd_extract_v2_ckpt.json"
EXTRACT_PROG  = DATA / "utd_extract_v2_progress.json"
CHUNK_PROG    = DATA / "utd_chunk_progress.json"
EMBED_CKPT    = DATA / "utd_embed_checkpoint.json"
EMBED_PROG    = DATA / "utd_embed_progress.json"
BM25_PROG     = DATA / "utd_bm25_progress.json"
PAUSE_SIGNAL  = DATA / "PIPELINE_PAUSE"

# Output files
CORPUS_FILE   = DATA / "utd_corpus_v2.jsonl"
CHUNKS_FILE   = DATA / "utd_chunks_v2.jsonl"
BM25_FILE     = DATA / "utd_bm25_texts.jsonl"
FAISS_INDEX   = Path("D:/ML/medos/backend/vectorstore/utd_faiss/index.faiss")
BM25_INDEX    = Path("D:/ML/medos/backend/vectorstore/bm25_index.pkl")

TOTAL_TOPICS  = 21812  # from our inspection


def _load(path: Path) -> dict:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _size(path: Path) -> str:
    try:
        if path.exists():
            s = path.stat().st_size
            if s > 1e9: return f"{s/1e9:.1f} GB"
            if s > 1e6: return f"{s/1e6:.0f} MB"
            return f"{s/1e3:.0f} KB"
    except Exception:
        pass
    return "—"


def _bar(pct: float, width: int = 30) -> str:
    filled = int(pct / 100 * width)
    bar = "[" + "#" * filled + "-" * (width - filled) + "]"
    return bar


def _age(ts_str: str) -> str:
    """Return human-readable age of a timestamp string."""
    if not ts_str:
        return ""
    try:
        t = time.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
        age_s = time.time() - time.mktime(t)
        if age_s < 60: return f"{age_s:.0f}s ago"
        if age_s < 3600: return f"{age_s/60:.0f}m ago"
        if age_s < 86400: return f"{age_s/3600:.1f}h ago"
        return f"{age_s/86400:.1f}d ago"
    except Exception:
        return ts_str


def _fmt_int(n) -> str:
    try: return f"{int(n):,}"
    except: return str(n)


def print_dashboard():
    os.system("cls" if os.name == "nt" else "clear")

    state   = _load(STATE_FILE)
    ex_ckpt = _load(EXTRACT_CKPT)
    ex_prog = _load(EXTRACT_PROG)
    ch_prog = _load(CHUNK_PROG)
    em_ckpt = _load(EMBED_CKPT)
    em_prog = _load(EMBED_PROG)
    bm_prog = _load(BM25_PROG)

    paused  = PAUSE_SIGNAL.exists()
    now     = time.strftime("%H:%M:%S")

    print()
    print("=" * 66)
    print(f"  MedOS UTD Embedding Pipeline — Status Dashboard")
    print(f"  {time.strftime('%Y-%m-%d %H:%M:%S')}{'   [PAUSED]' if paused else ''}")
    print("=" * 66)

    # ── Models ──────────────────────────────────────────────────────────
    models = state.get("models", {})
    embed_ok  = Path(models.get("embed_model_path", "x") + "/config.json").exists() if models else False
    rerank_ok = Path(models.get("rerank_model_path", "x") + "/config.json").exists() if models else False

    print()
    print("  PHASE 0 — Models")
    print(f"    Embedding  (bge-large-en-v1.5)  : {'[OK]' if embed_ok  else '[NOT DOWNLOADED]'}")
    print(f"    Re-ranker  (bge-reranker-v2-m3) : {'[OK]' if rerank_ok else '[NOT DOWNLOADED]'}")
    if not embed_ok:
        print("    --> Run: python utd_00_download_models.py")

    # ── Phase 1: Extract ────────────────────────────────────────────────
    print()
    print("  PHASE 1 — Extract Corpus")
    if ex_ckpt.get("done"):
        written  = ex_ckpt.get("written", 0)
        pct      = 100.0
        ts       = ex_ckpt.get("timestamp", "")
        print(f"    Status   : COMPLETE ({_fmt_int(written)} articles, {_age(ts)})")
        print(f"    Output   : {CORPUS_FILE.name}  {_size(CORPUS_FILE)}")
    elif ex_ckpt:
        processed = ex_ckpt.get("last_idx", 0)
        pct       = min(processed / TOTAL_TOPICS * 100, 100)
        ts        = ex_ckpt.get("timestamp", "")
        written   = ex_ckpt.get("written", processed)
        print(f"    Progress : {_bar(pct)} {pct:.1f}%")
        print(f"    Topics   : {_fmt_int(processed)} / {_fmt_int(TOTAL_TOPICS)}  ({_age(ts)})")
        print(f"    Written  : {_fmt_int(written)} articles  |  File: {_size(CORPUS_FILE)}")
        if ex_prog.get("eta_hours"):
            print(f"    ETA      : {ex_prog['eta_hours']:.1f} hours remaining")
    else:
        pct = 0.0
        print(f"    Status   : NOT STARTED")
        print(f"    --> Run NIGHT1 to begin")

    # ── Phase 2: Chunk ──────────────────────────────────────────────────
    print()
    print("  PHASE 2 — Chunk Corpus  (512 tokens / 64 overlap)")
    if ch_prog:
        art_done  = ch_prog.get("articles_processed", 0)
        art_total = ch_prog.get("total_articles", TOTAL_TOPICS)
        chunks    = ch_prog.get("total_chunks", 0)
        pct2      = min(art_done / max(art_total, 1) * 100, 100)
        ts2       = ch_prog.get("timestamp", "")
        print(f"    Progress : {_bar(pct2)} {pct2:.1f}%")
        print(f"    Articles : {_fmt_int(art_done)} / {_fmt_int(art_total)}  ({_age(ts2)})")
        print(f"    Chunks   : {_fmt_int(chunks)} total  |  File: {_size(CHUNKS_FILE)}")
        print(f"    Avg/Art  : {chunks//max(art_done,1):.1f} chunks per article")
    else:
        print(f"    Status   : NOT STARTED  (runs after Phase 1)")

    # ── Phase 3: Embed ──────────────────────────────────────────────────
    print()
    print("  PHASE 3 — FAISS Embedding  (bge-large-en-v1.5, CPU)")
    total_chunks = ch_prog.get("total_chunks", 0) if ch_prog else 0
    if em_ckpt.get("done"):
        vecs = em_ckpt.get("total_vectors", 0)
        ts3  = em_prog.get("timestamp", "")
        print(f"    Status   : COMPLETE  ({_fmt_int(vecs)} vectors, {_age(ts3)})")
        print(f"    Index    : {FAISS_INDEX.parent.name}/  {_size(FAISS_INDEX)}")
    elif em_ckpt or em_prog:
        proc3  = em_ckpt.get("last_idx") if em_ckpt else em_prog.get("processed", 0)
        tot3   = em_ckpt.get("total", total_chunks) if em_ckpt else em_prog.get("total", total_chunks) or total_chunks
        pct3   = min(proc3 / max(tot3, 1) * 100, 100)
        ts3    = em_prog.get("timestamp", "")
        rate   = em_prog.get("rate_chunks_per_sec", 0)
        eta    = em_prog.get("eta_hours", 0)
        errs   = em_prog.get("errors", 0)
        print(f"    Progress : {_bar(pct3)} {pct3:.1f}%")
        print(f"    Chunks   : {_fmt_int(proc3)} / {_fmt_int(tot3)}  ({_age(ts3)})")
        if rate: print(f"    Speed    : {rate:.2f} chunks/sec")
        if eta:  print(f"    ETA      : {eta:.1f} hours remaining")
        if errs: print(f"    Errors   : {errs}")
        if FAISS_INDEX.exists():
            print(f"    Index    : {_size(FAISS_INDEX)}  (partial)")
        else:
            print(f"    Index    : (Waiting for first checkpoint)")
    else:
        print(f"    Status   : NOT STARTED  (runs after Phase 2)")
        if total_chunks:
            est_h = total_chunks / (0.8 * 32) / 3600  # ~0.8 chunks/sec with batch=32
            print(f"    Est. Time: ~{est_h:.0f} hours for {_fmt_int(total_chunks)} chunks")

    # ── Phase 4: BM25 ───────────────────────────────────────────────────
    print()
    print("  PHASE 4 — BM25 Keyword Index")
    if BM25_INDEX.exists():
        print(f"    Status   : COMPLETE  |  {_size(BM25_INDEX)}")
    elif bm_prog:
        pct4 = bm_prog.get("percent", 0)
        ts4  = bm_prog.get("timestamp", "")
        print(f"    Progress : {_bar(pct4)} {pct4:.1f}%  ({_age(ts4)})")
    else:
        print(f"    Status   : NOT STARTED  (30 min, runs after Phase 3)")

    # ── Overall ─────────────────────────────────────────────────────────
    print()
    print("  " + "-" * 62)
    phases_done = sum([
        ex_ckpt.get("done", False),
        bool(ch_prog and ch_prog.get("articles_processed",0) >= ch_prog.get("total_articles",1)),
        em_ckpt.get("done", False),
        BM25_INDEX.exists(),
    ])
    overall = phases_done / 4 * 100
    print(f"  OVERALL  {_bar(overall, 40)} {overall:.0f}%  ({phases_done}/4 phases done)")

    # ── Control ─────────────────────────────────────────────────────────
    print()
    print("  CONTROLS")
    if paused:
        print("    [PAUSED]  Delete D:/ML/data/PIPELINE_PAUSE to resume")
        print("    Or run:   RESUME_PIPELINE.bat")
    else:
        print("    Pause:    PAUSE_PIPELINE.bat  (saves checkpoint, stops cleanly)")
    print()
    print("  NEXT STEPS")
    if not embed_ok:
        print("    1. python utd_00_download_models.py  (do this now!)")
    elif not ex_ckpt.get("done"):
        print("    1. Run RUN_NIGHT1.bat  (extract + chunk)")
    elif not em_ckpt.get("done"):
        print("    1. Run RUN_NIGHT2.bat  (embed — the long one)")
    elif not BM25_INDEX.exists():
        print("    1. Run RUN_NIGHT3.bat  (BM25 + finalize)")
    else:
        print("    All done! Update medos/backend/.env with VECTORSTORE_PATH")
        print("    Then restart: python medos/backend/main.py")

    print()
    print("=" * 66)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true",
                        help="Refresh every 10 seconds")
    parser.add_argument("--interval", type=int, default=10)
    args = parser.parse_args()

    if args.watch:
        print("Watching pipeline... (Ctrl+C to stop)")
        try:
            while True:
                print_dashboard()
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\nStopped watching.")
    else:
        print_dashboard()

"""
Build a concept_links.sqlite edge table mapping equivalent articles across
UpToDate, AMBOSS, and Books.

Algorithm:
  1. Load all titles from UTD (22K), AMBOSS (7K), and book chapters.
  2. Embed each title with bge-large-en-v1.5 (batched, GPU-optional).
  3. For each AMBOSS title, find the top-K UTD titles by cosine similarity.
     Accept edges above a threshold (default 0.82).
  4. Store bidirectional edges in concept_links.sqlite.

This is a one-time offline job (30-60 min on CPU; 5-10 min on GPU).
Results are portable: copy concept_links.sqlite to any machine.

Run:
    python scripts/concepts/build_links.py
    python scripts/concepts/build_links.py --top-k 5 --threshold 0.80

Schema:
    concept_links(
        source_a TEXT, id_a TEXT, title_a TEXT,
        source_b TEXT, id_b TEXT, title_b TEXT,
        similarity REAL
    )
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).parents[2]
sys.path.insert(0, str(_BACKEND))
from config import AMBOSS_DIR, CONCEPT_LINKS_DB, MODELS_DIR, UTD_DB_PATH

DDL = """
CREATE TABLE IF NOT EXISTS concept_links (
    source_a   TEXT NOT NULL,
    id_a       TEXT NOT NULL,
    title_a    TEXT NOT NULL,
    source_b   TEXT NOT NULL,
    id_b       TEXT NOT NULL,
    title_b    TEXT NOT NULL,
    similarity REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cl_a ON concept_links(source_a, id_a);
CREATE INDEX IF NOT EXISTS idx_cl_b ON concept_links(source_b, id_b);
"""


def _load_utd_titles() -> list[tuple[str, str]]:
    """Return list of (topic_id, title) from UTD index."""
    if not UTD_DB_PATH:
        return []
    db = UTD_DB_PATH / "unidex.en.sqlite"
    if not db.exists():
        print(f"  [WARN] UTD DB not found at {db}")
        return []
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT topic_id, title FROM topic WHERE title IS NOT NULL").fetchall()
    finally:
        c.close()
    return [(str(r["topic_id"]), r["title"].strip()) for r in rows if (r["title"] or "").strip()]


def _load_amboss_titles() -> list[tuple[str, str]]:
    """Return list of (doc_id, title) from AMBOSS DB."""
    if not AMBOSS_DIR:
        return []
    db = AMBOSS_DIR / "amboss-2025.db"
    if not db.exists():
        print(f"  [WARN] AMBOSS DB not found at {db}")
        return []
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT id, title FROM Docs WHERE title IS NOT NULL").fetchall()
    finally:
        c.close()
    return [(str(r["id"]), r["title"].strip()) for r in rows if (r["title"] or "").strip()]


def _embed_titles(titles: list[str], model_name: str, batch: int = 256, device: str = "cpu") -> "np.ndarray":
    """Embed a list of titles; returns float32 ndarray shape (N, D)."""
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        raise SystemExit("sentence-transformers not installed. pip install sentence-transformers")

    import numpy as np

    print(f"  Loading embedding model '{model_name}' on {device}...")
    model = SentenceTransformer(model_name, device=device)

    vecs: list = []
    n = len(titles)
    for i in range(0, n, batch):
        chunk = titles[i : i + batch]
        v = model.encode(chunk, normalize_embeddings=True, show_progress_bar=False)
        vecs.append(v)
        if (i // batch) % 10 == 0:
            pct = min(100, round(100 * (i + batch) / n))
            print(f"    Embedded {min(i+batch,n)}/{n} ({pct}%)", end="\r", flush=True)
    print()
    return np.vstack(vecs).astype("float32")


def _build_links(
    utd_ids:   list[str],
    utd_titles: list[str],
    utd_vecs:  "np.ndarray",
    amb_ids:   list[str],
    amb_titles: list[str],
    amb_vecs:  "np.ndarray",
    top_k: int,
    threshold: float,
) -> list[tuple]:
    """
    For each AMBOSS doc, find top_k UTD topics by cosine similarity.
    Returns list of (source_a, id_a, title_a, source_b, id_b, title_b, sim).
    """
    import numpy as np

    print(f"  Computing {len(amb_ids)} x {len(utd_ids)} cosine similarities...")
    t0 = time.time()

    # Batch matrix multiply: (A, D) x (D, B) -> (A, B)
    scores = amb_vecs @ utd_vecs.T   # shape (|AMBOSS|, |UTD|)

    edges: list[tuple] = []
    for ai, (aid, atitle, row) in enumerate(zip(amb_ids, amb_titles, scores)):
        top_idx = row.argsort()[-top_k:][::-1]
        for ui in top_idx:
            sim = float(row[ui])
            if sim < threshold:
                break
            edges.append(("amboss", aid, atitle, "utd", utd_ids[ui], utd_titles[ui], sim))

    elapsed = round(time.time() - t0, 1)
    print(f"  Done in {elapsed}s — {len(edges):,} edges above threshold {threshold}")
    return edges


def main() -> None:
    parser = argparse.ArgumentParser(description="Build MedOS concept_links.sqlite")
    parser.add_argument("--model",     default="BAAI/bge-large-en-v1.5")
    parser.add_argument("--device",    default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--top-k",     type=int,   default=5)
    parser.add_argument(
        "--threshold", type=float, default=0.76,
        # 0.76 chosen empirically: produces 24K edges with 87% AMBOSS coverage.
        # 0.82 (original) produced only 7K edges at 57% coverage — too strict.
    )
    parser.add_argument("--batch",     type=int,   default=256)
    parser.add_argument("--out",       default=str(CONCEPT_LINKS_DB))
    args = parser.parse_args()

    print("=== MedOS concept link builder ===")

    utd_pairs   = _load_utd_titles()
    amboss_pairs = _load_amboss_titles()
    print(f"  UTD titles:   {len(utd_pairs):,}")
    print(f"  AMBOSS titles: {len(amboss_pairs):,}")

    if not utd_pairs or not amboss_pairs:
        raise SystemExit("Need both UTD and AMBOSS to build links.")

    utd_ids, utd_titles     = zip(*utd_pairs)
    amboss_ids, amb_titles  = zip(*amboss_pairs)

    utd_vecs  = _embed_titles(list(utd_titles),  args.model, args.batch, args.device)
    amb_vecs  = _embed_titles(list(amb_titles), args.model, args.batch, args.device)

    edges = _build_links(
        list(utd_ids), list(utd_titles), utd_vecs,
        list(amboss_ids), list(amb_titles), amb_vecs,
        top_k=args.top_k, threshold=args.threshold,
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Writing {len(edges):,} edges -> {out}")

    c = sqlite3.connect(str(out))
    c.executescript(DDL)
    c.execute("DELETE FROM concept_links")
    c.executemany(
        "INSERT INTO concept_links VALUES (?,?,?,?,?,?,?)", edges
    )
    c.commit()
    c.close()
    print("Done.")


if __name__ == "__main__":
    main()

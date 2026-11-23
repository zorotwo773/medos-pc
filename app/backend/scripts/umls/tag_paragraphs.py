"""Tag every entry in global_search.sqlite + firstaid_regions with UMLS CUIs.

Uses pyahocorasick for fast longest-match scanning against the 200K
umls_scan_terms dictionary. Stores hits in data/paragraph_concepts.sqlite.

This is the deep-cross-source-linking unlock: once every body of text knows
its CUIs, RelatedRail / RAG / hover-mentions all become concept-aware.

For now we tag at "entry" level (one global_search row = one paragraph_idx=0)
since global_search.search_text aggregates per-entry content. A future
refinement can split by HTML paragraph and emit multiple paragraph_idx rows.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path
from typing import Iterator

import ahocorasick  # type: ignore[import-untyped]

_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import ROOT, UMLS_DB  # noqa: E402

GLOBAL_SEARCH_DB = ROOT / "data" / "global_search.sqlite"
FIRSTAID_DB = ROOT / "data" / "firstaid_index.sqlite"
OUT_DB = ROOT / "data" / "paragraph_concepts.sqlite"


_WS = re.compile(r"\s+")
_NON_KEY = re.compile(r"[^a-z0-9 ]+")
_WORD_BOUNDARY = re.compile(r"[a-z0-9]")


def normalize(text: str | None) -> str:
    if not text:
        return ""
    t = unicodedata.normalize("NFKD", text)
    t = t.encode("ascii", "ignore").decode("ascii").lower()
    t = _NON_KEY.sub(" ", t)
    return _WS.sub(" ", t).strip()


DDL = """
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
PRAGMA temp_store=MEMORY;

CREATE TABLE paragraph_concepts (
  source           TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  paragraph_idx    INTEGER NOT NULL DEFAULT 0,
  cui              TEXT NOT NULL,
  semantic_group   TEXT NOT NULL DEFAULT '',
  confidence       REAL NOT NULL DEFAULT 0.7,
  matched_term     TEXT NOT NULL,
  hit_count        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source, source_id, paragraph_idx, cui)
);
CREATE INDEX idx_paragraph_concepts_cui ON paragraph_concepts(cui);
CREATE INDEX idx_paragraph_concepts_source ON paragraph_concepts(source, source_id);
CREATE INDEX idx_paragraph_concepts_group ON paragraph_concepts(semantic_group, cui);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def load_scan_dictionary(umls_db: Path) -> ahocorasick.Automaton:
    print("  loading scan dictionary...")
    con = sqlite3.connect(f"file:{umls_db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    automaton: ahocorasick.Automaton = ahocorasick.Automaton()
    try:
        rows = con.execute(
            "SELECT term, term_norm, cui, semantic_group, priority, case_sensitive FROM umls_scan_terms"
        ).fetchall()
    finally:
        con.close()
    by_norm: dict[str, tuple[str, str, str, float]] = {}
    for row in rows:
        norm = (row["term_norm"] or "").strip()
        if not norm or len(norm) < 4:
            continue
        # Choose highest-priority CUI per norm key
        existing = by_norm.get(norm)
        if existing is None or (row["priority"] or 0) > existing[3]:
            by_norm[norm] = (row["term"], row["cui"], row["semantic_group"] or "", float(row["priority"] or 0))
    for norm_key, payload in by_norm.items():
        # Pad with spaces so AC only matches whole-word occurrences
        automaton.add_word(f" {norm_key} ", (norm_key, *payload))
    automaton.make_automaton()
    print(f"  scan dictionary loaded: {len(by_norm):,} unique norms")
    return automaton


def iter_entries(global_search_db: Path) -> Iterator[tuple[str, str, str]]:
    """Yield (source, source_id, search_text) from global_search.entries."""
    con = sqlite3.connect(f"file:{global_search_db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT source, external_id, search_text FROM entries WHERE COALESCE(search_text, '') != ''"
        )
        for row in rows:
            src = "utd" if row["source"] == "uptodate" else row["source"]
            yield src, str(row["external_id"]), row["search_text"]
    finally:
        con.close()


def iter_firstaid_regions(firstaid_db: Path) -> Iterator[tuple[str, str, str]]:
    """Richer body_text for First Aid regions (vs the shorter global_search version)."""
    if not firstaid_db.exists():
        return
    con = sqlite3.connect(f"file:{firstaid_db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT heading_id, body_text FROM firstaid_regions WHERE COALESCE(body_text, '') != ''"
        )
        for row in rows:
            yield "firstaid_full", str(row["heading_id"]), row["body_text"]
    finally:
        con.close()


def scan_text(automaton: ahocorasick.Automaton, text: str) -> dict[str, tuple[str, str, str, int]]:
    """Return {cui: (matched_term_display, semantic_group, top_norm, hit_count)}."""
    if not text:
        return {}
    padded = " " + normalize(text) + " "
    hits: dict[str, tuple[str, str, str, int]] = {}
    for _, (norm_key, display, cui, semgroup, _priority) in automaton.iter(padded):
        existing = hits.get(cui)
        if existing is None:
            hits[cui] = (display, semgroup, norm_key, 1)
        else:
            d, g, n, count = existing
            # Prefer the longest-matching norm key
            if len(norm_key) > len(n):
                hits[cui] = (display, g, norm_key, count + 1)
            else:
                hits[cui] = (d, g, n, count + 1)
    return hits


def run(umls_db: Path, gs_db: Path, fa_db: Path, out_db: Path) -> dict[str, int]:
    if not umls_db.exists():
        raise SystemExit(f"UMLS DB not found: {umls_db}")
    if not gs_db.exists():
        raise SystemExit(f"global_search DB not found: {gs_db}")

    print(f"Tagging corpus paragraphs -> {out_db}")
    automaton = load_scan_dictionary(umls_db)

    started = time.perf_counter()
    out_db.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_db.with_suffix(out_db.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(str(tmp))
    try:
        con.executescript(DDL)

        per_source: dict[str, int] = {}
        total_rows = 0
        batch: list[tuple] = []

        def flush_batch() -> None:
            nonlocal total_rows
            if not batch:
                return
            con.executemany(
                """
                INSERT OR REPLACE INTO paragraph_concepts(
                  source, source_id, paragraph_idx, cui, semantic_group,
                  confidence, matched_term, hit_count
                ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
                """,
                batch,
            )
            total_rows += len(batch)
            batch.clear()

        def process_one(source: str, source_id: str, text: str) -> None:
            nonlocal batch
            hits = scan_text(automaton, text)
            for cui, (display, semgroup, _norm, count) in hits.items():
                confidence = 0.85 if semgroup else 0.65
                batch.append((source, source_id, cui, semgroup, confidence, display, count))
            per_source[source] = per_source.get(source, 0) + len(hits)
            if len(batch) >= 50_000:
                flush_batch()
                con.commit()

        n_entries = 0
        for source, sid, text in iter_entries(gs_db):
            n_entries += 1
            process_one(source, sid, text)
            if n_entries % 10_000 == 0:
                print(f"  global_search scanned: {n_entries:,} entries, {total_rows + len(batch):,} hits staged")

        n_fa = 0
        for source, sid, text in iter_firstaid_regions(fa_db):
            n_fa += 1
            process_one(source, sid, text)
            if n_fa % 500 == 0:
                print(f"  firstaid_regions scanned: {n_fa:,}, {total_rows + len(batch):,} total hits")
        flush_batch()
        con.commit()

        elapsed = time.perf_counter() - started
        meta_rows = [
            ("built_at", str(int(time.time()))),
            ("elapsed_seconds", str(round(elapsed, 2))),
            ("entries_scanned_global_search", str(n_entries)),
            ("entries_scanned_firstaid_regions", str(n_fa)),
            ("hit_rows", str(total_rows)),
            *[(f"hits_{k}", str(v)) for k, v in per_source.items()],
        ]
        con.executemany("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", meta_rows)
        con.commit()

        print()
        print(f"=== Done in {elapsed:.1f}s ===")
        print(f"  total hits: {total_rows:,}")
        print(f"  per source: {per_source}")
        out: dict[str, int] = {"hit_rows": total_rows, "entries_gs": n_entries, "entries_fa": n_fa, **per_source}
        return out
    finally:
        con.close()
    # Atomic swap
    if out_db.exists():
        out_db.unlink()
    tmp.replace(out_db)


def main() -> None:
    parser = argparse.ArgumentParser(description="Tag corpus paragraphs with UMLS CUIs.")
    parser.add_argument("--umls-db", default=str(UMLS_DB))
    parser.add_argument("--global-search-db", default=str(GLOBAL_SEARCH_DB))
    parser.add_argument("--firstaid-db", default=str(FIRSTAID_DB))
    parser.add_argument("--out", default=str(OUT_DB))
    args = parser.parse_args()
    out = Path(args.out)
    counts = run(Path(args.umls_db), Path(args.global_search_db), Path(args.firstaid_db), out)
    # Atomic swap (run() leaves tmp file behind on success)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        if out.exists():
            out.unlink()
        tmp.replace(out)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()

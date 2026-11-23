from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from config import UMLS_DB, UMLS_META_DIR  # noqa: E402
from scripts.umls.build_umls import (  # noqa: E402
    INDEX_DDL,
    SOURCE_RANK,
    batched_insert,
    build_hpo_links,
    relation_rows,
    source_set,
    write_meta,
)


def augment(args: argparse.Namespace) -> None:
    db = Path(args.db)
    meta_dir = Path(args.meta_dir)
    if not db.exists():
        raise SystemExit(f"UMLS DB not found: {db}")
    if not (meta_dir / "MRREL.RRF").exists():
        raise SystemExit(f"MRREL.RRF not found under {meta_dir}")

    started = time.perf_counter()
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA temp_store=MEMORY")
        con.execute("PRAGMA synchronous=OFF")
        sources = source_set(args.sources)
        existing = {row["sab"] for row in con.execute("SELECT sab FROM umls_sources")}
        sources = sources & existing if existing else sources
        ranks = dict(SOURCE_RANK)
        for row in con.execute("SELECT sab FROM umls_sources"):
            ranks.setdefault(row["sab"], SOURCE_RANK.get(row["sab"], 100))

        print("loading kept CUI set...")
        kept_cuis = {row["cui"] for row in con.execute("SELECT cui FROM umls_concepts")}
        print(f"kept CUIs: {len(kept_cuis):,}")

        con.execute("DELETE FROM umls_relations")
        con.execute("DELETE FROM umls_hpo_disease_links")
        con.execute("DROP INDEX IF EXISTS idx_umls_rel_cui1")
        con.execute("DROP INDEX IF EXISTS idx_umls_rel_cui2")
        con.execute("DROP INDEX IF EXISTS idx_umls_hpo_pheno")
        con.execute("DROP INDEX IF EXISTS idx_umls_hpo_disease")
        con.commit()

        rel_count = batched_insert(
            con,
            "INSERT INTO umls_relations(cui1, cui2, rel, rela, sab, source_rank) VALUES (?, ?, ?, ?, ?, ?)",
            relation_rows(meta_dir, sources, ranks, kept_cuis, args.max_mrrel_lines),
            args.batch_size,
        )
        con.commit()
        print(f"relations kept: {rel_count:,}")
        hpo_count = build_hpo_links(con)
        print(f"phenotype-disease links: {hpo_count:,}")

        con.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_umls_rel_cui1 ON umls_relations(cui1);
            CREATE INDEX IF NOT EXISTS idx_umls_rel_cui2 ON umls_relations(cui2);
            CREATE INDEX IF NOT EXISTS idx_umls_hpo_pheno ON umls_hpo_disease_links(phenotype_cui);
            CREATE INDEX IF NOT EXISTS idx_umls_hpo_disease ON umls_hpo_disease_links(disease_cui);
            """
        )
        write_meta(con, {
            "relation_count": rel_count,
            "hpo_disease_link_count": hpo_count,
            "relations_augmented_at": int(time.time()),
            "relations_augmented_seconds": round(time.perf_counter() - started, 2),
        })
        con.execute("PRAGMA optimize")
        con.commit()
    finally:
        con.close()
    print(f"Done in {(time.perf_counter() - started):.1f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Add MRREL graph rows to an existing compact UMLS DB.")
    parser.add_argument("--db", default=str(UMLS_DB))
    parser.add_argument("--meta-dir", default=str(UMLS_META_DIR))
    parser.add_argument("--sources", default="")
    parser.add_argument("--batch-size", type=int, default=50_000)
    parser.add_argument("--max-mrrel-lines", type=int, default=None)
    args = parser.parse_args()
    augment(args)


if __name__ == "__main__":
    main()

"""Compute Information Content (Resnik) for HPO phenotype concepts.

IC(phenotype) = -log( N_disease_linked / N_total_disease )
  where N_disease_linked = distinct diseases linked to this phenotype OR any of
  its HPO descendants (via inverse_isa edges).

Output: umls_hpo_ic(phenotype_cui, ic REAL, descendant_count INT, disease_count INT)

This script reads umls.sqlite, walks HPO isa hierarchy, and writes IC scores
back into the same DB. Idempotent: drops + recreates the table.

Run after build_umls.py + augment_relations.py (HPO isa must be in umls_relations).
"""
from __future__ import annotations

import argparse
import math
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import UMLS_DB  # noqa: E402


DDL = """
DROP TABLE IF EXISTS umls_hpo_ic;
CREATE TABLE umls_hpo_ic (
  phenotype_cui    TEXT PRIMARY KEY,
  ic               REAL NOT NULL,
  descendant_count INTEGER NOT NULL,
  disease_count    INTEGER NOT NULL
);
CREATE INDEX idx_umls_hpo_ic_pcui ON umls_hpo_ic(phenotype_cui);
"""


def load_hpo_isa(con: sqlite3.Connection) -> tuple[dict[str, set[str]], set[str]]:
    """Return adjacency dict child→{parents} restricted to HPO concepts."""
    children: dict[str, set[str]] = defaultdict(set)
    nodes: set[str] = set()
    rows = con.execute(
        """
        SELECT cui1, cui2 FROM umls_relations
        WHERE sab='HPO' AND rela='isa'
        """
    )
    for child, parent in rows:
        if not child or not parent:
            continue
        children[child].add(parent)
        nodes.add(child)
        nodes.add(parent)
    return children, nodes


def descendant_closure(parent_map: dict[str, set[str]]) -> dict[str, set[str]]:
    """For every node, return the set of its descendants (incl. itself).

    parent_map[child] = {parents}.  We need descendant[node] = {desc1, desc2, ...}.
    Build the inverse map then do a DFS-based closure.
    """
    children_map: dict[str, set[str]] = defaultdict(set)
    for child, parents in parent_map.items():
        for parent in parents:
            children_map[parent].add(child)

    descendants: dict[str, set[str]] = {}

    def visit(node: str) -> set[str]:
        if node in descendants:
            return descendants[node]
        acc: set[str] = {node}
        for child in children_map.get(node, ()):
            acc |= visit(child)
        descendants[node] = acc
        return acc

    sys.setrecursionlimit(100_000)
    for node in list(children_map):
        visit(node)
    # Leaves (no children) still need an entry: just themselves.
    return descendants


def load_disease_links(con: sqlite3.Connection) -> dict[str, set[str]]:
    """phenotype_cui → set of disease CUIs from umls_hpo_disease_links."""
    out: dict[str, set[str]] = defaultdict(set)
    for pcui, dcui in con.execute(
        "SELECT phenotype_cui, disease_cui FROM umls_hpo_disease_links"
    ):
        out[pcui].add(dcui)
    return out


def compute(con: sqlite3.Connection) -> int:
    parent_map, _nodes = load_hpo_isa(con)
    print(f"  HPO isa edges loaded: parents={sum(len(v) for v in parent_map.values()):,}")

    descendants = descendant_closure(parent_map)
    print(f"  descendant sets built: {len(descendants):,} nodes with children")

    phenotype_diseases = load_disease_links(con)
    print(f"  phenotypes with disease links: {len(phenotype_diseases):,}")

    # Total denominator: distinct diseases that have ANY phenotype link
    total_diseases = len({d for s in phenotype_diseases.values() for d in s})
    if total_diseases == 0:
        raise SystemExit("No disease links found; build umls_hpo_disease_links first")
    print(f"  total diseases (denominator): {total_diseases:,}")

    # For each phenotype that exists either as a node in hierarchy or as a link key,
    # compute the union of diseases over self + descendants.
    all_phenotypes: set[str] = set(phenotype_diseases.keys()) | set(descendants.keys())
    out: list[tuple[str, float, int, int]] = []
    for pcui in all_phenotypes:
        desc_set = descendants.get(pcui, {pcui})
        # diseases linked to this node or any descendant
        disease_union: set[str] = set()
        for d in desc_set:
            disease_union |= phenotype_diseases.get(d, set())
        n_diseases = len(disease_union)
        if n_diseases == 0:
            continue
        p = n_diseases / total_diseases
        # clamp p to avoid log(0); if p>=1 IC=0
        ic = -math.log(p) if p < 1.0 else 0.0
        out.append((pcui, ic, len(desc_set), n_diseases))

    con.executescript(DDL)
    con.executemany(
        "INSERT INTO umls_hpo_ic(phenotype_cui, ic, descendant_count, disease_count) VALUES (?, ?, ?, ?)",
        out,
    )
    con.commit()
    return len(out)


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute Resnik IC for HPO phenotypes in umls.sqlite.")
    parser.add_argument("--db", default=str(UMLS_DB))
    args = parser.parse_args()

    db = Path(args.db)
    if not db.exists():
        raise SystemExit(f"UMLS DB not found: {db}")

    started = time.perf_counter()
    con = sqlite3.connect(str(db))
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        print(f"Computing HPO IC scores in {db}")
        rows = compute(con)
        con.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('hpo_ic_rows', ?)",
            (str(rows),),
        )
        con.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('hpo_ic_built_at', ?)",
            (str(int(time.time())),),
        )
        con.commit()
        print(f"Wrote {rows:,} IC rows in {time.perf_counter() - started:.1f}s")
    finally:
        con.close()


if __name__ == "__main__":
    main()

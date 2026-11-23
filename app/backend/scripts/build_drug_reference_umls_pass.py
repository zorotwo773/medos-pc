"""Enrich drug_reference.sqlite with UMLS-derived clinical data.

For every drug with a populated rxcui, resolve the corresponding UMLS CUI via
umls_codes (sab='RXNORM'), then materialize four UMLS-sourced tables:

  drug_atc                — ATC class hierarchy (already-existing table, was empty)
  drug_mechanism          — MED-RT mechanism class + physiologic effects
  drug_indications_umls   — MED-RT may_treat / may_prevent edges
  drug_adverse_events     — MED-RT contraindicated_with_disease + SNOMED causative_agent_of

The script is idempotent — it DELETEs UMLS-sourced rows before re-inserting,
leaving any pre-existing curated rows from UTD/MM scrapes untouched.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import DRUG_REF_DB, UMLS_DB  # noqa: E402


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS drug_mechanism (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id         INTEGER NOT NULL,
    mechanism_cui   TEXT    NOT NULL,
    mechanism_name  TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT 'class',
    source          TEXT    NOT NULL DEFAULT 'MED-RT',
    rank            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drug_mechanism_drug ON drug_mechanism(drug_id);
CREATE INDEX IF NOT EXISTS idx_drug_mechanism_cui ON drug_mechanism(mechanism_cui);

CREATE TABLE IF NOT EXISTS drug_indications_umls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id         INTEGER NOT NULL,
    indication_cui  TEXT    NOT NULL,
    indication_name TEXT    NOT NULL,
    relation        TEXT    NOT NULL DEFAULT 'may_treat',
    source          TEXT    NOT NULL DEFAULT 'MED-RT',
    rank            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drug_indications_umls_drug ON drug_indications_umls(drug_id);
CREATE INDEX IF NOT EXISTS idx_drug_indications_umls_cui ON drug_indications_umls(indication_cui);

CREATE TABLE IF NOT EXISTS drug_adverse_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id         INTEGER NOT NULL,
    ae_cui          TEXT    NOT NULL,
    ae_name         TEXT    NOT NULL,
    kind            TEXT    NOT NULL DEFAULT 'contraindication',
    source          TEXT    NOT NULL DEFAULT 'MED-RT',
    rank            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drug_adverse_events_drug ON drug_adverse_events(drug_id);
CREATE INDEX IF NOT EXISTS idx_drug_adverse_events_cui ON drug_adverse_events(ae_cui);

CREATE TABLE IF NOT EXISTS drug_umls_links (
    drug_id INTEGER PRIMARY KEY,
    cui     TEXT NOT NULL,
    rxcui   TEXT NOT NULL,
    method  TEXT NOT NULL DEFAULT 'rxnorm_code',
    linked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drug_umls_links_cui ON drug_umls_links(cui);
"""


# ATC code-length → level mapping (WHO standard).
def atc_level(code: str) -> int:
    n = len(code or "")
    if n == 1:
        return 1
    if n == 3:
        return 2
    if n == 4:
        return 3
    if n == 5:
        return 4
    if n == 7:
        return 5
    return 0


def attach_umls(con: sqlite3.Connection, umls_path: Path) -> None:
    quoted = str(umls_path).replace("'", "''")
    con.execute(f"ATTACH DATABASE '{quoted}' AS u")


def resolve_rxcui_to_cui(con: sqlite3.Connection) -> int:
    """Populate drug_umls_links by joining drugs.rxcui to umls_codes(sab=RXNORM)."""
    con.execute("DELETE FROM drug_umls_links")
    now = int(time.time())
    cur = con.execute(
        """
        INSERT INTO drug_umls_links(drug_id, cui, rxcui, method, linked_at)
        SELECT d.drug_id, u.cui, d.rxcui, 'rxnorm_code', ?
        FROM drugs d
        JOIN u.umls_codes u ON u.sab='RXNORM' AND u.code=d.rxcui
        WHERE d.rxcui IS NOT NULL AND d.rxcui != ''
        GROUP BY d.drug_id
        """,
        (now,),
    )
    return cur.rowcount or con.execute("SELECT COUNT(*) FROM drug_umls_links").fetchone()[0]


def populate_atc(con: sqlite3.Connection) -> int:
    """Fill drug_atc from umls_codes where sab='ATC'."""
    con.execute("DELETE FROM drug_atc")
    rows = con.execute(
        """
        SELECT l.drug_id, c.code, c.term
        FROM drug_umls_links l
        JOIN u.umls_codes c ON c.cui=l.cui AND c.sab='ATC'
        ORDER BY l.drug_id, length(c.code), c.code
        """
    ).fetchall()
    inserts = [(r[0], r[1], r[2], atc_level(r[1])) for r in rows]
    con.executemany(
        "INSERT INTO drug_atc(drug_id, atc_code, atc_name, level) VALUES (?, ?, ?, ?)",
        inserts,
    )
    return len(inserts)


def populate_mechanism(con: sqlite3.Connection) -> int:
    """Fill drug_mechanism from MED-RT has_mechanism_of_action + has_physiologic_effect.

    Relation is stored as (cui1=mechanism, rela=has_*, cui2=drug). So we join
    cui2 to the drug's CUI, and pick up the inverse subject as the mechanism.
    """
    con.execute("DELETE FROM drug_mechanism WHERE source='MED-RT'")
    rows = con.execute(
        """
        SELECT l.drug_id, r.cui1, c.preferred_name,
               CASE r.rela
                 WHEN 'has_mechanism_of_action' THEN 'class'
                 WHEN 'has_physiologic_effect'  THEN 'physiologic_effect'
                 ELSE r.rela
               END AS kind
        FROM drug_umls_links l
        JOIN u.umls_relations r ON r.cui2=l.cui
        JOIN u.umls_concepts c   ON c.cui=r.cui1
        WHERE r.sab='MED-RT'
          AND r.rela IN ('has_mechanism_of_action','has_physiologic_effect')
        ORDER BY l.drug_id, r.rela, c.preferred_name
        """
    ).fetchall()
    seen: set[tuple[int, str, str]] = set()
    out: list[tuple] = []
    rank_by_drug: dict[tuple[int, str], int] = {}
    for drug_id, cui, name, kind in rows:
        key = (drug_id, cui, kind)
        if key in seen:
            continue
        seen.add(key)
        bucket = (drug_id, kind)
        rank_by_drug[bucket] = rank_by_drug.get(bucket, 0) + 1
        out.append((drug_id, cui, name, kind, 'MED-RT', rank_by_drug[bucket]))
    con.executemany(
        "INSERT INTO drug_mechanism(drug_id, mechanism_cui, mechanism_name, kind, source, rank) VALUES (?, ?, ?, ?, ?, ?)",
        out,
    )
    return len(out)


def populate_indications(con: sqlite3.Connection) -> int:
    """Fill drug_indications_umls from MED-RT may_treat + may_prevent."""
    con.execute("DELETE FROM drug_indications_umls WHERE source='MED-RT'")
    rows = con.execute(
        """
        SELECT l.drug_id, r.cui1, c.preferred_name, r.rela
        FROM drug_umls_links l
        JOIN u.umls_relations r ON r.cui2=l.cui
        JOIN u.umls_concepts c   ON c.cui=r.cui1
        WHERE r.sab='MED-RT'
          AND r.rela IN ('may_treat','may_prevent')
          AND c.semantic_group IN ('disease','finding','pathology')
        ORDER BY l.drug_id, r.rela, c.preferred_name
        """
    ).fetchall()
    seen: set[tuple[int, str]] = set()
    out: list[tuple] = []
    rank_by_drug: dict[int, int] = {}
    for drug_id, cui, name, rela in rows:
        key = (drug_id, cui)
        if key in seen:
            continue
        seen.add(key)
        rank_by_drug[drug_id] = rank_by_drug.get(drug_id, 0) + 1
        out.append((drug_id, cui, name, rela, 'MED-RT', rank_by_drug[drug_id]))
    con.executemany(
        "INSERT INTO drug_indications_umls(drug_id, indication_cui, indication_name, relation, source, rank) VALUES (?, ?, ?, ?, ?, ?)",
        out,
    )
    return len(out)


def populate_adverse_events(con: sqlite3.Connection) -> int:
    """Fill drug_adverse_events from MED-RT contraindications + SNOMED causative_agent_of.

    MED-RT contraindicated_with_disease: stored as (disease, contraindicated_with_disease, drug).
    SNOMEDCT_US causative_agent_of: stored as (adverse-event-concept, causative_agent_of, drug).
    """
    con.execute("DELETE FROM drug_adverse_events")
    rows = con.execute(
        """
        SELECT l.drug_id, r.cui1, c.preferred_name, r.sab, r.rela,
               CASE
                 WHEN r.rela='contraindicated_with_disease' THEN 'contraindication'
                 WHEN r.rela='causative_agent_of' THEN 'reaction'
                 WHEN r.rela='induces' THEN 'induced'
                 ELSE r.rela
               END AS kind
        FROM drug_umls_links l
        JOIN u.umls_relations r ON r.cui2=l.cui
        JOIN u.umls_concepts c   ON c.cui=r.cui1
        WHERE (r.sab='MED-RT'      AND r.rela IN ('contraindicated_with_disease','induces'))
           OR (r.sab='SNOMEDCT_US' AND r.rela='causative_agent_of')
        ORDER BY l.drug_id, r.sab, r.rela, c.preferred_name
        """
    ).fetchall()
    seen: set[tuple[int, str]] = set()
    out: list[tuple] = []
    rank_by_drug: dict[tuple[int, str], int] = {}
    for drug_id, cui, name, sab, _rela, kind in rows:
        key = (drug_id, cui)
        if key in seen:
            continue
        seen.add(key)
        bucket = (drug_id, kind)
        rank_by_drug[bucket] = rank_by_drug.get(bucket, 0) + 1
        out.append((drug_id, cui, name, kind, sab, rank_by_drug[bucket]))
    con.executemany(
        "INSERT INTO drug_adverse_events(drug_id, ae_cui, ae_name, kind, source, rank) VALUES (?, ?, ?, ?, ?, ?)",
        out,
    )
    return len(out)


def write_build_meta(con: sqlite3.Connection, counts: dict[str, int], elapsed: float) -> None:
    rows = [(f"umls_pass_{k}", str(v)) for k, v in counts.items()]
    rows.append(("umls_pass_built_at", str(int(time.time()))))
    rows.append(("umls_pass_seconds", str(round(elapsed, 2))))
    con.executemany("INSERT OR REPLACE INTO build_meta(key, value) VALUES (?, ?)", rows)


def run(drug_db: Path, umls_db: Path) -> dict[str, int]:
    if not drug_db.exists():
        raise SystemExit(f"drug_reference DB not found: {drug_db}")
    if not umls_db.exists():
        raise SystemExit(f"UMLS DB not found: {umls_db}. Build it first with scripts/umls/build_umls.py")

    started = time.perf_counter()
    con = sqlite3.connect(str(drug_db))
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        attach_umls(con, umls_db)
        con.executescript(SCHEMA_SQL)
        con.commit()

        print("Resolving drug rxcui -> UMLS CUI...")
        linked = resolve_rxcui_to_cui(con)
        print(f"  drugs linked: {linked:,}")
        con.commit()

        print("Populating drug_atc...")
        atc_count = populate_atc(con)
        print(f"  ATC rows: {atc_count:,}")

        print("Populating drug_mechanism...")
        mech_count = populate_mechanism(con)
        print(f"  mechanism rows: {mech_count:,}")

        print("Populating drug_indications_umls...")
        ind_count = populate_indications(con)
        print(f"  indication rows: {ind_count:,}")

        print("Populating drug_adverse_events...")
        ae_count = populate_adverse_events(con)
        print(f"  adverse-event rows: {ae_count:,}")

        elapsed = time.perf_counter() - started
        counts = {
            "linked_drugs": linked,
            "atc_rows": atc_count,
            "mechanism_rows": mech_count,
            "indication_rows": ind_count,
            "adverse_event_rows": ae_count,
        }
        write_build_meta(con, counts, elapsed)
        con.commit()
        print(f"Done in {elapsed:.1f}s")
        return counts
    finally:
        try:
            con.execute("DETACH DATABASE u")
        except sqlite3.OperationalError:
            pass
        con.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich drug_reference.sqlite with UMLS-derived clinical data.")
    parser.add_argument("--drug-db", default=str(DRUG_REF_DB))
    parser.add_argument("--umls-db", default=str(UMLS_DB))
    args = parser.parse_args()
    run(Path(args.drug_db), Path(args.umls_db))


if __name__ == "__main__":
    main()

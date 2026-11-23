"""Build data/rxnorm.sqlite from RxNorm RRF files.

Defaults to the Prescribe subset because the prescribing UI only needs
currently prescribable concepts.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import ROOT, RXNORM_DB, RXNORM_RRF_DIR
from rxnorm_reader import normalize_name


CONSO_COLS = [
    "rxcui", "lat", "ts", "lui", "stt", "sui", "ispref", "rxaui", "saui",
    "scui", "sdui", "sab", "tty", "code", "name", "srl", "suppress", "cvf",
]
REL_COLS = [
    "rxcui1", "rxaui1", "stype1", "rel", "rxcui2", "rxaui2", "stype2",
    "rela", "rui", "srui", "sab", "sl", "dir", "rg", "suppress", "cvf",
]
SAT_COLS = [
    "rxcui", "lui", "sui", "rxaui", "stype", "code", "atui", "satui",
    "atn", "sab", "atv", "suppress", "cvf",
]


SCHEMA_SQL = """
DROP TABLE IF EXISTS rxn_synonyms_fts;
DROP TABLE IF EXISTS rxn_concepts;
DROP TABLE IF EXISTS rxn_relations;
DROP TABLE IF EXISTS rxn_attributes;
DROP TABLE IF EXISTS rxn_best_names;
DROP TABLE IF EXISTS rxn_ingredients;
DROP TABLE IF EXISTS rxn_brand_map;
DROP TABLE IF EXISTS rxn_atc;
DROP TABLE IF EXISTS rxn_dose_forms;
DROP TABLE IF EXISTS rxn_strengths;
DROP TABLE IF EXISTS rxn_ndc;
DROP TABLE IF EXISTS build_meta;

CREATE TABLE rxn_concepts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    rxcui     TEXT NOT NULL,
    name      TEXT NOT NULL,
    name_norm TEXT,
    tty       TEXT,
    sab       TEXT,
    code      TEXT,
    ispref    TEXT,
    suppress  TEXT
);
CREATE INDEX idx_rxn_concepts_rxcui ON rxn_concepts(rxcui);
CREATE INDEX idx_rxn_concepts_name_norm ON rxn_concepts(name_norm);
CREATE INDEX idx_rxn_concepts_tty ON rxn_concepts(tty, rxcui);

CREATE TABLE rxn_relations (
    rxcui1    TEXT,
    rxaui1    TEXT,
    stype1    TEXT,
    rel       TEXT,
    rxcui2    TEXT,
    rxaui2    TEXT,
    stype2    TEXT,
    rela      TEXT,
    rui       TEXT,
    srui      TEXT,
    sab       TEXT,
    sl        TEXT,
    dir       TEXT,
    rg        TEXT,
    suppress  TEXT,
    cvf       TEXT
);
CREATE INDEX idx_rxn_rel_rxcui1 ON rxn_relations(rxcui1);
CREATE INDEX idx_rxn_rel_rxcui2 ON rxn_relations(rxcui2);
CREATE INDEX idx_rxn_rel_rela ON rxn_relations(rela);

CREATE TABLE rxn_attributes (
    rxcui     TEXT,
    lui       TEXT,
    sui       TEXT,
    rxaui     TEXT,
    stype     TEXT,
    code      TEXT,
    atui      TEXT,
    satui     TEXT,
    atn       TEXT,
    sab       TEXT,
    atv       TEXT,
    suppress  TEXT,
    cvf       TEXT
);
CREATE INDEX idx_rxn_attr_rxcui ON rxn_attributes(rxcui);
CREATE INDEX idx_rxn_attr_atn ON rxn_attributes(atn, rxcui);

CREATE VIRTUAL TABLE rxn_synonyms_fts USING fts5(
    concept_rowid UNINDEXED,
    rxcui UNINDEXED,
    name,
    tty UNINDEXED,
    tokenize='unicode61 remove_diacritics 1'
);

CREATE TABLE build_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def _split_rrf(line: str, width: int) -> list[str]:
    parts = line.rstrip("\n\r").split("|")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    if len(parts) < width:
        parts.extend([""] * (width - len(parts)))
    return parts[:width]


def _load_concepts(conn: sqlite3.Connection, path: Path, batch_size: int = 20000) -> int:
    sql = """
        INSERT INTO rxn_concepts
            (rxcui, name, name_norm, tty, sab, code, ispref, suppress)
        VALUES (?,?,?,?,?,?,?,?)
    """
    batch: list[tuple[str, str, str, str, str, str, str, str]] = []
    count = 0
    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        for line in fh:
            row = _split_rrf(line, len(CONSO_COLS))
            batch.append((
                row[0], row[14], normalize_name(row[14]), row[12],
                row[11], row[13], row[6], row[16],
            ))
            if len(batch) >= batch_size:
                conn.executemany(sql, batch)
                count += len(batch)
                batch.clear()
        if batch:
            conn.executemany(sql, batch)
            count += len(batch)
    return count


def _load_table(conn: sqlite3.Connection, path: Path, table: str, cols: list[str]) -> int:
    placeholders = ",".join("?" for _ in cols)
    sql = f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})"
    batch: list[tuple[str, ...]] = []
    count = 0
    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        for line in fh:
            batch.append(tuple(_split_rrf(line, len(cols))))
            if len(batch) >= 25000:
                conn.executemany(sql, batch)
                count += len(batch)
                batch.clear()
        if batch:
            conn.executemany(sql, batch)
            count += len(batch)
    return count


def _exec_script(conn: sqlite3.Connection, statements: str) -> None:
    for stmt in statements.split(";"):
        stmt = stmt.strip()
        if stmt:
            conn.execute(stmt)


def _derive_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE rxn_best_names AS
        WITH ranked AS (
            SELECT rxcui, name, tty, sab,
                   ROW_NUMBER() OVER (
                     PARTITION BY rxcui
                     ORDER BY
                       CASE WHEN sab='RXNORM' THEN 0 ELSE 1 END,
                       CASE WHEN ispref='Y' THEN 0 ELSE 1 END,
                       CASE tty
                         WHEN 'IN' THEN 0 WHEN 'PIN' THEN 1 WHEN 'MIN' THEN 2
                         WHEN 'SCD' THEN 3 WHEN 'SBD' THEN 4 WHEN 'BN' THEN 5
                         ELSE 99 END,
                       length(name), lower(name)
                   ) AS rn
            FROM rxn_concepts
            WHERE COALESCE(suppress, '') <> 'Y'
        )
        SELECT rxcui, name, tty, sab FROM ranked WHERE rn = 1
        """
    )
    conn.execute("CREATE UNIQUE INDEX idx_rxn_best_names_rxcui ON rxn_best_names(rxcui)")

    conn.execute(
        """
        CREATE TABLE rxn_ingredients AS
        SELECT DISTINCT rel.rxcui2 AS rxcui,
               rel.rxcui1 AS ingredient_rxcui,
               COALESCE(ing.name, rel.rxcui1) AS ingredient_name,
               rel.rela AS relation
        FROM rxn_relations rel
        LEFT JOIN rxn_best_names ing ON ing.rxcui = rel.rxcui1
        WHERE rel.rela IN ('has_ingredient','has_precise_ingredient','has_ingredients')
          AND COALESCE(rel.rxcui1, '') <> ''
          AND COALESCE(rel.rxcui2, '') <> ''
        UNION
        SELECT DISTINCT rel.rxcui1 AS rxcui,
               rel.rxcui2 AS ingredient_rxcui,
               COALESCE(ing.name, rel.rxcui2) AS ingredient_name,
               rel.rela AS relation
        FROM rxn_relations rel
        LEFT JOIN rxn_best_names ing ON ing.rxcui = rel.rxcui2
        WHERE rel.rela IN ('ingredient_of','precise_ingredient_of','ingredients_of')
          AND COALESCE(rel.rxcui1, '') <> ''
          AND COALESCE(rel.rxcui2, '') <> ''
        UNION
        SELECT DISTINCT product.rxcui1 AS rxcui,
               ing.rxcui2 AS ingredient_rxcui,
               COALESCE(ing_name.name, ing.rxcui2) AS ingredient_name,
               'constitutes:ingredient_of' AS relation
        FROM rxn_relations product
        JOIN rxn_relations ing ON ing.rxcui1 = product.rxcui2
        LEFT JOIN rxn_best_names ing_name ON ing_name.rxcui = ing.rxcui2
        WHERE product.rela = 'constitutes'
          AND ing.rela IN ('ingredient_of','precise_ingredient_of')
          AND COALESCE(product.rxcui1, '') <> ''
          AND COALESCE(ing.rxcui2, '') <> ''
        UNION
        SELECT DISTINCT product.rxcui2 AS rxcui,
               ing.rxcui2 AS ingredient_rxcui,
               COALESCE(ing_name.name, ing.rxcui2) AS ingredient_name,
               'consists_of:ingredient_of' AS relation
        FROM rxn_relations product
        JOIN rxn_relations ing ON ing.rxcui1 = product.rxcui1
        LEFT JOIN rxn_best_names ing_name ON ing_name.rxcui = ing.rxcui2
        WHERE product.rela = 'consists_of'
          AND ing.rela IN ('ingredient_of','precise_ingredient_of')
          AND COALESCE(product.rxcui2, '') <> ''
          AND COALESCE(ing.rxcui2, '') <> ''
        """
    )
    conn.execute("CREATE INDEX idx_rxn_ingredients_rxcui ON rxn_ingredients(rxcui)")
    conn.execute("CREATE INDEX idx_rxn_ingredients_ing ON rxn_ingredients(ingredient_rxcui)")

    conn.execute(
        """
        CREATE TABLE rxn_brand_map AS
        SELECT DISTINCT rel.rxcui1 AS brand_rxcui,
               COALESCE(bn.name, rel.rxcui1) AS brand_name,
               rel.rxcui2 AS ingredient_rxcui,
               COALESCE(ing.name, rel.rxcui2) AS ingredient_name
        FROM rxn_relations rel
        LEFT JOIN rxn_best_names bn ON bn.rxcui = rel.rxcui1
        LEFT JOIN rxn_best_names ing ON ing.rxcui = rel.rxcui2
        WHERE rel.rela = 'has_tradename'
          AND COALESCE(rel.rxcui1, '') <> ''
          AND COALESCE(rel.rxcui2, '') <> ''
        UNION
        SELECT DISTINCT rel.rxcui2 AS brand_rxcui,
               COALESCE(bn.name, rel.rxcui2) AS brand_name,
               rel.rxcui1 AS ingredient_rxcui,
               COALESCE(ing.name, rel.rxcui1) AS ingredient_name
        FROM rxn_relations rel
        LEFT JOIN rxn_best_names bn ON bn.rxcui = rel.rxcui2
        LEFT JOIN rxn_best_names ing ON ing.rxcui = rel.rxcui1
        WHERE rel.rela = 'tradename_of'
          AND COALESCE(rel.rxcui1, '') <> ''
          AND COALESCE(rel.rxcui2, '') <> ''
        """
    )
    conn.execute("CREATE INDEX idx_rxn_brand_ing ON rxn_brand_map(ingredient_rxcui)")
    conn.execute("CREATE INDEX idx_rxn_brand_brand ON rxn_brand_map(brand_rxcui)")

    conn.execute(
        """
        CREATE TABLE rxn_dose_forms AS
        SELECT DISTINCT rel.rxcui2 AS rxcui,
               COALESCE(form.name, rel.rxcui1) AS dose_form,
               NULL AS route
        FROM rxn_relations rel
        LEFT JOIN rxn_best_names form ON form.rxcui = rel.rxcui1
        WHERE rel.rela = 'has_dose_form'
          AND COALESCE(rel.rxcui1, '') <> ''
          AND COALESCE(rel.rxcui2, '') <> ''
        UNION
        SELECT DISTINCT rel.rxcui1 AS rxcui,
               COALESCE(form.name, rel.rxcui2) AS dose_form,
               NULL AS route
        FROM rxn_relations rel
        LEFT JOIN rxn_best_names form ON form.rxcui = rel.rxcui2
        WHERE rel.rela = 'dose_form_of'
          AND COALESCE(rel.rxcui1, '') <> ''
          AND COALESCE(rel.rxcui2, '') <> ''
        """
    )
    conn.execute("CREATE INDEX idx_rxn_dose_forms_rxcui ON rxn_dose_forms(rxcui)")

    conn.execute(
        """
        CREATE TABLE rxn_atc AS
        SELECT DISTINCT rxcui, code AS atc_code, name AS atc_name,
               CASE length(code)
                 WHEN 1 THEN 1 WHEN 3 THEN 2 WHEN 4 THEN 3 WHEN 5 THEN 4 ELSE 5 END AS level
        FROM rxn_concepts
        WHERE sab = 'ATC' AND COALESCE(code, '') <> ''
        """
    )
    conn.execute("CREATE INDEX idx_rxn_atc_rxcui ON rxn_atc(rxcui)")

    conn.execute(
        """
        CREATE TABLE rxn_ndc AS
        SELECT DISTINCT rxcui, atv AS ndc, NULL AS package_desc
        FROM rxn_attributes
        WHERE atn = 'NDC' AND COALESCE(atv, '') <> ''
        """
    )
    conn.execute("CREATE INDEX idx_rxn_ndc_rxcui ON rxn_ndc(rxcui)")

    conn.execute(
        """
        CREATE TABLE rxn_strengths (
            rxcui TEXT,
            strength_num REAL,
            strength_unit TEXT,
            strength_text TEXT
        )
        """
    )
    rows = conn.execute(
        """
        SELECT DISTINCT rxcui, atv
        FROM rxn_attributes
        WHERE atn IN ('RXN_STRENGTH', 'RXN_AVAILABLE_STRENGTH')
          AND COALESCE(atv, '') <> ''
        """
    ).fetchall()
    parsed: list[tuple[str, float | None, str | None, str]] = []
    strength_re = re.compile(r"(\d+(?:\.\d+)?)\s*([A-Za-z]+(?:/[A-Za-z0-9]+)?)")
    for row in rows:
        text = row["atv"] or ""
        match = strength_re.search(text.replace(",", ""))
        parsed.append((
            row["rxcui"],
            float(match.group(1)) if match else None,
            match.group(2).upper() if match else None,
            text,
        ))
    conn.executemany(
        "INSERT INTO rxn_strengths (rxcui, strength_num, strength_unit, strength_text) VALUES (?,?,?,?)",
        parsed,
    )
    conn.execute("CREATE INDEX idx_rxn_strengths_rxcui ON rxn_strengths(rxcui)")

    conn.execute(
        """
        INSERT INTO rxn_synonyms_fts (concept_rowid, rxcui, name, tty)
        SELECT id, rxcui, name, tty
        FROM rxn_concepts
        WHERE COALESCE(name, '') <> ''
          AND COALESCE(suppress, '') <> 'Y'
        """
    )


def build(rrf_dir: Path, out_db: Path, subset_name: str) -> None:
    t0 = time.time()
    required = {
        "RXNCONSO.RRF": rrf_dir / "RXNCONSO.RRF",
        "RXNREL.RRF": rrf_dir / "RXNREL.RRF",
        "RXNSAT.RRF": rrf_dir / "RXNSAT.RRF",
    }
    missing = [str(path) for path in required.values() if not path.exists()]
    if missing:
        raise SystemExit("Missing RxNorm RRF files:\n" + "\n".join(missing))

    out_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(out_db))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-120000")
    _exec_script(conn, SCHEMA_SQL)
    conn.commit()

    print(f"Loading RxNorm {subset_name} from {rrf_dir}")
    concept_count = _load_concepts(conn, required["RXNCONSO.RRF"])
    conn.commit()
    print(f"  concepts:   {concept_count:,}")

    rel_count = _load_table(conn, required["RXNREL.RRF"], "rxn_relations", REL_COLS)
    conn.commit()
    print(f"  relations:  {rel_count:,}")

    attr_count = _load_table(conn, required["RXNSAT.RRF"], "rxn_attributes", SAT_COLS)
    conn.commit()
    print(f"  attributes: {attr_count:,}")

    print("Deriving helper tables...")
    _derive_tables(conn)
    conn.commit()

    conn.executemany(
        "INSERT OR REPLACE INTO build_meta (key, value) VALUES (?, ?)",
        [
            ("built_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
            ("subset", subset_name),
            ("rrf_dir", str(rrf_dir)),
            ("concept_count", str(concept_count)),
            ("relation_count", str(rel_count)),
            ("attribute_count", str(attr_count)),
        ],
    )
    conn.commit()
    conn.execute("PRAGMA optimize")
    conn.close()

    elapsed = time.time() - t0
    print(f"Done in {elapsed:.0f}s")
    print(f"Output: {out_db} ({out_db.stat().st_size / 1e6:.1f} MB)")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build local RxNorm SQLite cache")
    parser.add_argument("--subset", choices=["prescribe", "full"], default="prescribe")
    parser.add_argument("--rrf-dir", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=RXNORM_DB)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.rrf_dir:
        rrf_dir = args.rrf_dir
    elif args.subset == "prescribe":
        rrf_dir = RXNORM_RRF_DIR
    else:
        rrf_dir = ROOT / "data" / "RxNorm_full_05042026" / "rrf"
    build(rrf_dir, args.out, args.subset)

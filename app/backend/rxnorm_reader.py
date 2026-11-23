"""Read-only helpers for the local RxNorm SQLite cache.

The cache is built from the RxNorm Prescribe RRF subset by
scripts/build_rxnorm.py. These helpers intentionally degrade to empty results
when the cache has not been built yet so the drug reference keeps working.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Iterable, Optional

from config import RXNORM_DB


TTY_PRIORITY = {
    "IN": 0,
    "PIN": 1,
    "MIN": 2,
    "SCD": 3,
    "SBD": 4,
    "BN": 5,
}


def normalize_name(value: str) -> str:
    text = (value or "").lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = text.replace("/", " ")
    text = re.sub(
        r"\b(hydrochloride|hcl|sodium|potassium|calcium|magnesium|phosphate|"
        r"sulfate|sulphate|chloride|bromide|acetate|mesylate|maleate|tartrate|"
        r"succinate|fumarate|nitrate|hydrobromide|bitartrate|citrate|besylate|"
        r"tosylate|lactate|gluconate|propionate|dipropionate|valerate|pamoate|"
        r"mandelate|edisylate|oxalate|malate|benzoate)\b",
        " ",
        text,
    )
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def open_rxnorm(path: Path = RXNORM_DB) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA cache_size=-32000")
    return c


def rxnorm_available(path: Path = RXNORM_DB) -> bool:
    return path.exists()


def _has_table(c: sqlite3.Connection, name: str) -> bool:
    row = c.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
        (name,),
    ).fetchone()
    return bool(row)


def _concept_dict(row: sqlite3.Row | None) -> Optional[dict]:
    if not row:
        return None
    return {
        "rxcui": str(row["rxcui"]),
        "name": row["name"] or "",
        "tty": row["tty"] or "",
        "sab": row["sab"] or "",
        "score": float(row["score"]) if "score" in row.keys() and row["score"] is not None else None,
    }


def resolve_name(name: str, c: sqlite3.Connection | None = None) -> Optional[dict]:
    """Resolve a typed drug name to the best RxNorm concept."""
    close = False
    if c is None:
        if not rxnorm_available():
            return None
        c = open_rxnorm()
        close = True
    try:
        if not _has_table(c, "rxn_concepts"):
            return None
        raw = (name or "").strip()
        norm = normalize_name(raw)

        rows = c.execute(
            """
            SELECT rxcui, name, tty, sab, 0.0 AS score
            FROM rxn_concepts
            WHERE lower(name) = lower(?)
              AND COALESCE(suppress, '') <> 'Y'
            """,
            (raw,),
        ).fetchall()
        if rows:
            return _concept_dict(sorted(rows, key=lambda r: TTY_PRIORITY.get(r["tty"], 99))[0])

        if norm and norm != raw.lower():
            rows = c.execute(
                """
                SELECT rxcui, name, tty, sab, 0.2 AS score
                FROM rxn_concepts
                WHERE name_norm = ?
                  AND COALESCE(suppress, '') <> 'Y'
                """,
                (norm,),
            ).fetchall()
            if rows:
                return _concept_dict(sorted(rows, key=lambda r: TTY_PRIORITY.get(r["tty"], 99))[0])

        if not _has_table(c, "rxn_synonyms_fts"):
            return None
        fts_q = re.sub(r"[^\w\s]", " ", raw).strip()
        if not fts_q:
            return None
        fts_q = " ".join(f"{part}*" for part in fts_q.split())
        rows = c.execute(
            """
            SELECT c.rxcui, c.name, c.tty, c.sab, bm25(rxn_synonyms_fts) AS score
            FROM rxn_synonyms_fts
            JOIN rxn_concepts c ON c.rowid = rxn_synonyms_fts.concept_rowid
            WHERE rxn_synonyms_fts MATCH ?
              AND COALESCE(c.suppress, '') <> 'Y'
            ORDER BY score, CASE c.tty
                WHEN 'IN' THEN 0 WHEN 'PIN' THEN 1 WHEN 'MIN' THEN 2
                WHEN 'SCD' THEN 3 WHEN 'SBD' THEN 4 WHEN 'BN' THEN 5 ELSE 99 END
            LIMIT 1
            """,
            (fts_q,),
        ).fetchall()
        return _concept_dict(rows[0]) if rows else None
    except sqlite3.Error:
        return None
    finally:
        if close:
            c.close()


def _list_dicts(
    c: sqlite3.Connection,
    sql: str,
    params: Iterable[object],
    limit: int = 50,
) -> list[dict]:
    try:
        rows = c.execute(sql, tuple(params) + (limit,)).fetchall()
    except sqlite3.Error:
        return []
    return [dict(row) for row in rows]


def synonyms_of(rxcui: str, c: sqlite3.Connection, limit: int = 80) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT rxcui, name, tty, sab
        FROM rxn_concepts
        WHERE rxcui = ?
          AND COALESCE(name, '') <> ''
          AND COALESCE(suppress, '') <> 'Y'
        ORDER BY CASE tty
            WHEN 'IN' THEN 0 WHEN 'PIN' THEN 1 WHEN 'MIN' THEN 2
            WHEN 'BN' THEN 3 WHEN 'SCD' THEN 4 WHEN 'SBD' THEN 5 ELSE 99 END,
            length(name), lower(name)
        LIMIT ?
        """,
        (str(rxcui),),
        limit,
    )


def ingredients_of(rxcui: str, c: sqlite3.Connection, limit: int = 20) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT ingredient_rxcui, ingredient_name, relation
        FROM rxn_ingredients
        WHERE rxcui = ?
        ORDER BY lower(ingredient_name)
        LIMIT ?
        """,
        (str(rxcui),),
        limit,
    )


def brands_of(rxcui: str, c: sqlite3.Connection, limit: int = 30) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT brand_rxcui, brand_name, ingredient_rxcui, ingredient_name
        FROM rxn_brand_map
        WHERE ingredient_rxcui = ? OR brand_rxcui = ?
        ORDER BY lower(brand_name)
        LIMIT ?
        """,
        (str(rxcui), str(rxcui)),
        limit,
    )


def atc_of(rxcui: str, c: sqlite3.Connection, limit: int = 20) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT rxcui, atc_code, atc_name, level
        FROM rxn_atc
        WHERE rxcui = ?
        ORDER BY level, atc_code
        LIMIT ?
        """,
        (str(rxcui),),
        limit,
    )


def dose_forms_of(rxcui: str, c: sqlite3.Connection, limit: int = 20) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT rxcui, dose_form, route
        FROM rxn_dose_forms
        WHERE rxcui = ?
        ORDER BY lower(dose_form)
        LIMIT ?
        """,
        (str(rxcui),),
        limit,
    )


def strengths_of(rxcui: str, c: sqlite3.Connection, limit: int = 50) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT rxcui, strength_num, strength_unit, strength_text
        FROM rxn_strengths
        WHERE rxcui = ?
        ORDER BY strength_unit, strength_num
        LIMIT ?
        """,
        (str(rxcui),),
        limit,
    )


def ndcs_of(rxcui: str, c: sqlite3.Connection, limit: int = 30) -> list[dict]:
    return _list_dicts(
        c,
        """
        SELECT DISTINCT rxcui, ndc, package_desc
        FROM rxn_ndc
        WHERE rxcui = ?
        ORDER BY ndc
        LIMIT ?
        """,
        (str(rxcui),),
        limit,
    )

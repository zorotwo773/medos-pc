"""Link drug_reference.sqlite rows to RxNorm concepts.

This script is idempotent. It enriches the existing drug reference database
with canonical RxNorm identity, aliases, ingredients, strengths, dose forms,
ATC rows, and NDCs. Destructive dedupe is opt-in via --dedupe.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import DRUG_REF_DB, RXNORM_DB
from rxnorm_reader import (
    atc_of,
    brands_of,
    dose_forms_of,
    ingredients_of,
    ndcs_of,
    normalize_name,
    open_rxnorm,
    resolve_name,
    strengths_of,
    synonyms_of,
)


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS drug_id_aliases (
    old_drug_id INTEGER PRIMARY KEY,
    new_drug_id INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS drug_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    ingredient_rxcui TEXT,
    ingredient_name TEXT NOT NULL,
    strength TEXT,
    unit TEXT
);
CREATE INDEX IF NOT EXISTS idx_drug_ingredients_drug ON drug_ingredients(drug_id);
CREATE INDEX IF NOT EXISTS idx_drug_ingredients_rxcui ON drug_ingredients(ingredient_rxcui);

CREATE TABLE IF NOT EXISTS drug_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    alias_norm TEXT,
    source TEXT,
    tty TEXT,
    matched_rxcui TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_drug_aliases ON drug_aliases(drug_id, alias_norm, source);
CREATE INDEX IF NOT EXISTS idx_drug_aliases_norm ON drug_aliases(alias_norm, drug_id);

CREATE TABLE IF NOT EXISTS drug_atc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    atc_code TEXT,
    atc_name TEXT,
    level INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drug_atc_drug ON drug_atc(drug_id);

CREATE TABLE IF NOT EXISTS drug_ndc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    ndc TEXT,
    package_desc TEXT
);
CREATE INDEX IF NOT EXISTS idx_drug_ndc_drug ON drug_ndc(drug_id);

CREATE TABLE IF NOT EXISTS drug_dose_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    dose_form TEXT,
    route TEXT,
    rxcui TEXT
);
CREATE INDEX IF NOT EXISTS idx_drug_dose_forms_drug ON drug_dose_forms(drug_id);

CREATE TABLE IF NOT EXISTS drug_strengths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drug_id INTEGER NOT NULL,
    rxcui TEXT,
    strength_num REAL,
    strength_unit TEXT,
    strength_text TEXT,
    dose_form TEXT,
    route TEXT
);
CREATE INDEX IF NOT EXISTS idx_drug_strengths_drug ON drug_strengths(drug_id);

CREATE TABLE IF NOT EXISTS rxnorm_dedupe_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rxcui TEXT NOT NULL,
    survivor_drug_id INTEGER NOT NULL,
    duplicate_drug_id INTEGER NOT NULL,
    survivor_name TEXT,
    duplicate_name TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_rxnorm_dedupe_candidates_rxcui ON rxnorm_dedupe_candidates(rxcui);
"""


HARDCODED_ALIASES = {
    "acetaminophen": ["APAP", "paracetamol"],
    "epinephrine": ["adrenaline"],
    "albuterol": ["salbutamol"],
    "sulfamethoxazole/trimethoprim": ["co-trimoxazole", "TMP-SMX", "SMX-TMP"],
    "trimethoprim/sulfamethoxazole": ["co-trimoxazole", "TMP-SMX", "SMX-TMP"],
}

INGREDIENT_TTYS = {"IN", "PIN", "SU"}
PACK_TTYS = {"GPCK", "BPCK", "SCDGP", "SBDGP", "SCDFP", "SBDFP"}
PRODUCT_TTYS = {"SCD", "SBD", "SCDF", "SBDF", "DP", "SY", "PSN", "TMSY", "MTH_RXN_DP"}


def _connect_rw(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(str(path))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA foreign_keys=OFF")
    return c


def _exec_script(c: sqlite3.Connection, sql: str) -> None:
    for stmt in sql.split(";"):
        stmt = stmt.strip()
        if stmt:
            c.execute(stmt)


def _columns(c: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in c.execute(f"PRAGMA table_info({table})")}


def _add_column(c: sqlite3.Connection, table: str, definition: str) -> None:
    name = definition.split()[0]
    if name not in _columns(c, table):
        c.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


def _insert_alias(
    c: sqlite3.Connection,
    drug_id: int,
    alias: str,
    source: str,
    tty: str | None = None,
    matched_rxcui: str | None = None,
) -> None:
    text = (alias or "").strip()
    norm = normalize_name(text)
    if not text or not norm:
        return
    c.execute(
        """
        INSERT OR IGNORE INTO drug_aliases
            (drug_id, alias, alias_norm, source, tty, matched_rxcui)
        VALUES (?,?,?,?,?,?)
        """,
        (drug_id, text, norm, source, tty, matched_rxcui),
    )


def _is_combination_name(name: str) -> bool:
    lowered = (name or "").lower()
    return "/" in lowered or " and " in lowered or "+" in lowered


def _identity_kind(name: str, match: Optional[dict]) -> str:
    if _is_combination_name(name):
        return "multi_ingredient"
    if not match:
        return "unlinked"
    tty = (match.get("tty") or "").upper()
    if tty == "BN":
        return "brand"
    if tty in PACK_TTYS:
        return "pack"
    if tty in PRODUCT_TTYS:
        return "product"
    if tty in INGREDIENT_TTYS:
        return "single_ingredient"
    return "concept"


def _is_unsafe_combo_match(name: str, match: Optional[dict]) -> bool:
    if not match or not _is_combination_name(name):
        return False
    # A combination monograph must not collapse to one ingredient. That creates
    # false duplicate RXCUIs and makes destructive dedupe unsafe.
    return (match.get("tty") or "").upper() in INGREDIENT_TTYS


def _infer_dose_form(text: str | None) -> str | None:
    lower = (text or "").lower()
    for needle, form in [
        ("extended release oral tablet", "extended-release tablet"),
        ("delayed release oral tablet", "delayed-release tablet"),
        ("oral tablet", "tablet"),
        ("oral capsule", "capsule"),
        ("chewable tablet", "chewable tablet"),
        ("oral suspension", "suspension"),
        ("oral solution", "solution"),
        ("injection", "injection"),
        ("topical cream", "cream"),
        ("topical ointment", "ointment"),
        ("topical gel", "gel"),
        ("ophthalmic solution", "ophthalmic solution"),
        ("otic solution", "otic solution"),
        ("inhalation", "inhalation"),
        ("nasal spray", "nasal spray"),
        ("transdermal", "patch"),
        ("suppository", "suppository"),
    ]:
        if needle in lower:
            return form
    return None


def _related_strength_product_rows(rx: sqlite3.Connection, rxcui: str, drug_name: str) -> list[sqlite3.Row]:
    if _is_combination_name(drug_name):
        return rx.execute(
            """
            SELECT DISTINCT rxcui
            FROM rxn_ingredients
            WHERE ingredient_rxcui = ?
            LIMIT 150
            """,
            (str(rxcui),),
        ).fetchall()
    return rx.execute(
        """
        SELECT ri.rxcui
        FROM rxn_ingredients ri
        LEFT JOIN rxn_best_names bn ON bn.rxcui = ri.rxcui
        WHERE ri.ingredient_rxcui = ?
        GROUP BY ri.rxcui
        HAVING COUNT(DISTINCT ri.ingredient_rxcui) = 1
        ORDER BY lower(COALESCE(bn.name, ri.rxcui))
        LIMIT 300
        """,
        (str(rxcui),),
    ).fetchall()


def _best_strength_rows(rx: sqlite3.Connection, rxcui: str, drug_name: str) -> list[dict]:
    rows = strengths_of(rxcui, rx, limit=80)
    if rows:
        return rows
    related = _related_strength_product_rows(rx, rxcui, drug_name)
    out: list[dict] = []
    for row in related:
        out.extend(strengths_of(row["rxcui"], rx, limit=10))
        if len(out) >= 50:
            break
    return out


def _best_form_rows(rx: sqlite3.Connection, rxcui: str, drug_name: str) -> list[dict]:
    rows = dose_forms_of(rxcui, rx, limit=30)
    if rows:
        return rows
    related = _related_strength_product_rows(rx, rxcui, drug_name)
    out: list[dict] = []
    for row in related:
        out.extend(dose_forms_of(row["rxcui"], rx, limit=5))
        if len(out) >= 30:
            break
    return out


def _best_ndc_rows(rx: sqlite3.Connection, rxcui: str, drug_name: str) -> list[dict]:
    rows = ndcs_of(rxcui, rx, limit=100)
    if rows:
        return rows
    out: list[dict] = []
    for row in _related_strength_product_rows(rx, rxcui, drug_name):
        out.extend(ndcs_of(row["rxcui"], rx, limit=20))
        if len(out) >= 100:
            break
    seen: set[str] = set()
    unique: list[dict] = []
    for row in out:
        ndc = row.get("ndc")
        if ndc and ndc not in seen:
            seen.add(ndc)
            unique.append(row)
    return unique[:100]


def _link_one(ref: sqlite3.Connection, rx: sqlite3.Connection, drug: sqlite3.Row) -> Optional[dict]:
    drug_id = int(drug["drug_id"])
    name = drug["generic_name"] or ""
    match = resolve_name(name, rx)
    match_method = "direct"
    warnings: list[str] = []
    if _is_unsafe_combo_match(name, match):
        warnings.append("unsafe_combo_ingredient_match_rejected")
        match = None
    if not match:
        # Try a conservative combo/base-name fallback before giving up.
        variants = [] if _is_combination_name(name) else [
            name.replace("/", " "),
            name.replace(" and ", " "),
            name.split("/")[0].strip(),
        ]
        for variant in variants:
            if variant and variant.lower() != name.lower():
                candidate = resolve_name(variant, rx)
                if candidate:
                    match = candidate
                    match_method = "single_name_fallback"
                    break
    if not match:
        _insert_alias(ref, drug_id, name, "drug_reference")
        ref.execute(
            """
            UPDATE drugs
            SET rxnorm_match_method = ?, rxnorm_match_score = NULL,
                identity_kind = ?, identity_warnings = ?
            WHERE drug_id = ?
            """,
            (
                "unmatched",
                _identity_kind(name, None),
                ",".join(warnings) if warnings else None,
                drug_id,
            ),
        )
        return None

    rxcui = str(match["rxcui"])
    ref.execute(
        """
        UPDATE drugs
        SET rxcui = ?, rxcui_tty = ?, rxnorm_match_method = ?,
            rxnorm_match_score = ?, identity_kind = ?, identity_warnings = ?
        WHERE drug_id = ?
        """,
        (
            rxcui,
            match.get("tty") or "",
            match_method,
            match.get("score"),
            _identity_kind(name, match),
            ",".join(warnings) if warnings else None,
            drug_id,
        ),
    )
    _insert_alias(ref, drug_id, name, "drug_reference", matched_rxcui=rxcui)

    for brand in ref.execute(
        "SELECT brand_name FROM drug_brands WHERE drug_id = ?",
        (drug_id,),
    ).fetchall():
        _insert_alias(ref, drug_id, brand["brand_name"], "drug_brand", matched_rxcui=rxcui)

    for syn in synonyms_of(rxcui, rx, limit=80):
        _insert_alias(ref, drug_id, syn["name"], "rxnorm", syn.get("tty"), rxcui)

    for brand in brands_of(rxcui, rx, limit=40):
        _insert_alias(ref, drug_id, brand["brand_name"], "rxnorm_brand", "BN", brand["brand_rxcui"])

    lowered = normalize_name(name)
    for key, aliases in HARDCODED_ALIASES.items():
        if normalize_name(key) == lowered:
            for alias in aliases:
                _insert_alias(ref, drug_id, alias, "clinical_alias", matched_rxcui=rxcui)

    ingredients = ingredients_of(rxcui, rx, limit=30)
    if not ingredients and (match.get("tty") in {"IN", "PIN", "MIN"}):
        ingredients = [{
            "ingredient_rxcui": rxcui,
            "ingredient_name": match.get("name") or name,
            "relation": "self",
        }]
    for ing in ingredients:
        ref.execute(
            """
            INSERT INTO drug_ingredients
                (drug_id, ingredient_rxcui, ingredient_name, strength, unit)
            VALUES (?,?,?,?,?)
            """,
            (drug_id, ing["ingredient_rxcui"], ing["ingredient_name"], None, None),
        )

    for atc in atc_of(rxcui, rx, limit=20):
        ref.execute(
            "INSERT INTO drug_atc (drug_id, atc_code, atc_name, level) VALUES (?,?,?,?)",
            (drug_id, atc["atc_code"], atc["atc_name"], atc["level"]),
        )

    for ndc in _best_ndc_rows(rx, rxcui, name):
        ref.execute(
            "INSERT INTO drug_ndc (drug_id, ndc, package_desc) VALUES (?,?,?)",
            (drug_id, ndc["ndc"], ndc["package_desc"]),
        )

    forms = _best_form_rows(rx, rxcui, name)
    for form in forms:
        ref.execute(
            "INSERT INTO drug_dose_forms (drug_id, dose_form, route, rxcui) VALUES (?,?,?,?)",
            (drug_id, form["dose_form"], form["route"], form["rxcui"]),
        )

    default_form = forms[0]["dose_form"] if forms else None
    default_route = forms[0]["route"] if forms else None
    is_combo = _is_combination_name(name)
    for strength in _best_strength_rows(rx, rxcui, name):
        if not is_combo and " / " in (strength["strength_text"] or ""):
            continue
        product_name = rx.execute(
            "SELECT name FROM rxn_best_names WHERE rxcui = ?",
            (strength["rxcui"],),
        ).fetchone()
        inferred_form = _infer_dose_form(product_name["name"] if product_name else None)
        ref.execute(
            """
            INSERT INTO drug_strengths
                (drug_id, rxcui, strength_num, strength_unit, strength_text, dose_form, route)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                drug_id,
                strength["rxcui"],
                strength["strength_num"],
                strength["strength_unit"],
                strength["strength_text"],
                inferred_form or default_form,
                default_route,
            ),
        )

    return match


def _rebuild_fts(ref: sqlite3.Connection) -> None:
    # Keep the historical FTS shape but feed aliases into the indications field
    # so old search queries automatically benefit.
    try:
        ref.execute("DELETE FROM drug_fts")
        ref.execute(
            """
            INSERT INTO drug_fts (drug_id, generic_name, brand_names, drug_class, indications)
            SELECT
                qi.drug_id,
                qi.generic_name,
                COALESCE(qi.brand_names, ''),
                COALESCE(qi.drug_class, ''),
                COALESCE(
                    (SELECT group_concat(alias, ' ')
                     FROM drug_aliases da
                     WHERE da.drug_id = qi.drug_id),
                    ''
                ) || ' ' || COALESCE(
                    (SELECT substr(ds.content_text, 1, 300)
                     FROM drug_sections ds
                     WHERE ds.drug_id = qi.drug_id AND ds.section_key = 'indications'
                     LIMIT 1),
                    ''
                )
            FROM drug_quick_info qi
            """
        )
    except sqlite3.Error:
        pass


def _dedupe_by_rxcui(ref: sqlite3.Connection) -> int:
    ref.execute("DELETE FROM rxnorm_dedupe_candidates")
    groups = ref.execute(
        """
        SELECT rxcui, group_concat(drug_id) AS ids
        FROM drugs
        WHERE COALESCE(rxcui, '') <> ''
        GROUP BY rxcui
        HAVING COUNT(*) > 1
        """
    ).fetchall()
    removed = 0
    for group in groups:
        ids = [int(x) for x in group["ids"].split(",") if x]
        survivor = min(ids)
        survivor_row = ref.execute(
            "SELECT generic_name FROM drugs WHERE drug_id = ?",
            (survivor,),
        ).fetchone()
        survivor_norm = normalize_name(survivor_row["generic_name"] if survivor_row else "")
        for old_id in ids:
            if old_id == survivor:
                continue
            old_row = ref.execute(
                "SELECT generic_name FROM drugs WHERE drug_id = ?",
                (old_id,),
            ).fetchone()
            old_name = old_row["generic_name"] if old_row else ""
            old_norm = normalize_name(old_name)
            if old_norm != survivor_norm:
                ref.execute(
                    """
                    INSERT INTO rxnorm_dedupe_candidates
                        (rxcui, survivor_drug_id, duplicate_drug_id, survivor_name,
                         duplicate_name, status, reason)
                    VALUES (?,?,?,?,?,?,?)
                    """,
                    (
                        group["rxcui"],
                        survivor,
                        old_id,
                        survivor_row["generic_name"] if survivor_row else "",
                        old_name,
                        "skipped_conflict",
                        "same RXCUI but different normalized monograph names",
                    ),
                )
                continue
            ref.execute(
                "INSERT OR REPLACE INTO drug_id_aliases (old_drug_id, new_drug_id, reason) VALUES (?,?,?)",
                (old_id, survivor, f"rxnorm dedupe {group['rxcui']}"),
            )
            for table in [
                "drug_sections", "drug_brands", "drug_icd", "drug_class_tags",
                "drug_ingredients", "drug_aliases", "drug_atc", "drug_ndc",
                "drug_dose_forms", "drug_strengths",
            ]:
                try:
                    ref.execute(f"UPDATE OR IGNORE {table} SET drug_id = ? WHERE drug_id = ?", (survivor, old_id))
                except sqlite3.Error:
                    pass
            ref.execute(
                """
                INSERT INTO rxnorm_dedupe_candidates
                    (rxcui, survivor_drug_id, duplicate_drug_id, survivor_name,
                     duplicate_name, status, reason)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    group["rxcui"],
                    survivor,
                    old_id,
                    survivor_row["generic_name"] if survivor_row else "",
                    old_name,
                    "merged",
                    "same RXCUI and same normalized monograph name",
                ),
            )
            ref.execute("DELETE FROM drugs WHERE drug_id = ?", (old_id,))
            removed += 1
    return removed


def link(drug_db: Path, rxnorm_db: Path, dedupe: bool) -> None:
    if not drug_db.exists():
        raise SystemExit(f"Drug reference DB not found: {drug_db}")
    if not rxnorm_db.exists():
        raise SystemExit(f"RxNorm DB not found: {rxnorm_db}. Run scripts/build_rxnorm.py first.")

    t0 = time.time()
    ref = _connect_rw(drug_db)
    rx = open_rxnorm(rxnorm_db)
    _exec_script(ref, SCHEMA_SQL)
    _add_column(ref, "drugs", "rxcui TEXT")
    _add_column(ref, "drugs", "rxcui_tty TEXT")
    _add_column(ref, "drugs", "coverage_tier INTEGER DEFAULT 0")
    _add_column(ref, "drugs", "coverage_status TEXT")
    _add_column(ref, "drugs", "rxnorm_match_method TEXT")
    _add_column(ref, "drugs", "rxnorm_match_score REAL")
    _add_column(ref, "drugs", "identity_kind TEXT")
    _add_column(ref, "drugs", "identity_warnings TEXT")
    ref.commit()

    for table in [
        "drug_ingredients", "drug_aliases", "drug_atc", "drug_ndc",
        "drug_dose_forms", "drug_strengths",
    ]:
        ref.execute(f"DELETE FROM {table}")
    ref.execute("DELETE FROM rxnorm_dedupe_candidates")
    ref.execute(
        """
        UPDATE drugs
        SET rxcui = NULL, rxcui_tty = NULL, coverage_tier = 0,
            coverage_status = NULL, rxnorm_match_method = NULL,
            rxnorm_match_score = NULL, identity_kind = NULL,
            identity_warnings = NULL
        """
    )
    ref.commit()

    drugs = ref.execute("SELECT drug_id, generic_name FROM drugs ORDER BY lower(generic_name)").fetchall()
    linked = 0
    for idx, drug in enumerate(drugs, 1):
        if _link_one(ref, rx, drug):
            linked += 1
        if idx % 250 == 0:
            ref.commit()
            print(f"  [{idx:>4}/{len(drugs)}] linked {linked}")

    removed = _dedupe_by_rxcui(ref) if dedupe else 0
    _rebuild_fts(ref)

    final_total = int(ref.execute("SELECT COUNT(*) FROM drugs").fetchone()[0])
    final_linked = int(ref.execute(
        "SELECT COUNT(*) FROM drugs WHERE COALESCE(rxcui, '') <> ''"
    ).fetchone()[0])
    dedupe_alias_count = int(ref.execute("SELECT COUNT(*) FROM drug_id_aliases").fetchone()[0])
    dedupe_skipped = int(ref.execute(
        "SELECT COUNT(*) FROM rxnorm_dedupe_candidates WHERE status = 'skipped_conflict'"
    ).fetchone()[0])
    match_rate = final_linked / final_total if final_total else 0
    ref.executemany(
        "INSERT OR REPLACE INTO build_meta (key, value) VALUES (?,?)",
        [
            ("rxnorm_db", str(rxnorm_db)),
            ("rxnorm_linked_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
            ("rxcui_match_count", str(final_linked)),
            ("rxcui_match_rate", f"{match_rate:.4f}"),
            ("rxcui_dedupe_removed", str(removed)),
            ("rxcui_dedupe_alias_count", str(dedupe_alias_count)),
            ("rxcui_dedupe_skipped_conflicts", str(dedupe_skipped)),
            ("rxnorm_link_input_drug_count", str(len(drugs))),
            ("rxnorm_link_input_match_count", str(linked)),
        ],
    )
    ref.commit()
    ref.execute("PRAGMA optimize")
    rx.close()
    ref.close()
    print(
        f"Linked {final_linked}/{final_total} drugs ({match_rate:.1%}); "
        f"dedupe removed {removed}, skipped {dedupe_skipped} conflicts."
    )
    print(f"Done in {time.time() - t0:.0f}s")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Link drug_reference.sqlite to RxNorm")
    parser.add_argument("--drug-db", type=Path, default=DRUG_REF_DB)
    parser.add_argument("--rxnorm-db", type=Path, default=RXNORM_DB)
    parser.add_argument("--dedupe", action="store_true", help="Merge duplicate drug rows by RXCUI")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    link(args.drug_db, args.rxnorm_db, args.dedupe)

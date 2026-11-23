from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path
from typing import Iterable

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from config import UMLS_DB, UMLS_META_DIR  # noqa: E402


KEEP_SOURCES = (
    "SNOMEDCT_US", "ICD10CM", "RXNORM", "LNC", "HPO", "OMIM", "ORPHANET",
    "MDR", "NCI", "MSH", "CHV", "MED-RT", "ATC", "FMA", "DRUGBANK",
    "MTHSPL", "HGNC", "CVX", "MTH",
)

SOURCE_RANK = {
    "SNOMEDCT_US": 10,
    "ICD10CM": 20,
    "RXNORM": 30,
    "LNC": 35,
    "HPO": 40,
    "OMIM": 45,
    "ORPHANET": 50,
    "MSH": 55,
    "NCI": 60,
    "MDR": 65,
    "MED-RT": 70,
    "ATC": 75,
    "DRUGBANK": 78,
    "FMA": 82,
    "CHV": 85,
    "MTHSPL": 90,
    "HGNC": 92,
    "CVX": 94,
    "MTH": 110,
}

TTY_RANK = {
    "PT": 0,
    "PN": 1,
    "MH": 2,
    "IN": 2,
    "MIN": 3,
    "SCD": 4,
    "SBD": 4,
    "SY": 5,
    "AB": 6,
    "ACR": 7,
}

SEMANTIC_GROUPS = {
    "T047": ("disease", 10),
    "T048": ("disease", 11),
    "T049": ("disease", 12),
    "T019": ("disease", 14),
    "T020": ("disease", 15),
    "T033": ("finding", 20),
    "T034": ("finding", 21),
    "T184": ("finding", 22),
    "T046": ("pathology", 24),
    "T121": ("drug", 30),
    "T109": ("drug", 31),
    "T200": ("drug", 32),
    "T061": ("procedure", 40),
    "T060": ("procedure", 41),
    "T059": ("lab", 45),
    "T201": ("lab", 46),
    "T023": ("anatomy", 50),
    "T024": ("anatomy", 51),
    "T025": ("anatomy", 52),
    "T026": ("anatomy", 53),
    "T028": ("gene", 55),
    "T116": ("substance", 60),
    "T123": ("substance", 61),
}

SCAN_GROUPS = {"disease", "finding", "pathology", "drug", "lab", "anatomy", "procedure", "gene"}
SCAN_STOP_TERMS = {
    "disease", "disorder", "finding", "patient", "patients", "procedure", "test",
    "measurement", "therapy", "treatment", "body", "structure", "clinical",
    "medical", "screening", "assessment", "finding of", "history of",
}

IMPORTANT_RELAS = {
    "may_treat", "may_prevent", "has_mechanism_of_action", "has_physiologic_effect",
    "has_finding_site", "finding_site_of", "has_associated_morphology",
    "associated_morphology_of", "has_manifestation", "manifestation_of",
    "has_phenotype", "phenotype_of", "disease_has_finding", "has_part", "part_of",
    "isa", "inverse_isa", "mapped_to", "associated_with", "causative_agent",
    "causative_agent_of", "contraindicated_with_disease", "may_diagnose",
}
IMPORTANT_RELS = {"PAR", "CHD", "RB", "RN", "RO", "SY"}

_NON_KEY_RE = re.compile(r"[^a-z0-9]+")
_WS_RE = re.compile(r"\s+")


DDL = """
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
PRAGMA temp_store=MEMORY;

CREATE TABLE umls_sources (
  sab TEXT PRIMARY KEY,
  vsab TEXT NOT NULL,
  official_name TEXT NOT NULL,
  restriction_level INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE umls_terms (
  cui TEXT NOT NULL,
  term TEXT NOT NULL,
  term_norm TEXT NOT NULL,
  sab TEXT NOT NULL,
  tty TEXT NOT NULL,
  code TEXT NOT NULL,
  is_pref INTEGER NOT NULL DEFAULT 0,
  source_rank INTEGER NOT NULL DEFAULT 999,
  tty_rank INTEGER NOT NULL DEFAULT 99,
  suppress TEXT NOT NULL DEFAULT 'N',
  is_scan_term INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE umls_semantic_types (
  cui TEXT NOT NULL,
  tui TEXT NOT NULL,
  sty TEXT NOT NULL,
  semantic_group TEXT NOT NULL DEFAULT '',
  group_rank INTEGER NOT NULL DEFAULT 999
);

CREATE TABLE umls_definitions (
  cui TEXT NOT NULL,
  sab TEXT NOT NULL,
  definition TEXT NOT NULL,
  source_rank INTEGER NOT NULL DEFAULT 999
);

CREATE TABLE umls_codes (
  cui TEXT NOT NULL,
  sab TEXT NOT NULL,
  code TEXT NOT NULL,
  term TEXT NOT NULL,
  tty TEXT NOT NULL,
  source_rank INTEGER NOT NULL DEFAULT 999
);

CREATE TABLE umls_concepts (
  cui TEXT PRIMARY KEY,
  preferred_name TEXT NOT NULL,
  preferred_source TEXT NOT NULL,
  semantic_types_json TEXT NOT NULL DEFAULT '[]',
  semantic_group TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  source_count INTEGER NOT NULL DEFAULT 0,
  term_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE umls_relations (
  cui1 TEXT NOT NULL,
  cui2 TEXT NOT NULL,
  rel TEXT NOT NULL,
  rela TEXT NOT NULL,
  sab TEXT NOT NULL,
  source_rank INTEGER NOT NULL DEFAULT 999
);

CREATE TABLE umls_hpo_disease_links (
  phenotype_cui TEXT NOT NULL,
  disease_cui TEXT NOT NULL,
  relation TEXT NOT NULL,
  sab TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE umls_scan_terms (
  term TEXT NOT NULL,
  term_norm TEXT NOT NULL,
  cui TEXT NOT NULL,
  semantic_group TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term_norm, cui)
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_umls_terms_norm ON umls_terms(term_norm);
CREATE INDEX IF NOT EXISTS idx_umls_terms_cui ON umls_terms(cui);
CREATE INDEX IF NOT EXISTS idx_umls_terms_sab ON umls_terms(sab);
CREATE INDEX IF NOT EXISTS idx_umls_sem_cui ON umls_semantic_types(cui);
CREATE INDEX IF NOT EXISTS idx_umls_def_cui ON umls_definitions(cui);
CREATE INDEX IF NOT EXISTS idx_umls_codes_code ON umls_codes(upper(code));
CREATE INDEX IF NOT EXISTS idx_umls_codes_cui ON umls_codes(cui);
CREATE INDEX IF NOT EXISTS idx_umls_rel_cui1 ON umls_relations(cui1);
CREATE INDEX IF NOT EXISTS idx_umls_rel_cui2 ON umls_relations(cui2);
CREATE INDEX IF NOT EXISTS idx_umls_hpo_pheno ON umls_hpo_disease_links(phenotype_cui);
CREATE INDEX IF NOT EXISTS idx_umls_hpo_disease ON umls_hpo_disease_links(disease_cui);
CREATE INDEX IF NOT EXISTS idx_umls_scan_norm ON umls_scan_terms(term_norm);
CREATE VIRTUAL TABLE umls_terms_fts USING fts5(
  term,
  preferred_name,
  definition,
  content='umls_terms',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2',
  prefix='2 3 4'
);
INSERT INTO umls_terms_fts(rowid, term, preferred_name, definition)
SELECT t.rowid, t.term, c.preferred_name, c.definition
FROM umls_terms t
JOIN umls_concepts c ON c.cui=t.cui;
"""


def norm(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    return _WS_RE.sub(" ", _NON_KEY_RE.sub(" ", text)).strip()


def clean(value: str | None) -> str:
    return _WS_RE.sub(" ", value or "").strip()


def split_rrf(line: str) -> list[str]:
    return line.rstrip("\n").split("|")


def progress(label: str, count: int, every: int = 1_000_000) -> None:
    if count and count % every == 0:
        print(f"  {label}: {count:,}", flush=True)


def batched_insert(con: sqlite3.Connection, sql: str, rows: Iterable[tuple], batch_size: int = 50_000) -> int:
    batch: list[tuple] = []
    total = 0
    for row in rows:
        batch.append(row)
        if len(batch) >= batch_size:
            con.executemany(sql, batch)
            total += len(batch)
            batch.clear()
    if batch:
        con.executemany(sql, batch)
        total += len(batch)
    return total


def source_set(raw: str) -> set[str]:
    if not raw:
        return set(KEEP_SOURCES)
    return {item.strip().upper() for item in raw.split(",") if item.strip()}


def load_sources(con: sqlite3.Connection, meta_dir: Path, keep_sources: set[str]) -> dict[str, int]:
    path = meta_dir / "MRSAB.RRF"
    rows = []
    ranks = dict(SOURCE_RANK)
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        for line in fh:
            p = split_rrf(line)
            if len(p) < 24:
                continue
            vsab = p[2]
            sab = p[3].upper()
            if sab not in keep_sources:
                continue
            official = p[4] or p[23] or sab
            try:
                srl = int(p[16] or 0)
            except ValueError:
                srl = 0
            lat = p[19] if len(p) > 19 else ""
            active = 1 if (len(p) < 22 or p[21] == "Y") else 0
            ranks.setdefault(sab, 100)
            rows.append((sab, vsab, official, srl, lat, active))
    con.executemany(
        """
        INSERT OR REPLACE INTO umls_sources(sab, vsab, official_name, restriction_level, language, active)
        VALUES(?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    return ranks


def iter_terms(meta_dir: Path, keep_sources: set[str], ranks: dict[str, int], max_lines: int | None = None):
    path = meta_dir / "MRCONSO.RRF"
    seen_lines = 0
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        for line in fh:
            seen_lines += 1
            if max_lines and seen_lines > max_lines:
                break
            progress("MRCONSO scanned", seen_lines)
            p = split_rrf(line)
            if len(p) < 18:
                continue
            cui, lat, ts, _lui, _stt, _sui, ispref, _aui, _saui, _scui, _sdui, sab, tty, code, term, _srl, suppress = p[:17]
            sab = sab.upper()
            if lat != "ENG" or sab not in keep_sources:
                continue
            if suppress not in {"N", ""}:
                continue
            term = clean(term)
            term_norm = norm(term)
            if not term or not term_norm:
                continue
            yield (
                cui,
                term,
                term_norm,
                sab,
                tty,
                code if code and code != "NOCODE" else "",
                1 if ispref == "Y" or ts == "P" else 0,
                ranks.get(sab, 999),
                TTY_RANK.get(tty, 99),
                suppress or "N",
                0,
            )


def iter_semantic(meta_dir: Path, max_lines: int | None = None):
    path = meta_dir / "MRSTY.RRF"
    seen = 0
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        for line in fh:
            seen += 1
            if max_lines and seen > max_lines:
                break
            progress("MRSTY scanned", seen)
            p = split_rrf(line)
            if len(p) < 4:
                continue
            cui, tui, _stn, sty = p[:4]
            group, rank = SEMANTIC_GROUPS.get(tui, ("", 999))
            yield (cui, tui, sty, group, rank)


def iter_definitions(meta_dir: Path, keep_sources: set[str], ranks: dict[str, int], max_lines: int | None = None):
    path = meta_dir / "MRDEF.RRF"
    seen = 0
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        for line in fh:
            seen += 1
            if max_lines and seen > max_lines:
                break
            progress("MRDEF scanned", seen)
            p = split_rrf(line)
            if len(p) < 7:
                continue
            cui, _aui, _atui, _satui, sab, definition, suppress = p[:7]
            sab = sab.upper()
            if sab not in keep_sources or suppress not in {"N", ""}:
                continue
            definition = clean(definition)
            if definition:
                yield (cui, sab, definition, ranks.get(sab, 999))


def relation_rows(
    meta_dir: Path,
    keep_sources: set[str],
    ranks: dict[str, int],
    kept_cuis: set[str],
    max_lines: int | None = None,
):
    path = meta_dir / "MRREL.RRF"
    seen = 0
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        for line in fh:
            seen += 1
            if max_lines and seen > max_lines:
                break
            progress("MRREL scanned", seen)
            p = split_rrf(line)
            if len(p) < 15:
                continue
            cui1, _aui1, _stype1, rel, cui2, _aui2, _stype2, rela, _rui, _srui, sab, _sl, _rg, _dir, suppress = p[:15]
            sab = sab.upper()
            rela = rela or ""
            if sab not in keep_sources or suppress not in {"N", ""}:
                continue
            if cui1 not in kept_cuis or cui2 not in kept_cuis or cui1 == cui2:
                continue
            if rel not in IMPORTANT_RELS and rela not in IMPORTANT_RELAS:
                continue
            yield (cui1, cui2, rel, rela, sab, ranks.get(sab, 999))


def build_concepts(con: sqlite3.Connection) -> None:
    con.execute("CREATE INDEX IF NOT EXISTS idx_umls_terms_cui ON umls_terms(cui)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_umls_sem_cui ON umls_semantic_types(cui)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_umls_def_cui ON umls_definitions(cui)")
    con.commit()
    print("  pruning semantic/definition rows to kept CUIs")
    con.execute("DELETE FROM umls_semantic_types WHERE cui NOT IN (SELECT DISTINCT cui FROM umls_terms)")
    con.execute("DELETE FROM umls_definitions WHERE cui NOT IN (SELECT DISTINCT cui FROM umls_terms)")
    con.execute("DELETE FROM umls_codes")
    con.execute(
        """
        INSERT INTO umls_codes(cui, sab, code, term, tty, source_rank)
        SELECT cui, sab, code, term, tty, source_rank
        FROM umls_terms
        WHERE code != ''
        GROUP BY cui, sab, code
        """
    )
    con.commit()

    print("  materializing concept table")
    con.execute("DROP TABLE IF EXISTS _best_term")
    con.execute(
        """
        CREATE TEMP TABLE _best_term AS
        SELECT cui, term, sab
        FROM (
          SELECT cui, term, sab,
                 ROW_NUMBER() OVER (
                   PARTITION BY cui
                   ORDER BY source_rank ASC, is_pref DESC, tty_rank ASC, length(term) ASC, term
                 ) AS rn
          FROM umls_terms
        )
        WHERE rn=1
        """
    )
    con.execute("DROP TABLE IF EXISTS _sem")
    con.execute(
        """
        CREATE TEMP TABLE _sem AS
        SELECT cui,
               '[' || GROUP_CONCAT(json_quote(sty)) || ']' AS semantic_types_json,
               COALESCE((SELECT semantic_group
                         FROM umls_semantic_types s2
                         WHERE s2.cui=s.cui AND s2.semantic_group != ''
                         ORDER BY group_rank ASC
                         LIMIT 1), '') AS semantic_group
        FROM umls_semantic_types s
        GROUP BY cui
        """
    )
    con.execute("DROP TABLE IF EXISTS _def")
    con.execute(
        """
        CREATE TEMP TABLE _def AS
        SELECT cui, definition
        FROM (
          SELECT cui, definition,
                 ROW_NUMBER() OVER (
                   PARTITION BY cui
                   ORDER BY source_rank ASC, length(definition) DESC
                 ) AS rn
          FROM umls_definitions
        )
        WHERE rn=1
        """
    )
    con.execute("DROP TABLE IF EXISTS _counts")
    con.execute(
        """
        CREATE TEMP TABLE _counts AS
        SELECT cui, COUNT(*) AS term_count, COUNT(DISTINCT sab) AS source_count
        FROM umls_terms
        GROUP BY cui
        """
    )
    con.execute("DELETE FROM umls_concepts")
    con.execute(
        """
        INSERT INTO umls_concepts(
          cui, preferred_name, preferred_source, semantic_types_json, semantic_group,
          definition, source_count, term_count
        )
        SELECT bt.cui, bt.term, bt.sab,
               COALESCE(s.semantic_types_json, '[]'),
               COALESCE(s.semantic_group, ''),
               COALESCE(d.definition, ''),
               COALESCE(cnt.source_count, 0),
               COALESCE(cnt.term_count, 0)
        FROM _best_term bt
        LEFT JOIN _sem s ON s.cui=bt.cui
        LEFT JOIN _def d ON d.cui=bt.cui
        LEFT JOIN _counts cnt ON cnt.cui=bt.cui
        """
    )
    con.commit()


def scan_term_ok(term: str, term_norm: str, semantic_group: str) -> bool:
    if semantic_group not in SCAN_GROUPS:
        return False
    if not term_norm or term_norm in SCAN_STOP_TERMS:
        return False
    if len(term_norm) < 4 or len(term_norm) > 90:
        return False
    words = term_norm.split()
    if len(words) > 7:
        return False
    if len(words) == 1 and len(words[0]) < 5 and not term.isupper():
        return False
    if re.search(r"\([^)]{1,40}\)", term):
        return False
    if term_norm.startswith(("structure of ", "entire ", "specimen from ")):
        return False
    return True


def build_scan_terms(con: sqlite3.Connection, scan_limit: int) -> int:
    print("  building bounded UMLS scan dictionary")
    rows = con.execute(
        """
        SELECT t.term, t.term_norm, t.cui, c.semantic_group, t.sab, t.is_pref,
               t.source_rank, t.tty_rank, c.definition
        FROM umls_terms t
        JOIN umls_concepts c ON c.cui=t.cui
        WHERE c.semantic_group != ''
          AND length(t.term_norm) BETWEEN 4 AND 90
        ORDER BY t.source_rank ASC, t.is_pref DESC, t.tty_rank ASC, length(t.term) DESC
        LIMIT ?
        """,
        (max(scan_limit * 12, scan_limit),),
    ).fetchall()
    out = []
    seen: set[str] = set()
    for row in rows:
        term = row["term"]
        term_norm = row["term_norm"]
        group = row["semantic_group"]
        if term_norm in seen or not scan_term_ok(term, term_norm, group):
            continue
        seen.add(term_norm)
        priority = 1000 - int(row["source_rank"] or 999)
        priority += 40 if row["is_pref"] else 0
        priority += 20 if row["definition"] else 0
        priority += min(len(term_norm), 80) / 4
        case_sensitive = 1 if term.isupper() and len(term_norm) <= 8 else 0
        out.append((term, term_norm, row["cui"], group, float(priority), case_sensitive))
        if len(out) >= scan_limit:
            break
    con.executemany(
        """
        INSERT OR REPLACE INTO umls_scan_terms(term, term_norm, cui, semantic_group, priority, case_sensitive)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        out,
    )
    con.execute(
        "UPDATE umls_terms SET is_scan_term=1 WHERE term_norm IN (SELECT term_norm FROM umls_scan_terms)"
    )
    con.commit()
    return len(out)


def build_hpo_links(con: sqlite3.Connection) -> int:
    print("  deriving phenotype-disease links")
    con.execute("DELETE FROM umls_hpo_disease_links")
    con.execute(
        """
        INSERT INTO umls_hpo_disease_links(phenotype_cui, disease_cui, relation, sab, score)
        SELECT r.cui1, r.cui2, COALESCE(NULLIF(r.rela, ''), r.rel), r.sab,
               CASE r.sab
                 WHEN 'OMIM' THEN 2.0
                 WHEN 'ORPHANET' THEN 2.0
                 WHEN 'HPO' THEN 1.6
                 WHEN 'NCI' THEN 1.1
                 WHEN 'SNOMEDCT_US' THEN 0.7
                 ELSE 1.0
               END
        FROM umls_relations r
        JOIN umls_concepts p ON p.cui=r.cui1
        JOIN umls_concepts d ON d.cui=r.cui2
        WHERE p.semantic_group IN ('finding', 'pathology')
          AND d.semantic_group='disease'
          AND r.sab IN ('HPO', 'OMIM', 'ORPHANET', 'SNOMEDCT_US', 'NCI')
          AND COALESCE(NULLIF(r.rela, ''), r.rel) IN (
            'has_manifestation', 'manifestation_of',
            'has_phenotype', 'phenotype_of',
            'disease_has_finding', 'is_finding_of_disease',
            'associated_with'
          )
        UNION
        SELECT r.cui2, r.cui1, COALESCE(NULLIF(r.rela, ''), r.rel), r.sab,
               CASE r.sab
                 WHEN 'OMIM' THEN 2.0
                 WHEN 'ORPHANET' THEN 2.0
                 WHEN 'HPO' THEN 1.6
                 WHEN 'NCI' THEN 1.1
                 WHEN 'SNOMEDCT_US' THEN 0.7
                 ELSE 1.0
               END
        FROM umls_relations r
        JOIN umls_concepts p ON p.cui=r.cui2
        JOIN umls_concepts d ON d.cui=r.cui1
        WHERE p.semantic_group IN ('finding', 'pathology')
          AND d.semantic_group='disease'
          AND r.sab IN ('HPO', 'OMIM', 'ORPHANET', 'SNOMEDCT_US', 'NCI')
          AND COALESCE(NULLIF(r.rela, ''), r.rel) IN (
            'has_manifestation', 'manifestation_of',
            'has_phenotype', 'phenotype_of',
            'disease_has_finding', 'is_finding_of_disease',
            'associated_with'
          )
        """
    )
    count = con.execute("SELECT COUNT(*) FROM umls_hpo_disease_links").fetchone()[0]
    con.commit()
    return int(count)


def write_meta(con: sqlite3.Connection, meta: dict[str, str]) -> None:
    con.executemany(
        "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
        [(k, str(v)) for k, v in meta.items()],
    )
    con.commit()


def build(args: argparse.Namespace) -> Path:
    started = time.perf_counter()
    meta_dir = Path(args.meta_dir)
    if not (meta_dir / "MRCONSO.RRF").exists():
        raise SystemExit(f"MRCONSO.RRF not found under {meta_dir}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()

    keep_sources = source_set(args.sources)
    print(f"Building UMLS compact DB -> {out}")
    print(f"Sources: {', '.join(sorted(keep_sources))}")

    con = sqlite3.connect(str(tmp))
    con.row_factory = sqlite3.Row
    try:
        con.executescript(DDL)
        ranks = load_sources(con, meta_dir, keep_sources)

        term_count = batched_insert(
            con,
            """
            INSERT INTO umls_terms(
              cui, term, term_norm, sab, tty, code, is_pref, source_rank,
              tty_rank, suppress, is_scan_term
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            iter_terms(meta_dir, keep_sources, ranks, args.max_mrconso_lines),
            args.batch_size,
        )
        con.commit()
        print(f"  terms kept: {term_count:,}")

        sem_count = batched_insert(
            con,
            """
            INSERT INTO umls_semantic_types(cui, tui, sty, semantic_group, group_rank)
            VALUES (?, ?, ?, ?, ?)
            """,
            iter_semantic(meta_dir, args.max_mrsty_lines),
            args.batch_size,
        )
        con.commit()
        print(f"  semantic rows staged: {sem_count:,}")

        def_count = batched_insert(
            con,
            "INSERT INTO umls_definitions(cui, sab, definition, source_rank) VALUES (?, ?, ?, ?)",
            iter_definitions(meta_dir, keep_sources, ranks, args.max_mrdef_lines),
            args.batch_size,
        )
        con.commit()
        print(f"  definitions staged: {def_count:,}")

        build_concepts(con)
        concept_count = con.execute("SELECT COUNT(*) FROM umls_concepts").fetchone()[0]
        print(f"  concepts materialized: {concept_count:,}")

        rel_count = 0
        hpo_count = 0
        if args.with_relations:
            print("  loading kept CUI set for relation pass")
            kept_cuis = {row["cui"] for row in con.execute("SELECT cui FROM umls_concepts")}
            rel_count = batched_insert(
                con,
                "INSERT INTO umls_relations(cui1, cui2, rel, rela, sab, source_rank) VALUES (?, ?, ?, ?, ?, ?)",
                relation_rows(meta_dir, keep_sources, ranks, kept_cuis, args.max_mrrel_lines),
                args.batch_size,
            )
            con.commit()
            print(f"  relations kept: {rel_count:,}")
            hpo_count = build_hpo_links(con)
            print(f"  phenotype-disease links: {hpo_count:,}")

        scan_count = build_scan_terms(con, args.scan_limit)
        print(f"  scan terms: {scan_count:,}")

        print("  creating indexes + FTS")
        con.executescript(INDEX_DDL)
        write_meta(con, {
            "built_at": int(time.time()),
            "release": "2026AA",
            "source_count": len(keep_sources),
            "term_count": term_count,
            "concept_count": concept_count,
            "definition_count": def_count,
            "relation_count": rel_count,
            "hpo_disease_link_count": hpo_count,
            "scan_term_count": scan_count,
            "build_seconds": round(time.perf_counter() - started, 2),
        })
        con.execute("PRAGMA optimize")
        con.commit()
    finally:
        con.close()

    if out.exists():
        backup = out.with_suffix(out.suffix + ".bak")
        if backup.exists():
            backup.unlink()
        out.replace(backup)
    tmp.replace(out)
    print(f"Done: {out} in {(time.perf_counter() - started):.1f}s")
    return out


def archive_unused_language_indexes(meta_dir: Path, archive_dir: Path) -> list[Path]:
    meta_resolved = meta_dir.resolve()
    archive_resolved = archive_dir.resolve()
    if meta_resolved not in archive_resolved.parents and archive_resolved != meta_resolved:
        # The archive is allowed outside META only if it remains under the UMLS release root.
        release_root = meta_resolved.parent.resolve()
        if release_root not in archive_resolved.parents and archive_resolved != release_root:
            raise ValueError(f"Archive target is outside the UMLS release: {archive_dir}")
    archive_dir.mkdir(parents=True, exist_ok=True)
    moved: list[Path] = []
    for path in meta_dir.glob("MRXW_*.*"):
        name = path.name.upper()
        if name.startswith("MRXW_ENG."):
            continue
        target = archive_dir / path.name
        if target.exists():
            continue
        shutil.move(str(path), str(target))
        moved.append(target)
    return moved


def main() -> None:
    parser = argparse.ArgumentParser(description="Build compact MedOS UMLS SQLite from META/*.RRF")
    parser.add_argument("--meta-dir", default=str(UMLS_META_DIR))
    parser.add_argument("--out", default=str(UMLS_DB))
    parser.add_argument("--sources", default=",".join(KEEP_SOURCES))
    parser.add_argument("--with-relations", action="store_true", help="Parse MRREL for graph, HPO differential, and relation rails.")
    parser.add_argument("--batch-size", type=int, default=50_000)
    parser.add_argument("--scan-limit", type=int, default=45_000)
    parser.add_argument("--archive-unused-language-indexes", action="store_true")
    parser.add_argument("--archive-dir", default="")
    parser.add_argument("--max-mrconso-lines", type=int, default=None, help="Smoke-test limit; omit for production.")
    parser.add_argument("--max-mrsty-lines", type=int, default=None, help="Smoke-test limit; omit for production.")
    parser.add_argument("--max-mrdef-lines", type=int, default=None, help="Smoke-test limit; omit for production.")
    parser.add_argument("--max-mrrel-lines", type=int, default=None, help="Smoke-test limit; omit for production.")
    args = parser.parse_args()

    out = build(args)
    if args.archive_unused_language_indexes:
        archive_dir = Path(args.archive_dir) if args.archive_dir else Path(args.meta_dir).parent / "archive_non_english_indexes"
        moved = archive_unused_language_indexes(Path(args.meta_dir), archive_dir)
        print(f"Archived {len(moved)} non-English MRXW files after building {out}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Build a slim, phone-sized umls_lite.sqlite from the full 4.5 GB data/umls.sqlite.

The phone only needs UMLS to: resolve a term -> CUI, show the preferred name +
definition, list ICD/SNOMED codes, list synonyms, and autocomplete. None of that
needs the 18M-row umls_relations or the full 5M umls_terms.

CUI universe U = every CUI that MedOS content references
    (content_concepts  UNION  paragraph_concepts)
  + the curated 200K-term scan vocabulary (umls_scan_terms)
so terms the owner might hover/search still resolve even if not tagged yet.

Output: data/umls_lite.sqlite  (concepts, terms+FTS, codes (ICD/SNOMED/RXNORM/MSH),
definitions, scan_terms, meta).  Target <= ~400 MB.

Run:  .venv/Scripts/python.exe app/backend/scripts/build_umls_lite.py
"""
from __future__ import annotations
import os, sqlite3, sys, time

DATA = r"D:/MedOS/data"
SRC = f"{DATA}/umls.sqlite"
CONTENT = f"{DATA}/content_concepts.sqlite"
PARAGRAPH = f"{DATA}/paragraph_concepts.sqlite"
OUT = f"{DATA}/umls_lite.sqlite"

# Code vocabularies worth keeping on the phone (ICD = the owner's ask; SNOMED for
# clinical linkage; RXNORM to bridge drugs; MSH for MeSH cross-refs).
KEEP_SABS = ("ICD10CM", "ICD10", "ICD9CM", "SNOMEDCT_US", "RXNORM", "MSH")


def log(msg: str) -> None:
    print(f"[umls_lite] {msg}", flush=True)


def main() -> None:
    for p in (SRC, CONTENT, PARAGRAPH):
        if not os.path.exists(p):
            sys.exit(f"missing source: {p}")
    if os.path.exists(OUT):
        os.remove(OUT)

    t0 = time.time()
    db = sqlite3.connect(OUT)
    db.executescript(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA page_size=4096;"
    )
    db.execute(f"ATTACH DATABASE '{SRC}' AS src")
    db.execute(f"ATTACH DATABASE '{CONTENT}' AS cc")
    db.execute(f"ATTACH DATABASE '{PARAGRAPH}' AS pc")

    # ── CUI universe ────────────────────────────────────────────────────────
    db.execute("CREATE TABLE u(cui TEXT PRIMARY KEY)")
    db.execute("INSERT OR IGNORE INTO u SELECT DISTINCT cui FROM cc.content_concepts WHERE cui IS NOT NULL")
    db.execute("INSERT OR IGNORE INTO u SELECT DISTINCT cui FROM pc.paragraph_concepts WHERE cui IS NOT NULL")
    db.execute("INSERT OR IGNORE INTO u SELECT DISTINCT cui FROM src.umls_scan_terms WHERE cui IS NOT NULL")
    n_u = db.execute("SELECT count(*) FROM u").fetchone()[0]
    log(f"CUI universe: {n_u:,}")

    # ── Concepts ────────────────────────────────────────────────────────────
    db.execute(
        """CREATE TABLE umls_concepts AS
           SELECT c.cui, c.preferred_name, c.preferred_source, c.semantic_types_json,
                  c.semantic_group, c.definition, c.source_count, c.term_count
           FROM src.umls_concepts c JOIN u ON u.cui = c.cui"""
    )
    log(f"concepts: {db.execute('SELECT count(*) FROM umls_concepts').fetchone()[0]:,}")

    # ── Terms (synonyms) — drop suppressed ──────────────────────────────────
    db.execute(
        """CREATE TABLE umls_terms AS
           SELECT t.cui, t.term, t.term_norm, t.sab, t.tty, t.is_pref, t.source_rank
           FROM src.umls_terms t JOIN u ON u.cui = t.cui
           WHERE COALESCE(t.suppress,'N') NOT IN ('O','E','Y')"""
    )
    log(f"terms: {db.execute('SELECT count(*) FROM umls_terms').fetchone()[0]:,}")

    # ── Codes — only the useful vocabularies ────────────────────────────────
    qmarks = ",".join("?" for _ in KEEP_SABS)
    db.execute(
        f"""CREATE TABLE umls_codes AS
            SELECT cd.cui, cd.sab, cd.code, cd.term, cd.tty
            FROM src.umls_codes cd JOIN u ON u.cui = cd.cui
            WHERE cd.sab IN ({qmarks})""",
        KEEP_SABS,
    )
    log(f"codes: {db.execute('SELECT count(*) FROM umls_codes').fetchone()[0]:,}")

    # ── Definitions (top 2 per CUI by source_rank) ──────────────────────────
    db.execute(
        """CREATE TABLE umls_definitions AS
           SELECT cui, sab, definition, source_rank FROM (
             SELECT d.cui, d.sab, d.definition, d.source_rank,
                    ROW_NUMBER() OVER (PARTITION BY d.cui ORDER BY d.source_rank) AS rn
             FROM src.umls_definitions d JOIN u ON u.cui = d.cui
           ) WHERE rn <= 2"""
    )
    log(f"definitions: {db.execute('SELECT count(*) FROM umls_definitions').fetchone()[0]:,}")

    # ── Curated scan vocabulary (term -> CUI resolver), shipped as-is ───────
    db.execute(
        """CREATE TABLE umls_scan_terms AS
           SELECT term, term_norm, cui, semantic_group, priority, case_sensitive
           FROM src.umls_scan_terms"""
    )
    log(f"scan_terms: {db.execute('SELECT count(*) FROM umls_scan_terms').fetchone()[0]:,}")

    # ── meta ────────────────────────────────────────────────────────────────
    db.execute("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)")
    db.executemany("INSERT OR REPLACE INTO meta VALUES(?,?)", [
        ("schema", "umls_lite/1"),
        ("cui_universe", str(n_u)),
        ("kept_sabs", ",".join(KEEP_SABS)),
    ])

    db.execute("DROP TABLE u")
    db.commit()

    # ── Indexes + FTS for resolve/autocomplete ──────────────────────────────
    log("indexing…")
    db.executescript(
        """
        CREATE INDEX idx_terms_cui ON umls_terms(cui);
        CREATE INDEX idx_terms_norm ON umls_terms(term_norm);
        CREATE INDEX idx_codes_cui ON umls_codes(cui);
        CREATE INDEX idx_defs_cui ON umls_definitions(cui);
        CREATE INDEX idx_scan_norm ON umls_scan_terms(term_norm);
        CREATE INDEX idx_scan_cui ON umls_scan_terms(cui);
        """
    )
    # FTS5 over terms for fuzzy search / autocomplete (rowid -> umls_terms.rowid).
    db.execute("CREATE VIRTUAL TABLE umls_terms_fts USING fts5(term, content='umls_terms', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2')")
    db.execute("INSERT INTO umls_terms_fts(rowid, term) SELECT rowid, term FROM umls_terms")
    db.commit()

    log("ANALYZE + VACUUM…")
    db.execute("ANALYZE")
    db.execute("VACUUM")
    db.close()

    size = os.path.getsize(OUT) / (1024 * 1024)
    log(f"DONE -> {OUT}  ({size:.1f} MB)  in {time.time()-t0:.0f}s")

    # ── Validation ──────────────────────────────────────────────────────────
    v = sqlite3.connect(OUT)
    v.row_factory = sqlite3.Row
    row = v.execute(
        "SELECT cui, preferred_name FROM umls_concepts WHERE cui IN "
        "(SELECT cui FROM umls_scan_terms WHERE term_norm='myocardial infarction' LIMIT 1)"
    ).fetchone()
    if row:
        codes = v.execute(
            "SELECT sab, code FROM umls_codes WHERE cui=? AND sab LIKE 'ICD%' LIMIT 5", (row["cui"],)
        ).fetchall()
        syn = v.execute("SELECT count(*) FROM umls_terms WHERE cui=?", (row["cui"],)).fetchone()[0]
        log(f"validate: 'myocardial infarction' -> {row['cui']} ({row['preferred_name']}); "
            f"ICD codes={[(c['sab'], c['code']) for c in codes]}; synonyms={syn}")
    else:
        log("validate: WARNING — 'myocardial infarction' did not resolve")
    v.close()


if __name__ == "__main__":
    main()

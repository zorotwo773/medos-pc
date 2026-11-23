from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from config import CONCEPT_LINKS_DB, ROOT, UMLS_DB  # noqa: E402
import umls_reader  # noqa: E402


GLOBAL_SEARCH_DB = ROOT / "data" / "global_search.sqlite"
OUT_DB = ROOT / "data" / "content_concepts.sqlite"


DDL = """
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
CREATE TABLE content_concepts (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  href TEXT NOT NULL,
  cui TEXT NOT NULL,
  preferred_name TEXT NOT NULL,
  semantic_group TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source, source_id, cui)
);
CREATE INDEX idx_content_concepts_source ON content_concepts(source, source_id);
CREATE INDEX idx_content_concepts_cui ON content_concepts(cui, confidence DESC);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def quote_path(path: Path) -> str:
    return str(path).replace("'", "''")


def build(output: Path = OUT_DB, append_concept_links: bool = False, per_cui_limit: int = 8) -> int:
    if not UMLS_DB.exists():
        raise SystemExit(f"UMLS DB not found: {UMLS_DB}. Build it first with scripts/umls/build_umls.py")
    if not GLOBAL_SEARCH_DB.exists():
        raise SystemExit(f"Global search DB not found: {GLOBAL_SEARCH_DB}. Build it first with build_global_search_index.py")

    started = time.perf_counter()
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(str(tmp))
    con.row_factory = sqlite3.Row
    try:
        con.executescript(DDL)
        con.execute(f"ATTACH DATABASE '{quote_path(GLOBAL_SEARCH_DB)}' AS gs")
        con.execute(f"ATTACH DATABASE '{quote_path(UMLS_DB)}' AS u")
        now = int(time.time())

        con.execute(
            """
            INSERT OR REPLACE INTO content_concepts(
              source, source_id, title, href, cui, preferred_name, semantic_group,
              confidence, method, updated_at
            )
            SELECT e.source, e.external_id, e.title, e.href, t.cui, c.preferred_name,
                   c.semantic_group,
                   CASE
                     WHEN lower(e.title)=lower(c.preferred_name) THEN 1.0
                     WHEN c.definition != '' THEN 0.94
                     ELSE 0.90
                   END AS confidence,
                   'title_exact' AS method,
                   ? AS updated_at
            FROM gs.entries e
            JOIN u.umls_terms t ON t.term_norm=e.title_norm
            JOIN u.umls_concepts c ON c.cui=t.cui
            WHERE c.semantic_group != ''
              AND e.source IN ('amboss','utd','uworld','books','qbank','diseases','anatomy','drugs','firstaid','calc','lexi','sanford','utdddx')
              AND length(e.title_norm) >= 4
            """,
            (now,),
        )
        exact_count = con.execute("SELECT COUNT(*) FROM content_concepts").fetchone()[0]

        con.execute(
            """
            INSERT OR IGNORE INTO meta(key, value) VALUES
              ('built_at', ?),
              ('method', 'global_search_title_exact_to_umls'),
              ('exact_rows', ?)
            """,
            (str(now), str(exact_count)),
        )
        con.commit()

        if append_concept_links:
            append_exact_concept_links(con, per_cui_limit)
    finally:
        con.close()
    if output.exists():
        output.unlink()
    tmp.replace(output)
    print(f"Built {output} with {exact_count:,} exact CUI tags in {(time.perf_counter() - started):.1f}s")
    return int(exact_count)


def append_exact_concept_links(tag_con: sqlite3.Connection, per_cui_limit: int) -> int:
    if not CONCEPT_LINKS_DB.exists():
        return 0
    c = sqlite3.connect(str(CONCEPT_LINKS_DB))
    c.row_factory = sqlite3.Row
    try:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS concept_links (
              source_a TEXT NOT NULL,
              id_a TEXT NOT NULL,
              title_a TEXT NOT NULL,
              source_b TEXT NOT NULL,
              id_b TEXT NOT NULL,
              title_b TEXT NOT NULL,
              similarity REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cl_a ON concept_links(source_a, id_a);
            CREATE INDEX IF NOT EXISTS idx_cl_b ON concept_links(source_b, id_b);
            """
        )
        groups = tag_con.execute(
            """
            SELECT cui
            FROM content_concepts
            GROUP BY cui
            HAVING COUNT(DISTINCT source) >= 2
            """
        ).fetchall()
        inserted = 0
        for group in groups:
            rows = tag_con.execute(
                """
                SELECT source, source_id, title, confidence
                FROM content_concepts
                WHERE cui=?
                ORDER BY confidence DESC, source, title
                LIMIT ?
                """,
                (group["cui"], per_cui_limit),
            ).fetchall()
            for i, a in enumerate(rows):
                for b in rows[i + 1:]:
                    if a["source"] == b["source"]:
                        continue
                    exists = c.execute(
                        """
                        SELECT 1 FROM concept_links
                        WHERE source_a=? AND id_a=? AND source_b=? AND id_b=?
                        LIMIT 1
                        """,
                        (a["source"], a["source_id"], b["source"], b["source_id"]),
                    ).fetchone()
                    if exists:
                        continue
                    c.execute(
                        "INSERT INTO concept_links VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            a["source"], a["source_id"], a["title"],
                            b["source"], b["source_id"], b["title"],
                            min(float(a["confidence"] or 0), float(b["confidence"] or 0)),
                        ),
                    )
                    inserted += 1
        c.commit()
    finally:
        c.close()
    print(f"Appended {inserted:,} exact-CUI concept links to {CONCEPT_LINKS_DB}")
    return inserted


def augment_title_context(
    output: Path = OUT_DB,
    sources: tuple[str, ...] = ("amboss", "utd"),
    limit: int | None = None,
) -> int:
    if not output.exists():
        raise SystemExit(f"Content concept DB not found: {output}. Build exact tags first.")
    if not GLOBAL_SEARCH_DB.exists():
        raise SystemExit(f"Global search DB not found: {GLOBAL_SEARCH_DB}")

    started = time.perf_counter()
    source_set = {source.strip().lower() for source in sources if source.strip()}
    if not source_set:
        source_set = {"amboss", "utd"}

    con = sqlite3.connect(str(output))
    con.row_factory = sqlite3.Row
    gs = sqlite3.connect(f"file:{GLOBAL_SEARCH_DB}?mode=ro", uri=True)
    gs.row_factory = sqlite3.Row
    inserted = 0
    scanned = 0
    try:
        con.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_content_concepts_source ON content_concepts(source, source_id);
            CREATE INDEX IF NOT EXISTS idx_content_concepts_cui ON content_concepts(cui, confidence DESC);
            """
        )
        placeholders = ",".join("?" for _ in source_set)
        sql = f"""
            SELECT source, external_id, title, href, kind
            FROM entries
            WHERE source IN ({placeholders})
              AND COALESCE(title, '') != ''
            ORDER BY source, external_id
        """
        rows = gs.execute(sql, tuple(sorted(source_set))).fetchall()
        now = int(time.time())
        for row in rows:
            if limit is not None and scanned >= limit:
                break
            scanned += 1
            title = row["title"] or ""
            existing = con.execute(
                """
                SELECT 1
                FROM content_concepts
                WHERE source=? AND source_id=? AND method='title_context'
                LIMIT 1
                """,
                (row["source"], str(row["external_id"])),
            ).fetchone()
            if existing:
                continue
            context = umls_reader.concept_context(title)
            if not context or context.get("semantic_group") not in {"disease", "finding", "pathology", "procedure", "lab", "drug"}:
                continue
            confidence = 0.88 if context.get("icd10cm_codes") else 0.78
            cur = con.execute(
                """
                INSERT OR IGNORE INTO content_concepts(
                  source, source_id, title, href, cui, preferred_name, semantic_group,
                  confidence, method, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'title_context', ?)
                """,
                (
                    row["source"],
                    str(row["external_id"]),
                    title,
                    row["href"] or "",
                    context["cui"],
                    context.get("preferred_name") or "",
                    context.get("semantic_group") or "",
                    confidence,
                    now,
                ),
            )
            if cur.rowcount:
                inserted += 1
            if scanned % 1000 == 0:
                con.commit()
                print(f"  title-context scanned {scanned:,}, inserted {inserted:,}")
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", ("title_context_sources", ",".join(sorted(source_set))))
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", ("title_context_rows", str(inserted)))
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", ("title_context_built_at", str(now)))
        con.commit()
    finally:
        gs.close()
        con.close()
    print(f"Augmented {output} with {inserted:,} title-context rows from {scanned:,} entries in {(time.perf_counter() - started):.1f}s")
    return inserted


def main() -> None:
    parser = argparse.ArgumentParser(description="Tag MedOS search entries with UMLS CUIs.")
    parser.add_argument("--out", default=str(OUT_DB))
    parser.add_argument("--append-concept-links", action="store_true")
    parser.add_argument("--per-cui-limit", type=int, default=8)
    parser.add_argument("--augment-title-context-only", action="store_true")
    parser.add_argument("--augment-title-context", action="store_true")
    parser.add_argument("--sources", default="amboss,utd")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    out = Path(args.out)
    sources = tuple(item.strip() for item in args.sources.split(",") if item.strip())
    if args.augment_title_context_only:
        augment_title_context(out, sources, args.limit)
        return
    build(out, args.append_concept_links, args.per_cui_limit)
    if args.augment_title_context:
        augment_title_context(out, sources, args.limit)


if __name__ == "__main__":
    main()

"""
Build the MedOS glossary database.

Sources (in precedence order, lowest source_rank wins):
  0 — SESLHDPR 282 clinical abbreviations XLSX (definitive)
  0 — First Aid indexed headings + snippet summaries
  1 — AMBOSS article titles + first-sentence descriptions
  2 — UpToDate topic titles + first paragraph

Run from the backend/ directory:
    python scripts/glossary/build_glossary.py

Or specify paths explicitly:
    python scripts/glossary/build_glossary.py \
        --xlsx "path/to/Clinical Abbreviations List.xlsx" \
        --out  "path/to/glossary.db"

Output: glossary.db with schema:
    glossary(term TEXT, expansion TEXT, definition TEXT,
             source TEXT, source_id TEXT, source_rank INTEGER)
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

# Locate config from any working directory
_BACKEND = Path(__file__).parents[2]
sys.path.insert(0, str(_BACKEND))
from config import AMBOSS_DIR, FIRSTAID_INDEX_DB, GLOSSARY_DB, UTD_DB_PATH
import firstaid  # noqa: E402


# ── Schema ─────────────────────────────────────────────────────────────────

DDL = """
CREATE TABLE IF NOT EXISTS glossary (
    term        TEXT NOT NULL,
    expansion   TEXT NOT NULL DEFAULT '',
    definition  TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL,
    source_id   TEXT NOT NULL DEFAULT '',
    source_rank INTEGER NOT NULL DEFAULT 9
);
CREATE INDEX IF NOT EXISTS idx_glossary_term_lower ON glossary(lower(term));
CREATE INDEX IF NOT EXISTS idx_glossary_rank ON glossary(source_rank);
"""


def _open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(path))
    c.executescript(DDL)
    c.execute("DELETE FROM glossary")
    c.commit()
    return c


# ── Source parsers ─────────────────────────────────────────────────────────

def _load_seslhdpr(xlsx_path: Path) -> list[tuple]:
    """
    Parse the SESLHDPR 282 clinical abbreviations Excel sheet.
    Expected columns (case-insensitive):
      Abbreviation | Meaning (expansion) | Notes / Definition
    Returns list of (term, expansion, definition, 'SESLHDPR', '', 0)
    """
    try:
        import pandas as pd
    except ImportError:
        print("  [WARN] pandas not installed — skipping SESLHDPR xlsx. pip install pandas openpyxl")
        return []

    if not xlsx_path.exists():
        print(f"  [WARN] SESLHDPR xlsx not found at {xlsx_path} — skipping.")
        return []

    try:
        df = pd.read_excel(xlsx_path, engine="openpyxl", header=0)
    except Exception as e:
        print(f"  [WARN] Failed to read xlsx: {e}")
        return []

    # Normalise column names
    df.columns = [str(c).strip().lower() for c in df.columns]

    # Try to find the abbreviation, meaning, and notes columns
    abbrev_col  = next((c for c in df.columns if "abbrev" in c or c in ("abbreviation", "term")), None)
    meaning_col = next((c for c in df.columns if "meaning" in c or "expansion" in c or "full" in c), None)
    notes_col   = next((c for c in df.columns if "note" in c or "definition" in c or "comment" in c), None)

    if abbrev_col is None:
        # Fall back to first two columns
        cols = list(df.columns)
        abbrev_col  = cols[0] if len(cols) > 0 else None
        meaning_col = cols[1] if len(cols) > 1 else None
        notes_col   = cols[2] if len(cols) > 2 else None

    if abbrev_col is None:
        print("  [WARN] Could not identify abbreviation column in SESLHDPR xlsx — skipping.")
        return []

    # Some rows store the meaning in adjacent unnamed columns rather than the
    # detected meaning_col — collect all candidate columns to coalesce.
    unnamed_cols = [c for c in df.columns if c.startswith("unnamed")]

    rows: list[tuple] = []
    for _, row in df.iterrows():
        term = str(row.get(abbrev_col) or "").strip()
        if not term or term.lower() in ("nan", "abbreviation", "term"):
            continue

        # Coalesce meaning_col first, then any unnamed columns
        expansion = ""
        for col in ([meaning_col] if meaning_col else []) + unnamed_cols:
            val = str(row.get(col) or "").strip()
            if val and val.lower() != "nan":
                expansion = val
                break

        definition = str(row.get(notes_col) or "").strip() if notes_col else ""
        definition = "" if definition.lower() == "nan" else definition
        rows.append((term, expansion, definition, "SESLHDPR", "", 0))

    print(f"  SESLHDPR: {len(rows)} abbreviations")
    return rows


def _load_amboss(db_dir: Path, limit: int = 8000) -> list[tuple]:
    """
    Pull AMBOSS article titles as glossary terms.
    Expansion = title itself (it IS the full term).
    Definition = first sentence from the article's text blob (if available).
    """
    db_path = db_dir / "amboss-2025.db"
    if not db_path.exists():
        print(f"  [WARN] AMBOSS DB not found at {db_path} — skipping AMBOSS glossary source.")
        return []

    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        # Docs table has id, title, and optionally a plaintext/html body column
        # Try to get a brief description from the body.
        cols = [r[1] for r in c.execute("PRAGMA table_info(Docs)").fetchall()]
        text_col = next((col for col in ("text", "content", "body", "html", "description", "doc") if col in cols), None)

        if text_col:
            rows = c.execute(
                f"SELECT id, title, {text_col} as body FROM Docs WHERE title IS NOT NULL LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT id, title, NULL as body FROM Docs WHERE title IS NOT NULL LIMIT ?",
                (limit,),
            ).fetchall()
    finally:
        c.close()

    import re
    out: list[tuple] = []
    for r in rows:
        title = (r["title"] or "").strip()
        if not title:
            continue
        body = (r["body"] or "")
        # Strip HTML tags, take first sentence
        clean = re.sub(r"<[^>]+>", " ", str(body))
        clean = re.sub(r"\s+", " ", clean).strip()
        first_sent = (clean.split(".")[0] + ".").strip() if "." in clean else ""
        if len(first_sent) < 10:
            first_sent = ""
        out.append((title, title, first_sent[:400], "amboss", str(r["id"]), 1))

    print(f"  AMBOSS: {len(out)} terms")
    return out


def _load_firstaid(index_path: Path, limit: int = 12000) -> list[tuple]:
    """
    Pull First Aid indexed headings as glossary terms.
    Expansion = heading title. Definition = first 340 chars of extracted body text.
    """
    if not index_path.exists():
        print(f"  [WARN] First Aid index not found at {index_path} — skipping First Aid glossary source.")
        return []

    c = sqlite3.connect(f"file:{index_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            """
            SELECT heading_id, title, hierarchy, body_text, keywords
            FROM firstaid_regions
            WHERE title IS NOT NULL AND title != ''
            ORDER BY page, title
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        c.close()

    out: list[tuple] = []
    seen: set[str] = set()
    for r in rows:
        title = (r["title"] or "").strip()
        if not title:
            continue
        terms = firstaid.scan_terms_for_region(title, r["hierarchy"], r["body_text"], r["keywords"])
        definition = " ".join((r["body_text"] or "").split())[:340]
        for term in terms:
            key = firstaid.normalize(term)
            if key in seen:
                continue
            seen.add(key)
            out.append((term, title, definition, "firstaid", str(r["heading_id"]), 0))

    print(f"  First Aid: {len(out)} terms")
    return out


def _load_utd(db_dir: Path, limit: int = 25000) -> list[tuple]:
    """
    Pull UpToDate topic titles as glossary terms.
    We use the quick-find (QF) table for titles with their first-line text if available.
    """
    idx_path = db_dir / "unidex.en.sqlite"
    if not idx_path.exists():
        print(f"  [WARN] UTD index DB not found at {idx_path} — skipping UTD glossary source.")
        return []

    c = sqlite3.connect(f"file:{idx_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            "SELECT topic_id, title FROM topic WHERE title IS NOT NULL LIMIT ?", (limit,)
        ).fetchall()
    finally:
        c.close()

    out: list[tuple] = []
    for r in rows:
        title = (r["title"] or "").strip()
        if not title:
            continue
        out.append((title, title, "", "utd", str(r["topic_id"]), 2))

    print(f"  UpToDate: {len(out)} terms")
    return out


# ── Main ────────────────────────────────────────────────────────────────────

def build(
    xlsx_path: Path,
    out_path: Path,
    include_amboss: bool = True,
    include_utd: bool    = True,
    include_firstaid: bool = True,
) -> None:
    print(f"Building glossary DB -> {out_path}")

    c = _open_db(out_path)

    rows: list[tuple] = []
    rows.extend(_load_seslhdpr(xlsx_path))

    if include_firstaid:
        rows.extend(_load_firstaid(FIRSTAID_INDEX_DB))

    if include_amboss and AMBOSS_DIR:
        rows.extend(_load_amboss(AMBOSS_DIR))

    if include_utd and UTD_DB_PATH:
        rows.extend(_load_utd(UTD_DB_PATH))

    c.executemany(
        "INSERT INTO glossary (term, expansion, definition, source, source_id, source_rank) VALUES (?,?,?,?,?,?)",
        rows,
    )
    c.commit()
    c.close()

    total = len(rows)
    print(f"Done — {total:,} glossary entries written to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build MedOS glossary.db")
    parser.add_argument(
        "--xlsx",
        default=str(_BACKEND.parent / "Clinical Abbreviations List - SESLHDPR 282.xlsx"),
        help="Path to the SESLHDPR 282 clinical abbreviations Excel file",
    )
    parser.add_argument(
        "--out",
        default=str(GLOSSARY_DB),
        help="Output path for glossary.db",
    )
    parser.add_argument("--no-amboss", action="store_true", help="Skip AMBOSS terms")
    parser.add_argument("--no-utd",    action="store_true", help="Skip UTD terms")
    parser.add_argument("--no-firstaid", action="store_true", help="Skip First Aid indexed terms")
    args = parser.parse_args()

    build(
        xlsx_path=Path(args.xlsx),
        out_path=Path(args.out),
        include_amboss=not args.no_amboss,
        include_utd=not args.no_utd,
        include_firstaid=not args.no_firstaid,
    )


if __name__ == "__main__":
    main()

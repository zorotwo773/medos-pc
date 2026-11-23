"""
build_utdddx.py — normalize the UpToDate DDx bundle into
data/uptodate ddx/utdddx.sqlite.

Source (UNENCRYPTED): data/uptodate ddx/uptodateddx.db
  - diagnoses(id, diagnosisName, ismain)   — 4,521 dx; ismain=1 (854) are the
    "presenting" diagnoses that own a differential table.
  - ddx(id1, id2, id1diagnosis, id2diagnosis, signs, tests)  — 6,555 rows: for a
    main diagnosis (id1) each candidate differential (id2diagnosis) with the
    distinguishing SIGNS and TESTS. Every row has non-empty signs + tests.

We emit a reader-friendly, concept-taggable normalization. Re-runnable: writes
utdddx.sqlite.tmp then atomically replaces.

Run:  python scripts/build_utdddx.py
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path
from config import UTDDDX_DB, UTDDDX_SRC_DB  # noqa: E402


def clean_text(s: str | None) -> str:
    """Vendor text has run-together sentences (HTML stripped w/o spaces). Insert a
    space after ./;/: when a lowercase/punct is glued to an uppercase start, and
    collapse whitespace. Conservative so 'E.coli' / 'H1N1' survive."""
    if not s:
        return ""
    s = s.replace("\xa0", " ")
    s = re.sub(r"([a-z%\)\]])([.;:])([A-Z])", r"\1\2 \3", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def build() -> None:
    if not Path(UTDDDX_SRC_DB).exists():
        raise SystemExit(f"UTD DDx source not found at {UTDDDX_SRC_DB}")

    src = sqlite3.connect(f"file:{UTDDDX_SRC_DB}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    diagnoses = src.execute(
        "SELECT id, diagnosisName, ismain FROM diagnoses WHERE diagnosisName IS NOT NULL"
    ).fetchall()
    ddx_rows = src.execute(
        "SELECT id1, id2, id1diagnosis, id2diagnosis, signs, tests FROM ddx"
    ).fetchall()
    src.close()

    # Group differentials by their main diagnosis id.
    by_main: dict[int, list[sqlite3.Row]] = {}
    for r in ddx_rows:
        by_main.setdefault(r["id1"], []).append(r)

    tmp = Path(str(UTDDDX_DB) + ".tmp")
    if tmp.exists():
        tmp.unlink()
    out = sqlite3.connect(str(tmp))
    out.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE ddx_topics (
            id                 INTEGER PRIMARY KEY,
            title              TEXT NOT NULL,
            is_main            INTEGER DEFAULT 0,
            differential_count INTEGER DEFAULT 0,
            search_text        TEXT
        );
        CREATE TABLE ddx_differentials (
            main_id     INTEGER,
            ordinal     INTEGER,
            dx_title    TEXT,
            signs       TEXT,
            tests       TEXT
        );
        CREATE INDEX idx_ddx_diff_main ON ddx_differentials(main_id);
        CREATE INDEX idx_ddx_topics_main ON ddx_topics(is_main);
        CREATE VIRTUAL TABLE ddx_fts USING fts5(
            title, differentials, tokenize='porter unicode61'
        );
        """
    )

    n_topics = 0
    n_diff = 0
    for d in diagnoses:
        did = d["id"]
        title = clean_text(d["diagnosisName"])
        if not title:
            continue
        diffs = by_main.get(did, [])
        diff_titles = []
        for ordinal, dr in enumerate(diffs):
            dx_title = clean_text(dr["id2diagnosis"])
            signs = clean_text(dr["signs"])
            tests = clean_text(dr["tests"])
            out.execute(
                "INSERT INTO ddx_differentials(main_id, ordinal, dx_title, signs, tests) "
                "VALUES(?,?,?,?,?)",
                (did, ordinal, dx_title, signs, tests),
            )
            diff_titles.append(dx_title)
            n_diff += 1

        # search_text folds the differential titles in so global_search + the
        # UMLS tagger see the concepts this DDx page actually discusses.
        search_text = (title + " " + " ".join(diff_titles)).strip()
        out.execute(
            "INSERT INTO ddx_topics(id, title, is_main, differential_count, search_text) "
            "VALUES(?,?,?,?,?)",
            (did, title, int(d["ismain"] or 0), len(diffs), search_text),
        )
        out.execute(
            "INSERT INTO ddx_fts(rowid, title, differentials) VALUES(?,?,?)",
            (did, title, " ".join(diff_titles)),
        )
        n_topics += 1

    out.commit()
    out.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    out.execute("PRAGMA optimize")
    out.close()

    os.replace(tmp, UTDDDX_DB)
    print(f"[build_utdddx] wrote {UTDDDX_DB}  topics={n_topics}  differentials={n_diff}")


if __name__ == "__main__":
    build()

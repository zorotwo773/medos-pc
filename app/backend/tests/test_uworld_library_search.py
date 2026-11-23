from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from routers import glossary, search  # noqa: E402


def make_uworld_bundle(root: Path) -> Path:
    bundle = root / "uworldstep1library-test"
    bundle.mkdir()
    db = bundle / "uworldstep1library-test.db"
    con = sqlite3.connect(db)
    try:
        con.executescript(
            """
            CREATE TABLE Docs (id INTEGER PRIMARY KEY, title TEXT, path TEXT, doc TEXT);
            CREATE TABLE TOC (id INTEGER PRIMARY KEY, name TEXT, docId INTEGER, parentId INTEGER, leaf INTEGER);
            """
        )
        con.execute(
            "INSERT INTO Docs (id, title, path, doc) VALUES (?,?,?,?)",
            (334, "Achalasia", "", ""),
        )
        con.execute(
            "INSERT INTO TOC (id, name, docId, parentId, leaf) VALUES (?,?,?,?,?)",
            (9001, "Achalasia", 334, 0, 1),
        )
        con.commit()
    finally:
        con.close()
    return bundle


def make_global_search(root: Path) -> Path:
    db = root / "global_search.sqlite"
    con = sqlite3.connect(db)
    try:
        con.executescript(
            """
            CREATE TABLE entries (
              id INTEGER PRIMARY KEY,
              source TEXT NOT NULL,
              kind TEXT NOT NULL,
              external_id TEXT NOT NULL,
              title TEXT NOT NULL,
              title_norm TEXT NOT NULL,
              subtitle TEXT NOT NULL,
              href TEXT NOT NULL,
              search_text TEXT NOT NULL,
              preview_json TEXT NOT NULL DEFAULT '',
              weight REAL NOT NULL DEFAULT 0
            );
            CREATE VIRTUAL TABLE entries_fts USING fts5(
              title,
              subtitle,
              search_text,
              content='entries',
              content_rowid='id'
            );
            """
        )
        rows = [
            ("amboss", "article", "708", "Achalasia", "achalasia", "AMBOSS article", "/amboss?doc=708", "Achalasia", 390),
            ("uworld", "article", "334", "Achalasia", "achalasia", "UWorld article", "/library/uworld?doc=334", "Achalasia", 390),
        ]
        con.executemany(
            """
            INSERT INTO entries(source, kind, external_id, title, title_norm, subtitle, href, search_text, weight)
            VALUES(?,?,?,?,?,?,?,?,?)
            """,
            rows,
        )
        con.execute(
            "INSERT INTO entries_fts(entries_fts) VALUES('rebuild')"
        )
        con.commit()
    finally:
        con.close()
    return db


def make_amboss_only_global_search(root: Path) -> Path:
    db = root / "global_search_amboss_only.sqlite"
    con = sqlite3.connect(db)
    try:
        con.executescript(
            """
            CREATE TABLE entries (
              id INTEGER PRIMARY KEY,
              source TEXT NOT NULL,
              kind TEXT NOT NULL,
              external_id TEXT NOT NULL,
              title TEXT NOT NULL,
              title_norm TEXT NOT NULL,
              subtitle TEXT NOT NULL,
              href TEXT NOT NULL,
              search_text TEXT NOT NULL,
              preview_json TEXT NOT NULL DEFAULT '',
              weight REAL NOT NULL DEFAULT 0
            );
            CREATE VIRTUAL TABLE entries_fts USING fts5(
              title,
              subtitle,
              search_text,
              content='entries',
              content_rowid='id'
            );
            """
        )
        con.execute(
            """
            INSERT INTO entries(source, kind, external_id, title, title_norm, subtitle, href, search_text, weight)
            VALUES(?,?,?,?,?,?,?,?,?)
            """,
            ("amboss", "article", "708", "Achalasia", "achalasia", "AMBOSS article", "/amboss?doc=708", "Achalasia", 390),
        )
        con.execute("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
        con.commit()
    finally:
        con.close()
    return db


def make_glossary(root: Path) -> Path:
    db = root / "glossary.db"
    con = sqlite3.connect(db)
    try:
        con.executescript(
            """
            CREATE TABLE glossary (
              term TEXT NOT NULL,
              expansion TEXT NOT NULL DEFAULT '',
              definition TEXT NOT NULL DEFAULT '',
              source TEXT NOT NULL,
              source_id TEXT NOT NULL DEFAULT '',
              source_rank INTEGER NOT NULL DEFAULT 9
            );
            CREATE INDEX idx_glossary_term_lower ON glossary(lower(term));
            """
        )
        con.execute(
            """
            INSERT INTO glossary(term, expansion, definition, source, source_id, source_rank)
            VALUES(?,?,?,?,?,?)
            """,
            ("Achalasia", "Achalasia", "Esophageal motility disorder.", "amboss", "708", 1),
        )
        con.commit()
    finally:
        con.close()
    return db


class UWorldLibrarySearchTests(unittest.TestCase):
    def test_grouped_search_returns_uworld_library_articles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = make_uworld_bundle(root)
            search.UWORLD_LIBRARY_DIR = bundle
            search.GLOSSARY_DB = root / "missing-glossary.db"
            search.UMLS_DB = root / "missing-umls.sqlite"
            search._unified_search_cache.clear()

            rows = search._query_uworld_library("Achalasia", "achalasia", 5)
            self.assertEqual(rows[0]["scope"], "uworld")
            self.assertEqual(rows[0]["title"], "Achalasia")
            self.assertEqual(rows[0]["href"], "/library/uworld?doc=334")

            result = search.unified_search(q="Achalasia", scopes="uworld", grouped=True, limit=5)
            self.assertIn("uworld", result["groups"])
            self.assertEqual(result["groups"]["uworld"][0]["title"], "Achalasia")

    def test_flat_dashboard_search_tops_up_uworld_when_global_index_misses_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = make_uworld_bundle(root)
            search.UWORLD_LIBRARY_DIR = bundle
            search._GLOBAL_SEARCH_DB = make_amboss_only_global_search(root)
            search.GLOSSARY_DB = root / "missing-glossary.db"
            search.UMLS_DB = root / "missing-umls.sqlite"
            search._unified_search_cache.clear()

            result = search.unified_search(q="Achalasia", scopes="all", grouped=False, limit=10, fast=True)

            rows = result["results"]
            self.assertIn(("amboss", "Achalasia"), [(row["scope"], row["title"]) for row in rows])
            self.assertIn(("uworld", "Achalasia"), [(row["scope"], row["title"]) for row in rows])

    def test_glossary_lookup_includes_amboss_and_uworld_source_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            glossary.GLOSSARY_DB = make_glossary(root)
            glossary._GLOBAL_SEARCH_DB = make_global_search(root)

            with patch.object(glossary.umls_reader, "tooltip_payload", return_value=None):
                payload = glossary.glossary_lookup(term="Achalasia", lay=False)

            refs = payload.get("source_refs", [])
            self.assertEqual([ref["source"] for ref in refs], ["amboss", "uworld"])
            self.assertEqual([ref["href"] for ref in refs], ["/amboss?doc=708", "/library/uworld?doc=334"])


if __name__ == "__main__":
    unittest.main()

"""Dependency-free helpers for source-owned global-search suggestions.

The Android client must never offer a completion from a content pack that is
not installed.  Keeping source ownership on every generated term also lets an
incremental pack refresh replace its completions without rebuilding the whole
index.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from collections.abc import Iterable


SOURCE_BONUS = {
    "firstaid": 95,
    "drugs": 80,
    "utd": 70,
    "amboss": 66,
    "uworld": 64,
    "sanford": 62,
    "utdddx": 60,
    "books": 55,
    "diseases": 52,
    "calc": 50,
    "qbank": 34,
    "lexi": 32,
    "anatomy": 28,
}

_DOTTED_ACRONYM = re.compile(r"(?<!\w)(?:[^\W\d_]\.){2,}[^\W\d_]?\.?(?!\w)", re.UNICODE)


def suggestion_norm(value: str | None) -> str:
    """Match the phone's Unicode/dotted-acronym normalization semantics."""

    decomposed = unicodedata.normalize("NFKD", value or "")
    without_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    compacted = _DOTTED_ACRONYM.sub(lambda match: match.group(0).replace(".", ""), without_marks)
    normalized = "".join(ch.lower() if ch.isalnum() else " " for ch in compacted)
    return re.sub(r"\s+", " ", normalized).strip()


def suggestion_terms(row: dict) -> list[tuple[str, float]]:
    source_bonus = SOURCE_BONUS.get(str(row.get("source") or ""), 20)
    weight = float(row.get("weight") or 0)
    title = str(row.get("title") or "").strip()
    terms: dict[str, tuple[str, float]] = {}

    def add(term: str, score: float) -> None:
        key = suggestion_norm(term)
        if len(key) < 3:
            return
        previous = terms.get(key)
        if previous is None or score > previous[1] or (
            score == previous[1] and len(term) < len(previous[0])
        ):
            terms[key] = (term, score)

    if title:
        add(title, weight + source_bonus)
    for word in re.findall(r"[^\W\d_][\w-]{2,}", title, flags=re.UNICODE):
        add(word, weight + source_bonus + 20)
    return list(terms.values())


def owned_suggestions(rows: Iterable[dict]) -> list[tuple[str, str, float, str]]:
    """Return one best display term per ``(source, normalized term)``."""

    best: dict[tuple[str, str], tuple[str, str, float, str]] = {}
    for row in rows:
        source = str(row.get("source") or "").strip().lower()
        if not source:
            continue
        for term, weight in suggestion_terms(row):
            key = suggestion_norm(term)
            candidate = (term, key, float(weight), source)
            previous = best.get((source, key))
            if previous is None or candidate[2] > previous[2] or (
                candidate[2] == previous[2] and len(candidate[0]) < len(previous[0])
            ):
                best[(source, key)] = candidate
    return sorted(best.values(), key=lambda item: (item[3], item[1], -item[2], item[0].lower()))


def ensure_suggestion_schema(db: sqlite3.Connection) -> None:
    columns = {row[1] for row in db.execute("PRAGMA table_info(suggestions)")}
    if not columns:
        db.execute(
            """
            CREATE TABLE suggestions (
              term TEXT NOT NULL,
              term_norm TEXT NOT NULL,
              weight REAL NOT NULL,
              source TEXT
            )
            """
        )
    elif "source" not in columns:
        # Legacy rows deliberately remain NULL-owned. Android ignores them and
        # derives installed-only fallbacks from validated entry rows.
        db.execute("ALTER TABLE suggestions ADD COLUMN source TEXT")
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_suggestions_source_term_norm "
        "ON suggestions(source, term_norm)"
    )


def replace_source_suggestions(
    db: sqlite3.Connection,
    source: str,
    rows: Iterable[dict],
    abbreviation_rows: Iterable[tuple[str, str, str, float, str]] = (),
) -> None:
    """Replace completions for one refreshed source, preserving all others."""

    source_key = source.strip().lower()
    ensure_suggestion_schema(db)
    db.execute("DELETE FROM suggestions WHERE source=?", (source_key,))
    owned = [row for row in owned_suggestions(rows) if row[3] == source_key]
    db.executemany(
        "INSERT INTO suggestions(term, term_norm, weight, source) VALUES(?, ?, ?, ?)",
        owned,
    )

    abbreviation_columns = {
        row[1] for row in db.execute("PRAGMA table_info(abbr_suggestions)")
    }
    if "source" in abbreviation_columns:
        db.execute("DELETE FROM abbr_suggestions WHERE source=?", (source_key,))
        filtered = [row for row in abbreviation_rows if row[4].strip().lower() == source_key]
        db.executemany(
            """
            INSERT INTO abbr_suggestions(abbr_norm, expansion, expansion_norm, weight, source)
            VALUES(?, ?, ?, ?, ?)
            """,
            filtered,
        )

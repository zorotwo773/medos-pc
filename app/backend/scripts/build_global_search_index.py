from __future__ import annotations

import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlencode

BASE = Path(__file__).resolve().parents[1]
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from config import (  # noqa: E402
    AMBOSS_DIR,
    BOOK_CHAPTER_INDEX_DB,
    DRUG_REF_DB,
    GLOSSARY_DB,
    LEXI_DB_PATH,
    LIBRARY_INDEX_DB,
    ROOT,
    SANFORD_DB,
    UTDDDX_DB,
    UTD_DB_PATH,
    UWORLD_LIBRARY_DIR,
)
import firstaid  # noqa: E402
import book_priority  # noqa: E402
from routers import search as search_router  # noqa: E402
from scripts.search_suggestion_index import (  # noqa: E402
    owned_suggestions,
    replace_source_suggestions,
    suggestion_terms as source_suggestion_terms,
)

OUT_DB = ROOT / "data" / "global_search.sqlite"


@dataclass(frozen=True, slots=True)
class GlobalSearchBuildInputs:
    output: Path
    library_index: Path
    book_chapter_index: Path


def _sqlite_read_uri(path: Path) -> str:
    """Return an absolute, encoded, readonly SQLite file URI."""

    resolved = Path(path).expanduser().resolve(strict=False)
    return f"{resolved.as_uri()}?{urlencode((('mode', 'ro'),))}"


def norm(value: str | None) -> str:
    return search_router._normalize(value or "")


def clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def quote_identifier(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def entry(
    source: str,
    kind: str,
    external_id: str,
    title: str,
    subtitle: str,
    href: str,
    search_text: str,
    weight: float,
    preview: dict | None = None,
) -> dict:
    return {
        "source": source,
        "kind": kind,
        "external_id": str(external_id),
        "title": clean(title),
        "subtitle": clean(subtitle),
        "href": href,
        "search_text": clean(search_text),
        "weight": float(weight),
        "preview_json": json.dumps(preview or {}, ensure_ascii=False) if preview else "",
    }


def iter_utd() -> list[dict]:
    idx = UTD_DB_PATH / "unidex.en.sqlite" if UTD_DB_PATH else None
    if not idx or not idx.exists():
        return []
    c = sqlite3.connect(_sqlite_read_uri(idx), uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT topic_id, title FROM topic WHERE title != ''").fetchall()
    finally:
        c.close()
    return [
        entry("utd", "topic", r["topic_id"], r["title"], "UpToDate topic", f"/uptodate?t={int(r['topic_id'])}", r["title"], 420)
        for r in rows
    ]


def iter_amboss() -> list[dict]:
    db = AMBOSS_DIR / "amboss-2025.db" if AMBOSS_DIR else None
    if not db or not db.exists():
        return []
    c = sqlite3.connect(_sqlite_read_uri(db), uri=True)
    c.row_factory = sqlite3.Row
    out: list[dict] = []
    seen_titles: set[str] = set()
    try:
        for r in c.execute("SELECT id, title FROM Docs WHERE title != ''"):
            title = clean(r["title"])
            key = norm(title)
            if not title or key in seen_titles:
                continue
            seen_titles.add(key)
            out.append(entry("amboss", "article", r["id"], title, "AMBOSS article", f"/amboss?doc={int(r['id'])}", title, 390))
        for r in c.execute("SELECT id, name, docId FROM TOC WHERE docId > 0 AND name != ''"):
            title = clean(r["name"])
            key = norm(title)
            if not title or key in seen_titles:
                continue
            seen_titles.add(key)
            out.append(entry("amboss", "chapter", f"toc:{r['id']}", title, "AMBOSS chapter", f"/amboss?doc={int(r['docId'])}", title, 360))
    finally:
        c.close()
    return out


def _uworld_library_db() -> Path | None:
    """Resolve the UWorld library bundle's .db, tolerating the dated folder name.

    Mirrors uworld_library_reader._db_path() but returns None (instead of
    raising) when the bundle is absent, so the build degrades gracefully.
    """
    bundle = Path(UWORLD_LIBRARY_DIR) if UWORLD_LIBRARY_DIR else None
    if not bundle or not bundle.exists():
        data = ROOT / "data"
        bundle = next(
            (p for p in sorted(data.glob("uworld*library*")) if p.is_dir()),
            None,
        ) if data.exists() else None
    if not bundle:
        return None
    return next((p for p in sorted(bundle.glob("*.db"))), None)


def iter_uworld_library() -> list[dict]:
    """UWorld reference-article library — the structural twin of iter_amboss().

    Docs(id, title, doc) holds 1,529 articles; doc is v2-encrypted HTML, so we
    index titles only (same depth as AMBOSS) and link the article via its
    frontend route /library/uworld?doc=<id>. Once these rows land in
    global_search, tag_paragraphs.py auto-tags them with UMLS CUIs.
    """
    db = _uworld_library_db()
    if not db or not db.exists():
        return []
    c = sqlite3.connect(_sqlite_read_uri(db), uri=True)
    c.row_factory = sqlite3.Row
    out: list[dict] = []
    seen_titles: set[str] = set()
    try:
        for r in c.execute("SELECT id, title FROM Docs WHERE title != ''"):
            title = clean(r["title"])
            key = norm(title)
            if not title or key in seen_titles:
                continue
            seen_titles.add(key)
            out.append(entry("uworld", "article", r["id"], title, "UWorld article", f"/library/uworld?doc={int(r['id'])}", title, 390))
        # leaf=1 marks specialty roots + article nodes; leaf=0 are in-article
        # section anchors (noise). Article nodes dedupe against Docs above, so
        # this mainly contributes the specialty chapter rows.
        for r in c.execute("SELECT id, name, docId FROM TOC WHERE leaf=1 AND docId > 0 AND name != ''"):
            title = clean(r["name"])
            key = norm(title)
            if not title or key in seen_titles:
                continue
            seen_titles.add(key)
            out.append(entry("uworld", "chapter", f"toc:{r['id']}", title, "UWorld chapter", f"/library/uworld?doc={int(r['docId'])}", title, 360))
    finally:
        c.close()
    return out


def iter_sanford() -> list[dict]:
    """Sanford Guide antimicrobial-therapy topics (normalized sanford.sqlite).

    Antimicrobial (drug) and organism topics carry a higher weight so an
    antibiotic query surfaces the Sanford monograph. Once these land in
    global_search, tag_paragraphs.py auto-tags them with UMLS CUIs — keywords
    (rich drug/organism synonyms) are folded into search_text for that.
    """
    db = Path(SANFORD_DB)
    if not db.exists():
        return []
    c = sqlite3.connect(_sqlite_read_uri(db), uri=True)
    c.row_factory = sqlite3.Row
    out: list[dict] = []
    try:
        for r in c.execute(
            "SELECT id, title, subject, content_label, kind, trade_name, keywords "
            "FROM sanford_topics WHERE title != ''"
        ):
            title = clean(r["title"])
            if not title:
                continue
            # Sanford is THE antimicrobial authority: its drug topics are all
            # antimicrobials and its organism topics are pathogen-directed
            # therapy, so weight them ABOVE the generic drug/first-aid/utd
            # monographs (drugs=560, firstaid=650, utd=420) — an antibiotic or
            # organism query then leads with Sanford. Non-antimicrobial drug
            # searches are unaffected (Sanford has no such topic). ID conditions
            # rank solidly but don't bury general disease sources.
            kind = r["kind"]
            if kind == "drug":
                weight = 700
            elif kind == "organism":
                weight = 620
            elif kind == "condition":
                weight = 400
            elif kind in ("prophylaxis", "vaccine"):
                weight = 350
            else:
                weight = 285
            subtitle = f"Sanford · {r['content_label']}"
            search_text = " ".join(
                filter(None, [title, r["trade_name"] or "", r["keywords"] or "", r["subject"] or ""])
            )
            out.append(entry(
                "sanford", r["kind"] or "topic", r["id"], title, subtitle,
                f"/sanford?id={int(r['id'])}", search_text, weight,
            ))
    finally:
        c.close()
    return out


def iter_utdddx() -> list[dict]:
    """UpToDate DDx presenting diagnoses (normalized utdddx.sqlite). Only the
    'main' diagnoses (those that own a differential table) are indexed — they are
    the useful entry points; non-main diagnoses have no standalone page."""
    db = Path(UTDDDX_DB)
    if not db.exists():
        return []
    c = sqlite3.connect(_sqlite_read_uri(db), uri=True)
    c.row_factory = sqlite3.Row
    out: list[dict] = []
    try:
        for r in c.execute(
            "SELECT id, title, differential_count, search_text FROM ddx_topics WHERE is_main=1 AND title != ''"
        ):
            title = clean(r["title"])
            if not title:
                continue
            subtitle = f"UpToDate DDx · {r['differential_count']} differentials"
            out.append(entry(
                "utdddx", "ddx", r["id"], title, subtitle,
                f"/utdddx?id={int(r['id'])}", clean(r["search_text"]) or title, 300,
            ))
    finally:
        c.close()
    return out


def iter_books(inputs: GlobalSearchBuildInputs | None = None) -> list[dict]:
    out: list[dict] = []
    library_index = inputs.library_index if inputs else LIBRARY_INDEX_DB
    book_chapter_index = inputs.book_chapter_index if inputs else BOOK_CHAPTER_INDEX_DB
    if library_index.exists():
        c = sqlite3.connect(_sqlite_read_uri(library_index), uri=True)
        c.row_factory = sqlite3.Row
        try:
            for r in c.execute("SELECT id, title, subtitle FROM books WHERE title != ''"):
                rel = r["id"]
                raw_title = r["title"] or Path(rel).stem
                folder = rel.replace("\\", "/").split("/")[0] if "/" in (rel or "") else ""
                # Clean split/oddly-named files and apply gold-standard weight.
                display = book_priority.display_title(raw_title, folder, rel)
                authority = book_priority.base_bonus(raw_title, folder, rel)
                out.append(entry("books", "book", rel, display, r["subtitle"] or "Book",
                                 f"/library?path={quote(rel)}",
                                 " ".join(filter(None, (raw_title, display, folder))), 220 + authority))
        finally:
            c.close()

    if book_chapter_index.exists():
        c = sqlite3.connect(_sqlite_read_uri(book_chapter_index), uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT h.id, h.book_id, h.title, h.hierarchy, h.page, h.href,
                       b.title AS book_title, b.folder
                FROM headings h
                JOIN books b ON b.id = h.book_id
                WHERE h.title != ''
                """
            ).fetchall()
        finally:
            c.close()
        for r in rows:
            page = int(r["page"] or 0) or None
            book_label = book_priority.display_title(r["book_title"] or "", r["folder"] or "", r["book_id"])
            subtitle = search_router._chapter_subtitle(book_label, r["hierarchy"] or "", page)
            href = r["href"] or f"/library?path={quote(r['book_id'])}" + (f"&page={page}" if page else "")
            authority = book_priority.base_bonus(r["book_title"] or "", r["folder"] or "", r["book_id"])
            text = " ".join(str(v or "") for v in (r["title"], r["hierarchy"], r["book_title"], r["folder"]))
            out.append(entry("books", "chapter", f"chapter:{r['id']}", r["title"], subtitle, href, text, 270 + authority))
    return out


def iter_firstaid() -> list[dict]:
    out: list[dict] = []
    if not firstaid.index_exists():
        return out
    c = sqlite3.connect(_sqlite_read_uri(firstaid.FIRSTAID_INDEX_DB), uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            """
            SELECT heading_id, title, hierarchy, body_text, keywords, page, edition
            FROM firstaid_regions
            WHERE title != ''
            """
        ).fetchall()
    finally:
        c.close()
    for r in rows:
        terms = firstaid.scan_terms_for_region(r["title"], r["hierarchy"], r["body_text"], r["keywords"])
        if not terms:
            continue
        heading_id = int(r["heading_id"])
        page = int(r["page"] or 1)
        subtitle = " · ".join(filter(None, [f"FA {r['edition'] or '2026'}", f"p. {page}"]))
        out.append(entry(
            "firstaid",
            "region",
            str(heading_id),
            r["title"] or "",
            subtitle,
            f"#firstaid-{heading_id}",
            " ".join(str(v or "") for v in (r["title"], r["hierarchy"], " ".join(terms))),
            650,
        ))
    return out


def iter_drugs() -> list[dict]:
    if not DRUG_REF_DB.exists():
        return []
    c = sqlite3.connect(_sqlite_read_uri(DRUG_REF_DB), uri=True)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            """
            SELECT qi.drug_id, qi.generic_name, qi.brand_names, qi.drug_class,
                   qi.dose_snippet, d.has_black_box
            FROM drug_quick_info qi
            JOIN drugs d ON d.drug_id = qi.drug_id
            WHERE qi.generic_name != ''
            """
        ).fetchall()
    finally:
        c.close()
    out: list[dict] = []
    for r in rows:
        brands = r["brand_names"] or ""
        dc = r["drug_class"] or ""
        dose = r["dose_snippet"] or ""
        subtitle = " · ".join(filter(None, [
            brands.split(",")[0].strip() if brands else "",
            dc.split("|")[0].strip()[:30] if dc else "",
            dose[:60] if dose else "",
        ])) or "Drug reference"
        out.append(entry(
            "drugs", "drug", r["drug_id"], r["generic_name"] or "", subtitle,
            f"/drugs?id={int(r['drug_id'])}",
            f"{r['generic_name']} {brands} {dc} {dose}",
            560,
        ))
    return out


def iter_calcs_and_lexi() -> list[dict]:
    out = [
        entry("calc", "calculator", c["id"], c["title"], c["subtitle"], c["href"], c["search_text"], 330)
        for c in search_router._CALCULATOR_INDEX
    ]
    for calc in search_router._lexi_calc_catalog():
        title = calc["title"]
        categories = calc.get("categories") or ""
        source_label = "MDCalc calculator" if calc.get("source") == "mdcalc-live" else "Lexi calculator"
        out.append(entry(
            "calc", "calculator", f"lexi-calc:{calc['id']}", title,
            source_label + (f" · {categories.split(' ')[0]}" if categories else ""),
            f"/calculators?q={quote(title)}",
            calc.get("search_text") or f"{title} {categories} {calc.get('description') or ''}",
            335 if calc.get("source") == "mdcalc-live" else 315,
        ))

    if LEXI_DB_PATH and LEXI_DB_PATH.exists():
        c = sqlite3.connect(_sqlite_read_uri(LEXI_DB_PATH), uri=True)
        c.row_factory = sqlite3.Row
        seen: set[str] = set()
        try:
            for table, col in search_router._lexi_search_tables()[:32]:
                try:
                    rows = c.execute(
                        f"SELECT {quote_identifier(col)} AS term FROM {quote_identifier(table)} "
                        f"WHERE {quote_identifier(col)} IS NOT NULL AND {quote_identifier(col)} != '' LIMIT 3000"
                    ).fetchall()
                except sqlite3.Error:
                    continue
                for r in rows:
                    term = clean(r["term"])
                    key = norm(term)
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    out.append(entry("lexi", "term", f"{table}:{term}", term, f"Lexicomp · {table}", f"/lexi?q={quote(term)}", term, 240))
        finally:
            c.close()
    return out


def iter_anatomy_and_diseases() -> list[dict]:
    out = [
        entry("anatomy", item["kind"], item["id"], item["title"], item["subtitle"], item["href"], item["search_text"], 210)
        for item in search_router._anatomy_catalog()
    ]
    out.extend(
        entry("diseases", item["kind"], item["id"], item["title"], item["subtitle"], item["href"], item["search_text"], 250)
        for item in search_router._disease_catalog()
    )
    for item in search_router._cliniccons_image_catalog():
        payload = {k: v for k, v in item.items() if k not in {"image_title", "filename", "raw_match"}}
        out.append(entry(
            "diseases", "clinic_image", payload["id"], payload["title"], payload["subtitle"], payload["href"],
            payload["search_text"], 255, payload.get("preview"),
        ))
    return out


def iter_qbank() -> list[dict]:
    out: list[dict] = []
    for item in search_router._uworld_exhibit_catalog():
        bank = str(item.get("db") or "")
        exhibit_id = str(item.get("exhibit_id") or "")
        title = clean(str(item.get("title") or item.get("term") or f"UWorld table {exhibit_id}"))
        if not bank or not exhibit_id or not title:
            continue
        href = f"/qbank/exhibit/{exhibit_id}?db={bank}"
        out.append(entry(
            "qbank", "uworld_table", f"uworld-table:{bank}:{exhibit_id}", title,
            f"UWorld table · {bank.upper()}", href,
            f"{title} {item.get('term') or ''} {bank} {item.get('qid') or ''}", 245,
            {"type": "frame", "title": title, "url": href, "caption": f"UWorld table · {bank.upper()}", "source": "UWorld"},
        ))

    for bank, db_path in search_router._qbank_paths():
        c = sqlite3.connect(_sqlite_read_uri(db_path), uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT q.id, q.title, subj.name AS subject_name, sys.name AS system_name
                FROM Questions q
                LEFT JOIN Subjects subj ON subj.id=q.subId
                LEFT JOIN Systems sys ON sys.id=q.sysId
                WHERE q.title IS NOT NULL AND q.title != ''
                """
            ).fetchall()
        finally:
            c.close()
        for r in rows:
            subject = r["subject_name"] or ""
            system = r["system_name"] or ""
            title = r["title"] or f"Question {r['id']}"
            out.append(entry(
                "qbank", "question", f"{bank}:{r['id']}", title,
                " · ".join(filter(None, [bank.upper(), subject, system])),
                f"/qbank?db={bank}&qid={int(r['id'])}",
                f"{title} {subject} {system}", 45,
            ))
    return out


def suggestion_terms(row: dict) -> list[tuple[str, float]]:
    return source_suggestion_terms(row)


def normal_abbr(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def abbreviation_suggestions(rows: list[dict]) -> list[tuple[str, str, str, float, str]]:
    source_bonus = {
        "glossary": 480, "firstaid": 360, "drugs": 250, "utd": 235, "amboss": 230,
        "books": 205, "diseases": 190, "calc": 180, "qbank": 145, "lexi": 135, "anatomy": 120,
    }
    best: dict[tuple[str, str], tuple[str, str, str, float, str]] = {}

    def clean_candidate(value: str | None) -> str:
        candidate = clean(value)
        candidate = re.sub(r"^patient perspective:\s*", "", candidate, flags=re.I).strip()
        candidate = re.sub(r"^calculator:\s*", "", candidate, flags=re.I).strip()
        candidate = re.sub(r"\s*\([A-Z0-9-]{2,8}\)\s*$", "", candidate).strip()
        us = search_router._american_spelling_variant(candidate)
        return us or candidate

    def add(abbr: str | None, expansion: str | None, weight: float, source: str) -> None:
        abbr_norm = normal_abbr(abbr)
        if not abbr_norm or not search_router._could_be_abbrev_query(abbr_norm):
            return
        candidate = clean_candidate(expansion)
        expansion_norm = norm(candidate)
        if not expansion_norm or expansion_norm == norm(abbr_norm) or len(candidate) > 90:
            return
        key = (abbr_norm, expansion_norm)
        row = (abbr_norm, candidate, expansion_norm, float(weight), source)
        prev = best.get(key)
        if not prev or row[3] > prev[3] or (row[3] == prev[3] and len(row[1]) < len(prev[1])):
            best[key] = row

    if GLOSSARY_DB.exists():
        c = sqlite3.connect(_sqlite_read_uri(GLOSSARY_DB), uri=True)
        c.row_factory = sqlite3.Row
        try:
            gloss = c.execute(
                """
                SELECT term, expansion, source_rank
                FROM glossary
                WHERE expansion != ''
                """
            ).fetchall()
        finally:
            c.close()
        for row in gloss:
            term = row["term"] or ""
            expansion = row["expansion"] or ""
            penalty = int(row["source_rank"] or 0) * 8
            if search_router._looks_like_abbreviation_token(term):
                add(term, expansion, source_bonus["glossary"] - penalty, "glossary")
            term_acr = search_router._phrase_acronym(term)
            if term_acr:
                add(term_acr, term, source_bonus["glossary"] - 30 - penalty, "glossary")
            expansion_acr = search_router._phrase_acronym(expansion)
            if expansion_acr:
                add(expansion_acr, expansion, source_bonus["glossary"] - 45 - penalty, "glossary")

    for row in rows:
        if row["source"] in {"books", "anatomy"}:
            continue
        title = row["title"]
        abbr = search_router._phrase_acronym(title)
        if not abbr:
            continue
        add(abbr, title, row["weight"] + source_bonus.get(row["source"], 100), row["source"])

    return sorted(best.values(), key=lambda item: (item[0], -item[3], len(item[1]), item[1].lower()))


def rebuild(inputs: GlobalSearchBuildInputs | None = None) -> int:
    started = time.perf_counter()
    output = inputs.output if inputs else OUT_DB
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(".sqlite.tmp")
    if tmp.exists():
        tmp.unlink()
    c = sqlite3.connect(tmp)
    try:
        c.execute("PRAGMA journal_mode=OFF")
        c.execute("PRAGMA synchronous=OFF")
        c.execute("PRAGMA temp_store=MEMORY")
        c.executescript(
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
              title, subtitle, search_text,
              content='entries', content_rowid='id',
              tokenize='unicode61 remove_diacritics 2',
              prefix='2 3 4'
            );
            CREATE TABLE suggestions (
              term TEXT NOT NULL,
              term_norm TEXT NOT NULL,
              weight REAL NOT NULL,
              source TEXT NOT NULL
            );
            CREATE TABLE abbr_suggestions (
              abbr_norm TEXT NOT NULL,
              expansion TEXT NOT NULL,
              expansion_norm TEXT NOT NULL,
              weight REAL NOT NULL,
              source TEXT NOT NULL
            );
            CREATE INDEX idx_entries_source ON entries(source);
            CREATE INDEX idx_entries_title_norm ON entries(title_norm);
            CREATE UNIQUE INDEX idx_suggestions_source_term_norm ON suggestions(source, term_norm);
            CREATE INDEX idx_abbr_suggestions_abbr ON abbr_suggestions(abbr_norm);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )

        rows: list[dict] = []
        for label, loader in [
            ("firstaid", iter_firstaid),
            ("utd", iter_utd),
            ("amboss", iter_amboss),
            ("uworld", iter_uworld_library),
            ("sanford", iter_sanford),
            ("utdddx", iter_utdddx),
            ("books", lambda: iter_books(inputs)),
            ("drugs", iter_drugs),
            ("calc_lexi", iter_calcs_and_lexi),
            ("anatomy_diseases", iter_anatomy_and_diseases),
            ("qbank", iter_qbank),
        ]:
            before = len(rows)
            rows.extend(loader())
            print(f"[global-search] {label}: {len(rows) - before:,}")

        seen: set[tuple[str, str, str, str]] = set()
        deduped: list[dict] = []
        for row in rows:
            if not row["title"]:
                continue
            key = (row["source"], row["kind"], row["external_id"], norm(row["title"]))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)

        c.executemany(
            """
            INSERT INTO entries(source, kind, external_id, title, title_norm, subtitle, href, search_text, preview_json, weight)
            VALUES(:source, :kind, :external_id, :title, :title_norm, :subtitle, :href, :search_text, :preview_json, :weight)
            """,
            [{**row, "title_norm": norm(row["title"])} for row in deduped],
        )
        c.execute(
            """
            INSERT INTO entries_fts(rowid, title, subtitle, search_text)
            SELECT id, title, subtitle, search_text FROM entries
            """
        )

        c.executemany(
            "INSERT INTO suggestions(term, term_norm, weight, source) VALUES(?, ?, ?, ?)",
            owned_suggestions(deduped),
        )
        c.executemany(
            """
            INSERT INTO abbr_suggestions(abbr_norm, expansion, expansion_norm, weight, source)
            VALUES(?, ?, ?, ?, ?)
            """,
            abbreviation_suggestions(deduped),
        )
        c.execute("INSERT INTO meta(key, value) VALUES('built_at', ?)", (str(int(time.time())),))
        c.execute("INSERT INTO meta(key, value) VALUES('row_count', ?)", (str(len(deduped)),))
        c.commit()
    finally:
        c.close()

    if output.exists():
        output.unlink()
    tmp.rename(output)
    print(f"[global-search] wrote {output} in {(time.perf_counter() - started):.2f}s")
    return len(deduped)


def rebuild_books_only() -> int:
    """Fast incremental refresh of only the 'books' rows in global_search.sqlite.

    Re-reads the book + chapter indexes, replaces the books source rows, and
    reindexes the FTS table from the entries content. Every other source is left
    untouched, so a freshly scanned book becomes searchable and appears in
    autocomplete in seconds instead of waiting for a full multi-source rebuild.
    Falls back to a full rebuild() when the index does not exist yet."""
    if not OUT_DB.exists():
        return rebuild()
    started = time.perf_counter()
    c = sqlite3.connect(str(OUT_DB))
    try:
        c.execute("PRAGMA foreign_keys=OFF")
        c.execute("DELETE FROM entries WHERE source='books'")
        seen: set[tuple[str, str, str, str]] = set()
        deduped: list[dict] = []
        for row in iter_books():
            if not row["title"]:
                continue
            key = (row["source"], row["kind"], row["external_id"], norm(row["title"]))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)
        c.executemany(
            """
            INSERT INTO entries(source, kind, external_id, title, title_norm, subtitle, href, search_text, preview_json, weight)
            VALUES(:source, :kind, :external_id, :title, :title_norm, :subtitle, :href, :search_text, :preview_json, :weight)
            """,
            [{**row, "title_norm": norm(row["title"])} for row in deduped],
        )
        replace_source_suggestions(c, "books", deduped)
        # Reindex the FTS from the entries content (no external DB reads).
        c.execute("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('books_refreshed_at', ?)", (str(int(time.time())),))
        c.commit()
    finally:
        c.close()
    print(f"[global-search] refreshed {len(deduped):,} book rows in {(time.perf_counter() - started):.2f}s")
    return len(deduped)


_INCREMENTAL_LOADERS = {
    "sanford": iter_sanford,
    "utdddx": iter_utdddx,
    "books": iter_books,
    "drugs": iter_drugs,
}


def rebuild_sources_only(sources: list[str]) -> int:
    """Fast incremental refresh of specific source rows in global_search.sqlite.

    Replaces just the named sources' entries and reindexes the FTS from entries
    content — every other source is untouched. Use when adding/updating a single
    content DB (e.g. sanford, utdddx) without a full multi-source rebuild. Falls
    back to a full rebuild() when the index doesn't exist yet."""
    if not OUT_DB.exists():
        return rebuild()
    started = time.perf_counter()
    c = sqlite3.connect(str(OUT_DB))
    total = 0
    try:
        c.execute("PRAGMA foreign_keys=OFF")
        for src in sources:
            loader = _INCREMENTAL_LOADERS.get(src)
            if not loader:
                print(f"[global-search] no incremental loader for {src!r}, skipping")
                continue
            c.execute("DELETE FROM entries WHERE source=?", (src,))
            seen: set[tuple[str, str, str, str]] = set()
            deduped: list[dict] = []
            for row in loader():
                if not row["title"]:
                    continue
                key = (row["source"], row["kind"], row["external_id"], norm(row["title"]))
                if key in seen:
                    continue
                seen.add(key)
                deduped.append(row)
            c.executemany(
                """
                INSERT INTO entries(source, kind, external_id, title, title_norm, subtitle, href, search_text, preview_json, weight)
                VALUES(:source, :kind, :external_id, :title, :title_norm, :subtitle, :href, :search_text, :preview_json, :weight)
                """,
                [{**row, "title_norm": norm(row["title"])} for row in deduped],
            )
            replace_source_suggestions(
                c,
                src,
                deduped,
                abbreviation_suggestions(deduped),
            )
            print(f"[global-search] {src}: {len(deduped):,}")
            total += len(deduped)
        c.execute("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('sources_refreshed_at', ?)", (str(int(time.time())),))
        c.commit()
    finally:
        c.close()
    print(f"[global-search] refreshed {total:,} rows for {sources} in {(time.perf_counter() - started):.2f}s")
    return total


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--books-only" in args:
        count = rebuild_books_only()
        print(f"[global-search] refreshed {count:,} book rows")
    elif "--sources" in args:
        idx = args.index("--sources")
        srcs = [s.strip() for s in args[idx + 1].split(",") if s.strip()] if idx + 1 < len(args) else []
        count = rebuild_sources_only(srcs)
        print(f"[global-search] refreshed {count:,} rows")
    else:
        count = rebuild()
        print(f"[global-search] indexed {count:,} rows")

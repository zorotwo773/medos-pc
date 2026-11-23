from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "app" / "backend"
sys.path.insert(0, str(BACKEND))

import config  # noqa: E402  # loads backend/.env
import amboss_reader  # noqa: E402
import cliniccons_reader  # noqa: E402
import qbank_reader  # noqa: E402
import utd_reader  # noqa: E402


DEFAULT_OUTPUT = ROOT / "data" / "reference_entities.sqlite"


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (value or "").lower())).strip()


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def derived_aliases(title: str) -> list[str]:
    title = clean(title)
    aliases: set[str] = set()
    lowered = title.lower()
    for suffix in (" disease", " syndrome", " disorder"):
        if lowered.endswith(suffix):
            stem = title[: -len(suffix)].strip()
            if len(stem) >= 5 and re.search(r"[A-Z]", stem[:1]):
                aliases.add(stem)
    if "barré" in lowered:
        aliases.add(title.replace("Barré", "Barre").replace("barré", "barre"))
    if "ischemic attack" in lowered:
        aliases.add("TIA")
        aliases.add("Transient ischemic attack")
    if lowered == "sudden infant death syndrome":
        aliases.add("SIDS")
    return sorted(alias for alias in aliases if alias and norm(alias) != norm(title))


def title_relevance(query: str, title: str) -> int:
    q = norm(query)
    t = norm(title)
    if not q or not t:
        return 0
    if q == t:
        return 220
    if t.startswith(q + " "):
        return 180
    if q in t:
        return 150
    q_words = re.findall(r"[a-z0-9]+", q)
    if not q_words:
        return 0
    hits = sum(1 for word in q_words if word in t)
    return int(100 * hits / len(q_words))


def connect_output(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    c.executescript(
        """
        PRAGMA journal_mode = WAL;
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE entities (
          entity_id TEXT PRIMARY KEY,
          canonical TEXT NOT NULL,
          canonical_lc TEXT NOT NULL,
          primary_source TEXT NOT NULL,
          kind TEXT NOT NULL,
          abstract TEXT NOT NULL
        );
        CREATE TABLE aliases (
          entity_id TEXT NOT NULL,
          alias TEXT NOT NULL,
          alias_lc TEXT NOT NULL,
          source TEXT NOT NULL,
          case_sensitive INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (entity_id, alias_lc, source)
        );
        CREATE TABLE links (
          entity_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          href TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (entity_id, source, source_id, kind, href)
        );
        CREATE TABLE media (
          entity_id TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (entity_id, source, url)
        );
        CREATE TABLE icd_codes (
          entity_id TEXT NOT NULL,
          code TEXT NOT NULL,
          description TEXT NOT NULL,
          system TEXT NOT NULL,
          PRIMARY KEY (entity_id, code, description)
        );
        CREATE INDEX idx_aliases_lc ON aliases(alias_lc);
        CREATE INDEX idx_links_source ON links(source, source_id);
        CREATE INDEX idx_entities_canonical_lc ON entities(canonical_lc);
        """
    )
    return c


class Writer:
    def __init__(self, c: sqlite3.Connection) -> None:
        self.c = c
        self.alias_to_entities: dict[str, set[str]] = defaultdict(set)
        self.counts: dict[str, int] = defaultdict(int)

    def entity(self, entity_id: str, canonical: str, primary_source: str, kind: str = "concept", abstract: str = "") -> str:
        canonical = clean(canonical) or entity_id
        self.c.execute(
            """
            INSERT OR IGNORE INTO entities(entity_id, canonical, canonical_lc, primary_source, kind, abstract)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (entity_id, canonical, norm(canonical), primary_source, kind, clean(abstract)),
        )
        self.alias(entity_id, canonical, primary_source)
        self.counts["entities"] += 1
        return entity_id

    def alias(self, entity_id: str, alias: str, source: str, case_sensitive: bool = False) -> None:
        alias = clean(alias)
        alias_lc = norm(alias)
        if not alias or not alias_lc:
            return
        self.c.execute(
            "INSERT OR IGNORE INTO aliases(entity_id, alias, alias_lc, source, case_sensitive) VALUES (?, ?, ?, ?, ?)",
            (entity_id, alias, alias_lc, source, 1 if case_sensitive else 0),
        )
        self.alias_to_entities[alias_lc].add(entity_id)
        self.counts["aliases"] += 1

    def find_entities(self, *terms: str) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for term in terms:
            for entity_id in self.alias_to_entities.get(norm(term), set()):
                if entity_id not in seen:
                    seen.add(entity_id)
                    out.append(entity_id)
        return out

    def link(self, entity_id: str, source: str, source_id: str | int, kind: str, title: str, href: str, payload: dict | None = None) -> None:
        if not href:
            return
        self.c.execute(
            """
            INSERT OR IGNORE INTO links(entity_id, source, source_id, kind, title, href, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (entity_id, source, str(source_id), kind, clean(title), href, json.dumps(payload or {}, ensure_ascii=False)),
        )
        self.counts["links"] += 1

    def media(self, entity_id: str, source: str, title: str, url: str, payload: dict | None = None) -> None:
        if not url:
            return
        self.c.execute(
            "INSERT OR IGNORE INTO media(entity_id, source, title, url, payload_json) VALUES (?, ?, ?, ?, ?)",
            (entity_id, source, clean(title), url, json.dumps(payload or {}, ensure_ascii=False)),
        )
        self.counts["media"] += 1

    def icd(self, entity_id: str, code: str, description: str, system: str) -> None:
        code = clean(code)
        if not code:
            return
        self.c.execute(
            "INSERT OR IGNORE INTO icd_codes(entity_id, code, description, system) VALUES (?, ?, ?, ?)",
            (entity_id, code, clean(description), clean(system) or "ICD"),
        )
        self.counts["icd_codes"] += 1


def build_amboss_spine(w: Writer) -> None:
    phrase_groups = amboss_reader._extension_phrase_groups()
    group_aliases: dict[str, list[tuple[str, bool]]] = defaultdict(list)
    for alias, group_id in amboss_reader._extension_terms_map().items():
        group_aliases[group_id].append((alias, False))
    for alias, group_id in amboss_reader._extension_case_sensitive_terms_map().items():
        group_aliases[group_id].append((alias, True))

    for group_id, group in phrase_groups.items():
        if not isinstance(group, dict):
            continue
        aliases = group_aliases.get(group_id, [])
        title = clean(str(group.get("title") or "")) or (aliases[0][0] if aliases else group_id)
        entity_id = f"amboss-crx:{group_id}"
        abstract = amboss_reader._strip_html(str(group.get("description") or ""), max_len=900)
        w.entity(entity_id, title, "amboss-crx", "concept", abstract)
        for alias in derived_aliases(title):
            w.alias(entity_id, alias, "derived")
        for alias, case_sensitive in aliases:
            w.alias(entity_id, alias, "amboss-crx", case_sensitive)
        destination_matches = amboss_reader._extension_destination_matches(group, 12)
        if not destination_matches:
            resolved = amboss_reader._doc_slug_map().get(amboss_reader._slugify(title))
            if resolved:
                doc_id, article_title = resolved
                destination_matches = [{"id": doc_id, "title": article_title, "href": f"/amboss?doc={doc_id}", "source": "article"}]
        for match in destination_matches:
            w.link(
                entity_id,
                "amboss",
                match.get("id") or match.get("href") or "",
                "article",
                match.get("title") or title,
                match.get("href") or "",
                match,
            )
        for item in amboss_reader._extension_media(group, 6):
            w.media(entity_id, "amboss", item.get("title") or title, item.get("url") or "", item)


def build_cliniccons_links(w: Writer) -> None:
    c = cliniccons_reader._conn()
    try:
        disease_rows = c.execute("SELECT * FROM diseases ORDER BY disease_name").fetchall()
        aliases = defaultdict(list)
        for row in c.execute("SELECT document_id, alias FROM aliases"):
            aliases[int(row["document_id"])].append(row["alias"] or "")
        icds = defaultdict(list)
        for row in c.execute("SELECT * FROM icd_codes"):
            icds[int(row["document_id"])].append(dict(row))
        algos = defaultdict(list)
        for row in c.execute("SELECT * FROM disease_algorithms ORDER BY match_score DESC, title"):
            algos[int(row["disease_document_id"])].append(dict(row))
    finally:
        c.close()

    for row in disease_rows:
        doc_id = int(row["document_id"])
        terms = [row["disease_name"], *aliases.get(doc_id, [])]
        matched = w.find_entities(*terms)
        entity_id = matched[0] if matched else w.entity(f"cliniccons:disease:{doc_id}", row["disease_name"], "cliniccons", "disease", cliniccons_reader._primary_text(row))
        w.alias(entity_id, row["disease_name"], "cliniccons")
        for alias in derived_aliases(row["disease_name"]):
            w.alias(entity_id, alias, "derived")
        for alias in aliases.get(doc_id, []):
            w.alias(entity_id, alias, "cliniccons")
        w.link(entity_id, "cliniccons", doc_id, "disease", row["disease_name"], f"/cliniccons/disease/{doc_id}/html")
        for icd in icds.get(doc_id, []):
            w.icd(entity_id, icd.get("code", ""), icd.get("description", ""), icd.get("system", "ICD"))
        for algo in algos.get(doc_id, [])[:8]:
            algo_id = algo.get("algorithm_document_id") or doc_id
            href = f"/cliniccons/algorithm/{algo_id}/html" if algo.get("algorithm_document_id") else f"/cliniccons/disease/{doc_id}/html"
            w.link(entity_id, "cliniccons", algo_id, "algorithm", algo.get("title") or row["disease_name"], href, algo)
            for image in cliniccons_reader._image_payloads(algo.get("images_json")):
                w.media(entity_id, "cliniccons", image.get("title") or algo.get("title") or row["disease_name"], image.get("url") or "", image)


def build_utd_links(w: Writer) -> None:
    seen: set[tuple[str, int]] = set()
    for item in utd_reader._topic_index():
        title = item.get("title") or ""
        if utd_reader._hide_from_hover_topic(title):
            continue
        topic_id = int(item.get("id") or 0)
        if not topic_id:
            continue
        for entity_id in w.find_entities(item.get("term") or "", title):
            canonical = w.c.execute("SELECT canonical FROM entities WHERE entity_id=?", (entity_id,)).fetchone()["canonical"]
            if title_relevance(canonical, title) < 70 and len(norm(item.get("term") or "")) <= 4:
                continue
            key = (entity_id, topic_id)
            if key in seen:
                continue
            seen.add(key)
            w.link(entity_id, "utd", topic_id, "topic", title, f"/uptodate?t={topic_id}", item)


def build_qbank_links(w: Writer, dbs: list[str]) -> None:
    for db in dbs:
        for item in qbank_reader._visual_index(db):
            title = item.get("title") or item.get("term") or "UWorld visual"
            for entity_id in w.find_entities(item.get("term") or "", title):
                href = item.get("url") or ""
                if href:
                    separator = "&" if "?" in href else "?"
                    href = f"{href}{separator}db={db}"
                source_id = item.get("exhibit_id") or item.get("name") or item.get("qid") or href
                w.link(entity_id, "qbank", source_id, item.get("kind") or "visual", title, href, {**item, "db": db})
                if item.get("kind") == "image" and href:
                    w.media(entity_id, "qbank", title, href, {**item, "db": db})
                qid = item.get("qid")
                if qid:
                    w.link(entity_id, "qbank", qid, "question", f"Source question QID {qid}", f"/qbank?db={db}&qid={qid}", {**item, "db": db})


def build(output: Path, dbs: list[str]) -> dict[str, int]:
    c = connect_output(output)
    w = Writer(c)
    try:
        build_amboss_spine(w)
        build_cliniccons_links(w)
        build_utd_links(w)
        build_qbank_links(w, dbs)
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", ("generated_at", datetime.now(timezone.utc).isoformat()))
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", ("source", "amboss-crx + cliniccons + utd + qbank visuals"))
        for key, value in sorted(w.counts.items()):
            c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (f"count_{key}", str(value)))
        c.commit()
        return dict(w.counts)
    finally:
        c.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the MedOS central reference entity database.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--db", action="append", choices=["step1", "step2", "step3"], help="QBank visual DB to link. Repeatable.")
    args = parser.parse_args()
    summary = build(args.output, args.db or ["step1", "step2", "step3"])
    print(json.dumps({"output": str(args.output), **summary}, indent=2))


if __name__ == "__main__":
    main()

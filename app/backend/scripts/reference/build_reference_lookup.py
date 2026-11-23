"""
Build the server-side reference tooltip lookup.

The runtime scanner can still use the first-token bucket index, but hover-card
payloads should resolve through one indexed SQLite lookup keyed by the normalized
term. This builder folds the entity graph, glossary definitions, concept links,
and First Aid regions into data/reference_lookup.sqlite.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from config import (  # noqa: E402
    CONCEPT_LINKS_DB,
    FIRSTAID_EDITION,
    FIRSTAID_INDEX_DB,
    GLOSSARY_DB,
    REFERENCE_ENTITIES_DB,
    REFERENCE_LOOKUP_DB,
)
import firstaid  # noqa: E402


_NON_KEY_CHARS_RE = re.compile(r"[^a-z0-9]+")
_WHITESPACE_RE = re.compile(r"\s+")
_SOURCE_PRIORITY = {
    "drug": 0,
    "amboss": 1,
    "firstaid": 2,
    "utd": 3,
    "cliniccons": 4,
    "qbank": 5,
    "books": 6,
}


def norm_key(value: str | None) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return _WHITESPACE_RE.sub(" ", _NON_KEY_CHARS_RE.sub(" ", value.lower())).strip()


def compact(value: str | None, max_len: int = 420) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= max_len:
        return text
    return text[:max_len].rsplit(" ", 1)[0].strip(" ,;:-") + "..."


def source_slug(source: str | None) -> str:
    raw = (source or "").strip().lower()
    if raw in {"amboss", "amboss-crx", "amboss_reader"}:
        return "amboss"
    if raw in {"uptodate", "utd"}:
        return "utd"
    if raw in {"first aid", "first-aid", "firstaid", "fa"}:
        return "firstaid"
    if raw in {"seslhdpr", "abbrev", "abbreviation"}:
        return "seslhdpr"
    if raw in {"drug", "drugs", "drug_reference"}:
        return "drug"
    return raw or "reference"


def source_rank(source: str | None) -> int:
    return _SOURCE_PRIORITY.get(source_slug(source), 9)


def href_for(source: str, source_id: str, fallback: str = "") -> str:
    if fallback:
        return fallback
    if not source_id:
        return ""
    if source == "amboss":
        return f"/amboss?doc={source_id}"
    if source == "utd":
        return f"/uptodate?t={source_id}"
    if source == "firstaid":
        return f"#firstaid-{source_id}"
    if source == "drug":
        return f"/drugs?id={source_id}"
    return ""


def open_ro(path: Path) -> sqlite3.Connection | None:
    if not path.exists():
        return None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def append_unique(items: list[dict[str, Any]], item: dict[str, Any], key_fields: tuple[str, ...]) -> None:
    key = tuple(str(item.get(field, "")) for field in key_fields)
    if not any(tuple(str(prev.get(field, "")) for field in key_fields) == key for prev in items):
        items.append(item)


def related_index() -> dict[tuple[str, str], list[dict[str, Any]]]:
    con = open_ro(CONCEPT_LINKS_DB)
    if con is None:
        return {}
    out: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    try:
        rows = con.execute(
            """
            SELECT source_a, id_a, title_a, source_b, id_b, title_b, similarity
            FROM concept_links
            """
        ).fetchall()
    finally:
        con.close()
    for row in rows:
        a = (source_slug(row["source_a"]), str(row["id_a"]))
        b = (source_slug(row["source_b"]), str(row["id_b"]))
        append_unique(out[a], {
            "source": b[0],
            "id": b[1],
            "title": row["title_b"] or "",
            "similarity": round(float(row["similarity"] or 0.0), 3),
        }, ("source", "id"))
        append_unique(out[b], {
            "source": a[0],
            "id": a[1],
            "title": row["title_a"] or "",
            "similarity": round(float(row["similarity"] or 0.0), 3),
        }, ("source", "id"))
    return out


def add_definition(agg: dict[str, dict[str, Any]], key: str, candidate: dict[str, Any]) -> None:
    if not key:
        return
    bucket = agg.setdefault(key, {
        "term": candidate.get("term") or candidate.get("title") or key,
        "title": candidate.get("title") or candidate.get("term") or key,
        "definitions": [],
        "source_links": [],
        "media": [],
        "expansions": [],
        "related_ids": [],
    })
    if candidate.get("term") and (len(candidate["term"]) < len(bucket["term"]) or bucket["term"] == key):
        bucket["term"] = candidate["term"]
    if candidate.get("title") and (bucket["title"] == key or source_rank(candidate.get("source")) < source_rank(bucket.get("primary_source"))):
        bucket["title"] = candidate["title"]

    source = source_slug(candidate.get("source"))
    definition = compact(candidate.get("definition") or candidate.get("abstract") or "")
    if source != "seslhdpr":
        bucket["definitions"].append({
            "source": source,
            "kind": candidate.get("kind") or "article",
            "source_id": str(candidate.get("source_id") or ""),
            "title": candidate.get("title") or candidate.get("term") or bucket["title"],
            "href": href_for(source, str(candidate.get("source_id") or ""), candidate.get("href") or ""),
            "definition": definition,
        })
    expansion = compact(candidate.get("expansion") or "", 180)
    if expansion and expansion not in bucket["expansions"]:
        bucket["expansions"].append(expansion)


def add_link(agg: dict[str, dict[str, Any]], key: str, term: str, title: str, link: dict[str, Any]) -> None:
    if not key:
        return
    bucket = agg.setdefault(key, {
        "term": term or key,
        "title": title or term or key,
        "definitions": [],
        "source_links": [],
        "media": [],
        "expansions": [],
        "related_ids": [],
    })
    source = source_slug(link.get("source"))
    source_id = str(link.get("source_id") or link.get("id") or "")
    item = {
        "id": int(source_id) if source_id.isdigit() else source_id,
        "title": link.get("title") or title or term,
        "href": href_for(source, source_id, link.get("href") or ""),
        "source": source,
        "kind": link.get("kind") or "article",
    }
    if item["href"] or item["title"]:
        append_unique(bucket["source_links"], item, ("source", "kind", "href", "title"))


def add_media(agg: dict[str, dict[str, Any]], key: str, media: dict[str, Any]) -> None:
    if not key:
        return
    bucket = agg.setdefault(key, {
        "term": key,
        "title": key,
        "definitions": [],
        "source_links": [],
        "media": [],
        "expansions": [],
        "related_ids": [],
    })
    url = media.get("url") or ""
    if not url:
        return
    append_unique(bucket["media"], {
        "title": media.get("title") or "",
        "url": url,
        "source": source_slug(media.get("source")),
    }, ("url",))


def load_glossary(agg: dict[str, dict[str, Any]]) -> None:
    con = open_ro(GLOSSARY_DB)
    if con is None:
        return
    try:
        rows = con.execute(
            """
            SELECT term, expansion, definition, source, source_id, source_rank
            FROM glossary
            WHERE COALESCE(TRIM(term), '') <> ''
            """
        ).fetchall()
    finally:
        con.close()

    for row in rows:
        source = source_slug(row["source"])
        if source == "firstaid" and not firstaid.scan_terms_for_region(row["term"]):
            continue
        display_title = row["expansion"] if source == "firstaid" and row["expansion"] else row["term"]
        key = norm_key(row["term"])
        if not key:
            continue
        add_definition(agg, key, {
            "term": row["term"],
            "title": display_title,
            "source": source,
            "source_id": str(row["source_id"] or ""),
            "kind": "region" if source == "firstaid" else "topic" if source == "utd" else "article",
            "href": href_for(source, str(row["source_id"] or "")),
            "definition": row["definition"] or "",
            "expansion": (row["expansion"] or "") if source == "seslhdpr" else "",
        })
        if source in {"amboss", "firstaid", "utd"} and row["source_id"]:
            add_link(agg, key, row["term"], row["term"], {
                "source": source,
                "source_id": str(row["source_id"]),
                "kind": "region" if source == "firstaid" else "topic" if source == "utd" else "article",
                "title": display_title,
                "href": href_for(source, str(row["source_id"])),
            })


def load_firstaid_regions(agg: dict[str, dict[str, Any]]) -> None:
    con = open_ro(FIRSTAID_INDEX_DB)
    if con is None:
        return
    try:
        rows = con.execute(
            """
            SELECT heading_id, title, hierarchy, body_text, keywords, href
            FROM firstaid_regions
            WHERE edition=? AND COALESCE(TRIM(title), '') <> ''
            """,
            (FIRSTAID_EDITION,),
        ).fetchall()
    finally:
        con.close()

    for row in rows:
        title = re.sub(r"^\d+\s+", "", row["title"] or "").strip()
        terms = firstaid.scan_terms_for_region(title, row["hierarchy"], row["body_text"], row["keywords"])
        if not terms:
            continue
        heading_id = str(row["heading_id"])
        for term in terms:
            key = norm_key(term)
            if not key:
                continue
            add_definition(agg, key, {
                "term": term,
                "title": title,
                "source": "firstaid",
                "source_id": heading_id,
                "kind": "region",
                "href": f"#firstaid-{heading_id}",
                "definition": row["body_text"] or row["hierarchy"] or "",
            })
            add_link(agg, key, term, title, {
                "source": "firstaid",
                "source_id": heading_id,
                "kind": "region",
                "title": title,
                "href": f"#firstaid-{heading_id}",
            })
            add_media(agg, key, {
                "title": title,
                "source": "firstaid",
                "url": f"/firstaid/snippet/image?heading_id={heading_id}&zoom=2",
            })


def load_entities(agg: dict[str, dict[str, Any]], related: dict[tuple[str, str], list[dict[str, Any]]]) -> None:
    con = open_ro(REFERENCE_ENTITIES_DB)
    if con is None:
        return
    try:
        entities = {row["entity_id"]: dict(row) for row in con.execute("SELECT * FROM entities").fetchall()}
        alias_rows = con.execute("SELECT entity_id, alias FROM aliases").fetchall()
        link_rows = con.execute("SELECT entity_id, source, source_id, kind, title, href FROM links").fetchall()
        media_rows = con.execute("SELECT entity_id, source, title, url FROM media").fetchall()
    finally:
        con.close()

    aliases_by_entity: dict[str, list[str]] = defaultdict(list)
    for row in alias_rows:
        alias = row["alias"] or ""
        if alias.strip():
            aliases_by_entity[row["entity_id"]].append(alias)

    links_by_entity: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in link_rows:
        source = source_slug(row["source"])
        links_by_entity[row["entity_id"]].append({
            "source": source,
            "source_id": str(row["source_id"] or ""),
            "kind": row["kind"] or "article",
            "title": row["title"] or "",
            "href": href_for(source, str(row["source_id"] or ""), row["href"] or ""),
        })

    media_by_entity: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in media_rows:
        media_by_entity[row["entity_id"]].append({
            "source": source_slug(row["source"]),
            "title": row["title"] or "",
            "url": row["url"] or "",
        })

    for entity_id, entity in entities.items():
        canonical = entity.get("canonical") or ""
        if not norm_key(canonical):
            continue
        source = source_slug(entity.get("primary_source"))
        terms = [canonical, *aliases_by_entity.get(entity_id, [])]
        keys = {norm_key(term): term for term in terms if norm_key(term)}
        if not keys:
            continue
        preferred_link = sorted(links_by_entity.get(entity_id, []), key=lambda item: (source_rank(item["source"]), len(item.get("title") or "")))
        source_id = preferred_link[0]["source_id"] if preferred_link else ""
        href = preferred_link[0]["href"] if preferred_link else ""
        for key, term in keys.items():
            add_definition(agg, key, {
                "term": term,
                "title": canonical,
                "source": source,
                "source_id": source_id,
                "kind": entity.get("kind") or "concept",
                "href": href,
                "definition": entity.get("abstract") or "",
            })
            for link in links_by_entity.get(entity_id, []):
                add_link(agg, key, term, canonical, link)
                for rel in related.get((link["source"], str(link["source_id"])), [])[:8]:
                    append_unique(agg[key]["related_ids"], rel, ("source", "id"))
            for media in media_by_entity.get(entity_id, []):
                add_media(agg, key, media)


def choose_primary(bucket: dict[str, Any]) -> dict[str, Any]:
    definitions = bucket.get("definitions") or []
    if not definitions:
        links = bucket.get("source_links") or []
        if links:
            link = sorted(links, key=lambda item: (source_rank(item.get("source")), len(item.get("title") or "")))[0]
            return {
                "source": source_slug(link.get("source")),
                "kind": link.get("kind") or "article",
                "source_id": str(link.get("id") or ""),
                "href": link.get("href") or "",
                "title": link.get("title") or bucket.get("title") or bucket.get("term") or "",
                "definition": "",
            }
        return {
            "source": "reference",
            "kind": "concept",
            "source_id": "",
            "href": "",
            "title": bucket.get("title") or bucket.get("term") or "",
            "definition": "",
        }
    return sorted(
        definitions,
        key=lambda item: (
            source_rank(item.get("source")),
            0 if item.get("definition") else 1,
            len(item.get("title") or ""),
        ),
    )[0]


def write_lookup(agg: dict[str, dict[str, Any]], output: Path) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(str(tmp))
    try:
        con.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            CREATE TABLE lookup (
              term_key TEXT PRIMARY KEY,
              term TEXT NOT NULL,
              title TEXT NOT NULL,
              source TEXT NOT NULL,
              kind TEXT NOT NULL,
              primary_source TEXT NOT NULL,
              primary_kind TEXT NOT NULL,
              primary_id TEXT NOT NULL,
              primary_href TEXT NOT NULL,
              primary_def TEXT NOT NULL,
              expansion TEXT NOT NULL DEFAULT '',
              expansions_json TEXT NOT NULL DEFAULT '[]',
              source_links_json TEXT NOT NULL DEFAULT '[]',
              image_urls_json TEXT NOT NULL DEFAULT '[]',
              related_ids_json TEXT NOT NULL DEFAULT '[]',
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX idx_lookup_source ON lookup(primary_source);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        now = int(time.time())
        rows = []
        for key, bucket in agg.items():
            if not key:
                continue
            primary = choose_primary(bucket)
            links = sorted(bucket.get("source_links") or [], key=lambda item: (
                source_rank(item.get("source")),
                0 if item.get("href") == primary.get("href") else 1,
            ))
            media = sorted(bucket.get("media") or [], key=lambda item: (source_rank(item.get("source")), item.get("title") or ""))[:8]
            expansions = bucket.get("expansions") or []
            rows.append((
                key,
                bucket.get("term") or primary.get("title") or key,
                primary.get("title") or bucket.get("title") or bucket.get("term") or key,
                primary.get("source") or "reference",
                primary.get("kind") or "concept",
                primary.get("source") or "reference",
                primary.get("kind") or "concept",
                str(primary.get("source_id") or ""),
                primary.get("href") or "",
                primary.get("definition") or "",
                expansions[0] if expansions else "",
                safe_json(expansions),
                safe_json(links[:16]),
                safe_json(media),
                safe_json((bucket.get("related_ids") or [])[:20]),
                now,
            ))
        con.executemany(
            """
            INSERT INTO lookup (
              term_key, term, title, source, kind, primary_source, primary_kind,
              primary_id, primary_href, primary_def, expansion, expansions_json,
              source_links_json, image_urls_json, related_ids_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        con.executemany(
            "INSERT INTO meta(key, value) VALUES(?, ?)",
            [
                ("built_at", str(now)),
                ("row_count", str(len(rows))),
                ("source_priority", "amboss>firstaid>utd; drug overrides in runtime"),
            ],
        )
        con.commit()
    finally:
        con.close()
    if output.exists():
        output.unlink()
    tmp.replace(output)
    return len(rows)


def build(output: Path = REFERENCE_LOOKUP_DB) -> int:
    agg: dict[str, dict[str, Any]] = {}
    rel = related_index()
    load_glossary(agg)
    load_firstaid_regions(agg)
    load_entities(agg, rel)
    return write_lookup(agg, output)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build data/reference_lookup.sqlite")
    parser.add_argument("--output", type=Path, default=REFERENCE_LOOKUP_DB)
    args = parser.parse_args()
    count = build(args.output)
    print(f"Built {args.output} with {count:,} lookup rows")


if __name__ == "__main__":
    main()

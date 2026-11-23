"""
Custom Library storage.

One SQLite file holds everything the user builds themselves:

  custom_nodes        folders (nested to any depth), saved links, editable docs
  custom_annotations  highlighted passages per source article
  custom_images       images embedded in editable docs (stored as BLOBs)

Saved links point at the vendor libraries by (source, ref_id) and keep the
href needed to reopen the article. Editable copies are stored as sanitized
HTML, never written back to the vendor bundle.

The DB lives under MedOS/data so it survives application updates.
"""
from __future__ import annotations

import re
import sqlite3
import time
import uuid
from typing import Any, Iterable, Optional

from config import ROOT

DB_PATH = ROOT / "data" / "custom-library.sqlite3"

KINDS = {"folder", "link", "doc"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024

_SCHEMA = """
CREATE TABLE IF NOT EXISTS custom_nodes (
    id         TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    parent_id  TEXT,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    position   REAL NOT NULL DEFAULT 0,
    source     TEXT,
    ref_id     TEXT,
    href       TEXT,
    body_html  TEXT,
    meta_json  TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_nodes_user
    ON custom_nodes(user_email, parent_id, position);

CREATE TABLE IF NOT EXISTS custom_annotations (
    id           TEXT PRIMARY KEY,
    user_email   TEXT NOT NULL,
    source       TEXT NOT NULL,
    ref_id       TEXT NOT NULL,
    quote        TEXT NOT NULL,
    prefix       TEXT NOT NULL DEFAULT '',
    suffix       TEXT NOT NULL DEFAULT '',
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset   INTEGER NOT NULL DEFAULT -1,
    color        TEXT NOT NULL DEFAULT 'yellow',
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_ann_user_ref
    ON custom_annotations(user_email, source, ref_id);

CREATE TABLE IF NOT EXISTS custom_images (
    id         TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL
);
"""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA)
    return conn


def _json(text: Optional[str]) -> dict:
    import json

    try:
        value = json.loads(text or "{}")
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def node_to_public(row: sqlite3.Row, include_body: bool = False) -> dict:
    out = {
        "id": row["id"],
        "parentId": row["parent_id"],
        "kind": row["kind"],
        "title": row["title"],
        "position": row["position"],
        "source": row["source"],
        "refId": row["ref_id"],
        "href": row["href"],
        "meta": _json(row["meta_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "hasBody": bool(row["body_html"]),
    }
    if include_body:
        out["bodyHtml"] = row["body_html"] or ""
    return out


def list_nodes(conn: sqlite3.Connection, user_email: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM custom_nodes WHERE user_email=? "
        "ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, position, lower(title)",
        (user_email,),
    ).fetchall()
    return [node_to_public(r) for r in rows]


def get_node(conn: sqlite3.Connection, user_email: str, node_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM custom_nodes WHERE id=? AND user_email=?", (node_id, user_email)
    ).fetchone()


def _next_position(conn: sqlite3.Connection, user_email: str, parent_id: Optional[str]) -> float:
    if parent_id:
        row = conn.execute(
            "SELECT MAX(position) AS p FROM custom_nodes WHERE user_email=? AND parent_id=?",
            (user_email, parent_id),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT MAX(position) AS p FROM custom_nodes WHERE user_email=? AND parent_id IS NULL",
            (user_email,),
        ).fetchone()
    value = row["p"] if row and row["p"] is not None else 0.0
    return float(value) + 100.0


def _validate_parent(conn: sqlite3.Connection, user_email: str, parent_id: Optional[str]) -> Optional[str]:
    if not parent_id:
        return None
    row = get_node(conn, user_email, parent_id)
    if not row or row["kind"] != "folder":
        raise ValueError("Parent folder not found")
    return parent_id


def create_node(
    conn: sqlite3.Connection,
    user_email: str,
    *,
    kind: str,
    title: str,
    parent_id: Optional[str] = None,
    source: Optional[str] = None,
    ref_id: Optional[str] = None,
    href: Optional[str] = None,
    body_html: Optional[str] = None,
    meta: Optional[dict] = None,
) -> str:
    if kind not in KINDS:
        raise ValueError("Invalid node kind")
    title = (title or "").strip() or ("New folder" if kind == "folder" else "Untitled")
    parent_id = _validate_parent(conn, user_email, parent_id)
    node_id = uuid.uuid4().hex
    now = _now()
    conn.execute(
        "INSERT INTO custom_nodes "
        "(id, user_email, parent_id, kind, title, position, source, ref_id, href, body_html, meta_json, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            node_id, user_email, parent_id, kind, title[:400],
            _next_position(conn, user_email, parent_id),
            source, str(ref_id) if ref_id is not None else None,
            href, body_html, __import__("json").dumps(meta or {}), now, now,
        ),
    )
    return node_id


def find_link(conn: sqlite3.Connection, user_email: str, source: str, ref_id: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM custom_nodes WHERE user_email=? AND kind='link' AND source=? AND ref_id=? LIMIT 1",
        (user_email, source, str(ref_id)),
    ).fetchone()


def find_copy(conn: sqlite3.Connection, user_email: str, source: str, ref_id: str) -> Optional[sqlite3.Row]:
    rows = conn.execute(
        "SELECT * FROM custom_nodes WHERE user_email=? AND kind='doc'", (user_email,)
    ).fetchall()
    for row in rows:
        meta = _json(row["meta_json"])
        if meta.get("originSource") == source and str(meta.get("originRefId")) == str(ref_id):
            return row
    return None


def update_node(
    conn: sqlite3.Connection,
    user_email: str,
    node_id: str,
    *,
    title: Optional[str] = None,
    parent_id: Optional[str] = None,
    has_parent_field: bool = False,
    position: Optional[float] = None,
    body_html: Optional[str] = None,
    href: Optional[str] = None,
    meta: Optional[dict] = None,
) -> bool:
    row = get_node(conn, user_email, node_id)
    if not row:
        return False
    fields: list[str] = []
    params: list[Any] = []

    if title is not None:
        fields.append("title=?")
        params.append(title.strip()[:400] or row["title"])
    if has_parent_field:
        new_parent = _validate_parent(conn, user_email, parent_id)
        if new_parent == node_id:
            raise ValueError("A folder cannot contain itself")
        if new_parent:
            # Reject moves into own descendant.
            cursor = new_parent
            guard = 0
            while cursor and guard < 500:
                if cursor == node_id:
                    raise ValueError("A folder cannot be moved inside itself")
                parent_row = get_node(conn, user_email, cursor)
                cursor = parent_row["parent_id"] if parent_row else None
                guard += 1
        fields.extend(["parent_id=?", "position=?"])
        params.extend([new_parent, _next_position(conn, user_email, new_parent)])
    elif position is not None:
        fields.append("position=?")
        params.append(float(position))
    if body_html is not None:
        fields.append("body_html=?")
        params.append(body_html)
    if href is not None:
        fields.append("href=?")
        params.append(href)
    if meta is not None:
        fields.append("meta_json=?")
        params.append(__import__("json").dumps(meta))

    if not fields:
        return True
    fields.append("updated_at=?")
    params.append(_now())
    params.append(node_id)
    params.append(user_email)
    conn.execute(f"UPDATE custom_nodes SET {', '.join(fields)} WHERE id=? AND user_email=?", params)
    return True


def delete_node(conn: sqlite3.Connection, user_email: str, node_id: str) -> int:
    row = get_node(conn, user_email, node_id)
    if not row:
        return 0
    ids = [node_id]
    frontier = [node_id]
    guard = 0
    while frontier and guard < 10000:
        placeholders = ",".join("?" for _ in frontier)
        children = conn.execute(
            f"SELECT id FROM custom_nodes WHERE user_email=? AND parent_id IN ({placeholders})",
            [user_email, *frontier],
        ).fetchall()
        frontier = [c["id"] for c in children if c["id"] not in ids]
        ids.extend(frontier)
        guard += len(ids)
    placeholders = ",".join("?" for _ in ids)
    conn.execute(
        f"DELETE FROM custom_nodes WHERE user_email=? AND id IN ({placeholders})",
        [user_email, *ids],
    )
    return len(ids)


# ─── Annotations ────────────────────────────────────────────────────────────

def list_annotations(conn: sqlite3.Connection, user_email: str, source: str, ref_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM custom_annotations WHERE user_email=? AND source=? AND ref_id=? "
        "ORDER BY start_offset, created_at",
        (user_email, source, str(ref_id)),
    ).fetchall()
    return [annotation_to_public(r) for r in rows]


def annotation_to_public(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "source": row["source"],
        "refId": row["ref_id"],
        "quote": row["quote"],
        "prefix": row["prefix"],
        "suffix": row["suffix"],
        "start": row["start_offset"],
        "end": row["end_offset"],
        "color": row["color"],
        "note": row["note"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def create_annotation(
    conn: sqlite3.Connection,
    user_email: str,
    *,
    source: str,
    ref_id: str,
    quote: str,
    prefix: str = "",
    suffix: str = "",
    start: int = -1,
    end: int = -1,
    color: str = "yellow",
    note: str = "",
) -> str:
    annotation_id = uuid.uuid4().hex
    now = _now()
    conn.execute(
        "INSERT INTO custom_annotations "
        "(id, user_email, source, ref_id, quote, prefix, suffix, start_offset, end_offset, color, note, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            annotation_id, user_email, source, str(ref_id), quote[:4000],
            prefix[:200], suffix[:200], int(start), int(end),
            color or "yellow", note[:8000], now, now,
        ),
    )
    return annotation_id


def update_annotation(
    conn: sqlite3.Connection,
    user_email: str,
    annotation_id: str,
    *,
    color: Optional[str] = None,
    note: Optional[str] = None,
) -> bool:
    fields: list[str] = []
    params: list[Any] = []
    if color is not None:
        fields.append("color=?")
        params.append(color or "yellow")
    if note is not None:
        fields.append("note=?")
        params.append(note[:8000])
    if not fields:
        return True
    fields.append("updated_at=?")
    params.append(_now())
    params.extend([annotation_id, user_email])
    cur = conn.execute(
        f"UPDATE custom_annotations SET {', '.join(fields)} WHERE id=? AND user_email=?",
        params,
    )
    return cur.rowcount > 0


def delete_annotation(conn: sqlite3.Connection, user_email: str, annotation_id: str) -> bool:
    cur = conn.execute(
        "DELETE FROM custom_annotations WHERE id=? AND user_email=?", (annotation_id, user_email)
    )
    return cur.rowcount > 0


def annotation_count(conn: sqlite3.Connection, user_email: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM custom_annotations WHERE user_email=?", (user_email,)
    ).fetchone()
    return int(row["n"] if row else 0)


# ─── Images ─────────────────────────────────────────────────────────────────

def save_image(conn: sqlite3.Connection, user_email: str, filename: str, mime: str, data: bytes) -> str:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Image is larger than 8 MB")
    if not (mime or "").startswith("image/"):
        raise ValueError("Only image uploads are supported")
    if mime.lower() in {"image/svg+xml", "image/svg"}:
        raise ValueError("SVG uploads are not supported")
    image_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO custom_images (id, user_email, filename, mime, data, created_at) VALUES (?,?,?,?,?,?)",
        (image_id, user_email, filename[:240], mime, sqlite3.Binary(data), _now()),
    )
    return image_id


def get_image(conn: sqlite3.Connection, image_id: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM custom_images WHERE id=?", (image_id,)).fetchone()


# ─── Sanitising stored docs ─────────────────────────────────────────────────

_SCRIPT_BLOCK = re.compile(r"<\s*(script|style|iframe|object|embed)\b[^>]*>.*?<\s*/\s*\1\s*>", re.I | re.S)
_DANGEROUS_TAG = re.compile(r"<\s*/?\s*(script|style|iframe|object|embed|form|input|button|textarea|select)\b[^>]*>", re.I)
_EVENT_ATTR = re.compile(r"\son\w+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
_JS_URL = re.compile(r"(?:href|src)\s*=\s*([\"'])\s*javascript:[^\"']*\1", re.I)


def sanitize_doc_html(html: str) -> str:
    text = _SCRIPT_BLOCK.sub("", html or "")
    text = _DANGEROUS_TAG.sub("", text)
    text = _EVENT_ATTR.sub("", text)
    text = _JS_URL.sub('href="#"', text)
    return text


# ─── Editable copies from vendor libraries ─────────────────────────────────

def _public_asset_urls(fragment: str) -> str:
    """Point backend-relative image URLs at the /api proxy (same origin as the app)."""
    def rewrite(match: re.Match) -> str:
        attr, quote, path = match.group(1), match.group(2), match.group(3)
        if path.startswith(("/api/", "//", "http://", "https://", "data:", "#")):
            return match.group(0)
        return f"{attr}={quote}/api/{path.lstrip('/')}{quote}"

    fragment = re.sub(
        r"\b(src|poster)=([\"'])([^\"']+)\2", rewrite, fragment, flags=re.I
    )
    fragment = re.sub(
        r"\bsrcset=([\"'])([^\"']+)\1",
        lambda m: 'srcset=' + m.group(1) + re.sub(
            r"(^|,\s*)(?!/|https?:|data:)([^\s,]+)",
            lambda s: s.group(1) + "/api/" + s.group(2).lstrip("/"),
            m.group(2),
        ) + m.group(1),
        fragment,
        flags=re.I,
    )
    return fragment


def extract_source_article(source: str, ref_id: str) -> tuple[str, str, str]:
    """Return (title, sanitized body html, origin href) for one vendor article."""
    source = (source or "").strip().lower()
    ref = str(ref_id or "").strip()

    if source == "uworld":
        import uworld_library_reader as U

        row = U._article_row(int(ref))
        if not row["doc"]:
            raise ValueError("This article has no content")
        decrypted = U._decrypt_doc(row["id"], row["doc"])
        body = U._sanitize_uworld_print_article(decrypted)
        return row["title"] or f"UWorld article {ref}", _public_asset_urls(body), f"/library/uworld?doc={row['id']}"

    if source == "amboss":
        import amboss_reader as A

        conn = A._conn()
        try:
            row = conn.execute("SELECT id, title, doc FROM Docs WHERE id=?", (int(ref),)).fetchone()
        finally:
            conn.close()
        if not row:
            raise ValueError("AMBOSS article not found")
        if not row["doc"]:
            raise ValueError("This article has no content")
        decrypted = A.decrypt_doc(row["id"], row["doc"])
        rewritten = A._rewrite_article_assets(decrypted)
        tree = A.HTMLParser(rewritten)
        article = tree.css_first("article")
        fragment = article.html if article else A._fragment_inner_html(tree)
        body = A._sanitize_amboss_print_fragment(fragment)
        return row["title"] or f"AMBOSS article {ref}", _public_asset_urls(body), f"/amboss?doc={row['id']}"

    if source == "utd":
        import utd_reader as UT

        data = UT._topic_data(int(ref))
        body = UT._sanitize_utd_print_fragment(data.get("bodyHtml", "") if isinstance(data, dict) else "")
        conn = UT._conn("unidex.en.sqlite")
        try:
            row = conn.execute("SELECT title FROM topic WHERE topic_id=?", (int(ref),)).fetchone()
        finally:
            conn.close()
        title = (row["title"] if row else "") or f"UpToDate topic {ref}"
        return title, _public_asset_urls(body), f"/uptodate?t={ref}"

    raise ValueError(f"Unsupported source '{source}'")

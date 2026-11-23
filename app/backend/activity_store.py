"""
Unified user-activity & progression store.

This is the durable "progression tracking file": it shares the same SQLite
database as the Q-Bank state (`QBANK_STATE_DB` / qbank_state.sqlite3) so that one
file holds the *complete* portable record — qbank QID ledger + reading history +
search history + resume pointers. That makes version-to-version export/import a
single-file operation (see routers/activity.py).

We deliberately reuse qbank_reader's connection (`_state_conn`) and JSON/id
helpers rather than re-implement them, so the WAL pragmas, migrations and the
`qbank_progress` table all stay in one place. qbank_reader never imports this
module, so there is no import cycle.

Tables added here (idempotent, created on first connection):
  • activity_events  — append-only feed of everything the user did
  • last_location    — single-row-per-user resume pointer
  • page_scroll      — per-href scroll position for back-navigation restore
  • search_history   — every search, for "common searches"
"""
from __future__ import annotations

from typing import Any, Iterable, Optional
import sqlite3

from qbank_reader import (
    _state_conn,
    _json_dumps,
    _json_loads,
    _normalize_id_list,
    _utc_now,
)

# Event kinds that represent a place the user can be sent back to on app restart.
# Ephemeral surfaces (e.g. a drug popup, a search) are logged but never become
# the resume pointer.
_RESUMABLE_KINDS = {"read", "page_open", "qbank_block", "exam"}

_MAX_EVENTS = 2000        # newest-N retained per user
_MAX_SCROLL_ROWS = 400    # LRU cap on page_scroll rows per user
_MAX_SEARCHES = 1000


# ─── Schema ──────────────────────────────────────────────────────────────────

def _ensure_activity_tables(c: sqlite3.Connection) -> None:
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS activity_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL,
            ts         TEXT NOT NULL,
            kind       TEXT NOT NULL,
            source     TEXT,
            ref_id     TEXT,
            title      TEXT,
            href       TEXT,
            detail     TEXT,
            meta_json  TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_activity_events_user_id
            ON activity_events(user_email, id DESC);

        CREATE TABLE IF NOT EXISTS last_location (
            user_email TEXT PRIMARY KEY,
            href       TEXT NOT NULL,
            title      TEXT,
            source     TEXT,
            kind       TEXT,
            ref_id     TEXT,
            scroll_y   REAL NOT NULL DEFAULT 0,
            meta_json  TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS page_scroll (
            user_email TEXT NOT NULL,
            href       TEXT NOT NULL,
            scroll_y   REAL NOT NULL DEFAULT 0,
            anchor     TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (user_email, href)
        );
        CREATE INDEX IF NOT EXISTS idx_page_scroll_user_updated
            ON page_scroll(user_email, updated_at DESC);

        CREATE TABLE IF NOT EXISTS search_history (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email    TEXT NOT NULL,
            query         TEXT NOT NULL,
            scopes        TEXT,
            results_count INTEGER,
            ts            TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_search_history_user_id
            ON search_history(user_email, id DESC);
        """
    )


_ACTIVITY_TABLES_READY = False


def aconn() -> sqlite3.Connection:
    """A state connection guaranteed to have both the qbank and activity tables.

    The activity-table DDL is idempotent (CREATE TABLE IF NOT EXISTS), so it
    only needs to run once per process. Re-running the multi-statement script
    on every /activity/* request added needless write work and lock contention
    during the client's load burst — exactly when uvicorn is still warming up.
    """
    global _ACTIVITY_TABLES_READY
    c = _state_conn()           # creates/migrates qbank tables + WAL pragmas
    if not _ACTIVITY_TABLES_READY:
        _ensure_activity_tables(c)
        c.commit()
        _ACTIVITY_TABLES_READY = True
    return c


# ─── Events + resume pointer ─────────────────────────────────────────────────

def _prune_events(c: sqlite3.Connection, user_email: str) -> None:
    row = c.execute(
        "SELECT id FROM activity_events WHERE user_email=? ORDER BY id DESC LIMIT 1 OFFSET ?",
        (user_email, _MAX_EVENTS),
    ).fetchone()
    if row:
        c.execute(
            "DELETE FROM activity_events WHERE user_email=? AND id <= ?",
            (user_email, row["id"]),
        )


def record_event(
    c: sqlite3.Connection,
    user_email: str,
    *,
    kind: str,
    source: Optional[str] = None,
    ref_id: Optional[Any] = None,
    title: Optional[str] = None,
    href: Optional[str] = None,
    detail: Optional[str] = None,
    meta: Optional[dict] = None,
    scroll_y: Optional[float] = None,
    resumable: Optional[bool] = None,
) -> str:
    ts = _utc_now()
    c.execute(
        "INSERT INTO activity_events "
        "(user_email, ts, kind, source, ref_id, title, href, detail, meta_json) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (
            user_email, ts, kind, source,
            None if ref_id is None else str(ref_id),
            title, href, detail, _json_dumps(meta or {}),
        ),
    )
    is_resumable = resumable if resumable is not None else (kind in _RESUMABLE_KINDS)
    if is_resumable and href:
        set_last_location(
            c, user_email, href=href, title=title, source=source,
            kind=kind, ref_id=ref_id, scroll_y=scroll_y, meta=meta,
        )
    _prune_events(c, user_email)
    return ts


def set_last_location(
    c: sqlite3.Connection,
    user_email: str,
    *,
    href: str,
    title: Optional[str] = None,
    source: Optional[str] = None,
    kind: Optional[str] = None,
    ref_id: Optional[Any] = None,
    scroll_y: Optional[float] = None,
    meta: Optional[dict] = None,
) -> None:
    # When no scroll is supplied, keep the page's previously-known scroll if we
    # are re-pinning the same href, otherwise start at the top.
    if scroll_y is None:
        existing = c.execute(
            "SELECT href, scroll_y FROM last_location WHERE user_email=?",
            (user_email,),
        ).fetchone()
        if existing and existing["href"] == href:
            scroll_y = existing["scroll_y"]
        else:
            known = c.execute(
                "SELECT scroll_y FROM page_scroll WHERE user_email=? AND href=?",
                (user_email, href),
            ).fetchone()
            scroll_y = known["scroll_y"] if known else 0
    c.execute(
        """
        INSERT INTO last_location
            (user_email, href, title, source, kind, ref_id, scroll_y, meta_json, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_email) DO UPDATE SET
            href=excluded.href, title=excluded.title, source=excluded.source,
            kind=excluded.kind, ref_id=excluded.ref_id, scroll_y=excluded.scroll_y,
            meta_json=excluded.meta_json, updated_at=excluded.updated_at
        """,
        (
            user_email, href, title, source, kind,
            None if ref_id is None else str(ref_id),
            float(scroll_y or 0), _json_dumps(meta or {}), _utc_now(),
        ),
    )


def get_last_location(c: sqlite3.Connection, user_email: str) -> Optional[dict]:
    row = c.execute(
        "SELECT href, title, source, kind, ref_id, scroll_y, meta_json, updated_at "
        "FROM last_location WHERE user_email=?",
        (user_email,),
    ).fetchone()
    if not row:
        return None
    return {
        "href": row["href"],
        "title": row["title"],
        "source": row["source"],
        "kind": row["kind"],
        "ref_id": row["ref_id"],
        "scroll_y": row["scroll_y"],
        "meta": _json_loads(row["meta_json"], {}),
        "updated_at": row["updated_at"],
    }


def recent_events(
    c: sqlite3.Connection,
    user_email: str,
    limit: int = 30,
    kinds: Optional[Iterable[str]] = None,
) -> list[dict]:
    sql = (
        "SELECT ts, kind, source, ref_id, title, href, detail, meta_json "
        "FROM activity_events WHERE user_email=?"
    )
    params: list[Any] = [user_email]
    kind_list = list(kinds) if kinds else []
    if kind_list:
        sql += " AND kind IN (%s)" % ",".join("?" * len(kind_list))
        params += kind_list
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    rows = c.execute(sql, params).fetchall()
    return [
        {
            "ts": r["ts"], "kind": r["kind"], "source": r["source"],
            "ref_id": r["ref_id"], "title": r["title"], "href": r["href"],
            "detail": r["detail"], "meta": _json_loads(r["meta_json"], {}),
        }
        for r in rows
    ]


# ─── Scroll positions ────────────────────────────────────────────────────────

def _prune_scroll(c: sqlite3.Connection, user_email: str) -> None:
    row = c.execute(
        "SELECT updated_at FROM page_scroll WHERE user_email=? "
        "ORDER BY updated_at DESC LIMIT 1 OFFSET ?",
        (user_email, _MAX_SCROLL_ROWS),
    ).fetchone()
    if row:
        c.execute(
            "DELETE FROM page_scroll WHERE user_email=? AND updated_at <= ?",
            (user_email, row["updated_at"]),
        )


def save_scroll(
    c: sqlite3.Connection,
    user_email: str,
    href: str,
    scroll_y: float,
    anchor: Optional[str] = None,
) -> None:
    now = _utc_now()
    y = float(scroll_y or 0)
    c.execute(
        """
        INSERT INTO page_scroll (user_email, href, scroll_y, anchor, updated_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(user_email, href) DO UPDATE SET
            scroll_y=excluded.scroll_y, anchor=excluded.anchor, updated_at=excluded.updated_at
        """,
        (user_email, href, y, anchor, now),
    )
    # Keep the resume pointer's scroll fresh when it points at this page.
    c.execute(
        "UPDATE last_location SET scroll_y=?, updated_at=? WHERE user_email=? AND href=?",
        (y, now, user_email, href),
    )
    _prune_scroll(c, user_email)


def get_scroll(c: sqlite3.Connection, user_email: str, href: str) -> Optional[dict]:
    row = c.execute(
        "SELECT scroll_y, anchor FROM page_scroll WHERE user_email=? AND href=?",
        (user_email, href),
    ).fetchone()
    if not row:
        return None
    return {"scroll_y": row["scroll_y"], "anchor": row["anchor"]}


# ─── Search history ──────────────────────────────────────────────────────────

def log_search(
    c: sqlite3.Connection,
    user_email: str,
    query: str,
    scopes: Optional[str] = None,
    results_count: Optional[int] = None,
) -> None:
    q = (query or "").strip()
    if not q:
        return
    c.execute(
        "INSERT INTO search_history (user_email, query, scopes, results_count, ts) "
        "VALUES (?,?,?,?,?)",
        (user_email, q, scopes, results_count, _utc_now()),
    )
    row = c.execute(
        "SELECT id FROM search_history WHERE user_email=? ORDER BY id DESC LIMIT 1 OFFSET ?",
        (user_email, _MAX_SEARCHES),
    ).fetchone()
    if row:
        c.execute(
            "DELETE FROM search_history WHERE user_email=? AND id <= ?",
            (user_email, row["id"]),
        )


def recent_searches(c: sqlite3.Connection, user_email: str, limit: int = 20) -> list[dict]:
    rows = c.execute(
        "SELECT query, scopes, results_count, ts FROM search_history "
        "WHERE user_email=? ORDER BY id DESC LIMIT ?",
        (user_email, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def top_searches(c: sqlite3.Connection, user_email: str, limit: int = 10) -> list[dict]:
    rows = c.execute(
        """
        SELECT query, COUNT(*) AS n, MAX(ts) AS last_ts
        FROM search_history WHERE user_email=?
        GROUP BY LOWER(query)
        ORDER BY n DESC, last_ts DESC
        LIMIT ?
        """,
        (user_email, limit),
    ).fetchall()
    return [{"query": r["query"], "count": r["n"], "last_ts": r["last_ts"]} for r in rows]


# ─── Progression portability (version-to-version sync) ───────────────────────

def merge_progress(
    c: sqlite3.Connection,
    user_email: str,
    used_by_db: Optional[dict],
    marked_by_db: Optional[dict],
) -> dict:
    """Union imported used/marked QID maps into qbank_progress.

    Keyed by raw QID so a refreshed UWorld DB or a new app build never resets
    progress: questions that still exist stay 'used', genuinely new ones show as
    unused. Idempotent — re-importing the same file adds nothing.
    """
    used = used_by_db if isinstance(used_by_db, dict) else {}
    marked = marked_by_db if isinstance(marked_by_db, dict) else {}
    keys = set(used) | set(marked)
    summary = {"banksTouched": 0, "usedAdded": 0, "markedAdded": 0, "banks": {}}
    now = _utc_now()
    for db in sorted(keys):
        cur = c.execute(
            "SELECT used_ids, marked_ids FROM qbank_progress WHERE user_email=? AND db=?",
            (user_email, db),
        ).fetchone()
        cur_used = set(_normalize_id_list(_json_loads(cur["used_ids"], []))) if cur else set()
        cur_marked = set(_normalize_id_list(_json_loads(cur["marked_ids"], []))) if cur else set()
        new_used = set(_normalize_id_list(used.get(db)))
        new_marked = set(_normalize_id_list(marked.get(db)))
        merged_used = cur_used | new_used
        merged_marked = cur_marked | new_marked
        added_u = len(merged_used) - len(cur_used)
        added_m = len(merged_marked) - len(cur_marked)
        if not (new_used or new_marked):
            continue
        c.execute(
            """
            INSERT INTO qbank_progress (user_email, db, used_ids, marked_ids, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_email, db) DO UPDATE SET
                used_ids=excluded.used_ids, marked_ids=excluded.marked_ids, updated_at=excluded.updated_at
            """,
            (user_email, db, _json_dumps(sorted(merged_used)), _json_dumps(sorted(merged_marked)), now),
        )
        summary["banksTouched"] += 1
        summary["usedAdded"] += added_u
        summary["markedAdded"] += added_m
        summary["banks"][db] = {
            "usedAdded": added_u, "markedAdded": added_m,
            "usedTotal": len(merged_used), "markedTotal": len(merged_marked),
        }
    return summary

"""
UpToDate DDx router — serves the normalized data/uptodate ddx/utdddx.sqlite
(built by scripts/build_utdddx.py from the unencrypted uptodateddx.db).

Model: a differential-diagnosis matrix. A "main" diagnosis (presenting problem)
owns a list of candidate differentials, each with distinguishing SIGNS and TESTS.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from config import UTDDDX_DB

router = APIRouter(prefix="/utdddx", tags=["utdddx"])


def _conn() -> sqlite3.Connection:
    if not Path(UTDDDX_DB).exists():
        raise HTTPException(
            status_code=503,
            detail={"error": "UTD DDx database not built yet. Run scripts/build_utdddx.py"},
        )
    c = sqlite3.connect(f"file:{UTDDDX_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=4000")
    return c


def _fts_query(q: str) -> str:
    toks = re.findall(r"[\w]+", q.lower())
    if not toks:
        return ""
    return " ".join(f'"{t}"*' for t in toks)


@router.get("/health")
def utdddx_health():
    if not Path(UTDDDX_DB).exists():
        return {"configured": True, "exists": False, "path": str(UTDDDX_DB)}
    try:
        c = _conn()
        n = c.execute("SELECT COUNT(*) FROM ddx_topics").fetchone()[0]
        main = c.execute("SELECT COUNT(*) FROM ddx_topics WHERE is_main=1").fetchone()[0]
        c.close()
        return {"configured": True, "exists": True, "topic_count": n, "main_count": main}
    except Exception as e:  # pragma: no cover
        return {"configured": True, "exists": True, "error": str(e)}


@router.get("/search")
def utdddx_search(
    q: str = Query(..., min_length=1, max_length=120),
    limit: int = Query(default=20, ge=1, le=60),
    main_only: bool = Query(default=True),
):
    """FTS5 search. main_only floats presenting diagnoses (those with a
    differential table) to the top — those are the useful entry points."""
    c = _conn()
    try:
        match = _fts_query(q)
        if not match:
            return {"query": q, "results": []}
        rank_expr = "(rank - CASE WHEN t.is_main=1 THEN 6 ELSE 0 END)" if main_only else "rank"
        rows = c.execute(
            f"""
            SELECT t.id, t.title, t.is_main, t.differential_count
            FROM ddx_fts f JOIN ddx_topics t ON t.id = f.rowid
            WHERE ddx_fts MATCH ?
            ORDER BY {rank_expr}
            LIMIT ?
            """,
            (match, limit),
        ).fetchall()
        return {
            "query": q,
            "results": [
                {
                    "id": r["id"], "title": r["title"],
                    "is_main": bool(r["is_main"]),
                    "differential_count": r["differential_count"],
                    "href": f"/utdddx?id={r['id']}",
                }
                for r in rows
            ],
        }
    finally:
        c.close()


@router.get("/browse")
def utdddx_browse(limit: int = Query(default=1000, ge=1, le=5000)):
    """All presenting diagnoses (is_main), alphabetical — the reader's index."""
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, title, differential_count FROM ddx_topics "
            "WHERE is_main=1 ORDER BY title LIMIT ?",
            (limit,),
        ).fetchall()
        return {
            "topics": [
                {"id": r["id"], "title": r["title"],
                 "differential_count": r["differential_count"],
                 "href": f"/utdddx?id={r['id']}"}
                for r in rows
            ],
            "total": len(rows),
        }
    finally:
        c.close()


@router.get("/topic/{topic_id}")
def utdddx_topic(topic_id: int):
    """A presenting diagnosis + its full differential table."""
    c = _conn()
    try:
        t = c.execute(
            "SELECT id, title, is_main, differential_count FROM ddx_topics WHERE id=?",
            (topic_id,),
        ).fetchone()
        if not t:
            raise HTTPException(status_code=404, detail="DDx topic not found")
        diffs = c.execute(
            "SELECT dx_title, signs, tests FROM ddx_differentials "
            "WHERE main_id=? ORDER BY ordinal",
            (topic_id,),
        ).fetchall()
        return {
            "id": t["id"], "title": t["title"], "is_main": bool(t["is_main"]),
            "differential_count": t["differential_count"],
            "differentials": [
                {"diagnosis": d["dx_title"], "signs": d["signs"], "tests": d["tests"]}
                for d in diffs
            ],
        }
    finally:
        c.close()


@router.get("/tooltip")
def utdddx_tooltip(
    term: str = Query(..., min_length=2, max_length=120),
    limit: int = Query(default=6, ge=1, le=20),
):
    c = _conn()
    try:
        match = _fts_query(term)
        if not match:
            raise HTTPException(status_code=404, detail="No match")
        rows = c.execute(
            """
            SELECT t.id, t.title, t.is_main, t.differential_count
            FROM ddx_fts f JOIN ddx_topics t ON t.id = f.rowid
            WHERE ddx_fts MATCH ?
            ORDER BY (rank - CASE WHEN t.is_main=1 THEN 6 ELSE 0 END)
            LIMIT ?
            """,
            (match, limit),
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="No match")
        top = rows[0]
        abstract = (
            f"{top['differential_count']} differential diagnoses"
            if top["is_main"] else "UpToDate DDx"
        )
        return {
            "term": term,
            "source": "utdddx",
            "title": top["title"],
            "abstract": abstract,
            "matches": [
                {"id": r["id"], "title": r["title"], "is_main": bool(r["is_main"]),
                 "differential_count": r["differential_count"],
                 "href": f"/utdddx?id={r['id']}", "source": "utdddx"}
                for r in rows
            ],
        }
    finally:
        c.close()


@router.get("/cui")
def utdddx_cui(id: int = Query(...)):
    """Fetch associated UMLS CUIs for a DDx topic."""
    c = _conn()
    try:
        rows = c.execute("SELECT cui FROM ddx_umls WHERE id=?", (id,)).fetchall()
        return {"id": id, "cuis": [r["cui"] for r in rows]}
    except sqlite3.OperationalError:
        return {"id": id, "cuis": []}
    finally:
        c.close()


@router.get("/utd-links")
def utdddx_utd_links(id: int = Query(...)):
    """Fetch associated UpToDate topic IDs for a DDx topic."""
    c = _conn()
    try:
        rows = c.execute("SELECT utd_topic_id FROM ddx_utd_links WHERE id=?", (id,)).fetchall()
        return {"id": id, "utd_topic_ids": [r["utd_topic_id"] for r in rows]}
    except sqlite3.OperationalError:
        return {"id": id, "utd_topic_ids": []}
    finally:
        c.close()


@router.get("/by-utd")
def utdddx_by_utd(utd_id: str = Query(...)):
    """Reverse lookup: find DDx topics linked to a specific UpToDate article."""
    c = _conn()
    try:
        rows = c.execute(
            """
            SELECT t.id, t.title, t.is_main, t.differential_count
            FROM ddx_utd_links l
            JOIN ddx_topics t ON t.id = l.id
            WHERE l.utd_topic_id = ?
            ORDER BY t.title
            """,
            (utd_id,)
        ).fetchall()
        return {
            "utd_id": utd_id,
            "topics": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "is_main": bool(r["is_main"]),
                    "differential_count": r["differential_count"],
                    "href": f"/utdddx?id={r['id']}"
                }
                for r in rows
            ]
        }
    except sqlite3.OperationalError:
        return {"utd_id": utd_id, "topics": []}
    finally:
        c.close()

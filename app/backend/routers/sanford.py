"""
Sanford Guide router — serves the normalized data/sanfordguide/sanford.sqlite
(built by scripts/build_sanford.py from the unencrypted Sanford HTML bundle).

Sanford is the antimicrobial-therapy authority: drug (antimicrobial), organism,
clinical-condition, prophylaxis, vaccine and tool topics. For antibiotic/organism
queries this source should lead — see routers/search.py (_SOURCE_DIVERSITY_ORDER
places 'sanford' near the front) and AmbossHtml.matchPriority.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from config import SANFORD_ASSET_DIR, SANFORD_DB

router = APIRouter(prefix="/sanford", tags=["sanford"])

_ASSET_DIR = Path(SANFORD_ASSET_DIR)


def _conn() -> sqlite3.Connection:
    if not Path(SANFORD_DB).exists():
        raise HTTPException(
            status_code=503,
            detail={"error": "Sanford database not built yet. Run scripts/build_sanford.py"},
        )
    c = sqlite3.connect(f"file:{SANFORD_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=4000")
    return c


def _fts_query(q: str) -> str:
    """Sanitize a user string into a safe FTS5 prefix query."""
    toks = re.findall(r"[\w]+", q.lower())
    if not toks:
        return ""
    return " ".join(f'"{t}"*' for t in toks)


@router.get("/health")
def sanford_health():
    if not Path(SANFORD_DB).exists():
        return {"configured": True, "exists": False, "path": str(SANFORD_DB)}
    try:
        c = _conn()
        n = c.execute("SELECT COUNT(*) FROM sanford_topics").fetchone()[0]
        drugs = c.execute("SELECT COUNT(*) FROM sanford_topics WHERE is_drug=1").fetchone()[0]
        c.close()
        return {"configured": True, "exists": True, "topic_count": n, "drug_count": drugs}
    except Exception as e:  # pragma: no cover
        return {"configured": True, "exists": True, "error": str(e)}


@router.get("/search")
def sanford_search(
    q: str = Query(..., min_length=1, max_length=120),
    limit: int = Query(default=20, ge=1, le=60),
    drugs_first: bool = Query(default=True),
):
    """FTS5 search. drugs_first floats antimicrobial + organism topics up, so an
    antibiotic query leads with the Sanford drug monograph."""
    c = _conn()
    try:
        match = _fts_query(q)
        if not match:
            return {"query": q, "results": []}
        rank_expr = (
            "(rank - CASE WHEN t.kind='drug' THEN 8 WHEN t.kind='organism' THEN 4 ELSE 0 END)"
            if drugs_first else "rank"
        )
        rows = c.execute(
            f"""
            SELECT t.id, t.title, t.slug, t.kind, t.content_label, t.subject,
                   t.trade_name, t.is_drug
            FROM sanford_fts f JOIN sanford_topics t ON t.id = f.rowid
            WHERE sanford_fts MATCH ?
            ORDER BY {rank_expr}
            LIMIT ?
            """,
            (match, limit),
        ).fetchall()
        return {
            "query": q,
            "results": [
                {
                    "id": r["id"],
                    "title": r["title"],
                    "slug": r["slug"],
                    "kind": r["kind"],
                    "label": r["content_label"],
                    "subject": r["subject"],
                    "trade_name": r["trade_name"],
                    "is_drug": bool(r["is_drug"]),
                    "href": f"/sanford?id={r['id']}",
                }
                for r in rows
            ],
        }
    finally:
        c.close()


@router.get("/browse")
def sanford_browse():
    """Category tree for the reader sidebar: content_label → topics."""
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, title, kind, content_label, subject, trade_name "
            "FROM sanford_topics ORDER BY content_label, title"
        ).fetchall()
        groups: dict[str, dict] = {}
        # Stable, clinically-sensible order (drugs/organisms lead).
        order = ["Antimicrobial", "Organism", "Clinical Condition",
                 "Prophylaxis & Prevention", "Hepatitis", "HIV / Specialty",
                 "Vaccines", "Tools & Tables", "Reference"]
        for r in rows:
            g = groups.setdefault(r["content_label"], {"label": r["content_label"], "topics": []})
            g["topics"].append({
                "id": r["id"], "title": r["title"], "kind": r["kind"],
                "subject": r["subject"], "trade_name": r["trade_name"],
                "href": f"/sanford?id={r['id']}",
            })
        ordered = [groups[k] for k in order if k in groups]
        ordered += [v for k, v in sorted(groups.items()) if k not in order]
        return {"groups": ordered, "total": sum(len(g["topics"]) for g in ordered)}
    finally:
        c.close()


@router.get("/topic/{topic_id}")
def sanford_topic(topic_id: int):
    c = _conn()
    try:
        r = c.execute(
            "SELECT id, slug, title, subject, content_label, kind, trade_name, "
            "keywords, is_drug, body_html FROM sanford_topics WHERE id=?",
            (topic_id,),
        ).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Sanford topic not found")
        return {
            "id": r["id"], "slug": r["slug"], "title": r["title"],
            "subject": r["subject"], "label": r["content_label"], "kind": r["kind"],
            "trade_name": r["trade_name"], "keywords": r["keywords"],
            "is_drug": bool(r["is_drug"]), "body_html": r["body_html"],
        }
    finally:
        c.close()


@router.get("/topic-by-slug/{slug}")
def sanford_topic_by_slug(slug: str):
    """Resolve an internal cross-link (data-sanford-slug) to a topic id."""
    c = _conn()
    try:
        r = c.execute("SELECT id FROM sanford_topics WHERE slug=?", (slug,)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="Slug not found")
        return {"id": r["id"], "href": f"/sanford?id={r['id']}"}
    finally:
        c.close()


@router.get("/asset/{name}")
def sanford_asset(name: str):
    """Serve a figure referenced by a Sanford topic body (images live alongside
    the source HTML in SANFORD_ASSET_DIR). Path-traversal guarded."""
    safe = Path(name).name  # strip any directory component
    path = _ASSET_DIR / safe
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(str(path))


@router.get("/tooltip")
def sanford_tooltip(
    term: str = Query(..., min_length=2, max_length=120),
    limit: int = Query(default=6, ge=1, le=20),
):
    """Compact hover payload. Antimicrobial/organism matches lead."""
    c = _conn()
    try:
        match = _fts_query(term)
        if not match:
            raise HTTPException(status_code=404, detail="No match")
        rows = c.execute(
            """
            SELECT t.id, t.title, t.kind, t.content_label, t.trade_name
            FROM sanford_fts f JOIN sanford_topics t ON t.id = f.rowid
            WHERE sanford_fts MATCH ?
            ORDER BY (rank - CASE WHEN t.kind='drug' THEN 8 WHEN t.kind='organism' THEN 4 ELSE 0 END)
            LIMIT ?
            """,
            (match, limit),
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="No match")
        top = rows[0]
        return {
            "term": term,
            "source": "sanford",
            "title": top["title"],
            "abstract": (top["trade_name"] or top["content_label"] or "Sanford Guide"),
            "matches": [
                {
                    "id": r["id"], "title": r["title"], "kind": r["kind"],
                    "label": r["content_label"], "trade_name": r["trade_name"],
                    "href": f"/sanford?id={r['id']}", "source": "sanford",
                }
                for r in rows
            ],
        }
    finally:
        c.close()

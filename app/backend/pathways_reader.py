"""MedOS Pathways — serve the normalized UpToDate-Pathways decision graphs.

Reads the precomputed `data/utdpathways/pathways.sqlite` emitted by
`scripts/build_pathways.py` (never the encrypted source at runtime) and exposes:

    GET /pathways/specialties        — specialty → pathway cards (for the hub)
    GET /pathways/list?q=            — flat, searchable list
    GET /pathways/{id}               — { meta, graph }  (the full decision graph)
    GET /pathways/{id}/case?seed=    — a Case Sim seed: a virtual patient + the
                                       correct root→leaf path + per-node answers
    GET /pathways/health

The graph is small (tens–hundreds of nodes), so the whole thing is handed to the
client, which drives the interactive walk / case simulation locally.
"""
from __future__ import annotations

import json
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

try:
    from config import PATHWAYS_DB
except Exception:  # pragma: no cover
    PATHWAYS_DB = Path(__file__).parent.parent.parent / "data" / "utdpathways" / "pathways.sqlite"

router = APIRouter(prefix="/pathways", tags=["Pathways"])

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _db_path() -> Path:
    p = Path(PATHWAYS_DB)
    if not p.exists():
        raise HTTPException(
            503,
            "pathways.sqlite not found — run `python scripts/build_pathways.py` first.",
        )
    return p


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{_db_path()}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=4000")
    return c


@lru_cache(maxsize=256)
def _graph(pathway_id: int) -> dict:
    with _conn() as c:
        row = c.execute(
            "SELECT graph_json FROM pathway_graph WHERE pathway_id=?", (pathway_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, f"pathway {pathway_id} not found")
    return json.loads(row["graph_json"])


def _plain(html: str, limit: int = 0) -> str:
    t = _WS_RE.sub(" ", _TAG_RE.sub(" ", html or "")).strip()
    return (t[:limit].rstrip() + "…") if limit and len(t) > limit else t


# ── Hub / listing ─────────────────────────────────────────────────────────────
@router.get("/specialties")
def specialties():
    with _conn() as c:
        specs = c.execute("SELECT id, name FROM specialties ORDER BY name").fetchall()
        out = []
        for s in specs:
            paths = c.execute(
                "SELECT id, title, num_steps, num_decisions, num_outcomes, est_minutes "
                "FROM pathways WHERE specialty_id=? ORDER BY title",
                (s["id"],),
            ).fetchall()
            out.append({
                "id": s["id"],
                "name": s["name"],
                "count": len(paths),
                "pathways": [dict(p) for p in paths],
            })
    return {"specialties": out}


@router.get("/list")
def list_pathways(q: str = Query("", max_length=200)):
    sql = ("SELECT p.id, p.title, p.specialty_id, s.name AS specialty, "
           "p.num_steps, p.num_decisions, p.num_outcomes, p.est_minutes "
           "FROM pathways p LEFT JOIN specialties s ON s.id=p.specialty_id")
    args: tuple = ()
    if q.strip():
        sql += " WHERE p.title LIKE ?"
        args = (f"%{q.strip()}%",)
    sql += " ORDER BY p.title"
    with _conn() as c:
        rows = c.execute(sql, args).fetchall()
    return {"pathways": [dict(r) for r in rows]}


@router.get("/health")
def health():
    try:
        with _conn() as c:
            n = c.execute("SELECT COUNT(*) FROM pathways").fetchone()[0]
            s = c.execute("SELECT COUNT(*) FROM specialties").fetchone()[0]
        return {"ok": True, "pathways": n, "specialties": s}
    except HTTPException as e:
        return {"ok": False, "detail": e.detail}


@router.get("/{pathway_id}")
def pathway(pathway_id: int):
    with _conn() as c:
        meta = c.execute(
            "SELECT p.id, p.content_id, p.title, p.specialty_id, s.name AS specialty, "
            "p.root_id, p.scope_html, p.num_steps, p.num_decisions, p.num_outcomes, "
            "p.est_minutes FROM pathways p LEFT JOIN specialties s ON s.id=p.specialty_id "
            "WHERE p.id=?",
            (pathway_id,),
        ).fetchone()
    if not meta:
        raise HTTPException(404, f"pathway {pathway_id} not found")
    return {"meta": dict(meta), "graph": _graph(pathway_id)}


# ── Case Sim seed ─────────────────────────────────────────────────────────────
def _decision_depth_fn(nodes: dict):
    """max # of decision nodes reachable below a node (cycle-safe, memoized)."""
    memo: dict[str, int] = {}

    def dd(nid: str, stack: frozenset = frozenset()) -> int:
        if nid in memo:
            return memo[nid]
        node = nodes.get(nid)
        if not node or not node.get("branches"):
            return 0
        if nid in stack:
            return 0
        stack = stack | {nid}
        best = 0
        for b in node["branches"]:
            child = b["to"]
            add = 1 if nodes.get(child, {}).get("kind") == "decision" else 0
            best = max(best, add + dd(child, stack))
        memo[nid] = best
        return best

    return dd


def _pick_path(graph: dict, seed: int) -> tuple[list[str], dict[str, str]]:
    """Choose one root→leaf path. seed=0 = richest (most decisions); other seeds
    perturb the branch choice at decision nodes for case variety. Returns
    (ordered node ids, {decisionNodeId: chosenChildNodeId})."""
    nodes = graph["nodes"]
    dd = _decision_depth_fn(nodes)
    path: list[str] = []
    correct: dict[str, str] = {}
    visited: set[str] = set()
    cur = graph.get("rootId")
    guard = 0
    while cur and guard < 400:
        guard += 1
        path.append(cur)
        node = nodes.get(cur)
        if not node:
            break
        branches = node.get("branches", [])
        if not branches:
            break  # outcome leaf
        opts = [b for b in branches if b["to"] not in visited] or branches
        visited.add(cur)
        if node.get("kind") == "decision" and len(opts) > 1:
            # rank branches by downstream richness; seed rotates the pick
            ranked = sorted(opts, key=lambda b: dd(b["to"]), reverse=True)
            choice = ranked[seed % len(ranked)]
            seed = seed // max(1, len(ranked)) + 1
            correct[cur] = choice["to"]
        else:
            choice = max(opts, key=lambda b: dd(b["to"]))
        cur = choice["to"]
    return path, correct


_AN = re.compile(r"[^a-z]")


def _vignette(title: str, specialty: str) -> str:
    topic = title.split(":", 1)[0].strip() if ":" in title else title
    focus = title.split(":", 1)[1].strip() if ":" in title else ""
    lead = f"A patient presents in the {specialty} setting" if specialty else "A patient presents"
    if focus:
        return f"{lead}. Your task: {focus[0].lower()}{focus[1:]} for {topic.lower()}. Work the chart one decision at a time."
    return f"{lead} — {topic}. Work the chart one decision at a time."


@router.get("/{pathway_id}/case")
def case(pathway_id: int, seed: int = Query(0, ge=0, le=9999)):
    graph = _graph(pathway_id)
    with _conn() as c:
        meta = c.execute(
            "SELECT p.title, s.name AS specialty, p.scope_html FROM pathways p "
            "LEFT JOIN specialties s ON s.id=p.specialty_id WHERE p.id=?",
            (pathway_id,),
        ).fetchone()
    if not meta:
        raise HTTPException(404, f"pathway {pathway_id} not found")

    path, correct = _pick_path(graph, seed)
    nodes = graph["nodes"]

    # Build the patient chart: one finding per decision on the path. `value` is the
    # label of the correct branch (the finding that sends this patient down it).
    findings = []
    for nid in path:
        node = nodes.get(nid, {})
        if node.get("kind") != "decision" or nid not in correct:
            continue
        child = correct[nid]
        label = next((b["label"] for b in node.get("branches", []) if b["to"] == child), "")
        findings.append({
            "node": nid,
            "step": len(findings) + 1,
            "question": node.get("question") or _plain(node.get("title", "")),
            "value": label,
        })

    leaf_id = path[-1] if path else graph.get("rootId")
    outcome = nodes.get(leaf_id, {})
    return {
        "seed": seed,
        "path": path,
        "targetLeafId": leaf_id,
        "correctBranchByNode": correct,
        "outcome": {"id": leaf_id, "title": outcome.get("title", ""),
                    "teachingHtml": outcome.get("teachingHtml", "")},
        "decisionCount": len(findings),
        "patientCard": {
            "vignette": _vignette(meta["title"], meta["specialty"] or ""),
            "scope": _plain(meta["scope_html"] or "", 320),
            "findings": findings,
        },
    }

"""
/activity — unified user activity, resume pointer, scroll restore, search
history, progression rollup, and version-to-version progression export/import.

Backed by activity_store, which shares the qbank_state.sqlite3 file, so the
export is a single portable "progression tracking file". Every route is scoped
to the caller via require_user (the same user key qbank progress uses, so
export taken on one build imports cleanly into the next).
"""
from __future__ import annotations

import sqlite3
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from auth import require_user
import activity_store as A
from qbank_reader import (
    _bank_registry,
    _bank_count,
    _read_user_state,
    _utc_now,
)
from config import ANKI_PROGRESS_DB

router = APIRouter(prefix="/activity", tags=["Activity"])


# ─── Request models ──────────────────────────────────────────────────────────

class EventBody(BaseModel):
    kind: str
    source: Optional[str] = None
    ref_id: Optional[Any] = None
    title: Optional[str] = None
    href: Optional[str] = None
    detail: Optional[str] = None
    meta: Optional[dict] = None
    scroll_y: Optional[float] = None
    resumable: Optional[bool] = None


class ScrollBody(BaseModel):
    href: str
    scroll_y: float = 0
    anchor: Optional[str] = None


class SearchBody(BaseModel):
    query: str
    scopes: Optional[str] = None
    results_count: Optional[int] = None


class ImportBody(BaseModel):
    mode: str = "merge"          # "merge" (union, default) | "replace"
    payload: dict


# ─── Events + resume ─────────────────────────────────────────────────────────

@router.post("/event")
def post_event(body: EventBody, user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        ts = A.record_event(
            c, user_email,
            kind=body.kind, source=body.source, ref_id=body.ref_id,
            title=body.title, href=body.href, detail=body.detail,
            meta=body.meta, scroll_y=body.scroll_y, resumable=body.resumable,
        )
        c.commit()
        return {"ok": True, "ts": ts}
    finally:
        c.close()


@router.get("/recent")
def get_recent(
    limit: int = Query(default=30, ge=1, le=200),
    user_email: str = Depends(require_user),
):
    c = A.aconn()
    try:
        return {"events": A.recent_events(c, user_email, limit)}
    finally:
        c.close()


@router.get("/resume")
def get_resume(user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        return {"resume": A.get_last_location(c, user_email)}
    finally:
        c.close()


# ─── Scroll positions ────────────────────────────────────────────────────────

@router.post("/scroll")
def post_scroll(body: ScrollBody, user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        A.save_scroll(c, user_email, body.href, body.scroll_y, body.anchor)
        c.commit()
        return {"ok": True}
    finally:
        c.close()


@router.get("/scroll")
def get_scroll(href: str = Query(...), user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        return {"scroll": A.get_scroll(c, user_email, href)}
    finally:
        c.close()


# ─── Search history ──────────────────────────────────────────────────────────

@router.post("/search")
def post_search(body: SearchBody, user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        A.log_search(c, user_email, body.query, body.scopes, body.results_count)
        c.commit()
        return {"ok": True}
    finally:
        c.close()


@router.get("/searches")
def get_searches(
    limit: int = Query(default=20, ge=1, le=100),
    user_email: str = Depends(require_user),
):
    c = A.aconn()
    try:
        return {
            "recent": A.recent_searches(c, user_email, limit),
            "top": A.top_searches(c, user_email, min(limit, 15)),
        }
    finally:
        c.close()


# ─── Progression rollup ──────────────────────────────────────────────────────

def _bank_label(info) -> str:
    if info.category == "uworld":
        return f"UWorld STEP {info.step}"
    if info.category == "nbme":
        return f"NBME Step {info.step} · Form {info.form}"
    if info.category == "cms":
        return f"CMS {info.subject} · Form {info.form}"
    return info.label


def _anki_summary() -> Optional[dict]:
    try:
        conn = sqlite3.connect(str(ANKI_PROGRESS_DB))
        conn.row_factory = sqlite3.Row
        try:
            today = int(time.time() / 86400)
            row = conn.execute(
                "SELECT "
                "COUNT(*) AS seen, "
                "SUM(CASE WHEN ivl >= 21 THEN 1 ELSE 0 END) AS mature, "
                "SUM(CASE WHEN due_day <= ? THEN 1 ELSE 0 END) AS due "
                "FROM card_state WHERE reps > 0",
                (today,),
            ).fetchone()
        finally:
            conn.close()
        if not row or not row["seen"]:
            return None
        return {
            "seen": row["seen"] or 0,
            "mature": row["mature"] or 0,
            "due": row["due"] or 0,
        }
    except Exception:
        return None


@router.get("/progression")
def get_progression(user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        state = _read_user_state(c, user_email)
        used = state.get("usedIdsByDb", {}) or {}
        marked = state.get("markedIdsByDb", {}) or {}

        reg = _bank_registry()
        banks: list[dict] = []
        for key, info in reg.items():
            total = _bank_count(key)
            u = len(used.get(key, []) or [])
            m = len(marked.get(key, []) or [])
            if total == 0 and u == 0 and m == 0:
                continue
            banks.append({
                "key": key,
                "label": _bank_label(info),
                "category": info.category,
                "step": info.step,
                "form": info.form,
                "subject": info.subject,
                "total": total,
                "used": u,
                "marked": m,
            })

        # Order: UWorld → NBME → CMS, then by step/form.
        cat_order = {"uworld": 0, "nbme": 1, "cms": 2}
        banks.sort(key=lambda b: (
            cat_order.get(b["category"], 9),
            b["step"] or 0,
            str(b["form"] or ""),
            b["label"],
        ))

        return {
            "banks": banks,
            "anki": _anki_summary(),
            "searches": A.top_searches(c, user_email, 12),
            "generated_at": _utc_now(),
        }
    finally:
        c.close()


# ─── Version-to-version export / import ──────────────────────────────────────

@router.get("/export")
def export_progression(user_email: str = Depends(require_user)):
    c = A.aconn()
    try:
        state = _read_user_state(c, user_email)
        return {
            "version": 1,
            "app": "medos",
            "kind": "progression",
            "exported_at": _utc_now(),
            "user_email": user_email,
            "qbank": {
                "usedIdsByDb": state.get("usedIdsByDb", {}),
                "markedIdsByDb": state.get("markedIdsByDb", {}),
            },
            "searches": A.recent_searches(c, user_email, 500),
        }
    finally:
        c.close()


@router.post("/import")
def import_progression(body: ImportBody, user_email: str = Depends(require_user)):
    payload = body.payload or {}
    qbank = payload.get("qbank") if isinstance(payload.get("qbank"), dict) else {}
    used = qbank.get("usedIdsByDb") or payload.get("usedIdsByDb")
    marked = qbank.get("markedIdsByDb") or payload.get("markedIdsByDb")

    c = A.aconn()
    try:
        if body.mode == "replace":
            c.execute("DELETE FROM qbank_progress WHERE user_email=?", (user_email,))
        summary = A.merge_progress(c, user_email, used, marked)

        # Optional: fold imported searches in (best-effort, deduped softly).
        searches = payload.get("searches")
        imported_searches = 0
        if isinstance(searches, list):
            for s in searches:
                if isinstance(s, dict) and s.get("query"):
                    A.log_search(
                        c, user_email, str(s["query"]),
                        s.get("scopes"), s.get("results_count"),
                    )
                    imported_searches += 1

        c.commit()
        return {
            "ok": True,
            "mode": body.mode,
            **summary,
            "searchesImported": imported_searches,
        }
    finally:
        c.close()

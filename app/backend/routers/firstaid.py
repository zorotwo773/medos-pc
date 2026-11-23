from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

import firstaid

router = APIRouter(prefix="/firstaid", tags=["First Aid"])


def _image_url(heading_id: int, zoom: int = 2) -> str:
    return f"/firstaid/snippet/image?heading_id={int(heading_id)}&zoom={int(zoom)}"


@router.get("/search")
def search_firstaid(q: str = Query(..., min_length=1, max_length=160), limit: int = Query(8, ge=1, le=40)):
    return {"results": [firstaid_region_payload(item, include_text=False) for item in firstaid.search_regions(q, limit)]}


@router.get("/snippet")
def get_firstaid_snippet(heading_id: int = Query(..., ge=1)):
    region = firstaid.get_region(heading_id)
    if not region:
        raise HTTPException(status_code=404, detail="First Aid heading not found. Run scripts/firstaid/build_firstaid_index.py")
    return firstaid_region_payload(region, include_text=True)


@router.get("/snippet/image")
def get_firstaid_snippet_image(
    request: Request,
    heading_id: int = Query(..., ge=1),
    zoom: int = Query(2, ge=1, le=4),
    mode: str = Query("region"),
    highlight: str = Query("", max_length=200),
):
    if mode not in {"region", "page"}:
        raise HTTPException(status_code=400, detail="mode must be region or page")
    try:
        image_path = (
            firstaid.render_page_image(heading_id, zoom=zoom, highlight=highlight)
            if mode == "page"
            else firstaid.render_snippet_image(heading_id, zoom=zoom, highlight=highlight)
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not render First Aid snippet: {exc}") from exc

    etag = firstaid.etag_for(Path(image_path))
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    return Response(
        content=Path(image_path).read_bytes(),
        media_type="image/webp",
        headers={
            "ETag": etag,
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.get("/status")
def firstaid_status():
    exists = firstaid.index_exists()
    count = 0
    meta: dict[str, str] = {}
    if exists:
        import sqlite3
        from config import FIRSTAID_INDEX_DB

        c = sqlite3.connect(f"file:{FIRSTAID_INDEX_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            count = int(c.execute("SELECT count(*) FROM firstaid_regions").fetchone()[0] or 0)
            try:
                meta = {row["key"]: row["value"] for row in c.execute("SELECT key, value FROM meta").fetchall()}
            except sqlite3.Error:
                meta = {}
        finally:
            c.close()
    return {
        "built": exists and count > 0,
        "rows": count,
        "meta": meta,
        "pdf": str(firstaid.resolve_pdf_path()),
        "index": str(__import__("config").FIRSTAID_INDEX_DB),
    }


def firstaid_region_payload(region: dict, include_text: bool) -> dict:
    heading_id = int(region["heading_id"])
    body_text = region.get("body_text") or ""
    figure_refs = region.get("figure_refs") or []
    if isinstance(figure_refs, str):
        try:
            figure_refs = json.loads(figure_refs or "[]")
        except Exception:
            figure_refs = []
    payload = {
        "heading_id": heading_id,
        "title": region.get("title") or "",
        "hierarchy": region.get("hierarchy") or "",
        "page": int(region.get("page") or 1),
        "page_end": int(region.get("page_end") or region.get("page") or 1),
        "edition": region.get("edition") or "2026",
        "image_url": _image_url(heading_id, 2),
        "href": region.get("href") or "",
        "figure_refs": figure_refs,
    }
    if include_text:
        payload["body_text"] = body_text
    else:
        payload["body_text"] = body_text[:420]
    return payload

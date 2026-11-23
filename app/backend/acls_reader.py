"""
ACLS algorithm poster images.

Serves the real AHA/AAP reference chart images that back each walkable
algorithm's "Poster" view (the actual printed chart, alongside the
interactive Walk/Map screens). One image per algorithm id, looked up
directly by filename — no DB, no fuzzy matching (unlike cliniccons, ACLS
only ever has a handful of these).
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse

BASE = Path(__file__).parent
ROOT = BASE.parent.parent
IMG_DIR = ROOT / "data" / "acls" / "img"

router = APIRouter(prefix="/acls", tags=["ACLS"])

_ID_RE = re.compile(r"^[a-z0-9-]+$")


def _find(algo_id: str) -> Path:
    if not _ID_RE.match(algo_id):
        raise HTTPException(422, "invalid algorithm id")
    for ext in (".jpg", ".jpeg", ".png"):
        path = IMG_DIR / f"{algo_id}{ext}"
        if path.is_file():
            return path
    raise HTTPException(404, "no poster image for this algorithm")


@router.get("/image/{algo_id}")
def image(algo_id: str):
    return FileResponse(_find(algo_id), headers={"Cache-Control": "private, max-age=86400"})


@router.head("/image/{algo_id}")
def image_head(algo_id: str):
    # Existence probe for the frontend's "does this algorithm have a poster?"
    # check — HEAD isn't auto-derived from the GET route, so it's explicit.
    _find(algo_id)
    return Response(status_code=200)

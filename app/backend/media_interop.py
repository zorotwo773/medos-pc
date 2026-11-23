from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse

PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"
router = APIRouter(tags=["media interop"])


def _script_json(value: object) -> str:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


def media_interop_head(
    source: str, title: str, source_url: str, print_url: str = ""
) -> str:
    payload = _script_json(
        {
            "source": source,
            "title": title,
            "sourceUrl": source_url,
            "printUrl": print_url,
        }
    )
    return (
        f"<script>window.__MEDOS_MEDIA_CONTEXT__={payload};</script>"
        '<script type="module" src="/medos-media-interop.mjs"></script>'
    )


@router.get("/media-interop-core.mjs", include_in_schema=False)
def core_module() -> FileResponse:
    return FileResponse(
        PUBLIC_DIR / "media-interop-core.mjs",
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/medos-media-interop.mjs", include_in_schema=False)
def runtime_module() -> FileResponse:
    return FileResponse(
        PUBLIC_DIR / "medos-media-interop.mjs",
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache"},
    )

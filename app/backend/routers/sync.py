"""
/sync — LAN auto-sync HTTP surface.

Two audiences share this router:

* **Peer backends** call /sync/manifest and /sync/export directly over the LAN
  (no browser cookie). These are guarded by an optional shared token
  (MEDOS_SYNC_TOKEN); with no token set they trust-on-LAN. They only ever read
  or UNION-merge progression, so a peer can never delete your data.
* **The browser UI** calls /sync/status, /sync/now, /sync/toggle and
  /sync/rename through the /api proxy, which carries the session cookie, so
  those are gated by require_user.

See lan_sync.py for the discovery + merge engine.
"""
from __future__ import annotations

from typing import Optional
import sqlite3

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

import lan_sync
from auth import require_user

router = APIRouter(prefix="/sync", tags=["Sync"])


def _require_token(x_medos_sync_token: Optional[str] = Header(default=None)) -> None:
    if not lan_sync.token_ok(x_medos_sync_token):
        raise HTTPException(status_code=403, detail="sync token required")


# ─── Peer-facing (token-or-open) ─────────────────────────────────────────────
@router.get("/manifest")
def get_manifest(_: None = Depends(_require_token)):
    try:
        return lan_sync.local_manifest()
    except (sqlite3.Error, OSError) as error:
        raise HTTPException(status_code=503, detail="sync history unavailable") from error


@router.get("/export")
def get_export(_: None = Depends(_require_token)):
    try:
        return lan_sync.local_export()
    except (sqlite3.Error, OSError) as error:
        raise HTTPException(status_code=503, detail="sync history unavailable") from error


class PushBody(BaseModel):
    expected_node_id: Optional[str] = None
    expected_user: Optional[str] = None
    qbank: Optional[dict] = None
    usedIdsByDb: Optional[dict] = None
    markedIdsByDb: Optional[dict] = None


@router.post("/push")
def post_push(body: PushBody, _: None = Depends(_require_token)):
    """Accept a pushed progression payload (used by clients that can't be
    pulled, e.g. the phone app behind NAT). UNION-merge only."""
    try:
        summary = lan_sync.apply_payload(body.model_dump())
    except lan_sync.SyncIdentityChanged as error:
        raise HTTPException(status_code=409, detail="sync desktop/account changed") from error
    except (sqlite3.Error, OSError) as error:
        raise HTTPException(status_code=503, detail="sync history unavailable") from error
    return {"ok": True, **summary}


# ─── Browser-facing (cookie auth) ────────────────────────────────────────────
@router.get("/status")
def get_status(_user: str = Depends(require_user)):
    return lan_sync.service_status()


@router.post("/now")
def post_sync_now(_user: str = Depends(require_user)):
    return lan_sync.sync_now()


class ToggleBody(BaseModel):
    enabled: bool


@router.post("/toggle")
def post_toggle(body: ToggleBody, _user: str = Depends(require_user)):
    return {"enabled": lan_sync.set_enabled(body.enabled)}


class RenameBody(BaseModel):
    name: str


@router.post("/rename")
def post_rename(body: RenameBody, _user: str = Depends(require_user)):
    return {"device_name": lan_sync.set_device_name(body.name)}

"""Host-only network access control endpoints."""
from __future__ import annotations

import atexit
import asyncio
import concurrent.futures
import ipaddress
import itertools
import json
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response

from network_access import (
    ApplicationNetworkPolicyApplier,
    EffectiveNetworkPolicy,
    NetworkPolicyCancelled,
    NetworkPolicyTimeout,
    WindowsNetworkPolicyApplier,
    _has_duplicate_keys,
    atomic_write_network_settings,
    load_network_settings,
    network_settings_path,
)


_MAX_CHANGE_BODY = 4096
_FRONTEND_PORT = 3000
_GET_COALESCE_SECONDS = 0.25


class _PolicyWorker:
    """One bounded process-global worker for blocking policy operations."""

    def __init__(self) -> None:
        self._sequence = itertools.count()
        self._queue: queue.PriorityQueue = queue.PriorityQueue(maxsize=32)
        self._state_lock = threading.Lock()
        self._closed = False
        self._thread = threading.Thread(
            target=self._run, name="medos-network-policy", daemon=True
        )
        self._thread.start()

    def submit(self, callback: Callable[[], object], *, priority: int):
        future: concurrent.futures.Future = concurrent.futures.Future()
        with self._state_lock:
            if self._closed:
                raise HTTPException(status_code=503, detail="network policy service is stopped")
            try:
                self._queue.put_nowait((priority, next(self._sequence), callback, future))
            except queue.Full as error:
                raise HTTPException(status_code=503, detail="network policy service is busy") from error
        return future

    @property
    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def close(self, *, wait: bool = True, cancel_pending: bool = True) -> None:
        with self._state_lock:
            if not self._closed:
                self._closed = True
                if cancel_pending:
                    while True:
                        try:
                            _priority, _sequence, _callback, future = self._queue.get_nowait()
                        except queue.Empty:
                            break
                        future.cancel()
                        self._queue.task_done()
                sentinel_priority = -1 if cancel_pending else sys.maxsize
                self._queue.put(
                    (sentinel_priority, next(self._sequence), None, None)
                )
        if wait:
            self._thread.join()

    def _run(self) -> None:
        while True:
            _priority, _sequence, callback, future = self._queue.get()
            try:
                if callback is None:
                    return
                if future.set_running_or_notify_cancel():
                    try:
                        future.set_result(callback())
                    except BaseException as error:
                        future.set_exception(error)
            finally:
                self._queue.task_done()


_POLICY_WORKER = _PolicyWorker()


def shutdown_network_policy_worker() -> None:
    _POLICY_WORKER.close(wait=True, cancel_pending=True)


atexit.register(shutdown_network_policy_worker)


def _response(
    *,
    can_change: bool,
    requested: bool,
    effective: bool,
    needs_attention: bool,
    platform_name: str,
) -> dict:
    return {
        "requested": {"allow_public": requested},
        "effective": {"allow_public": effective},
        "can_change": can_change,
        "platform": platform_name,
        "needs_attention": bool(needs_attention or requested != effective),
    }


def _effective_state(value) -> EffectiveNetworkPolicy:
    if type(value) is bool:
        return EffectiveNetworkPolicy("public" if value else "private", value, True)
    if isinstance(value, EffectiveNetworkPolicy):
        return value
    allow_public = getattr(value, "allow_public", None)
    valid = getattr(value, "valid", None)
    status = getattr(value, "status", "invalid")
    if type(allow_public) is bool and type(valid) is bool:
        return EffectiveNetworkPolicy(str(status), allow_public, valid)
    return EffectiveNetworkPolicy("invalid", False, False)


def _best_effort_rollback(platform_applier, allow_public: bool) -> bool:
    try:
        platform_applier.rollback(allow_public)
        return True
    except Exception:
        return False


def _safe_error(message: str, *, outcome: str | None = None) -> dict[str, object]:
    result: dict[str, object] = {"message": message, "needs_attention": True}
    if outcome is not None:
        result["outcome"] = outcome
    return result


def _single_header(request: Request, name: bytes) -> bytes | None:
    values = [value for key, value in request.scope.get("headers", ()) if key.lower() == name]
    if len(values) > 1:
        raise HTTPException(status_code=400, detail="duplicate request header")
    return values[0] if values else None


def _trusted_browser_origin(raw_origin: bytes) -> bool:
    try:
        origin = raw_origin.decode("ascii")
        if any(character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F for character in origin):
            return False
        if "?" in origin or "#" in origin:
            return False
        parsed = urlsplit(origin)
        port = parsed.port
    except (UnicodeError, ValueError):
        return False
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or port != _FRONTEND_PORT
    ):
        return False
    host = parsed.hostname.lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _validate_change_admission(request: Request) -> None:
    raw_origin = _single_header(request, b"origin")
    if raw_origin is not None and not _trusted_browser_origin(raw_origin):
        raise HTTPException(status_code=403, detail="untrusted network access origin")
    raw_content_type = _single_header(request, b"content-type")
    if raw_content_type is None:
        raise HTTPException(status_code=415, detail="application/json required")
    try:
        content_type = raw_content_type.decode("ascii")
    except UnicodeError as error:
        raise HTTPException(status_code=415, detail="application/json required") from error
    parts = [part.strip() for part in content_type.split(";")]
    if not parts or parts[0].lower() != "application/json":
        raise HTTPException(status_code=415, detail="application/json required")
    if len(parts) > 2 or (len(parts) == 2 and parts[1].lower() != "charset=utf-8"):
        raise HTTPException(status_code=415, detail="application/json required")


async def _parse_change_request(request: Request) -> bool:
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_CHANGE_BODY:
            raise HTTPException(status_code=413, detail="network access request is too large")
        chunks.append(chunk)
    raw = b"".join(chunks)
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_has_duplicate_keys)
    except (UnicodeError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="invalid network access request") from error
    if not isinstance(payload, dict) or set(payload) != {"allow_public"}:
        raise HTTPException(status_code=422, detail="invalid network access request")
    allow_public = payload["allow_public"]
    if type(allow_public) is not bool:
        raise HTTPException(status_code=422, detail="invalid network access request")
    return allow_public


async def _await_policy(future: concurrent.futures.Future):
    return await asyncio.shield(asyncio.wrap_future(future))


def create_network_access_router(
    *,
    settings_path: str | Path | None = None,
    platform_applier=None,
    persist_settings: Callable[[str | Path, bool], None] = atomic_write_network_settings,
    platform_name: str | None = None,
) -> APIRouter:
    router = APIRouter()
    resolved_path = network_settings_path() if settings_path is None else Path(settings_path)
    resolved_platform = sys.platform if platform_name is None else platform_name
    applier = platform_applier or (
        WindowsNetworkPolicyApplier(platform_name=resolved_platform)
        if resolved_platform == "win32"
        else ApplicationNetworkPolicyApplier(resolved_path)
    )
    pending_get: concurrent.futures.Future | None = None
    pending_get_completed_at: float | None = None

    def snapshot() -> tuple[bool, bool, bool]:
        settings = load_network_settings(resolved_path)
        try:
            effective = _effective_state(applier.read_effective())
        except Exception:
            effective = EffectiveNetworkPolicy("invalid", False, False)
        return (
            settings.allow_public,
            effective.allow_public,
            settings.needs_attention or not effective.valid,
        )

    @router.get("/network/access/internal-admit", status_code=204)
    async def internal_admit(request: Request) -> Response:
        # The outer network middleware has already authenticated the fixed token,
        # required an actual loopback delegator, loaded the settings through the
        # hardened file boundary, and admitted the forwarded effective peer.
        if not getattr(request.state, "network_forward_trusted", False):
            raise HTTPException(status_code=403, detail="internal admission only")
        return Response(status_code=204)

    @router.get("/network/access")
    async def get_network_access(request: Request) -> dict:
        nonlocal pending_get, pending_get_completed_at
        can_change = bool(getattr(request.state, "network_can_change", False))
        now = time.monotonic()
        if pending_get is None or (
            pending_get.done()
            and (
                pending_get_completed_at is None
                or now - pending_get_completed_at > _GET_COALESCE_SECONDS
            )
        ):
            pending_get = _POLICY_WORKER.submit(snapshot, priority=10)
            pending_get_completed_at = None

            def record_completion(_future) -> None:
                nonlocal pending_get_completed_at
                pending_get_completed_at = time.monotonic()

            pending_get.add_done_callback(record_completion)
        future = pending_get
        requested, effective, needs_attention = await _await_policy(future)
        return _response(
            can_change=can_change,
            requested=requested,
            effective=effective,
            needs_attention=needs_attention,
            platform_name=resolved_platform,
        )

    def change_policy(requested: bool, can_change: bool) -> dict:
        settings = load_network_settings(resolved_path)
        uses_persisted_application_policy = bool(
            getattr(applier, "uses_persisted_application_policy", False)
        )
        try:
            prior_live = _effective_state(applier.read_effective())
        except Exception as error:
            raise HTTPException(
                status_code=502, detail=_safe_error("network access state could not be read")
            ) from error
        if not prior_live.valid:
            raise HTTPException(
                status_code=409, detail=_safe_error("network access state is inconsistent")
            )

        policy_changed = prior_live.allow_public != requested
        if policy_changed:
            try:
                applier.apply(requested)
            except NetworkPolicyCancelled as error:
                raise HTTPException(
                    status_code=409, detail=_safe_error("network access change cancelled")
                ) from error
            except NetworkPolicyTimeout as error:
                raise HTTPException(
                    status_code=504,
                    detail=_safe_error(
                        "network access change timed out",
                        outcome="unknown" if error.outcome_unknown else None,
                    ),
                ) from error
            except Exception as error:
                if not getattr(error, "restoration_owned", False):
                    _best_effort_rollback(applier, prior_live.allow_public)
                raise HTTPException(
                    status_code=502, detail=_safe_error("network access change failed")
                ) from error

            if not uses_persisted_application_policy:
                try:
                    effective = _effective_state(applier.read_effective())
                except Exception as error:
                    raise HTTPException(
                        status_code=502, detail=_safe_error("network access verification failed")
                    ) from error
                if not effective.valid or effective.allow_public != requested:
                    raise HTTPException(
                        status_code=409, detail=_safe_error("network access verification mismatch")
                    )

        try:
            persist_settings(resolved_path, requested)
        except Exception as error:
            _best_effort_rollback(applier, prior_live.allow_public)
            raise HTTPException(
                status_code=500,
                detail=_safe_error("network access settings were not saved"),
            ) from error

        try:
            final_live = _effective_state(applier.read_effective())
        except Exception:
            final_live = EffectiveNetworkPolicy("invalid", False, False)
        if not final_live.valid or final_live.allow_public != requested:
            try:
                persist_settings(resolved_path, settings.allow_public)
            except Exception:
                pass
            raise HTTPException(
                status_code=409,
                detail=_safe_error("network access state changed concurrently"),
            )

        return _response(
            can_change=can_change,
            requested=requested,
            effective=final_live.allow_public,
            needs_attention=not final_live.valid,
            platform_name=resolved_platform,
        )

    @router.post("/network/access")
    async def set_network_access(request: Request) -> dict:
        nonlocal pending_get, pending_get_completed_at
        if not getattr(request.state, "network_can_change", False):
            raise HTTPException(status_code=403, detail="host-only network setting")
        _validate_change_admission(request)
        requested = await _parse_change_request(request)
        can_change = bool(getattr(request.state, "network_can_change", False))
        future = _POLICY_WORKER.submit(
            lambda: change_policy(requested, can_change), priority=0
        )
        result = await _await_policy(future)
        pending_get = None
        pending_get_completed_at = None
        return result

    return router


router = create_network_access_router()

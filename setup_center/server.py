"""Authenticated loopback HTTP service for the MedOS setup wizard."""

from __future__ import annotations

import dataclasses
import json
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import MappingProxyType
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from .copy_engine import CopyCancelled, CopyControl


_MAX_REQUEST_BYTES = 1024 * 1024
_SENSITIVE_ERROR_RE = re.compile(
    r"(?i)(?:secret|token|password|api[_-]?key|authorization|cookie)\s*[=:]\s*[^\s,;]+"
)


class OperationError(RuntimeError):
    """Raised when an operation cannot be started or controlled."""


@dataclass(frozen=True, slots=True)
class OperationHandle:
    operation_id: str


@dataclass(frozen=True, slots=True)
class ServerAddress:
    host: str
    port: int
    session_url: str


@dataclass(frozen=True, slots=True)
class ServiceRegistry:
    """Application services exposed to the browser wizard."""

    preflight: Callable[[dict[str, Any]], Any]
    install: Callable[[dict[str, Any], Callable[[Any], None], CopyControl], Any]
    repair: Callable[[dict[str, Any], Callable[[Any], None], CopyControl], Any]
    diagnostics: Callable[[dict[str, Any], Callable[[Any], None], CopyControl], Any]
    start_medos: Callable[[dict[str, Any], Callable[[Any], None], CopyControl], Any] | None = None
    resume: Callable[[dict[str, Any], Callable[[Any], None], CopyControl], Any] | None = None
    verify: Callable[[dict[str, Any], Callable[[Any], None], CopyControl], Any] | None = None
    recommended_target: Callable[[], Any] | None = None
    destinations: Callable[[], Any] | None = None


# Payload keys the browser is not allowed to set, because they would let the
# page choose a filesystem location directly instead of picking one of the
# destinations the server enumerated. "target" would place a 48 GiB copy and
# "output" would place a diagnostics archive.
_BROWSER_FORBIDDEN_KEYS = frozenset({"target", "output"})


def _json_value(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return {field.name: _json_value(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, Enum):
        return _json_value(value.value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset, deque)):
        return [_json_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _safe_error(error: BaseException) -> str:
    first_line = str(error).replace("\r", "\n").split("\n", 1)[0].strip()
    redacted = _SENSITIVE_ERROR_RE.sub("[REDACTED]", first_line)
    return (redacted or error.__class__.__name__)[:300]


def _public_failure(error: BaseException) -> dict[str, Any]:
    summary = _safe_error(error)
    lowered = summary.casefold()
    if isinstance(error, PermissionError) or "permission denied" in lowered:
        code = "permission-denied"
    elif "runtime" in lowered and any(word in lowered for word in ("missing", "unavailable", "not found")):
        code = "runtime-missing"
    elif "port" in lowered and any(word in lowered for word in ("used", "conflict", "listen", "bind")):
        code = "port-conflict"
    elif "health" in lowered or "timed out" in lowered or "timeout" in lowered:
        code = "launch-health-failed"
    else:
        code = "operation-failed"
    return {
        "code": code,
        "summary": summary,
        "actions": (
            "Correct the reported issue, then choose Resume setup",
            "Save diagnostics",
        ),
        "diagnostics_available": True,
    }


class OperationRegistry:
    """Own one background mutation and its bounded reconnectable event history."""

    def __init__(
        self,
        *,
        max_events: int = 2000,
        control_timeout_seconds: float = 2.0,
    ) -> None:
        if isinstance(max_events, bool) or not isinstance(max_events, int) or max_events <= 0:
            raise ValueError("max_events must be a positive integer")
        if control_timeout_seconds <= 0:
            raise ValueError("control_timeout_seconds must be positive")
        self._lock = threading.RLock()
        self._changed = threading.Condition(self._lock)
        self._events: deque[dict[str, Any]] = deque(maxlen=max_events)
        self._operation: dict[str, Any] | None = None
        self._control: CopyControl | None = None
        self._thread: threading.Thread | None = None
        self._sequence = 0
        self._control_timeout_seconds = float(control_timeout_seconds)

    def start(
        self,
        kind: str,
        operation: Callable[[Callable[[Any], None], CopyControl], Any],
    ) -> OperationHandle:
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("operation kind is required")
        with self._changed:
            if self._operation is not None and self._operation["status"] == "running":
                raise OperationError("another operation is already active")
            operation_id = secrets.token_urlsafe(18)
            control = CopyControl()
            self._control = control
            self._events.clear()
            self._sequence = 0
            self._operation = {
                "id": operation_id,
                "kind": kind.strip(),
                "status": "running",
                "control": "running",
                "started_at": time.time(),
                "finished_at": None,
                "result": None,
                "error": None,
                "failure": None,
            }
            thread = threading.Thread(
                target=self._run,
                args=(operation_id, operation, control),
                name=f"medos-{kind.strip()}-{operation_id[:8]}",
                daemon=True,
            )
            self._thread = thread
            thread.start()
            return OperationHandle(operation_id=operation_id)

    def _run(
        self,
        operation_id: str,
        operation: Callable[[Callable[[Any], None], CopyControl], Any],
        control: CopyControl,
    ) -> None:
        def emit(value: Any) -> None:
            with self._changed:
                if self._operation is None or self._operation["id"] != operation_id:
                    return
                self._sequence += 1
                event_value = _json_value(value)
                if isinstance(event_value, dict):
                    event = dict(event_value)
                else:
                    event = {"value": event_value}
                event["sequence"] = self._sequence
                self._events.append(event)
                self._changed.notify_all()

        try:
            result = operation(emit, control)
        except CopyCancelled:
            self._finish(operation_id, status="cancelled")
        except BaseException as error:  # The worker boundary must always become reconnectable state.
            self._finish(
                operation_id,
                status="failed",
                error=_safe_error(error),
                failure=_public_failure(error),
            )
        else:
            self._finish(operation_id, status="succeeded", result=_json_value(result))

    def _finish(
        self,
        operation_id: str,
        *,
        status: str,
        result: Any = None,
        error: str | None = None,
        failure: dict[str, Any] | None = None,
    ) -> None:
        with self._changed:
            if self._operation is None or self._operation["id"] != operation_id:
                return
            self._operation["status"] = status
            self._operation["control"] = "cancelled" if status == "cancelled" else "complete"
            self._operation["finished_at"] = time.time()
            self._operation["result"] = result
            self._operation["error"] = error
            self._operation["failure"] = failure
            self._changed.notify_all()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._sync_control_locked()
            operation = dict(self._operation) if self._operation is not None else None
            events = [dict(event) for event in self._events]
            return {"operation": operation, "events": events}

    def wait(self, operation_id: str, *, timeout_seconds: float) -> dict[str, Any]:
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        with self._changed:
            while True:
                if self._operation is None or self._operation["id"] != operation_id:
                    raise OperationError("operation is not available")
                if self._operation["status"] != "running":
                    return self.snapshot()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self.snapshot()
                self._changed.wait(remaining)

    def control(self, action: str) -> dict[str, Any]:
        with self._changed:
            if self._operation is None or self._operation["status"] != "running" or self._control is None:
                raise OperationError("no active operation")
            if action == "pause":
                self._control.pause()
                expected = "paused"
            elif action == "resume":
                self._control.resume()
                expected = "running"
            elif action == "cancel":
                self._control.cancel()
                expected = "cancelled"
            else:
                raise OperationError("unknown control action")
            self._sync_control_locked()
            self._changed.notify_all()
            if not self._control.wait_for_state(
                expected,
                timeout_seconds=self._control_timeout_seconds,
            ):
                self._sync_control_locked()
                raise OperationError(f"{action} was not acknowledged at a safe checkpoint")
            self._sync_control_locked()
            return self.snapshot()

    def _sync_control_locked(self) -> None:
        if (
            self._operation is not None
            and self._operation["status"] == "running"
            and self._control is not None
        ):
            self._operation["control"] = self._control.state


_BUILTIN_ASSETS = MappingProxyType(
    {
        "": (
            "text/html; charset=utf-8",
            b"<!doctype html><html><head><meta charset='utf-8'><title>MedOS Setup</title>"
            b"</head><body><main><h1>MedOS Setup</h1></main></body></html>",
        ),
    }
)


class _LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class SetupServer:
    """Serve one unguessable wizard session on an IPv4 loopback socket."""

    def __init__(
        self,
        services: ServiceRegistry,
        *,
        static_root: Path | None = None,
        operations: OperationRegistry | None = None,
    ) -> None:
        self.services = services
        self.operations = operations or OperationRegistry()
        self.token = secrets.token_urlsafe(32)
        self._session_prefix = f"/session/{self.token}/"
        self._static_root = Path(static_root).resolve(strict=False) if static_root is not None else None
        self._thread: threading.Thread | None = None
        handler = self._handler_type()
        self._httpd = _LoopbackServer(("127.0.0.1", 0), handler)
        host, port = self._httpd.server_address[:2]
        self.address = ServerAddress(
            host=str(host),
            port=int(port),
            session_url=f"http://{host}:{port}{self._session_prefix}",
        )

    def start(self) -> ServerAddress:
        if self._thread is not None:
            return self.address
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name="medos-setup-server",
            daemon=True,
        )
        self._thread.start()
        return self.address

    def close(self) -> None:
        if self._thread is not None:
            self._httpd.shutdown()
            self._thread.join(timeout=5)
            self._thread = None
        self._httpd.server_close()

    def session_path(self, relative: str) -> str:
        return self._session_prefix + relative

    def api_path(self, name: str) -> str:
        return self._session_prefix + "api/" + name

    def _asset(self, name: str) -> tuple[str, bytes] | None:
        if name not in {"", "index.html", "styles.css", "app.js"}:
            return None
        if self._static_root is not None:
            filename = "index.html" if name == "" else name
            candidate = self._static_root / filename
            try:
                if candidate.is_file() and candidate.resolve(strict=True).parent == self._static_root:
                    content_type = {
                        "index.html": "text/html; charset=utf-8",
                        "styles.css": "text/css; charset=utf-8",
                        "app.js": "text/javascript; charset=utf-8",
                    }[filename]
                    return content_type, candidate.read_bytes()
            except OSError:
                return None
        return _BUILTIN_ASSETS.get(name)

    def _handler_type(self) -> type[BaseHTTPRequestHandler]:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MedOSSetup"
            sys_version = ""

            def log_message(self, format: str, *args: object) -> None:
                # Access logs would contain the bearer-like path token.
                return

            def do_GET(self) -> None:
                path = urlsplit(self.path).path
                if not path.startswith(owner._session_prefix):
                    self._error(HTTPStatus.NOT_FOUND, "not found")
                    return
                relative = path[len(owner._session_prefix) :]
                if relative == "api/status":
                    self._json(HTTPStatus.OK, owner.operations.snapshot())
                    return
                if relative == "api/recommended-target":
                    if owner.services.recommended_target is None:
                        self._error(HTTPStatus.NOT_FOUND, "not found")
                    else:
                        self._json(HTTPStatus.OK, owner.services.recommended_target())
                    return
                if relative == "api/destinations":
                    if owner.services.destinations is None:
                        self._error(HTTPStatus.NOT_FOUND, "not found")
                    else:
                        self._json(HTTPStatus.OK, owner.services.destinations())
                    return
                if relative.startswith("api/"):
                    self._error(HTTPStatus.NOT_FOUND, "not found")
                    return
                asset = owner._asset(relative)
                if asset is None:
                    self._error(HTTPStatus.NOT_FOUND, "not found")
                    return
                content_type, content = asset
                self._send(HTTPStatus.OK, content_type, content)

            def do_POST(self) -> None:
                path = urlsplit(self.path).path
                if not path.startswith(owner._session_prefix):
                    self._error(HTTPStatus.NOT_FOUND, "not found")
                    return
                relative = path[len(owner._session_prefix) :]
                if relative not in {
                    "api/preflight",
                    "api/verify",
                    "api/install",
                    "api/start-medos",
                    "api/resume",
                    "api/repair",
                    "api/diagnostics",
                    "api/control",
                }:
                    self._error(HTTPStatus.NOT_FOUND, "not found")
                    return
                origin = self.headers.get("Origin")
                allowed = {
                    f"http://127.0.0.1:{owner.address.port}",
                    f"http://localhost:{owner.address.port}",
                }
                if origin is not None and origin not in allowed:
                    self._discard_declared_body()
                    self._error(HTTPStatus.FORBIDDEN, "origin rejected")
                    return
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    self._discard_declared_body()
                    self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "application/json required")
                    return
                length_text = self.headers.get("Content-Length")
                try:
                    length = int(length_text) if length_text is not None else -1
                except ValueError:
                    length = -1
                if length < 0:
                    self._error(HTTPStatus.LENGTH_REQUIRED, "valid content length required")
                    return
                if length > _MAX_REQUEST_BYTES:
                    self._discard_declared_body()
                    self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request too large")
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._error(HTTPStatus.BAD_REQUEST, "invalid JSON")
                    return
                if not isinstance(payload, dict):
                    self._error(HTTPStatus.BAD_REQUEST, "JSON object required")
                    return
                rejected = sorted(_BROWSER_FORBIDDEN_KEYS.intersection(payload))
                if rejected:
                    # Anything that reaches this loopback port could otherwise
                    # nominate an arbitrary filesystem path. The wizard chooses
                    # one by the id that GET api/destinations issued. Fail
                    # loudly rather than silently writing somewhere the caller
                    # did not ask for. The named keys come from the frozen set
                    # above, never from the request.
                    self._error(
                        HTTPStatus.BAD_REQUEST,
                        f"{' and '.join(rejected)} cannot be chosen by the page; "
                        "use destination_id",
                    )
                    return
                try:
                    if relative == "api/preflight":
                        self._json(HTTPStatus.OK, owner.services.preflight(payload))
                        return
                    if relative == "api/control":
                        action = payload.get("action")
                        if not isinstance(action, str):
                            raise OperationError("control action is required")
                        self._json(HTTPStatus.OK, owner.operations.control(action))
                        return
                    kind = relative.removeprefix("api/")
                    service = {
                        "verify": owner.services.verify,
                        "install": owner.services.install,
                        "start-medos": owner.services.start_medos,
                        "resume": owner.services.resume,
                        "repair": owner.services.repair,
                        "diagnostics": owner.services.diagnostics,
                    }[kind]
                    if service is None:
                        raise OperationError(f"{kind} service is unavailable")
                    service_payload = {} if kind == "start-medos" else payload
                    handle = owner.operations.start(
                        kind,
                        lambda emit, control: service(service_payload, emit, control),
                    )
                    self._json(HTTPStatus.ACCEPTED, {"operation_id": handle.operation_id})
                except OperationError as error:
                    self._error(HTTPStatus.CONFLICT, _safe_error(error))
                except Exception as error:
                    self._error(HTTPStatus.INTERNAL_SERVER_ERROR, _safe_error(error))

            def _security_headers(self) -> None:
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header(
                    "Content-Security-Policy",
                    "default-src 'self'; script-src 'self'; style-src 'self'; "
                    "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
                )

            def _discard_declared_body(self) -> None:
                """Discard only a small declared body so Windows can deliver the response."""

                try:
                    length = int(self.headers.get("Content-Length", "-1"))
                except ValueError:
                    return
                if length < 0 or length > _MAX_REQUEST_BYTES + 1:
                    return
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        return
                    remaining -= len(chunk)

            def _send(self, status: HTTPStatus, content_type: str, content: bytes) -> None:
                self.send_response(status)
                self._security_headers()
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def _json(self, status: HTTPStatus, value: Any) -> None:
                content = json.dumps(
                    _json_value(value),
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                self._send(status, "application/json; charset=utf-8", content)

            def _error(self, status: HTTPStatus, message: str) -> None:
                self._json(status, {"error": message})

        return Handler


def start_server(services: ServiceRegistry, *, browser: bool = True) -> SetupServer:
    """Start a setup session and optionally open its authenticated landing page."""

    static_root = Path(__file__).with_name("static")
    server = SetupServer(
        services,
        static_root=static_root if static_root.is_dir() else None,
    )
    try:
        server.start()
        if browser:
            import webbrowser

            webbrowser.open(server.address.session_url, new=1)
    except BaseException:
        server.close()
        raise
    return server


__all__ = [
    "OperationError",
    "OperationHandle",
    "OperationRegistry",
    "ServerAddress",
    "ServiceRegistry",
    "SetupServer",
    "start_server",
]

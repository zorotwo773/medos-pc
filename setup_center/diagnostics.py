"""Privacy-filtered, deterministic MedOS diagnostic bundles."""

from __future__ import annotations

import os
import platform
import re
import stat
import uuid
import zipfile
from pathlib import Path

from .health import HealthReport
from .journal import Journal, JournalError
from .manifest import canonical_json_bytes


_SENSITIVE_ASSIGNMENT_RE = re.compile(
    r"(?im)^(\s*(?:[A-Za-z0-9_]*(?:secret|token|password|api[_-]?key|cookie)[A-Za-z0-9_]*|authorization)\s*[=:])[^\r\n]*"
)
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+")
_WINDOWS_HOME_RE = re.compile(r"(?i)\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+")
_MAC_HOME_RE = re.compile(r"/Users/[^/\s]+")
_LINUX_HOME_RE = re.compile(r"/home/[^/\s]+")


def _redact(text: str) -> str:
    text = _SENSITIVE_ASSIGNMENT_RE.sub(r"\1[REDACTED]", text)
    text = _BEARER_RE.sub("Bearer [REDACTED]", text)
    text = _WINDOWS_HOME_RE.sub("%USERPROFILE%", text)
    text = _MAC_HOME_RE.sub("~", text)
    text = _LINUX_HOME_RE.sub("~", text)
    return text


def _health_value(report: HealthReport) -> dict[str, object]:
    return {
        "status": report.status.value,
        "healthy": report.healthy,
        "summary": report.summary,
        "issues": [
            {
                "code": issue.code,
                "message": issue.message,
                "relative_path": issue.relative_path,
            }
            for issue in report.issues
        ],
        "endpoints": [
            {
                "name": endpoint.name,
                "url": endpoint.url,
                "ok": endpoint.ok,
                "status_code": endpoint.status_code,
                "error": endpoint.error,
            }
            for endpoint in report.endpoints
        ],
    }


def _install_value(target: Path) -> dict[str, object]:
    try:
        state = Journal.load(target).state
    except JournalError:
        return {"state": "unavailable"}
    return {
        "schema_version": state.schema_version,
        "release_id": state.release_id,
        "manifest_sha256": state.manifest_sha256,
        "mode": state.mode.value,
        "phase": state.phase,
        "verified_bytes": state.verified_bytes,
        "completed_file_count": len(state.completed_paths),
    }


def _read_tail(path: Path, limit: int) -> str | None:
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            content = handle.read(limit)
    except OSError:
        return None
    return _redact(content.decode("utf-8", errors="replace"))


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def create_diagnostic_bundle(
    target_root: Path,
    report: HealthReport,
    output: Path,
    *,
    max_log_bytes: int = 256 * 1024,
) -> Path:
    """Write a deterministic bundle containing no environment/database contents."""

    if isinstance(max_log_bytes, bool) or not isinstance(max_log_bytes, int) or max_log_bytes <= 0:
        raise ValueError("max_log_bytes must be a positive integer")
    target = Path(target_root).expanduser().resolve(strict=False)
    files: dict[str, bytes] = {}
    summary = {
        "schema_version": 1,
        "health": _health_value(report),
        "install": _install_value(target),
        "host": {
            "system": platform.system(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
            "python_implementation": platform.python_implementation(),
        },
    }
    files["summary.json"] = canonical_json_bytes(summary)
    for name in ("backend.err", "backend.log", "frontend.err", "frontend.log"):
        content = _read_tail(target / "app" / name, max_log_bytes)
        if content is not None:
            files[f"logs/{name}.txt"] = content.encode("utf-8")
    # Redact every serialized surface again so issue messages cannot smuggle secrets.
    files = {
        name: _redact(content.decode("utf-8", errors="replace")).encode("utf-8")
        for name, content in files.items()
    }

    destination = Path(output).expanduser().resolve(strict=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.tmp-{uuid.uuid4().hex}")
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            allowZip64=True,
        ) as archive:
            for name in sorted(files):
                archive.writestr(_zip_info(name), files[name])
        os.replace(temporary, destination)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return destination


__all__ = ["create_diagnostic_bundle"]

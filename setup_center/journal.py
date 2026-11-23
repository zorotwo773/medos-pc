"""Atomic, versioned installation state for resumable MedOS operations."""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from .manifest import canonical_json_bytes
from .planner import InstallMode


_SCHEMA_VERSION = 1
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PHASES = frozenset(
    {
        "preflight",
        "copying",
        "paused",
        "waiting-for-drive",
        "copied",
        "verifying",
        "configuring",
        "launching",
        "launch-failed",
        "repairing",
        "complete",
        "failed",
        "rolled-back",
    }
)
_STATE_KEYS = frozenset(
    {
        "schema_version",
        "install_id",
        "release_id",
        "manifest_sha256",
        "mode",
        "target_root",
        "phase",
        "verified_bytes",
        "completed_paths",
        "created_at",
        "updated_at",
    }
)


class JournalError(RuntimeError):
    """Raised when installation state is incompatible, malformed, or unwritable."""


@dataclass(frozen=True, slots=True)
class InstallState:
    schema_version: int
    install_id: str
    release_id: str
    manifest_sha256: str
    mode: InstallMode
    target_root: str
    phase: str
    verified_bytes: int
    completed_paths: tuple[str, ...]
    created_at: str
    updated_at: str

    def to_json(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "install_id": self.install_id,
            "release_id": self.release_id,
            "manifest_sha256": self.manifest_sha256,
            "mode": self.mode.value,
            "target_root": self.target_root,
            "phase": self.phase,
            "verified_bytes": self.verified_bytes,
            "completed_paths": list(self.completed_paths),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _safe_completed_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise JournalError("completed path must be a safe POSIX relative path")
    parts = value.split("/")
    if any(part in ("", ".", "..") or ":" in part for part in parts):
        raise JournalError("completed path must be a safe POSIX relative path")
    path = PurePosixPath(*parts)
    if path.is_absolute():
        raise JournalError("completed path must be relative")
    return path.as_posix()


def _require_timestamp(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise JournalError(f"{field} must be an RFC3339 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise JournalError(f"{field} must be an RFC3339 UTC timestamp") from error
    if parsed.tzinfo != timezone.utc:
        raise JournalError(f"{field} must be an RFC3339 UTC timestamp")
    return value


def _state_from_json(value: object) -> InstallState:
    if not isinstance(value, dict):
        raise JournalError("install state must be a JSON object")
    keys = frozenset(value)
    missing = _STATE_KEYS - keys
    unknown = keys - _STATE_KEYS
    if missing:
        raise JournalError(f"install state is missing field(s): {', '.join(sorted(missing))}")
    if unknown:
        raise JournalError(f"install state has unknown field(s): {', '.join(sorted(unknown))}")
    schema = value["schema_version"]
    if isinstance(schema, bool) or schema != _SCHEMA_VERSION:
        raise JournalError(f"unsupported install-state schema_version: {schema}")
    install_id = value["install_id"]
    if not isinstance(install_id, str):
        raise JournalError("install_id must be a canonical UUID")
    try:
        if str(uuid.UUID(install_id)) != install_id:
            raise ValueError
    except ValueError as error:
        raise JournalError("install_id must be a canonical UUID") from error
    release_id = value["release_id"]
    if not isinstance(release_id, str) or not release_id or len(release_id) > 128:
        raise JournalError("release_id is invalid")
    manifest_sha256 = value["manifest_sha256"]
    if not isinstance(manifest_sha256, str) or _SHA256_RE.fullmatch(manifest_sha256) is None:
        raise JournalError("manifest_sha256 must be 64 lowercase hexadecimal characters")
    try:
        mode = InstallMode(value["mode"])
    except (TypeError, ValueError) as error:
        raise JournalError("install mode is invalid") from error
    target_root = value["target_root"]
    if not isinstance(target_root, str) or not Path(target_root).is_absolute():
        raise JournalError("target_root must be an absolute path")
    phase = value["phase"]
    if not isinstance(phase, str) or phase not in _PHASES:
        raise JournalError("install phase is invalid")
    verified_bytes = value["verified_bytes"]
    if isinstance(verified_bytes, bool) or not isinstance(verified_bytes, int) or verified_bytes < 0:
        raise JournalError("verified_bytes must be a non-negative integer")
    completed_value = value["completed_paths"]
    if not isinstance(completed_value, list):
        raise JournalError("completed_paths must be a JSON array")
    completed = tuple(_safe_completed_path(item) for item in completed_value)
    if len({item.casefold() for item in completed}) != len(completed):
        raise JournalError("completed_paths contains a collision")
    created_at = _require_timestamp(value["created_at"], "created_at")
    updated_at = _require_timestamp(value["updated_at"], "updated_at")
    if updated_at < created_at:
        raise JournalError("updated_at cannot precede created_at")
    return InstallState(
        schema_version=schema,
        install_id=install_id,
        release_id=release_id,
        manifest_sha256=manifest_sha256,
        mode=mode,
        target_root=str(Path(target_root).resolve(strict=False)),
        phase=phase,
        verified_bytes=verified_bytes,
        completed_paths=completed,
        created_at=created_at,
        updated_at=updated_at,
    )


def _load_state(path: Path) -> InstallState:
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise JournalError(f"cannot read install state: {path}") from error
    return _state_from_json(value)


class Journal:
    """Own and atomically persist one target's installation state."""

    def __init__(self, path: Path, state: InstallState) -> None:
        self.path = Path(path)
        self.state = state

    @classmethod
    def create(
        cls,
        target_root: Path,
        *,
        release_id: str,
        manifest_sha256: str,
        mode: InstallMode,
    ) -> "Journal":
        target = Path(target_root).expanduser().resolve(strict=False)
        if not release_id or len(release_id) > 128:
            raise JournalError("release_id is invalid")
        if _SHA256_RE.fullmatch(manifest_sha256) is None:
            raise JournalError("manifest_sha256 must be 64 lowercase hexadecimal characters")
        try:
            install_mode = mode if isinstance(mode, InstallMode) else InstallMode(mode)
        except ValueError as error:
            raise JournalError("install mode is invalid") from error
        state_dir = target / ".medos-install"
        try:
            state_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise JournalError(f"cannot create install state directory: {state_dir}") from error
        timestamp = _utc_now()
        state = InstallState(
            schema_version=_SCHEMA_VERSION,
            install_id=str(uuid.uuid4()),
            release_id=release_id,
            manifest_sha256=manifest_sha256,
            mode=install_mode,
            target_root=str(target),
            phase="preflight",
            verified_bytes=0,
            completed_paths=(),
            created_at=timestamp,
            updated_at=timestamp,
        )
        journal = cls(state_dir / "install-state.json", state)
        journal._persist(state)
        return journal

    @classmethod
    def load(cls, target_root: Path) -> "Journal":
        target = Path(target_root).expanduser().resolve(strict=False)
        path = target / ".medos-install" / "install-state.json"
        state = _load_state(path)
        if Path(state.target_root) != target:
            raise JournalError("install state target_root does not match its directory")
        return cls(path, state)

    def _persist(self, state: InstallState) -> None:
        temporary = self.path.with_name(f"{self.path.name}.tmp-{uuid.uuid4().hex}")
        try:
            with temporary.open("xb") as handle:
                handle.write(canonical_json_bytes(state.to_json()))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except BaseException as error:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            if isinstance(error, OSError):
                raise JournalError(f"cannot persist install state: {self.path}") from error
            raise

    def _update(self, *, persist: bool = True, **changes: Any) -> None:
        candidate = replace(self.state, updated_at=_utc_now(), **changes)
        if persist:
            self._persist(candidate)
        self.state = candidate

    def flush(self) -> None:
        candidate = replace(self.state, updated_at=_utc_now())
        self._persist(candidate)
        self.state = candidate

    def set_phase(self, phase: str) -> None:
        if phase not in _PHASES:
            raise JournalError(f"invalid install phase: {phase}")
        self._update(phase=phase)

    def mark_completed(
        self,
        relative_path: str,
        *,
        size: int,
        persist: bool = True,
    ) -> None:
        path = _safe_completed_path(relative_path)
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise JournalError("completed size must be a non-negative integer")
        if path in self.state.completed_paths:
            return
        self._update(
            persist=persist,
            completed_paths=self.state.completed_paths + (path,),
            verified_bytes=self.state.verified_bytes + size,
        )

    def unmark_completed(self, relative_path: str, *, size: int) -> None:
        path = _safe_completed_path(relative_path)
        if path not in self.state.completed_paths:
            return
        self._update(
            completed_paths=tuple(item for item in self.state.completed_paths if item != path),
            verified_bytes=max(0, self.state.verified_bytes - size),
        )

    def assert_compatible(
        self,
        *,
        release_id: str,
        manifest_sha256: str,
        mode: InstallMode,
        target_root: Path,
    ) -> None:
        try:
            install_mode = mode if isinstance(mode, InstallMode) else InstallMode(mode)
        except ValueError as error:
            raise JournalError("install mode is invalid") from error
        mismatches: list[str] = []
        if self.state.release_id != release_id:
            mismatches.append("release_id")
        if self.state.manifest_sha256 != manifest_sha256:
            mismatches.append("manifest_sha256")
        if self.state.mode is not install_mode:
            mismatches.append("mode")
        if Path(self.state.target_root) != Path(target_root).expanduser().resolve(strict=False):
            mismatches.append("target_root")
        if mismatches:
            raise JournalError(f"install state is incompatible: {', '.join(mismatches)}")


__all__ = ["InstallState", "Journal", "JournalError"]

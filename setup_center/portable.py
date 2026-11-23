"""Manifest-bound in-place activation for prepared SSDs and extracted releases."""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Callable, Mapping, Protocol, Sequence

from .copy_engine import CopyControl
from .mac_runtime import MacRuntimeError, select_mac_runtime
from .manifest import (
    ComponentManifest,
    FileRecord,
    ManifestError,
    canonical_json_bytes,
    load_drive_manifest,
    sha256_file,
)
from .platforms import PlatformInfo, detect_platform
from .portable_paths import PortablePathError, portable_relative_path
from .progress import ProgressEvent


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_USER_ENV_KEYS = frozenset(
    {
        "UTD_PASSWORD",
        "MEDOS_SESSION_SECRET",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "NVIDIA_API_KEY",
    }
)


class PortableError(RuntimeError):
    """Raised when a portable release cannot be activated safely."""


def _launch_file_error(reason: str, target: str) -> PortableError:
    return PortableError(
        f"{reason}: {target}. Restore the matching application files from the "
        "original release or a verified update. Keep your medical data and progress."
    )


@dataclass(frozen=True, slots=True)
class PortableLayout:
    release_root: Path
    drive_id: str
    release_id: str
    component_id: str
    manifest_sha256: str
    component: ComponentManifest
    mappings: Mapping[PurePosixPath, PurePosixPath]

    def source_for_target(self, target: str | PurePosixPath) -> Path:
        try:
            relative = portable_relative_path(target, "target")
            source = self.mappings[relative]
        except (KeyError, PortablePathError) as error:
            text = target.as_posix() if isinstance(target, PurePosixPath) else str(target)
            raise PortableError(f"release component is missing: {text}") from error
        return self._contained_existing(source, "portable source")

    def source_root_for_target_prefix(self, prefix: str | PurePosixPath) -> Path:
        try:
            target_prefix = portable_relative_path(prefix, "target prefix")
        except PortablePathError as error:
            raise PortableError(str(error)) from error
        roots: set[PurePosixPath] = set()
        prefix_parts = target_prefix.parts
        for target, source in self.mappings.items():
            if target.parts[: len(prefix_parts)] != prefix_parts:
                continue
            suffix = target.parts[len(prefix_parts) :]
            if suffix and source.parts[-len(suffix) :] != suffix:
                raise PortableError(
                    f"portable source mapping is inconsistent below {target_prefix.as_posix()}"
                )
            root_parts = source.parts[: len(source.parts) - len(suffix)] if suffix else source.parts
            roots.add(PurePosixPath(*root_parts))
        if len(roots) != 1:
            raise PortableError(
                f"release component has no single source root for {target_prefix.as_posix()}"
            )
        root = self._contained_existing(next(iter(roots)), "portable source root")
        if not root.is_dir():
            raise PortableError(
                f"portable source root is not a directory: {target_prefix.as_posix()}"
            )
        return root

    def _contained_existing(self, relative: PurePosixPath, label: str) -> Path:
        candidate = self.release_root / Path(*relative.parts)
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(self.release_root)
            info = candidate.lstat()
        except (OSError, ValueError) as error:
            raise PortableError(f"{label} is unavailable or escapes the release") from error
        if candidate.is_symlink() or stat.S_ISLNK(info.st_mode):
            raise PortableError(f"{label} must not be a link")
        return resolved


@dataclass(frozen=True, slots=True)
class PortableStatePaths:
    root: Path
    cache: Path
    logs: Path
    pids: Path
    config: Path
    locator: Path


@dataclass(frozen=True, slots=True)
class PortableActivationRequest:
    release_root: Path
    component_id: str = "desktop-core"
    open_after: bool = True


@dataclass(frozen=True, slots=True)
class PortableActivationResult:
    phase: str
    release_root: Path
    state_root: Path
    release_id: str
    shortcut: Path
    health_summary: str | None


class _Launcher(Protocol):
    def start(self, target_root: Path) -> object: ...
    def stop(self, target_root: Path) -> object: ...


class _HealthChecker(Protocol):
    def check(self, target_root: Path, *, timeout_seconds: float) -> object: ...


class _ShortcutManager(Protocol):
    def create(self, target_root: Path) -> Sequence[Path]: ...


def _normal_regular_file(path: Path, label: str, *, max_bytes: int | None = None) -> bytes:
    candidate = Path(path)
    try:
        info = candidate.lstat()
    except OSError as error:
        raise PortableError(f"{label} is missing") from error
    if candidate.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise PortableError(f"{label} is not a normal file")
    if max_bytes is not None and info.st_size > max_bytes:
        raise PortableError(f"{label} is too large")
    try:
        return candidate.read_bytes()
    except OSError as error:
        raise PortableError(f"{label} cannot be read") from error


def load_portable_layout(release_root: Path, component_id: str) -> PortableLayout:
    """Load signed release metadata without walking or hashing large payload roles."""

    lexical = Path(release_root).expanduser()
    if lexical.is_symlink():
        raise PortableError("portable release root must not be a link")
    try:
        root = lexical.resolve(strict=True)
    except OSError as error:
        raise PortableError("portable release root is unavailable") from error
    if not root.is_dir():
        raise PortableError("portable release root is not a directory")
    marker = root / "setup-drive.json"
    marker_bytes = _normal_regular_file(marker, "setup-drive.json", max_bytes=1024 * 1024)
    sidecar_bytes = _normal_regular_file(
        root / "setup-drive.json.sha256", "setup-drive.json sidecar", max_bytes=256
    )
    marker_digest = hashlib.sha256(marker_bytes).hexdigest()
    expected_sidecar = f"{marker_digest}  setup-drive.json\n".encode("ascii")
    if sidecar_bytes != expected_sidecar:
        raise PortableError("setup-drive.json sidecar digest does not match")
    component_cache: dict[Path, ComponentManifest] = {}
    try:
        drive = load_drive_manifest(root, component_cache=component_cache)
    except ManifestError as error:
        raise PortableError(str(error)) from error
    reference = next(
        (item for item in drive.components if item.component_id == component_id), None
    )
    if reference is None:
        raise PortableError(f"release component is unavailable: {component_id}")
    component_path = (root / Path(*reference.manifest.parts)).resolve(strict=True)
    component = component_cache.get(component_path)
    if component is None:
        raise PortableError("release component was not retained during validation")
    mappings = {record.target: record.source for record in component.files}
    return PortableLayout(
        release_root=root,
        drive_id=drive.drive_id,
        release_id=drive.release_id,
        component_id=component.component_id,
        manifest_sha256=reference.sha256,
        component=component,
        mappings=MappingProxyType(mappings),
    )


def _safe_id(value: str, field: str) -> str:
    if not isinstance(value, str) or _ID_RE.fullmatch(value) is None:
        raise PortableError(f"{field} is not a safe release identifier")
    return value


def portable_state_paths(
    host: PlatformInfo, drive_id: str, release_id: str
) -> PortableStatePaths:
    """Return the small per-user writable state location for an in-place release."""

    safe_drive = _safe_id(drive_id, "drive_id")
    _safe_id(release_id, "release_id")
    if host.system == "windows":
        if host.local_app_data is None:
            raise PortableError("LOCALAPPDATA is unavailable for portable state")
        root = host.local_app_data / "MedOS" / "portable" / safe_drive
    elif host.system == "macos":
        root = host.home / "Library" / "Application Support" / "MedOS" / "portable" / safe_drive
    else:
        raise PortableError(f"unsupported portable platform: {host.system}")
    return PortableStatePaths(
        root=root,
        cache=root / "cache",
        logs=root / "logs",
        pids=root / "pids",
        config=root / "config",
        locator=root / "locator.json",
    )


def _record_applies(record: FileRecord, host: PlatformInfo) -> bool:
    if record.platform == "all":
        return True
    if record.platform in {"windows", "macos"}:
        return record.platform == host.system
    return record.platform == f"macos-{host.architecture}"


def _critical_targets(host: PlatformInfo) -> tuple[str, ...]:
    shared = (
        "app/medos_server.mjs",
        "app/.next/BUILD_ID",
        "app/.next/.medos-shipped",
    )
    if host.system == "windows":
        return shared + (
            "START.ps1",
            "medos.ico",
            "tools/python/python.exe",
            "tools/node/node.exe",
        )
    return shared + ("mac/start.sh", "mac/runtime-select.sh")


def _read_env(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError) as error:
        raise PortableError("existing MedOS environment cannot be read") from error
    values: dict[str, str] = {}
    for line in lines:
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key in _USER_ENV_KEYS and "\n" not in value and "\r" not in value:
            values[key] = value
    return values


def _atomic_write(path: Path, payload: bytes) -> None:
    temporary = path.with_name(f".{path.name}-{uuid.uuid4().hex}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("xb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    except OSError as error:
        raise PortableError(f"cannot write portable state: {path.name}") from error
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


class PortableActivator:
    """Activate a prepared release in place without copying its payload."""

    def __init__(
        self,
        *,
        platform_info: PlatformInfo | None = None,
        launcher: _Launcher,
        health_checker: _HealthChecker,
        shortcut_manager: _ShortcutManager,
        health_timeout_seconds: float = 120.0,
    ) -> None:
        self.platform_info = platform_info or detect_platform()
        self.launcher = launcher
        self.health_checker = health_checker
        self.shortcut_manager = shortcut_manager
        self.health_timeout_seconds = health_timeout_seconds

    @staticmethod
    def _event(phase: str, message: str) -> ProgressEvent:
        return ProgressEvent(
            phase=phase,
            message=message,
            relative_path="",
            completed_bytes=0,
            total_bytes=0,
            current_bytes=0,
            current_total=0,
            completed_items=0,
            total_items=0,
            bytes_per_second=0.0,
            eta_seconds=None,
        )

    def _validate_launch_files(self, layout: PortableLayout, control: CopyControl) -> None:
        records = {
            record.target.as_posix(): record
            for record in layout.component.files
            if record.required and _record_applies(record, self.platform_info)
        }
        for target in _critical_targets(self.platform_info):
            control.checkpoint()
            record = records.get(target)
            if record is None:
                raise _launch_file_error("portable release is missing launch file", target)
            source = layout.source_for_target(record.target)
            try:
                info = source.stat()
            except OSError as error:
                raise _launch_file_error("portable launch file is unavailable", target) from error
            if not source.is_file() or info.st_size != record.size:
                raise _launch_file_error("portable launch file is invalid", target)
            if sha256_file(source) != record.sha256:
                raise _launch_file_error("portable launch file hash mismatch", target)
        if self.platform_info.system == "macos":
            try:
                candidate = select_mac_runtime(layout.release_root, self.platform_info)
            except MacRuntimeError as error:
                raise PortableError(str(error)) from error
            prefixes = (
                f"mac-tools/{candidate.architecture}/python/bin/python3",
                f"mac-tools/{candidate.architecture}/node/bin/node",
            )
            swc = [
                target
                for target in records
                if target.startswith(f"mac-tools/{candidate.architecture}/swc/")
                and target.endswith(".node")
            ]
            for target in prefixes + tuple(swc[:1]):
                record = records.get(target)
                if record is None:
                    raise _launch_file_error("portable release is missing launch file", target)
                source = layout.source_for_target(record.target)
                if source.stat().st_size != record.size or sha256_file(source) != record.sha256:
                    raise _launch_file_error("portable launch file hash mismatch", target)

    @staticmethod
    def _prepare_state(layout: PortableLayout, host: PlatformInfo) -> PortableStatePaths:
        state = portable_state_paths(host, layout.drive_id, layout.release_id)
        for folder in (state.root, state.cache, state.logs, state.pids, state.config):
            try:
                folder.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                raise PortableError("portable user state cannot be created") from error
        locator = {
            "schema_version": 1,
            "drive_id": layout.drive_id,
            "release_id": layout.release_id,
            "component_id": layout.component_id,
            "manifest_sha256": layout.manifest_sha256,
            "release_root": str(layout.release_root),
        }
        _atomic_write(state.locator, canonical_json_bytes(locator))
        return state

    @staticmethod
    def _write_environment(layout: PortableLayout, state: PortableStatePaths) -> None:
        environment_path = layout.release_root / "app" / "backend" / ".env"
        values = _read_env(environment_path)
        values.setdefault("UTD_PASSWORD", "")
        values.setdefault("MEDOS_SESSION_SECRET", secrets.token_urlsafe(36))
        values["MEDOS_ROOT"] = layout.release_root.as_posix()
        values["MEDOS_PORTABLE_STATE_ROOT"] = state.root.as_posix()
        values["QBANK_STATE_DB"] = (state.config / "qbank_state.sqlite3").as_posix()
        values["LIBRARY_PATH"] = layout.source_root_for_target_prefix("data/books").as_posix()
        values["BOOK_CHAPTER_INDEX_DB"] = layout.source_for_target(
            "data/book_chapter_index.sqlite"
        ).as_posix()
        values["GLOBAL_SEARCH_DB"] = layout.source_for_target(
            "data/global_search.sqlite"
        ).as_posix()
        order = (
            "UTD_PASSWORD",
            "MEDOS_SESSION_SECRET",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "NVIDIA_API_KEY",
            "MEDOS_ROOT",
            "MEDOS_PORTABLE_STATE_ROOT",
            "QBANK_STATE_DB",
            "LIBRARY_PATH",
            "BOOK_CHAPTER_INDEX_DB",
            "GLOBAL_SEARCH_DB",
        )
        payload = "".join(f"{key}={values[key]}\n" for key in order if key in values).encode(
            "utf-8"
        )
        _atomic_write(environment_path, payload)

    def activate(
        self,
        request: PortableActivationRequest,
        on_progress: Callable[[ProgressEvent], None],
        control: CopyControl,
    ) -> PortableActivationResult:
        on_progress(self._event("detecting-platform", "Detecting this computer"))
        control.checkpoint()
        on_progress(self._event("validating-release", "Validating the portable MedOS release"))
        layout = load_portable_layout(request.release_root, request.component_id)
        self._validate_launch_files(layout, control)
        control.checkpoint()
        on_progress(self._event("preparing-runtime", "Preparing small per-user MedOS state"))
        state = self._prepare_state(layout, self.platform_info)
        self._write_environment(layout, state)
        control.checkpoint()
        on_progress(self._event("creating-shortcut", "Creating the MedOS shortcut"))
        try:
            shortcuts = tuple(Path(path) for path in self.shortcut_manager.create(layout.release_root))
        except (OSError, RuntimeError) as error:
            raise PortableError(str(error) or "could not create the MedOS shortcut") from error
        if len(shortcuts) != 1:
            raise PortableError("portable activation must create exactly one MedOS shortcut")
        health_summary: str | None = None
        if request.open_after:
            on_progress(self._event("starting-medos", "Starting MedOS from this folder"))
            launch_result = self.launcher.start(layout.release_root)
            returncode = getattr(launch_result, "returncode", 0)
            if returncode != 0:
                detail = str(
                    getattr(launch_result, "stderr", "")
                    or getattr(launch_result, "stdout", "")
                    or "MedOS launcher failed"
                ).strip()
                raise PortableError(detail[-1000:])
            control.checkpoint()
            on_progress(self._event("checking-health", "Checking that MedOS is ready"))
            health = self.health_checker.check(
                layout.release_root, timeout_seconds=self.health_timeout_seconds
            )
            health_summary = str(getattr(health, "summary", ""))
            if not bool(getattr(health, "healthy", False)):
                self.launcher.stop(layout.release_root)
                raise PortableError("portable MedOS failed its launch health check")
        else:
            on_progress(self._event("starting-medos", "MedOS launch was not requested"))
            on_progress(self._event("checking-health", "MedOS launch check was skipped"))
        on_progress(self._event("complete", "MedOS is ready"))
        return PortableActivationResult(
            phase="complete",
            release_root=layout.release_root,
            state_root=state.root,
            release_id=layout.release_id,
            shortcut=shortcuts[0],
            health_summary=health_summary,
        )


__all__ = [
    "PortableActivationRequest",
    "PortableActivationResult",
    "PortableActivator",
    "PortableError",
    "PortableLayout",
    "PortableStatePaths",
    "load_portable_layout",
    "portable_state_paths",
]

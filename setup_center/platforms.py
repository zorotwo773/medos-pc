"""Platform and filesystem probes used before MedOS installation."""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping


class PlatformError(RuntimeError):
    """Raised when the host cannot satisfy a Setup Center platform contract."""


@dataclass(frozen=True, slots=True)
class PlatformInfo:
    system: str
    architecture: str
    home: Path
    local_app_data: Path | None
    process_architecture: str | None = None
    translated: bool = False

    def __post_init__(self) -> None:
        if self.process_architecture is None:
            object.__setattr__(self, "process_architecture", self.architecture)


def normalize_architecture(machine: str) -> str:
    """Normalize common Windows/macOS machine strings to release names."""

    normalized = machine.strip().lower()
    if normalized in {"amd64", "x86_64"}:
        return "x64"
    if normalized in {"arm64", "aarch64"}:
        return "arm64"
    raise PlatformError(f"unsupported architecture: {machine or '<empty>'}")


def detect_platform(
    *,
    system_name: str | None = None,
    machine: str | None = None,
    environ: Mapping[str, str] | None = None,
    home: Path | None = None,
    sysctl_reader: Callable[[str], str] | None = None,
) -> PlatformInfo:
    """Detect the supported host without mutating environment or dependencies."""

    raw_system = (system_name or platform.system()).strip().lower()
    if raw_system == "windows":
        system = "windows"
    elif raw_system == "darwin":
        system = "macos"
    else:
        raise PlatformError(f"unsupported operating system: {system_name or platform.system()}")
    environment = os.environ if environ is None else environ
    resolved_home = (Path.home() if home is None else Path(home)).expanduser()
    local_value = environment.get("LOCALAPPDATA") if system == "windows" else None
    local_app_data = Path(local_value).expanduser() if local_value else None
    process_architecture = normalize_architecture(machine or platform.machine())
    architecture = process_architecture
    translated = False
    if system == "macos" and process_architecture == "x64":
        reader = _read_macos_sysctl if sysctl_reader is None else sysctl_reader
        try:
            translated = reader("sysctl.proc_translated").strip() == "1"
        except (OSError, subprocess.SubprocessError):
            translated = False
        if translated:
            architecture = "arm64"
    return PlatformInfo(
        system=system,
        architecture=architecture,
        home=resolved_home,
        local_app_data=local_app_data,
        process_architecture=process_architecture,
        translated=translated,
    )


def _read_macos_sysctl(key: str) -> str:
    try:
        result = subprocess.run(
            ["/usr/sbin/sysctl", "-in", key],
            check=False,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout if result.returncode == 0 else ""


def default_install_root(info: PlatformInfo) -> Path:
    """Return the non-administrator default install path for a supported host."""

    if info.system == "windows":
        if info.local_app_data is None:
            raise PlatformError("LOCALAPPDATA is unavailable; choose an install folder")
        return info.local_app_data / "MedOS"
    if info.system == "macos":
        return info.home / "Applications" / "MedOS"
    raise PlatformError(f"unsupported operating system: {info.system}")


@dataclass(frozen=True, slots=True)
class DestinationCandidate:
    """One install destination the setup server is willing to offer."""

    id: str
    label: str
    path: Path
    free_bytes: int
    total_bytes: int
    filesystem: str | None
    recommended: bool


def _destination_id(path: Path) -> str:
    """Derive a stable opaque id for a destination.

    The browser chooses a destination by id and never by path, so a page (or
    anything that reaches the loopback port) cannot nominate an arbitrary
    filesystem location. Ids are stable across requests so a choice made on one
    request still resolves on the next, and the server re-enumerates before
    installing, so a stale or invented id simply fails to resolve.
    """

    digest = hashlib.sha256(os.path.normcase(str(path)).encode("utf-8", "surrogatepass"))
    return digest.hexdigest()[:16]


def _volume_information(root: str) -> tuple[str | None, str | None]:
    """Return (volume label, filesystem name) for a Windows root, if available."""

    if os.name != "nt":
        return None, None
    try:
        import ctypes
    except ImportError:  # pragma: no cover - ctypes ships with CPython
        return None, None
    label = ctypes.create_unicode_buffer(261)
    filesystem = ctypes.create_unicode_buffer(64)
    try:
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(root),
            label,
            len(label),
            None,
            None,
            None,
            filesystem,
            len(filesystem),
        )
    except (AttributeError, OSError, ValueError):
        return None, None
    if not ok:
        return None, None
    return (label.value or None), (filesystem.value or None)


def _candidate_roots(info: PlatformInfo) -> list[tuple[Path, str]]:
    """Return (install path, human label) pairs worth offering on this host."""

    roots: list[tuple[Path, str]] = []
    if info.system == "windows":
        try:
            drives = list(os.listdrives())
        except (OSError, AttributeError):
            drives = []
        for drive in drives:
            label, _ = _volume_information(drive)
            letter = drive.rstrip("\\/")
            roots.append((Path(drive) / "MedOS", f"{letter} {label}" if label else letter))
    elif info.system == "macos":
        volumes = Path("/Volumes")
        try:
            entries = sorted(volumes.iterdir())
        except OSError:
            entries = []
        for entry in entries:
            if entry.is_dir() and not entry.is_symlink():
                roots.append((entry / "MedOS", entry.name))
    return roots


def enumerate_destinations(info: PlatformInfo) -> tuple[DestinationCandidate, ...]:
    """List install destinations with free space, recommended one first.

    The wizard needs somewhere to copy a ~48 GiB release, so it has to show real
    volumes and their free space rather than asking the user to type a path.
    """

    seen: set[str] = set()
    candidates: list[DestinationCandidate] = []
    try:
        preferred: Path | None = default_install_root(info).expanduser()
    except PlatformError:
        preferred = None

    ordered: list[tuple[Path, str, bool]] = []
    if preferred is not None:
        ordered.append((preferred, "This computer", True))
    ordered.extend((path, label, False) for path, label in _candidate_roots(info))

    for path, label, recommended in ordered:
        resolved = Path(os.path.abspath(os.fspath(path)))
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        try:
            probe = _nearest_existing_path(resolved)
            usage = shutil.disk_usage(probe)
        except (OSError, PlatformError):
            # Empty card readers and disconnected volumes are not destinations.
            continue
        _, filesystem = _volume_information(f"{resolved.drive}\\") if resolved.drive else (None, None)
        candidates.append(
            DestinationCandidate(
                id=_destination_id(resolved),
                label=label,
                path=resolved,
                free_bytes=usage.free,
                total_bytes=usage.total,
                filesystem=filesystem,
                recommended=recommended,
            )
        )
    return tuple(candidates)


def _nearest_existing_path(path: Path) -> Path:
    candidate = Path(path).expanduser()
    if candidate.exists():
        return candidate.parent if candidate.is_file() else candidate
    for parent in candidate.parents:
        if parent.exists():
            return parent.parent if parent.is_file() else parent
    raise PlatformError(f"cannot find an existing volume for: {path}")


def probe_free_bytes(path: Path) -> int:
    """Return free bytes for the nearest existing destination ancestor."""

    try:
        return shutil.disk_usage(_nearest_existing_path(Path(path))).free
    except OSError as error:
        raise PlatformError(f"cannot inspect free space for: {path}") from error


__all__ = [
    "DestinationCandidate",
    "PlatformError",
    "PlatformInfo",
    "default_install_root",
    "detect_platform",
    "enumerate_destinations",
    "normalize_architecture",
    "probe_free_bytes",
]

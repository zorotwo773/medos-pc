"""Safe destination validation and immutable MedOS installation plans."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Callable

from .manifest import ComponentManifest, FileRecord, sha256_file
from .platforms import PlatformInfo, detect_platform


class PlanningError(RuntimeError):
    """Raised when an installation cannot be planned safely.

    Destination refusals carry a stable ``code`` so the wizard can explain the
    problem in the user's own terms instead of matching on this message text.
    """

    def __init__(self, message: str, *, code: str = "") -> None:
        super().__init__(message)
        self.code = code


class InstallMode(str, Enum):
    FULL = "full"
    SPACE_SAVING = "space-saving"
    PORTABLE = "portable"


class SourceCheck(str, Enum):
    FULL = "full"
    DEFERRED = "deferred"


class PlanAction(str, Enum):
    COPY = "copy"
    SKIP_VERIFIED = "skip-verified"
    PRESERVE_MUTABLE = "preserve-mutable"
    EXTERNAL_DATA = "external-data"
    SKIP_OPTIONAL = "skip-optional"


@dataclass(frozen=True, slots=True)
class PlannedFile:
    record: FileRecord
    source_path: Path
    target_path: Path
    action: PlanAction


@dataclass(frozen=True, slots=True)
class InstallPlan:
    component_id: str
    source_root: Path
    target_root: Path
    mode: InstallMode
    items: tuple[PlannedFile, ...]
    copy_bytes: int
    external_bytes: int
    required_bytes: int

    def action_for(self, target: str | PurePosixPath) -> PlannedFile:
        requested = PurePosixPath(target).as_posix().casefold()
        for item in self.items:
            if item.record.target.as_posix().casefold() == requested:
                return item
        raise KeyError(str(target))


# Windows File Explorer skips entries whose destination path exceeds MAX_PATH and
# reports success anyway, so an "incomplete extraction" reaches setup looking like
# a corrupt release. Say what to do instead of only naming the file.
INCOMPLETE_EXTRACTION_HINT = (
    "This usually means the MedOS release ZIP was not extracted completely. "
    "Extract it again with 7-Zip, or extract to a short path such as C:\\MedOS, "
    "then start setup again."
)


def _human_bytes(value: int) -> str:
    """Format a byte count the way an end user reads disk space."""

    size = float(value)
    for unit in ("bytes", "KB", "MB", "GB"):
        if size < 1024.0 or unit == "GB":
            break
        size /= 1024.0
    if unit == "bytes":
        return f"{int(size)} bytes"
    return f"{size:.1f} {unit}"


def _common_path(first: Path, second: Path) -> Path | None:
    try:
        return Path(os.path.commonpath((first, second)))
    except ValueError:
        return None


def _is_root(path: Path) -> bool:
    return bool(path.anchor) and path == Path(path.anchor)


def _is_reparse_point(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _existing_destination_has_reparse(path: Path) -> bool:
    candidate = path
    while True:
        if candidate.exists() and _is_reparse_point(candidate):
            return True
        if candidate.parent == candidate:
            return False
        candidate = candidate.parent


def _is_managed_install(path: Path) -> bool:
    state = path / ".medos-install" / "install-state.json"
    if state.is_file():
        return True
    windows_shape = (path / "START.bat").is_file() and (path / "app").is_dir()
    mac_shape = (path / "MedOS.command").is_file() and (path / "app").is_dir()
    return windows_shape or mac_shape


def _nearest_existing_ancestor(path: Path) -> Path:
    candidate = path
    while not candidate.exists() and candidate.parent != candidate:
        candidate = candidate.parent
    return candidate


def _same_storage_volume(first: Path, second: Path) -> bool:
    """Compare physical/filesystem volumes without writing a probe file."""

    first_anchor = os.path.normcase(first.anchor)
    second_anchor = os.path.normcase(second.anchor)
    if first_anchor and second_anchor and first_anchor != second_anchor:
        return False
    try:
        return os.stat(_nearest_existing_ancestor(first)).st_dev == os.stat(
            _nearest_existing_ancestor(second)
        ).st_dev
    except OSError:
        return bool(first_anchor and first_anchor == second_anchor)


def validate_destination(
    source_root: Path,
    target_root: Path,
    *,
    home: Path,
    refuse_source_volume: bool = False,
) -> None:
    """Reject broad, overlapping, linked, or foreign installation targets."""

    source = Path(source_root).expanduser().resolve(strict=True)
    target_input = Path(target_root).expanduser()
    target = target_input.resolve(strict=False)
    resolved_home = Path(home).expanduser().resolve(strict=False)
    if _is_root(target):
        raise PlanningError(
            f"refusing filesystem root destination: {target}", code="destination-is-root"
        )
    if target == resolved_home:
        raise PlanningError(
            "refusing to install over the user home directory", code="destination-is-home"
        )
    overlap = _common_path(source, target)
    if overlap is not None and overlap in {source, target}:
        raise PlanningError("source and destination overlap", code="destination-overlaps-source")
    if refuse_source_volume and _same_storage_volume(source, target):
        raise PlanningError(
            "source release and copy destination are on the same volume",
            code="destination-is-source-volume",
        )
    if target_input.exists() and not target_input.is_dir():
        raise PlanningError(
            "install destination must be a directory", code="destination-not-a-folder"
        )
    if _existing_destination_has_reparse(target_input):
        raise PlanningError(
            "install destination resolves through a link or reparse point",
            code="destination-is-link",
        )
    if target_input.is_dir():
        try:
            nonempty = next(target_input.iterdir(), None) is not None
        except OSError as error:
            raise PlanningError(
                f"cannot inspect install destination: {target_input}",
                code="destination-unreadable",
            ) from error
        if nonempty and not _is_managed_install(target_input):
            raise PlanningError(
                "refusing non-MedOS non-empty destination",
                code="destination-has-other-files",
            )


def _record_applies(record: FileRecord, info: PlatformInfo) -> bool:
    if record.platform == "all":
        return True
    if record.platform == info.system:
        return True
    return record.platform == f"{info.system}-{info.architecture}"


def _contained_source_file(source_root: Path, relative: PurePosixPath) -> Path:
    root = source_root.resolve(strict=True)
    candidate_input = root / Path(*relative.parts)
    try:
        candidate = candidate_input.resolve(strict=True)
    except OSError as error:
        raise FileNotFoundError(str(candidate_input)) from error
    common = _common_path(root, candidate)
    if common != root:
        raise PlanningError(f"source path escapes source root: {relative}")
    if not candidate.is_file() or _is_reparse_point(candidate_input):
        raise PlanningError(f"source is not a contained regular file: {relative}")
    return candidate


def _contained_target_path(target_root: Path, relative: PurePosixPath) -> Path:
    root = target_root.resolve(strict=False)
    candidate_input = root / Path(*relative.parts)
    candidate = candidate_input.resolve(strict=False)
    if _common_path(root, candidate) != root:
        raise PlanningError(f"target path escapes destination: {relative}")
    if candidate_input.exists() and _is_reparse_point(candidate_input):
        raise PlanningError(f"target path is a link or reparse point: {relative}")
    return candidate_input


def _verify_source(
    record: FileRecord,
    source_root: Path,
    hash_file: Callable[[Path], str],
) -> Path | None:
    try:
        path = _contained_source_file(source_root, record.source)
    except FileNotFoundError:
        if record.required:
            raise PlanningError(
                f"required source is missing: {record.source}. {INCOMPLETE_EXTRACTION_HINT}"
            ) from None
        return None
    try:
        size = path.stat().st_size
    except OSError as error:
        raise PlanningError(f"cannot inspect source: {record.source}") from error
    if size != record.size:
        raise PlanningError(
            f"source size mismatch for {record.source}: expected {record.size}, "
            f"got {size}. {INCOMPLETE_EXTRACTION_HINT}"
        )
    try:
        digest = hash_file(path)
    except OSError as error:
        raise PlanningError(f"cannot hash source: {record.source}") from error
    if digest != record.sha256:
        raise PlanningError(f"source hash mismatch for {record.source}")
    return path


def _deferred_source_candidate(source_root: Path, relative: PurePosixPath) -> Path:
    candidate = source_root / Path(*relative.parts)
    if _common_path(source_root, candidate) != source_root:
        raise PlanningError(f"source path escapes source root: {relative}")
    return candidate


def resolve_copy_source(record: FileRecord, source_root: Path) -> Path:
    """Resolve and structurally verify one source immediately before copying it."""

    try:
        root = Path(source_root).expanduser().resolve(strict=True)
    except OSError as error:
        raise PlanningError(f"cannot inspect source root: {source_root}") from error
    candidate = _deferred_source_candidate(root, record.source)
    current = root
    try:
        for part in record.source.parts:
            current = current / part
            info = current.lstat()
            attributes = getattr(info, "st_file_attributes", 0)
            reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            if stat.S_ISLNK(info.st_mode) or attributes & reparse_flag:
                raise PlanningError(
                    f"source is not a contained regular file: {record.source}"
                )
        if not stat.S_ISREG(info.st_mode):
            raise PlanningError(f"source is not a contained regular file: {record.source}")
    except FileNotFoundError:
        message = (
            "required source is missing" if record.required else "optional source is missing"
        )
        raise PlanningError(f"{message}: {record.source}") from None
    except NotADirectoryError:
        raise PlanningError(f"source is not a contained regular file: {record.source}") from None
    except OSError as error:
        raise PlanningError(f"cannot inspect source: {record.source}") from error
    if info.st_size != record.size:
        raise PlanningError(
            f"source size mismatch for {record.source}: expected {record.size}, got {info.st_size}"
        )
    return candidate


def _target_is_verified(
    path: Path,
    record: FileRecord,
    hash_file: Callable[[Path], str],
) -> bool:
    if not path.exists():
        return False
    if not path.is_file() or _is_reparse_point(path):
        raise PlanningError(f"managed target is not a regular file: {record.target}")
    try:
        if path.stat().st_size != record.size:
            return False
        return hash_file(path) == record.sha256
    except OSError as error:
        raise PlanningError(f"cannot inspect managed target: {record.target}") from error


def build_install_plan(
    component: ComponentManifest,
    source_root: Path,
    target_root: Path,
    mode: InstallMode,
    *,
    free_bytes: int,
    reserve_bytes: int,
    hash_file: Callable[[Path], str] = sha256_file,
    platform_info: PlatformInfo | None = None,
    source_check: SourceCheck = SourceCheck.FULL,
    checkpoint: Callable[[], None] | None = None,
) -> InstallPlan:
    """Build a verified immutable plan without changing source or destination."""

    if isinstance(free_bytes, bool) or not isinstance(free_bytes, int) or free_bytes < 0:
        raise PlanningError("free_bytes must be a non-negative integer")
    if isinstance(reserve_bytes, bool) or not isinstance(reserve_bytes, int) or reserve_bytes < 0:
        raise PlanningError("reserve_bytes must be a non-negative integer")
    try:
        install_mode = mode if isinstance(mode, InstallMode) else InstallMode(mode)
    except ValueError as error:
        raise PlanningError(f"unsupported install mode: {mode}") from error
    try:
        check = source_check if isinstance(source_check, SourceCheck) else SourceCheck(source_check)
    except ValueError as error:
        raise PlanningError(f"unsupported source check: {source_check}") from error
    info = platform_info or detect_platform()
    source = Path(source_root).expanduser().resolve(strict=True)
    target = Path(target_root).expanduser().resolve(strict=False)
    if install_mode is InstallMode.PORTABLE:
        if source != target:
            raise PlanningError("portable mode requires the source and destination to be identical")
    else:
        validate_destination(source, target, home=info.home)

    items: list[PlannedFile] = []
    copy_bytes = 0
    external_bytes = 0
    for record in component.files:
        if checkpoint is not None:
            checkpoint()
        if not _record_applies(record, info):
            continue
        if check is SourceCheck.FULL:
            source_path = _verify_source(record, source, hash_file)
        else:
            source_path = _deferred_source_candidate(source, record.source)
        target_path = _contained_target_path(target, record.target)
        if source_path is None:
            items.append(
                PlannedFile(
                    record=record,
                    source_path=source / Path(*record.source.parts),
                    target_path=target_path,
                    action=PlanAction.SKIP_OPTIONAL,
                )
            )
            continue
        if install_mode is InstallMode.PORTABLE:
            action = PlanAction.SKIP_VERIFIED
        elif install_mode is InstallMode.SPACE_SAVING and record.role == "data":
            action = PlanAction.EXTERNAL_DATA
            external_bytes += record.size
        elif record.mutable and target_path.exists():
            action = PlanAction.PRESERVE_MUTABLE
        elif _target_is_verified(target_path, record, hash_file):
            action = PlanAction.SKIP_VERIFIED
        else:
            action = PlanAction.COPY
            copy_bytes += record.size
        items.append(
            PlannedFile(
                record=record,
                source_path=source_path,
                target_path=target_path,
                action=action,
            )
        )
    items.sort(key=lambda item: item.record.role in {"data", "model"})
    required_bytes = 0 if install_mode is InstallMode.PORTABLE else copy_bytes + reserve_bytes
    if free_bytes < required_bytes:
        raise PlanningError(
            f"Not enough free space on the destination: MedOS needs "
            f"{_human_bytes(required_bytes)} and only {_human_bytes(free_bytes)} "
            f"is free. Free up {_human_bytes(required_bytes - free_bytes)}, choose "
            f"another destination, or run MedOS straight from this drive with the "
            f"portable option instead of copying it."
        )
    return InstallPlan(
        component_id=component.component_id,
        source_root=source,
        target_root=target,
        mode=install_mode,
        items=tuple(items),
        copy_bytes=copy_bytes,
        external_bytes=external_bytes,
        required_bytes=required_bytes,
    )


def estimate_install_bytes(
    component: ComponentManifest,
    mode: InstallMode,
    *,
    reserve_bytes: int = 0,
    platform_info: PlatformInfo | None = None,
) -> tuple[int, int, int]:
    """Return (copy_bytes, external_bytes, required_bytes) without touching disk.

    build_install_plan() has to stat every source and destination file to decide
    a per-file action, which takes minutes over USB for a 200,000 file release.
    The wizard only needs to know whether a destination is large enough, and it
    needs that on every render, so this derives the same totals from the
    manifest alone.

    It assumes an empty destination and that every recorded source is present,
    which is what a fresh install onto a new folder looks like. Both assumptions
    can only over-state the space needed, never under-state it.
    """

    try:
        install_mode = mode if isinstance(mode, InstallMode) else InstallMode(mode)
    except ValueError as error:
        raise PlanningError(f"unsupported install mode: {mode}") from error
    if isinstance(reserve_bytes, bool) or not isinstance(reserve_bytes, int) or reserve_bytes < 0:
        raise PlanningError("reserve_bytes must be a non-negative integer")
    info = platform_info or detect_platform()

    copy_bytes = 0
    external_bytes = 0
    for record in component.files:
        if not _record_applies(record, info):
            continue
        if install_mode is InstallMode.PORTABLE:
            continue
        if install_mode is InstallMode.SPACE_SAVING and record.role == "data":
            external_bytes += record.size
            continue
        copy_bytes += record.size
    required_bytes = 0 if install_mode is InstallMode.PORTABLE else copy_bytes + reserve_bytes
    return copy_bytes, external_bytes, required_bytes


__all__ = [
    "INCOMPLETE_EXTRACTION_HINT",
    "InstallMode",
    "InstallPlan",
    "PlanAction",
    "PlannedFile",
    "PlanningError",
    "SourceCheck",
    "build_install_plan",
    "estimate_install_bytes",
    "resolve_copy_source",
    "validate_destination",
]

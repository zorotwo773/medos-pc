"""Transactional, idempotent MedOS Setup Drive preparation."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Callable, Iterable, Mapping

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _FileTime(ctypes.Structure):
        _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

    class _ByHandleFileInformation(ctypes.Structure):
        _fields_ = (
            ("attributes", wintypes.DWORD),
            ("creation_time", _FileTime),
            ("access_time", _FileTime),
            ("write_time", _FileTime),
            ("volume_serial", wintypes.DWORD),
            ("size_high", wintypes.DWORD),
            ("size_low", wintypes.DWORD),
            ("link_count", wintypes.DWORD),
            ("file_index_high", wintypes.DWORD),
            ("file_index_low", wintypes.DWORD),
        )

    class _FileBasicInformation(ctypes.Structure):
        _fields_ = (
            ("creation_time", ctypes.c_longlong),
            ("last_access_time", ctypes.c_longlong),
            ("last_write_time", ctypes.c_longlong),
            ("change_time", ctypes.c_longlong),
            ("file_attributes", wintypes.DWORD),
        )

    _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _CreateFileW = _KERNEL32.CreateFileW
    _CreateFileW.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    _CreateFileW.restype = wintypes.HANDLE
    _CloseHandle = _KERNEL32.CloseHandle
    _CloseHandle.argtypes = (wintypes.HANDLE,)
    _CloseHandle.restype = wintypes.BOOL
    _GetFileInformationByHandle = _KERNEL32.GetFileInformationByHandle
    _GetFileInformationByHandle.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(_ByHandleFileInformation),
    )
    _GetFileInformationByHandle.restype = wintypes.BOOL
    _GetFileInformationByHandleEx = _KERNEL32.GetFileInformationByHandleEx
    _GetFileInformationByHandleEx.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    _GetFileInformationByHandleEx.restype = wintypes.BOOL
    _SetFileInformationByHandle = _KERNEL32.SetFileInformationByHandle
    _SetFileInformationByHandle.argtypes = (
        wintypes.HANDLE,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    )
    _SetFileInformationByHandle.restype = wintypes.BOOL
    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    _GENERIC_READ = 0x80000000
    _FILE_LIST_DIRECTORY = 0x00000001
    _FILE_READ_ATTRIBUTES = 0x00000080
    _FILE_WRITE_ATTRIBUTES = 0x00000100
    _FILE_SHARE_READ = 0x00000001
    _FILE_SHARE_WRITE = 0x00000002
    _OPEN_EXISTING = 3
    _FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    _FILE_ATTRIBUTE_NORMAL = 0x00000080
    _FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _FILE_BASIC_INFO_CLASS = 0
    _WINDOWS_EPOCH_100NS = 116_444_736_000_000_000

from . import __version__
from .android import ApkMetadata, build_android_kit, verify_android_kit
from .mac_bootstrap import build_mac_bootstrap
from .manifest import (
    FileRecord,
    canonical_json_bytes,
    load_component_manifest,
    load_drive_manifest,
    sha256_file,
)
from .portable_paths import (
    LEGACY_BOOK_RENAMES,
    PortablePathError,
    portable_path_key,
    portable_relative_path,
)
from tools.release.audit_release_features import (
    ReleaseFeatureAuditError,
    require_release_features,
)


_IDENTIFIER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_EXCLUDED_DIRECTORIES = frozenset(
    {
        ".cache",
        ".git",
        ".history",
        ".medos-payload",
        ".medos-setup",
        ".next-cache",
        ".pytest_cache",
        ".thumbnails",
        ".venv",
        "__pycache__",
        "__test__",
        "__tests__",
        "_cache",
        "_fa_snippet_cache",
        "_thumbs",
        "archive",
        "cache",
        "history",
        "phone",
        "scratch",
        "test",
        "test-results",
        "tests",
    }
)
_EXCLUDED_NAMES = frozenset(
    {
        ".env",
        ".firewall-checked",
        "anki_progress.sqlite",
        "anki_userdecks.sqlite",
        "collection.media.7z",
        "ctgov_cache.sqlite",
        "fcontentsearch.db",
        "keystore.properties",
        "local.properties",
        "qbank_state.sqlite3",
        "status.json",
        "sync_node.json",
        "torrent_state.json",
        "user_content.json",
        "users.sqlite",
        "utd_index.sqlite",
        "utdasset_decrypted.sqlite",
    }
)
_EXCLUDED_SUFFIXES = (
    "-journal",
    "-shm",
    "-wal",
    ".apk",
    ".err",
    ".jks",
    ".keystore",
    ".log",
    ".pid",
    ".pyc",
    ".pyo",
    ".tmp",
    ".torrent",
    ".zip",
)
_PORTABLE_EXTERNAL_ROOT = PurePosixPath(".medos-payload/desktop-external")
_BOOKS_ROOT = ("data", "books")
_RESERVED_RELOCATED_DATA_ROOT = PurePosixPath("MedOS-storage/project/data")
# Canonical root for portable release staging receipts. Only used by the
# publishing tools (never by an installed app), and overridable so a build on a
# machine without an E: drive works unchanged.
_FIXED_RELEASE_STAGE_ROOT = Path(
    os.environ.get("MEDOS_RELEASE_STAGING")
    or (Path.home() / "MedOS-release-staging")
)
_RELEASE_STAGE_MANIFEST_NAME = "release-stage.json"
_RELEASE_STAGE_SIDECAR_NAME = "release-stage.json.sha256"
_RELEASE_STAGE_DATABASE_TARGETS = (
    PurePosixPath("app/backend/library_index.sqlite3"),
    PurePosixPath("data/book_chapter_index.sqlite"),
    PurePosixPath("data/global_search.sqlite"),
)
_RELEASE_STAGE_OVERRIDE_MAP = {
    "app/backend/library_index.sqlite3": "app/backend/library_index.sqlite3",
    "data/book_chapter_index.sqlite": "data/book_chapter_index.sqlite",
    "data/books": "data/books",
    "data/global_search.sqlite": "data/global_search.sqlite",
}


class PrepareError(RuntimeError):
    """Raised when drive preparation cannot publish a completely verified result."""


class PreparePhase(str, Enum):
    INVENTORY = "inventory"
    MAC = "mac"
    ANDROID = "android"
    MANIFESTS = "manifests"
    VERIFY = "verify"
    PUBLISH = "publish"
    COMPLETE = "complete"


@dataclass(frozen=True, slots=True)
class PrepareProgress:
    phase: PreparePhase
    message: str
    completed: int
    total: int


@dataclass(frozen=True, slots=True)
class PrepareConfig:
    source_root: Path
    drive_root: Path
    mac_tools_root: Path
    apk_path: Path
    phone_data_zip: Path
    drive_id: str
    release_id: str
    component_id: str = "desktop-core"
    apk_metadata: ApkMetadata | None = None
    before_phase: Callable[[PreparePhase], None] | None = None
    release_stage_manifest: Path | None = None


@dataclass(frozen=True, slots=True)
class PrepareItem:
    path: Path
    kind: str
    status: str
    size: int
    sha256: str


@dataclass(frozen=True, slots=True)
class PrepareReport:
    drive_root: Path
    drive_id: str
    release_id: str
    component_file_count: int
    component_bytes: int
    items: tuple[PrepareItem, ...]

    @property
    def artifacts(self) -> tuple[Path, ...]:
        return tuple(item.path for item in self.items)


@dataclass(frozen=True, slots=True)
class _InventoryFile:
    record: FileRecord
    source_path: Path
    portable_copy: bool = False
    source_identity: tuple[int, int, int, int] | None = None
    source_containment: Path | None = None
    release_stage_override: bool = False


@dataclass(frozen=True, slots=True)
class _Publication:
    staged: Path
    relative: PurePosixPath
    kind: str
    force_replace: bool = False


@dataclass(slots=True)
class _HeldReceiptFile:
    path: Path
    stream: BinaryIO
    content: bytes
    identity: tuple[int, int, int, int]
    label: str

    def assert_bound(self) -> None:
        _assert_no_reparse_chain(self.path, self.label)
        if _file_identity(self.path) != self.identity:
            raise PrepareError(f"{self.label} identity changed during preparation")
        try:
            self.stream.seek(0)
            held_content = self.stream.read(len(self.content) + 1)
            if os.name == "nt":
                rebound_stream = self.path.open("rb")
            else:
                descriptor = os.open(
                    self.path,
                    os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                )
                rebound_stream = _fdopen_owned_descriptor(
                    descriptor,
                    "rb",
                    self.label,
                )
            rebound_error: BaseException | None = None
            try:
                current = os.fstat(rebound_stream.fileno())
                if (
                    current.st_size,
                    current.st_mtime_ns,
                    current.st_dev,
                    current.st_ino,
                ) != self.identity:
                    raise PrepareError(
                        f"{self.label} identity changed during preparation"
                    )
                path_content = rebound_stream.read(len(self.content) + 1)
            except BaseException as error:
                rebound_error = error
                raise
            finally:
                _cleanup_preserving_primary(
                    rebound_error,
                    (rebound_stream.close,),
                    f"{self.label} rebound stream cleanup failed",
                )
        except OSError as error:
            raise _prepare_error_with_notes(
                f"{self.label} became unreadable",
                error,
            ) from error
        if held_content != self.content or path_content != self.content:
            raise PrepareError(f"{self.label} bytes changed during preparation")

    def close(self) -> None:
        self.stream.close()


def _exception_detail(error: BaseException) -> str:
    detail = f"{type(error).__name__}: {error}"
    if error.__cause__ is not None:
        detail += (
            f"; caused by {type(error.__cause__).__name__}: "
            f"{error.__cause__}"
        )
    notes = getattr(error, "__notes__", ())
    if notes:
        detail += "; " + "; ".join(notes)
    return detail


def _run_cleanup_actions(actions: Iterable[Callable[[], None]]) -> None:
    first_error: BaseException | None = None
    for action in actions:
        try:
            action()
        except BaseException as error:
            if first_error is None:
                first_error = error
            else:
                first_error.add_note(
                    f"additional cleanup failure: {_exception_detail(error)}"
                )
    if first_error is not None:
        raise first_error


def _cleanup_preserving_primary(
    primary_error: BaseException | None,
    actions: Iterable[Callable[[], None]],
    context: str,
) -> None:
    try:
        _run_cleanup_actions(actions)
    except BaseException as cleanup_error:
        if primary_error is None:
            raise
        primary_error.add_note(f"{context}: {_exception_detail(cleanup_error)}")


def _prepare_error_with_notes(message: str, cause: BaseException) -> PrepareError:
    error = PrepareError(message)
    for note in getattr(cause, "__notes__", ()):
        error.add_note(note)
    return error


def _fdopen_owned_descriptor(
    descriptor: int,
    mode: str,
    label: str,
) -> BinaryIO:
    try:
        return os.fdopen(descriptor, mode, closefd=True)
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (lambda: os.close(descriptor),),
            f"{label} descriptor cleanup failed",
        )
        raise


def _windows_fd_from_owned_handle(raw: int, flags: int, label: str) -> int:
    try:
        import msvcrt

        return msvcrt.open_osfhandle(raw, flags)
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (lambda: _windows_close_handle(raw),),
            f"{label} raw handle cleanup failed",
        )
        raise


@dataclass(slots=True)
class _ReleaseReceiptLease:
    manifest: _HeldReceiptFile
    sidecar: _HeldReceiptFile

    def assert_bound(self) -> None:
        self.manifest.assert_bound()
        self.sidecar.assert_bound()
        expected = hashlib.sha256(self.manifest.content).hexdigest().encode("ascii") + b"\n"
        if self.sidecar.content != expected:
            raise PrepareError("portable release stage receipt sidecar differs")

    def close(self) -> None:
        _run_cleanup_actions(
            held.close for held in (self.sidecar, self.manifest)
        )


@dataclass(slots=True)
class _HeldDirectoryChain:
    handles: list[int]
    windows: bool

    def close(self) -> None:
        handles = tuple(reversed(self.handles))
        self.handles.clear()

        def close_handle(handle: int) -> None:
            if self.windows:
                _windows_close_handle(handle)
            else:
                os.close(handle)

        _run_cleanup_actions(
            (lambda handle=handle: close_handle(handle))
            for handle in handles
        )


@dataclass(slots=True)
class _PublicationRecoveryState:
    rollback_required: bool = False
    retain_recovery: bool = False
    retained_stage: Path | None = None


@dataclass(frozen=True, slots=True)
class _ReleaseStageOverride:
    manifest_path: Path
    stage_root: Path
    source_root: Path
    prepared_root: Path
    library_root: Path
    inventory: tuple[_InventoryFile, ...]
    receipt_lease: _ReleaseReceiptLease


def _emit(
    callback: Callable[[PrepareProgress], None] | None,
    phase: PreparePhase,
    message: str,
    completed: int,
    total: int,
) -> None:
    if callback is not None:
        callback(PrepareProgress(phase, message, completed, total))


def _begin(config: PrepareConfig, phase: PreparePhase) -> None:
    if config.before_phase is not None:
        config.before_phase(phase)


def _resolved_directory(path: Path, label: str) -> Path:
    try:
        resolved = Path(path).expanduser().resolve(strict=True)
    except OSError as error:
        raise PrepareError(f"{label} is unavailable") from error
    if not resolved.is_dir() or Path(path).is_symlink():
        raise PrepareError(f"{label} must be a regular directory")
    return resolved


def _resolved_file(path: Path, label: str) -> Path:
    try:
        resolved = Path(path).expanduser().resolve(strict=True)
    except OSError as error:
        raise PrepareError(f"{label} is unavailable") from error
    if not resolved.is_file() or Path(path).is_symlink():
        raise PrepareError(f"{label} must be a regular file")
    return resolved


def _common(first: Path, second: Path) -> Path | None:
    try:
        return Path(os.path.commonpath((first, second)))
    except ValueError:
        return None


def _overlap(first: Path, second: Path) -> bool:
    common = _common(first, second)
    return common is not None and common in {first, second}


def _is_link_or_reparse(path: Path) -> bool:
    try:
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except OSError:
        return True
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(attributes & reparse_flag)


def _lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(Path(path).expanduser())))


def _path_lexists(path: Path) -> bool:
    return os.path.lexists(path)


def _directory_identity(path: Path) -> tuple[int, int] | None:
    try:
        info = path.lstat()
    except OSError:
        return None
    if _is_link_or_reparse(path) or not stat.S_ISDIR(info.st_mode):
        return None
    return (info.st_dev, info.st_ino)


def _prepare_drive_is_disconnected(
    drive: Path,
    expected_identity: tuple[int, int] | None,
) -> bool:
    """Return true only when the prepared output vanished or changed identity."""

    current = _directory_identity(drive)
    return current is None or (
        expected_identity is not None and current != expected_identity
    )


def _assert_existing_no_reparse_chain(path: Path, label: str) -> None:
    absolute = _lexical_absolute(path)
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if not _path_lexists(current):
            break
        if _is_link_or_reparse(current):
            raise PrepareError(f"{label} contains a symlink or reparse point")


def _file_identity(path: Path) -> tuple[int, int, int, int]:
    try:
        info = path.lstat()
    except OSError as error:
        raise PrepareError(f"release stage source is unavailable: {path.name}") from error
    if _is_link_or_reparse(path) or not stat.S_ISREG(info.st_mode):
        raise PrepareError(f"release stage source is not a regular file: {path.name}")
    return (info.st_size, info.st_mtime_ns, info.st_dev, info.st_ino)


def _assert_no_reparse_chain(path: Path, label: str) -> None:
    absolute = Path(path)
    if not absolute.is_absolute():
        raise PrepareError(f"{label} must be absolute")
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        if _is_link_or_reparse(current):
            raise PrepareError(f"{label} contains a symlink or reparse point")


def _windows_close_handle(handle: int) -> None:
    if os.name == "nt" and handle != _INVALID_HANDLE_VALUE:
        if not _CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())


def _windows_open_retained(
    path: Path,
    *,
    directory: bool,
    read_data: bool,
    write_attributes: bool = False,
) -> tuple[int, tuple[int, int, int, int, int, int]]:
    desired_access = _GENERIC_READ if read_data else _FILE_READ_ATTRIBUTES
    if write_attributes:
        desired_access |= _FILE_WRITE_ATTRIBUTES
    if directory:
        desired_access |= _FILE_LIST_DIRECTORY
    share_mode = _FILE_SHARE_READ | (_FILE_SHARE_WRITE if directory else 0)
    flags = _FILE_FLAG_OPEN_REPARSE_POINT
    if directory:
        flags |= _FILE_FLAG_BACKUP_SEMANTICS
    handle = _CreateFileW(
        str(path),
        desired_access,
        share_mode,
        None,
        _OPEN_EXISTING,
        flags,
        None,
    )
    if handle == _INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = _ByHandleFileInformation()
        if not _GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        size = (info.size_high << 32) | info.size_low
        file_id = (info.file_index_high << 32) | info.file_index_low
        written = (info.write_time.high << 32) | info.write_time.low
        mtime_ns = (written - _WINDOWS_EPOCH_100NS) * 100
        return handle, (
            info.attributes,
            info.volume_serial,
            file_id,
            size,
            mtime_ns,
            info.link_count,
        )
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (lambda: _windows_close_handle(handle),),
            "retained Windows handle cleanup failed",
        )
        raise


def _assert_windows_directory_chain_bound(
    held: _HeldDirectoryChain,
    path: Path,
    label: str,
) -> None:
    if os.name != "nt" or not held.windows:
        raise PrepareError(f"{label} Windows directory retention is unavailable")
    absolute = _lexical_absolute(path)
    candidates = [Path(absolute.anchor)]
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        candidates.append(current)
    if len(candidates) != len(held.handles):
        raise PrepareError(f"{label} retained directory chain is incomplete")
    for candidate, handle in zip(candidates, held.handles, strict=True):
        try:
            path_info = candidate.lstat()
        except OSError as error:
            raise PrepareError(f"{label} directory chain became unavailable") from error
        handle_info = _ByHandleFileInformation()
        if not _GetFileInformationByHandle(handle, ctypes.byref(handle_info)):
            raise ctypes.WinError(ctypes.get_last_error())
        file_id = (handle_info.file_index_high << 32) | handle_info.file_index_low
        if (
            _is_link_or_reparse(candidate)
            or not stat.S_ISDIR(path_info.st_mode)
            or handle_info.attributes & _FILE_ATTRIBUTE_REPARSE_POINT
            or not handle_info.attributes & _FILE_ATTRIBUTE_DIRECTORY
            or handle_info.volume_serial != path_info.st_dev & 0xFFFFFFFF
            or file_id != path_info.st_ino
        ):
            raise PrepareError(f"{label} directory chain changed while retained")


def _windows_clear_readonly_retained(candidate: Path, before: os.stat_result) -> None:
    if os.name != "nt":
        raise PrepareError("handle-bound read-only cleanup is unavailable")
    parent_chain: _HeldDirectoryChain | None = None
    handle: int | None = None
    primary_error: BaseException | None = None
    try:
        parent_chain = _hold_directory_chain(
            candidate.parent,
            "read-only staging entry parent",
        )
        _assert_windows_directory_chain_bound(
            parent_chain,
            candidate.parent,
            "read-only staging entry parent",
        )
        handle, handle_info = _windows_open_retained(
            candidate,
            directory=False,
            read_data=False,
            write_attributes=True,
        )
        _assert_windows_directory_chain_bound(
            parent_chain,
            candidate.parent,
            "read-only staging entry parent",
        )
        attributes, volume, file_id, size, mtime_ns, links = handle_info
        path_identity = (
            before.st_dev,
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_nlink,
        )
        rebound = candidate.lstat()
        if (
            _is_link_or_reparse(candidate)
            or not stat.S_ISREG(before.st_mode)
            or not stat.S_ISREG(rebound.st_mode)
            or attributes
            & (_FILE_ATTRIBUTE_DIRECTORY | _FILE_ATTRIBUTE_REPARSE_POINT)
            or not attributes & stat.FILE_ATTRIBUTE_READONLY
            or links != 1
            or volume != before.st_dev & 0xFFFFFFFF
            or (size, mtime_ns, file_id, links)
            != (before.st_size, before.st_mtime_ns, before.st_ino, before.st_nlink)
            or (
                rebound.st_dev,
                rebound.st_ino,
                rebound.st_size,
                rebound.st_mtime_ns,
                rebound.st_nlink,
            )
            != path_identity
        ):
            raise PrepareError(
                "read-only preparation staging entry changed before handle retention"
            )

        basic = _FileBasicInformation()
        if not _GetFileInformationByHandleEx(
            handle,
            _FILE_BASIC_INFO_CLASS,
            ctypes.byref(basic),
            ctypes.sizeof(basic),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if basic.file_attributes != attributes:
            raise PrepareError(
                "read-only preparation staging attributes changed before cleanup"
            )
        _assert_windows_directory_chain_bound(
            parent_chain,
            candidate.parent,
            "read-only staging entry parent",
        )
        updated_attributes = attributes & ~stat.FILE_ATTRIBUTE_READONLY
        if updated_attributes == 0:
            updated_attributes = _FILE_ATTRIBUTE_NORMAL
        basic.file_attributes = updated_attributes
        if not _SetFileInformationByHandle(
            handle,
            _FILE_BASIC_INFO_CLASS,
            ctypes.byref(basic),
            ctypes.sizeof(basic),
        ):
            raise ctypes.WinError(ctypes.get_last_error())

        after = _ByHandleFileInformation()
        if not _GetFileInformationByHandle(handle, ctypes.byref(after)):
            raise ctypes.WinError(ctypes.get_last_error())
        _assert_windows_directory_chain_bound(
            parent_chain,
            candidate.parent,
            "read-only staging entry parent",
        )
        after_file_id = (after.file_index_high << 32) | after.file_index_low
        after_size = (after.size_high << 32) | after.size_low
        after_written = (after.write_time.high << 32) | after.write_time.low
        after_mtime_ns = (after_written - _WINDOWS_EPOCH_100NS) * 100
        rebound = candidate.lstat()
        if (
            after.attributes != updated_attributes
            or after.attributes & stat.FILE_ATTRIBUTE_READONLY
            or after.attributes & _FILE_ATTRIBUTE_REPARSE_POINT
            or after.volume_serial != before.st_dev & 0xFFFFFFFF
            or (after_file_id, after_size, after_mtime_ns, after.link_count)
            != (before.st_ino, before.st_size, before.st_mtime_ns, before.st_nlink)
            or _is_link_or_reparse(candidate)
            or (
                rebound.st_dev,
                rebound.st_ino,
                rebound.st_size,
                rebound.st_mtime_ns,
                rebound.st_nlink,
            )
            != path_identity
            or getattr(rebound, "st_file_attributes", 0)
            & stat.FILE_ATTRIBUTE_READONLY
        ):
            raise PrepareError(
                "read-only preparation staging entry changed during handle cleanup"
            )
    except BaseException as error:
        primary_error = error
        raise
    finally:
        cleanup_actions: list[Callable[[], None]] = []
        if handle is not None:
            cleanup_actions.append(lambda: _windows_close_handle(handle))
        if parent_chain is not None:
            cleanup_actions.append(parent_chain.close)
        if cleanup_actions:
            _cleanup_preserving_primary(
                primary_error,
                cleanup_actions,
                "read-only staging handles cleanup failed",
            )


def _open_retained_directory(
    path: Path,
    label: str,
    *,
    parent_handle: int | None = None,
) -> int:
    try:
        if os.name == "nt":
            info = path.lstat()
            if _is_link_or_reparse(path) or not stat.S_ISDIR(info.st_mode):
                raise PrepareError(f"{label} contains an unsafe directory")
            handle, handle_info = _windows_open_retained(
                path,
                directory=True,
                read_data=False,
            )
            attributes, _volume, file_id, _size, _mtime, _links = handle_info
            if (
                attributes & _FILE_ATTRIBUTE_REPARSE_POINT
                or not attributes & _FILE_ATTRIBUTE_DIRECTORY
                or file_id != info.st_ino
            ):
                error = PrepareError(f"{label} changed while it was retained")
                _cleanup_preserving_primary(
                    error,
                    (lambda: _windows_close_handle(handle),),
                    f"{label} handle cleanup failed",
                )
                raise error
            return handle
        import fcntl

        if parent_handle is None:
            info = path.lstat()
            open_path: str | Path = path
            open_kwargs: dict[str, int] = {}
        else:
            info = os.stat(
                path.name,
                dir_fd=parent_handle,
                follow_symlinks=False,
            )
            open_path = path.name
            open_kwargs = {"dir_fd": parent_handle}
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise PrepareError(f"{label} contains an unsafe directory")
        handle = os.open(
            open_path,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            **open_kwargs,
        )
        try:
            fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
            current_info = os.fstat(handle)
            if (current_info.st_dev, current_info.st_ino) != (
                info.st_dev,
                info.st_ino,
            ):
                raise PrepareError(f"{label} changed while it was retained")
            return handle
        except BaseException as error:
            _cleanup_preserving_primary(
                error,
                (lambda: os.close(handle),),
                f"{label} handle cleanup failed",
            )
            raise
    except PrepareError:
        raise
    except (ImportError, OSError) as error:
        raise PrepareError(f"cannot retain {label}") from error


def _hold_directory_chain(path: Path, label: str) -> _HeldDirectoryChain:
    absolute = _lexical_absolute(path)
    candidates = [Path(absolute.anchor)]
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current /= part
        candidates.append(current)
    held = _HeldDirectoryChain([], os.name == "nt")
    try:
        for candidate in candidates:
            held.handles.append(
                _open_retained_directory(
                    candidate,
                    label,
                    parent_handle=(held.handles[-1] if held.handles else None),
                )
            )
        return held
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (held.close,),
            "directory handle cleanup failed",
        )
        if not isinstance(error, Exception) or isinstance(error, PrepareError):
            raise
        raise PrepareError(f"cannot retain {label}") from error


def _open_held_receipt_file(
    path: Path,
    label: str,
    *,
    maximum_bytes: int,
) -> _HeldReceiptFile:
    _assert_no_reparse_chain(path, label)
    identity = _file_identity(path)
    stream: BinaryIO
    if os.name == "nt":
        raw: int | None = None
        try:
            raw, handle_info = _windows_open_retained(
                path,
                directory=False,
                read_data=True,
            )
            attributes, _volume, file_id, size, mtime_ns, _links = handle_info
            if attributes & (
                _FILE_ATTRIBUTE_DIRECTORY | _FILE_ATTRIBUTE_REPARSE_POINT
            ):
                raise PrepareError(f"{label} must be a regular file")
            if (size, mtime_ns, path.lstat().st_ino) != (
                identity[0],
                identity[1],
                file_id,
            ):
                raise PrepareError(f"{label} changed while it was opened")
            owned_raw = raw
            raw = None
            descriptor = _windows_fd_from_owned_handle(
                owned_raw,
                os.O_RDONLY | getattr(os, "O_BINARY", 0),
                label,
            )
            stream = _fdopen_owned_descriptor(descriptor, "rb", label)
        except BaseException as error:
            if raw is not None:
                _cleanup_preserving_primary(
                    error,
                    (lambda: _windows_close_handle(raw),),
                    f"{label} raw handle cleanup failed",
                )
            if isinstance(error, PrepareError):
                raise
            if isinstance(error, (ImportError, OSError)):
                raise _prepare_error_with_notes(
                    f"cannot retain {label} handle",
                    error,
                ) from error
            raise
    else:
        descriptor: int | None = None
        try:
            import fcntl

            # POSIX has no Windows-style mandatory deny-delete sharing. Stage
            # writers are therefore required to honor this advisory lease;
            # exact pathname identity and bytes are also rebound around Task 5.
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags)
            fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            owned_descriptor = descriptor
            descriptor = None
            stream = _fdopen_owned_descriptor(
                owned_descriptor,
                "rb",
                label,
            )
        except BaseException as error:
            if descriptor is not None:
                _cleanup_preserving_primary(
                    error,
                    (lambda: os.close(descriptor),),
                    f"{label} descriptor cleanup failed",
                )
            if isinstance(error, (ImportError, OSError)):
                raise _prepare_error_with_notes(
                    f"cannot retain {label} handle",
                    error,
                ) from error
            raise
    try:
        content = stream.read(maximum_bytes + 1)
        if len(content) > maximum_bytes:
            raise PrepareError(f"{label} is unexpectedly large")
        held = _HeldReceiptFile(path, stream, content, identity, label)
        held.assert_bound()
        return held
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (stream.close,),
            f"{label} stream cleanup failed",
        )
        raise


def _open_release_receipt_lease(
    manifest: Path,
    sidecar: Path,
) -> _ReleaseReceiptLease:
    held_manifest = _open_held_receipt_file(
        manifest,
        "portable release stage receipt",
        maximum_bytes=8 * 1024 * 1024,
    )
    try:
        held_sidecar = _open_held_receipt_file(
            sidecar,
            "portable release stage sidecar",
            maximum_bytes=1024,
        )
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (held_manifest.close,),
            "portable release stage receipt cleanup failed",
        )
        raise
    lease = _ReleaseReceiptLease(held_manifest, held_sidecar)
    try:
        lease.assert_bound()
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (lease.close,),
            "portable release receipt lease cleanup failed",
        )
        raise
    return lease


def _contained_stage_file(stage_root: Path, relative: PurePosixPath) -> Path:
    candidate = stage_root / Path(*relative.parts)
    current = stage_root
    if _is_link_or_reparse(current):
        raise PrepareError("release stage contains a symlink or reparse point")
    for part in relative.parts:
        current /= part
        if _is_link_or_reparse(current):
            raise PrepareError("release stage contains a symlink or reparse point")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(stage_root)
    except (OSError, ValueError) as error:
        raise PrepareError("release stage source escapes the fixed stage") from error
    _file_identity(candidate)
    return candidate


def _is_release_stage_target(target: PurePosixPath) -> bool:
    return target.parts[:2] == _BOOKS_ROOT or target in _RELEASE_STAGE_DATABASE_TARGETS


def _read_release_stage_receipt(content: bytes) -> dict:
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PrepareError("verified release stage receipt is unreadable") from error
    if type(value) is not dict:
        raise PrepareError("verified release stage receipt is malformed")
    return value


def _canonical_relocated_data_root(
    source: Path,
    *,
    prepared_root: Path,
) -> Path | None:
    data_binding = source / "data"
    if _is_link_or_reparse(data_binding):
        _assert_no_reparse_chain(
            data_binding.parent,
            "canonical desktop data source parent",
        )
        reserved = prepared_root / Path(*_RESERVED_RELOCATED_DATA_ROOT.parts)
        _assert_no_reparse_chain(reserved, "reserved relocated data source")
        try:
            bound_data = data_binding.resolve(strict=True)
            reserved_data = reserved.resolve(strict=True)
        except OSError as error:
            raise PrepareError("reserved relocated data source is unavailable") from error
        if (
            not reserved_data.is_dir()
            or str(bound_data) != str(reserved_data)
            or str(reserved_data) != str(reserved)
        ):
            raise PrepareError(
                "canonical desktop data source is not the reserved prepared-drive binding"
            )
        return reserved_data
    else:
        _assert_no_reparse_chain(
            data_binding,
            "canonical desktop books source parent",
        )
        return None


def _canonical_release_stage_library_root(
    receipt: dict,
    *,
    source: Path,
    prepared_root: Path,
) -> Path:
    roots = receipt.get("roots")
    if type(roots) is not dict:
        raise PrepareError("portable release stage roots are malformed")
    raw_library = roots.get("library_root")
    if type(raw_library) is not str or not raw_library:
        raise PrepareError("portable release stage library root is not canonical")
    declared = Path(raw_library)
    if (
        not declared.is_absolute()
        or raw_library != str(declared)
        or str(_lexical_absolute(declared)) != str(declared)
    ):
        raise PrepareError("portable release stage library root is not canonical")
    _assert_no_reparse_chain(declared, "portable release stage library root")
    try:
        canonical = declared.resolve(strict=True)
    except OSError as error:
        raise PrepareError("portable release stage library root is unavailable") from error
    if str(canonical) != str(declared) or not canonical.is_dir():
        raise PrepareError("portable release stage library root is not canonical")

    _canonical_relocated_data_root(source, prepared_root=prepared_root)
    data_binding = source / "data"

    books_binding = data_binding / "books"
    try:
        bound_library = books_binding.resolve(strict=True)
    except OSError as error:
        raise PrepareError("canonical desktop books source is unavailable") from error
    if not bound_library.is_dir() or str(bound_library) != str(canonical):
        raise PrepareError(
            "portable release stage library root differs from the desktop books source"
        )
    return canonical


def _verify_release_stage(
    source: Path,
    library: Path,
    stage_root: Path,
    manifest: Path,
    release_id: str,
    receipt_lease: _ReleaseReceiptLease,
) -> None:
    try:
        from tools.release.stage_portable_library import (
            StageError,
            verify_release_stage,
        )
    except ImportError as error:
        raise PrepareError("portable release stage verification is unavailable") from error
    receipt_lease.assert_bound()
    try:
        report = verify_release_stage(
            source,
            library,
            stage_root,
            release_id=release_id,
        )
    except (OSError, StageError, TypeError, ValueError) as error:
        raise PrepareError("portable release stage failed verification") from error
    receipt_lease.assert_bound()
    try:
        reported_manifest = report.manifest_path.resolve(strict=True)
    except OSError as error:
        raise PrepareError("portable release stage receipt became unavailable") from error
    if reported_manifest != manifest:
        raise PrepareError("portable release stage verifier returned a different receipt")


def _release_stage_inventory(
    receipt: dict,
    *,
    source: Path,
    library_root: Path,
    stage_root: Path,
) -> tuple[_InventoryFile, ...]:
    if receipt.get("release_id") != stage_root.name:
        raise PrepareError("portable release stage ID does not match its fixed directory")
    roots = receipt.get("roots")
    if type(roots) is not dict or roots.get("source_root") != str(source):
        raise PrepareError("portable release stage source root is not canonical")
    if roots.get("library_root") != str(library_root):
        raise PrepareError("portable release stage library root is not canonical")
    if roots.get("stage_root") != str(stage_root):
        raise PrepareError("portable release stage root is not canonical")
    if receipt.get("overrides") != _RELEASE_STAGE_OVERRIDE_MAP:
        raise PrepareError("portable release stage override map is not fixed")

    rows = receipt.get("source_files")
    if type(rows) is not list or not rows:
        raise PrepareError("portable release stage book inventory is empty or malformed")
    inventory_summary = receipt.get("book_inventory")
    if type(inventory_summary) is not dict:
        raise PrepareError("portable release stage book inventory summary is malformed")

    inventory: list[_InventoryFile] = []
    valid_staged_paths: set[str] = set()
    staged_keys: set[str] = set()
    valid_logical_bytes = 0
    for index, row in enumerate(rows):
        if type(row) is not dict or set(row) != {
            "canonical_path",
            "staged_path",
            "size",
            "mtime_ns",
            "device",
            "file_id",
        }:
            raise PrepareError("portable release stage source record is malformed")
        if type(row["staged_path"]) is not str:
            raise PrepareError("portable release stage path has a noncanonical type")
        for field in ("size", "mtime_ns", "device", "file_id"):
            if type(row[field]) is not int or row[field] < 0:
                raise PrepareError("portable release stage identity has a noncanonical type")
        try:
            staged_relative = portable_relative_path(
                row["staged_path"],
                f"release stage source_files[{index}].staged_path",
            )
        except PortablePathError as error:
            raise PrepareError(str(error)) from error
        portable_key = portable_path_key(staged_relative)
        if portable_key in staged_keys:
            raise PrepareError("portable release stage book path collision")
        staged_keys.add(portable_key)
        valid_staged_paths.add(staged_relative.as_posix())
        target = PurePosixPath("data/books") / staged_relative
        path = _contained_stage_file(stage_root, target)
        identity = _file_identity(path)
        receipt_identity = (
            row["size"],
            row["mtime_ns"],
            row["device"],
            row["file_id"],
        )
        if identity != receipt_identity:
            raise PrepareError("portable release stage book identity drift")
        inventory.append(
            _record(
                path,
                source_root=stage_root,
                source_override=_PORTABLE_EXTERNAL_ROOT / target,
                target=target,
                role="data",
                platform="all",
                mutable=False,
                portable_copy=True,
                source_identity=identity,
                source_containment=stage_root,
                release_stage_override=True,
            )
        )
        valid_logical_bytes += row["size"]

    quarantine = receipt.get("invalid_pdf_quarantine")
    if type(quarantine) is not dict or set(quarantine) != {
        "schema_version",
        "manifest_sha256",
        "catalog_path",
        "catalog_size",
        "catalog_sha256",
        "file_count",
        "logical_bytes",
        "entries",
    }:
        raise PrepareError("portable release stage quarantine summary is malformed")
    if (
        type(quarantine["schema_version"]) is not int
        or quarantine["schema_version"] != 1
        or type(quarantine["entries"]) is not list
    ):
        raise PrepareError("portable release stage quarantine schema is unsupported")
    quarantine_paths: set[str] = set()
    quarantine_logical_bytes = 0
    for index, row in enumerate(quarantine["entries"]):
        if type(row) is not dict or set(row) != {
            "relative_path",
            "quarantine_path",
            "size",
            "sha256",
            "reason",
            "probe_kind",
            "probe_timeout_seconds",
            "diagnostic",
            "mtime_ns",
            "device",
            "file_id",
        }:
            raise PrepareError("portable release stage quarantine entry is malformed")
        if (
            type(row["relative_path"]) is not str
            or type(row["quarantine_path"]) is not str
        ):
            raise PrepareError("portable release stage quarantine path type is invalid")
        try:
            source_relative = portable_relative_path(
                row["relative_path"],
                f"release stage quarantine[{index}].relative_path",
            )
            quarantine_relative = portable_relative_path(
                row["quarantine_path"],
                f"release stage quarantine[{index}].quarantine_path",
            )
        except PortablePathError as error:
            raise PrepareError(str(error)) from error
        expected_name = hashlib.sha256(
            source_relative.as_posix().encode("utf-8")
        ).hexdigest()
        expected_quarantine = PurePosixPath(
            f".medos-quarantine/invalid-books/{expected_name}.pdf.invalid"
        )
        if quarantine_relative != expected_quarantine:
            raise PrepareError("portable release stage quarantine mapping differs")
        key = portable_path_key(quarantine_relative)
        if key in staged_keys:
            raise PrepareError("portable release stage quarantine path collision")
        staged_keys.add(key)
        quarantine_paths.add(quarantine_relative.as_posix())
        for field in ("size", "mtime_ns", "device", "file_id"):
            if type(row[field]) is not int or row[field] < 0:
                raise PrepareError("portable release stage quarantine identity is invalid")
        if type(row["sha256"]) is not str or not re.fullmatch(
            r"[0-9a-f]{64}", row["sha256"]
        ):
            raise PrepareError("portable release stage quarantine digest is invalid")
        target = PurePosixPath("data/books") / quarantine_relative
        path = _contained_stage_file(stage_root, target)
        identity = _file_identity(path)
        expected_identity = (
            row["size"],
            row["mtime_ns"],
            row["device"],
            row["file_id"],
        )
        if identity != expected_identity:
            raise PrepareError("portable release stage quarantine identity drift")
        item = _record(
            path,
            source_root=stage_root,
            source_override=_PORTABLE_EXTERNAL_ROOT / target,
            target=target,
            role="data",
            platform="all",
            mutable=False,
            portable_copy=True,
            source_identity=identity,
            source_containment=stage_root,
            release_stage_override=True,
        )
        if item.record.size != row["size"] or item.record.sha256 != row["sha256"]:
            raise PrepareError("portable release stage quarantine bytes differ")
        inventory.append(item)
        quarantine_logical_bytes += row["size"]

    if quarantine["entries"]:
        if (
            type(quarantine["manifest_sha256"]) is not str
            or not re.fullmatch(r"[0-9a-f]{64}", quarantine["manifest_sha256"])
        ):
            raise PrepareError("portable release stage quarantine manifest digest differs")
        catalog_relative = PurePosixPath(".medos-quarantine/invalid-books.json")
        if quarantine["catalog_path"] != catalog_relative.as_posix():
            raise PrepareError("portable release stage quarantine catalog path differs")
        target = PurePosixPath("data/books") / catalog_relative
        path = _contained_stage_file(stage_root, target)
        identity = _file_identity(path)
        item = _record(
            path,
            source_root=stage_root,
            source_override=_PORTABLE_EXTERNAL_ROOT / target,
            target=target,
            role="data",
            platform="all",
            mutable=False,
            portable_copy=True,
            source_identity=identity,
            source_containment=stage_root,
            release_stage_override=True,
        )
        if (
            type(quarantine["catalog_size"]) is not int
            or type(quarantine["catalog_sha256"]) is not str
            or item.record.size != quarantine["catalog_size"]
            or item.record.sha256 != quarantine["catalog_sha256"]
        ):
            raise PrepareError("portable release stage quarantine catalog differs")
        inventory.append(item)
    elif any(
        type(quarantine[field]) is not type(expected)
        or quarantine[field] != expected
        for field, expected in (
            ("manifest_sha256", None),
            ("catalog_path", None),
            ("catalog_size", 0),
            ("catalog_sha256", None),
            ("file_count", 0),
            ("logical_bytes", 0),
        )
    ):
        raise PrepareError("empty portable release stage quarantine evidence differs")

    if (
        type(quarantine["file_count"]) is not int
        or quarantine["file_count"] != len(quarantine["entries"])
        or type(quarantine["logical_bytes"]) is not int
        or quarantine["logical_bytes"] != quarantine_logical_bytes
    ):
        raise PrepareError("portable release stage quarantine totals differ")

    expected_summary = {
        "file_count": len(rows) + len(quarantine["entries"]),
        "logical_bytes": valid_logical_bytes + quarantine_logical_bytes,
        "path_set_sha256": hashlib.sha256(
            "\n".join(sorted(valid_staged_paths | quarantine_paths)).encode("utf-8")
        ).hexdigest(),
        "valid_file_count": len(rows),
        "valid_logical_bytes": valid_logical_bytes,
        "valid_pdf_count": sum(
            PurePosixPath(row["staged_path"]).suffix.lower() == ".pdf" for row in rows
        ),
    }
    if inventory_summary != expected_summary:
        raise PrepareError("portable release stage book inventory summary differs")
    renamed_targets = {
        (PurePosixPath("data/books") / target).as_posix()
        for target in LEGACY_BOOK_RENAMES.values()
    }
    observed_targets = {item.record.target.as_posix() for item in inventory}
    if not renamed_targets.issubset(observed_targets):
        raise PrepareError("portable release stage is missing one of seven renamed books")

    database_evidence = receipt.get("generated_databases")
    if type(database_evidence) is not dict or set(database_evidence) != {
        target.as_posix() for target in _RELEASE_STAGE_DATABASE_TARGETS
    }:
        raise PrepareError("portable release stage database inventory is not fixed")
    for target in _RELEASE_STAGE_DATABASE_TARGETS:
        path = _contained_stage_file(stage_root, target)
        identity = _file_identity(path)
        evidence = database_evidence[target.as_posix()]
        if type(evidence) is not dict:
            raise PrepareError("portable release stage database evidence differs")
        item = _record(
            path,
            source_root=stage_root,
            source_override=_PORTABLE_EXTERNAL_ROOT / target,
            target=target,
            role="runtime" if target.parts[:2] == ("app", "backend") else "data",
            platform="all",
            mutable=False,
            portable_copy=True,
            source_identity=identity,
            source_containment=stage_root,
            release_stage_override=True,
        )
        if (
            type(evidence.get("size")) is not int
            or type(evidence.get("sha256")) is not str
            or item.record.size != evidence["size"]
            or item.record.sha256 != evidence["sha256"]
        ):
            raise PrepareError("portable release stage database evidence differs")
        inventory.append(item)
    _reject_inventory_collisions(inventory)
    return tuple(inventory)


def _load_release_stage_override(
    config: PrepareConfig,
    source: Path,
) -> _ReleaseStageOverride | None:
    if config.release_stage_manifest is None:
        return None
    fixed_input = _lexical_absolute(Path(_FIXED_RELEASE_STAGE_ROOT))
    manifest_input = _lexical_absolute(Path(config.release_stage_manifest))
    stage_input = fixed_input / config.release_id
    expected_manifest_input = stage_input / _RELEASE_STAGE_MANIFEST_NAME
    sidecar_input = stage_input / _RELEASE_STAGE_SIDECAR_NAME
    if manifest_input != expected_manifest_input:
        raise PrepareError("portable release stage receipt is not the canonical fixed receipt")
    for path, label in (
        (fixed_input, "fixed release stage root"),
        (stage_input, "portable release stage"),
        (manifest_input, "portable release stage receipt"),
        (sidecar_input, "portable release stage sidecar"),
    ):
        _assert_no_reparse_chain(path, label)
    try:
        fixed_root = fixed_input.resolve(strict=True)
        stage_root = stage_input.resolve(strict=True)
        manifest = manifest_input.resolve(strict=True)
        sidecar = sidecar_input.resolve(strict=True)
    except OSError as error:
        raise PrepareError("portable release stage receipt is unavailable") from error
    expected_manifest = stage_root / _RELEASE_STAGE_MANIFEST_NAME
    if manifest != expected_manifest:
        raise PrepareError("portable release stage receipt is not the canonical fixed receipt")
    if stage_root.parent != fixed_root or stage_root.name != config.release_id:
        raise PrepareError("portable release stage is outside the fixed containment root")
    drive = Path(config.drive_root).expanduser().resolve(strict=False)
    if _overlap(drive, fixed_root):
        raise PrepareError("prepared output must not overlap the fixed release stage root")
    if not stage_root.is_dir():
        raise PrepareError("portable release stage is not a regular directory")

    receipt_lease = _open_release_receipt_lease(manifest, sidecar)
    try:
        receipt_lease.assert_bound()
        receipt = _read_release_stage_receipt(receipt_lease.manifest.content)
        library = _canonical_release_stage_library_root(
            receipt,
            source=source,
            prepared_root=drive,
        )
        receipt_lease.assert_bound()
        _verify_release_stage(
            source,
            library,
            stage_root,
            manifest,
            config.release_id,
            receipt_lease,
        )
        inventory = _release_stage_inventory(
            receipt,
            source=source,
            library_root=library,
            stage_root=stage_root,
        )
        receipt_lease.assert_bound()
        return _ReleaseStageOverride(
            manifest_path=manifest,
            stage_root=stage_root,
            source_root=source,
            prepared_root=drive,
            library_root=library,
            inventory=inventory,
            receipt_lease=receipt_lease,
        )
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (receipt_lease.close,),
            "release receipt handle cleanup failed",
        )
        raise


def _reverify_release_stage(override: _ReleaseStageOverride) -> None:
    override.receipt_lease.assert_bound()
    receipt = _read_release_stage_receipt(override.receipt_lease.manifest.content)
    library = _canonical_release_stage_library_root(
        receipt,
        source=override.source_root,
        prepared_root=override.prepared_root,
    )
    if str(library) != str(override.library_root):
        raise PrepareError("portable release stage library root changed during preparation")
    _verify_release_stage(
        override.source_root,
        override.library_root,
        override.stage_root,
        override.manifest_path,
        override.stage_root.name,
        override.receipt_lease,
    )
    for item in override.inventory:
        _revalidate_inventory_source(item)


def _revalidate_inventory_source(item: _InventoryFile) -> None:
    if item.source_identity is None or item.source_containment is None:
        raise PrepareError("portable release stage source identity is unavailable")
    contained = _contained_stage_file(item.source_containment, item.record.target)
    if contained != item.source_path or _file_identity(contained) != item.source_identity:
        raise PrepareError("portable release stage source identity drift")


def _assert_independent_release_copy(
    item: _InventoryFile,
    destination: Path,
    *,
    verify_digest: bool = True,
) -> tuple[int, int, int]:
    _assert_no_reparse_chain(destination, "materialized release stage destination")
    try:
        info = destination.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise PrepareError(
                f"materialized release stage source is not regular: {item.record.target}"
            )
        if info.st_nlink and info.st_nlink != 1:
            raise PrepareError(
                f"materialized release stage source is not independent: {item.record.target}"
            )
        if os.path.samefile(item.source_path, destination):
            raise PrepareError(
                f"materialized release stage source aliases its input: {item.record.target}"
            )
        copied_digest = sha256_file(destination) if verify_digest else item.record.sha256
    except PrepareError:
        raise
    except OSError as error:
        raise PrepareError(
            f"cannot verify materialized release stage source: {item.record.target}"
        ) from error
    if info.st_size != item.record.size or copied_digest != item.record.sha256:
        raise PrepareError(
            f"materialized release stage source differs: {item.record.target}"
        )
    return (info.st_dev, info.st_ino, info.st_nlink)


def _directory_metadata(root: Path) -> dict[str, tuple[int, int]]:
    if not root.is_dir():
        return {}
    result: dict[str, tuple[int, int]] = {}
    for directory, names, _files in os.walk(root, topdown=True, followlinks=False):
        current = Path(directory)
        names[:] = [
            name for name in names if not _is_link_or_reparse(current / name)
        ]
        info = current.stat()
        relative = current.relative_to(root).as_posix()
        result[relative] = (info.st_atime_ns, info.st_mtime_ns)
    return result


def _restore_directory_metadata(
    root: Path,
    original: dict[str, tuple[int, int]],
) -> None:
    if not root.is_dir() or _is_link_or_reparse(root):
        return
    current_directories: list[Path] = []
    for directory, names, _files in os.walk(root, topdown=True, followlinks=False):
        current = Path(directory)
        kept: list[str] = []
        for name in names:
            candidate = current / name
            if _is_link_or_reparse(candidate):
                continue
            kept.append(name)
            current_directories.append(candidate)
        names[:] = kept
    current_directories.sort(key=lambda path: len(path.parts), reverse=True)
    for path in current_directories:
        relative = path.relative_to(root).as_posix()
        if relative not in original:
            try:
                path.rmdir()
            except OSError:
                pass
    for relative, times in sorted(
        original.items(),
        key=lambda item: len(PurePosixPath(item[0]).parts),
        reverse=True,
    ):
        path = root if relative == "." else root / Path(*PurePosixPath(relative).parts)
        try:
            if path.is_dir() and not _is_link_or_reparse(path):
                os.utime(path, ns=times)
        except OSError:
            pass


def _assert_no_reparse_tree(path: Path, label: str) -> None:
    _assert_no_reparse_chain(path, label)
    if path.is_file():
        return
    if not path.is_dir():
        raise PrepareError(f"{label} is not a regular tree")
    for directory, names, files in os.walk(path, topdown=True, followlinks=False):
        current = Path(directory)
        for name in names + files:
            candidate = current / name
            if _is_link_or_reparse(candidate):
                raise PrepareError(f"{label} contains a symlink or reparse point")


def _create_initial_stage_tree(
    drive: Path,
    stage: Path,
    publish: Path,
) -> _HeldDirectoryChain:
    expected_staging = drive / ".medos-setup" / "staging"
    if stage.parent != expected_staging or publish != stage / "publish":
        raise PrepareError("preparation staging path is not canonical")
    absolute_drive = _lexical_absolute(drive)
    current = Path(absolute_drive.anchor)
    components = [current]
    for part in absolute_drive.parts[1:]:
        current /= part
        components.append(current)
    components.extend(
        (
            drive / ".medos-setup",
            expected_staging,
            stage,
            publish,
        )
    )
    held = _HeldDirectoryChain([], os.name == "nt")
    try:
        for index, candidate in enumerate(components):
            must_be_new = candidate in {stage, publish}
            exists = _path_lexists(candidate)
            if must_be_new and exists:
                raise PrepareError("preparation staging directory already exists")
            if not exists:
                if not held.handles:
                    raise PrepareError("preparation staging anchor is unavailable")
                try:
                    if os.name == "nt":
                        os.mkdir(candidate)
                    else:
                        os.mkdir(candidate.name, dir_fd=held.handles[-1])
                except OSError as error:
                    raise PrepareError(
                        f"cannot create preparation staging component: {candidate.name}"
                    ) from error
            label = (
                "prepared output"
                if index < len(absolute_drive.parts)
                else "preparation staging tree"
            )
            held.handles.append(
                _open_retained_directory(
                    candidate,
                    label,
                    parent_handle=(held.handles[-1] if held.handles else None),
                )
            )
        return held
    except BaseException as error:
        _cleanup_preserving_primary(
            error,
            (held.close,),
            "initial staging handle cleanup failed",
        )
        raise


def _find_resumable_prepare_stage(
    drive: Path,
    config: PrepareConfig,
) -> Path | None:
    staging_parent = drive / ".medos-setup" / "staging"
    if not _path_lexists(staging_parent):
        return None
    _assert_no_reparse_chain(staging_parent, "preparation staging parent")
    try:
        entries = sorted(staging_parent.iterdir(), key=lambda value: value.name)
    except OSError as error:
        raise PrepareError("cannot inspect retained preparation stages") from error
    if not entries:
        return None
    if len(entries) != 1:
        raise PrepareError(
            "multiple retained preparation stages require explicit recovery"
        )
    stage = entries[0]
    if (
        re.fullmatch(r"[0-9a-f]{32}", stage.name) is None
        or _is_link_or_reparse(stage)
        or not stage.is_dir()
    ):
        raise PrepareError("retained preparation stage is unsafe")
    _assert_no_reparse_tree(stage, "retained preparation stage")
    publish = stage / "publish"
    if _is_link_or_reparse(publish) or not publish.is_dir():
        raise PrepareError("retained preparation stage is incomplete")
    try:
        drive_manifest = load_drive_manifest(publish)
    except (OSError, ValueError) as error:
        raise PrepareError("retained preparation stage is incomplete") from error
    if (
        drive_manifest.drive_id != config.drive_id
        or drive_manifest.release_id != config.release_id
        or len(drive_manifest.components) != 1
        or drive_manifest.components[0].component_id != config.component_id
    ):
        raise PrepareError(
            "retained preparation stage does not match the requested release"
        )
    return stage


def _remove_prepare_stage(stage: Path, drive: Path) -> None:
    expected_parent = drive / ".medos-setup" / "staging"
    if stage.parent != expected_parent or re.fullmatch(r"[0-9a-f]{32}", stage.name) is None:
        raise PrepareError("refusing to clean an untrusted preparation staging path")
    if not _path_lexists(stage):
        return
    _assert_no_reparse_tree(stage, "preparation staging tree")

    def retry_dos_readonly(
        function: Callable[[str], None],
        raw_path: str,
        error: BaseException,
    ) -> None:
        if os.name != "nt" or not isinstance(error, PermissionError):
            raise error
        candidate = _lexical_absolute(Path(raw_path))
        try:
            candidate.relative_to(stage)
        except ValueError:
            raise error
        _assert_no_reparse_tree(stage, "preparation staging tree")
        _assert_no_reparse_chain(candidate, "read-only preparation staging entry")
        try:
            before = candidate.lstat()
        except OSError:
            raise error
        attributes = getattr(before, "st_file_attributes", 0)
        if (
            _is_link_or_reparse(candidate)
            or not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or not attributes & stat.FILE_ATTRIBUTE_READONLY
        ):
            raise error
        identity = (before.st_dev, before.st_ino, before.st_nlink)
        _windows_clear_readonly_retained(candidate, before)
        _assert_no_reparse_tree(stage, "preparation staging tree")
        _assert_no_reparse_chain(candidate, "read-only preparation staging entry")
        try:
            after = candidate.lstat()
        except OSError:
            raise error
        if (
            _is_link_or_reparse(candidate)
            or (after.st_dev, after.st_ino, after.st_nlink) != identity
            or getattr(after, "st_file_attributes", 0)
            & stat.FILE_ATTRIBUTE_READONLY
        ):
            raise PrepareError("read-only preparation staging entry changed during cleanup")
        function(raw_path)

    shutil.rmtree(stage, onexc=retry_dos_readonly)
    if _path_lexists(stage):
        raise OSError("preparation staging directory remained after cleanup")


def _write_recovery_marker(stage: Path, cleanup_error: BaseException) -> Path:
    staging_parent = stage.parent
    if _path_lexists(stage) and stage.is_dir() and not _is_link_or_reparse(stage):
        marker = stage / "RECOVERY.json"
    else:
        marker = staging_parent / f"RECOVERY-{stage.name}.json"
    _assert_existing_no_reparse_chain(marker.parent, "recovery marker parent")
    marker.parent.mkdir(parents=True, exist_ok=True)
    _assert_no_reparse_chain(marker.parent, "recovery marker parent")
    content = canonical_json_bytes(
        {
            "schema_version": 1,
            "kind": "prepare-staging-recovery",
            "staging_path": str(stage),
            "cleanup_error": {
                "type": type(cleanup_error).__name__,
                "message": str(cleanup_error),
            },
        }
    )
    try:
        with marker.open("xb") as stream:
            stream.write(content)
    except OSError as error:
        raise PrepareError("cannot create preparation recovery marker") from error
    return marker


def _report_cleanup_failure(
    primary_error: BaseException | None,
    cleanup_error: BaseException,
    stage: Path,
) -> None:
    marker: Path | None = None
    marker_error: BaseException | None = None
    try:
        marker = _write_recovery_marker(stage, cleanup_error)
    except BaseException as error:
        if primary_error is None and isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        marker_error = error
    retained = (
        f"cleanup failed ({type(cleanup_error).__name__}: {cleanup_error}); "
        f"retained staging path: {stage}"
    )
    if marker is not None:
        retained += f"; recovery marker: {marker}"
    if primary_error is not None:
        primary_error.add_note(retained)
        if marker_error is not None:
            primary_error.add_note(
                "recovery marker creation also failed: "
                f"{_exception_detail(marker_error)}"
            )
        return
    error = PrepareError(retained)
    if marker_error is not None:
        error.add_note(
            "recovery marker creation also failed: "
            f"{_exception_detail(marker_error)}"
        )
    raise error from cleanup_error


def _is_retained_prepare_shell(root: Path) -> bool:
    try:
        root_entries = list(root.iterdir())
        if len(root_entries) != 1 or root_entries[0].name != ".medos-setup":
            return False
        setup_root = root_entries[0]
        if _is_link_or_reparse(setup_root) or not setup_root.is_dir():
            return False
        setup_entries = list(setup_root.iterdir())
        if len(setup_entries) != 1 or setup_entries[0].name != "staging":
            return False
        staging = setup_entries[0]
        if _is_link_or_reparse(staging) or not staging.is_dir():
            return False
        stages = list(staging.iterdir())
        return bool(stages) and all(
            re.fullmatch(r"[0-9a-f]{32}", item.name) is not None
            and not _is_link_or_reparse(item)
            and item.is_dir()
            for item in stages
        )
    except OSError:
        return False


def _validate_config(config: PrepareConfig) -> tuple[Path, Path, Path, Path, Path, bool]:
    for name, value in (
        ("drive ID", config.drive_id),
        ("release ID", config.release_id),
        ("component ID", config.component_id),
    ):
        if not isinstance(value, str) or _IDENTIFIER_RE.fullmatch(value) is None:
            raise PrepareError(f"{name} must be a safe lowercase release identifier")
    source = _resolved_directory(config.source_root, "source root")
    mac_tools = _resolved_directory(config.mac_tools_root, "macOS runtime root")
    apk = _resolved_file(config.apk_path, "Android APK")
    phone_data = _resolved_file(config.phone_data_zip, "phone data ZIP")
    drive_input = Path(config.drive_root).expanduser()
    if config.release_stage_manifest is not None:
        drive_input = _lexical_absolute(drive_input)
        _assert_existing_no_reparse_chain(drive_input, "prepared output")
    drive = drive_input.resolve(strict=False)
    direct = drive == source
    if config.release_stage_manifest is not None and _overlap(drive, source):
        raise PrepareError(
            "release-stage output must be disjoint from the live source root"
        )
    if not direct:
        directory_sources_overlap = any(
            _overlap(drive, item) for item in (source, mac_tools)
        )
        file_source_would_be_overwritten = any(
            _common(drive, item) == drive for item in (apk, phone_data)
        )
        if directory_sources_overlap or file_source_would_be_overwritten:
            raise PrepareError("clean output must not overlap any source root")
        if drive.exists():
            if not drive.is_dir() or drive.is_symlink():
                raise PrepareError("clean output must be a regular directory")
            try:
                nonempty = next(drive.iterdir(), None) is not None
            except OSError as error:
                raise PrepareError("cannot inspect clean output") from error
            marker = drive / "setup-drive.json"
            if (
                nonempty
                and not marker.is_file()
                and not _is_retained_prepare_shell(drive)
            ):
                raise PrepareError("refusing a non-empty output that is not a MedOS Setup Drive")
            if marker.is_file():
                try:
                    existing = json.loads(marker.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError) as error:
                    raise PrepareError("existing clean output marker is invalid") from error
                if not isinstance(existing, dict) or existing.get("drive_id") != config.drive_id:
                    raise PrepareError("existing clean output belongs to a different Setup Drive")
    return source, drive, mac_tools, apk, phone_data, direct


def _excluded_file(path: Path, *, allow_zip: bool) -> bool:
    lowered = path.name.casefold()
    if lowered in _EXCLUDED_NAMES or lowered.startswith(".env."):
        return True
    for suffix in _EXCLUDED_SUFFIXES:
        if lowered.endswith(suffix) and not (allow_zip and suffix == ".zip"):
            return True
    return False


def _walk_files(root: Path, *, allow_zip: bool = False) -> Iterable[Path]:
    if not root.is_dir() or root.is_symlink():
        raise PrepareError(f"required release directory is unavailable: {root}")
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        current = Path(directory)
        kept: list[str] = []
        for name in sorted(names, key=str.casefold):
            candidate = current / name
            if name.casefold() in _EXCLUDED_DIRECTORIES or candidate.is_symlink():
                continue
            kept.append(name)
        names[:] = kept
        for name in sorted(files, key=str.casefold):
            candidate = current / name
            if candidate.is_symlink() or _excluded_file(candidate, allow_zip=allow_zip):
                continue
            if not candidate.is_file():
                raise PrepareError(f"release source is not a regular file: {candidate}")
            yield candidate


def _walk_payload_files(
    root: Path,
    *,
    excluded_names: Iterable[str],
    excluded_suffixes: Iterable[str],
    excluded_directories: Iterable[str],
) -> Iterable[Path]:
    names_to_skip = {value.casefold() for value in excluded_names}
    suffixes_to_skip = tuple(value.casefold() for value in excluded_suffixes)
    directories_to_skip = {
        value.casefold() for value in excluded_directories
    } | set(_EXCLUDED_DIRECTORIES)
    if root.is_file() and not root.is_symlink():
        lowered = root.name.casefold()
        if (
            lowered not in names_to_skip
            and not lowered.endswith(suffixes_to_skip)
            and not _excluded_file(root, allow_zip=False)
        ):
            yield root
        return
    if not root.is_dir() or root.is_symlink():
        raise PrepareError(f"canonical release source is unavailable: {root}")
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        current = Path(directory)
        names[:] = [
            name
            for name in sorted(names, key=str.casefold)
            if name.casefold() not in directories_to_skip
            and not (current / name).is_symlink()
        ]
        for name in sorted(files, key=str.casefold):
            candidate = current / name
            lowered = name.casefold()
            if (
                candidate.is_symlink()
                or lowered in names_to_skip
                or lowered.endswith(suffixes_to_skip)
                or _excluded_file(candidate, allow_zip=False)
            ):
                continue
            if not candidate.is_file():
                raise PrepareError(f"canonical release source is not a file: {candidate}")
            yield candidate


def _record(
    path: Path,
    *,
    source_root: Path,
    target: PurePosixPath,
    role: str,
    platform: str,
    mutable: bool,
    source_override: PurePosixPath | None = None,
    portable_copy: bool = False,
    source_identity: tuple[int, int, int, int] | None = None,
    source_containment: Path | None = None,
    release_stage_override: bool = False,
) -> _InventoryFile:
    relative = source_override or PurePosixPath(path.relative_to(source_root).as_posix())
    _validate_inventory_paths(relative, target)
    try:
        size = path.stat().st_size
        digest = sha256_file(path)
    except OSError as error:
        raise PrepareError(f"cannot inventory release source: {path}") from error
    return _InventoryFile(
        FileRecord(
            source=relative,
            target=target,
            size=size,
            sha256=digest,
            role=role,
            platform=platform,
            mutable=mutable,
            required=True,
        ),
        path,
        portable_copy,
        source_identity,
        source_containment,
        release_stage_override,
    )


def _validate_inventory_paths(source: PurePosixPath, target: PurePosixPath) -> None:
    if target.parts[:2] == _BOOKS_ROOT and PurePosixPath(*target.parts[2:]) in LEGACY_BOOK_RENAMES:
        raise PrepareError(
            "legacy book path cannot be prepared directly; build a verified portable "
            "release stage before preparing the release"
        )
    for field, value in (("inventory source", source), ("inventory target", target)):
        try:
            portable_relative_path(value, field)
        except PortablePathError as error:
            raise PrepareError(str(error)) from error


def _source_inventory(
    source: Path,
    *,
    omit_release_stage_targets: bool = False,
    relocated_data_root: Path | None = None,
) -> list[_InventoryFile]:
    inventory: list[_InventoryFile] = []

    def required_file(relative: str, *, platform: str = "all", role: str = "launcher") -> None:
        path = source / Path(relative)
        if not path.is_file() or path.is_symlink():
            raise PrepareError(f"required release file is unavailable: {relative}")
        inventory.append(
            _record(
                path,
                source_root=source,
                target=PurePosixPath(relative.replace("\\", "/")),
                role=role,
                platform=platform,
                mutable=False,
            )
        )

    for name in ("START.bat", "STOP.bat", "START.ps1", "STOP.ps1"):
        required_file(name, platform="windows")
    for name in ("mac/start.sh", "mac/stop.sh"):
        required_file(name, platform="macos")
    for name in (
        "app/START.ps1",
        "app/Set-MedOSNetworkAccess.ps1",
        "app/medos_server.mjs",
        "app/package.json",
        "app/package-lock.json",
        "app/status_server.py",
        "app/.next/BUILD_ID",
        "app/.next/.medos-shipped",
    ):
        required_file(name, role="runtime")

    roots = (
        ("app/.next", "runtime", "all", False, False),
        ("app/node_modules", "runtime", "all", False, True),
        ("app/backend", "runtime", "all", False, False),
        ("app/public", "runtime", "all", False, False),
        ("tools/python", "runtime", "windows", False, True),
        ("tools/node", "runtime", "windows", False, True),
    )
    existing_targets = {
        portable_path_key(item.record.target): item.record.target for item in inventory
    }
    for relative, role, platform, mutable, allow_zip in roots:
        root = source / Path(relative)
        for path in _walk_files(root, allow_zip=allow_zip):
            target = PurePosixPath(path.relative_to(source).as_posix())
            if omit_release_stage_targets and _is_release_stage_target(target):
                continue
            key = portable_path_key(target)
            if existing_targets.get(key) == target:
                continue
            inventory.append(
                _record(
                    path,
                    source_root=source,
                    target=target,
                    role=role,
                    platform=platform,
                    mutable=mutable,
                )
            )
            existing_targets.setdefault(key, target)
    pack_map = source / "app" / "backend" / "pack_paths.py"
    if pack_map.is_file() and not pack_map.is_symlink():
        books = source / "data" / "books"
        if not books.is_dir() or (
            _is_link_or_reparse(books) and not omit_release_stage_targets
        ):
            raise PrepareError("canonical desktop books source is unavailable")
        try:
            from tools.release import universal_release
        except ImportError as error:
            raise PrepareError("canonical desktop release inventory support is unavailable") from error
        try:
            payload_sources = universal_release.discover_payload_sources(
                source,
                books,
                relocated_data_root=relocated_data_root,
            )
        except (
            OSError,
            universal_release.ReleaseError,
            TypeError,
            ValueError,
        ) as error:
            raise PrepareError("canonical desktop release inventory is invalid") from error
        for payload in payload_sources:
            destination = PurePosixPath(payload.destination)
            role = "model" if destination.parts[0] == "models" else "data"
            for path in _walk_payload_files(
                payload.source,
                excluded_names=payload.excluded_names,
                excluded_suffixes=payload.excluded_suffixes,
                excluded_directories=payload.excluded_directory_names,
            ):
                relative = PurePosixPath() if payload.source.is_file() else PurePosixPath(
                    path.relative_to(payload.source).as_posix()
                )
                target = destination if not relative.parts else destination / relative
                if omit_release_stage_targets and _is_release_stage_target(target):
                    continue
                portable_copy = not path.is_relative_to(source)
                source_path = (
                    _PORTABLE_EXTERNAL_ROOT / target if portable_copy else target
                )
                inventory.append(
                    _record(
                        path,
                        source_root=source,
                        source_override=source_path,
                        target=target,
                        role=role,
                        platform="all",
                        mutable=False,
                        portable_copy=portable_copy,
                    )
                )
    else:
        for optional_root, role in (("data", "data"), ("models", "model")):
            root = source / optional_root
            if not root.is_dir() or root.is_symlink():
                continue
            for path in _walk_files(root):
                target = PurePosixPath(path.relative_to(source).as_posix())
                if omit_release_stage_targets and _is_release_stage_target(target):
                    continue
                inventory.append(
                    _record(
                        path,
                        source_root=source,
                        target=target,
                        role=role,
                        platform="all",
                        mutable=False,
                    )
                )
    return inventory


def _copy_tree(source: Path, destination: Path, *, allow_zip: bool = True) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for path in _walk_files(source, allow_zip=allow_zip):
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copyfile(path, target)
        except OSError as error:
            raise PrepareError(f"cannot stage release file: {path}") from error


def _stage_portable_external_payload(
    inventory: list[_InventoryFile],
    *,
    publish: Path,
    drive: Path,
    release_stage: _ReleaseStageOverride | None = None,
) -> tuple[Path | None, frozenset[PurePosixPath]]:
    selected = [item for item in inventory if item.portable_copy]
    if not selected:
        return None, frozenset()
    destination_root = publish / Path(*_PORTABLE_EXTERNAL_ROOT.parts)
    verified_sources: set[PurePosixPath] = set()
    for item in selected:
        if item.release_stage_override:
            if release_stage is None:
                raise PrepareError("release stage receipt lease is unavailable")
            release_stage.receipt_lease.assert_bound()
        if item.source_identity is not None:
            _revalidate_inventory_source(item)
        destination = publish / Path(*item.record.source.parts)
        _assert_existing_no_reparse_chain(
            destination.parent,
            "temporary release stage destination",
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        existing = drive / Path(*item.record.source.parts)
        reused = False
        if not item.release_stage_override:
            try:
                _assert_no_reparse_chain(existing.parent, "existing prepared payload")
                resolved_parent = existing.parent.resolve(strict=True)
                resolved_parent.relative_to(drive)
                if (
                    not _is_link_or_reparse(existing)
                    and existing.is_file()
                    and existing.stat().st_size == item.record.size
                    and sha256_file(existing) == item.record.sha256
                ):
                    os.link(existing, destination)
                    reused = True
            except (OSError, ValueError, PrepareError):
                reused = False
        if reused:
            verified_sources.add(item.record.source)
            continue
        try:
            destination_lease = _hold_directory_chain(
                destination.parent,
                "temporary release stage destination parent",
            )
            copy_error: BaseException | None = None
            try:
                shutil.copyfile(item.source_path, destination)
            except BaseException as error:
                copy_error = error
                raise
            finally:
                _cleanup_preserving_primary(
                    copy_error,
                    (destination_lease.close,),
                    "temporary destination lease cleanup failed",
                )
        except OSError as error:
            wrapped = PrepareError(
                f"cannot materialize external release source: {item.record.target}"
            )
            for note in getattr(error, "__notes__", ()):
                wrapped.add_note(note)
            raise wrapped from error
        if item.source_identity is not None:
            _revalidate_inventory_source(item)
            _assert_independent_release_copy(item, destination)
            verified_sources.add(item.record.source)
    return destination_root, frozenset(verified_sources)


def _existing_artifact_copier(drive: Path, relative_root: PurePosixPath):
    existing_root = drive / Path(*relative_root.parts)

    def copy(source: Path, destination: Path) -> object:
        existing = existing_root / destination.name
        try:
            resolved_parent = existing.parent.resolve(strict=True)
            resolved_parent.relative_to(drive)
            if (
                not _is_link_or_reparse(existing)
                and existing.is_file()
                and existing.stat().st_size == source.stat().st_size
            ):
                expected = sha256_file(source)
                if sha256_file(existing) == expected:
                    os.link(existing, destination)
                    if sha256_file(destination) == expected:
                        return destination
                    destination.unlink(missing_ok=True)
        except (OSError, ValueError):
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                pass
        return shutil.copyfile(source, destination)

    return copy


def _mac_payload_inventory(mac_tools: Path) -> list[_InventoryFile]:
    inventory: list[_InventoryFile] = []
    for architecture in ("arm64", "x64"):
        source_arch = mac_tools / architecture
        for required in ("python/bin/python3", "node/bin/node"):
            if not (source_arch / Path(required)).is_file():
                raise PrepareError(f"{architecture} macOS runtime is missing {required}")
        for path in _walk_files(source_arch, allow_zip=True):
            relative_arch = PurePosixPath(path.relative_to(source_arch).as_posix())
            _validate_inventory_paths(
                PurePosixPath(".medos-payload/mac-tools") / architecture / relative_arch,
                PurePosixPath("mac-tools") / architecture / relative_arch,
            )
            inventory.append(
                _record(
                    path,
                    source_root=mac_tools,
                    source_override=PurePosixPath(".medos-payload/mac-tools") / architecture / relative_arch,
                    target=PurePosixPath("mac-tools") / architecture / relative_arch,
                    role="runtime",
                    platform=f"macos-{architecture}",
                    mutable=False,
                )
            )
    return inventory


def _stage_mac_payload(mac_tools: Path, destination: Path) -> list[_InventoryFile]:
    inventory = _mac_payload_inventory(mac_tools)
    for architecture in ("arm64", "x64"):
        _copy_tree(
            mac_tools / architecture,
            destination / architecture,
            allow_zip=True,
        )
    return inventory


def _replace_resumed_staged_file(item: _InventoryFile, destination: Path) -> None:
    _assert_existing_no_reparse_chain(
        destination.parent,
        "resumed staged payload parent",
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    _assert_no_reparse_chain(destination.parent, "resumed staged payload parent")
    if _path_lexists(destination) and (
        _is_link_or_reparse(destination) or not destination.is_file()
    ):
        raise PrepareError(
            f"resumed staged component source is unsafe: {item.record.source}"
        )
    if item.source_identity is not None:
        _revalidate_inventory_source(item)
    lease = _hold_directory_chain(
        destination.parent,
        "resumed staged payload parent",
    )
    temporary = destination.with_name(f".{destination.name}.resume-{uuid.uuid4().hex}.tmp")
    primary_error: BaseException | None = None
    try:
        if _path_lexists(temporary):
            raise PrepareError("resumed staged payload temporary path already exists")
        shutil.copyfile(item.source_path, temporary)
        if (
            temporary.stat().st_size != item.record.size
            or sha256_file(temporary) != item.record.sha256
        ):
            raise PrepareError(
                f"resumed staged component source differs: {item.record.source}"
            )
        if item.source_identity is not None:
            _revalidate_inventory_source(item)
        os.replace(temporary, destination)
    except BaseException as error:
        primary_error = error
        raise
    finally:
        def remove_temporary() -> None:
            temporary.unlink(missing_ok=True)

        _cleanup_preserving_primary(
            primary_error,
            (remove_temporary, lease.close),
            "resumed staged payload cleanup failed",
        )


def _remove_resumed_staged_file(destination: Path) -> None:
    _assert_existing_no_reparse_chain(
        destination.parent,
        "resumed staged payload parent",
    )
    if not _path_lexists(destination):
        return
    _assert_no_reparse_chain(destination.parent, "resumed staged payload parent")
    if _is_link_or_reparse(destination) or not destination.is_file():
        raise PrepareError("resumed staged component contains an unsafe obsolete source")
    lease = _hold_directory_chain(
        destination.parent,
        "resumed staged payload parent",
    )
    primary_error: BaseException | None = None
    try:
        if _is_link_or_reparse(destination) or not destination.is_file():
            raise PrepareError(
                "resumed staged component contains an unsafe obsolete source"
            )
        destination.unlink()
    except BaseException as error:
        primary_error = error
        raise
    finally:
        _cleanup_preserving_primary(
            primary_error,
            (lease.close,),
            "resumed staged payload cleanup failed",
        )


def _reconcile_resumed_tree(source: Path, destination: Path) -> None:
    source_files = {
        path.relative_to(source): path
        for path in _walk_files(source, allow_zip=True)
    }
    destination_files = {
        path.relative_to(destination): path
        for path in _walk_files(destination, allow_zip=True)
    }
    if set(source_files) != set(destination_files):
        raise PrepareError(
            "retained setup payload layout differs from the current installer"
        )
    for relative, source_path in source_files.items():
        target = destination_files[relative]
        record = _record(
            source_path,
            source_root=source,
            source_override=PurePosixPath(relative.as_posix()),
            target=PurePosixPath(relative.as_posix()),
            role="installer",
            platform="all",
            mutable=False,
        )
        if (
            target.stat().st_size != record.record.size
            or sha256_file(target) != record.record.sha256
        ):
            _replace_resumed_staged_file(record, target)


def _reconcile_resumed_component(
    *,
    publish: Path,
    config: PrepareConfig,
    inventory: list[_InventoryFile],
) -> tuple[Path, Path, Path, Path]:
    drive_manifest_path = publish / "setup-drive.json"
    drive_manifest = load_drive_manifest(publish)
    reference = drive_manifest.components[0]
    expected_manifest = PurePosixPath(
        f".medos-setup/manifests/{config.component_id}.manifest.json"
    )
    if reference.manifest != expected_manifest:
        raise PrepareError("retained component manifest path is unexpected")
    component = publish / Path(*reference.manifest.parts)
    previous = load_component_manifest(component)
    previous_by_source = {record.source: record for record in previous.files}
    if len(previous_by_source) != len(previous.files):
        raise PrepareError("retained preparation inventory has source collisions")
    current_by_source = {item.record.source: item for item in inventory}

    for source_path in previous_by_source.keys() - current_by_source.keys():
        _remove_resumed_staged_file(
            publish / Path(*source_path.parts),
        )

    for item in inventory:
        previous_record = previous_by_source.get(item.record.source)
        if previous_record is None or (
            previous_record.size != item.record.size
            or previous_record.sha256 != item.record.sha256
        ):
            _replace_resumed_staged_file(
                item,
                publish / Path(*item.record.source.parts),
            )

    _write(component, _component_bytes(config.component_id, inventory))
    component_sidecar = _sidecar(component)
    _write(
        drive_manifest_path,
        canonical_json_bytes(
            {
                "schema_version": 1,
                "drive_id": config.drive_id,
                "release_id": config.release_id,
                "setup_center_version": __version__,
                "components": [
                    {
                        "component_id": config.component_id,
                        "manifest": reference.manifest.as_posix(),
                        "sha256": sha256_file(component),
                    }
                ],
            }
        ),
    )
    drive_sidecar = _sidecar(drive_manifest_path)
    load_drive_manifest(publish)
    return component, component_sidecar, drive_manifest_path, drive_sidecar


def _assert_resumed_android_inputs(report, *, apk: Path, phone_data: Path) -> None:
    by_kind = {artifact.kind: artifact for artifact in report.artifacts}
    for kind, source in (("apk", apk), ("data", phone_data)):
        artifact = by_kind.get(kind)
        if artifact is None or (
            artifact.size != source.stat().st_size
            or artifact.sha256 != sha256_file(source)
        ):
            raise PrepareError(
                "retained Android payload differs from the current release inputs"
            )


def _reject_inventory_collisions(inventory: list[_InventoryFile]) -> None:
    for field in ("source", "target"):
        seen: dict[str, PurePosixPath] = {}
        for item in inventory:
            value = getattr(item.record, field)
            folded = portable_path_key(value)
            if folded in seen:
                raise PrepareError(f"release {field} path collision: {seen[folded]} and {value}")
            seen[folded] = value


def _component_bytes(component_id: str, inventory: list[_InventoryFile]) -> bytes:
    files = []
    for item in sorted(inventory, key=lambda value: value.record.target.as_posix().casefold()):
        record = item.record
        files.append(
            {
                "source": record.source.as_posix(),
                "target": record.target.as_posix(),
                "size": record.size,
                "sha256": record.sha256,
                "role": record.role,
                "platform": record.platform,
                "mutable": record.mutable,
                "required": record.required,
            }
        )
    return canonical_json_bytes(
        {"schema_version": 1, "component_id": component_id, "files": files}
    )


def _write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.write_bytes(content)
    except OSError as error:
        raise PrepareError(f"cannot stage preparation artifact: {path.name}") from error


def _sidecar(path: Path) -> Path:
    digest = sha256_file(path)
    sidecar = path.with_name(path.name + ".sha256")
    _write(sidecar, f"{digest}  {path.name}\n".encode("ascii"))
    return sidecar


def _tree_measure(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    files: list[Path] = []
    for directory, names, filenames in os.walk(path, topdown=True, followlinks=False):
        current = Path(directory)
        for name in names:
            if _is_link_or_reparse(current / name):
                raise PrepareError(f"artifact contains an unsafe entry: {current / name}")
        names[:] = sorted(names, key=str.casefold)
        for name in filenames:
            item = current / name
            if _is_link_or_reparse(item) or not item.is_file():
                raise PrepareError(f"artifact contains an unsafe entry: {item}")
            files.append(item)
    for item in sorted(files, key=lambda value: value.relative_to(path).as_posix().casefold()):
        relative = item.relative_to(path).as_posix()
        size = item.stat().st_size
        file_digest = sha256_file(item)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(file_digest))
        total += size
    return total, digest.hexdigest()


def _measure(path: Path) -> tuple[int, str]:
    if _is_link_or_reparse(path):
        raise PrepareError(f"staged artifact is unsafe: {path}")
    if path.is_file():
        return path.stat().st_size, sha256_file(path)
    if path.is_dir():
        return _tree_measure(path)
    raise PrepareError(f"staged artifact is missing: {path}")


def _measure_inventory_tree(
    root: PurePosixPath,
    inventory: Iterable[_InventoryFile],
) -> tuple[int, str]:
    """Derive a tree measurement from file records whose bytes were verified."""

    rows: list[tuple[PurePosixPath, int, str]] = []
    for item in inventory:
        try:
            relative = item.record.source.relative_to(root)
        except ValueError:
            continue
        if not relative.parts:
            raise PrepareError(f"inventory tree contains a non-file root record: {root}")
        rows.append((relative, item.record.size, item.record.sha256))
    if not rows:
        raise PrepareError(f"inventory tree is empty: {root}")
    digest = hashlib.sha256()
    total = 0
    for relative, size, file_digest in sorted(
        rows,
        key=lambda row: row[0].as_posix().casefold(),
    ):
        digest.update(relative.as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(file_digest))
        total += size
    return total, digest.hexdigest()


def _report_object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise PrepareError(f"preparation report contains a duplicate field: {key}")
        result[key] = value
    return result


def _report_relative_path(value: object) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise PrepareError("preparation report contains an unsafe artifact path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.as_posix() != value or any(
        part in {"", ".", ".."} or ":" in part for part in path.parts
    ):
        raise PrepareError("preparation report contains an unsafe artifact path")
    return path


def _release_stage_evidence(
    override: _ReleaseStageOverride,
    publish: Path,
    *,
    copy_verified_sources: frozenset[PurePosixPath] = frozenset(),
) -> dict[str, object]:
    override.receipt_lease.assert_bound()
    rows: list[dict[str, object]] = []
    for item in sorted(
        override.inventory,
        key=lambda value: value.record.target.as_posix(),
    ):
        destination = publish / Path(*item.record.source.parts)
        device, file_id, link_count = _assert_independent_release_copy(
            item,
            destination,
            verify_digest=item.record.source not in copy_verified_sources,
        )
        if item.source_identity is None:
            raise PrepareError("release stage source identity evidence is unavailable")
        rows.append(
            {
                "source": item.record.source.as_posix(),
                "target": item.record.target.as_posix(),
                "size": item.record.size,
                "sha256": item.record.sha256,
                "device": device,
                "file_id": file_id,
                "link_count": link_count,
                "stage_device": item.source_identity[2],
                "stage_file_id": item.source_identity[3],
            }
        )
    return {
        "receipt_sha256": hashlib.sha256(
            override.receipt_lease.manifest.content
        ).hexdigest(),
        "sidecar_sha256": hashlib.sha256(
            override.receipt_lease.sidecar.content
        ).hexdigest(),
        "overrides": rows,
    }


def _verify_release_stage_evidence(
    root: Path,
    report: dict[str, object],
    *,
    component=None,
    checkpoint: Callable[[], None] | None = None,
) -> None:
    evidence = report.get("release_stage")
    if evidence is None:
        return
    if type(evidence) is not dict or set(evidence) != {
        "receipt_sha256",
        "sidecar_sha256",
        "overrides",
    }:
        raise PrepareError("preparation report release stage evidence is invalid")
    for field in ("receipt_sha256", "sidecar_sha256"):
        if (
            type(evidence[field]) is not str
            or re.fullmatch(r"[0-9a-f]{64}", evidence[field]) is None
        ):
            raise PrepareError("preparation report release stage digest is invalid")
    rows = evidence["overrides"]
    if type(rows) is not list or not (4 <= len(rows) <= 10_000):
        raise PrepareError("preparation report release stage inventory is invalid")
    component_id = report["component_id"]
    if type(component_id) is not str or _IDENTIFIER_RE.fullmatch(component_id) is None:
        raise PrepareError("preparation report component ID is invalid")
    component = component or load_component_manifest(
        root / ".medos-setup" / "manifests" / f"{component_id}.manifest.json",
        checkpoint=checkpoint,
    )
    expected = {}
    for index, item in enumerate(component.files):
        if checkpoint is not None and index % 1024 == 0:
            checkpoint()
        if _is_release_stage_target(item.target):
            expected[item.target.as_posix()] = item
    observed: set[str] = set()
    for row in rows:
        if checkpoint is not None:
            checkpoint()
        if type(row) is not dict or set(row) != {
            "source",
            "target",
            "size",
            "sha256",
            "device",
            "file_id",
            "link_count",
            "stage_device",
            "stage_file_id",
        }:
            raise PrepareError("preparation report release stage entry is invalid")
        source = _report_relative_path(row["source"])
        target = _report_relative_path(row["target"])
        target_key = target.as_posix()
        record = expected.get(target_key)
        if target_key in observed or record is None:
            raise PrepareError("preparation report release stage inventory differs")
        observed.add(target_key)
        for field in (
            "size",
            "device",
            "file_id",
            "link_count",
            "stage_device",
            "stage_file_id",
        ):
            if type(row[field]) is not int or row[field] < 0:
                raise PrepareError("preparation report release stage identity is invalid")
        if (
            type(row["sha256"]) is not str
            or re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is None
            or source != record.source
            or row["size"] != record.size
            or row["sha256"] != record.sha256
            or row["link_count"] != 1
        ):
            raise PrepareError("preparation report release stage entry differs")
        candidate = root / Path(*source.parts)
        _assert_no_reparse_chain(candidate, "prepared release stage override")
        try:
            candidate.resolve(strict=True).relative_to(root)
            info = candidate.lstat()
        except (OSError, ValueError) as error:
            raise PrepareError("prepared release stage override is unsafe") from error
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_size != row["size"]
            or info.st_dev != row["device"]
            or info.st_ino != row["file_id"]
            or info.st_nlink != 1
            or (info.st_dev, info.st_ino)
            == (row["stage_device"], row["stage_file_id"])
        ):
            raise PrepareError(
                f"prepared release stage override is not independent: {target}"
            )
    if observed != set(expected):
        raise PrepareError("preparation report release stage inventory is incomplete")


def load_prepared_artifact_inventory(
    drive_root: Path,
    *,
    drive=None,
) -> tuple[dict[str, object], tuple[dict[str, object], ...]]:
    """Load only bounded preparation metadata; do not hash artifact payloads."""

    root_input = _lexical_absolute(Path(drive_root))
    _assert_no_reparse_chain(root_input, "prepared drive")
    root = root_input.resolve(strict=True)
    report_path = root / ".medos-setup" / "preparation-report.json"
    _assert_no_reparse_chain(report_path, "preparation report")
    try:
        if report_path.stat().st_size > 8 * 1024 * 1024:
            raise PrepareError("preparation report is unexpectedly large")
        report = json.loads(
            report_path.read_text(encoding="utf-8"),
            object_pairs_hook=_report_object_pairs,
        )
    except PrepareError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PrepareError("preparation report is unavailable or invalid") from error
    required_fields = {
        "schema_version",
        "drive_id",
        "release_id",
        "component_id",
        "component_file_count",
        "component_bytes",
        "artifacts",
        "authenticity_note",
    }
    optional_fields = {"release_stage", "release_features"}
    if (
        not isinstance(report, dict)
        or not required_fields.issubset(report)
        or not set(report).issubset(required_fields | optional_fields)
    ):
        raise PrepareError("preparation report fields are invalid")
    if report["schema_version"] != 1:
        raise PrepareError("preparation report schema is unsupported")
    drive = drive or load_drive_manifest(root)
    if report["drive_id"] != drive.drive_id or report["release_id"] != drive.release_id:
        raise PrepareError("preparation report does not match this drive")
    features = report.get("release_features")
    if features is not None and (
        not isinstance(features, dict)
        or set(features)
        != {
            "missing_features",
            "missing_packs",
            "incomplete_packs",
            "mac_architectures",
            "portable_activation",
            "shortcut_count",
        }
        or features["missing_features"] != []
        or features["missing_packs"] != []
        or features["incomplete_packs"] != []
        or features["mac_architectures"] != ["arm64", "x64"]
        or features["portable_activation"] is not True
        or features["shortcut_count"] != 1
    ):
        raise PrepareError("preparation report release features are invalid")
    artifacts = report["artifacts"]
    if not isinstance(artifacts, list) or not (1 <= len(artifacts) <= 10_000):
        raise PrepareError("preparation report artifact list is invalid")
    seen: set[str] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict) or set(artifact) != {"path", "kind", "size", "sha256"}:
            raise PrepareError("preparation report artifact entry is invalid")
        relative = _report_relative_path(artifact["path"])
        folded = relative.as_posix().casefold()
        if folded in seen:
            raise PrepareError(f"preparation report path collision: {relative}")
        seen.add(folded)
        kind = artifact["kind"]
        size = artifact["size"]
        digest = artifact["sha256"]
        if not isinstance(kind, str) or not kind or len(kind) > 64:
            raise PrepareError(f"preparation report kind is invalid: {relative}")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise PrepareError(f"preparation report size is invalid: {relative}")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise PrepareError(f"preparation report hash is invalid: {relative}")
    return report, tuple(artifacts)


def _hash_with_progress(
    path: Path,
    *,
    on_bytes: Callable[[int], None] | None,
    checkpoint: Callable[[], None] | None,
    chunk_size: int = 1024 * 1024,
) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            if checkpoint is not None:
                checkpoint()
            digest.update(chunk)
            if on_bytes is not None:
                on_bytes(len(chunk))
    return digest.hexdigest()


def _measure_with_progress(
    path: Path,
    *,
    on_bytes: Callable[[int], None] | None,
    checkpoint: Callable[[], None] | None,
) -> tuple[int, str]:
    if _is_link_or_reparse(path):
        raise PrepareError(f"staged artifact is unsafe: {path}")
    if path.is_file():
        return path.stat().st_size, _hash_with_progress(
            path,
            on_bytes=on_bytes,
            checkpoint=checkpoint,
        )
    if not path.is_dir():
        raise PrepareError(f"staged artifact is missing: {path}")
    digest = hashlib.sha256()
    total = 0
    files: list[Path] = []
    for directory, names, filenames in os.walk(path, topdown=True, followlinks=False):
        if checkpoint is not None:
            checkpoint()
        current = Path(directory)
        for name in names:
            if _is_link_or_reparse(current / name):
                raise PrepareError(f"artifact contains an unsafe entry: {current / name}")
        names[:] = sorted(names, key=str.casefold)
        for name in filenames:
            item = current / name
            if _is_link_or_reparse(item) or not item.is_file():
                raise PrepareError(f"artifact contains an unsafe entry: {item}")
            files.append(item)
    for item in sorted(files, key=lambda value: value.relative_to(path).as_posix().casefold()):
        relative = item.relative_to(path).as_posix()
        size = item.stat().st_size
        file_digest = _hash_with_progress(
            item,
            on_bytes=on_bytes,
            checkpoint=checkpoint,
        )
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(file_digest))
        total += size
    return total, digest.hexdigest()


# MedOS Setup's own code and instructions, as opposed to the medical payload.
# A hotfix legitimately replaces these, so they can be re-recorded afterwards.
# component-manifest, drive-manifest and the checksum sidecars are deliberately
# excluded: those are the baseline that proves the medical data is intact, and
# re-sealing them would let genuine corruption pass verification.
_RESEALABLE_INSTALLER_ARTIFACTS = {
    "setup_center": "setup-center",
    "START HERE - WINDOWS.cmd": "windows-launcher",
    "START HERE - MAC.zip": "mac-bootstrap",
    "START HERE - README.html": "fallback-guide",
}


def _is_resealable_installer_artifact(path: str, kind: str) -> bool:
    """Return whether *this exact installer artifact* may be re-recorded.

    Artifact kinds are intentionally insufficient here: large application and
    clinical-data trees are grouped as ``desktop-payload``. Allowing a whole
    kind would let a corrupted or modified payload become trusted release data.
    """

    return _RESEALABLE_INSTALLER_ARTIFACTS.get(path) == kind


def reseal_installer_artifacts(
    drive_root: Path,
    paths: Iterable[str],
) -> tuple[dict[str, object], ...]:
    """Re-record the hashes of MedOS Setup's own artifacts after a hotfix.

    A hotfix replaces installer code but cannot update the preparation report,
    so the drive then fails its own verification and a correctly patched drive
    is reported as corrupt — sending users to re-download 45 GB that was never
    damaged. Re-sealing rewrites only the artifacts named by the caller, so it
    can never become a blanket "trust everything on this drive".
    """

    root = _lexical_absolute(Path(drive_root)).resolve(strict=True)
    report, inventory = load_prepared_artifact_inventory(root)
    requested = [str(item) for item in paths]
    if not requested:
        raise PrepareError("no artifact paths were named for re-sealing")

    recorded = {
        _report_relative_path(artifact["path"]).as_posix(): artifact
        for artifact in inventory
    }
    resealed: list[dict[str, object]] = []
    for name in requested:
        relative = _report_relative_path(name)
        key = relative.as_posix()
        artifact = recorded.get(key)
        if artifact is None:
            raise PrepareError(f"this drive does not record an artifact at {key}")
        kind = artifact["kind"]
        if not _is_resealable_installer_artifact(key, kind):
            raise PrepareError(
                f"{key} is a {kind} artifact and cannot be re-sealed; it is part of "
                "the baseline that proves the medical data is intact"
            )
        if key == _PORTABLE_EXTERNAL_ROOT.as_posix():
            # Prepared from the component inventory rather than from disk, so a
            # plain re-measure here would not even reproduce the same digest.
            raise PrepareError(f"{key} holds medical data and cannot be re-sealed")
        candidate = root / Path(*relative.parts)
        _assert_no_reparse_chain(candidate, "prepared artifact")
        if _is_link_or_reparse(candidate):
            raise PrepareError(f"prepared artifact is unsafe: {key}")
        size, digest = _measure(candidate)
        resealed.append(
            {
                "path": key,
                "kind": kind,
                "previous_size": artifact["size"],
                "previous_sha256": artifact["sha256"],
                "size": size,
                "sha256": digest,
            }
        )
        # inventory holds the same dicts as report["artifacts"].
        artifact["size"] = size
        artifact["sha256"] = digest

    _write(
        root / ".medos-setup" / "preparation-report.json",
        canonical_json_bytes(report),
    )
    return tuple(resealed)


def verify_prepared_artifacts(
    drive_root: Path,
    *,
    drive=None,
    inventory: tuple[dict[str, object], ...] | None = None,
    report: dict[str, object] | None = None,
    on_bytes: Callable[[int], None] | None = None,
    on_artifact: Callable[[], None] | None = None,
    checkpoint: Callable[[], None] | None = None,
    component=None,
) -> dict[str, int]:
    """Verify every non-component artifact recorded by drive preparation."""

    root = _lexical_absolute(Path(drive_root)).resolve(strict=True)
    if inventory is None or report is None:
        component_cache = {}
        if drive is None:
            drive = load_drive_manifest(
                root,
                component_cache=component_cache,
                checkpoint=checkpoint,
            )
        report, inventory = load_prepared_artifact_inventory(root, drive=drive)
        if component is None:
            component = next(
                (
                    value
                    for value in component_cache.values()
                    if value.component_id == report["component_id"]
                ),
                None,
            )
    seen: set[str] = set()
    kinds: set[str] = set()
    verified_bytes = 0
    for artifact in inventory:
        if checkpoint is not None:
            checkpoint()
        relative = _report_relative_path(artifact["path"])
        folded = relative.as_posix().casefold()
        if folded in seen:
            raise PrepareError(f"preparation report path collision: {relative}")
        seen.add(folded)
        kind = artifact["kind"]
        size = artifact["size"]
        digest = artifact["sha256"]
        candidate = root / Path(*relative.parts)
        try:
            _assert_no_reparse_chain(candidate, "prepared artifact")
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
        except (OSError, ValueError) as error:
            raise PrepareError(f"prepared artifact is missing or unsafe: {relative}") from error
        if _is_link_or_reparse(candidate):
            raise PrepareError(f"prepared artifact is unsafe: {relative}")
        actual_size, actual_digest = _measure_with_progress(
            candidate,
            on_bytes=on_bytes,
            checkpoint=checkpoint,
        )
        if actual_size != size or actual_digest != digest:
            if _is_resealable_installer_artifact(relative.as_posix(), kind):
                raise PrepareError(
                    f"MedOS Setup's own files no longer match this release: {relative}. "
                    "This is what an applied hotfix looks like, not damaged medical "
                    "data. Re-seal the installer files with "
                    "'medos-setup reseal-installer', or use a freshly built release."
                )
            raise PrepareError(f"prepared artifact failed verification: {relative}")
        kinds.add(kind)
        verified_bytes += actual_size
        if on_artifact is not None:
            on_artifact()
    required_kinds = {
        "mac-runtime",
        "mac-bootstrap",
        "android-kit",
        "setup-center",
        "component-manifest",
        "drive-manifest",
        "windows-launcher",
        "fallback-guide",
    }
    if not required_kinds.issubset(kinds):
        raise PrepareError("preparation report is missing required artifact groups")
    _verify_release_stage_evidence(
        root,
        report,
        component=component,
        checkpoint=checkpoint,
    )
    return {"artifact_count": len(inventory), "artifact_bytes": verified_bytes}


def _same(
    staged: Path,
    final: Path,
    measurement: tuple[int, str] | None = None,
) -> tuple[bool, int, str]:
    size, digest = measurement if measurement is not None else _measure(staged)
    if (
        not _path_lexists(final)
        or _is_link_or_reparse(final)
        or staged.is_dir() != final.is_dir()
    ):
        return False, size, digest
    try:
        final_size, final_digest = _measure(final)
    except (OSError, PrepareError):
        return False, size, digest
    return size == final_size and digest == final_digest, size, digest


def _validate_published_metadata(drive: Path) -> None:
    """Validate final control files without re-reading published payload bytes."""

    published_drive = load_drive_manifest(drive)
    load_prepared_artifact_inventory(drive, drive=published_drive)


def _copy_clean_payload(source: Path, publish: Path, inventory: list[_InventoryFile]) -> None:
    for item in inventory:
        if item.record.source.parts[0] == ".medos-payload":
            continue
        destination = publish / Path(*item.record.source.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item.source_path, destination)
    helper = source / "tools" / "release"
    if helper.is_dir():
        _copy_tree(helper, publish / "tools" / "release", allow_zip=True)


def _verify_inventory(
    inventory: list[_InventoryFile],
    *,
    source: Path,
    publish: Path,
    direct: bool,
    copy_verified_sources: frozenset[PurePosixPath] = frozenset(),
) -> None:
    for item in inventory:
        staged_payload = item.record.source.parts[0] == ".medos-payload"
        if direct and not staged_payload:
            path = item.source_path
            resolved_root = source
        else:
            path = publish / Path(*item.record.source.parts)
            resolved_root = publish
        try:
            _assert_no_reparse_chain(path, "staged component source")
            resolved_parent = path.parent.resolve(strict=True)
            resolved_parent.relative_to(resolved_root)
        except (OSError, ValueError) as error:
            raise PrepareError(f"staged component source is missing or unsafe: {item.record.source}") from error
        if path.is_symlink() or not path.is_file() or path.stat().st_size != item.record.size:
            raise PrepareError(f"staged component source failed verification: {item.record.source}")
        if item.record.source in copy_verified_sources:
            continue
        if item.release_stage_override:
            _assert_independent_release_copy(item, path)
        elif sha256_file(path) != item.record.sha256:
            raise PrepareError(f"staged component source failed verification: {item.record.source}")


def _publish(
    publications: list[_Publication],
    *,
    drive: Path,
    stage: Path,
    validate: Callable[[], None],
    recovery: _PublicationRecoveryState,
    measurements: Mapping[PurePosixPath, tuple[int, str]] | None = None,
) -> tuple[PrepareItem, ...]:
    measured: list[tuple[_Publication, bool, int, str, bool]] = []
    for item in publications:
        measurement = measurements.get(item.relative) if measurements is not None else None
        if item.force_replace:
            size, digest = measurement if measurement is not None else _measure(item.staged)
            same = False
        else:
            same, size, digest = _same(
                item.staged,
                drive / Path(*item.relative.parts),
                measurement,
            )
        measured.append((item, same, size, digest, item.staged.is_dir()))
    backup = stage / "rollback"
    changed: list[tuple[_Publication, Path | None]] = []

    def restore(primary_error: BaseException) -> bool:
        try:
            for item, rollback in reversed(changed):
                final = drive / Path(*item.relative.parts)
                retained: list[_HeldDirectoryChain] = []
                restore_item_error: BaseException | None = None
                try:
                    retained.append(
                        _hold_directory_chain(
                            final.parent,
                            "rollback publication parent",
                        )
                    )
                    retained.append(
                        _hold_directory_chain(
                            item.staged.parent,
                            "rollback staging parent",
                        )
                    )
                    if rollback is not None:
                        retained.append(
                            _hold_directory_chain(
                                rollback.parent,
                                "rollback backup parent",
                            )
                        )
                    if _path_lexists(final):
                        os.replace(final, item.staged)
                    if rollback is not None:
                        if not _path_lexists(rollback):
                            raise PrepareError(
                                f"rollback backup is missing: {item.relative}"
                            )
                        os.replace(rollback, final)
                except BaseException as error:
                    restore_item_error = error
                    raise
                finally:
                    _cleanup_preserving_primary(
                        restore_item_error,
                        (
                            directory_lease.close
                            for directory_lease in reversed(retained)
                        ),
                        "rollback directory lease cleanup failed",
                    )
            recovery.rollback_required = False
            recovery.retain_recovery = False
            recovery.retained_stage = None
            return True
        except BaseException as restore_error:
            primary_error.add_note(
                "automatic rollback failed; recovery files were retained at "
                f"{stage}: {_exception_detail(restore_error)}"
            )
            marker = stage / "ROLLBACK REQUIRED.txt"
            try:
                marker.write_text(
                    "Automated rollback was interrupted. Preserve this directory for recovery.\n",
                    encoding="utf-8",
                )
            except BaseException as marker_error:
                primary_error.add_note(
                    "rollback marker creation also failed: "
                    f"{_exception_detail(marker_error)}"
                )
            return False

    try:
        for item, same, _, _, _ in measured:
            if same:
                continue
            final = drive / Path(*item.relative.parts)
            _assert_existing_no_reparse_chain(
                final.parent,
                "prepared publication parent",
            )
            final.parent.mkdir(parents=True, exist_ok=True)
            _assert_no_reparse_chain(final.parent, "prepared publication parent")
            rollback: Path | None = None
            final_lease = _hold_directory_chain(
                final.parent,
                "prepared publication parent",
            )
            staged_lease: _HeldDirectoryChain | None = None
            rollback_lease: _HeldDirectoryChain | None = None
            publication_error: BaseException | None = None
            try:
                staged_lease = _hold_directory_chain(
                    item.staged.parent,
                    "staged publication parent",
                )
                if _path_lexists(final):
                    rollback = backup / Path(*item.relative.parts)
                    _assert_existing_no_reparse_chain(
                        rollback.parent,
                        "publication rollback parent",
                    )
                    rollback.parent.mkdir(parents=True, exist_ok=True)
                    rollback_lease = _hold_directory_chain(
                        rollback.parent,
                        "publication rollback parent",
                    )
                    os.replace(final, rollback)
                    changed.append((item, rollback))
                os.replace(item.staged, final)
                if rollback is None:
                    changed.append((item, None))
            except BaseException as error:
                publication_error = error
                raise
            finally:
                _cleanup_preserving_primary(
                    publication_error,
                    tuple(
                        lease.close
                        for lease in (rollback_lease, staged_lease, final_lease)
                        if lease is not None
                    ),
                    "publication directory lease cleanup failed",
                )
        for item, _, expected_size, _, expected_directory in measured:
            published = drive / Path(*item.relative.parts)
            try:
                _assert_no_reparse_chain(published, "published artifact")
                info = published.lstat()
            except OSError as error:
                raise PrepareError(
                    f"published artifact is missing or unsafe: {item.relative}"
                ) from error
            actual_directory = stat.S_ISDIR(info.st_mode)
            if (
                _is_link_or_reparse(published)
                or actual_directory != expected_directory
                or (not actual_directory and info.st_size != expected_size)
            ):
                raise PrepareError(f"published artifact failed verification: {item.relative}")
        validate()
    except BaseException as error:
        recovery.rollback_required = True
        recovery.retain_recovery = True
        recovery.retained_stage = stage
        restored = restore(error)
        if isinstance(error, OSError):
            message = (
                "artifact publication failed and prior outputs were restored"
                if restored
                else "artifact publication failed; rollback recovery was retained"
            )
            wrapped = PrepareError(message)
            for note in getattr(error, "__notes__", ()):
                wrapped.add_note(note)
            raise wrapped from error
        raise
    results = []
    for item, same, size, digest, _ in measured:
        results.append(
            PrepareItem(
                path=(drive / Path(*item.relative.parts)).resolve(strict=False),
                kind=item.kind,
                status="reused" if same else "verified",
                size=size,
                sha256=digest,
            )
        )
    return tuple(results)


def prepare_drive(
    config: PrepareConfig,
    on_progress: Callable[[PrepareProgress], None] | None = None,
) -> PrepareReport:
    """Stage, verify, and transactionally publish one complete Setup Drive."""

    source, drive, mac_tools, apk, phone_data, direct = _validate_config(config)
    release_stage = _load_release_stage_override(config, source)
    release_inventory: list[_InventoryFile] | None = None
    try:
        if release_stage is not None:
            relocated_data_root = _canonical_relocated_data_root(
                source,
                prepared_root=drive,
            )
            release_inventory = _source_inventory(
                source,
                omit_release_stage_targets=True,
                relocated_data_root=relocated_data_root,
            )
            release_inventory.extend(release_stage.inventory)
            _reject_inventory_collisions(release_inventory)
            release_stage.receipt_lease.assert_bound()
    except BaseException as error:
        if release_stage is not None:
            _cleanup_preserving_primary(
                error,
                (release_stage.receipt_lease.close,),
                "release receipt handle cleanup failed",
            )
        raise
    drive_preexisted = drive.exists()
    prior_directory_metadata = (
        _directory_metadata(drive) if release_stage is not None else {}
    )
    completed = False
    resumable_stage = _find_resumable_prepare_stage(drive, config)
    resuming = resumable_stage is not None
    stage = resumable_stage or (
        drive / ".medos-setup" / "staging" / uuid.uuid4().hex
    )
    publish = stage / "publish"
    publication_recovery = _PublicationRecoveryState()
    initial_stage_lease: _HeldDirectoryChain | None = None
    primary_error: BaseException | None = None
    drive_identity = _directory_identity(drive)
    try:
        if resuming:
            _assert_no_reparse_tree(stage, "retained preparation stage")
            initial_stage_lease = _hold_directory_chain(
                publish,
                "retained preparation stage",
            )
        elif release_stage is not None:
            _assert_existing_no_reparse_chain(drive, "prepared output")
            _assert_existing_no_reparse_chain(
                publish.parent,
                "preparation staging parent",
            )
            initial_stage_lease = _create_initial_stage_tree(
                drive,
                stage,
                publish,
            )
        else:
            drive.mkdir(parents=True, exist_ok=True)
            publish.mkdir(parents=True, exist_ok=False)
        drive_identity = _directory_identity(drive)
        inventory = (
            _source_inventory(source)
            if release_inventory is None
            else release_inventory
        )
        mac_payload = publish / ".medos-payload" / "mac-tools"
        mac_zip = publish / "START HERE - MAC.zip"
        android_root = publish / "ANDROID - COPY TO PHONE"
        windows = publish / "START HERE - WINDOWS.cmd"
        readme = publish / "START HERE - README.html"
        setup_center_payload = publish / "setup_center"
        if resuming:
            _reconcile_resumed_tree(
                source / "setup_center",
                setup_center_payload,
            )
            portable_external = (
                publish / Path(*_PORTABLE_EXTERNAL_ROOT.parts)
                if any(item.portable_copy for item in inventory)
                else None
            )
            copy_verified_sources: frozenset[PurePosixPath] = frozenset()
            inventory.extend(_mac_payload_inventory(mac_tools))
            _reject_inventory_collisions(inventory)
            (
                component,
                component_sidecar,
                drive_manifest,
                drive_sidecar,
            ) = _reconcile_resumed_component(
                publish=publish,
                config=config,
                inventory=inventory,
            )
            build_mac_bootstrap(
                mac_zip,
                setup_root=source,
                mac_tools_root=mac_tools,
                release_id=config.release_id,
            )
            mac_sidecar = _sidecar(mac_zip)
            android_report = None
        else:
            _begin(config, PreparePhase.INVENTORY)
            _emit(
                on_progress,
                PreparePhase.INVENTORY,
                "Inventorying safe desktop payload",
                0,
                6,
            )
            portable_external, copy_verified_sources = _stage_portable_external_payload(
                inventory,
                publish=publish,
                drive=drive,
                release_stage=release_stage,
            )

            _begin(config, PreparePhase.MAC)
            _emit(
                on_progress,
                PreparePhase.MAC,
                "Staging dual-architecture macOS runtimes",
                1,
                6,
            )
            inventory.extend(_stage_mac_payload(mac_tools, mac_payload))
            build_mac_bootstrap(
                mac_zip,
                setup_root=source,
                mac_tools_root=mac_tools,
                release_id=config.release_id,
            )
            mac_sidecar = _sidecar(mac_zip)

            _begin(config, PreparePhase.ANDROID)
            _emit(
                on_progress,
                PreparePhase.ANDROID,
                "Building verified Android transfer kit",
                2,
                6,
            )
            android_report = build_android_kit(
                android_root,
                apk=apk,
                data_zip=phone_data,
                metadata=config.apk_metadata,
                artifact_copier=_existing_artifact_copier(
                    drive,
                    PurePosixPath(android_root.name),
                ),
            )

            _begin(config, PreparePhase.MANIFESTS)
            _emit(
                on_progress,
                PreparePhase.MANIFESTS,
                "Writing canonical drive manifests",
                3,
                6,
            )
            _reject_inventory_collisions(inventory)
            component_content = _component_bytes(config.component_id, inventory)
            component = publish / ".medos-setup" / "manifests" / f"{config.component_id}.manifest.json"
            _write(component, component_content)
            component_sidecar = _sidecar(component)
            drive_manifest = publish / "setup-drive.json"
            _write(
                drive_manifest,
                canonical_json_bytes(
                    {
                        "schema_version": 1,
                        "drive_id": config.drive_id,
                        "release_id": config.release_id,
                        "setup_center_version": __version__,
                        "components": [
                            {
                                "component_id": config.component_id,
                                "manifest": component.relative_to(publish).as_posix(),
                                "sha256": sha256_file(component),
                            }
                        ],
                    }
                ),
            )
            drive_sidecar = _sidecar(drive_manifest)

            try:
                shutil.copyfile(source / windows.name, windows)
                shutil.copyfile(source / readme.name, readme)
            except OSError as error:
                raise PrepareError(
                    "Windows launcher or fallback guide is unavailable"
                ) from error
            _copy_tree(source / "setup_center", setup_center_payload, allow_zip=True)
            if not direct:
                _copy_clean_payload(source, publish, inventory)

        _begin(config, PreparePhase.VERIFY)
        _emit(
            on_progress,
            PreparePhase.VERIFY,
            (
                "Resuming verified staged output"
                if resuming
                else "Verifying every staged output"
            ),
            4,
            6,
        )
        load_drive_manifest(publish)
        loaded_component = load_component_manifest(component)
        try:
            feature_audit = require_release_features(source, loaded_component)
        except ReleaseFeatureAuditError as error:
            raise PrepareError(str(error)) from error
        _verify_inventory(
            inventory,
            source=source,
            publish=publish,
            direct=direct,
            copy_verified_sources=copy_verified_sources,
        )
        verified_android = verify_android_kit(
            android_root,
            metadata_inspector=(
                (lambda _: android_report.metadata)
                if android_report is not None
                else (
                    (lambda _: config.apk_metadata)
                    if config.apk_metadata is not None
                    else None
                )
            ),
        )
        if android_report is None:
            android_report = verified_android
            _assert_resumed_android_inputs(
                android_report,
                apk=apk,
                phone_data=phone_data,
            )
        for sidecar, artifact in (
            (mac_sidecar, mac_zip),
            (component_sidecar, component),
            (drive_sidecar, drive_manifest),
        ):
            expected = f"{sha256_file(artifact)}  {artifact.name}\n"
            if sidecar.read_text(encoding="ascii") != expected:
                raise PrepareError(f"checksum sidecar failed verification: {sidecar.name}")

        publications = [
            _Publication(mac_payload, PurePosixPath(".medos-payload/mac-tools"), "mac-runtime"),
            _Publication(mac_zip, PurePosixPath(mac_zip.name), "mac-bootstrap"),
            _Publication(mac_sidecar, PurePosixPath(mac_sidecar.name), "checksum"),
            _Publication(android_root, PurePosixPath(android_root.name), "android-kit"),
            _Publication(setup_center_payload, PurePosixPath("setup_center"), "setup-center"),
            _Publication(component, PurePosixPath(component.relative_to(publish).as_posix()), "component-manifest"),
            _Publication(component_sidecar, PurePosixPath(component_sidecar.relative_to(publish).as_posix()), "checksum"),
            _Publication(drive_manifest, PurePosixPath(drive_manifest.name), "drive-manifest"),
            _Publication(drive_sidecar, PurePosixPath(drive_sidecar.name), "checksum"),
            _Publication(windows, PurePosixPath(windows.name), "windows-launcher"),
            _Publication(readme, PurePosixPath(readme.name), "fallback-guide"),
        ]
        if portable_external is not None:
            publications.append(
                _Publication(
                    portable_external,
                    _PORTABLE_EXTERNAL_ROOT,
                    "desktop-payload",
                    force_replace=release_stage is not None,
                )
            )
        if not direct:
            top_level_sources = sorted(
                {
                    item.record.source.parts[0]
                    for item in inventory
                    if item.record.source.parts[0] != ".medos-payload"
                }
                | {"setup_center"}
            )
            for name in top_level_sources:
                path = publish / name
                if path.exists() and all(item.staged != path for item in publications):
                    publications.append(_Publication(path, PurePosixPath(name), "desktop-payload"))

        artifact_values = []
        publication_measurements: dict[PurePosixPath, tuple[int, str]] = {}
        for item in publications:
            if portable_external is not None and item.staged == portable_external:
                size, digest = _measure_inventory_tree(
                    _PORTABLE_EXTERNAL_ROOT,
                    inventory,
                )
            else:
                size, digest = _measure(item.staged)
            publication_measurements[item.relative] = (size, digest)
            artifact_values.append(
                {
                    "path": item.relative.as_posix(),
                    "kind": item.kind,
                    "size": size,
                    "sha256": digest,
                }
            )
        preparation_value: dict[str, object] = {
            "schema_version": 1,
            "drive_id": config.drive_id,
            "release_id": config.release_id,
            "component_id": config.component_id,
            "component_file_count": len(inventory),
            "component_bytes": sum(item.record.size for item in inventory),
            "artifacts": artifact_values,
            "authenticity_note": "SHA-256 detects corruption; publisher authenticity comes from the signed Android APK and trusted distribution channel.",
            "release_features": {
                "missing_features": list(feature_audit.missing_features),
                "missing_packs": list(feature_audit.missing_packs),
                "incomplete_packs": list(feature_audit.incomplete_packs),
                "mac_architectures": list(feature_audit.mac_architectures),
                "portable_activation": feature_audit.portable_activation,
                "shortcut_count": feature_audit.shortcut_count,
            },
        }
        if release_stage is not None:
            preparation_value["release_stage"] = _release_stage_evidence(
                release_stage,
                publish,
                copy_verified_sources=copy_verified_sources,
            )
        preparation_report = publish / ".medos-setup" / "preparation-report.json"
        _write(
            preparation_report,
            canonical_json_bytes(preparation_value),
        )
        publications.append(
            _Publication(
                preparation_report,
                PurePosixPath(preparation_report.relative_to(publish).as_posix()),
                "preparation-report",
            )
        )
        publication_measurements[publications[-1].relative] = _measure(preparation_report)

        _begin(config, PreparePhase.PUBLISH)
        _emit(on_progress, PreparePhase.PUBLISH, "Publishing verified artifacts", 5, 6)
        if release_stage is not None:
            # The external payload is already an independently materialized,
            # hash-verified copy. Re-check only the held receipt binding here;
            # re-reading the original release tree cannot strengthen the copy.
            release_stage.receipt_lease.assert_bound()

        def validate_published() -> None:
            _validate_published_metadata(drive)

        items = _publish(
            publications,
            drive=drive,
            stage=stage,
            validate=validate_published,
            recovery=publication_recovery,
            measurements=publication_measurements,
        )
        _begin(config, PreparePhase.COMPLETE)
        _emit(on_progress, PreparePhase.COMPLETE, "Setup Drive is ready", 6, 6)
        report = PrepareReport(
            drive_root=drive,
            drive_id=config.drive_id,
            release_id=config.release_id,
            component_file_count=len(inventory),
            component_bytes=sum(item.record.size for item in inventory),
            items=items,
        )
        completed = True
        return report
    except BaseException as error:
        if (
            isinstance(error, Exception)
            and _prepare_drive_is_disconnected(drive, drive_identity)
        ):
            publication_recovery.retain_recovery = True
            publication_recovery.retained_stage = stage
            disconnected = PrepareError(
                "Setup Drive disconnected; reconnect it and run preparation again "
                "to resume the retained staged work"
            )
            disconnected.add_note(f"retained staging path: {stage}")
            primary_error = disconnected
            raise disconnected from error
        primary_error = error
        raise
    finally:
        deferred_error: BaseException | None = None

        def defer_cleanup_error(error: BaseException, context: str) -> None:
            nonlocal deferred_error
            if deferred_error is None:
                deferred_error = error
            else:
                deferred_error.add_note(f"{context}: {_exception_detail(error)}")

        if initial_stage_lease is not None:
            try:
                initial_stage_lease.close()
            except BaseException as error:
                if primary_error is not None:
                    primary_error.add_note(
                        "initial staging handle cleanup failed: "
                        f"{_exception_detail(error)}"
                    )
                elif isinstance(error, (KeyboardInterrupt, SystemExit)):
                    defer_cleanup_error(error, "initial staging handle cleanup failed")
                else:
                    wrapped = PrepareError(
                        "initial staging handle cleanup failed"
                    )
                    wrapped.__cause__ = error
                    defer_cleanup_error(wrapped, "initial staging handle cleanup failed")
        if not publication_recovery.retain_recovery:
            try:
                _remove_prepare_stage(stage, drive)
            except BaseException as error:
                active_error = primary_error or deferred_error
                if active_error is None and isinstance(
                    error, (KeyboardInterrupt, SystemExit)
                ):
                    defer_cleanup_error(error, "preparation staging cleanup failed")
                    active_error = error
                try:
                    _report_cleanup_failure(active_error, error, stage)
                except BaseException as reporting_error:
                    if active_error is not None:
                        active_error.add_note(
                            "cleanup recovery reporting also failed: "
                            f"{_exception_detail(reporting_error)}"
                        )
                    else:
                        defer_cleanup_error(
                            reporting_error,
                            "cleanup recovery reporting failed",
                        )
        if (
            release_stage is not None
            and not completed
            and not publication_recovery.retain_recovery
        ):
            active_error = primary_error or deferred_error
            try:
                _restore_directory_metadata(drive, prior_directory_metadata)
            except BaseException as error:
                if active_error is not None:
                    active_error.add_note(
                        "prepared output metadata restoration failed: "
                        f"{_exception_detail(error)}"
                    )
                else:
                    defer_cleanup_error(
                        error,
                        "prepared output metadata restoration failed",
                    )
            if (
                not drive_preexisted
                and _path_lexists(drive)
                and not _is_link_or_reparse(drive)
                and drive.is_dir()
            ):
                try:
                    drive.rmdir()
                except BaseException as error:
                    active_error = primary_error or deferred_error
                    if active_error is not None:
                        active_error.add_note(
                            "new output directory cleanup failed: "
                            f"{_exception_detail(error)}"
                        )
                    elif isinstance(error, (KeyboardInterrupt, SystemExit)):
                        defer_cleanup_error(
                            error,
                            "new output directory cleanup failed",
                        )
                    else:
                        wrapped = PrepareError(
                            "new output directory cleanup failed"
                        )
                        wrapped.__cause__ = error
                        defer_cleanup_error(
                            wrapped,
                            "new output directory cleanup failed",
                        )
        if release_stage is not None:
            try:
                release_stage.receipt_lease.close()
            except BaseException as error:
                active_error = primary_error or deferred_error
                if active_error is not None:
                    active_error.add_note(
                        "release receipt handle cleanup failed: "
                        f"{_exception_detail(error)}"
                    )
                elif isinstance(error, (KeyboardInterrupt, SystemExit)):
                    defer_cleanup_error(error, "release receipt handle cleanup failed")
                else:
                    wrapped = PrepareError(
                        "release receipt handle cleanup failed"
                    )
                    wrapped.__cause__ = error
                    defer_cleanup_error(
                        wrapped,
                        "release receipt handle cleanup failed",
                    )
        if primary_error is None and deferred_error is not None:
            raise deferred_error


__all__ = [
    "PrepareConfig",
    "PrepareError",
    "PrepareItem",
    "PreparePhase",
    "PrepareProgress",
    "PrepareReport",
    "prepare_drive",
    "reseal_installer_artifacts",
    "verify_prepared_artifacts",
]

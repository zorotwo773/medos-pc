"""Resumable, verified file copying for MedOS installations."""

from __future__ import annotations

import os
import hashlib
import stat
import threading
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import BinaryIO, Callable

from .journal import Journal, JournalError
from .manifest import sha256_file
from .planner import (
    InstallPlan,
    PlanAction,
    PlannedFile,
    PlanningError,
    resolve_copy_source,
)
from .progress import MacroProgressEmitter, ProgressEvent, install_phase_for


class CopyError(RuntimeError):
    """Raised when a file cannot be safely copied or verified."""


class CopyCancelled(CopyError):
    """Raised when the user cancels at a safe chunk boundary."""


class CopyControl:
    """Thread-safe pause/resume/cancel coordination at chunk boundaries."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._request = "running"
        self._state = "running"

    @property
    def state(self) -> str:
        with self._condition:
            return self._state

    def pause(self) -> None:
        with self._condition:
            if self._request == "cancelled":
                raise CopyCancelled("copy cancellation is already pending")
            self._request = "paused"
            if self._state == "running":
                self._state = "pause-requested"
            self._condition.notify_all()

    def resume(self) -> None:
        with self._condition:
            if self._request == "cancelled":
                raise CopyCancelled("copy cancellation is already pending")
            self._request = "running"
            if self._state in {"paused", "waiting-for-drive", "pause-requested"}:
                self._state = "resume-requested"
            self._condition.notify_all()

    def cancel(self) -> None:
        with self._condition:
            self._request = "cancelled"
            if self._state != "cancelled":
                self._state = "cancel-requested"
            self._condition.notify_all()

    def checkpoint(self) -> None:
        with self._condition:
            if self._request == "cancelled":
                self._state = "cancelled"
                self._condition.notify_all()
                raise CopyCancelled("copy cancelled")
            while self._request == "paused":
                self._state = "paused"
                self._condition.notify_all()
                self._condition.wait()
                if self._request == "cancelled":
                    self._state = "cancelled"
                    self._condition.notify_all()
                    raise CopyCancelled("copy cancelled")
            self._state = "running"
            self._condition.notify_all()

    def wait_for_drive(self) -> None:
        """Acknowledge a missing source and wait for an explicit Resume request."""

        with self._condition:
            if self._request == "cancelled":
                self._state = "cancelled"
                self._condition.notify_all()
                raise CopyCancelled("copy cancelled")
            self._request = "paused"
            self._state = "waiting-for-drive"
            self._condition.notify_all()
            while self._request == "paused":
                self._condition.wait()
            if self._request == "cancelled":
                self._state = "cancelled"
                self._condition.notify_all()
                raise CopyCancelled("copy cancelled")
            self._state = "running"
            self._condition.notify_all()

    def wait_for_state(self, state: str, *, timeout_seconds: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        with self._condition:
            while self._state != state:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True


def _default_source_opener(path: Path, mode: str) -> BinaryIO:
    return path.open(mode)


class CopyEngine:
    """Execute the COPY actions in an immutable install plan."""

    def __init__(
        self,
        *,
        chunk_size: int = 4 * 1024 * 1024,
        source_opener: Callable[[Path, str], BinaryIO] = _default_source_opener,
        clock: Callable[[], float] = time.monotonic,
        journal_checkpoint_files: int = 2048,
        journal_checkpoint_bytes: int = 128 * 1024 * 1024,
        journal_checkpoint_seconds: float = 30.0,
        before_publish: Callable[[Path], None] | None = None,
    ) -> None:
        if isinstance(chunk_size, bool) or not isinstance(chunk_size, int) or chunk_size <= 0:
            raise ValueError("chunk_size must be a positive integer")
        if (
            isinstance(journal_checkpoint_files, bool)
            or not isinstance(journal_checkpoint_files, int)
            or journal_checkpoint_files <= 0
        ):
            raise ValueError("journal_checkpoint_files must be a positive integer")
        if (
            isinstance(journal_checkpoint_bytes, bool)
            or not isinstance(journal_checkpoint_bytes, int)
            or journal_checkpoint_bytes <= 0
        ):
            raise ValueError("journal_checkpoint_bytes must be a positive integer")
        if (
            isinstance(journal_checkpoint_seconds, bool)
            or not isinstance(journal_checkpoint_seconds, (int, float))
            or journal_checkpoint_seconds <= 0
        ):
            raise ValueError("journal_checkpoint_seconds must be positive")
        self.chunk_size = chunk_size
        self.source_opener = source_opener
        self.clock = clock
        self.journal_checkpoint_files = journal_checkpoint_files
        self.journal_checkpoint_bytes = journal_checkpoint_bytes
        self.journal_checkpoint_seconds = float(journal_checkpoint_seconds)
        self.before_publish = before_publish

    def execute(
        self,
        plan: InstallPlan,
        journal: Journal,
        on_progress: Callable[[ProgressEvent], None],
        control: CopyControl,
    ) -> None:
        if Path(journal.state.target_root) != plan.target_root.resolve(strict=False):
            raise CopyError("journal target does not match the install plan")
        if journal.state.mode is not plan.mode:
            raise CopyError("journal mode does not match the install plan")
        progress = MacroProgressEmitter(on_progress, clock=self.clock)
        marker_digest = self._drive_marker_digest(plan.source_root)
        try:
            journal.set_phase("copying")
            completed_bytes = 0
            completed_items = 0
            total_items = sum(item.action is PlanAction.COPY for item in plan.items)
            started = self.clock()
            transferred_this_run = 0
            checkpoint_started = started
            checkpoint_files = 0
            checkpoint_bytes = 0
            for item in plan.items:
                if item.action is not PlanAction.COPY:
                    continue
                control.checkpoint()
                relative = item.record.target.as_posix()
                if relative in journal.state.completed_paths:
                    if self._target_matches(item):
                        completed_bytes += item.record.size
                        completed_items += 1
                        self._emit(
                            item,
                            completed_bytes,
                            plan.copy_bytes,
                            item.record.size,
                            completed_items,
                            total_items,
                            started,
                            transferred_this_run,
                            progress.emit,
                        )
                        continue
                    journal.unmark_completed(relative, size=item.record.size)
                while True:
                    try:
                        resolved_item = replace(
                            item,
                            source_path=resolve_copy_source(item.record, plan.source_root),
                        )
                        written = self._copy_one(
                            resolved_item,
                            plan,
                            journal,
                            completed_bytes,
                            completed_items,
                            total_items,
                            started,
                            transferred_this_run,
                            progress.emit,
                            control,
                        )
                    except (OSError, PlanningError, CopyError) as error:
                        if marker_digest is None or self._drive_marker_matches(
                            plan.source_root, marker_digest
                        ):
                            journal.set_phase("paused")
                            if isinstance(error, CopyError):
                                raise
                            raise CopyError(str(error)) from error
                        journal.flush()
                        journal.set_phase("waiting-for-drive")
                        control.wait_for_drive()
                        observed = self._drive_marker_digest(plan.source_root)
                        if observed != marker_digest:
                            journal.set_phase("paused")
                            raise CopyError(
                                "the original MedOS setup drive has not been reconnected"
                            ) from error
                        journal.set_phase("copying")
                        continue
                    item = resolved_item
                    break
                transferred_this_run += written
                completed_bytes += item.record.size
                journal.mark_completed(relative, size=item.record.size, persist=False)
                completed_items += 1
                checkpoint_files += 1
                checkpoint_bytes += item.record.size
                checkpoint_now = self.clock()
                if (
                    checkpoint_files >= self.journal_checkpoint_files
                    or checkpoint_bytes >= self.journal_checkpoint_bytes
                    or checkpoint_now - checkpoint_started >= self.journal_checkpoint_seconds
                ):
                    journal.flush()
                    checkpoint_started = checkpoint_now
                    checkpoint_files = 0
                    checkpoint_bytes = 0
                self._emit(
                    item,
                    completed_bytes,
                    plan.copy_bytes,
                    item.record.size,
                    completed_items,
                    total_items,
                    started,
                    transferred_this_run,
                    progress.emit,
                )
            journal.set_phase("copied")
        except CopyCancelled:
            journal.set_phase("paused")
            raise
        except JournalError as error:
            raise CopyError(str(error)) from error

    def _target_matches(self, item: PlannedFile) -> bool:
        try:
            return (
                item.target_path.is_file()
                and item.target_path.stat().st_size == item.record.size
                and sha256_file(item.target_path, chunk_size=self.chunk_size) == item.record.sha256
            )
        except OSError:
            return False

    @staticmethod
    def _drive_marker_digest(source_root: Path) -> str | None:
        marker = Path(source_root) / "setup-drive.json"
        try:
            if not marker.is_file() or marker.is_symlink():
                return None
            return sha256_file(marker, chunk_size=64 * 1024)
        except OSError:
            return None

    @classmethod
    def _drive_marker_matches(cls, source_root: Path, expected: str) -> bool:
        return cls._drive_marker_digest(source_root) == expected

    def _copy_one(
        self,
        item: PlannedFile,
        plan: InstallPlan,
        journal: Journal,
        completed_bytes: int,
        completed_items: int,
        total_items: int,
        started: float,
        transferred_before: int,
        on_progress: Callable[[ProgressEvent], None],
        control: CopyControl,
    ) -> int:
        try:
            item.target_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            journal.set_phase("paused")
            raise CopyError(f"copy interrupted while creating {item.record.target}") from error
        partial = item.target_path.with_name(item.target_path.name + ".medos-partial")
        offset = self._prepare_partial(item, partial, plan.target_root)
        initial = self._fingerprint(item.source_path)
        copied = 0
        try:
            with self.source_opener(item.source_path, "rb") as source:
                source.seek(offset)
                with self._open_bound_partial(partial, offset, item.record.size) as destination:
                    while offset + copied < item.record.size:
                        control.checkpoint()
                        remaining = item.record.size - offset - copied
                        chunk = source.read(min(self.chunk_size, remaining))
                        if not chunk:
                            raise OSError("source ended before declared size")
                        destination.write(chunk)
                        copied += len(chunk)
                        self._emit(
                            item,
                            completed_bytes + offset + copied,
                            plan.copy_bytes,
                            offset + copied,
                            completed_items,
                            total_items,
                            started,
                            transferred_before + copied,
                            on_progress,
                        )
                    destination.flush()
                    os.fsync(destination.fileno())
                    if self._fingerprint(item.source_path) != initial:
                        raise CopyError(f"source changed during copy: {item.record.source}")
                    partial_size = os.fstat(destination.fileno()).st_size
                    digest = self._hash_open_handle(destination)
                    verified_identity = self._open_identity(destination)
                    if partial_size != item.record.size:
                        raise CopyError(f"copy size mismatch for {item.record.target}")
                    if digest != item.record.sha256:
                        raise CopyError(f"copy hash mismatch for {item.record.target}")
                    if self.before_publish is not None:
                        self.before_publish(partial)
                    self._assert_bound_identity(destination, partial, verified_identity)
                    self._publish_open_partial(destination, partial, item.target_path)
        except CopyCancelled:
            raise
        except CopyError as error:
            if partial.exists():
                self._quarantine(partial, plan.target_root)
            elif item.target_path.exists():
                self._quarantine(item.target_path, plan.target_root)
            journal.set_phase("paused")
            raise
        except OSError as error:
            journal.set_phase("paused")
            raise CopyError(f"copy interrupted for {item.record.target}: {error}") from error
        return copied

    @staticmethod
    def _windows_open_fd(path: Path) -> int:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        create_file = ctypes.windll.kernel32.CreateFileW
        create_file.argtypes = (
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        )
        create_file.restype = wintypes.HANDLE
        handle = create_file(
            CopyEngine._windows_extended_path(path),
            0x80000000 | 0x40000000 | 0x00010000,
            0x00000001 | 0x00000004,
            None,
            4,
            0x00000080 | 0x00200000,
            None,
        )
        invalid = ctypes.c_void_p(-1).value
        if handle == invalid:
            raise ctypes.WinError()
        try:
            return msvcrt.open_osfhandle(handle, os.O_RDWR | getattr(os, "O_BINARY", 0))
        except BaseException:
            ctypes.windll.kernel32.CloseHandle(handle)
            raise

    def _open_bound_partial(self, partial: Path, offset: int, lock_size: int) -> BinaryIO:
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOINHERIT", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        if partial.exists() and self._is_reparse(partial):
            raise CopyError(f"partial copy is unsafe: {partial}")
        try:
            fd = self._windows_open_fd(partial) if os.name == "nt" else os.open(partial, flags, 0o600)
        except OSError as error:
            raise CopyError(f"cannot open partial copy safely: {partial}") from error
        handle: BinaryIO | None = None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or self._is_reparse(partial):
                raise CopyError(f"partial copy is not a regular file: {partial}")
            path_info = partial.lstat()
            if (path_info.st_dev, path_info.st_ino) != (info.st_dev, info.st_ino):
                raise CopyError(f"partial copy identity changed: {partial}")
            if offset == 0:
                os.ftruncate(fd, 0)
            elif info.st_size != offset:
                raise CopyError(f"partial copy identity changed: {partial}")
            handle = os.fdopen(fd, "r+b")
            handle.seek(offset)
            if os.name == "nt":
                import msvcrt

                remaining_lock = max(1, lock_size)
                lock_offset = 0
                while remaining_lock:
                    count = min(remaining_lock, 0x7FFFFFFF)
                    handle.seek(lock_offset)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, count)
                    lock_offset += count
                    remaining_lock -= count
                handle.seek(offset)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except BaseException:
            if handle is not None:
                handle.close()
            else:
                os.close(fd)
            raise

    def _hash_open_handle(self, handle: BinaryIO) -> str:
        digest = hashlib.sha256()
        handle.seek(0)
        while chunk := handle.read(self.chunk_size):
            digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _open_identity(handle: BinaryIO) -> tuple[int, int, int, int, int]:
        info = os.fstat(handle.fileno())
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns

    @staticmethod
    def _is_reparse(path: Path) -> bool:
        info = path.lstat()
        attributes = getattr(info, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return stat.S_ISLNK(info.st_mode) or bool(attributes & reparse_flag)

    @staticmethod
    def _windows_extended_path(path: Path) -> str:
        value = str(path.resolve(strict=False))
        if value.startswith("\\\\"):
            return "\\\\?\\UNC\\" + value[2:]
        return "\\\\?\\" + value

    def _assert_bound_identity(
        self,
        handle: BinaryIO,
        path: Path,
        expected: tuple[int, int, int, int, int],
    ) -> None:
        if self._open_identity(handle) != expected:
            raise CopyError("verified partial changed before publication")
        try:
            info = path.lstat()
        except OSError as error:
            raise CopyError("verified partial changed before publication") from error
        observed = (
            info.st_dev,
            info.st_ino,
            info.st_size,
        )
        if observed != expected[:3] or self._is_reparse(path):
            raise CopyError("verified partial changed before publication")

    def _publish_open_partial(
        self,
        handle: BinaryIO,
        partial: Path,
        target: Path,
    ) -> None:
        if os.name != "nt":
            os.replace(partial, target)
        else:
            self._windows_rename_open_handle(handle, target)
        target_info = target.lstat()
        target_identity = (
            target_info.st_dev,
            target_info.st_ino,
            target_info.st_size,
        )
        if target_identity != self._open_identity(handle)[:3]:
            raise CopyError("published copy is not the verified partial")

    @staticmethod
    def _windows_rename_open_handle(handle: BinaryIO, target: Path) -> None:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        class FileRenameInfo(ctypes.Structure):
            _fields_ = (
                ("ReplaceIfExists", wintypes.BOOLEAN),
                ("RootDirectory", wintypes.HANDLE),
                ("FileNameLength", wintypes.DWORD),
                ("FileName", wintypes.WCHAR * 1),
            )

        target_path = str(target.resolve(strict=False))
        target_text = (
            "\\??\\UNC\\" + target_path[2:]
            if target_path.startswith("\\\\")
            else "\\??\\" + target_path
        )
        encoded = target_text.encode("utf-16-le")
        size = FileRenameInfo.FileName.offset + len(encoded) + 2
        buffer = ctypes.create_string_buffer(size)
        value = ctypes.cast(buffer, ctypes.POINTER(FileRenameInfo)).contents
        value.ReplaceIfExists = 1
        value.RootDirectory = None
        value.FileNameLength = len(encoded)
        ctypes.memmove(ctypes.addressof(buffer) + FileRenameInfo.FileName.offset, encoded, len(encoded))
        rename = ctypes.windll.kernel32.SetFileInformationByHandle
        rename.argtypes = (wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD)
        rename.restype = wintypes.BOOL
        raw_handle = msvcrt.get_osfhandle(handle.fileno())
        if not rename(raw_handle, 3, ctypes.byref(buffer), size):
            raise ctypes.WinError()

    def _prepare_partial(self, item: PlannedFile, partial: Path, target_root: Path) -> int:
        if not partial.exists():
            return 0
        if self._is_reparse(partial):
            self._quarantine(partial, target_root)
            return 0
        try:
            size = partial.stat().st_size
        except OSError as error:
            raise CopyError(f"cannot inspect partial copy: {item.record.target}") from error
        if size > item.record.size or not self._partial_matches_source(item.source_path, partial, size):
            self._quarantine(partial, target_root)
            return 0
        return size

    def _partial_matches_source(self, source_path: Path, partial: Path, size: int) -> bool:
        remaining = size
        try:
            with self.source_opener(source_path, "rb") as source, partial.open("rb") as existing:
                while remaining:
                    count = min(self.chunk_size, remaining)
                    source_chunk = source.read(count)
                    partial_chunk = existing.read(count)
                    if source_chunk != partial_chunk or len(partial_chunk) != count:
                        return False
                    remaining -= count
            return True
        except OSError:
            return False

    @staticmethod
    def _fingerprint(path: Path) -> tuple[int, int, int, int]:
        try:
            info = path.stat()
        except OSError as error:
            raise CopyError(f"cannot inspect copy source: {path}") from error
        return info.st_size, info.st_mtime_ns, info.st_dev, info.st_ino

    @staticmethod
    def _quarantine(partial: Path, target_root: Path) -> Path:
        failed = target_root / ".medos-install" / "failed"
        try:
            failed.mkdir(parents=True, exist_ok=True)
            destination = failed / f"{uuid.uuid4().hex}-{partial.name}"
            os.replace(partial, destination)
            return destination
        except OSError as error:
            raise CopyError(f"cannot quarantine invalid partial: {partial}") from error

    def _emit(
        self,
        item: PlannedFile,
        completed_bytes: int,
        total_bytes: int,
        current_bytes: int,
        completed_items: int,
        total_items: int,
        started: float,
        transferred_this_run: int,
        on_progress: Callable[[ProgressEvent], None],
    ) -> None:
        elapsed = max(self.clock() - started, 1e-9)
        rate = max(0.0, transferred_this_run / elapsed)
        remaining = max(0, total_bytes - completed_bytes)
        eta = remaining / rate if rate > 0 else None
        on_progress(
            ProgressEvent(
                phase=install_phase_for(item.record.role),
                message=(
                    "Installing the medical library"
                    if item.record.role in {"data", "model"}
                    else "Installing the MedOS application"
                ),
                relative_path="",
                completed_bytes=min(completed_bytes, total_bytes),
                total_bytes=total_bytes,
                current_bytes=min(current_bytes, item.record.size),
                current_total=item.record.size,
                completed_items=completed_items,
                total_items=total_items,
                bytes_per_second=rate,
                eta_seconds=eta,
            )
        )


__all__ = [
    "CopyCancelled",
    "CopyControl",
    "CopyEngine",
    "CopyError",
    "ProgressEvent",
]

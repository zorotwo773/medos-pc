"""Bounded, manifest-owned MedOS repair actions."""

from __future__ import annotations

import os
import shlex
import shutil
import signal
import subprocess
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Sequence

from .health import HealthIssue, HealthReport
from .journal import Journal, JournalError
from .manifest import ComponentManifest, FileRecord, sha256_file


class RepairError(RuntimeError):
    """Raised when a requested repair is unowned, unsafe, or unsuccessful."""


@dataclass(frozen=True, slots=True)
class RepairAction:
    code: str
    relative_path: str
    status: str
    message: str


@dataclass(frozen=True, slots=True)
class RepairResult:
    actions: tuple[RepairAction, ...]
    health_attempts: int
    health_report: HealthReport


class ProcessInspector(ABC):
    @abstractmethod
    def executable(self, process_id: int) -> Path | None:
        """Return a process executable/command path, or None if it is not running."""

    @abstractmethod
    def terminate_tree(self, process_id: int) -> None:
        """Terminate the owned process and its descendants."""


class SystemProcessInspector(ProcessInspector):
    def executable(self, process_id: int) -> Path | None:
        if process_id <= 0:
            return None
        if os.name == "nt":
            script = (
                f"$p=Get-CimInstance Win32_Process -Filter \"ProcessId={process_id}\" "
                "-ErrorAction SilentlyContinue; if($p){$p.ExecutablePath}"
            )
            command = ["powershell.exe", "-NoProfile", "-Command", script]
        else:
            command = ["ps", "-p", str(process_id), "-o", "command="]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=5,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        output = completed.stdout.strip()
        if completed.returncode != 0 or not output:
            return None
        if os.name == "nt":
            return Path(output.splitlines()[0].strip())
        try:
            arguments = shlex.split(output)
        except ValueError:
            return None
        return Path(arguments[0]) if arguments else None

    def terminate_tree(self, process_id: int) -> None:
        if process_id <= 0:
            raise RepairError("process ID must be positive")
        if os.name == "nt":
            command = ["taskkill", "/F", "/T", "/PID", str(process_id)]
            try:
                completed = subprocess.run(
                    command,
                    capture_output=True,
                    timeout=15,
                    check=False,
                    shell=False,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise RepairError(f"cannot stop owned process {process_id}") from error
            if completed.returncode != 0:
                raise RepairError(f"cannot stop owned process {process_id}")
            return
        subprocess.run(
            ["pkill", "-TERM", "-P", str(process_id)],
            capture_output=True,
            timeout=5,
            check=False,
            shell=False,
        )
        try:
            os.kill(process_id, signal.SIGTERM)
        except ProcessLookupError:
            return
        except OSError as error:
            raise RepairError(f"cannot stop owned process {process_id}") from error


class RepairEngine:
    """Apply only known manifest/PID repairs and perform one health retry."""

    _PID_PATHS = frozenset({"app/backend.pid", "app/frontend.pid", "app/status.pid"})

    def __init__(
        self,
        *,
        component: ComponentManifest,
        health_checker,
        process_inspector: ProcessInspector | None = None,
        health_timeout_seconds: float = 120.0,
    ) -> None:
        if health_timeout_seconds <= 0:
            raise ValueError("health_timeout_seconds must be positive")
        self.component = component
        self.health_checker = health_checker
        self.process_inspector = process_inspector or SystemProcessInspector()
        self.health_timeout_seconds = health_timeout_seconds
        self._records = {
            record.target.as_posix().casefold(): record for record in component.files
        }

    def repair(
        self,
        target_root: Path,
        issues: Sequence[HealthIssue],
        *,
        source_root: Path,
    ) -> RepairResult:
        target = Path(target_root).expanduser().resolve(strict=True)
        source = Path(source_root).expanduser().resolve(strict=True)
        journal = self._load_journal(target)
        if journal is not None:
            journal.set_phase("repairing")
        actions: list[RepairAction] = []
        for issue in issues:
            if issue.code in {"managed-file-corrupt", "managed-file-missing", "missing-runtime", "missing-build"}:
                record = self._repairable_record(issue)
                self._restore_record(source, target, record)
                if journal is not None:
                    journal.unmark_completed(record.target.as_posix(), size=record.size)
                    journal.mark_completed(record.target.as_posix(), size=record.size)
                actions.append(
                    RepairAction(
                        issue.code,
                        record.target.as_posix(),
                        "restored",
                        "Restored the verified release file from the Setup Drive.",
                    )
                )
            elif issue.code == "permission":
                record = self._repairable_record(issue)
                path = self._contained_target(target, record.target)
                try:
                    path.chmod(path.stat().st_mode | 0o700)
                except OSError as error:
                    raise RepairError(f"cannot repair permissions: {record.target}") from error
                actions.append(
                    RepairAction(
                        issue.code,
                        record.target.as_posix(),
                        "permissions-repaired",
                        "Restored executable access on the managed file.",
                    )
                )
            elif issue.code == "stale-process":
                actions.append(self._repair_pid(target, issue))
            elif issue.code in {"backend-unreachable", "frontend-unreachable"}:
                # A single bounded launch retry below is the appropriate repair.
                # Treating endpoint timeouts as an unknown repair left users stuck
                # on a screen that could neither restart nor resume MedOS.
                actions.append(
                    RepairAction(
                        issue.code,
                        "",
                        "restart-requested",
                        "Restarting the MedOS services and checking them again.",
                    )
                )
            else:
                raise RepairError(f"no bounded repair is defined for issue: {issue.code}")
        report = self.health_checker.check(
            target,
            launch=True,
            timeout_seconds=self.health_timeout_seconds,
        )
        if journal is not None:
            journal.set_phase("complete" if report.healthy else "failed")
        return RepairResult(tuple(actions), 1, report)

    @staticmethod
    def _load_journal(target: Path) -> Journal | None:
        if not (target / ".medos-install" / "install-state.json").is_file():
            return None
        try:
            return Journal.load(target)
        except JournalError as error:
            raise RepairError(str(error)) from error

    def _repairable_record(self, issue: HealthIssue) -> FileRecord:
        if not issue.relative_path:
            raise RepairError(f"repair issue lacks a managed path: {issue.code}")
        record = self._records.get(issue.relative_path.casefold())
        if record is None:
            raise RepairError(f"repair path is not manifest-owned: {issue.relative_path}")
        if record.mutable:
            raise RepairError(f"refusing to replace mutable user data: {record.target}")
        return record

    @staticmethod
    def _contained_source(source: Path, relative: PurePosixPath) -> Path:
        try:
            path = (source / Path(*relative.parts)).resolve(strict=True)
            path.relative_to(source)
        except (OSError, ValueError) as error:
            raise RepairError(f"repair source escapes or is missing: {relative}") from error
        if not path.is_file():
            raise RepairError(f"repair source is not a file: {relative}")
        return path

    @staticmethod
    def _contained_target(target: Path, relative: PurePosixPath) -> Path:
        candidate = target / Path(*relative.parts)
        try:
            candidate.resolve(strict=False).relative_to(target)
        except ValueError as error:
            raise RepairError(f"repair target escapes install root: {relative}") from error
        if candidate.is_symlink():
            raise RepairError(f"repair target is a link: {relative}")
        return candidate

    def _restore_record(self, source_root: Path, target_root: Path, record: FileRecord) -> None:
        source = self._contained_source(source_root, record.source)
        if source.stat().st_size != record.size or sha256_file(source) != record.sha256:
            raise RepairError(f"repair source does not match its manifest: {record.source}")
        target = self._contained_target(target_root, record.target)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(f"{target.name}.medos-repair-{uuid.uuid4().hex}")
        try:
            with source.open("rb") as input_file, partial.open("xb") as output_file:
                shutil.copyfileobj(input_file, output_file, length=4 * 1024 * 1024)
                output_file.flush()
                os.fsync(output_file.fileno())
            if partial.stat().st_size != record.size or sha256_file(partial) != record.sha256:
                raise RepairError(f"repaired file failed verification: {record.target}")
            os.replace(partial, target)
        except (OSError, RepairError) as error:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
            if isinstance(error, RepairError):
                raise
            raise RepairError(f"cannot restore managed file: {record.target}") from error

    def _repair_pid(self, target: Path, issue: HealthIssue) -> RepairAction:
        if issue.relative_path not in self._PID_PATHS:
            raise RepairError(f"PID repair path is not allowed: {issue.relative_path}")
        relative = PurePosixPath(issue.relative_path)
        pid_file = self._contained_target(target, relative)
        try:
            process_id = int(pid_file.read_text(encoding="ascii").strip())
        except (OSError, UnicodeError, ValueError) as error:
            raise RepairError(f"PID record is invalid: {issue.relative_path}") from error
        if process_id <= 0:
            raise RepairError(f"PID record is invalid: {issue.relative_path}")
        executable = self.process_inspector.executable(process_id)
        if executable is not None:
            resolved = Path(executable).expanduser().resolve(strict=False)
            try:
                resolved.relative_to(target)
            except ValueError as error:
                raise RepairError(
                    f"refusing to stop process outside the MedOS target: {process_id}"
                ) from error
            self.process_inspector.terminate_tree(process_id)
            status = "stopped"
            message = "Stopped the stale MedOS-owned process and removed its PID record."
        else:
            status = "removed"
            message = "Removed a PID record whose process is no longer running."
        try:
            pid_file.unlink()
        except OSError as error:
            raise RepairError(f"cannot remove PID record: {issue.relative_path}") from error
        return RepairAction(issue.code, issue.relative_path, status, message)


__all__ = [
    "ProcessInspector",
    "RepairAction",
    "RepairEngine",
    "RepairError",
    "RepairResult",
    "SystemProcessInspector",
]

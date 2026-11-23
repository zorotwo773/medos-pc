"""Installation, resume, configuration, update staging, and rollback."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import stat
import uuid
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Callable, Protocol, Sequence

from .copy_engine import CopyCancelled, CopyControl, CopyEngine, CopyError
from .journal import Journal, JournalError
from .manifest import (
    ComponentManifest,
    FileRecord,
    ManifestError,
    canonical_json_bytes,
    load_component_manifest,
    load_drive_manifest,
    sha256_file,
)
from .planner import (
    InstallMode,
    InstallPlan,
    PlanAction,
    PlannedFile,
    PlanningError,
    SourceCheck,
    build_install_plan,
)
from .platforms import PlatformInfo, detect_platform, probe_free_bytes
from .progress import MacroProgressEmitter, ProgressEvent


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
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class InstallError(RuntimeError):
    """Raised when installation cannot safely reach its requested result."""


class InstallPhase(str, Enum):
    PREFLIGHT = "preflight"
    COPYING = "copying"
    VERIFYING = "verifying"
    CONFIGURING = "configuring"
    LAUNCHING = "launching"
    LAUNCH_FAILED = "launch-failed"
    REPAIRING = "repairing"
    COMPLETE = "complete"
    FAILED = "failed"
    ROLLED_BACK = "rolled-back"


@dataclass(frozen=True, slots=True)
class InstallRequest:
    drive_root: Path
    target_root: Path
    component_id: str
    mode: InstallMode
    launch_after: bool = True
    allow_online_repair: bool = False


@dataclass(frozen=True, slots=True)
class InstallResult:
    phase: InstallPhase
    target_root: Path
    release_id: str
    mode: InstallMode
    copied_bytes: int
    external_bytes: int
    external_data_root: Path | None
    shortcuts: tuple[Path, ...]
    health_summary: str | None


class HealthResult(Protocol):
    healthy: bool
    summary: str


class HealthChecker(Protocol):
    def check(self, target_root: Path, *, timeout_seconds: float) -> HealthResult: ...


class Launcher(Protocol):
    def start(self, target_root: Path) -> None: ...
    def stop(self, target_root: Path) -> None: ...


class ShortcutManager(Protocol):
    def create(self, target_root: Path) -> Sequence[Path]: ...


class _NoShortcuts:
    def create(self, target_root: Path) -> tuple[Path, ...]:
        return ()


@dataclass(frozen=True, slots=True)
class _Swap:
    relative_path: str
    final_path: Path
    rollback_path: Path | None


class Installer:
    """Coordinate one manifest-driven installation or update."""

    def __init__(
        self,
        *,
        platform_info: PlatformInfo | None = None,
        free_space: Callable[[Path], int] = probe_free_bytes,
        reserve_bytes: int = 1024 * 1024 * 1024,
        copy_engine: CopyEngine | None = None,
        launcher: Launcher | None = None,
        health_checker: HealthChecker | None = None,
        shortcut_manager: ShortcutManager | None = None,
        health_timeout_seconds: float = 120.0,
    ) -> None:
        if reserve_bytes < 0:
            raise ValueError("reserve_bytes must be non-negative")
        if health_timeout_seconds <= 0:
            raise ValueError("health_timeout_seconds must be positive")
        self.platform_info = platform_info or detect_platform()
        self.free_space = free_space
        self.reserve_bytes = reserve_bytes
        self.copy_engine = copy_engine or CopyEngine()
        self.launcher = launcher
        self.health_checker = health_checker
        self.shortcut_manager = shortcut_manager or _NoShortcuts()
        self.health_timeout_seconds = health_timeout_seconds

    def run(
        self,
        request: InstallRequest,
        on_progress: Callable[[ProgressEvent], None],
        control: CopyControl,
    ) -> InstallResult:
        progress = MacroProgressEmitter(on_progress, clock=self.copy_engine.clock)

        def emit_lifecycle(
            phase: str,
            message: str,
            *,
            completed_bytes: int = 0,
            total_bytes: int = 0,
            completed_items: int = 0,
            total_items: int = 0,
        ) -> None:
            progress.emit(
                ProgressEvent(
                    phase=phase,
                    message=message,
                    relative_path="",
                    completed_bytes=completed_bytes,
                    total_bytes=total_bytes,
                    current_bytes=0,
                    current_total=0,
                    completed_items=completed_items,
                    total_items=total_items,
                    bytes_per_second=0.0,
                    eta_seconds=None,
                ),
                force=True,
            )

        control.checkpoint()
        emit_lifecycle("preparing", "Preparing MedOS")
        drive_root = Path(request.drive_root).expanduser().resolve(strict=False)
        target_root = Path(request.target_root).expanduser().resolve(strict=False)
        component_cache = {}
        try:
            drive = load_drive_manifest(
                drive_root,
                component_cache=component_cache,
                checkpoint=control.checkpoint,
            )
            reference = next(
                component for component in drive.components if component.component_id == request.component_id
            )
        except StopIteration as error:
            raise InstallError(f"release component is unavailable: {request.component_id}") from error
        except ManifestError as error:
            raise InstallError(str(error)) from error
        component_path = drive_root / Path(*reference.manifest.parts)
        try:
            component = component_cache[component_path.resolve(strict=True)]
            control.checkpoint()
            mode = request.mode if isinstance(request.mode, InstallMode) else InstallMode(request.mode)
            prior_state = self._load_prior_state(target_root)
            if (
                prior_state is not None
                and prior_state.state.release_id == drive.release_id
                and prior_state.state.manifest_sha256 == reference.sha256
                and prior_state.state.mode is mode
                and prior_state.state.phase in {"failed", "launch-failed"}
                and request.launch_after
            ):
                return self._resume_launch_failure(
                    request=request,
                    drive_root=drive_root,
                    target_root=target_root,
                    release_id=drive.release_id,
                    manifest_sha256=reference.sha256,
                    mode=mode,
                    component=component,
                    journal=prior_state,
                    emit_lifecycle=emit_lifecycle,
                    control=control,
                )
            free_bytes = self.free_space(target_root)
            control.checkpoint()
            plan = build_install_plan(
                component,
                drive_root,
                target_root,
                mode,
                free_bytes=free_bytes,
                reserve_bytes=self.reserve_bytes,
                platform_info=self.platform_info,
                source_check=SourceCheck.DEFERRED,
                checkpoint=control.checkpoint,
            )
            control.checkpoint()
        except (ManifestError, PlanningError, ValueError, OSError) as error:
            raise InstallError(str(error)) from error

        prior_state = self._load_prior_state(target_root)
        is_resume = (
            prior_state is not None
            and prior_state.state.release_id == drive.release_id
            and prior_state.state.manifest_sha256 == reference.sha256
            and prior_state.state.mode is mode
            and prior_state.state.phase in {
                "preflight",
                "copying",
                "paused",
                "waiting-for-drive",
                "copied",
                "configuring",
                "launching",
            }
        )
        journal = self._journal_for(
            target_root,
            release_id=drive.release_id,
            manifest_sha256=reference.sha256,
            mode=mode,
            prior=prior_state if is_resume else None,
        )
        self._write_resume_request(request, drive_root=drive_root, target_root=target_root)
        environment_before = self._read_optional_bytes(target_root / "app" / "backend" / ".env")
        staged_items = tuple(
            item
            for item in plan.items
            if item.action is PlanAction.COPY
            and item.record.role in {"runtime", "launcher", "config", "documentation", "installer"}
            and item.target_path.exists()
            and not is_resume
        )
        total_copy_items = sum(item.action is PlanAction.COPY for item in plan.items)
        staged_bytes = sum(item.record.size for item in staged_items)
        staged_count = len(staged_items)

        def offset_progress(
            byte_offset: int, item_offset: int
        ) -> Callable[[ProgressEvent], None]:
            def emit(event: ProgressEvent) -> None:
                progress.emit(
                    replace(
                        event,
                        completed_bytes=min(
                            plan.copy_bytes, byte_offset + event.completed_bytes
                        ),
                        total_bytes=plan.copy_bytes,
                        completed_items=min(
                            total_copy_items, item_offset + event.completed_items
                        ),
                        total_items=total_copy_items,
                    )
                )

            return emit

        swaps: list[_Swap] = []
        launched = False
        try:
            if staged_items:
                try:
                    swaps = self._stage_and_swap(
                        plan,
                        staged_items,
                        drive.release_id,
                        reference.sha256,
                        offset_progress(0, 0),
                        control,
                    )
                except InstallError:
                    self._restore_optional_bytes(
                        target_root / "app" / "backend" / ".env", environment_before
                    )
                    journal.set_phase("rolled-back")
                    raise
                for item in staged_items:
                    journal.mark_completed(item.record.target.as_posix(), size=item.record.size)
            direct_items = tuple(item for item in plan.items if item not in staged_items)
            direct_plan = self._subset_plan(plan, direct_items)
            self.copy_engine.execute(
                direct_plan,
                journal,
                offset_progress(staged_bytes, staged_count),
                control,
            )
            control.checkpoint()
            journal.set_phase("verifying")
            emit_lifecycle(
                "verifying",
                "Verifying the installation",
                completed_bytes=plan.copy_bytes,
                total_bytes=plan.copy_bytes,
                completed_items=total_copy_items,
                total_items=total_copy_items,
            )
            self._verify_installed_structure(plan, journal, staged_items, control)
            control.checkpoint()
            journal.set_phase("configuring")
            control.checkpoint()
            self._write_portable_environment(drive_root, target_root, mode)
            control.checkpoint()
            shortcuts = (
                self._create_shortcuts(target_root)
                if request.launch_after
                else ()
            )
            control.checkpoint()
            health_summary: str | None = None
            if request.launch_after:
                if self.launcher is None or self.health_checker is None:
                    raise InstallError("launch integration is unavailable")
                journal.set_phase("launching")
                emit_lifecycle(
                    "starting",
                    "Starting MedOS",
                    completed_bytes=plan.copy_bytes,
                    total_bytes=plan.copy_bytes,
                    completed_items=total_copy_items,
                    total_items=total_copy_items,
                )
                control.checkpoint()
                self.launcher.start(target_root)
                launched = True
                control.checkpoint()
                health = self.health_checker.check(
                    target_root, timeout_seconds=self.health_timeout_seconds
                )
                control.checkpoint()
                health_summary = health.summary
                if not health.healthy:
                    if swaps:
                        self.launcher.stop(target_root)
                        self._rollback_swaps(target_root, drive.release_id, swaps)
                        self._restore_optional_bytes(
                            target_root / "app" / "backend" / ".env", environment_before
                        )
                        journal.set_phase("rolled-back")
                        raise InstallError("updated runtime failed health checks and was rolled back")
                    journal.set_phase("launch-failed")
                    raise InstallError("installed runtime failed health checks")
            journal.set_phase("complete")
            emit_lifecycle(
                "complete",
                "MedOS is ready",
                completed_bytes=plan.copy_bytes,
                total_bytes=plan.copy_bytes,
                completed_items=total_copy_items,
                total_items=total_copy_items,
            )
            return InstallResult(
                phase=InstallPhase.COMPLETE,
                target_root=target_root,
                release_id=drive.release_id,
                mode=mode,
                copied_bytes=plan.copy_bytes,
                external_bytes=plan.external_bytes,
                external_data_root=drive_root if mode is InstallMode.SPACE_SAVING else None,
                shortcuts=shortcuts,
                health_summary=health_summary,
            )
        except CopyCancelled:
            try:
                if launched and self.launcher is not None:
                    self.launcher.stop(target_root)
                if swaps:
                    self._rollback_swaps(target_root, drive.release_id, swaps)
                    self._restore_optional_bytes(
                        target_root / "app" / "backend" / ".env", environment_before
                    )
                journal.set_phase("rolled-back" if swaps else "paused")
            except (OSError, InstallError, JournalError) as error:
                raise InstallError("safe cancellation rollback failed") from error
            raise
        except InstallError:
            raise
        except (CopyError, JournalError, OSError) as error:
            raise InstallError(str(error)) from error

    @staticmethod
    def _is_launch_critical(record: FileRecord) -> bool:
        target = record.target.as_posix().casefold()
        if record.role in {"launcher", "installer", "config"}:
            return True
        exact = {
            "app/runtime.bin",
            "app/medos_server.mjs",
            "app/.next/build_id",
            "app/.next/.medos-shipped",
            "tools/python/python.exe",
            "tools/node/node.exe",
            "mac/start.sh",
            "mac/runtime-select.sh",
        }
        if target in exact:
            return True
        return record.role == "runtime" and (
            target.endswith("/python/bin/python3")
            or target.endswith("/node/bin/node")
            or "/swc-darwin-" in target and target.endswith(".node")
        )

    def _validate_launch_critical(
        self,
        component: ComponentManifest,
        target_root: Path,
        control: CopyControl,
    ) -> None:
        checked = 0
        for record in component.files:
            if not record.required or not self._is_launch_critical(record):
                continue
            control.checkpoint()
            path = target_root / Path(*record.target.parts)
            try:
                stat_result = path.stat()
            except OSError as error:
                raise InstallError(f"launch-critical file is unavailable: {record.target}") from error
            if not path.is_file() or path.is_symlink() or stat_result.st_size != record.size:
                raise InstallError(f"launch-critical file is invalid: {record.target}")
            if sha256_file(path) != record.sha256:
                raise InstallError(f"launch-critical file hash mismatch: {record.target}")
            checked += 1
        if checked == 0:
            raise InstallError("release manifest has no launch-critical files")

    def _create_shortcuts(self, target_root: Path) -> tuple[Path, ...]:
        try:
            return tuple(Path(path) for path in self.shortcut_manager.create(target_root))
        except (OSError, RuntimeError) as error:
            raise InstallError(str(error) or "could not create the MedOS shortcut") from error

    def _resume_launch_failure(
        self,
        *,
        request: InstallRequest,
        drive_root: Path,
        target_root: Path,
        release_id: str,
        manifest_sha256: str,
        mode: InstallMode,
        component: ComponentManifest,
        journal: Journal,
        emit_lifecycle: Callable[..., None],
        control: CopyControl,
    ) -> InstallResult:
        try:
            journal.assert_compatible(
                release_id=release_id,
                manifest_sha256=manifest_sha256,
                mode=mode,
                target_root=target_root,
            )
            self._write_resume_request(request, drive_root=drive_root, target_root=target_root)
            emit_lifecycle("verifying", "Checking launch-critical MedOS files")
            self._validate_launch_critical(component, target_root, control)
            journal.set_phase("configuring")
            self._write_portable_environment(drive_root, target_root, mode)
            control.checkpoint()
            shortcuts = (
                self._create_shortcuts(target_root)
                if request.launch_after
                else ()
            )
            if self.launcher is None or self.health_checker is None:
                raise InstallError("launch integration is unavailable")
            journal.set_phase("launching")
            emit_lifecycle("starting", "Restarting MedOS without recopying medical data")
            control.checkpoint()
            self.launcher.stop(target_root)
            self.launcher.start(target_root)
            control.checkpoint()
            health = self.health_checker.check(
                target_root, timeout_seconds=self.health_timeout_seconds
            )
            if not health.healthy:
                journal.set_phase("launch-failed")
                raise InstallError("installed runtime failed health checks")
            journal.set_phase("complete")
            emit_lifecycle("complete", "MedOS is ready")
            return InstallResult(
                phase=InstallPhase.COMPLETE,
                target_root=target_root,
                release_id=release_id,
                mode=mode,
                copied_bytes=0,
                external_bytes=0,
                external_data_root=(
                    drive_root
                    if mode in {InstallMode.SPACE_SAVING, InstallMode.PORTABLE}
                    else None
                ),
                shortcuts=shortcuts,
                health_summary=health.summary,
            )
        except (JournalError, OSError) as error:
            raise InstallError(str(error)) from error

    def resume(
        self,
        target_root: Path,
        on_progress: Callable[[ProgressEvent], None],
        control: CopyControl,
    ) -> InstallResult:
        target = Path(target_root).expanduser().resolve(strict=False)
        path = target / ".medos-install" / "resume-request.json"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or frozenset(value) != frozenset(
                {
                    "schema_version",
                    "drive_root",
                    "target_root",
                    "component_id",
                    "mode",
                    "launch_after",
                    "allow_online_repair",
                }
            ):
                raise ValueError("invalid resume request fields")
            if value["schema_version"] != 1 or Path(value["target_root"]).resolve(strict=False) != target:
                raise ValueError("resume request does not match target")
            request = InstallRequest(
                drive_root=Path(value["drive_root"]),
                target_root=target,
                component_id=value["component_id"],
                mode=InstallMode(value["mode"]),
                launch_after=value["launch_after"],
                allow_online_repair=value["allow_online_repair"],
            )
            if not isinstance(request.component_id, str) or not isinstance(request.launch_after, bool):
                raise ValueError("invalid resume request values")
            if not isinstance(request.allow_online_repair, bool):
                raise ValueError("invalid resume request values")
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
            raise InstallError(f"cannot resume install: {path}") from error
        return self.run(request, on_progress, control)

    @staticmethod
    def _load_prior_state(target_root: Path) -> Journal | None:
        path = target_root / ".medos-install" / "install-state.json"
        if not path.is_file():
            return None
        try:
            return Journal.load(target_root)
        except JournalError as error:
            raise InstallError(str(error)) from error

    @staticmethod
    def _journal_for(
        target_root: Path,
        *,
        release_id: str,
        manifest_sha256: str,
        mode: InstallMode,
        prior: Journal | None,
    ) -> Journal:
        if prior is not None:
            prior.assert_compatible(
                release_id=release_id,
                manifest_sha256=manifest_sha256,
                mode=mode,
                target_root=target_root,
            )
            return prior
        state_path = target_root / ".medos-install" / "install-state.json"
        if state_path.is_file():
            history = target_root / ".medos-install" / "history"
            history.mkdir(parents=True, exist_ok=True)
            historical = history / f"install-state-{uuid.uuid4().hex}.json"
            shutil.copy2(state_path, historical)
        return Journal.create(
            target_root,
            release_id=release_id,
            manifest_sha256=manifest_sha256,
            mode=mode,
        )

    @staticmethod
    def _write_resume_request(
        request: InstallRequest, *, drive_root: Path, target_root: Path
    ) -> None:
        path = target_root / ".medos-install" / "resume-request.json"
        value = {
            "schema_version": 1,
            "drive_root": str(drive_root),
            "target_root": str(target_root),
            "component_id": request.component_id,
            "mode": request.mode.value,
            "launch_after": request.launch_after,
            "allow_online_repair": request.allow_online_repair,
        }
        _atomic_write(path, canonical_json_bytes(value))

    def _stage_and_swap(
        self,
        plan: InstallPlan,
        staged_items: tuple[PlannedFile, ...],
        release_id: str,
        manifest_sha256: str,
        on_progress: Callable[[ProgressEvent], None],
        control: CopyControl,
    ) -> list[_Swap]:
        stage_root = plan.target_root / ".medos-install" / "stage" / release_id
        stage_plan_items = tuple(
            PlannedFile(
                record=item.record,
                source_path=item.source_path,
                target_path=stage_root / Path(*item.record.target.parts),
                action=PlanAction.COPY,
            )
            for item in staged_items
        )
        stage_bytes = sum(item.record.size for item in staged_items)
        stage_plan = InstallPlan(
            component_id=plan.component_id,
            source_root=plan.source_root,
            target_root=stage_root,
            mode=plan.mode,
            items=stage_plan_items,
            copy_bytes=stage_bytes,
            external_bytes=0,
            required_bytes=stage_bytes,
        )
        stage_state = stage_root / ".medos-install" / "install-state.json"
        if stage_state.is_file():
            stage_journal = Journal.load(stage_root)
            stage_journal.assert_compatible(
                release_id=release_id,
                manifest_sha256=manifest_sha256,
                mode=plan.mode,
                target_root=stage_root,
            )
        else:
            stage_journal = Journal.create(
                stage_root,
                release_id=release_id,
                manifest_sha256=manifest_sha256,
                mode=plan.mode,
            )
        self.copy_engine.execute(stage_plan, stage_journal, on_progress, control)
        rollback_root = plan.target_root / ".medos-install" / "rollback" / release_id
        swaps: list[_Swap] = []
        try:
            for source_item, stage_item in zip(staged_items, stage_plan_items, strict=True):
                control.checkpoint()
                final = source_item.target_path
                staged = stage_item.target_path
                rollback = rollback_root / Path(*source_item.record.target.parts)
                final.parent.mkdir(parents=True, exist_ok=True)
                rollback_path: Path | None = None
                if final.exists():
                    rollback.parent.mkdir(parents=True, exist_ok=True)
                    if rollback.exists():
                        raise InstallError(
                            f"rollback path already exists: {source_item.record.target}"
                        )
                    os.replace(final, rollback)
                    rollback_path = rollback
                try:
                    os.replace(staged, final)
                except OSError:
                    if (
                        rollback_path is not None
                        and rollback_path.exists()
                        and not final.exists()
                    ):
                        os.replace(rollback_path, final)
                    raise
                swaps.append(
                    _Swap(
                        relative_path=source_item.record.target.as_posix(),
                        final_path=final,
                        rollback_path=rollback_path,
                    )
                )
                control.checkpoint()
        except CopyCancelled:
            self._rollback_swaps(plan.target_root, release_id, swaps)
            raise
        except (OSError, InstallError) as error:
            self._rollback_swaps(plan.target_root, release_id, swaps)
            raise InstallError("runtime swap failed and was rolled back") from error
        return swaps

    @staticmethod
    def _subset_plan(plan: InstallPlan, items: tuple[PlannedFile, ...]) -> InstallPlan:
        copy_bytes = sum(
            item.record.size for item in items if item.action is PlanAction.COPY
        )
        return InstallPlan(
            component_id=plan.component_id,
            source_root=plan.source_root,
            target_root=plan.target_root,
            mode=plan.mode,
            items=items,
            copy_bytes=copy_bytes,
            external_bytes=plan.external_bytes,
            required_bytes=copy_bytes,
        )

    @staticmethod
    def _verify_installed_structure(
        plan: InstallPlan,
        journal: Journal,
        staged_items: tuple[PlannedFile, ...],
        control: CopyControl,
    ) -> None:
        staged_targets = {item.record.target for item in staged_items}
        completed_paths = frozenset(journal.state.completed_paths)
        for item in plan.items:
            control.checkpoint()
            if item.action in {
                PlanAction.PRESERVE_MUTABLE,
                PlanAction.EXTERNAL_DATA,
                PlanAction.SKIP_OPTIONAL,
            }:
                continue
            relative = item.record.target.as_posix()
            if item.action is PlanAction.COPY and relative not in completed_paths:
                raise InstallError(f"copy journal evidence is missing: {item.record.target}")
            path = item.target_path
            try:
                info = path.lstat()
            except OSError as error:
                if item.record.target in staged_targets:
                    raise InstallError(
                        f"staged runtime was not published: {item.record.target}"
                    ) from error
                raise InstallError(
                    f"installed file size is invalid: {item.record.target}"
                ) from error
            attributes = getattr(info, "st_file_attributes", 0)
            reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            if (
                not stat.S_ISREG(info.st_mode)
                or stat.S_ISLNK(info.st_mode)
                or attributes & reparse_flag
                or info.st_size != item.record.size
            ):
                raise InstallError(f"installed file size is invalid: {item.record.target}")

    @staticmethod
    def _rollback_swaps(target_root: Path, release_id: str, swaps: list[_Swap]) -> None:
        failed_root = target_root / ".medos-install" / "failed-release" / release_id
        for swap in reversed(swaps):
            if swap.final_path.exists():
                failed = failed_root / Path(*Path(swap.relative_path).parts)
                failed.parent.mkdir(parents=True, exist_ok=True)
                if failed.exists():
                    failed = failed.with_name(f"{failed.name}-{uuid.uuid4().hex}")
                os.replace(swap.final_path, failed)
            if swap.rollback_path is not None and swap.rollback_path.exists():
                swap.final_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(swap.rollback_path, swap.final_path)

    @staticmethod
    def _read_optional_bytes(path: Path) -> bytes | None:
        try:
            return path.read_bytes()
        except FileNotFoundError:
            return None

    @staticmethod
    def _restore_optional_bytes(path: Path, content: bytes | None) -> None:
        if content is None:
            if path.exists():
                failed = path.parent / f"{path.name}.failed-{uuid.uuid4().hex}"
                os.replace(path, failed)
            return
        _atomic_write(path, content)

    @staticmethod
    def _write_portable_environment(
        drive_root: Path, target_root: Path, mode: InstallMode
    ) -> None:
        source_values = _read_env(drive_root / "app" / "backend" / ".env")
        target_path = target_root / "app" / "backend" / ".env"
        target_values = _read_env(target_path)
        output: dict[str, str] = {}
        if "UTD_PASSWORD" in target_values:
            output["UTD_PASSWORD"] = target_values["UTD_PASSWORD"]
        elif "UTD_PASSWORD" in source_values:
            output["UTD_PASSWORD"] = source_values["UTD_PASSWORD"]
        else:
            output["UTD_PASSWORD"] = ""
        output["MEDOS_SESSION_SECRET"] = target_values.get(
            "MEDOS_SESSION_SECRET", secrets.token_urlsafe(36)
        )
        for key in sorted(_USER_ENV_KEYS - {"UTD_PASSWORD", "MEDOS_SESSION_SECRET"}):
            if key in target_values:
                output[key] = target_values[key]
        if mode is InstallMode.SPACE_SAVING:
            output["MEDOS_ROOT"] = drive_root.as_posix()
        portable_books = (
            drive_root
            / ".medos-payload"
            / "desktop-external"
            / "data"
            / "books"
        )
        if mode in {InstallMode.SPACE_SAVING, InstallMode.PORTABLE} and portable_books.is_dir():
            output["LIBRARY_PATH"] = portable_books.as_posix()
        lines = [f"{key}={value}" for key, value in output.items()]
        _atomic_write(target_path, ("\n".join(lines) + "\n").encode("utf-8"))


def _read_env(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError) as error:
        raise InstallError(f"cannot read environment file: {path}") from error
    values: dict[str, str] = {}
    for line in lines:
        candidate = line.strip()
        if not candidate or candidate.startswith("#") or "=" not in candidate:
            continue
        key, value = candidate.split("=", 1)
        key = key.strip()
        if _ENV_KEY_RE.fullmatch(key) is None:
            continue
        value = value.strip()
        if "\n" in value or "\r" in value:
            raise InstallError(f"invalid environment value for {key}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def _atomic_write(path: Path, content: bytes) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4().hex}")
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)  # type: ignore[possibly-undefined]
        except (OSError, UnboundLocalError):
            pass
        raise InstallError(f"cannot write file atomically: {path}") from error


__all__ = [
    "InstallError",
    "InstallPhase",
    "InstallRequest",
    "InstallResult",
    "Installer",
]

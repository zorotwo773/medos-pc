"""Command-line and browser-service entry points for MedOS Setup Center."""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import sys
import threading
import time
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Sequence

from .copy_engine import CopyControl
from .diagnostics import create_diagnostic_bundle
from .health import HealthChecker, PlatformLauncher
from .install import InstallRequest, Installer
from .manifest import (
    ManifestError,
    load_component_manifest,
    load_drive_manifest,
    sha256_file,
)
from .planner import (
    INCOMPLETE_EXTRACTION_HINT,
    InstallMode,
    PlanningError,
    SourceCheck,
    build_install_plan,
    estimate_install_bytes,
    validate_destination,
)
from .platforms import (
    PlatformError,
    PlatformInfo,
    default_install_root,
    detect_platform,
    enumerate_destinations,
    probe_free_bytes,
)
from .portable import PortableActivationRequest, PortableActivator
from .progress import MacroProgressEmitter, ProgressEvent
from .repair import RepairEngine
from .shortcuts import PlatformShortcutManager
from .server import ServiceRegistry, start_server


_SENSITIVE_RE = re.compile(
    r"(?i)(?:secret|token|password|api[_-]?key|authorization|cookie)\s*[=:]\s*[^\s,;]+"
)

# The engine's refusals are written for engineers. The wizard shows these
# instead, keyed by the stable code the planner attaches.
_DESTINATION_REFUSALS = {
    "destination-overlaps-source": (
        "This is the drive MedOS is running from, so it cannot also be the destination. "
        "Choose another disk, or pick Run from this folder instead."
    ),
    "destination-is-source-volume": (
        "This destination is on the same disk as the MedOS release. Choose another disk, "
        "or pick Run from this folder to avoid making a second copy."
    ),
    "destination-has-other-files": (
        "This folder already holds other files and MedOS will not overwrite them. "
        "Choose another disk, or empty this folder first."
    ),
    "destination-is-root": (
        "MedOS cannot install directly onto the top of a drive. Choose another destination."
    ),
    "destination-is-home": (
        "MedOS cannot install over your home folder. Choose another destination."
    ),
    "destination-not-a-folder": "A file already exists at this path, so MedOS cannot use it.",
    "destination-is-link": (
        "This path leads through a shortcut or link, which MedOS cannot install into."
    ),
    "destination-unreadable": (
        "MedOS cannot read this location. Check that the disk is connected and that you "
        "have permission to write to it."
    ),
}

_MODE_LABELS = {
    InstallMode.FULL: "Full install",
    InstallMode.SPACE_SAVING: "Space-saving install",
    InstallMode.PORTABLE: "Run from this folder",
}

_MODE_DESCRIPTIONS = {
    InstallMode.FULL: (
        "Copies MedOS and all medical data onto the destination. "
        "You can then unplug the drive."
    ),
    InstallMode.SPACE_SAVING: (
        "Copies only the app onto the destination and reads medical data from "
        "this drive. Needs far less space, but the drive must stay connected."
    ),
    InstallMode.PORTABLE: (
        "Copies nothing and runs MedOS from this folder. Best when you unpacked "
        "a download or want to use MedOS straight from the drive."
    ),
}


class CliError(RuntimeError):
    """Raised for safe, user-actionable CLI failures."""


def _safe_message(error: BaseException) -> str:
    first = str(error).replace("\r", "\n").split("\n", 1)[0].strip()
    return _SENSITIVE_RE.sub("[REDACTED]", first or error.__class__.__name__)[:500]


def _json_value(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return {field.name: _json_value(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_value(item) for item in value]
    return value


def _write_result(value: Any, *, json_output: bool) -> None:
    normalized = _json_value(value)
    if json_output:
        print(json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return
    if isinstance(normalized, dict):
        for key, item in normalized.items():
            label = key.replace("_", " ").capitalize()
            print(f"{label}: {item}")
    else:
        print(normalized)


def _component(drive_root: Path, component_id: str):
    component_cache = {}
    drive = load_drive_manifest(drive_root, component_cache=component_cache)
    try:
        reference = next(item for item in drive.components if item.component_id == component_id)
    except StopIteration as error:
        raise CliError(f"release component is unavailable: {component_id}") from error
    component_path = (drive_root / Path(*reference.manifest.parts)).resolve(strict=True)
    manifest = component_cache[component_path]
    return drive, reference, manifest


def verify_drive(
    drive_root: Path,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    control: CopyControl | None = None,
) -> dict[str, Any]:
    """Verify every required source artifact for every component on the SSD."""

    root = Path(drive_root).expanduser().resolve(strict=True)
    component_cache = {}
    checkpoint = control.checkpoint if control is not None else None
    drive = load_drive_manifest(
        root,
        component_cache=component_cache,
        checkpoint=checkpoint,
    )
    components = tuple(
        component_cache[(root / Path(*reference.manifest.parts)).resolve(strict=True)]
        for reference in drive.components
    )
    prepared_report = None
    prepared_inventory = None
    supplemental_items = 0
    supplemental_bytes = 0
    if (root / ".medos-setup" / "preparation-report.json").is_file():
        from .prepare import load_prepared_artifact_inventory

        prepared_report, prepared_inventory = load_prepared_artifact_inventory(root, drive=drive)
        supplemental_items = len(prepared_inventory)
        supplemental_bytes = sum(int(item["size"]) for item in prepared_inventory)
    total_items = sum(len(component.files) for component in components) + supplemental_items
    total_bytes = (
        sum(record.size for component in components for record in component.files)
        + supplemental_bytes
    )
    progress = (
        MacroProgressEmitter(on_progress, clock=time.monotonic)
        if on_progress is not None
        else None
    )

    def emit_progress(
        completed_items: int,
        completed_bytes: int,
        *,
        current_total: int = 0,
    ) -> None:
        if progress is None:
            return
        progress.emit(
            ProgressEvent(
                phase="verifying-ssd",
                message="Verifying this MedOS SSD",
                relative_path="",
                completed_bytes=completed_bytes,
                total_bytes=total_bytes,
                current_bytes=current_total,
                current_total=current_total,
                completed_items=completed_items,
                total_items=total_items,
                bytes_per_second=0.0,
                eta_seconds=None,
            ),
            force=completed_items == 0 and completed_bytes == 0,
        )

    file_count = 0
    verified_bytes = 0
    checked_items = 0
    checked_bytes = 0
    optional_missing = 0
    emit_progress(checked_items, checked_bytes)
    for component in components:
        for record in component.files:
            if control is not None:
                control.checkpoint()
            source_input = root / Path(*record.source.parts)
            try:
                source = source_input.resolve(strict=True)
                source.relative_to(root)
            except (OSError, ValueError) as error:
                if not record.required and not source_input.exists():
                    optional_missing += 1
                    checked_items += 1
                    checked_bytes += record.size
                    emit_progress(checked_items, checked_bytes, current_total=record.size)
                    continue
                raise CliError(
                    f"required source is missing or unsafe: {record.source}. "
                    f"{INCOMPLETE_EXTRACTION_HINT}"
                ) from error
            if not source.is_file() or source_input.is_symlink():
                raise CliError(f"release source is not a regular file: {record.source}")
            size = source.stat().st_size
            if size != record.size:
                raise CliError(
                    f"source size mismatch: {record.source}. {INCOMPLETE_EXTRACTION_HINT}"
                )
            digest = hashlib.sha256()
            file_hashed = 0
            try:
                with source.open("rb") as handle:
                    while chunk := handle.read(1024 * 1024):
                        if control is not None:
                            control.checkpoint()
                        digest.update(chunk)
                        file_hashed += len(chunk)
                        checked_bytes += len(chunk)
                        if file_hashed < record.size:
                            emit_progress(checked_items, checked_bytes, current_total=record.size)
            except OSError as error:
                raise CliError(f"cannot verify release source: {record.source}") from error
            if digest.hexdigest() != record.sha256:
                raise CliError(f"source hash mismatch: {record.source}")
            file_count += 1
            verified_bytes += size
            checked_items += 1
            emit_progress(checked_items, checked_bytes, current_total=size)
    supplemental: dict[str, int] = {}
    if prepared_inventory is not None and prepared_report is not None:
        from .prepare import verify_prepared_artifacts

        def artifact_bytes(count: int) -> None:
            nonlocal checked_bytes
            checked_bytes += count
            emit_progress(checked_items, checked_bytes)

        def artifact_complete() -> None:
            nonlocal checked_items
            checked_items += 1
            emit_progress(checked_items, checked_bytes)

        supplemental = verify_prepared_artifacts(
            root,
            drive=drive,
            inventory=prepared_inventory,
            report=prepared_report,
            on_bytes=artifact_bytes,
            on_artifact=artifact_complete,
            checkpoint=checkpoint,
            component=next(
                (
                    component
                    for component in components
                    if component.component_id == prepared_report["component_id"]
                ),
                None,
            ),
        )
    return {
        "phase": "verify",
        "ready": True,
        "drive_id": drive.drive_id,
        "release_id": drive.release_id,
        "component_count": len(drive.components),
        "file_count": file_count,
        "verified_bytes": verified_bytes,
        "optional_missing": optional_missing,
        **supplemental,
    }


class SetupServices:
    """Adapt the core engine to the narrow browser and CLI service contracts."""

    def __init__(
        self,
        drive_root: Path,
        *,
        platform_info: PlatformInfo | None = None,
        reserve_bytes: int = 1024 * 1024 * 1024,
    ) -> None:
        if reserve_bytes < 0:
            raise ValueError("reserve_bytes must be non-negative")
        self.drive_root = Path(drive_root).expanduser().resolve(strict=True)
        self.platform_info = platform_info or detect_platform()
        self.reserve_bytes = reserve_bytes
        self.launcher = PlatformLauncher(platform_info=self.platform_info)
        self.health_checker = HealthChecker(
            platform_info=self.platform_info,
            launcher=self.launcher,
        )
        self._mode_requirement_cache: list[dict[str, Any]] | None = None

    def registry(self) -> ServiceRegistry:
        return ServiceRegistry(
            preflight=self.preflight,
            verify=self.verify,
            install=self.install,
            start_medos=self.start_medos,
            resume=self.resume_install,
            repair=self.repair,
            diagnostics=self.diagnostics,
            recommended_target=self.recommended_target,
            destinations=self.destinations,
        )

    def destinations(self) -> dict[str, Any]:
        """List install destinations and which modes fit on each.

        The browser picks a destination by the id issued here, so the server
        never has to trust a filesystem path that arrived over HTTP.
        """

        modes = self._mode_requirements()
        entries: list[dict[str, Any]] = []
        for candidate in enumerate_destinations(self.platform_info):
            unusable: str | None = None
            try:
                validate_destination(
                    self.drive_root,
                    candidate.path,
                    home=self.platform_info.home,
                    refuse_source_volume=True,
                )
            except (PlanningError, PlatformError) as error:
                code = getattr(error, "code", "")
                unusable = _DESTINATION_REFUSALS.get(code, str(error))
            entries.append(
                {
                    "id": candidate.id,
                    "label": candidate.label,
                    "path": str(candidate.path),
                    "free_bytes": candidate.free_bytes,
                    "total_bytes": candidate.total_bytes,
                    "filesystem": candidate.filesystem,
                    "recommended": candidate.recommended,
                    "unusable": unusable,
                    "fits": {
                        mode["id"]: (
                            unusable is None
                            and candidate.free_bytes
                            >= mode["required_bytes"] + self.reserve_bytes
                        )
                        for mode in modes
                        if mode["id"] != InstallMode.PORTABLE.value
                    },
                }
            )
        return {
            "phase": "destinations",
            "system": self.platform_info.system,
            "architecture": self.platform_info.architecture,
            "platform": f"{self.platform_info.system} {self.platform_info.architecture}",
            "release_root": str(self.drive_root),
            "reserve_bytes": self.reserve_bytes,
            "modes": modes,
            "destinations": entries,
        }

    def _mode_requirements(self) -> list[dict[str, Any]]:
        """Return each mode with the bytes it needs, parsing the manifest once.

        Reading a 200,000 file manifest takes tens of seconds, so the result is
        memoized: the wizard asks for destinations on every render.
        """

        if self._mode_requirement_cache is not None:
            return [dict(item) for item in self._mode_requirement_cache]

        _, _, component = _component(self.drive_root, "desktop-core")
        modes: list[dict[str, Any]] = []
        for mode in (InstallMode.FULL, InstallMode.SPACE_SAVING, InstallMode.PORTABLE):
            try:
                _, external, required = estimate_install_bytes(
                    component,
                    mode,
                    platform_info=self.platform_info,
                )
            except (PlanningError, PlatformError) as error:
                raise CliError(
                    f"cannot work out what {_MODE_LABELS[mode]} needs: {error}"
                ) from error
            modes.append(
                {
                    "id": mode.value,
                    "label": _MODE_LABELS[mode],
                    "description": _MODE_DESCRIPTIONS[mode],
                    "required_bytes": required,
                    "external_bytes": external,
                }
            )
        self._mode_requirement_cache = [dict(item) for item in modes]
        return modes

    def _destination_from_id(self, value: str) -> Path:
        for candidate in enumerate_destinations(self.platform_info):
            if candidate.id == value:
                return candidate.path
        raise CliError(
            "that destination is no longer available; refresh the page and choose again"
        )

    def recommended_target(self) -> dict[str, Any]:
        """Return device-local metadata without reading any release manifest."""

        return {
            "phase": "recommended-target",
            "platform": f"{self.platform_info.system} {self.platform_info.architecture}",
            "architecture": self.platform_info.architecture,
            "default_target": str(default_install_root(self.platform_info).expanduser().resolve(strict=False)),
        }

    def _mode(self, payload: dict[str, Any]) -> InstallMode:
        try:
            return InstallMode(payload.get("mode", InstallMode.FULL.value))
        except ValueError as error:
            raise CliError("choose full, space-saving, or portable mode") from error

    def _component_id(self, payload: dict[str, Any]) -> str:
        value = payload.get("component_id", "desktop-core")
        if not isinstance(value, str) or not value:
            raise CliError("component_id is required")
        return value

    def _target(self, payload: dict[str, Any], mode: InstallMode) -> Path:
        if mode is InstallMode.PORTABLE:
            return self.drive_root
        chosen = payload.get("destination_id")
        if chosen is not None:
            if not isinstance(chosen, str) or not chosen.strip():
                raise CliError("destination_id must be a destination id from this page")
            target = self._destination_from_id(chosen.strip()).expanduser().resolve(strict=False)
            try:
                validate_destination(
                    self.drive_root,
                    target,
                    home=self.platform_info.home,
                    refuse_source_volume=True,
                )
            except PlanningError as error:
                raise CliError(_DESTINATION_REFUSALS.get(error.code, str(error))) from error
            return target
        # Raw paths remain available to the CLI, which is trusted. The setup
        # server strips this key before it reaches here, so a page cannot
        # nominate an arbitrary filesystem location.
        value = payload.get("target")
        if isinstance(value, str) and value.strip():
            return Path(value).expanduser().resolve(strict=False)
        return default_install_root(self.platform_info).expanduser().resolve(strict=False)

    def preflight(self, payload: dict[str, Any]) -> dict[str, Any]:
        device = payload.get("device", "desktop")
        if device == "android":
            from .android import verify_android_kit

            drive = load_drive_manifest(self.drive_root)
            report = verify_android_kit(self.drive_root / "ANDROID - COPY TO PHONE")
            warning_checks = tuple(
                {"name": "metadata-warning", "ok": True, "message": warning}
                for warning in report.warnings
            )
            return {
                "phase": "preflight",
                "ready": report.ready,
                "device": "android",
                "platform": f"{self.platform_info.system} {self.platform_info.architecture}",
                "release_id": drive.release_id,
                "kit_root": str(report.kit_root),
                "guide": str(report.kit_root / "START HERE - ANDROID.html"),
                "version_name": report.metadata.version_name,
                "version_code": report.metadata.version_code,
                "data_file_count": report.data_file_count,
                "data_bytes": report.data_uncompressed_bytes,
                "summary": "The signed MedOS APK and phone-data ZIP are verified and ready to copy.",
                "checks": (
                    {"name": "apk", "ok": True, "message": "The APK hash, package identity, version, and recorded signature match."},
                    {"name": "phone-data", "ok": True, "message": f"The safe data ZIP contains {report.data_file_count} file(s)."},
                    {"name": "guide", "ok": True, "message": "Open START HERE - ANDROID.html in the Android kit and follow the copy/import steps."},
                )
                + warning_checks,
            }
        if device == "verify":
            raise CliError("Full SSD verification must be started as a verification operation")
        mode = self._mode(payload)
        target = self._target(payload, mode)
        drive, _, component = _component(self.drive_root, self._component_id(payload))
        plan = build_install_plan(
            component,
            self.drive_root,
            target,
            mode,
            free_bytes=probe_free_bytes(target),
            reserve_bytes=self.reserve_bytes,
            platform_info=self.platform_info,
            source_check=SourceCheck.DEFERRED,
        )
        preserved = sum(1 for item in plan.items if item.action.value == "preserve-mutable")
        return {
            "phase": "preflight",
            "ready": True,
            "device": device,
            "platform": f"{self.platform_info.system} {self.platform_info.architecture}",
            "architecture": self.platform_info.architecture,
            "release_id": drive.release_id,
            "component_id": component.component_id,
            "mode": mode.value,
            "target": str(target),
            "default_target": str(default_install_root(self.platform_info)),
            "copy_bytes": plan.copy_bytes,
            "external_bytes": plan.external_bytes,
            "required_bytes": plan.required_bytes,
            "preserved_file_count": preserved,
            "summary": "The SSD, destination, permissions, and free space are ready.",
            "checks": (
                {"name": "manifest", "ok": True, "message": "Installer manifests and payload paths are valid; files are verified while copying."},
                {"name": "destination", "ok": True, "message": "The selected destination is safe and writable."},
                {"name": "space", "ok": True, "message": f"Enough free space is available for {plan.required_bytes} bytes."},
                {"name": "preservation", "ok": True, "message": f"{preserved} existing mutable file(s) will be preserved."},
            ),
        }

    def _installer(self) -> Installer:
        return Installer(
            platform_info=self.platform_info,
            reserve_bytes=self.reserve_bytes,
            launcher=self.launcher,
            health_checker=self.health_checker,
            shortcut_manager=PlatformShortcutManager(self.platform_info),
        )

    def _portable_activator(self) -> PortableActivator:
        return PortableActivator(
            platform_info=self.platform_info,
            launcher=self.launcher,
            health_checker=self.health_checker,
            shortcut_manager=PlatformShortcutManager(self.platform_info),
        )

    def install(
        self,
        payload: dict[str, Any],
        emit,
        control: CopyControl,
    ) -> dict[str, Any]:
        mode = self._mode(payload)
        target = self._target(payload, mode)
        launch_after = payload.get("launch_after", True)
        if not isinstance(launch_after, bool):
            raise CliError("launch_after must be true or false")
        if mode is InstallMode.PORTABLE:
            result = self._portable_activator().activate(
                PortableActivationRequest(
                    release_root=self.drive_root,
                    component_id=self._component_id(payload),
                    open_after=launch_after,
                ),
                emit,
                control,
            )
            return {
                "phase": result.phase,
                "target": str(result.release_root),
                "release_id": result.release_id,
                "mode": mode.value,
                "copied_bytes": 0,
                "external_bytes": 0,
                "data_root": str(result.release_root),
                "portable_state_root": str(result.state_root),
                "shortcuts": (str(result.shortcut),),
                "health": result.health_summary or "Activated without launch check",
                "open_url": "http://127.0.0.1:3000/" if launch_after else None,
            }
        request = InstallRequest(
            drive_root=self.drive_root,
            target_root=target,
            component_id=self._component_id(payload),
            mode=mode,
            launch_after=launch_after,
            allow_online_repair=False,
        )
        result = self._installer().run(request, emit, control)
        return {
            "phase": result.phase.value,
            "target": str(result.target_root),
            "release_id": result.release_id,
            "mode": result.mode.value,
            "copied_bytes": result.copied_bytes,
            "external_bytes": result.external_bytes,
            "data_root": str(result.external_data_root or result.target_root),
            "shortcuts": tuple(str(path) for path in result.shortcuts),
            "health": result.health_summary or "Installed without launch check",
            "open_url": "http://127.0.0.1:3000/" if launch_after else None,
        }

    def verify(
        self,
        payload: dict[str, Any],
        emit,
        control: CopyControl,
    ) -> dict[str, Any]:
        del payload
        return verify_drive(self.drive_root, on_progress=emit, control=control)

    def resume(self, target: Path, emit, control: CopyControl) -> dict[str, Any]:
        result = self._installer().resume(target, emit, control)
        return {
            "phase": result.phase.value,
            "target": str(result.target_root),
            "release_id": result.release_id,
            "mode": result.mode.value,
            "copied_bytes": result.copied_bytes,
            "external_bytes": result.external_bytes,
            "data_root": str(result.external_data_root or result.target_root),
            "shortcuts": tuple(str(path) for path in result.shortcuts),
            "health": result.health_summary,
            "open_url": "http://127.0.0.1:3000/",
        }

    def start_medos(
        self,
        payload: dict[str, Any],
        emit,
        control: CopyControl,
    ) -> dict[str, Any]:
        del payload
        return self.install(
            {
                "mode": InstallMode.PORTABLE.value,
                "component_id": "desktop-core",
                "launch_after": True,
            },
            emit,
            control,
        )

    def resume_install(
        self,
        payload: dict[str, Any],
        emit,
        control: CopyControl,
    ) -> dict[str, Any]:
        mode = self._mode(payload)
        if mode is InstallMode.PORTABLE:
            return self.install(payload, emit, control)
        return self.resume(self._target(payload, mode), emit, control)

    def repair(self, payload: dict[str, Any], emit, control: CopyControl) -> dict[str, Any]:
        control.checkpoint()
        mode = self._mode(payload)
        target = self._target(payload, mode)
        _, _, component = _component(self.drive_root, self._component_id(payload))
        emit(ProgressEvent(
            phase="diagnosing",
            message="Checking the installed MedOS services and launch files",
            relative_path="",
            completed_bytes=0,
            total_bytes=0,
            current_bytes=0,
            current_total=0,
            completed_items=0,
            total_items=0,
            bytes_per_second=0.0,
            eta_seconds=None,
        ))
        report = self.health_checker.check(target, launch=False, timeout_seconds=5.0)
        if report.healthy:
            return {
                "phase": "complete",
                "target": str(target),
                "health": report.summary,
                "summary": "MedOS is already healthy; no files were replaced.",
            }
        control.checkpoint()
        engine = RepairEngine(component=component, health_checker=self.health_checker)
        emit(ProgressEvent(
            phase="repairing",
            message="Repairing bounded managed launch files",
            relative_path="",
            completed_bytes=0,
            total_bytes=0,
            current_bytes=0,
            current_total=0,
            completed_items=0,
            total_items=0,
            bytes_per_second=0.0,
            eta_seconds=None,
        ))
        result = engine.repair(target, report.issues, source_root=self.drive_root)
        return {
            "phase": "complete" if result.health_report.healthy else "failed",
            "target": str(target),
            "health": result.health_report.summary,
            "summary": f"Applied {len(result.actions)} bounded repair action(s).",
            "actions": result.actions,
        }

    def diagnostics(self, payload: dict[str, Any], emit, control: CopyControl) -> dict[str, Any]:
        control.checkpoint()
        mode = self._mode(payload)
        target = self._target(payload, mode)
        report = self.health_checker.check(target, launch=False, timeout_seconds=2.0)
        output_value = payload.get("output")
        output = (
            Path(output_value).expanduser().resolve(strict=False)
            if isinstance(output_value, str) and output_value.strip()
            else target / ".medos-install" / "diagnostics.zip"
        )
        emit(ProgressEvent(
            phase="diagnostics",
            message="Collecting privacy-filtered setup diagnostics",
            relative_path="",
            completed_bytes=0,
            total_bytes=0,
            current_bytes=0,
            current_total=0,
            completed_items=0,
            total_items=0,
            bytes_per_second=0.0,
            eta_seconds=None,
        ))
        path = create_diagnostic_bundle(target, report, output)
        return {
            "phase": "complete",
            "target": str(target),
            "path": str(path),
            "health": report.summary,
            "summary": "Privacy-filtered diagnostics were saved.",
        }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="medos-setup",
        description="Offline-first MedOS installation, verification, and recovery center.",
    )
    parser.add_argument("--version", action="version", version="MedOS Setup Center 0.1.0")
    commands = parser.add_subparsers(dest="command", required=True)

    def drive(command: str, help_text: str) -> argparse.ArgumentParser:
        item = commands.add_parser(command, help=help_text)
        item.add_argument("--drive-root", type=Path, required=True)
        item.add_argument("--json", action="store_true", dest="json_output")
        return item

    def target(item: argparse.ArgumentParser, *, optional: bool = False) -> None:
        item.add_argument("--target", type=Path, required=not optional)
        item.add_argument("--component", default="desktop-core")
        item.add_argument("--mode", choices=[mode.value for mode in InstallMode], default="full")
        item.add_argument("--reserve-bytes", type=int, default=1024 * 1024 * 1024, help=argparse.SUPPRESS)

    serve = drive("serve", "open the authenticated local setup wizard")
    serve.add_argument("--no-browser", action="store_true")

    preflight = drive("preflight", "check a destination without changing it")
    target(preflight, optional=True)

    install = drive("install", "install or update MedOS")
    target(install)
    install.add_argument("--no-launch", action="store_true")

    resume = drive("resume", "resume an interrupted verified copy")
    resume.add_argument("--target", type=Path, required=True)
    resume.add_argument("--reserve-bytes", type=int, default=1024 * 1024 * 1024, help=argparse.SUPPRESS)

    drive("verify", "verify every SSD manifest and payload file")

    repair = drive("repair", "diagnose and safely repair a managed install")
    target(repair)

    diagnostics = drive("diagnostics", "save a privacy-filtered diagnostic bundle")
    target(diagnostics)
    diagnostics.add_argument("--output", type=Path)

    android = drive("android", "verify or install the Android transfer kit")
    android.add_argument("--serial")

    prepare = drive("prepare-drive", "prepare deterministic SSD release artifacts")
    prepare.add_argument("--source-root", type=Path)
    prepare.add_argument("--mac-tools-root", type=Path, required=True)
    prepare.add_argument("--apk", type=Path)
    prepare.add_argument("--phone-data-zip", type=Path)
    prepare.add_argument("--drive-id", default="medos-setup-drive")
    prepare.add_argument("--release-id", required=True)
    prepare.add_argument("--component", default="desktop-core")
    prepare.add_argument("--release-stage-manifest", type=Path)

    reseal = drive(
        "reseal-installer",
        "re-record installer file hashes after a hotfix so verification passes",
    )
    reseal.add_argument(
        "--path",
        action="append",
        dest="paths",
        metavar="ARTIFACT",
        help="artifact path a hotfix replaced, e.g. setup_center (repeatable)",
    )

    smoke = drive("smoke-test", "run non-destructive release checks")
    smoke.add_argument("--target", type=Path)
    return parser


def _progress(json_output: bool):
    if json_output:
        return lambda event: None

    def write(event: ProgressEvent) -> None:
        total = max(0, event.total_bytes)
        percent = int((event.completed_bytes / total) * 100) if total else 0
        rate = f"{event.bytes_per_second / (1024 * 1024):.1f} MiB/s"
        eta = "calculating ETA" if event.eta_seconds is None else f"ETA {int(event.eta_seconds)}s"
        print(
            f"\r{event.message}: {percent:3d}% {event.completed_bytes}/{total} bytes "
            f"{rate}, {eta}",
            end="",
            file=sys.stderr,
            flush=True,
        )

    return write


def _payload(arguments: argparse.Namespace) -> dict[str, Any]:
    result: dict[str, Any] = {
        "component_id": getattr(arguments, "component", "desktop-core"),
        "mode": getattr(arguments, "mode", "full"),
    }
    target = getattr(arguments, "target", None)
    if target is not None:
        result["target"] = str(target)
    return result


def _run(arguments: argparse.Namespace) -> Any:
    command = arguments.command
    if command == "verify" or command == "smoke-test":
        result = verify_drive(arguments.drive_root)
        if command == "smoke-test":
            result = {**result, "phase": "smoke-test"}
        return result
    if command == "reseal-installer":
        try:
            from .prepare import PrepareError, reseal_installer_artifacts
        except ImportError as error:
            raise CliError("drive preparation support is unavailable in this Setup Center build") from error
        if not arguments.paths:
            raise CliError(
                "name at least one replaced installer file with --path, "
                "for example --path setup_center"
            )
        try:
            resealed = reseal_installer_artifacts(arguments.drive_root, arguments.paths)
        except PrepareError as error:
            raise CliError(str(error)) from error
        return {
            "phase": "reseal-installer",
            "resealed": [dict(item) for item in resealed],
        }
    if command == "android":
        try:
            from .android import verify_android_kit
        except ImportError as error:
            raise CliError("Android kit support is unavailable in this Setup Center build") from error
        return verify_android_kit(Path(arguments.drive_root) / "ANDROID - COPY TO PHONE")
    if command == "prepare-drive":
        try:
            from .prepare import PrepareConfig, prepare_drive
        except ImportError as error:
            raise CliError("drive preparation support is unavailable in this Setup Center build") from error
        source_root = arguments.source_root or arguments.drive_root
        return prepare_drive(
            PrepareConfig(
                source_root=source_root,
                drive_root=arguments.drive_root,
                mac_tools_root=arguments.mac_tools_root,
                apk_path=arguments.apk or source_root / "MedOS.apk",
                phone_data_zip=(
                    arguments.phone_data_zip
                    or source_root / "phone" / "build" / "medos-phone-data.zip"
                ),
                drive_id=arguments.drive_id,
                release_id=arguments.release_id,
                component_id=arguments.component,
                release_stage_manifest=arguments.release_stage_manifest,
            )
        )

    services = SetupServices(
        arguments.drive_root,
        reserve_bytes=getattr(arguments, "reserve_bytes", 1024 * 1024 * 1024),
    )
    if command == "serve":
        server = start_server(services.registry(), browser=not arguments.no_browser)
        if arguments.json_output:
            _write_result(
                {"phase": "serve", "url": server.address.session_url},
                json_output=True,
            )
        else:
            print("MedOS Setup Center is running. Close this window when setup is finished.")
            print(server.address.session_url)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            return {"phase": "stopped"}
        finally:
            server.close()
    if command == "preflight":
        return services.preflight(_payload(arguments))
    control = CopyControl()
    if command == "install":
        value = _payload(arguments)
        value["launch_after"] = not arguments.no_launch
        return services.install(value, _progress(arguments.json_output), control)
    if command == "resume":
        return services.resume(arguments.target, _progress(arguments.json_output), control)
    if command == "repair":
        return services.repair(_payload(arguments), _progress(arguments.json_output), control)
    if command == "diagnostics":
        value = _payload(arguments)
        if arguments.output is not None:
            value["output"] = str(arguments.output)
        return services.diagnostics(value, _progress(arguments.json_output), control)
    raise CliError(f"unsupported command: {command}")


def main(argv: Sequence[str] | None = None) -> int:
    """Run Setup Center without leaking tracebacks or secrets to end users."""

    parser = _parser()
    try:
        arguments = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit as error:
        return int(error.code or 0)
    try:
        result = _run(arguments)
        if arguments.command != "serve":
            _write_result(result, json_output=arguments.json_output)
        return 0
    except (CliError, ManifestError, OSError, RuntimeError, ValueError) as error:
        message = _safe_message(error)
        if getattr(arguments, "json_output", False):
            print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
        else:
            print(f"MedOS Setup stopped safely: {message}", file=sys.stderr)
        return 2


__all__ = ["CliError", "SetupServices", "main", "verify_drive"]

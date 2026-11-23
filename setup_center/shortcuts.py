"""Create one owned, platform-native MedOS launcher for the current user."""

from __future__ import annotations

import base64
import os
import plistlib
import shutil
import stat
import subprocess
import uuid
from pathlib import Path
from typing import Callable

from .platforms import PlatformInfo, detect_platform


_BUNDLE_IDENTIFIER = "org.medos.desktop"
_OWNED_BUNDLE_IDENTIFIERS = frozenset({_BUNDLE_IDENTIFIER, "local.medos.launcher"})
_MAC_EXECUTABLE = """#!/bin/sh
set -eu
show_error() {
  /bin/echo "MedOS: $1" >&2
  /usr/bin/osascript - "$1" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run arguments
  display dialog (item 1 of arguments) with title "MedOS" buttons {"OK"} default button "OK" with icon stop
end run
APPLESCRIPT
}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RESOURCE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../Resources" && pwd)
if ! IFS= read -r TARGET_ROOT < "$RESOURCE_DIR/target-root"; then
  show_error "This MedOS shortcut is incomplete. Open MedOS.command in the complete MedOS folder, or run Setup Center again to recreate the shortcut."
  exit 2
fi
case "$TARGET_ROOT" in
  /*) ;;
  *)
    show_error "This MedOS shortcut has an invalid folder location. Open MedOS.command in the complete MedOS folder, or run Setup Center again to recreate the shortcut."
    exit 64 ;;
esac
if [ ! -r "$TARGET_ROOT/mac/start.sh" ]; then
  show_error "MedOS cannot find its launch files. Open MedOS.command in the complete MedOS folder. If that folder was moved, run Setup Center there to recreate the shortcut; if its drive is disconnected, reconnect it."
  exit 2
fi
if /bin/bash "$TARGET_ROOT/mac/start.sh" --no-browser "$@"; then
  /usr/bin/open "http://127.0.0.1:3000" >/dev/null 2>&1 || true
  exit 0
else
  STATUS=$?
  show_error "MedOS could not start (exit $STATUS). Open MedOS.command in the MedOS folder to see the error, or use Save diagnostics in Setup Center."
  exit "$STATUS"
fi
"""
_WINDOWS_LINK_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:MEDOS_SHORTCUT_PATH)
$shortcut.TargetPath = $env:MEDOS_POWERSHELL_PATH
$quotedLauncher = '"' + $env:MEDOS_START_PATH.Replace('"', '""') + '"'
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File ' + $quotedLauncher
$shortcut.WorkingDirectory = $env:MEDOS_WORKING_DIRECTORY
$shortcut.IconLocation = $env:MEDOS_ICON_PATH + ',0'
$shortcut.Description = 'Start MedOS'
$shortcut.Save()
"""


class ShortcutError(RuntimeError):
    """Raised when an owned launcher cannot be created safely."""


WindowsLinkWriter = Callable[[Path, Path, Path, Path], None]


class PlatformShortcutManager:
    """Create one MedOS shortcut; stopping remains an internal app action."""

    def __init__(
        self,
        platform_info: PlatformInfo | None = None,
        *,
        windows_link_writer: WindowsLinkWriter | None = None,
        icon_bytes: bytes | None = None,
    ) -> None:
        self.platform_info = platform_info or detect_platform()
        self.windows_link_writer = windows_link_writer or self._write_windows_link
        self._icon_bytes = icon_bytes

    def create(self, target_root: Path) -> tuple[Path, ...]:
        root = self._normal_target(target_root)
        if self.platform_info.system == "windows":
            return (self._create_windows(root),)
        if self.platform_info.system == "macos":
            return (self._create_macos(root),)
        raise ShortcutError(f"unsupported shortcut platform: {self.platform_info.system}")

    @staticmethod
    def _normal_target(target_root: Path) -> Path:
        lexical = Path(target_root).expanduser()
        if lexical.is_symlink():
            raise ShortcutError("MedOS target must not be a symlink")
        try:
            root = lexical.resolve(strict=True)
        except OSError as error:
            raise ShortcutError("MedOS target is unavailable") from error
        if not root.is_dir():
            raise ShortcutError("MedOS target is not a directory")
        return root

    @staticmethod
    def _required_file(root: Path, relative: str) -> Path:
        candidate = root / Path(*relative.split("/"))
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
            info = candidate.lstat()
        except (OSError, ValueError) as error:
            raise ShortcutError(f"required launcher is unavailable: {relative}") from error
        if candidate.is_symlink() or not stat.S_ISREG(info.st_mode):
            raise ShortcutError(f"required launcher is unsafe: {relative}")
        return resolved

    def _create_windows(self, root: Path) -> Path:
        launcher = self._required_file(root, "START.ps1")
        icon = self._required_file(root, "medos.ico")
        desktop = self.platform_info.home / "Desktop"
        try:
            desktop.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ShortcutError("Windows Desktop is unavailable") from error
        final = desktop / "MedOS.lnk"
        if final.exists() and (final.is_dir() or final.is_symlink()):
            raise ShortcutError("Desktop MedOS shortcut is unsafe")
        temporary = desktop / f".MedOS-{uuid.uuid4().hex}.lnk"
        try:
            self.windows_link_writer(temporary, launcher, root, icon)
            info = temporary.lstat()
            if temporary.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
                raise ShortcutError("Windows did not create a valid MedOS shortcut")
            os.replace(temporary, final)
        except (OSError, subprocess.SubprocessError) as error:
            raise ShortcutError("could not create the Windows MedOS shortcut") from error
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        return final

    @staticmethod
    def _write_windows_link(link: Path, launcher: Path, working: Path, icon: Path) -> None:
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not powershell:
            raise ShortcutError("Windows PowerShell is unavailable")
        encoded = base64.b64encode(_WINDOWS_LINK_SCRIPT.encode("utf-16le")).decode("ascii")
        environment = dict(os.environ)
        environment.update(
            {
                "MEDOS_SHORTCUT_PATH": str(link),
                "MEDOS_POWERSHELL_PATH": str(Path(powershell).resolve(strict=True)),
                "MEDOS_START_PATH": str(launcher),
                "MEDOS_WORKING_DIRECTORY": str(working),
                "MEDOS_ICON_PATH": str(icon),
            }
        )
        completed = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            check=False,
            capture_output=True,
            timeout=20.0,
            env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if completed.returncode != 0:
            raise ShortcutError("Windows rejected the MedOS shortcut")

    def _mac_icon_bytes(self) -> bytes:
        if self._icon_bytes is not None:
            return self._icon_bytes
        asset = Path(__file__).resolve().parent / "assets" / "MedOS.icns"
        try:
            payload = asset.read_bytes()
        except OSError as error:
            raise ShortcutError("MedOS macOS icon is unavailable") from error
        if len(payload) < 16 or payload[:4] != b"icns":
            raise ShortcutError("MedOS macOS icon is invalid")
        return payload

    def _create_macos(self, root: Path) -> Path:
        self._required_file(root, "mac/start.sh")
        applications = self.platform_info.home / "Applications"
        desktop_root = self.platform_info.home / "Desktop"
        try:
            applications.mkdir(parents=True, exist_ok=True)
            desktop_root.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise ShortcutError("macOS Applications or Desktop folder is unavailable") from error
        bundle = applications / "MedOS.app"
        self._assert_owned_or_absent(bundle)
        staging = applications / f".MedOS-{uuid.uuid4().hex}.app"
        backup = applications / f".MedOS-{uuid.uuid4().hex}.old"
        replaced = False
        try:
            self._write_macos_bundle(staging, root)
            if bundle.exists():
                os.replace(bundle, backup)
                replaced = True
            os.replace(staging, bundle)
            if replaced:
                shutil.rmtree(backup)
            self._publish_desktop_link(desktop_root / "MedOS.app", bundle)
        except (OSError, plistlib.InvalidFileException) as error:
            if replaced and backup.exists() and not bundle.exists():
                os.replace(backup, bundle)
            raise ShortcutError("could not create the macOS MedOS launcher") from error
        finally:
            for candidate in (staging, backup):
                if candidate.exists() and not candidate.is_symlink():
                    shutil.rmtree(candidate, ignore_errors=True)
        return desktop_root / "MedOS.app"

    @staticmethod
    def _assert_owned_or_absent(bundle: Path) -> None:
        if not bundle.exists() and not bundle.is_symlink():
            return
        if bundle.is_symlink() or not bundle.is_dir():
            raise ShortcutError("existing MedOS app is not owned by MedOS")
        plist_path = bundle / "Contents" / "Info.plist"
        try:
            with plist_path.open("rb") as source:
                payload = plistlib.load(source)
        except (OSError, plistlib.InvalidFileException) as error:
            raise ShortcutError("existing MedOS app is not owned by MedOS") from error
        if payload.get("CFBundleIdentifier") not in _OWNED_BUNDLE_IDENTIFIERS:
            raise ShortcutError("existing MedOS app is not owned by MedOS")

    def _write_macos_bundle(self, bundle: Path, root: Path) -> None:
        contents = bundle / "Contents"
        executable = contents / "MacOS" / "MedOS"
        resources = contents / "Resources"
        executable.parent.mkdir(parents=True)
        resources.mkdir()
        executable.write_text(_MAC_EXECUTABLE, encoding="utf-8", newline="\n")
        executable.chmod(0o755)
        target_text = str(root)
        if "\x00" in target_text or "\n" in target_text or "\r" in target_text:
            raise ShortcutError("MedOS target path is not safe for a macOS launcher")
        (resources / "target-root").write_text(target_text + "\n", encoding="utf-8", newline="\n")
        (resources / "MedOS.icns").write_bytes(self._mac_icon_bytes())
        plist = {
            "CFBundleDevelopmentRegion": "en",
            "CFBundleExecutable": "MedOS",
            "CFBundleIconFile": "MedOS.icns",
            "CFBundleIdentifier": _BUNDLE_IDENTIFIER,
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundleName": "MedOS",
            "CFBundleDisplayName": "MedOS",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.1.5",
            "CFBundleVersion": "1",
        }
        (contents / "Info.plist").write_bytes(
            plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=True)
        )
        (contents / "PkgInfo").write_bytes(b"APPL????")

    @classmethod
    def _publish_desktop_link(cls, link: Path, bundle: Path) -> None:
        if link.is_symlink():
            if link.resolve(strict=False) != bundle:
                raise ShortcutError("existing Desktop MedOS link points elsewhere")
            return
        temporary = link.parent / f".MedOS-{uuid.uuid4().hex}.link"
        backup = link.parent / f".MedOS-{uuid.uuid4().hex}.old"
        replaced = False
        try:
            if link.exists():
                cls._assert_owned_or_absent(link)
            temporary.symlink_to(bundle, target_is_directory=True)
            if link.exists():
                os.replace(link, backup)
                replaced = True
            os.replace(temporary, link)
            if replaced:
                shutil.rmtree(backup)
        except OSError:
            if replaced and backup.exists() and not link.exists():
                os.replace(backup, link)
            raise
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            if backup.exists() and not backup.is_symlink():
                shutil.rmtree(backup, ignore_errors=True)


__all__ = ["PlatformShortcutManager", "ShortcutError"]

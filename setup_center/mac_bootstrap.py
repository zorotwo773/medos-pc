"""Deterministic, permission-preserving macOS Setup app construction."""

from __future__ import annotations

import os
import plistlib
import re
import shutil
import stat
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from tools.release.universal_release import patch_zip_unix_modes


_RELEASE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_FIXED_TIME = (1980, 1, 1, 0, 0, 0)
_APP_ROOT = PurePosixPath("MedOS Setup.app")


class MacBootstrapError(RuntimeError):
    """Raised when the macOS bootstrap cannot be built safely."""


@dataclass(frozen=True, slots=True)
class _Entry:
    name: str
    source: Path | None = None
    content: bytes | None = None
    directory: bool = False


def _directory(name: str) -> str:
    return name.rstrip("/") + "/"


def _parents(name: str) -> tuple[str, ...]:
    path = PurePosixPath(name.rstrip("/"))
    result: list[str] = []
    for parent in path.parents:
        if str(parent) == ".":
            continue
        result.append(_directory(parent.as_posix()))
    return tuple(reversed(result))


def _collect_tree(
    source_root: Path,
    archive_root: PurePosixPath,
    *,
    skip_symlinks: bool = False,
) -> list[_Entry]:
    if not source_root.is_dir() or source_root.is_symlink():
        raise MacBootstrapError(f"bootstrap source directory is unavailable: {source_root}")
    entries: list[_Entry] = [_Entry(_directory(archive_root.as_posix()), directory=True)]
    try:
        children = sorted(source_root.rglob("*"), key=lambda path: path.relative_to(source_root).as_posix().casefold())
    except OSError as error:
        raise MacBootstrapError(f"cannot enumerate bootstrap source: {source_root}") from error
    for path in children:
        relative = path.relative_to(source_root)
        if "__pycache__" in relative.parts or path.name.endswith((".pyc", ".pyo")):
            continue
        if path.is_symlink():
            if skip_symlinks:
                # Convenience links such as pydoc3 and pkg-config aliases are
                # not needed by the installer and are unreliable on NTFS.
                continue
            raise MacBootstrapError(f"bootstrap source contains a symbolic link: {path}")
        name = (archive_root / PurePosixPath(relative.as_posix())).as_posix()
        if path.is_dir():
            entries.append(_Entry(_directory(name), directory=True))
        elif path.is_file():
            entries.append(_Entry(name, source=path))
        else:
            raise MacBootstrapError(f"bootstrap source is not a regular file: {path}")
    return entries


def _package_entries(setup_root: Path) -> list[_Entry]:
    package = setup_root / "setup_center"
    entries = _collect_tree(
        package,
        _APP_ROOT / "Contents" / "Resources" / "setup_center",
    )
    names = {entry.name for entry in entries}
    for required in (
        f"{_APP_ROOT.as_posix()}/Contents/Resources/setup_center/__init__.py",
        f"{_APP_ROOT.as_posix()}/Contents/Resources/setup_center/__main__.py",
        f"{_APP_ROOT.as_posix()}/Contents/Resources/setup_center/static/index.html",
        f"{_APP_ROOT.as_posix()}/Contents/Resources/setup_center/static/styles.css",
        f"{_APP_ROOT.as_posix()}/Contents/Resources/setup_center/static/app.js",
    ):
        if required not in names:
            raise MacBootstrapError(f"Setup Center package is incomplete: {required}")
    return entries


def _runtime_entries(mac_tools_root: Path) -> list[_Entry]:
    result: list[_Entry] = []
    for architecture in ("arm64", "x64"):
        python_root = mac_tools_root / architecture / "python"
        executable = python_root / "bin" / "python3"
        if not executable.is_file() or executable.is_symlink():
            raise MacBootstrapError(f"{architecture} macOS Python runtime is unavailable")
        archive_root = (
            _APP_ROOT
            / "Contents"
            / "Resources"
            / "runtime"
            / architecture
            / "mac-tools"
            / "python"
        )
        result.extend(_collect_tree(python_root, archive_root, skip_symlinks=True))
    return result


def _plist() -> bytes:
    value = {
        "CFBundleDevelopmentRegion": "en",
        "CFBundleDisplayName": "MedOS Setup",
        "CFBundleExecutable": "MedOS Setup",
        "CFBundleIdentifier": "com.medos.setup",
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "MedOS Setup",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
    }
    return plistlib.dumps(value, fmt=plistlib.FMT_XML, sort_keys=True)


def _launcher(release_id: str) -> bytes:
    template_path = Path(__file__).with_name("assets") / "mac-launcher.sh"
    try:
        template = template_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise MacBootstrapError("macOS launcher template is unavailable") from error
    if template.count("__MEDOS_RELEASE_ID__") != 1:
        raise MacBootstrapError("macOS launcher template placeholder is invalid")
    return (
        template.replace("__MEDOS_RELEASE_ID__", release_id)
        .replace("\r\n", "\n")
        .encode("utf-8")
    )


def _entry_inventory(
    setup_root: Path,
    mac_tools_root: Path,
    release_id: str,
) -> list[_Entry]:
    entries: list[_Entry] = [
        _Entry(_directory(_APP_ROOT.as_posix()), directory=True),
        _Entry(_directory((_APP_ROOT / "Contents").as_posix()), directory=True),
        _Entry(_directory((_APP_ROOT / "Contents" / "MacOS").as_posix()), directory=True),
        _Entry(_directory((_APP_ROOT / "Contents" / "Resources").as_posix()), directory=True),
        _Entry((_APP_ROOT / "Contents" / "Info.plist").as_posix(), content=_plist()),
        _Entry(
            (_APP_ROOT / "Contents" / "MacOS" / "MedOS Setup").as_posix(),
            content=_launcher(release_id),
        ),
    ]
    entries.extend(_package_entries(setup_root))
    entries.extend(_runtime_entries(mac_tools_root))

    complete: dict[str, _Entry] = {}
    folded: dict[str, str] = {}
    for entry in entries:
        for parent in _parents(entry.name):
            complete.setdefault(parent, _Entry(parent, directory=True))
        previous = folded.get(entry.name.casefold())
        if previous is not None and previous != entry.name:
            raise MacBootstrapError(f"case-insensitive archive path collision: {previous}")
        folded[entry.name.casefold()] = entry.name
        existing = complete.get(entry.name)
        if existing is not None and existing != entry:
            if existing.directory and entry.directory:
                continue
            raise MacBootstrapError(f"duplicate archive member: {entry.name}")
        complete[entry.name] = entry
    return sorted(complete.values(), key=lambda item: item.name.casefold())


def _zip_info(entry: _Entry) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(entry.name, date_time=_FIXED_TIME)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    if entry.directory:
        info.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
    else:
        info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _write_archive(path: Path, entries: list[_Entry]) -> None:
    with zipfile.ZipFile(
        path,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        allowZip64=True,
        strict_timestamps=True,
    ) as archive:
        for entry in entries:
            info = _zip_info(entry)
            if entry.directory:
                archive.writestr(info, b"")
            elif entry.content is not None:
                archive.writestr(info, entry.content)
            elif entry.source is not None:
                try:
                    with entry.source.open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
                        shutil.copyfileobj(source, target, length=4 * 1024 * 1024)
                except OSError as error:
                    raise MacBootstrapError(f"cannot archive bootstrap file: {entry.source}") from error
            else:
                raise MacBootstrapError(f"archive member has no content: {entry.name}")


def _inspect(path: Path) -> None:
    required = {
        "MedOS Setup.app/Contents/Info.plist",
        "MedOS Setup.app/Contents/MacOS/MedOS Setup",
        "MedOS Setup.app/Contents/Resources/setup_center/__main__.py",
        "MedOS Setup.app/Contents/Resources/setup_center/static/index.html",
        "MedOS Setup.app/Contents/Resources/runtime/arm64/mac-tools/python/bin/python3",
        "MedOS Setup.app/Contents/Resources/runtime/x64/mac-tools/python/bin/python3",
    }
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            names = {info.filename for info in infos}
            if len(names) != len(infos) or not required.issubset(names):
                raise MacBootstrapError("macOS bootstrap archive is incomplete or ambiguous")
            if archive.testzip() is not None:
                raise MacBootstrapError("macOS bootstrap archive failed CRC verification")
            plist = plistlib.loads(archive.read("MedOS Setup.app/Contents/Info.plist"))
            if (
                plist.get("CFBundleExecutable") != "MedOS Setup"
                or plist.get("CFBundleIdentifier") != "com.medos.setup"
                or plist.get("LSMinimumSystemVersion") != "12.0"
            ):
                raise MacBootstrapError("macOS bootstrap Info.plist is invalid")
            for name in required:
                info = archive.getinfo(name)
                mode = (info.external_attr >> 16) & 0o777
                expected = 0o755 if name.endswith(("/MedOS Setup", "/python3")) else 0o644
                if info.create_system != 3 or mode != expected:
                    raise MacBootstrapError(f"macOS bootstrap permissions are invalid: {name}")
            launcher = archive.read("MedOS Setup.app/Contents/MacOS/MedOS Setup")
            if not launcher.startswith(b"#!/bin/sh\n"):
                raise MacBootstrapError("macOS bootstrap launcher is invalid")
    except (OSError, zipfile.BadZipFile, KeyError, plistlib.InvalidFileException) as error:
        if isinstance(error, MacBootstrapError):
            raise
        raise MacBootstrapError("cannot inspect macOS bootstrap archive") from error


def build_mac_bootstrap(
    output: Path,
    *,
    setup_root: Path,
    mac_tools_root: Path,
    release_id: str,
) -> Path:
    """Build and atomically publish a deterministic dual-architecture Setup app ZIP.

    The app is bound to the release it was built from, not to one physical
    drive, so the same build runs from the SSD, the USB stick, or an extracted
    download without rebuilding the bundle per destination.
    """

    if not isinstance(release_id, str) or _RELEASE_ID_RE.fullmatch(release_id) is None:
        raise MacBootstrapError("release ID must be a safe lowercase release identifier")
    setup = Path(setup_root).expanduser().resolve(strict=True)
    tools = Path(mac_tools_root).expanduser().resolve(strict=True)
    destination = Path(output).expanduser().resolve(strict=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    entries = _entry_inventory(setup, tools, release_id)
    temporary = destination.with_name(f"{destination.name}.medos-partial-{uuid.uuid4().hex}")
    try:
        _write_archive(temporary, entries)
        patch_zip_unix_modes(temporary)
        _inspect(temporary)
        os.replace(temporary, destination)
    except (OSError, MacBootstrapError, RuntimeError) as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        if isinstance(error, MacBootstrapError):
            raise
        raise MacBootstrapError("cannot build macOS bootstrap archive") from error
    return destination


__all__ = ["MacBootstrapError", "build_mac_bootstrap"]

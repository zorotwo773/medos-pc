"""Apply a verified MedOS code update, preserving personal configuration and data."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import socket
import stat
import sys
import uuid


class UpdateError(RuntimeError):
    pass


ROOT_FILES = {
    'START.ps1', 'STOP.ps1', 'START_HERE_WINDOWS.cmd', 'START HERE - WINDOWS.cmd',
    'START HERE - LINUX.sh', 'START HERE - README.html', 'README.md',
    'MedOS_USER_GUIDE.md', 'MedOS_USER_GUIDE.pdf', 'DISTRIBUTION.md', 'UPGRADE.md',
    'setup-drive.json', 'release-manifest.json', 'portable-component.json',
    'setup-drive.json.sha256', 'release-source.json', 'RELEASE_README.md',
    'START.bat', 'STOP.bat', 'ALLOW_LAN.bat', 'ALLOW_LAN.ps1', 'launch.vbs',
    'MedOS.command', 'MedOS-Setup.command', 'MedOS-Stop.command', 'medos.icns', 'medos.ico',
}
APP_FILES = {
    'app/medos_server.mjs', 'app/package.json', 'app/package-lock.json',
    'app/next.config.ts', 'app/tsconfig.json', 'app/START.ps1', 'app/START.bat',
    'app/medos_kill.ps1', 'app/status_server.py', 'app/Set-MedOSNetworkAccess.ps1',
    'app/proxy.ts', 'app/postcss.config.mjs', 'app/eslint.config.mjs',
}
FRONTEND_SOURCE_PREFIXES = (
    'app/app/', 'app/components/', 'app/lib/', 'app/hooks/', 'app/styles/',
)
ACTIVATION_FILES = {
    '.medos-setup/manifests/desktop-core.manifest.json',
    '.medos-setup/manifests/desktop-core.manifest.json.sha256',
}
FRONTEND_REQUIRED = {
    'app/.next/BUILD_ID', 'app/.next/required-server-files.json',
    'app/.next/routes-manifest.json', 'app/.next/build-manifest.json',
    'app/.next/prerender-manifest.json', 'app/.next/server/pages-manifest.json',
    'app/.next/server/app-paths-manifest.json',
}


def safe_relative(value: str) -> Path:
    if not isinstance(value, str) or '\\' in value or ':' in value:
        raise UpdateError('Unsafe update path')
    p = PurePosixPath(value)
    if p.is_absolute() or not p.parts or '..' in p.parts or str(p) != value:
        raise UpdateError('Unsafe update path')
    if any(
        part.endswith((' ', '.')) or any(ord(c) < 32 or c in '<>"|?*' for c in part)
        or re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])', part.split('.')[0])
        for part in p.parts
    ):
        raise UpdateError('Unsafe update path')
    if any(part.casefold() in ('.env', 'data', '__pycache__', '.git', '.venv') or part.casefold().startswith('.env.') for part in p.parts):
        raise UpdateError('Update cannot write personal configuration or data')
    # Next may vendor runtime packages into its compiled build. These belong to
    # the atomic .next replacement; platform-specific app/node_modules does not.
    if any(part.casefold() == 'node_modules' for part in p.parts) and p.parts[:2] != ('app', '.next'):
        raise UpdateError('Update cannot replace native dependency installations')
    allowed = (
        value in ROOT_FILES or value.startswith(('mac/', 'linux/', 'setup_center/', 'MedOS.app/', 'MedOS Stop.app/', 'docs/'))
        or value.startswith(('app/.next/', 'app/public/'))
        or value.startswith(FRONTEND_SOURCE_PREFIXES)
        or (value.startswith('app/backend/') and (p.suffix == '.py' or p.name.startswith('requirements')))
        or value in APP_FILES or value in ACTIVATION_FILES
    )
    if not allowed:
        raise UpdateError(f'Path is outside the code update scope: {value}')
    return Path(*p.parts)


def _linked(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def contained(base: Path, relative: Path, *, allow_links: bool = False) -> Path:
    base = Path(os.path.abspath(base))
    target = base / relative
    if not target.resolve().is_relative_to(base.resolve()):
        raise UpdateError('Update path escapes its folder')
    if not allow_links:
        cursor = target
        while True:
            if _linked(cursor):
                raise UpdateError('Move this update into a regular local folder; linked code paths are unsupported')
            if cursor == base:
                break
            cursor = cursor.parent
    return target


def _read_object(path: Path) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise UpdateError('Update verification failed: duplicate JSON key')
            result[key] = value
        return result
    result = json.loads(path.read_text(encoding='utf-8-sig'), object_pairs_hook=unique)
    if not isinstance(result, dict):
        raise UpdateError('Update verification failed: expected a JSON object')
    return result


def _validate_frontend(payload: Path, seen: set[str]) -> None:
    if not FRONTEND_REQUIRED.issubset(seen):
        raise UpdateError('Update verification failed: complete frontend runtime manifests required')
    if not contained(payload, Path('app/.next/BUILD_ID')).read_text(encoding='utf-8').strip():
        raise UpdateError('Update verification failed: empty frontend build identity')

    def require(value: str):
        rel = safe_relative(value)
        if not value.startswith('app/.next/') or rel.as_posix() not in seen:
            raise UpdateError(f'Update verification failed: frontend runtime file missing: {value}')

    server_files = _read_object(contained(payload, Path('app/.next/required-server-files.json'))).get('files')
    if not isinstance(server_files, list) or not all(isinstance(value, str) for value in server_files):
        raise UpdateError('Update verification failed: invalid frontend runtime inventory')
    for value in server_files:
        require('app/' + value.replace('\\', '/'))
    for name in ('app-paths-manifest.json', 'pages-manifest.json'):
        routes = _read_object(contained(payload, Path('app/.next/server') / name))
        for value in routes.values():
            if not isinstance(value, str):
                raise UpdateError('Update verification failed: invalid frontend route inventory')
            require('app/.next/server/' + value.replace('\\', '/'))

    # Trace paths are relative to each .nft manifest and may legitimately use
    # '..'. Verify only dependencies inside the replaced build. Native packages
    # outside .next remain in the existing platform dependency installation.
    for trace in sorted(name for name in seen if name.startswith('app/.next/') and name.endswith('.nft.json')):
        files = _read_object(contained(payload, Path(trace))).get('files')
        if not isinstance(files, list):
            raise UpdateError('Update verification failed: invalid frontend trace inventory')
        for value in files:
            if not isinstance(value, str) or not value or ':' in value:
                raise UpdateError('Update verification failed: invalid frontend trace path')
            value = value.replace('\\', '/')
            if PurePosixPath(value).is_absolute():
                raise UpdateError('Update verification failed: invalid frontend trace path')
            target = posixpath.normpath(posixpath.join(PurePosixPath(trace).parent.as_posix(), value))
            if not target.startswith('app/.next/'):
                continue
            rel = safe_relative(target)
            if contained(payload, rel).is_dir():
                # pdfjs traces its entire vendored directory. The physical
                # inventory check below verifies every included descendant.
                if not any(name.startswith(target + '/') for name in seen):
                    raise UpdateError(f'Update verification failed: frontend traced directory missing files: {target}')
            else:
                require(target)

    # Compare the physical build inventory with the hash-listed payload.
    # An accidentally omitted record must not erase that runtime file when .next
    # is replaced as a directory.
    next_root = contained(payload, Path('app/.next'))
    actual = set()
    for directory, names, files in os.walk(next_root, followlinks=False):
        for name in names + files:
            candidate = Path(directory) / name
            contained(payload, candidate.relative_to(payload))
        actual.update((Path(directory) / name).relative_to(payload).as_posix() for name in files)
    expected = {name for name in seen if name.startswith('app/.next/')}
    if actual != expected:
        raise UpdateError('Update verification failed: frontend file inventory is incomplete')


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def apply_update(root: Path, kit: Path, *, check_ports: bool = True, mode: str | None = None, verify_only: bool = False) -> Path:
    root, kit = Path(os.path.abspath(root)), Path(os.path.abspath(kit))
    # Check before resolving: resolving first would conceal a linked kit root.
    for selected in (root, kit):
        if _linked(selected):
            raise UpdateError('Move this update into a regular local folder; linked code paths are unsupported')
    # Resolve the chosen locations once. System aliases such as macOS /var ->
    # /private/var are valid ancestors; links inside the selected roots are not.
    root, kit = root.resolve(), kit.resolve()
    try:
        manifest = _read_object(contained(kit, Path('update.json')))
        marker = _read_object(contained(root, Path('setup-drive.json')))
    except (OSError, ValueError) as exc:
        raise UpdateError('Extract MedOS Update inside the complete MedOS 1.1.4 or 1.1.5 folder first') from exc
    update_mode = manifest.get('mode', 'full')
    if not isinstance(update_mode, str) or update_mode not in ('full', 'patch'):
        raise UpdateError('Unsupported update mode')
    if mode is not None and mode != update_mode:
        raise UpdateError('Requested update mode does not match this kit')
    patch = update_mode == 'patch'

    if type(manifest.get('schema_version')) is not int or manifest.get('schema_version') != 1:
        raise UpdateError('Unsupported update manifest')
    release_id = manifest.get('release_id')
    if patch:
        if not isinstance(release_id, str) or re.fullmatch(r'medos-\d+\.\d+(?:\.\d+)?', release_id) is None:
            raise UpdateError('Unsupported update manifest')
        if release_id != marker.get('release_id'):
            raise UpdateError('This patch is for a different MedOS release')
    elif release_id != 'medos-1.1.5':
        raise UpdateError('Unsupported update manifest')
    if marker.get('release_id') not in ('medos-1.1.4', 'medos-1.1.5'):
        raise UpdateError('This update supports MedOS 1.1.4 and 1.1.5; use the complete release for an older version')
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise UpdateError('Update verification failed: empty file list')
    if not patch and manifest.get('replace_directories', ['app/.next']) != ['app/.next']:
        raise UpdateError('Unsupported update directory replacement scope')
    if patch and manifest.get('replace_directories'):
        raise UpdateError('Patch updates cannot replace directories')
    seen: set[str] = set()
    seen_casefold: set[str] = set()
    verified: list[tuple[Path, Path]] = []
    total = 0
    for record in records:
        if (not isinstance(record, dict) or not isinstance(record.get('path'), str)
                or type(record.get('bytes')) is not int or record['bytes'] < 0
                or not isinstance(record.get('sha256'), str)
                or re.fullmatch('[a-fA-F0-9]{64}', record['sha256']) is None):
            raise UpdateError('Update verification failed: invalid file record')
        rel = safe_relative(record['path'])
        key = rel.as_posix().casefold()
        if key in seen_casefold:
            raise UpdateError('Update verification failed: duplicate file')
        seen_casefold.add(key)
        seen.add(rel.as_posix())
        source = contained(kit / 'payload', rel)
        # A full update replaces app/.next as one atomic directory. Next's own
        # build can put junctions inside it (e.g. pdfjs-dist), so walking those
        # individual files for links is both unnecessary and wrong. Patches do
        # write individual files and keep the strict check.
        inside_next = not patch and rel.as_posix().startswith('app/.next/')
        contained(root, rel, allow_links=inside_next)
        if not source.is_file() or source.stat().st_size != record['bytes'] or digest(source) != record['sha256'].lower():
            raise UpdateError(f'Update verification failed: {rel.as_posix()}. Download and extract the update again.')
        total += source.stat().st_size
        verified.append((rel, source))
    if not patch:
        if not {'app/.next/BUILD_ID', 'setup-drive.json'}.issubset(seen):
            raise UpdateError('Update verification failed: complete frontend build and release identity required')
        _validate_frontend(kit / 'payload', seen)
        if _read_object(contained(kit / 'payload', Path('setup-drive.json'))).get('release_id') != manifest['release_id']:
            raise UpdateError('Update verification failed: payload release identity does not match the update')
    if shutil.disk_usage(root).free < total * 2 + 64 * 1024 * 1024:
        raise UpdateError('Free more disk space before updating; the update keeps a rollback copy')
    if check_ports:
        for port in (3000, 8002):
            with socket.socket() as probe:
                probe.settimeout(0.3)
                if probe.connect_ex(('127.0.0.1', port)) == 0:
                    raise UpdateError(f'Close MedOS before updating (port {port} is still in use)')
    if verify_only:
        return kit
    state = contained(root, Path('.medos-updates'))
    state.mkdir(exist_ok=True)
    lock = state / 'update.lock'
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise UpdateError(f'An update is active or was interrupted. Keep its backup and inspect {lock} before retrying.') from exc
    os.close(descriptor)
    transaction = state / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    incoming, backup = transaction / 'payload', transaction / 'backup'
    changed: list[tuple[Path, bool]] = []
    retain_lock = False
    try:
        for (rel, source), record in zip(verified, records):
            destination = incoming / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            if destination.stat().st_size != record['bytes'] or digest(destination) != record['sha256'].lower():
                raise UpdateError(f'Update verification failed after staging: {rel.as_posix()}')
            if rel.suffix in ('.sh', '.command') or 'Contents/MacOS' in rel.as_posix():
                destination.chmod(0o755)
        if not patch:
            _validate_frontend(incoming, seen)
        if patch:
            units = [rel for rel, _ in verified]
        else:
            units = [Path('app/.next')]
            units += [rel for rel, _ in verified if not rel.as_posix().startswith('app/.next/') and rel.name not in ('setup-drive.json', 'release-manifest.json', 'portable-component.json')]
            units += [rel for rel, _ in verified if rel.name in ('portable-component.json', 'release-manifest.json', 'setup-drive.json')]
        (transaction / 'plan.json').write_text(json.dumps({
            'release_id': manifest['release_id'], 'units': [
                {'path': rel.as_posix(), 'existed': (root / rel).exists()} for rel in units
            ],
        }, indent=2), encoding='utf-8')
        for rel in units:
            destination = contained(root, rel)
            previous = backup / rel
            existed = destination.exists()
            changed.append((rel, existed))
            if existed:
                previous.parent.mkdir(parents=True, exist_ok=True)
                os.replace(destination, previous)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(incoming / rel, destination)
        (transaction / 'result.json').write_text(json.dumps({'status': 'complete', 'release_id': manifest['release_id'], 'backup': str(backup)}, indent=2), encoding='utf-8')
        return backup
    except BaseException as exc:
        # Ctrl+C must either restore the old code or leave the recovery lock.
        # A second interruption during rollback also leaves the lock in place.
        retain_lock = True
        rollback_errors = []
        for rel, existed in reversed(changed):
            try:
                destination = contained(root, rel)
                previous = backup / rel
                if existed and not previous.exists():
                    if destination.exists():
                        continue  # Moving the old file failed before publication.
                    raise OSError('Original file and rollback copy are both unavailable')
                if destination.exists():
                    failed = transaction / 'failed' / rel
                    failed.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(destination, failed)
                if existed:
                    os.replace(previous, destination)
            except (OSError, UpdateError) as restore_error:
                rollback_errors.append(f'{rel}: {restore_error}')
        detail = 'Previous files were restored.' if not rollback_errors else f'Recovery needs attention. Keep {transaction}; ' + '; '.join(rollback_errors)
        retain_lock = bool(rollback_errors)
        try:
            (transaction / 'result.json').write_text(json.dumps({
                'status': 'recovery_required' if retain_lock else 'rolled_back',
                'error': str(exc), 'rollback_errors': rollback_errors,
            }, indent=2), encoding='utf-8')
        except OSError:
            pass
        raise UpdateError(f'Update could not finish: {exc}. {detail}') from exc
    finally:
        if not retain_lock:
            lock.unlink(missing_ok=True)


def write_entrypoints(kit: Path) -> list[Path]:
    """Write self-contained launchers for a kit placed inside existing MedOS."""
    kit = Path(kit)
    kit.mkdir(parents=True, exist_ok=True)
    helper = contained(kit, Path('apply_update.py'))
    shutil.copyfile(Path(__file__), helper)
    windows = r'''@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0.."
if errorlevel 1 exit /b 2
if not exist "tools\python\python.exe" (
  echo Put the MedOS Update folder inside your existing complete MedOS folder first.
  popd
  pause
  exit /b 2
)
"tools\python\python.exe" "%~dp0apply_update.py" --root "." --kit "%~dp0."
set "MEDOS_UPDATE_STATUS=%errorlevel%"
popd
pause
exit /b %MEDOS_UPDATE_STATUS%
'''
    mac = '''#!/bin/sh
set -eu
KIT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$KIT/.." && pwd)
cd "$ROOT"
case "$(/usr/bin/uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)
    if [ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || printf 0)" = 1 ]; then ARCH=arm64; else ARCH=x64; fi ;;
  *) printf '%s\\n' 'This Mac architecture is not supported by this update.' >&2; exit 2 ;;
esac
PYTHON="$ROOT/mac-tools/$ARCH/python/bin/python3"
if [ ! -x "$PYTHON" ]; then
  printf '%s\\n' 'Put MedOS Update inside the complete MedOS folder with its existing Mac runtime first.' >&2
  exit 2
fi
"$PYTHON" "$KIT/apply_update.py" --root "$ROOT" --kit "$KIT"
'''
    linux = '''#!/bin/sh
set -eu
KIT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$KIT/.." && pwd)
cd "$ROOT"
if [ -x "$ROOT/.medos-linux/venv/bin/python" ]; then
  PYTHON="$ROOT/.medos-linux/venv/bin/python"
else
  PYTHON=$(command -v python3) || { printf '%s\\n' 'Python 3.10 or newer is required to apply this update.' >&2; exit 2; }
fi
"$PYTHON" "$KIT/apply_update.py" --root "$ROOT" --kit "$KIT"
'''
    paths = [helper]
    for name, body in (
        ('APPLY UPDATE - WINDOWS.cmd', windows),
        ('APPLY UPDATE - MAC.command', mac),
        ('APPLY UPDATE - LINUX.sh', linux),
    ):
        path = contained(kit, Path(name))
        path.write_text(body, encoding='utf-8', newline='\r\n' if name.endswith('.cmd') else '\n')
        if not name.endswith('.cmd'):
            path.chmod(0o755)
        paths.append(path)
    return paths


def main() -> int:
    # Embedded Windows Python otherwise uses a legacy encoding when output is
    # redirected. A Unicode backup path must not turn a completed update into
    # an apparent failure, or hide a recovery message. Keep logs valid UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if callable(getattr(stream, 'reconfigure', None)):
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--kit', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--no-port-check', action='store_true',
                        help='apply even if MedOS is still running (use only from a controlled launcher)')
    parser.add_argument('--mode', choices=('full', 'patch'), default=None,
                        help='require a specific kit mode; defaults to the mode declared in update.json')
    parser.add_argument('--verify-only', action='store_true',
                        help='verify the kit and target, then exit without changing any files')
    args = parser.parse_args()
    try:
        result = apply_update(args.root, args.kit, check_ports=not args.no_port_check,
                              mode=args.mode, verify_only=args.verify_only)
        if args.verify_only:
            print('Update kit verified successfully. No files were changed.')
        else:
            print(f'MedOS update complete. Your data and personal configuration were preserved.\nBackup: {result}\nOpen the usual START HERE launcher. On Linux, setup refreshes dependencies if needed.')
        return 0
    except (UpdateError, OSError, ValueError, KeyError, TypeError) as exc:
        print(f'MedOS update needs attention: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

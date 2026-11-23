"""Supervise the native Linux backend/frontend without killing unrelated apps."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
import webbrowser


class LaunchError(RuntimeError):
    pass


def ensure_session_secret(root: Path) -> str:
    from dotenv import dotenv_values, set_key
    paths = (root / 'app/backend/.env', root / 'app/.env')
    secret = next((str(dotenv_values(path).get('MEDOS_SESSION_SECRET') or '').strip() for path in paths if str(dotenv_values(path).get('MEDOS_SESSION_SECRET') or '').strip()), '')
    secret = secret or secrets.token_urlsafe(36)
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)
        set_key(str(path), 'MEDOS_SESSION_SECRET', secret)
        path.chmod(0o600)
    return secret


def launch_environment(root: Path, inherited: dict[str, str]) -> dict[str, str]:
    env = dict(inherited)
    for key in ('PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_OPTIONS'):
        env.pop(key, None)
    settings_root = Path(env.get('XDG_CONFIG_HOME') or str(Path.home() / '.config'))
    env.update(
        NODE_ENV='production', PYTHONUTF8='1', PYTHONUNBUFFERED='1',
        PYTHONDONTWRITEBYTECODE='1', BACKEND_PORT='8002',
        MEDOS_ROOT=str(root.resolve()),
        MEDOS_INTERNAL_FORWARD_TOKEN=secrets.token_hex(32),
        MEDOS_NETWORK_ACCESS_SETTINGS=str(settings_root / 'MedOS' / 'network-access.json'),
    )
    return env


def validate_release(root: Path) -> None:
    for relative in ('app/backend/main.py', 'app/medos_server.mjs', 'app/.next/BUILD_ID', 'app/package-lock.json', 'data'):
        if not (root / relative).exists():
            raise LaunchError(f'Missing {relative}. Extract the complete release into one folder first.')


def require_free_port(port: int) -> None:
    with socket.socket() as probe:
        probe.settimeout(0.3)
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            raise LaunchError(f'Port {port} is already in use. Close the existing MedOS session or the application using it, then retry.')


def is_backend_health(value: object) -> bool:
    return isinstance(value, dict) and value.get('status') == 'ok' and 'rag' in value and isinstance(value.get('corpora'), dict)


def wait_ready(url: str, process: subprocess.Popen, seconds: float, *, backend: bool = False) -> None:
    deadline = time.monotonic() + seconds
    local_http = build_opener(ProxyHandler({}))
    while True:
        result = process.poll()
        if result is not None:
            raise LaunchError(f'{"Backend" if backend else "Frontend"} stopped with exit code {result}. See the log files below.')
        try:
            with local_http.open(url, timeout=1) as response:
                if response.status == 200 and (not backend or is_backend_health(json.load(response))):
                    return
        except (URLError, OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise LaunchError(f'{"Backend" if backend else "Frontend"} did not become ready within {seconds:g} seconds. See the log files below.')
        time.sleep(0.25)


def stop_children(children: list[subprocess.Popen]) -> None:
    groups = [child.pid for child in reversed(children)]
    # A service may exit before its workers. Its process group still belongs
    # to this launch, so signal the group even when Popen.poll() has an exit code.
    for group in groups:
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while groups and time.monotonic() < deadline:
        for child in children:
            child.poll()
        surviving = []
        for group in groups:
            try:
                os.killpg(group, 0)
                surviving.append(group)
            except ProcessLookupError:
                pass
        groups = surviving
        if groups:
            time.sleep(0.05)
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for child in reversed(children):
        child.wait(timeout=5)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--check', action='store_true', help='check files and dependencies without starting services')
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    logs = root / '.medos-linux' / 'logs'
    children: list[subprocess.Popen] = []
    try:
        if sys.platform != 'linux':
            raise LaunchError('Use the Windows or Mac entry point on this operating system.')
        validate_release(root)
        node = shutil.which('node')
        if not node:
            raise LaunchError('Node.js is missing. Install Node.js 22 LTS version 22.13+, then run START HERE - LINUX.sh again.')
        if not (root / 'app/node_modules/next/package.json').is_file():
            raise LaunchError('Linux dependencies are not prepared. Run bash linux/setup.sh.')
        if args.check:
            print('MedOS Linux files and setup are present. Native launch still requires the health checks.')
            return 0
        require_free_port(8002)
        require_free_port(3000)
        logs.mkdir(parents=True, exist_ok=True)
        env = launch_environment(root, os.environ)
        env['MEDOS_SESSION_SECRET'] = ensure_session_secret(root)
        def interrupted(signum, frame):
            raise KeyboardInterrupt
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, interrupted)
        with (logs / 'backend.log').open('a', encoding='utf-8') as backend_log, (logs / 'frontend.log').open('a', encoding='utf-8') as frontend_log:
            print('Starting MedOS backend...', flush=True)
            backend = subprocess.Popen(
                [sys.executable, '-B', '-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8002', '--no-proxy-headers'],
                cwd=root / 'app/backend', env=env, stdout=backend_log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            children.append(backend)
            wait_ready('http://127.0.0.1:8002/health', backend, 120, backend=True)
            print('Starting MedOS frontend...', flush=True)
            frontend = subprocess.Popen(
                [node, 'medos_server.mjs', '--production'], cwd=root / 'app', env=env,
                stdout=frontend_log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            children.append(frontend)
            wait_ready('http://127.0.0.1:3000', frontend, 120)
            print('MedOS is ready: http://127.0.0.1:3000\nKeep this window open. Press Ctrl+C to stop.', flush=True)
            if not args.no_browser:
                webbrowser.open('http://127.0.0.1:3000')
            while all(child.poll() is None for child in children):
                time.sleep(0.5)
            raise LaunchError('A MedOS service stopped. Restart once; if it repeats, review the logs below.')
    except KeyboardInterrupt:
        print('\nStopping this MedOS session...')
        return 0
    except (LaunchError, OSError) as exc:
        print(f'MedOS needs attention: {exc}\nLogs: {logs}\nYour medical data and progress were not removed.', file=sys.stderr)
        return 2
    finally:
        stop_children(children)


if __name__ == '__main__':
    raise SystemExit(main())

"""Platform launch integration and bounded MedOS HTTP health checks."""

from __future__ import annotations

import math
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Mapping, Protocol, Sequence

from .platforms import PlatformInfo, detect_platform


class HealthStatus(str, Enum):
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"


@dataclass(frozen=True, slots=True)
class LaunchResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True, slots=True)
class EndpointResult:
    name: str
    url: str
    ok: bool
    status_code: int | None
    error: str | None


@dataclass(frozen=True, slots=True)
class HealthIssue:
    code: str
    message: str
    relative_path: str | None = None


@dataclass(frozen=True, slots=True)
class HealthReport:
    status: HealthStatus
    healthy: bool
    summary: str
    issues: tuple[HealthIssue, ...]
    endpoints: tuple[EndpointResult, ...]
    log_tails: Mapping[str, str]


class CommandRunner(Protocol):
    def run(
        self, arguments: Sequence[str], *, cwd: Path, timeout_seconds: float
    ) -> LaunchResult: ...


class SubprocessRunner:
    _MAX_CAPTURE_BYTES = 64 * 1024

    def run(
        self, arguments: Sequence[str], *, cwd: Path, timeout_seconds: float
    ) -> LaunchResult:
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            try:
                completed = subprocess.run(
                    list(arguments),
                    cwd=cwd,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    timeout=timeout_seconds,
                    check=False,
                    shell=False,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                return LaunchResult(1, self._capture(stdout_file), str(error))
            return LaunchResult(
                completed.returncode,
                self._capture(stdout_file),
                self._capture(stderr_file),
            )

    @classmethod
    def _capture(cls, handle) -> str:
        handle.flush()
        handle.seek(0, 2)
        size = handle.tell()
        handle.seek(max(0, size - cls._MAX_CAPTURE_BYTES))
        return handle.read(cls._MAX_CAPTURE_BYTES).decode("utf-8", errors="replace")


class PlatformLauncher:
    """Run only the launchers contained by a selected MedOS target."""

    def __init__(
        self,
        *,
        platform_info: PlatformInfo | None = None,
        runner: CommandRunner | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
        self.platform_info = platform_info or detect_platform()
        self.runner = runner or SubprocessRunner()
        self.timeout_seconds = timeout_seconds

    def start(self, target_root: Path) -> LaunchResult:
        root = Path(target_root).expanduser().resolve(strict=True)
        if self.platform_info.system == "windows":
            launcher = self._contained_file(root, root / "START.bat")
            arguments = ("cmd.exe", "/d", "/c", str(launcher), "-NoBrowser")
        else:
            launcher = self._contained_file(root, root / "mac" / "start.sh")
            arguments = ("/bin/bash", str(launcher), "--no-browser")
        return self.runner.run(arguments, cwd=root, timeout_seconds=self.timeout_seconds)

    def stop(self, target_root: Path) -> LaunchResult:
        root = Path(target_root).expanduser().resolve(strict=True)
        if self.platform_info.system == "windows":
            launcher = self._contained_file(root, root / "STOP.bat")
            arguments = ("cmd.exe", "/d", "/c", str(launcher))
        else:
            launcher = self._contained_file(root, root / "mac" / "stop.sh")
            arguments = ("/bin/bash", str(launcher))
        return self.runner.run(arguments, cwd=root, timeout_seconds=self.timeout_seconds)

    @staticmethod
    def _contained_file(root: Path, candidate: Path) -> Path:
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root)
        except (OSError, ValueError) as error:
            raise RuntimeError(f"required MedOS launcher is unavailable: {candidate}") from error
        if not resolved.is_file() or candidate.is_symlink():
            raise RuntimeError(f"required MedOS launcher is unsafe: {candidate}")
        return resolved


def _default_http_get(url: str, timeout_seconds: float) -> int:
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "MedOS-Setup/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code)


class HealthChecker:
    """Require both bundled runtime/build prerequisites and both HTTP services."""

    _ENDPOINTS = (
        ("backend", "http://127.0.0.1:8002/health"),
        ("frontend", "http://127.0.0.1:3000/"),
    )

    def __init__(
        self,
        *,
        platform_info: PlatformInfo | None = None,
        launcher: PlatformLauncher | None = None,
        http_get: Callable[[str, float], int] = _default_http_get,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        poll_interval: float = 0.5,
        max_log_bytes: int = 32 * 1024,
    ) -> None:
        if poll_interval <= 0 or max_log_bytes <= 0:
            raise ValueError("poll_interval and max_log_bytes must be positive")
        self.platform_info = platform_info or detect_platform()
        self.launcher = launcher or PlatformLauncher(platform_info=self.platform_info)
        self.http_get = http_get
        self.sleeper = sleeper
        self.clock = clock
        self.poll_interval = poll_interval
        self.max_log_bytes = max_log_bytes

    def check(
        self,
        target_root: Path,
        *,
        launch: bool = False,
        timeout_seconds: float,
    ) -> HealthReport:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        target = Path(target_root).expanduser().resolve(strict=False)
        prerequisite_issues = self._prerequisite_issues(target)
        if prerequisite_issues:
            return self._report(prerequisite_issues, (), {})
        if launch:
            result = self.launcher.start(target)
            if result.returncode != 0:
                issues = self._classify_text(result.stdout + "\n" + result.stderr)
                if not issues:
                    issues = [HealthIssue("launch-failed", "MedOS did not start successfully.")]
                return self._report(issues, (), {})

        pending = {name: url for name, url in self._ENDPOINTS}
        results: dict[str, EndpointResult] = {}
        started = self.clock()
        deadline = started + timeout_seconds
        max_attempts = max(1, int(math.ceil(timeout_seconds / self.poll_interval)) + 1)
        for _ in range(max_attempts):
            for name, url in tuple(pending.items()):
                try:
                    status = self.http_get(url, min(3.0, timeout_seconds))
                    if 200 <= status < 400:
                        results[name] = EndpointResult(name, url, True, status, None)
                        del pending[name]
                except (OSError, TimeoutError, urllib.error.URLError):
                    pass
            if not pending:
                break
            if self.clock() >= deadline:
                break
            self.sleeper(min(self.poll_interval, max(0.0, deadline - self.clock())))
        issues: list[HealthIssue] = []
        for name, url in pending.items():
            results[name] = EndpointResult(name, url, False, None, "timeout")
            issues.append(
                HealthIssue(
                    f"{name}-unreachable",
                    f"The MedOS {name} service did not answer before the health-check deadline.",
                )
            )
        log_tails = self._read_log_tails(target) if issues else {}
        classified = self._classify_text("\n".join(log_tails.values()))
        existing_codes = {issue.code for issue in issues}
        issues.extend(issue for issue in classified if issue.code not in existing_codes)
        ordered_results = tuple(results[name] for name, _ in self._ENDPOINTS)
        return self._report(issues, ordered_results, log_tails)

    def _prerequisite_issues(self, target: Path) -> list[HealthIssue]:
        if self.platform_info.system == "windows":
            runtime_paths = (
                target / "tools" / "python" / "python.exe",
                target / "tools" / "node" / "node.exe",
            )
        else:
            architecture = self.platform_info.architecture
            runtime_paths = (
                target / "mac-tools" / architecture / "python" / "bin" / "python3",
                target / "mac-tools" / architecture / "node" / "bin" / "node",
            )
        issues: list[HealthIssue] = []
        missing_runtime = [path for path in runtime_paths if not path.is_file()]
        if missing_runtime:
            issues.append(
                HealthIssue(
                    "missing-runtime",
                    "The offline Python or Node runtime is missing.",
                    relative_path=missing_runtime[0].relative_to(target).as_posix(),
                )
            )
        build_paths = (target / "app" / ".next" / "BUILD_ID", target / "app" / ".next" / ".medos-shipped")
        missing_build = [path for path in build_paths if not path.is_file()]
        if missing_build:
            issues.append(
                HealthIssue(
                    "missing-build",
                    "The verified frontend production build is incomplete.",
                    relative_path=missing_build[0].relative_to(target).as_posix(),
                )
            )
        return issues

    def _read_log_tails(self, target: Path) -> dict[str, str]:
        result: dict[str, str] = {}
        for name in ("backend.err", "frontend.err"):
            path = target / "app" / name
            try:
                with path.open("rb") as handle:
                    handle.seek(0, 2)
                    size = handle.tell()
                    handle.seek(max(0, size - self.max_log_bytes))
                    content = handle.read(self.max_log_bytes)
            except OSError:
                continue
            result[name] = content.decode("utf-8", errors="replace")
        return result

    @staticmethod
    def _classify_text(text: str) -> list[HealthIssue]:
        lowered = text.lower()
        issues: list[HealthIssue] = []
        if any(token in lowered for token in ("eaddrinuse", "address already in use", "only one usage of each socket")):
            issues.append(
                HealthIssue(
                    "port-conflict",
                    "Another program is already using a MedOS network port.",
                )
            )
        if any(token in lowered for token in ("no module named", "cannot find module", "module not found")):
            issues.append(
                HealthIssue(
                    "runtime-dependency",
                    "A bundled runtime dependency could not be loaded.",
                )
            )
        if any(token in lowered for token in ("permission denied", "operation not permitted", "eacces")):
            issues.append(
                HealthIssue(
                    "permission",
                    "The operating system denied access to a required MedOS file.",
                )
            )
        return issues

    @staticmethod
    def _report(
        issues: Sequence[HealthIssue],
        endpoints: Sequence[EndpointResult],
        log_tails: Mapping[str, str],
    ) -> HealthReport:
        healthy = not issues and len(endpoints) == 2 and all(endpoint.ok for endpoint in endpoints)
        if healthy:
            summary = "MedOS backend and frontend are healthy."
        else:
            summary = f"MedOS health check found {len(issues)} issue(s)."
        return HealthReport(
            status=HealthStatus.HEALTHY if healthy else HealthStatus.UNHEALTHY,
            healthy=healthy,
            summary=summary,
            issues=tuple(issues),
            endpoints=tuple(endpoints),
            log_tails=dict(log_tails),
        )


__all__ = [
    "EndpointResult",
    "HealthChecker",
    "HealthIssue",
    "HealthReport",
    "HealthStatus",
    "LaunchResult",
    "PlatformLauncher",
]

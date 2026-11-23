"""Select a complete, architecture-bound bundled macOS runtime."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .platforms import PlatformInfo


class MacRuntimeError(RuntimeError):
    """Raised when no safe complete runtime exists for a supported Mac."""


@dataclass(frozen=True, slots=True)
class MacRuntimeCandidate:
    architecture: str
    root: Path
    python: Path
    node: Path
    npm: Path
    swc: Path


def _regular_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def _candidate(release_root: Path, architecture: str) -> MacRuntimeCandidate | None:
    root = Path(release_root) / "mac-tools" / architecture
    candidate = MacRuntimeCandidate(
        architecture=architecture,
        root=root,
        python=root / "python" / "bin" / "python3",
        node=root / "node" / "bin" / "node",
        npm=root / "node" / "bin" / "npm",
        swc=(
            root
            / "swc"
            / "node_modules"
            / "@next"
            / f"swc-darwin-{architecture}"
            / f"next-swc.darwin-{architecture}.node"
        ),
    )
    return candidate if all(_regular_file(path) for path in (
        candidate.python,
        candidate.node,
        candidate.npm,
        candidate.swc,
    )) else None


def select_mac_runtime(release_root: Path, host: PlatformInfo) -> MacRuntimeCandidate:
    """Prefer a complete native runtime, with x64 as Apple Silicon fallback."""

    if host.system != "macos":
        raise MacRuntimeError(f"macOS runtime requested for unsupported host: {host.system}")
    order = ("arm64", "x64") if host.architecture == "arm64" else ("x64",)
    for architecture in order:
        candidate = _candidate(Path(release_root), architecture)
        if candidate is not None:
            return candidate
    raise MacRuntimeError(
        "no complete bundled macOS runtime: " + ", ".join(order)
    )


__all__ = [
    "MacRuntimeCandidate",
    "MacRuntimeError",
    "select_mac_runtime",
]

"""Strict, portable manifest contracts for a MedOS Setup Drive."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, MutableMapping
from urllib.parse import urlsplit

from .portable_paths import PortablePathError, portable_path_key, portable_relative_path


_SCHEMA_VERSION = 1
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_IDENTIFIER_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
_FILE_ROLES = frozenset(
    {
        "runtime",
        "data",
        "model",
        "config",
        "launcher",
        "documentation",
        "installer",
        "android",
    }
)
_FILE_PLATFORMS = frozenset({"all", "windows", "macos", "macos-arm64", "macos-x64"})


class ManifestError(ValueError):
    """Raised when a drive or component manifest is unsafe or malformed."""


@dataclass(frozen=True, slots=True)
class FileRecord:
    source: PurePosixPath
    target: PurePosixPath
    size: int
    sha256: str
    role: str = "runtime"
    platform: str = "all"
    mutable: bool = False
    required: bool = True


@dataclass(frozen=True, slots=True)
class ComponentManifest:
    schema_version: int
    component_id: str
    files: tuple[FileRecord, ...]


@dataclass(frozen=True, slots=True)
class ComponentReference:
    component_id: str
    manifest: PurePosixPath
    sha256: str


@dataclass(frozen=True, slots=True)
class DriveManifest:
    schema_version: int
    drive_id: str
    release_id: str
    setup_center_version: str
    components: tuple[ComponentReference, ...]
    repair_url: str | None = None


def canonical_json_bytes(value: object) -> bytes:
    """Return deterministic, UTF-8 JSON suitable for hashing and sidecars."""

    serialized = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return (serialized + "\n").encode("utf-8")


def sha256_file(path: Path, *, chunk_size: int = 4 * 1024 * 1024) -> str:
    """Stream a file and return its lowercase SHA-256 digest."""

    if isinstance(chunk_size, bool) or not isinstance(chunk_size, int) or chunk_size <= 0:
        raise ValueError("chunk_size must be a positive integer")
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ManifestError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _load_json(path: Path) -> Mapping[str, Any]:
    try:
        content = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise ManifestError(f"cannot read manifest: {path}") from error
    try:
        value = json.loads(content, object_pairs_hook=_object_without_duplicate_keys)
    except ManifestError:
        raise
    except (json.JSONDecodeError, UnicodeError) as error:
        raise ManifestError(f"invalid JSON manifest: {path}") from error
    if not isinstance(value, dict):
        raise ManifestError("manifest root must be a JSON object")
    return value


def _require_exact_keys(
    value: Mapping[str, Any],
    *,
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
    context: str,
) -> None:
    keys = frozenset(value)
    missing = required - keys
    unknown = keys - required - optional
    if missing:
        raise ManifestError(f"{context} is missing field(s): {', '.join(sorted(missing))}")
    if unknown:
        raise ManifestError(f"{context} contains unknown field(s): {', '.join(sorted(unknown))}")


def _require_schema(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value != _SCHEMA_VERSION:
        raise ManifestError(f"schema_version must be {_SCHEMA_VERSION}")
    return value


def _require_identifier(value: object, field: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER_RE.fullmatch(value) is None:
        raise ManifestError(f"{field} must be a lowercase release identifier")
    return value


def _require_hash(value: object, field: str = "sha256") -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise ManifestError(f"{field} must be 64 lowercase hexadecimal characters")
    return value


def _safe_relative(value: object, field: str) -> PurePosixPath:
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{field} must be a non-empty POSIX relative path")
    if "\\" in value or "\x00" in value or value.startswith("/") or value.endswith("/"):
        raise ManifestError(f"unsafe {field}: {value!r}")
    raw_parts = value.split("/")
    if any(part in ("", ".", "..") or ":" in part for part in raw_parts):
        raise ManifestError(f"unsafe {field}: {value!r}")
    path = PurePosixPath(*raw_parts)
    if path.is_absolute():
        raise ManifestError(f"unsafe {field}: {value!r}")
    try:
        return portable_relative_path(path, field)
    except PortablePathError as error:
        raise ManifestError(str(error)) from error


def _parse_file_record(value: object, index: int) -> FileRecord:
    if not isinstance(value, dict):
        raise ManifestError(f"files[{index}] must be a JSON object")
    _require_exact_keys(
        value,
        required=frozenset({"source", "target", "size", "sha256"}),
        optional=frozenset({"role", "platform", "mutable", "required"}),
        context=f"files[{index}]",
    )
    size = value["size"]
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise ManifestError(f"files[{index}].size must be a non-negative integer")
    role = value.get("role", "runtime")
    if not isinstance(role, str) or role not in _FILE_ROLES:
        raise ManifestError(f"files[{index}].role is unsupported")
    platform = value.get("platform", "all")
    if not isinstance(platform, str) or platform not in _FILE_PLATFORMS:
        raise ManifestError(f"files[{index}].platform is unsupported")
    mutable = value.get("mutable", False)
    required = value.get("required", True)
    if not isinstance(mutable, bool):
        raise ManifestError(f"files[{index}].mutable must be a boolean")
    if not isinstance(required, bool):
        raise ManifestError(f"files[{index}].required must be a boolean")
    return FileRecord(
        source=_safe_relative(value["source"], f"files[{index}].source"),
        target=_safe_relative(value["target"], f"files[{index}].target"),
        size=size,
        sha256=_require_hash(value["sha256"], f"files[{index}].sha256"),
        role=role,
        platform=platform,
        mutable=mutable,
        required=required,
    )


def _reject_collisions(
    records: tuple[FileRecord, ...],
    *,
    checkpoint: Callable[[], None] | None = None,
) -> None:
    for field in ("source", "target"):
        seen: dict[str, PurePosixPath] = {}
        for index, record in enumerate(records):
            if checkpoint is not None and index % 1024 == 0:
                checkpoint()
            path = getattr(record, field)
            folded = portable_path_key(path)
            previous = seen.get(folded)
            if previous is not None:
                raise ManifestError(f"{field} path collision: {previous} and {path}")
            seen[folded] = path


def _component_from_value(
    value: Mapping[str, Any],
    *,
    checkpoint: Callable[[], None] | None = None,
) -> ComponentManifest:
    """Parse one already-read component value with cooperative checkpoints."""

    if checkpoint is not None:
        checkpoint()
    _require_exact_keys(
        value,
        required=frozenset({"schema_version", "component_id", "files"}),
        context="component manifest",
    )
    files_value = value["files"]
    if not isinstance(files_value, list):
        raise ManifestError("component manifest files must be a JSON array")
    records_list: list[FileRecord] = []
    for index, item in enumerate(files_value):
        if checkpoint is not None and index % 1024 == 0:
            checkpoint()
        records_list.append(_parse_file_record(item, index))
    records = tuple(records_list)
    if checkpoint is not None:
        checkpoint()
    _reject_collisions(records, checkpoint=checkpoint)
    if checkpoint is not None:
        checkpoint()
    return ComponentManifest(
        schema_version=_require_schema(value["schema_version"]),
        component_id=_require_identifier(value["component_id"], "component_id"),
        files=records,
    )


def load_component_manifest(
    path: Path,
    *,
    checkpoint: Callable[[], None] | None = None,
) -> ComponentManifest:
    """Load one component manifest and reject ambiguous or unsafe inventory."""

    value = _load_json(Path(path))
    return _component_from_value(value, checkpoint=checkpoint)


def _require_setup_version(value: object) -> str:
    if not isinstance(value, str) or _VERSION_RE.fullmatch(value) is None:
        raise ManifestError("setup_center_version must use semantic version syntax")
    return value


def _require_https_url(value: object) -> str:
    if not isinstance(value, str):
        raise ManifestError("repair_url must be an HTTPS URL")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ManifestError("repair_url must be an HTTPS URL without credentials or fragment")
    return value


def _contained_file(root: Path, relative: PurePosixPath) -> Path:
    try:
        resolved_root = root.resolve(strict=True)
        candidate = (resolved_root / Path(*relative.parts)).resolve(strict=True)
    except OSError as error:
        raise ManifestError(f"component manifest cannot be resolved: {relative}") from error
    try:
        common = Path(os.path.commonpath((resolved_root, candidate)))
    except ValueError as error:
        raise ManifestError(f"component manifest escapes drive root: {relative}") from error
    if common != resolved_root or not candidate.is_file():
        raise ManifestError(f"component manifest escapes drive root or is not a file: {relative}")
    return candidate


def _parse_component_reference(
    value: object,
    index: int,
    root: Path,
    *,
    component_cache: MutableMapping[Path, ComponentManifest] | None = None,
    checkpoint: Callable[[], None] | None = None,
) -> ComponentReference:
    if not isinstance(value, dict):
        raise ManifestError(f"components[{index}] must be a JSON object")
    _require_exact_keys(
        value,
        required=frozenset({"component_id", "manifest", "sha256"}),
        context=f"components[{index}]",
    )
    component_id = _require_identifier(value["component_id"], f"components[{index}].component_id")
    relative = _safe_relative(value["manifest"], f"components[{index}].manifest")
    expected_digest = _require_hash(value["sha256"], f"components[{index}].sha256")
    component_path = _contained_file(root, relative)
    if checkpoint is not None:
        checkpoint()
    actual_digest = sha256_file(component_path)
    if actual_digest != expected_digest:
        raise ManifestError(f"component manifest digest mismatch: {relative}")
    component = (
        component_cache.get(component_path)
        if component_cache is not None
        else None
    )
    if component is None:
        component = load_component_manifest(component_path, checkpoint=checkpoint)
        if component_cache is not None:
            component_cache[component_path] = component
    if component.component_id != component_id:
        raise ManifestError(
            f"component_id mismatch for {relative}: expected {component_id}, got {component.component_id}"
        )
    return ComponentReference(component_id=component_id, manifest=relative, sha256=expected_digest)


def load_drive_manifest(
    root: Path,
    *,
    component_cache: MutableMapping[Path, ComponentManifest] | None = None,
    checkpoint: Callable[[], None] | None = None,
) -> DriveManifest:
    """Load and verify a Setup Drive marker and every component manifest."""

    drive_root = Path(root)
    value = _load_json(drive_root / "setup-drive.json")
    _require_exact_keys(
        value,
        required=frozenset(
            {"schema_version", "drive_id", "release_id", "setup_center_version", "components"}
        ),
        optional=frozenset({"repair_url"}),
        context="drive manifest",
    )
    components_value = value["components"]
    if not isinstance(components_value, list) or not components_value:
        raise ManifestError("drive manifest components must be a non-empty JSON array")
    components_list: list[ComponentReference] = []
    for index, item in enumerate(components_value):
        if checkpoint is not None:
            checkpoint()
        components_list.append(
            _parse_component_reference(
                item,
                index,
                drive_root,
                component_cache=component_cache,
                checkpoint=checkpoint,
            )
        )
    components = tuple(components_list)
    seen: set[str] = set()
    for component in components:
        folded = component.component_id.casefold()
        if folded in seen:
            raise ManifestError(f"component_id collision: {component.component_id}")
        seen.add(folded)
    repair_value = value.get("repair_url")
    repair_url = None if repair_value is None else _require_https_url(repair_value)
    return DriveManifest(
        schema_version=_require_schema(value["schema_version"]),
        drive_id=_require_identifier(value["drive_id"], "drive_id"),
        release_id=_require_identifier(value["release_id"], "release_id"),
        setup_center_version=_require_setup_version(value["setup_center_version"]),
        components=components,
        repair_url=repair_url,
    )


__all__ = [
    "ComponentManifest",
    "ComponentReference",
    "DriveManifest",
    "FileRecord",
    "ManifestError",
    "canonical_json_bytes",
    "load_component_manifest",
    "load_drive_manifest",
    "sha256_file",
]

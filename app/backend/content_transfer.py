"""Import / export of personal data and content packs ("Transfer & backup").

The Content Manager's four top actions all land here:

  * export personal data      -> RAR/7z archive of the user's own data
  * export content list       -> small JSON manifest of what is installed
  * import content list       -> read a partner's manifest and diff it locally
  * import content            -> extract a MedOS export archive and wire it in

Archives produced here are "special": they always contain a
``medos-export.json`` manifest at the package root, so any other MedOS
install can inspect and import them without guessing the layout.

Splitting: WinRAR's ``-v<size>`` (or 7-Zip's ``-v<size>``) writes volumes of
at most the requested size, so "2 GB parts" over 3 GB of data yields two
archives (2 GB + 1 GB).

Jobs run in a background thread because packs are multi-gigabyte; the
frontend polls ``/content/transfer/status``.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable, Optional

import pack_paths
import packs
from config import LIBRARY_PATH, ROOT

FORMAT = "medos-export"
LIST_FORMAT = "medos-content-list"
VERSION = 1

TRANSFER_DIR = ROOT / "data" / ".transfer"
IMPORT_DIR = ROOT / "data" / "imported"
BACKUP_DIR = ROOT / "data" / "backups" / "transfers"

# Personal data is snapshotted, never copied hot: SQLite files are backed up
# through the sqlite3 backup API so WAL contents are included consistently.
# users.sqlite (accounts + password hashes) is deliberately NOT exported.
PERSONAL_ITEMS: tuple[dict, ...] = (
    {
        "id": "personal:custom-library",
        "label": "My Library — saved articles, folders, annotations, images",
        "rel": "data/custom-library.sqlite3",
        "mode": "sqlite",
    },
    {
        "id": "personal:qbank",
        "label": "Q-Bank progress — sessions, answers, marks, notes, timers",
        "rel": "data/qbank_state.sqlite3",
        "mode": "sqlite",
    },
    {
        "id": "personal:flashcards",
        "label": "Flashcards progress",
        "rel": "data/anki_progress.sqlite",
        "mode": "sqlite",
    },
    {
        "id": "personal:book-priority",
        "label": "Bookshelf order & priorities",
        "rel": "data/book_priority.json",
        "mode": "file",
    },
    {
        "id": "personal:content-config",
        "label": "Content-folder locations (overrides)",
        "rel": "data/user_content.json",
        "mode": "file",
    },
)


# ── small helpers ───────────────────────────────────────────────────────────

def _now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _app_build() -> str:
    build = ROOT / "app" / ".next" / "BUILD_ID"
    try:
        return build.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_file() and not f.is_symlink():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def _safe_name(raw: str, fallback: str = "MedOS-export") -> str:
    name = re.sub(r"[^0-9A-Za-z._ -]+", "-", (raw or "").strip()).strip(" .-")
    name = re.sub(r"-{2,}", "-", name)
    return (name or fallback)[:120]


def _safe_rel(raw: str) -> Optional[str]:
    """A manifest path that stays inside its package root, or None."""
    text = (raw or "").replace("\\", "/").lstrip("/")
    if not text or re.match(r"^[A-Za-z]:", text):
        return None
    parts = [p for p in text.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _human_path(rel: str) -> Path:
    return ROOT / Path(rel)


def _free_bytes(path: Path) -> int:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0


def _cleanup_stale(folder: Path, pattern: str, max_age_hours: float) -> None:
    """Remove leftovers from a killed job (staging folders, old extractions)."""
    if not folder.is_dir():
        return
    cutoff = time.time() - max_age_hours * 3600
    for child in folder.glob(pattern):
        try:
            if child.stat().st_mtime >= cutoff:
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink()
        except OSError:
            continue


# ── external archivers ──────────────────────────────────────────────────────

def _program_files_candidates(*relative: str) -> list[str]:
    """Archiver locations under either Program Files root, whatever they are."""
    out: list[str] = []
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if base:
            out.append(str(Path(base).joinpath(*relative)))
    return out


def _rar_exe() -> Optional[str]:
    candidates = [
        os.environ.get("MEDOS_RAR_EXE"),
        *_program_files_candidates("WinRAR", "Rar.exe"),
        str(ROOT / "tools" / "winrar" / "Rar.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return shutil.which("rar")


def _seven_zip_exe() -> Optional[str]:
    candidates = [
        os.environ.get("MEDOS_7Z_EXE"),
        *_program_files_candidates("7-Zip", "7z.exe"),
        str(ROOT / "tools" / "7z" / "7z.exe"),
        str(ROOT / "tools" / "7zip" / "7z.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return shutil.which("7z")


def archive_tools() -> dict:
    rar = _rar_exe()
    seven = _seven_zip_exe()
    return {
        "rar": rar,
        "seven_zip": seven,
        "can_export": bool(rar or seven),
        "can_import": bool(rar or seven),
        "preferred": "rar" if rar else ("7z" if seven else None),
    }


# ── inventory / content list ────────────────────────────────────────────────

def _personal_inventory() -> list[dict]:
    out: list[dict] = []
    for item in PERSONAL_ITEMS:
        path = _human_path(item["rel"])
        size = path.stat().st_size if path.is_file() else 0
        out.append({
            "id": item["id"],
            "label": item["label"],
            "mode": item["mode"],
            "rel": item["rel"],
            "size": size,
            "exists": size > 0,
        })
    return out


# Pack ids that keep a row in the transfer list even with 0 bytes on disk, so
# users can see defined-but-not-built parts (e.g. FAISS/BM25 before indexing).
_LIST_WHEN_EMPTY = {"rag"}


def _library_books() -> list[dict]:
    """Every PDF in the bookshelf, with its shelf, size and library-relative path."""
    if not LIBRARY_PATH.is_dir():
        return []
    out: list[dict] = []
    try:
        candidates = sorted(LIBRARY_PATH.rglob("*.pdf"))
    except OSError:
        return []
    for pdf in candidates:
        try:
            if not pdf.is_file():
                continue
            rel = pdf.relative_to(LIBRARY_PATH).as_posix()
        except (OSError, ValueError):
            continue
        parts = rel.split("/")
        if any(part.startswith("_") for part in parts):
            continue
        try:
            size = pdf.stat().st_size
        except OSError:
            continue
        if size <= 0:
            continue
        out.append({
            "rel": rel,
            "id": f"book:{rel}",
            "name": pdf.stem,
            "shelf": "/".join(parts[:-1]),
            "size": size,
        })
    return out


def _content_inventory() -> list[dict]:
    tree = pack_paths.build_sync_tree(ROOT, pack_status=packs.all_pack_status())
    books: Optional[list[dict]] = None
    out: list[dict] = []
    for room in tree.get("rooms", []):
        for entry in room.get("entries", []):
            size = int(entry.get("size_on_disk") or 0)
            present = size > 0
            # Packs defined but not built yet (e.g. FAISS/BM25) still get a row
            # so the split is visible; everything else needs bytes to count.
            pack_id = str(entry.get("pack_id") or entry.get("id") or "")
            if not present and pack_id not in _LIST_WHEN_EMPTY:
                continue
            item = {
                "id": entry.get("id") or entry.get("pack_id"),
                "pack_id": entry.get("pack_id"),
                "room_id": room.get("id"),
                "room": room.get("label") or "Content",
                "label": entry.get("label") or entry.get("pack_id"),
                "description": entry.get("description") or "",
                "size": size,
                "present": present,
                "paths": list(entry.get("paths") or []),
                "scope": entry.get("scope") or "pack",
                "local_only": bool(entry.get("local_only")),
                "children": [
                    {
                        "label": c.get("label") or c.get("id"),
                        "size": int(c.get("size_on_disk") or 0),
                        "present": bool(c.get("present")),
                    }
                    for c in (entry.get("children") or [])
                ],
            }
            if pack_id == "books":
                if books is None:
                    books = _library_books()
                item["books"] = books
            out.append(item)
    return out


def inventory() -> dict:
    personal = _personal_inventory()
    content = _content_inventory()
    default_dest = str(Path.home() / "Downloads")
    if not Path(default_dest).is_dir():
        default_dest = str(ROOT / "exports")
    return {
        "personal": personal,
        "content": content,
        "personal_total": sum(p["size"] for p in personal),
        "content_total": sum(c["size"] for c in content),
        "app_build": _app_build(),
        "machine": socket.gethostname(),
        "tools": archive_tools(),
        "defaults": {
            "destination": default_dest,
            "name": f"MedOS-export-{datetime.now().strftime('%Y-%m-%d')}",
            "max_part_mb": 2048,
        },
        "free_bytes": _free_bytes(Path(default_dest)),
        "root": str(ROOT),
    }


# -- storage audit -----------------------------------------------------------
# Content Manager rows only ever covered shipped pack payloads, so the total
# looked smaller than the folder in Explorer. `storage()` reconciles the list
# against the real tree: content rows + personal data + regenerable caches +
# the MedOS program itself. Anything it cannot place is reported as "unmapped"
# so a future data folder can never silently disappear from the menu again.

_STORAGE_CACHE: dict[str, tuple[float, dict]] = {}
_STORAGE_TTL = 300.0

_MACHINE_LOCAL_DATA_DIRS = {
    ".cache",
    ".downloads",
    ".packs",
    ".transfer",
    "backups",
    "cache",
    "_fa_snippet_cache",
    "__pycache__",
    "imported",
}
_MACHINE_LOCAL_DATA_FILES = {
    "users.sqlite",
    "sync_node.json",
    "torrent_state.json",
    "ctgov_cache.sqlite",
}
_TRANSIENT_SUFFIXES = ("-wal", "-shm", "-journal", ".log", ".pid", ".tmp", ".err")


def _dir_bytes(path: Path) -> tuple[int, int]:
    """(bytes, files) for a file or directory tree, using scandir for speed."""
    if path.is_file():
        try:
            return path.stat().st_size, 1
        except OSError:
            return 0, 0
    total = 0
    count = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                            count += 1
                    except OSError:
                        continue
        except OSError:
            continue
    return total, count


def _is_transient_name(name: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(suffix) for suffix in _TRANSIENT_SUFFIXES)


def storage(force: bool = False) -> dict:
    """Explain the difference between the Content list and the folder size."""
    root_key = str(ROOT.resolve())
    now = time.time()
    hit = _STORAGE_CACHE.get(root_key)
    if hit and not force and now - hit[0] < _STORAGE_TTL:
        return hit[1]

    content = _content_inventory()
    personal = _personal_inventory()
    content_total = sum(int(c.get("size") or 0) for c in content)
    personal_total = sum(int(p.get("size") or 0) for p in personal if p.get("exists"))

    covered = {p.rstrip("/") for c in content for p in (c.get("paths") or [])}
    personal_files = {
        str(p.get("rel") or "").replace("\\", "/").rstrip("/")
        for p in personal
        if p.get("exists") and p.get("rel")
    }

    data = ROOT / "data"
    data_bytes, data_files = _dir_bytes(data)
    machine_local = 0
    unmapped_bytes = 0
    unmapped_files = 0
    unmapped: dict[str, list[int]] = {}

    for dirpath, dirnames, filenames in os.walk(data):
        directory = Path(dirpath)
        try:
            rel_dir = directory.relative_to(ROOT).as_posix()
        except ValueError:
            continue
        if rel_dir in covered:
            # Whole tree is a pack payload — already in content_total.
            dirnames[:] = []
            continue
        kept: list[str] = []
        for name in dirnames:
            child_rel = f"{rel_dir}/{name}"
            if child_rel in covered:
                continue  # counted by a pack row; do not walk twice
            if name in _MACHINE_LOCAL_DATA_DIRS:
                size, _files = _dir_bytes(directory / name)
                machine_local += size
                continue
            kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            rel = f"{rel_dir}/{name}"
            if rel in covered or rel in personal_files:
                continue
            try:
                size = (directory / name).stat().st_size
            except OSError:
                continue
            if name in _MACHINE_LOCAL_DATA_FILES or _is_transient_name(name):
                machine_local += size
                continue
            unmapped_bytes += size
            unmapped_files += 1
            group = "/".join(rel.split("/")[:3])
            slot = unmapped.setdefault(group, [0, 0])
            slot[0] += size
            slot[1] += 1

    # Program files and update payloads live outside data/. They are part of
    # the installation, not content, but showing them closes the total.
    buckets: list[dict] = []
    known = {
        "app": "MedOS program (app)",
        "tools": "Portable Python & Node",
        "android-companion": "Android companion",
    }
    outside_total = 0
    updates = [0, 0]
    other = [0, 0]
    for child in sorted(ROOT.iterdir(), key=lambda p: p.name.lower()):
        name = child.name
        if name == "data" or name in covered:
            continue
        size, count = _dir_bytes(child)
        outside_total += size
        if name in known:
            buckets.append({"id": name, "label": known[name], "bytes": size, "files": count})
        elif name in ("MedOS Update", ".medos-updates"):
            updates[0] += size
            updates[1] += count
        else:
            other[0] += size
            other[1] += count
    if updates[0]:
        buckets.append({
            "id": "updates",
            "label": "Update packages & backups",
            "bytes": updates[0],
            "files": updates[1],
        })
    root_files = 0
    try:
        for child in ROOT.iterdir():
            if child.is_file():
                try:
                    root_files += child.stat().st_size
                    other[1] += 1
                except OSError:
                    continue
    except OSError:
        pass
    outside_total += root_files
    other[0] += root_files
    if other[0]:
        buckets.append({
            "id": "other",
            "label": "Installer & docs",
            "bytes": other[0],
            "files": other[1],
        })

    total_bytes = data_bytes + outside_total
    reconciled = (
        content_total
        + personal_total
        + machine_local
        + unmapped_bytes
        + outside_total
    )
    result = {
        "root": str(ROOT),
        "total_bytes": total_bytes,
        "data_bytes": data_bytes,
        "data_files": data_files,
        "content_total": content_total,
        "content_items": len(content),
        "personal_total": personal_total,
        "machine_local_bytes": machine_local,
        "unmapped_bytes": unmapped_bytes,
        "unmapped_files": unmapped_files,
        "unmapped": [
            {"group": group, "bytes": values[0], "files": values[1]}
            for group, values in sorted(unmapped.items(), key=lambda kv: -kv[1][0])[:12]
        ],
        "buckets": buckets,
        "reconciled_bytes": reconciled,
        "gap_bytes": total_bytes - reconciled,
        "checked_at": datetime.now().isoformat(timespec="seconds"),
    }
    _STORAGE_CACHE[root_key] = (now, result)
    return result


def content_list() -> dict:
    personal = _personal_inventory()
    content = _content_inventory()
    return {
        "format": LIST_FORMAT,
        "version": VERSION,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "app_build": _app_build(),
        "machine": socket.gethostname(),
        "layout": "medos-folder",
        "personal": [
            {"id": p["id"], "label": p["label"], "size": p["size"]}
            for p in personal if p["exists"]
        ],
        "content": [
            {
                "id": c["id"],
                "pack_id": c["pack_id"],
                "room": c["room"],
                "label": c["label"],
                "size": c["size"],
                "present": c.get("present", c["size"] > 0),
                "children": c["children"],
            }
            for c in content
        ],
        "totals": {
            "personal_bytes": sum(p["size"] for p in personal if p["exists"]),
            "content_bytes": sum(c["size"] for c in content),
            "content_items": len(content),
        },
    }


def parse_list(payload: object) -> dict:
    """Diff a partner's content list against this machine."""
    if not isinstance(payload, dict):
        raise ValueError("That file is not a MedOS content list.")
    fmt = payload.get("format")
    if fmt not in (LIST_FORMAT, FORMAT):
        raise ValueError("That JSON file is not a MedOS content list or export manifest.")
    listed = payload.get("content")
    if not isinstance(listed, list):
        listed = []
    local = {c["id"]: c for c in _content_inventory()}
    have: list[dict] = []
    missing: list[dict] = []
    for item in listed:
        if not isinstance(item, dict):
            continue
        key = str(item.get("id") or item.get("pack_id") or "")
        if not key:
            continue
        summary = {
            "id": key,
            "label": item.get("label") or key,
            "size": int(item.get("size") or 0),
            "room": item.get("room") or "",
        }
        if key in local and local[key]["size"] > 0:
            summary["local_size"] = local[key]["size"]
            have.append(summary)
        else:
            missing.append(summary)
    return {
        "format": fmt,
        "created_at": payload.get("created_at"),
        "machine": payload.get("machine"),
        "app_build": payload.get("app_build"),
        "personal": payload.get("personal") or [],
        "content": listed,
        "have": have,
        "missing": missing,
        "listed_count": len(listed),
        "local_count": len(local),
        "listed_bytes": sum(int(i.get("size") or 0) for i in listed if isinstance(i, dict)),
    }


# ── job runner ──────────────────────────────────────────────────────────────

_lock = threading.Lock()
_job: dict = {
    "running": False,
    "action": None,
    "stage": "",
    "percent": None,
    "log": [],
    "error": None,
    "result": None,
    "preview": None,
    "token": None,
    "started_at": None,
    "finished_at": None,
}

_import_cache: dict[str, str] = {}


def _set(**fields) -> None:
    with _lock:
        _job.update(fields)


def _stage(stage: str, percent: Optional[float] = None) -> None:
    with _lock:
        _job["stage"] = stage
        if percent is not None:
            _job["percent"] = max(0.0, min(100.0, percent))
        _job["log"].append(stage)
        _job["log"] = _job["log"][-400:]


def status() -> dict:
    with _lock:
        return json.loads(json.dumps(_job))


def _begin(action: str) -> bool:
    with _lock:
        if _job["running"]:
            return False
        _job.update({
            "running": True,
            "action": action,
            "stage": "Starting…",
            "percent": 0.0,
            "log": [],
            "error": None,
            "result": None,
            "preview": None,
            "token": None,
            "started_at": time.time(),
            "finished_at": None,
        })
        return True


def _finish(result: Optional[dict] = None, error: Optional[str] = None) -> None:
    with _lock:
        _job.update({
            "running": False,
            "error": error,
            "result": result,
            "stage": "Done" if not error else "Failed",
            "percent": 100.0 if not error else _job.get("percent"),
            "finished_at": time.time(),
        })


def _spawn(action: str, target: Callable[[], None]) -> dict:
    if not _begin(action):
        return {"status": "busy", **status()}
    thread = threading.Thread(target=target, daemon=True)
    try:
        thread.start()
    except RuntimeError:
        _finish(error="Could not start the transfer worker; restart MedOS and retry.")
    return {"status": "started", "action": action}


def _run_guarded(fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI, never crashes the app
        print(f"[transfer] failed: {exc}")
        _finish(error=str(exc) or exc.__class__.__name__)


# ── export ──────────────────────────────────────────────────────────────────

def _snapshot_sqlite(src: Path, dst: Path) -> int:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    source = sqlite3.connect(str(src), timeout=30.0)
    try:
        source.execute("PRAGMA busy_timeout=30000")
        target = sqlite3.connect(str(dst), timeout=30.0)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    return dst.stat().st_size if dst.exists() else 0


def _link_or_copy(src: Path, dst: Path) -> int:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
        return 0  # hardlinked: nothing copied, but bytes are already in place
    except OSError:
        shutil.copy2(src, dst)
        size = 0
        try:
            size = dst.stat().st_size
        except OSError:
            pass
        return size


def _restore_sqlite(src: Path, target: Path) -> None:
    """Write an exported SQLite snapshot into the live database in place."""
    target.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(str(src), timeout=30.0)
    try:
        source.execute("PRAGMA busy_timeout=30000")
        destination = sqlite3.connect(str(target), timeout=30.0)
        try:
            destination.execute("PRAGMA busy_timeout=30000")
            source.backup(destination)
        finally:
            destination.close()
    finally:
        source.close()


def _copy_personal(staging: Path, items: Iterable[dict], progress: Callable[[int], None]) -> list[dict]:
    entries: list[dict] = []
    for item in items:
        if item.get("mode") == "sqlite":
            src = _human_path(item["rel"])
            if not src.is_file():
                continue
            stored = f"personal/{src.name}"
            size = _snapshot_sqlite(src, staging / Path(stored))
            entries.append({
                "id": item["id"],
                "label": item["label"],
                "mode": "sqlite",
                "source": item["rel"],
                "stored": stored,
                "size": size,
            })
            progress(size)
        else:
            src = _human_path(item["rel"])
            if not src.is_file():
                continue
            stored = f"personal/{src.name}"
            _link_or_copy(src, staging / Path(stored))
            try:
                size = (staging / Path(stored)).stat().st_size
            except OSError:
                size = 0
            entries.append({
                "id": item["id"],
                "label": item["label"],
                "mode": "file",
                "source": item["rel"],
                "stored": stored,
                "size": size,
            })
            progress(size)
    return entries


def _copy_content(staging: Path, entries: Iterable[dict], progress: Callable[[int], None]) -> list[dict]:
    """Stage the pack files that the torrent would ship.

    Uses ``pack_paths.iter_files_for_pack`` so the same exclusions apply as
    everywhere else in MedOS (loose Anki media, caches, WAL files, …).
    Files are grouped under their pack root (``data/uptodate``, ``data/anki``…)
    so an importing MedOS can run the normal folder detection on each root.
    """
    out: list[dict] = []
    for entry in entries:
        safe_id = _safe_name(entry["id"], "content")
        pack_id = str(entry.get("pack_id") or entry.get("id") or "")
        declared = [r for r in (_safe_rel(p) for p in entry.get("paths") or []) if r]

        # Per-book transfer: one PDF, staged on its own so the importing MedOS
        # can drop it straight into the same shelf instead of replacing the
        # whole Books pack.
        book_rel = _safe_rel(str(entry.get("book") or ""))
        if book_rel:
            src = LIBRARY_PATH / Path(book_rel)
            if not src.is_file():
                continue
            stored = f"content/{safe_id}/books/{book_rel}"
            target = staging / Path(stored)
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                _link_or_copy(src, target)
                size = target.stat().st_size
            except OSError:
                continue
            progress(size)
            out.append({
                "id": entry["id"],
                "pack_id": entry.get("pack_id"),
                "room": entry.get("room"),
                "label": entry["label"],
                "size": size,
                "book": book_rel,
                "stored": stored,
                "roots": [],
                "children": [],
            })
            continue

        # root → list of (source file, path relative to root)
        groups: dict[str, list[tuple[Path, Path]]] = {}
        if entry.get("scope") == "paths":
            # Local-only rows: copy exactly the advertised paths (they are
            # excluded from the torrent pack on purpose, e.g. Anki media).
            sources: Iterable[Path] = pack_paths.iter_files_for_transfer(ROOT, declared)
        else:
            sources = pack_paths.iter_files_for_pack(ROOT, pack_id)
        for src in sources:
            try:
                rel = src.relative_to(ROOT)
            except ValueError:
                continue
            rel_posix = rel.as_posix()
            # Longest declared prefix that contains this file.
            match = ""
            for prefix in declared:
                if rel_posix == prefix or rel_posix.startswith(prefix.rstrip("/") + "/"):
                    if len(prefix) > len(match):
                        match = prefix
            if match:
                root = match
            else:
                root = rel.parent.as_posix() or "."
            # A declared file prefix (e.g. data/uptodate/utdtoc.db) is grouped
            # by its parent so folder detection works on import.
            probe = ROOT / Path(root)
            if probe.is_file():
                root = Path(root).parent.as_posix() or "."
            inside = rel.relative_to(Path(root)) if root not in ("", ".") else rel
            groups.setdefault(root or ".", []).append((src, inside))

        roots: list[dict] = []
        for root, files in groups.items():
            stored_root = f"content/{safe_id}/{root}" if root != "." else f"content/{safe_id}"
            dst_root = staging / Path(stored_root)
            root_bytes = 0
            pending = 0
            pending_count = 0
            for src, inside in files:
                target = dst_root / inside
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists():
                        target.unlink()
                    try:
                        os.link(src, target)
                    except OSError:
                        shutil.copy2(src, target)
                    size = target.stat().st_size
                    root_bytes += size
                    pending += size
                    pending_count += 1
                except OSError:
                    continue
                # Batch progress updates: a pack can hold thousands of files.
                if pending >= 32 * 1024 * 1024 or pending_count >= 400:
                    progress(pending)
                    pending = 0
                    pending_count = 0
            if pending:
                progress(pending)
            if root_bytes <= 0:
                continue
            roots.append({"rel": root, "stored": stored_root, "size": root_bytes})

        out.append({
            "id": entry["id"],
            "pack_id": entry.get("pack_id"),
            "room": entry.get("room"),
            "label": entry["label"],
            "size": sum(r["size"] for r in roots),
            "roots": roots,
            "children": entry.get("children") or [],
        })
    return out


def _run_export(destination: str, name: str, personal_ids: list[str], content_ids: list[str], max_part_mb: float) -> None:
    personal_all = {p["id"]: p for p in _personal_inventory() if p["exists"]}
    content_all = {c["id"]: c for c in _content_inventory()}
    book_all = {b["id"]: b for b in _library_books()}
    personal = [personal_all[i] for i in personal_ids if i in personal_all]
    content = [content_all[i] for i in content_ids if i in content_all]
    for book_id in content_ids:
        book = book_all.get(book_id)
        if not book:
            continue
        content.append({
            "id": book["id"],
            "pack_id": "books",
            "room": "Books, First Aid & retrieval",
            "label": book["name"],
            "description": "Single book from your bookshelf",
            "size": book["size"],
            "present": True,
            "paths": [],
            "children": [],
            "book": book["rel"],
        })
    if not personal and not content:
        _finish(error="Nothing was selected to export.")
        return

    dest_dir = Path(destination).expanduser()
    if dest_dir.suffix.lower() in (".rar", ".7z", ".zip"):
        dest_dir = dest_dir.parent
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        _finish(error=f"Cannot create destination folder: {exc}")
        return
    if not os.access(dest_dir, os.W_OK):
        _finish(error=f"Destination folder is not writable: {dest_dir}")
        return

    tools = archive_tools()
    if not tools["can_export"]:
        _finish(error="WinRAR or 7-Zip is required to build archives. Install WinRAR (or 7-Zip) and try again.")
        return

    name = _safe_name(name)
    total_bytes = sum(p["size"] for p in personal) + sum(c["size"] for c in content)
    free = _free_bytes(dest_dir)
    staged = TRANSFER_DIR / f"{name}-{int(time.time())}"
    pkg = staged / name
    copied = 0

    def progress(size: int) -> None:
        nonlocal copied
        copied += max(0, size)
        pct = (copied / total_bytes * 100.0) if total_bytes else 0.0
        _stage(
            f"Staging {pct:.0f}% · {_fmt_bytes(copied)} of {_fmt_bytes(total_bytes)}",
            pct * 0.55,
        )

    try:
        pkg.mkdir(parents=True, exist_ok=True)
        _stage(f"Staging personal data and {len(content)} content item(s)…", 1.0)
        personal_entries = _copy_personal(pkg, personal, progress)
        content_entries = _copy_content(pkg, content, progress)

        manifest = {
            "format": FORMAT,
            "version": VERSION,
            "kind": "personal" if personal and not content else ("content" if content and not personal else "full"),
            "name": name,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "app_build": _app_build(),
            "machine": socket.gethostname(),
            "platform": platform.platform(),
            "layout": "medos-folder",
            "split_bytes": int(round(max(0.0, float(max_part_mb)) * 1024 * 1024)),
            "personal": personal_entries,
            "content": content_entries,
            "content_list": content_list(),
        }
        (pkg / "medos-export.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8", errors="replace"
        )
        (pkg / "README.txt").write_text(
            "MedOS export\r\n"
            "=============\r\n\r\n"
            "This archive was created by MedOS (Content Manager -> Transfer & backup).\r\n"
            "Import it from the same place on any MedOS machine:\r\n"
            "  Content Manager -> Import -> choose this archive -> Inspect -> Import.\r\n\r\n"
            "medos-export.json is the manifest. If the archive is split, select the\r\n"
            "first volume (.part1.rar, .part01.rar or .7z.001) and the rest are picked up automatically.\r\n",
            encoding="utf-8",
            errors="replace",
        )

        _stage("Compressing archive…", 58.0)
        volumes = _build_archive(pkg, dest_dir, name, max_part_mb, tools)
    except Exception as exc:  # noqa: BLE001
        _finish(error=str(exc) or exc.__class__.__name__)
        return
    finally:
        shutil.rmtree(staged, ignore_errors=True)

    _record_export(name, dest_dir, volumes)
    if total_bytes > free and free > 0:
        warn = f"Destination had only {_fmt_bytes(free)} free for {_fmt_bytes(total_bytes)} of content."
    else:
        warn = None
    _set(percent=100.0)
    _finish(result={
        "kind": "export",
        "name": name,
        "destination": str(dest_dir),
        "volumes": volumes,
        "bytes": sum(v["size"] for v in volumes),
        "split_mb": round(max(0.0, float(max_part_mb)), 3),
        "personal": [p["id"] for p in personal_entries],
        "content": [c["id"] for c in content_entries],
        "warning": warn,
    })


def _build_archive(pkg: Path, dest_dir: Path, name: str, max_part_mb: float, tools: dict) -> list[dict]:
    split_mb = max(0.0, float(max_part_mb))
    split_bytes = int(round(split_mb * 1024 * 1024))
    split_label = f"{split_mb:g}"
    exact_globs = [
        f"{name}.rar", f"{name}.part*.rar", f"{name}.r??", f"{name}.r???",
        f"{name}.7z", f"{name}.7z.*",
    ]
    for pattern in exact_globs:
        for stale in dest_dir.glob(pattern):
            try:
                if stale.is_file():
                    stale.unlink()
            except OSError:
                pass

    if tools.get("rar"):
        target = dest_dir / f"{name}.rar"
        cmd = [tools["rar"], "a", "-idq", "-r", "-m1", "-y"]
        if split_bytes:
            cmd.append(f"-v{split_bytes}b")
        cmd += [str(target), pkg.name]
        _stage(f"WinRAR: writing {target.name}{f' in {split_label} MB parts' if split_bytes else ''}…", 60.0)
        proc = subprocess.run(cmd, cwd=str(pkg.parent), capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            raise RuntimeError(f"WinRAR failed ({proc.returncode}): {(proc.stderr or proc.stdout or '').strip()[:400]}")
        # WinRAR writes a single "name.rar" when the compressed data fits in
        # one volume, even when -v was requested. Only multi-volume archives
        # get the .partN.rar names, so accept both here (and the older .r00
        # naming produced by some WinRAR versions).
        patterns = [f"{name}.part*.rar", f"{name}.rar", f"{name}.r??", f"{name}.r???"]
    else:
        seven = tools["seven_zip"]
        target = dest_dir / f"{name}.7z"
        cmd = [seven, "a", "-t7z", "-mx=1", "-y"]
        if split_bytes:
            cmd.append(f"-v{split_bytes}b")
        cmd += [str(target), "."]
        _stage(f"7-Zip: writing {target.name}{f' in {split_label} MB parts' if split_bytes else ''}…", 60.0)
        proc = subprocess.run(cmd, cwd=str(pkg), capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            raise RuntimeError(f"7-Zip failed ({proc.returncode}): {(proc.stderr or proc.stdout or '').strip()[:400]}")
        # 7-Zip likewise writes a single "name.7z" when the split limit was
        # never reached; only real split archives use name.7z.001, .002, ...
        patterns = [f"{name}.7z.*", f"{name}.7z"]

    files = sorted(
        {p for pattern in patterns for p in dest_dir.glob(pattern) if p.is_file()},
        key=lambda p: p.name,
    )
    if not files:
        raise RuntimeError(
            f"The archiver finished but no output file was found in {dest_dir} "
            f"(looked for: {', '.join(patterns)})."
        )
    return [{"name": p.name, "path": str(p), "size": p.stat().st_size} for p in files]


def start_export(destination: str, name: str, personal: list[str], content: list[str], max_part_mb: float) -> dict:
    _cleanup_stale(TRANSFER_DIR, "*", 12.0)
    return _spawn(
        "export",
        lambda: _run_guarded(
            lambda: _run_export(destination, name, personal, content, max_part_mb)
        ),
    )


# ── inspect / import ────────────────────────────────────────────────────────

def _find_manifest(root: Path) -> Optional[Path]:
    root = root.resolve()
    direct = root / "medos-export.json"
    if direct.is_file():
        return direct
    for candidate in sorted(root.rglob("medos-export.json")):
        try:
            if candidate.is_file() and len(candidate.relative_to(root).parts) <= 4:
                return candidate
        except ValueError:
            continue
    return None


def _extract_archive(archive: Path, dest: Path, tools: dict) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    lower = archive.name.lower()
    if lower.endswith((".rar", ".r00")):
        # RAR5 is common for vendor packs.  MedOS bundles 7-Zip for exactly
        # this, so a fresh EXE install can open them without WinRAR.
        if tools.get("seven_zip"):
            cmd = [tools["seven_zip"], "x", "-y", f"-o{dest}", str(archive)]
        elif tools.get("rar"):
            cmd = [tools["rar"], "x", "-idq", "-y", "-o+", str(archive), str(dest) + os.sep]
        else:
            raise RuntimeError(
                "7-Zip or WinRAR is needed to open .rar archives. Reinstall MedOS "
                "with the bundled 7-Zip tools, or export as .zip."
            )
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    elif lower.endswith((".7z", ".001", ".7z.001")) or ".7z." in lower:
        if not tools.get("seven_zip"):
            raise RuntimeError("7-Zip is needed to open .7z archives. Install 7-Zip or export as .rar.")
        cmd = [tools["seven_zip"], "x", "-y", f"-o{dest}", str(archive)]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    elif lower.endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(archive) as z:
            z.extractall(dest)
        proc = None
    else:
        raise RuntimeError("Unsupported archive type. Use a MedOS .rar / .7z export, or point at the extracted folder.")
    if proc is not None and proc.returncode != 0:
        raise RuntimeError(
            f"Could not extract the archive ({(proc.stderr or proc.stdout or '').strip()[:400]}). "
            "If it is split, select the first volume (.part1.rar, .part01.rar or .7z.001)."
        )

    root = dest.resolve()
    for path in dest.rglob("*"):
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if root != resolved and root not in resolved.parents:
            raise RuntimeError("The archive tried to write outside the import folder; import cancelled.")


def _manifest_preview(manifest: dict, pkg_root: Path) -> dict:
    personal = []
    for item in manifest.get("personal") or []:
        if not isinstance(item, dict):
            continue
        stored = _safe_rel(item.get("stored") or "")
        size = 0
        if stored:
            try:
                size = (pkg_root / Path(stored)).stat().st_size
            except OSError:
                size = int(item.get("size") or 0)
        personal.append({
            "id": item.get("id"),
            "label": item.get("label") or item.get("id"),
            "size": size,
            "stored": stored,
        })
    content = []
    for item in manifest.get("content") or []:
        if not isinstance(item, dict):
            continue
        book = _safe_rel(item.get("book") or "")
        if book:
            stored = _safe_rel(item.get("stored") or "")
            size = 0
            if stored:
                try:
                    size = (pkg_root / Path(stored)).stat().st_size
                except OSError:
                    size = int(item.get("size") or 0)
            content.append({
                "id": item.get("id"),
                "pack_id": item.get("pack_id"),
                "room": item.get("room"),
                "label": item.get("label") or book,
                "size": size,
                "book": book,
                "stored": stored,
                "roots": [],
                "children": [],
            })
            continue
        roots = []
        for root in item.get("roots") or []:
            if not isinstance(root, dict):
                continue
            stored = _safe_rel(root.get("stored") or "")
            if not stored:
                continue
            roots.append({
                "rel": root.get("rel"),
                "stored": stored,
                "size": _dir_bytes(pkg_root / Path(stored)),
            })
        content.append({
            "id": item.get("id"),
            "pack_id": item.get("pack_id"),
            "room": item.get("room"),
            "label": item.get("label") or item.get("id"),
            "size": sum(r["size"] for r in roots),
            "roots": roots,
            "children": item.get("children") or [],
        })
    return {
        "format": manifest.get("format"),
        "version": manifest.get("version"),
        "kind": manifest.get("kind"),
        "name": manifest.get("name"),
        "created_at": manifest.get("created_at"),
        "machine": manifest.get("machine"),
        "app_build": manifest.get("app_build"),
        "split_bytes": manifest.get("split_bytes") or 0,
        "personal": personal,
        "content": content,
        "personal_total": sum(p["size"] for p in personal),
        "content_total": sum(c["size"] for c in content),
        "package_root": str(pkg_root),
    }


def _run_inspect(path_text: str) -> None:
    path = Path(path_text).expanduser()
    if not path.exists():
        _finish(error=f"Path not found: {path}")
        return
    tools = archive_tools()

    if path.is_dir():
        pkg_root = path.resolve()
        extracted_dir = None
        _stage(f"Reading folder {pkg_root}…", 10.0)
    else:
        if not tools["can_import"]:
            _finish(error="WinRAR or 7-Zip is required to open export archives.")
            return
        _stage("Extracting archive for inspection…", 5.0)
        extracted_dir = IMPORT_DIR / f"inspect-{_now_stamp()}-{_safe_name(path.stem, 'package')}"
        try:
            _extract_archive(path, extracted_dir, tools)
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(extracted_dir, ignore_errors=True)
            _finish(error=str(exc))
            return
        manifest_path = _find_manifest(extracted_dir)
        if manifest_path is None:
            shutil.rmtree(extracted_dir, ignore_errors=True)
            _finish(error="No medos-export.json found. This is not a MedOS export archive.")
            return
        pkg_root = manifest_path.parent

    manifest_path = _find_manifest(pkg_root)
    if manifest_path is None:
        _finish(error="No medos-export.json found. This is not a MedOS export package.")
        return
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        _finish(error=f"Could not read medos-export.json: {exc}")
        return
    if manifest.get("format") != FORMAT:
        _finish(error="Unrecognized export format in medos-export.json.")
        return
    if int(manifest.get("version") or 0) > VERSION:
        _finish(error="This export was made by a newer MedOS version. Update MedOS, then import again.")
        return

    _stage("Reading manifest…", 90.0)
    preview = _manifest_preview(manifest, pkg_root)
    token = f"import-{int(time.time())}"
    _import_cache.clear()
    _import_cache[token] = str(extracted_dir or pkg_root)
    _set(token=token, preview=preview, percent=100.0)
    _finish(result={"kind": "inspect", "token": token, "preview": preview})


def start_inspect(path_text: str) -> dict:
    _cleanup_stale(IMPORT_DIR, "inspect-*", 48.0)
    _cleanup_stale(IMPORT_DIR, "import-*", 48.0)
    return _spawn("inspect", lambda: _run_guarded(lambda: _run_inspect(path_text)))


def _restore_personal(pkg_root: Path, entries: list[dict], stamp: str) -> list[dict]:
    restored: list[dict] = []
    backup_dir = BACKUP_DIR / stamp
    for entry in entries:
        stored = _safe_rel(entry.get("stored") or "")
        if not stored:
            continue
        src = pkg_root / Path(stored)
        if not src.is_file():
            continue
        item = next((p for p in PERSONAL_ITEMS if p["id"] == entry.get("id")), None)
        if item is None:
            continue
        target = _human_path(item["rel"])
        try:
            if target.is_file():
                backup_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup_dir / target.name)
            if item["mode"] == "sqlite":
                _restore_sqlite(src, target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
            restored.append({"id": item["id"], "label": item["label"], "path": str(target)})
        except Exception as exc:  # noqa: BLE001
            restored.append({"id": item["id"], "label": item["label"], "error": str(exc)})
    return restored


def _merge_into(src: Path, dst: Path) -> tuple[int, int, int]:
    """Copy ``src`` into ``dst`` without ever overwriting an existing file.

    Returns ``(copied_files, skipped_files, copied_bytes)``.  Merging keeps a
    partner's export from clobbering content the user already has, while still
    filling in missing files on a fresh machine.
    """
    copied = skipped = nbytes = 0
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            return 0, 1, 0
        shutil.copy2(src, dst)
        return 1, 0, dst.stat().st_size
    for folder, _dirs, files in os.walk(src):
        folder_path = Path(folder)
        target_dir = dst / folder_path.relative_to(src)
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            continue
        for name in files:
            source_file = folder_path / name
            target = target_dir / name
            if target.exists():
                skipped += 1
                continue
            try:
                shutil.copy2(source_file, target)
                copied += 1
                nbytes += target.stat().st_size
            except OSError:
                skipped += 1
    return copied, skipped, nbytes


# Which override keys each pack is allowed to set — prevents a broad root such
# as ``data`` from accidentally re-pointing an unrelated reader.
_PACK_OVERRIDE_KEYS: dict[str, set[str]] = {
    "uptodate": {"UTD_DB_PATH"},
    "amboss": {"AMBOSS_DIR", "AMBOSS_QBANK_DIR"},
    "drugs-pro": {"MICROMEDEX_DB", "MICROMEDEX_INTERACTION_DB", "LEXI_DB_PATH"},
    "uworld-step1": {"STEP1_DB_PATH"},
    "uworld-step2": {"STEP2_DB_PATH"},
    "uworld-step3": {"STEP3_DB_PATH"},
    "books": {"LIBRARY_PATH"},
    "firstaid": {"FIRSTAID_PDF"},
    "firstaid-index": {"FIRSTAID_INDEX_DB"},
    "rag": {"FAISS_DIR", "BM25_DIR", "MODELS_DIR", "VECTORSTORE_PATH"},
    "mehlman": {"MEHLMAN_DIR"},
    "uworld-library": {"LIBRARY_PATH"},
}

# Scanning these roots for signatures would traverse unrelated packs.
_BROAD_ROOTS = {"data", "data/books", ".", ""}


def _apply_content(pkg_root: Path, entries: list[dict], stamp: str) -> list[dict]:
    # lazy: avoids an import cycle
    from routers.content import ImportFolderRequest, _kick_index_refresh, import_folder

    results: list[dict] = []
    applied_keys: set[str] = set()
    book_rels: list[str] = []
    for entry in entries:
        roots = [r for r in (entry.get("roots") or []) if isinstance(r, dict)]
        _stage(f"Importing content: {entry.get('label') or entry.get('id')}…", 45.0)
        pack_id = str(entry.get("pack_id") or entry.get("id") or "")
        allowed_keys = _PACK_OVERRIDE_KEYS.get(pack_id, set())
        report: dict = {
            "id": entry.get("id"),
            "pack_id": entry.get("pack_id"),
            "label": entry.get("label"),
            "size": 0,
            "roots": [],
            "applied": [],
            "detected": [],
            "warnings": [],
        }

        book_rel = _safe_rel(str(entry.get("book") or ""))
        if book_rel:
            stored = _safe_rel(str(entry.get("stored") or ""))
            src = pkg_root / Path(stored) if stored else None
            target = LIBRARY_PATH / Path(book_rel)
            if src is not None and src.is_file():
                try:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.is_file() and target.stat().st_size == src.stat().st_size:
                        report["warnings"].append(f"{book_rel}: identical file already in the library")
                    else:
                        if target.exists():
                            report["warnings"].append(f"{book_rel}: replaced the existing copy")
                        shutil.copy2(src, target)
                        book_rels.append(book_rel)
                    report["book"] = book_rel
                    report["size"] = target.stat().st_size
                    report["applied"].append(entry.get("label") or Path(book_rel).stem)
                except OSError as exc:
                    report["warnings"].append(f"{book_rel}: {exc}")
            else:
                report["warnings"].append(f"{book_rel}: the book file is missing from the package")
            results.append(report)
            continue
        scan_dirs: list[Path] = []
        for root in roots:
            stored = _safe_rel(root.get("stored") or "")
            rel = _safe_rel(root.get("rel") or "")
            if not stored or not rel:
                continue
            src_root = pkg_root / Path(stored)
            if not src_root.exists():
                continue
            target = _human_path(rel)
            try:
                copied, skipped, nbytes = _merge_into(src_root, target)
            except Exception as exc:  # noqa: BLE001
                report["warnings"].append(f"{rel}: {exc}")
                continue
            report["roots"].append({
                "rel": rel,
                "path": str(target),
                "copied": copied,
                "skipped": skipped,
                "bytes": nbytes,
            })
            report["size"] += nbytes
            if target.is_dir() and rel not in _BROAD_ROOTS:
                scan_dirs.append(target)

        detections: list[dict] = []
        for folder in scan_dirs:
            try:
                res = import_folder(ImportFolderRequest(path=str(folder), refresh_index=False))
                detections.extend(res.get("detected") or [])
            except Exception as exc:  # noqa: BLE001
                report["warnings"].append(f"{folder.name}: {exc}")

        report["detected"] = [
            {"label": d.get("label"), "config_key": d.get("config_key"), "incomplete": bool(d.get("incomplete"))}
            for d in detections
            if not allowed_keys or d.get("config_key") in allowed_keys
        ]

        for detection in detections:
            key = detection.get("config_key")
            if not key or key in applied_keys or detection.get("incomplete"):
                continue
            if allowed_keys and key not in allowed_keys:
                continue
            try:
                res = import_folder(ImportFolderRequest(
                    path=str(Path(detection.get("value") or "")),
                    confirm_key=key,
                    refresh_index=False,
                ))
                if res.get("applied"):
                    applied_keys.add(key)
                    report["applied"].append(res["applied"].get("label") or key)
            except Exception as exc:  # noqa: BLE001
                report["warnings"].append(f"{key}: {exc}")

        results.append(report)

    # One coalesced reindex for the whole import.  Doing this inside every
    # import_folder() confirmation spawned concurrent rebuilds that collided on
    # global_search.sqlite.tmp when a pack exposed several override keys.
    if any(report.get("applied") for report in results):
        try:
            _kick_index_refresh("content import")
        except Exception as exc:  # noqa: BLE001
            print(f"[transfer] content reindex skipped: {exc}")

    if book_rels:
        try:
            from routers import library as library_router

            for rel in book_rels:
                library_router._sync_search_indexes_bg([rel], full=False)
        except Exception as exc:  # noqa: BLE001
            print(f"[transfer] book reindex skipped: {exc}")
    return results


def _run_import(token: str, path_text: str, personal_ids: list[str], content_ids: list[str]) -> None:
    root_text = _import_cache.get(token) or ""
    if not root_text and path_text:
        path = Path(path_text).expanduser()
        if not path.exists():
            _finish(error=f"Path not found: {path}")
            return
        if path.is_dir():
            root_text = str(path.resolve())
        else:
            tools = archive_tools()
            extracted = IMPORT_DIR / f"import-{_now_stamp()}-{_safe_name(path.stem, 'package')}"
            _stage("Extracting archive…", 5.0)
            _extract_archive(path, extracted, tools)
            root_text = str(extracted)
    if not root_text or not Path(root_text).exists():
        _finish(error="Inspect the export first, or choose the archive/folder again.")
        return

    root = Path(root_text)
    manifest_path = _find_manifest(root)
    if manifest_path is None:
        _finish(error="No medos-export.json found in that package.")
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig", errors="replace"))
    pkg_root = manifest_path.parent
    stamp = _now_stamp()

    personal_entries = [
        e for e in (manifest.get("personal") or [])
        if isinstance(e, dict) and (not personal_ids or e.get("id") in personal_ids)
    ]
    content_entries = [
        e for e in (manifest.get("content") or [])
        if isinstance(e, dict) and (not content_ids or e.get("id") in content_ids)
    ]
    if not personal_entries and not content_entries:
        _finish(error="Nothing was selected to import.")
        return

    restored: list[dict] = []
    if personal_entries:
        _stage(f"Restoring {len(personal_entries)} personal data item(s)…", 20.0)
        restored = _restore_personal(pkg_root, personal_entries, stamp)

    content_results: list[dict] = []
    if content_entries:
        _stage(f"Importing {len(content_entries)} content item(s)…", 45.0)
        content_results = _apply_content(pkg_root, content_entries, stamp)

    _finish(result={
        "kind": "import",
        "stamp": stamp,
        "personal": restored,
        "content": content_results,
        "package": str(pkg_root),
        "backups": str(BACKUP_DIR / stamp) if restored else None,
        "source_machine": manifest.get("machine"),
        "source_build": manifest.get("app_build"),
    })


def start_import(token: str, path_text: str, personal: list[str], content: list[str]) -> dict:
    return _spawn(
        "import",
        lambda: _run_guarded(
            lambda: _run_import(token, path_text, personal, content)
        ),
    )


def _run_quick_import(path_text: str) -> None:
    """One-click content import: extract, merge and wire in — personal data untouched.

    This is deliberately content-only.  Restoring personal databases is a
    separate, explicit choice in the detailed Import window because it replaces
    this machine's My Library / Q-Bank progress.
    """
    path = Path(path_text).expanduser()
    if not path.exists():
        _finish(error=f"Path not found: {path}")
        return

    if path.is_dir():
        root = path.resolve()
        pkg_root = root
    else:
        tools = archive_tools()
        if not tools["can_import"]:
            _finish(error="7-Zip is not available in this MedOS install. Reinstall MedOS to restore it.")
            return
        _stage(f"Extracting {path.name}…", 10.0)
        extracted = IMPORT_DIR / f"import-{_now_stamp()}-{_safe_name(path.stem, 'content')}"
        try:
            _extract_archive(path, extracted, tools)
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(extracted, ignore_errors=True)
            _finish(error=str(exc))
            return
        root = extracted
        manifest_path = _find_manifest(extracted)
        if manifest_path is None:
            _finish(error=(
                "No MedOS manifest found. Open the detailed Import window to inspect "
                "this archive, or point the folder scanner at the extracted content."
            ))
            return
        pkg_root = manifest_path.parent

    manifest_path = _find_manifest(pkg_root)
    if manifest_path is None:
        _finish(error="No medos-export.json found in that package.")
        return
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig", errors="replace"))
    except Exception as exc:  # noqa: BLE001
        _finish(error=f"Could not read medos-export.json: {exc}")
        return
    if manifest.get("format") != FORMAT:
        _finish(error="Unrecognized export format in medos-export.json.")
        return
    if int(manifest.get("version") or 0) > VERSION:
        _finish(error="This export was made by a newer MedOS version. Update MedOS, then import again.")
        return

    content_entries = [
        entry for entry in (manifest.get("content") or [])
        if isinstance(entry, dict)
    ]
    if not content_entries:
        _finish(error="This archive has no content items. Use the detailed Import window for personal data.")
        return

    _stage(f"Installing {len(content_entries)} content item(s)…", 45.0)
    content_results = _apply_content(pkg_root, content_entries, _now_stamp())
    _finish(result={
        "kind": "import",
        "stamp": _now_stamp(),
        "personal": [],
        "content": content_results,
        "package": str(pkg_root),
        "backups": None,
        "source_machine": manifest.get("machine"),
        "source_build": manifest.get("app_build"),
        "quick": True,
    })


def start_quick_import(path_text: str) -> dict:
    _cleanup_stale(IMPORT_DIR, "inspect-*", 48.0)
    _cleanup_stale(IMPORT_DIR, "import-*", 48.0)
    return _spawn("import", lambda: _run_guarded(lambda: _run_quick_import(path_text)))


def free_space(path_text: str) -> dict:
    """Free bytes on the volume that holds ``path_text`` (nearest ancestor)."""
    raw = (path_text or "").strip()
    path = Path(raw).expanduser() if raw else Path.home()
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return {
        "path": str(path),
        "probe": str(probe),
        "exists": path.exists(),
        "free": _free_bytes(probe),
    }


# ── exported-archive ledger + leftover cleanup ──────────────────────────────

EXPORT_LEDGER = TRANSFER_DIR / "exports.json"
_EXPORT_LEDGER_LOCK = threading.Lock()
_EXPORT_NAME_RE = re.compile(r"^MedOS[\s_-]*(?:export|backup)", re.IGNORECASE)
_VOLUME_SUFFIX_RE = re.compile(
    r"(?:\.part\d+\.rar|\.r\d{2,3}|\.7z\.\d{3,}|\.zip\.\d{3,}|\.rar|\.7z|\.zip)$",
    re.IGNORECASE,
)


def _read_export_ledger() -> list[dict]:
    try:
        data = json.loads(EXPORT_LEDGER.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data[-300:]:
        if isinstance(item, dict) and item.get("volumes"):
            out.append(item)
    return out


def _write_export_ledger(items: list[dict]) -> None:
    try:
        TRANSFER_DIR.mkdir(parents=True, exist_ok=True)
        temp = EXPORT_LEDGER.with_suffix(".tmp")
        temp.write_text(json.dumps(items[-300:], indent=2), encoding="utf-8")
        temp.replace(EXPORT_LEDGER)
    except OSError as exc:  # ledger is best-effort, never fails an export
        print(f"[transfer] export ledger write failed: {exc}")


def _record_export(name: str, dest_dir: Path, volumes: list[dict]) -> None:
    with _EXPORT_LEDGER_LOCK:
        items = _read_export_ledger()
        items.append({
            "name": name,
            "destination": str(dest_dir),
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "volumes": [
                {"name": v.get("name"), "path": v.get("path"), "size": int(v.get("size") or 0)}
                for v in volumes
                if isinstance(v, dict) and v.get("path")
            ],
        })
        _write_export_ledger(items)


def _is_export_archive_name(name: str) -> bool:
    return bool(_EXPORT_NAME_RE.match(name or "")) and bool(_VOLUME_SUFFIX_RE.search(name or ""))


def _export_scan_dirs() -> list[Path]:
    dirs: list[Path] = []
    for candidate in (Path.home() / "Downloads", ROOT / "exports", TRANSFER_DIR):
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved not in dirs:
            dirs.append(resolved)
    for entry in _read_export_ledger():
        raw = str(entry.get("destination") or "").strip()
        if not raw:
            continue
        try:
            resolved = Path(raw).expanduser().resolve()
        except OSError:
            continue
        if resolved not in dirs:
            dirs.append(resolved)
    return dirs


def _candidate_export_files() -> dict[str, Path]:
    """Every deletable leftover, keyed by resolved path."""
    found: dict[str, Path] = {}
    ledger_paths: set[str] = set()
    for entry in _read_export_ledger():
        for volume in entry.get("volumes") or []:
            raw = str((volume or {}).get("path") or "").strip()
            if not raw:
                continue
            try:
                ledger_paths.add(str(Path(raw).expanduser().resolve()))
            except OSError:
                continue
    for directory in _export_scan_dirs():
        if not directory.is_dir():
            continue
        try:
            children = list(directory.iterdir())
        except OSError:
            continue
        for child in children:
            try:
                if not child.is_file() or not _is_export_archive_name(child.name):
                    continue
                resolved = str(child.resolve())
            except OSError:
                continue
            if resolved in ledger_paths or _EXPORT_NAME_RE.match(child.name):
                found[resolved] = child
    for raw in ledger_paths:
        path = Path(raw)
        try:
            # Anything this feature wrote is a MedOS export even if the user
            # renamed the archive; the ledger is the source of truth for it.
            if path.is_file():
                found[str(path.resolve())] = path
        except OSError:
            continue
    return found


def _volume_family(name: str) -> str:
    lowered = name.lower()
    for pattern, replacement in (
        (r"\.part\d+\.rar$", ".rar"),
        (r"\.r\d{2,3}$", ".rar"),
        (r"\.7z\.\d{3,}$", ".7z"),
        (r"\.zip\.\d{3,}$", ".zip"),
    ):
        if re.search(pattern, lowered):
            return re.sub(pattern, replacement, name, flags=re.IGNORECASE)
    return name


def leftovers() -> dict:
    """Group MedOS export archives still sitting on disk for optional deletion."""
    files = _candidate_export_files()
    groups: dict[tuple[str, str], dict] = {}
    total = 0
    for resolved, path in files.items():
        try:
            stat = path.stat()
        except OSError:
            continue
        family = _volume_family(path.name)
        key = (str(path.parent), family)
        group = groups.setdefault(key, {
            "key": f"{path.parent}\\{family}",
            "name": family,
            "folder": str(path.parent),
            "size": 0,
            "created_at": "",
            "volumes": [],
        })
        modified = datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
        group["size"] += stat.st_size
        total += stat.st_size
        if not group["created_at"] or modified < group["created_at"]:
            group["created_at"] = modified
        group["volumes"].append({
            "name": path.name,
            "path": str(path),
            "size": stat.st_size,
            "modified_at": modified,
        })
    archives = sorted(groups.values(), key=lambda item: (item["created_at"], item["name"]), reverse=True)
    for archive in archives:
        archive["volumes"].sort(key=lambda item: item["name"].lower())
    return {
        "archives": archives,
        "count": sum(len(a["volumes"]) for a in archives),
        "total_bytes": total,
        "scan_dirs": [str(d) for d in _export_scan_dirs()],
    }


def delete_leftovers(paths: list[str]) -> dict:
    """Delete only files that :func:`leftovers` is currently offering."""
    allowed = _candidate_export_files()
    removed: list[dict] = []
    errors: list[dict] = []
    freed = 0
    requested = paths or list(allowed.keys())
    for raw in requested:
        try:
            resolved = str(Path(raw).expanduser().resolve())
        except OSError:
            errors.append({"path": raw, "error": "invalid path"})
            continue
        path = allowed.get(resolved)
        if path is None:
            errors.append({
                "path": raw,
                "error": "not a MedOS export archive offered for cleanup",
            })
            continue
        try:
            size = path.stat().st_size
            path.unlink()
            removed.append({"path": str(path), "name": path.name, "size": size})
            freed += size
        except OSError as exc:
            errors.append({"path": str(path), "error": str(exc)})

    if removed:
        removed_paths = {item["path"] for item in removed}
        with _EXPORT_LEDGER_LOCK:
            items = _read_export_ledger()
            kept: list[dict] = []
            for entry in items:
                volumes = [
                    v for v in entry.get("volumes") or []
                    if str(v.get("path") or "") not in removed_paths
                ]
                if volumes:
                    entry["volumes"] = volumes
                    kept.append(entry)
            _write_export_ledger(kept)

    return {
        "removed": removed,
        "errors": errors,
        "freed_bytes": freed,
        "remaining": leftovers(),
    }


# ── shelf import (single PDF) ───────────────────────────────────────────────

def _safe_pdf_name(raw: str) -> str:
    safe = Path(raw or "book.pdf").name
    safe = "".join(ch for ch in safe if ch not in '<>:"/\\|?*').strip()
    if not safe:
        safe = "book.pdf"
    if not safe.lower().endswith(".pdf"):
        safe += ".pdf"
    return safe


def library_shelves() -> dict:
    """Existing bookshelf folders, grouped for the "add a book" picker."""
    counts: dict[str, int] = {}
    if LIBRARY_PATH.is_dir():
        try:
            pdfs = list(LIBRARY_PATH.rglob("*.pdf"))
        except OSError:
            pdfs = []
        for pdf in pdfs:
            try:
                if not pdf.is_file():
                    continue
                parts = pdf.relative_to(LIBRARY_PATH).parts
            except (OSError, ValueError):
                continue
            if not parts or parts[0].startswith("_"):
                continue
            counts[parts[0]] = counts.get(parts[0], 0) + 1
            if len(parts) >= 2:
                nested = f"{parts[0]}/{parts[1]}"
                counts[nested] = counts.get(nested, 0) + 1
    shelves: list[dict] = [{
        "rel": "",
        "label": "Bookshelf root",
        "count": sum(count for rel, count in counts.items() if "/" not in rel),
        "depth": 0,
    }]
    for rel, count in sorted(counts.items(), key=lambda item: item[0].lower()):
        if "/" in rel:
            continue
        shelves.append({"rel": rel, "label": rel, "count": count, "depth": 0})
        for nested, nested_count in sorted(counts.items(), key=lambda item: item[0].lower()):
            if nested.startswith(rel + "/") and nested.count("/") == 1:
                shelves.append({
                    "rel": nested,
                    "label": nested.split("/", 1)[1],
                    "count": nested_count,
                    "depth": 1,
                })
    return {
        "root": str(LIBRARY_PATH),
        "exists": LIBRARY_PATH.exists(),
        "shelves": shelves,
    }


def import_book(path_text: str, shelf: str = "", name: str = "", index: bool = True, overwrite: bool = False) -> dict:
    source = Path((path_text or "").strip().strip('"')).expanduser()
    if not source.is_file():
        raise ValueError(f"PDF not found: {source}")
    if source.suffix.lower() != ".pdf":
        raise ValueError("Choose a PDF file.")

    shelf_rel = _safe_rel((shelf or "").replace("\\", "/")) if shelf else ""
    if shelf and shelf_rel is None:
        raise ValueError("That shelf path is not valid.")
    target_dir = LIBRARY_PATH / Path(shelf_rel) if shelf_rel else LIBRARY_PATH
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = _safe_pdf_name(name or source.name)
    target = target_dir / filename
    try:
        if target.exists() and target.resolve() == source.resolve():
            raise ValueError("That PDF already lives on this shelf.")
    except OSError:
        pass
    if target.exists() and not overwrite:
        raise ValueError(f"“{filename}” already exists on {shelf_rel or 'the bookshelf root'}.")

    try:
        shutil.copy2(source, target)
    except OSError as exc:
        raise ValueError(f"Could not copy the PDF into the library: {exc}") from exc

    rel = target.relative_to(LIBRARY_PATH).as_posix()
    indexed = False
    try:
        from routers import library as library_router

        if index:
            library_router._sync_search_indexes_bg([rel], full=False)
            indexed = True
        else:
            library_router._reindex_bg(force=False)
    except Exception as exc:  # noqa: BLE001
        print(f"[transfer] book index after import skipped: {exc}")

    return {
        "rel": rel,
        "path": str(target),
        "shelf": shelf_rel,
        "name": target.stem,
        "size": target.stat().st_size if target.exists() else 0,
        "indexed": indexed,
        "search_indexing": indexed,
    }


def _powershell_pick(script: str, timeout: int = 900) -> dict:
    if os.name != "nt":
        raise ValueError("The native file picker is only available on Windows.")
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=creation,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("The file picker timed out. Type the path instead.") from exc
    selected = (proc.stdout or "").strip().splitlines()
    value = selected[-1].strip() if selected else ""
    if proc.returncode != 0 and not value:
        detail = (proc.stderr or proc.stdout or "").strip()[:300]
        raise ValueError(f"Could not open the file picker: {detail}")
    return {"path": value, "cancelled": not value}


def pick_destination(initial: str = "") -> dict:
    """Ask Windows for a folder (used as an archive destination)."""
    safe = (initial or "").replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null\n"
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog\n"
        "$dialog.Description = 'Choose where MedOS should save the export'\n"
        "$dialog.ShowNewFolderButton = $true\n"
        f"if ('{safe}' -and (Test-Path -LiteralPath '{safe}')) {{ $dialog.SelectedPath = '{safe}' }}\n"
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [Console]::Out.WriteLine($dialog.SelectedPath) }\n"
    )
    return _powershell_pick(script)


def pick_archive(initial: str = "") -> dict:
    """Ask Windows for an export archive (or the first split volume)."""
    safe = (initial or "").replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null\n"
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog\n"
        "$dialog.Title = 'Choose a content archive (RAR, 7-Zip or ZIP)'\n"
        "$dialog.Filter = 'Content archives (*.rar;*.7z;*.zip;*.001)|*.rar;*.7z;*.zip;*.001|"
        "RAR archives (*.rar)|*.rar|7-Zip archives (*.7z)|*.7z|ZIP archives (*.zip)|*.zip|"
        "All files (*.*)|*.*'\n"
        "$dialog.Multiselect = $false\n"
        f"if ('{safe}' -and (Test-Path -LiteralPath '{safe}')) "
        f"{{ $dialog.InitialDirectory = (Split-Path -Parent '{safe}') }}\n"
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [Console]::Out.WriteLine($dialog.FileName) }\n"
    )
    return _powershell_pick(script)


def pick_pdf(initial: str = "") -> dict:
    """Ask Windows for a PDF (non-MedOS book or Q-Bank import)."""
    safe = (initial or "").replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Windows.Forms | Out-Null\n"
        "$dialog = New-Object System.Windows.Forms.OpenFileDialog\n"
        "$dialog.Title = 'Choose a PDF'\n"
        "$dialog.Filter = 'PDF files (*.pdf)|*.pdf|All files (*.*)|*.*'\n"
        "$dialog.Multiselect = $false\n"
        f"if ('{safe}' -and (Test-Path -LiteralPath '{safe}')) "
        f"{{ $dialog.InitialDirectory = (Split-Path -Parent '{safe}') }}\n"
        "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
        "{ [Console]::Out.WriteLine($dialog.FileName) }\n"
    )
    return _powershell_pick(script)


def pick_folder(initial: str = "") -> dict:
    """Ask Windows for an extracted export folder."""
    return pick_destination(initial)


def reveal(path_text: str) -> dict:
    path = Path(path_text).expanduser()
    if not path.is_dir():
        if path.is_file():
            path = path.parent
        else:
            raise ValueError(f"Folder not found: {path}")
    try:
        if os.name == "nt":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Could not open the folder: {exc}") from exc
    return {"opened": str(path)}


def _fmt_bytes(n: int) -> str:
    if n >= 1e9:
        return f"{n / 1e9:.2f} GB"
    if n >= 1e6:
        return f"{n / 1e6:.1f} MB"
    if n >= 1e3:
        return f"{n / 1e3:.0f} KB"
    return f"{n} B"



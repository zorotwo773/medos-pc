#!/usr/bin/env python3
"""
Build a SELF-CONTAINED MedOS live-folder torrent (public runtime only).

After download (save path = parent of MedOS), the user can run START.bat.

WHITELIST — only what the shipped app needs to run:
  - Launchers (START/STOP/ALLOW_LAN/launch.vbs + Mac .command)
  - app/.next (prebuilt), app/public, app/backend (no build scripts/tests)
  - app/node_modules (required for `npm start` / next)
  - app root: package.json, next.config, proxy, START, status_server, …
  - tools/ (bundled Python + Node)
  - mac/ runtime scripts
  - models/ + all content packs under data/
  - MedOS.apk + medos-phone-data.zip (if present)
  - End-user docs: RELEASE_README.txt, MedOS_USER_GUIDE.md, UPGRADE.md
  - Anki: collection.anki2 + collection.media.7z

NEVER shipped (private / unused / poison risk):
  - Frontend TS source (components, app/, lib, types, …)
  - CLAUDE.md, AGENTS.md, IMPLEMENTATION.md, .gitignore, eslint, tsconfig
  - Dev launchers (START_DEV, launch_dev), seeder-only notes
  - app/backend/scripts build tooling (the runtime seed helper is allowlisted)
    and tests, .env secrets
  - Loose Anki collection.media (ships as .7z)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import quote

ROOT_CANDIDATES = [
    Path(__file__).resolve().parents[3],
    Path(os.environ.get("MEDOS_ROOT") or Path.home() / "MedOS"),
]


def find_root() -> Path:
    for c in ROOT_CANDIDATES:
        if (c / "data").is_dir() and (c / "app").is_dir():
            return c
    return ROOT_CANDIDATES[0]


ROOT = find_root()
sys.path.insert(0, str(ROOT / "app" / "backend"))
import pack_paths  # noqa: E402


# --- Public root files (exact names) -----------------------------------------
LAUNCH_FILES = (
    "START.bat", "START.ps1", "STOP.bat", "STOP.ps1",
    "ALLOW_LAN.bat", "ALLOW_LAN.ps1",
    "launch.vbs",
    "MedOS.command", "MedOS-Setup.command", "MedOS-Stop.command",
    "INSTALL_FROM_PACKS.bat", "INSTALL_FROM_PACKS.ps1",
    "EXPORT_PROGRESS.bat", "EXPORT_PROGRESS.py",
    "IMPORT_PROGRESS.bat", "IMPORT_PROGRESS.py",
    "START_SEED_TRAY.bat", "STOP_SEED_TRAY.bat",
    "packs-map.json", "medos.ico", "MedOS.apk",
    "medos-phone-data.zip",
    "FETCH_MAC_TOOLS.ps1",
    "RELEASE_README.txt",
    "MedOS_USER_GUIDE.md",
    "UPGRADE.md",
    "RELEASE_MAC_OVERLAY_README.txt",
)

# Exact files under app/ (not a full directory dump).
APP_ROOT_FILES = (
    "package.json",
    "package-lock.json",
    "medos_server.mjs",
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "proxy.ts",
    "START.ps1",
    "START.bat",
    "status_server.py",
    "medos_kill.ps1",
    "postcss.config.mjs",
)

# Only these trees under app/ are walked.
APP_RUNTIME_DIRS = (
    ".next",
    "public",
    "backend",
    "node_modules",
    "chrome-extension",
)

# Walked outside app/ (still filtered by SKIP_*).
OTHER_RUNTIME_DIRS = (
    "tools",
    "mac",
    "models",
)

# Setup Drive preparation stores the dual-architecture runtimes outside the
# live folder. The torrent maps that verified payload back to MedOS/mac-tools
# so mac/start.sh can use it immediately after download.
MAC_RUNTIME_SOURCES = (
    Path("mac-tools"),
    Path(".medos-payload") / "mac-tools",
)

# Under app/backend — build tooling / tests stay private.
BACKEND_SKIP_DIRS = {
    "scripts",
    "tests",
    "__pycache__",
}

# Runtime helper required by START_SEED_TRAY.bat and the Content Manager.
# Every other backend script remains excluded as build/developer tooling.
BACKEND_RUNTIME_SCRIPTS = (
    "medos_seed_tray.py",
)

# Directory names skipped everywhere (except tools/node_modules).
SKIP_DIR = set(pack_paths.EXCLUDE_DIR_NAMES) | {
    ".git", ".tmp", "__pycache__", "dist", "phone", "scratch", "docs",
    "archive", ".venv", ".claude", ".vscode", ".idea", ".codex-run",
    "collection.media",
    "cache", ".cache",
}

SKIP_NAME = set(pack_paths.EXCLUDE_NAMES) | {
    ".env",
    ".env.local",
    ".env.backup",
    # Private / agent / dev docs — never seed
    "CLAUDE.md",
    "AGENTS.md",
    "IMPLEMENTATION.md",
    ".gitignore",
    ".dockerignore",
    ".gitattributes",
    "eslint.config.mjs",
    "tsconfig.json",
    "tsconfig.tsbuildinfo",
    "next-env.d.ts",
    "calc-debug.png",
    "thumb.jpg",
    "START_DEV.ps1",
    "START_DEV.bat",
    "launch_dev.vbs",
    "SEED_IN_UTORRENT.txt",
    "README.md",
    "RELEASE_APP_UPDATE_README.txt",
    "RELEASE_PACKS_README.txt",
    "make_app_launchers.sh",
}

SKIP_SUF = tuple(pack_paths.EXCLUDE_SUFFIXES) + (
    ".torrent", ".magnet.txt", ".log", ".pid", ".err", ".tmp",
    ".map",  # source maps not needed at runtime
    ".d.ts", ".d.cts", ".d.mts",  # Node/TypeScript declarations are compile-time only
)


def write_packs_map(root: Path) -> dict:
    mapping = pack_paths.all_pack_path_map(root)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "build_stamp": time.strftime("%Y%m%d-%H%M"),
        "layout": "medos-folder-self-contained",
        "torrent_root": "MedOS",
        "privacy": "public-runtime-only",
        "save_path_hint": f"Set download location to {root.parent}",
        "packs": mapping,
        "excluded_note": (
            "Public runtime only: .next + public + backend + node_modules + chrome-extension + tools + data. "
            "No frontend TS source, no CLAUDE/AGENTS/dev docs, no backend/scripts. "
            "Anki media = data/anki/collection.media.7z (extract on first START). "
            ".env excluded; START creates a local one."
        ),
    }
    text = json.dumps(payload, indent=2)
    for dest in (root / "packs-map.json", root / "data" / "packs-map.json"):
        try:
            _atomic_write(dest, text.encode("utf-8"))
        except OSError as exc:
            print(f"  WARNING: could not write {dest}: {exc}", flush=True)
    return payload


def _skip_file(p: Path) -> bool:
    name = p.name
    lower = name.lower()
    if name in SKIP_NAME or lower in SKIP_NAME:
        return True
    if any(lower.endswith(s) for s in SKIP_SUF):
        return True
    if lower.startswith(".env") and not lower.endswith(".example"):
        return True
    # Stray private / scratch names
    if lower in ("claude.md", "agents.md", "implementation.md"):
        return True
    if "clinical abbreviations" in lower:
        return True
    return False


def _dir_skipped(rel_parts: tuple[str, ...], *, under_tools: bool) -> bool:
    lower_parts = tuple(part.lower() for part in rel_parts)
    torch_headers = ("tools", "python", "lib", "site-packages", "torch", "include")
    if lower_parts[: len(torch_headers)] == torch_headers:
        return True
    if len(lower_parts) >= 4 and lower_parts[0] == "mac-tools":
        runtime, section = lower_parts[2], lower_parts[3]
        if (runtime, section) in {
            ("node", "include"),
            ("python", "include"),
        }:
            return True
        if lower_parts[2:5] == ("node", "lib", "node_modules"):
            return True
    # app/backend/{scripts,tests,…}
    if (
        len(rel_parts) >= 3
        and rel_parts[0] == "app"
        and rel_parts[1] == "backend"
        and rel_parts[2] in BACKEND_SKIP_DIRS
    ):
        return True
    for i, part in enumerate(rel_parts):
        if part == "node_modules":
            # Keep tools/**/node_modules, app/node_modules, and mac-tools/**/node_modules
            # (Darwin Next SWC binaries live under mac-tools/*/swc/node_modules).
            if under_tools or (rel_parts and rel_parts[0] in ("app", "mac-tools")):
                continue
            return True
        if part in SKIP_DIR:
            return True
        if part == ".next" and i + 1 < len(rel_parts) and rel_parts[i + 1] in (
            "cache", "dev", "trace", "types",
        ):
            return True
    return False


def iter_files(root: Path):
    seen: set[str] = set()

    def add(
        abs_p: Path,
        *,
        allow_skipped_dir: bool = False,
        torrent_relative: Path | None = None,
    ):
        try:
            if not abs_p.is_file() or _skip_file(abs_p):
                return
            relative = torrent_relative or abs_p.relative_to(root)
            rel_parts = relative.parts
            under_tools = bool(rel_parts) and rel_parts[0] == "tools"
            if not allow_skipped_dir and _dir_skipped(rel_parts, under_tools=under_tools):
                return
            size = abs_p.stat().st_size
            if size <= 0:
                return
            rel = relative.as_posix()
            key = rel.lower()
            if key in seen:
                return
            seen.add(key)
            yield f"MedOS/{rel}", abs_p, size
        except OSError:
            return

    def walk_tree(target: Path, *, torrent_prefix: Path | None = None):
        if not target.exists():
            return
        if target.is_file():
            yield from add(target, torrent_relative=torrent_prefix)
            return
        for dirpath, dirnames, filenames in os.walk(target):
            dp = Path(dirpath)
            try:
                if torrent_prefix is None:
                    rel_parts = dp.relative_to(root).parts
                else:
                    rel_parts = (torrent_prefix / dp.relative_to(target)).parts
            except ValueError:
                dirnames[:] = []
                continue
            under_tools = bool(rel_parts) and rel_parts[0] == "tools"
            keep = []
            for d in dirnames:
                trial = rel_parts + (d,)
                if _dir_skipped(trial, under_tools=under_tools):
                    continue
                if (
                    rel_parts
                    and rel_parts[0] == "app"
                    and len(rel_parts) >= 2
                    and rel_parts[1] == "backend"
                    and d in BACKEND_SKIP_DIRS
                ):
                    continue
                if rel_parts and rel_parts[-1] == ".next" and d in (
                    "cache", "dev", "trace", "types",
                ):
                    continue
                keep.append(d)
            dirnames[:] = keep
            for f in filenames:
                mapped = None
                if torrent_prefix is not None:
                    mapped = torrent_prefix / (dp / f).relative_to(target)
                yield from add(dp / f, torrent_relative=mapped)

    for f in LAUNCH_FILES:
        p = root / f
        if p.is_file():
            yield from add(p)

    app = root / "app"
    for name in APP_ROOT_FILES:
        p = app / name
        if p.is_file():
            yield from add(p)

    for d in APP_RUNTIME_DIRS:
        yield from walk_tree(app / d)

    for name in BACKEND_RUNTIME_SCRIPTS:
        helper = app / "backend" / "scripts" / name
        if helper.is_file():
            yield from add(helper, allow_skipped_dir=True)

    for d in OTHER_RUNTIME_DIRS:
        yield from walk_tree(root / d)

    for relative in MAC_RUNTIME_SOURCES:
        source = root / relative
        if source.is_dir():
            yield from walk_tree(source, torrent_prefix=Path("mac-tools"))
            break

    # Content packs
    for _pid, prefixes in pack_paths.all_pack_path_map(root).items():
        for pref in prefixes:
            pref_norm = pref.replace("\\", "/").rstrip("/")
            if pref_norm == "data/anki":
                anki = root / "data" / "anki"
                for name in ("collection.anki2", "collection.media.7z"):
                    p = anki / name
                    if p.is_file():
                        yield from add(p)
                if anki.is_dir():
                    for p in anki.iterdir():
                        if p.is_file() and p.name not in (
                            "collection.anki2", "collection.media.7z",
                        ):
                            yield from add(p)
                continue
            yield from walk_tree(root / Path(pref))

    p = root / "data" / "packs-map.json"
    if p.is_file():
        yield from add(p)

    ex = root / "app" / "backend" / ".env.example"
    if ex.is_file():
        yield from add(ex)


def materialize_mac_runtime(root: Path) -> Path:
    """Expose prepared Mac runtimes at the live-folder path using hardlinks."""
    destination = root / "mac-tools"
    if destination.is_dir():
        return destination
    if destination.exists():
        raise RuntimeError(f"macOS runtime destination is not a directory: {destination}")

    source = root / ".medos-payload" / "mac-tools"
    if not source.is_dir():
        return destination

    stage = root / ".tmp" / f"mac-tools-{os.getpid()}"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    try:
        for directory, names, filenames in os.walk(source, topdown=True, followlinks=False):
            current = Path(directory)
            relative = current.relative_to(source)
            for name in names:
                candidate = current / name
                if candidate.is_symlink():
                    raise RuntimeError(f"macOS runtime contains a symbolic link: {candidate}")
            names[:] = sorted(names, key=str.casefold)
            target_dir = stage / relative
            target_dir.mkdir(parents=True, exist_ok=True)
            for name in sorted(filenames, key=str.casefold):
                candidate = current / name
                if candidate.is_symlink() or not candidate.is_file():
                    raise RuntimeError(f"macOS runtime entry is not a regular file: {candidate}")
                os.link(candidate, target_dir / name)
        os.replace(stage, destination)
    finally:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
    return destination


def ensure_shipped_marker(root: Path) -> None:
    nxt = root / "app" / ".next"
    build_id = nxt / "BUILD_ID"
    marker = nxt / ".medos-shipped"
    if build_id.is_file() and not marker.is_file():
        # START.ps1 only needs the marker to exist; the installer regression
        # suite compares its contents with BUILD_ID, so record that id exactly.
        marker.write_text(build_id.read_text(encoding="utf-8").strip() + "\n", encoding="utf-8")
        print(f"  wrote {marker}", flush=True)


def _atomic_write(path: Path, payload: bytes) -> None:
    """Replace one distribution artifact without exposing partial bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp.write_bytes(payload)
        if path.exists():
            try:
                path.chmod(path.stat().st_mode | stat.S_IWRITE)
            except OSError:
                pass
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def publish_canonical_artifacts(
    *,
    raw_torrent: bytes,
    infohash: str,
    trackers,
    root: Path,
    out_dir: Path,
    stamp: str,
) -> dict:
    """Publish one torrent and one percent-encoded universal magnet."""
    magnet = "&".join(
        [f"magnet:?xt=urn:btih:{infohash.lower()}", "dn=MedOS"]
        + [f"tr={quote(str(tracker), safe='')}" for tracker in trackers[:6]]
    )
    torrent_path = out_dir / f"MedOS-{stamp}.torrent"
    torrent_outputs = (torrent_path, root / "MedOS.torrent")
    magnet_outputs = (
        out_dir / f"MedOS-{stamp}.magnet.txt",
        root / "MedOS.magnet.txt",
        root / "data" / "sync_magnet.txt",
    )
    for path in torrent_outputs:
        _atomic_write(path, raw_torrent)
    encoded_magnet = (magnet + "\n").encode("utf-8")
    for path in magnet_outputs:
        _atomic_write(path, encoded_magnet)
    return {
        "torrent_path": torrent_path,
        "torrent_outputs": torrent_outputs,
        "magnet_outputs": magnet_outputs,
        "magnet": magnet,
    }


def _required_present(root: Path) -> list[str]:
    """Hard requirements — abort torrent build if any are missing."""
    need = [
        "START.bat",
        "START.ps1",
        "app/START.ps1",
        "app/package.json",
        "app/medos_server.mjs",
        "app/.next/BUILD_ID",
        "app/node_modules/next/package.json",
        "app/backend/main.py",
        "tools/python/python.exe",
        "tools/node/node.exe",
    ]
    missing = [p for p in need if not (root / p).is_file()]
    mac_root = next(
        (root / relative for relative in MAC_RUNTIME_SOURCES if (root / relative).is_dir()),
        root / MAC_RUNTIME_SOURCES[-1],
    )
    for architecture in ("arm64", "x64"):
        for relative in ("python/bin/python3", "node/bin/node"):
            if not (mac_root / architecture / Path(relative)).is_file():
                missing.append(f"mac-tools/{architecture}/{relative}")
    return missing


def private_runtime_hits(files) -> list[str]:
    """Return paths that violate the public-runtime privacy contract."""
    allowed_backend_scripts = {
        f"/app/backend/scripts/{name.lower()}" for name in BACKEND_RUNTIME_SCRIPTS
    }
    banned_hits: list[str] = []
    for rel, _, _ in files:
        norm = rel.replace("\\", "/")
        low = norm.lower()
        if any(
            f"/app/{segment}/" in low
            for segment in (
                "components", "app", "lib", "types", "tests",
                "test-results", "infra", "scripts",
            )
        ):
            if "/app/backend/" not in low:
                banned_hits.append(rel)
                continue
        if "/app/backend/scripts/" in low and not any(
            low.endswith(allowed) for allowed in allowed_backend_scripts
        ):
            banned_hits.append(rel)
            continue
        if "/app/backend/tests/" in low:
            banned_hits.append(rel)
            continue
        if low.endswith(("/claude.md", "/agents.md", "/implementation.md")):
            banned_hits.append(rel)
            continue
        if "start_dev" in low or "launch_dev" in low:
            banned_hits.append(rel)
    return banned_hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--trackers", nargs="*", default=[
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://opentracker.i2p.rocks:6969/announce",
        "udp://tracker.torrent.eu.org:451/announce",
    ])
    ap.add_argument("--piece-size", type=int, default=16 * 1024 * 1024)
    ap.add_argument("--max-files", type=int, default=200000)
    ap.add_argument("--list-only", action="store_true",
                    help="Print file inventory and exit (no hash)")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    out_dir = Path(args.out_dir).resolve() if args.out_dir else root / "dist" / "medos-torrent"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Root: {root}", flush=True)
    tmp = root / ".tmp"
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)

    materialize_mac_runtime(root)
    missing = _required_present(root)
    if missing:
        print("ABORT: required runtime files missing:", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        return 2

    ensure_shipped_marker(root)
    anki_7z = root / "data" / "anki" / "collection.media.7z"
    if not anki_7z.is_file():
        print(
            "WARNING: data/anki/collection.media.7z missing — Anki images/audio "
            "will not be in the torrent. Pack it first (7z a -mx=0).",
            flush=True,
        )

    packs_map = write_packs_map(root)
    stamp = packs_map["build_stamp"]

    files = list(iter_files(root))
    n = len(files)
    total = sum(s for _, _, s in files)
    print(f"Files: {n}  (~{total/(1024**3):.2f} GiB)", flush=True)

    # Sanity: no private app paths slipped through
    banned_hits = private_runtime_hits(files)
    if banned_hits:
        print("ABORT: private/unused paths still included:", file=sys.stderr)
        for h in banned_hits[:20]:
            print(f"  - {h}", file=sys.stderr)
        return 2

    if args.list_only:
        by_top: dict[str, list] = {}
        for rel, _, size in files:
            parts = rel.replace("\\", "/").split("/")
            top = parts[1] if len(parts) > 1 else parts[0]
            by_top.setdefault(top, []).append(size)
        for top in sorted(by_top, key=lambda t: -sum(by_top[t])):
            sz = sum(by_top[top])
            print(f"  {len(by_top[top]):6d} files  {sz/1024**2:10.1f} MiB  {top}")
        return 0

    if n < 500:
        print("ABORT: too few files", file=sys.stderr)
        return 2
    if n > int(args.max_files):
        print(f"ABORT: {n} files > max {args.max_files} — metadata too large", file=sys.stderr)
        return 2

    import libtorrent as lt

    fs = lt.file_storage()
    fs.set_name("MedOS")
    print("Collecting PUBLIC-RUNTIME MedOS …", flush=True)
    for rel, abs_p, size in files:
        fs.add_file(rel.replace("/", "\\") if os.name == "nt" else rel, size)
    piece = int(args.piece_size)
    try:
        fs.set_piece_length(piece)
    except Exception:
        pass
    ct = lt.create_torrent(fs, piece, 64)
    print(f"Pieces: {fs.num_pieces()} @ {piece} bytes (v1-only)", flush=True)
    ct.set_comment(
        "MedOS public runtime. Save path = parent of MedOS. "
        "Run START.bat when complete. No source / private docs."
    )
    ct.set_creator("MedOS")
    for tr in args.trackers:
        ct.add_tracker(tr, 0)

    n_pieces = max(1, fs.num_pieces())
    last = [-1]

    def cb(idx) -> None:
        try:
            i = int(idx)
        except Exception:
            i = 0
        pct = int((i + 1) * 100 / n_pieces)
        if pct != last[0] and pct % 2 == 0:
            last[0] = pct
            print(f"  hash {pct}%", flush=True)

    print(f"Hashing via {root.parent} …", flush=True)
    lt.set_piece_hashes(ct, str(root.parent), cb)
    entry = ct.generate()
    raw = lt.bencode(entry)
    info = entry.get(b"info", entry.get("info"))
    if info is None:
        raise RuntimeError(f"torrent generate() missing info; keys={list(entry.keys())}")
    ih = hashlib.sha1(lt.bencode(info)).hexdigest()

    artifacts = publish_canonical_artifacts(
        raw_torrent=raw,
        infohash=ih,
        trackers=args.trackers,
        root=root,
        out_dir=out_dir,
        stamp=stamp,
    )
    tpath = artifacts["torrent_path"]
    magnet = artifacts["magnet"]
    (out_dir / "packs-map.json").write_text(json.dumps(packs_map, indent=2), encoding="utf-8")

    seed = f"""uTorrent — seed MedOS PUBLIC RUNTIME (download → START.bat)
================================================================
Torrent: ~{total/(1024**3):.1f} GiB  ({n} files)
Includes ONLY: app runtime (.next/public/backend/node_modules) + tools +
mac + APK + phone-data zip (if present) + content packs.
EXCLUDES: source code, CLAUDE/AGENTS, backend/scripts, dev launchers.

IMPORTANT — avoids "stuck at 99.9%":
  After ANY edit/rebuild under MedOS, run MAKE_MEDOS_TORRENT.ps1 again
  and re-add the torrent in uTorrent (Force Re-check → 100%).

1. Remove any OLD MedOS torrent from the client
2. Open: {root / 'MedOS.torrent'}
3. Save location: {root.parent}   (D:\\ if install is D:\\MedOS)
4. Force Re-check until 100%, then seed
5. Recipients: open MedOS\\START.bat when complete

Magnet:
{magnet}
"""
    (out_dir / "SEED_IN_UTORRENT.txt").write_text(seed, encoding="utf-8")
    (root / "SEED_IN_UTORRENT.txt").write_text(seed, encoding="utf-8")

    print(f"OK {tpath} ({tpath.stat().st_size} bytes)", flush=True)
    print(f"Infohash: {ih}", flush=True)
    print(magnet, flush=True)
    print(f"uTorrent save path: {root.parent}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

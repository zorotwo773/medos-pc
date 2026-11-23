#!/usr/bin/env python3
"""
Build a multi-file BitTorrent of the live MedOS data tree (no .7z packing).

Torrent layout (matches a normal install):
  MedOS/
    packs-map.json
    data/umls.sqlite
    data/uptodate/...
    ...

Seeders / downloaders set the torrent "download location" to the PARENT of
their MedOS folder (e.g. D:\\). Files already present are hashed and seeded —
zero extra disk for anyone who already has MedOS.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT_CANDIDATES = [
    Path(__file__).resolve().parents[3],  # …/MedOS from app/backend/scripts/
    Path(__file__).resolve().parents[2],
    Path(os.environ.get("MEDOS_ROOT") or Path.home() / "MedOS"),
]


def _find_root() -> Path:
    for c in ROOT_CANDIDATES:
        if (c / "data").is_dir() and (c / "app" / "backend").is_dir():
            return c
    return ROOT_CANDIDATES[0]


ROOT = _find_root()
sys.path.insert(0, str(ROOT / "app" / "backend"))
import pack_paths  # noqa: E402


def _link(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink():
        return
    if src.is_dir():
        if os.name == "nt":
            r = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
                capture_output=True, text=True,
            )
            if dst.exists():
                return
            raise RuntimeError(f"mklink failed for {src}: {r.stderr or r.stdout}")
        os.symlink(src, dst, target_is_directory=True)
    else:
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)


def stage_files(root: Path, medos_stage: Path, pack_ids: list[str] | None) -> dict[str, list[str]]:
    """Link pack files under medos_stage/ so torrent paths are MedOS/data/…"""
    mapping = pack_paths.all_pack_path_map(root)
    if pack_ids:
        mapping = {k: v for k, v in mapping.items() if k in pack_ids}

    included: dict[str, list[str]] = {}
    for pid, prefixes in mapping.items():
        kept: list[str] = []
        for rel in prefixes:
            src = root / Path(rel)
            if not src.exists():
                print(f"  skip missing: {rel}")
                continue
            pref = rel.replace("\\", "/").rstrip("/")
            if src.is_file():
                files = [] if pack_paths._is_excluded(src) else [src]
            else:
                files = [
                    f for f in pack_paths.iter_files_for_pack(root, pid)
                    if str(f.relative_to(root)).replace("\\", "/").startswith(pref)
                ]
            for f in files:
                rel_f = f.relative_to(root).as_posix()
                _link(f, medos_stage / rel_f)
            if files:
                kept.append(pref)
        if kept:
            included[pid] = kept
            nfiles = sum(
                1 for pref in kept
                for f in (root / Path(pref)).rglob("*") if f.is_file()
            ) if False else len(kept)
            print(f"  {pid}: {len(kept)} path prefix(es)")
    return included


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--packs", default="", help="comma-separated pack ids (default: all present)")
    ap.add_argument("--trackers", nargs="*", default=[
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://opentracker.i2p.rocks:6969/announce",
    ])
    args = ap.parse_args()

    root = Path(args.root).resolve()
    out_dir = Path(args.out_dir).resolve() if args.out_dir else root / "dist" / "data-torrent"
    out_dir.mkdir(parents=True, exist_ok=True)
    pack_ids = [p.strip() for p in args.packs.split(",") if p.strip()] or None

    stamp = time.strftime("%Y%m%d-%H%M")
    stage_root = Path(tempfile.mkdtemp(prefix=f"medos-data-torrent-{stamp}-"))
    medos_stage = stage_root / "MedOS"
    medos_stage.mkdir(parents=True)

    print(f"Root:  {root}")
    print(f"Stage: {medos_stage}")
    print(f"Out:   {out_dir}")

    try:
        included = stage_files(root, medos_stage, pack_ids)
        if not included:
            print("ABORT: nothing to pack", file=sys.stderr)
            return 2

        packs_map = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "build_stamp": stamp,
            "layout": "data",
            "torrent_root": "MedOS",
            "save_path_hint": (
                "Set the torrent download location to the PARENT of your MedOS folder "
                f"(e.g. {root.parent} if your install is {root}). "
                "Existing files are reused for seeding — no extra disk."
            ),
            "packs": included,
        }
        map_text = json.dumps(packs_map, indent=2)
        (medos_stage / "packs-map.json").write_text(map_text, encoding="utf-8")
        (out_dir / "packs-map.json").write_text(map_text, encoding="utf-8")
        # Also drop a copy under data/ so a running app finds it after seed/fetch
        data_map = root / "data" / "packs-map.json"
        try:
            data_map.write_text(map_text, encoding="utf-8")
        except OSError:
            pass

        try:
            from torf import Torrent
        except ImportError:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "torf"])
            from torf import Torrent

        torrent_path = out_dir / f"MedOS-data-{stamp}.torrent"
        print("Hashing (reads every included byte once — large packs take a while)…")
        t = Torrent(
            path=str(medos_stage),
            trackers=list(args.trackers),
            comment="MedOS live data — selective packs, seed from your install",
        )
        t.name = "MedOS"
        t.private = False
        t.generate(callback=lambda *_: None, interval=2)
        t.write(str(torrent_path), overwrite=True)
        magnet = str(t.magnet())
        (out_dir / f"MedOS-data-{stamp}.magnet.txt").write_text(magnet + "\n", encoding="utf-8")
        # Convenience copies at MedOS root for sharing
        try:
            shutil.copy2(torrent_path, root / "MedOS-data.torrent")
            (root / "MedOS-data.magnet.txt").write_text(magnet + "\n", encoding="utf-8")
        except OSError:
            pass

        print(f"OK {torrent_path} ({torrent_path.stat().st_size} bytes)")
        print(f"Info hash: {t.infohash}")
        print(f"Magnet: {magnet}")
        print()
        print("How to seed (no extra space):")
        print(f"  1. Open {torrent_path.name} in uTorrent / qBittorrent")
        print(f"  2. Set download location to: {root.parent}")
        print(f"  3. Start — it should find MedOS\\data\\… already present and seed")
        print()
        print("How to fetch on another machine:")
        print("  Paste the magnet into Content Manager, tick packs, Start fetch")
        print(f"  (save path is your MedOS folder's parent, or use in-app libtorrent)")
        return 0
    finally:
        # Remove junctions/links without deleting targets
        if os.name == "nt":
            # Junctions must be removed with rmdir, not DeleteFile
            for dirpath, dirnames, filenames in os.walk(stage_root, topdown=False):
                for name in filenames:
                    try:
                        Path(dirpath, name).unlink(missing_ok=True)
                    except OSError:
                        pass
                for name in dirnames:
                    p = Path(dirpath, name)
                    try:
                        p.rmdir()
                    except OSError:
                        subprocess.run(["cmd", "/c", "rmdir", str(p)], capture_output=True)
            shutil.rmtree(stage_root, ignore_errors=True)
        else:
            shutil.rmtree(stage_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

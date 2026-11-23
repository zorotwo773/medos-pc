#!/usr/bin/env python3
"""
MedOS background BitTorrent seeder (tray / no-UI helper).

Runs WITHOUT the FastAPI backend. Seeds the embedded MedOS.torrent / magnet
from the live install folder so peers can fetch while MedOS is closed.

Usage:
  tools\\python\\python.exe app\\backend\\scripts\\medos_seed_tray.py --root D:\\MedOS
  START_SEED_TRAY.bat
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import time
from pathlib import Path


def load_torrent_params(lt, torrent: Path, *, save_path: str):
    """Load the large MedOS file table using the app's explicit limits."""
    if hasattr(lt, "load_torrent_file"):
        size = torrent.stat().st_size
        params = lt.load_torrent_file(
            str(torrent),
            {
                "max_buffer_size": max(64 * 1024 * 1024, size + 1024 * 1024),
                "max_decode_tokens": 10_000_000,
                "max_pieces": 0x400000,
            },
        )
    else:
        params = lt.add_torrent_params()
        params.ti = lt.torrent_info(str(torrent))
    params.save_path = save_path
    return params


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="", help="MedOS install root")
    ap.add_argument("--upload-limit-kbps", type=int, default=0)
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[3]
    if not (root / "data").is_dir():
        print(f"ABORT: not a MedOS root: {root}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(root / "app" / "backend"))
    os.environ.setdefault("MEDOS_ROOT", str(root))

    try:
        import libtorrent as lt  # type: ignore
    except Exception as exc:
        print(f"ABORT: libtorrent required ({exc})", file=sys.stderr)
        return 2

    magnet = None
    for p in (root / "data" / "sync_magnet.txt", root / "MedOS.magnet.txt"):
        if p.is_file():
            text = p.read_text(encoding="utf-8").strip()
            if text.startswith("magnet:"):
                magnet = text.splitlines()[0].strip()
                break
    torrent = root / "MedOS.torrent"
    save_path = str(root.parent)
    pid_file = root / "data" / "seed_tray.pid"
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()), encoding="utf-8")

    stop = False

    def _stop(*_a):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    settings = {
        "listen_interfaces": "0.0.0.0:6882,[::]:6882",
        "enable_dht": True,
        "enable_lsd": True,
        "enable_upnp": True,
        "enable_natpmp": True,
        "max_metadata_size": 64 * 1024 * 1024,
    }
    try:
        sess = lt.session(settings)
    except Exception:
        sess = lt.session()

    try:
        if torrent.is_file():
            params = load_torrent_params(lt, torrent, save_path=save_path)
            handle = sess.add_torrent(params)
        elif magnet:
            params = lt.parse_magnet_uri(magnet)
            params.save_path = save_path
            handle = sess.add_torrent(params)
        else:
            print("ABORT: no MedOS.torrent / magnet", file=sys.stderr)
            return 2
    except Exception as exc:
        print(f"ABORT: add torrent failed: {exc}", file=sys.stderr)
        return 2

    if args.upload_limit_kbps:
        try:
            handle.set_upload_limit(args.upload_limit_kbps * 1024)
        except Exception:
            pass

    print(f"MedOS seed tray: save_path={save_path} pid={os.getpid()}", flush=True)
    last = -1
    while not stop:
        try:
            st = handle.status()
            pct = int(float(st.progress) * 100)
            if pct != last and pct % 5 == 0:
                print(
                    f"  {pct}%  ↑{st.upload_rate/1024:.0f}KB/s  "
                    f"peers={st.num_peers} seeds={st.num_seeds}",
                    flush=True,
                )
                last = pct
        except Exception:
            pass
        time.sleep(5)

    try:
        sess.remove_torrent(handle, 0)
    except Exception:
        pass
    try:
        pid_file.unlink(missing_ok=True)
    except Exception:
        pass
    print("MedOS seed tray stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
In-app pack fetching over BitTorrent (torrent_fetch.py).

Two distribution layouts (auto-detected from the torrent's file list):

  1. **data** (preferred) — the live MedOS tree (`data/umls.sqlite`,
     `data/uptodate/…`, …). Seeders point their client at their existing
     MedOS folder and use zero extra disk. Downloaders tick packs → only
     those path prefixes download, landing exactly where readers look.
     No 7z / password / extract step.

  2. **archives** (legacy) — `MedOS-<pack>-*.7z` files from PACK_PACKS.
     Still supported: sha256 → extract → verify.

Either way, selective download is per-file priority via libtorrent, and
every finished pack is functionally verified (packs.verify_pack) before it
joins search.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from config import ROOT

try:
    import pack_paths
except ImportError:
    pack_paths = None  # type: ignore

try:
    import libtorrent as lt  # type: ignore
    HAVE_LIBTORRENT = True
except Exception:
    lt = None  # type: ignore
    HAVE_LIBTORRENT = False

_STATE_FILE = ROOT / "data" / "torrent_state.json"
_DOWNLOADS_DIR = ROOT / "data" / ".downloads"
_MANIFEST_CANDIDATES = (
    ROOT / "data" / "packs-map.json",          # written into the data torrent
    ROOT / "dist" / "packs" / "packs-manifest.json",
    ROOT / "dist" / "data-torrent" / "packs-map.json",
    ROOT / "packs-manifest.json",
)
_PACK_FILENAME_RE = re.compile(r"MedOS-([a-z0-9][a-z0-9\-]*)-\d{6,}.*\.7z$", re.IGNORECASE)

_lock = threading.RLock()
_session = None  # type: ignore
_handle = None  # type: ignore
_state: dict = {
    "provider_uri": "",
    "seed_after_download": True,
    "auto_seed_on_start": True,
    "background_tray": False,
    "upload_limit_kbps": 0,
    "selected_packs": [],
    "mode": "idle",           # idle | libtorrent | watch-folder
    "layout": "unknown",      # data | archives | unknown
}
_watch_thread: Optional[threading.Thread] = None
_watch_stop = threading.Event()
_path_map_cache: dict[str, list[str]] = {}


def _load_state() -> None:
    if _STATE_FILE.exists():
        try:
            _state.update(json.loads(_STATE_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass


def _save_state() -> None:
    _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        _STATE_FILE.write_text(json.dumps(_state, indent=2), encoding="utf-8")
    except OSError:
        pass


_load_state()


def load_manifest() -> dict:
    for candidate in _MANIFEST_CANDIDATES:
        if candidate.exists():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except Exception:
                continue
    return {}


def _refresh_path_map() -> dict[str, list[str]]:
    """Prefer packs-map.json from a live data torrent; else the static map."""
    global _path_map_cache
    for candidate in (
        ROOT / "data" / "packs-map.json",
        ROOT / "dist" / "data-torrent" / "packs-map.json",
        ROOT / "packs-map.json",
    ):
        if candidate.exists():
            try:
                data = json.loads(candidate.read_text(encoding="utf-8"))
                packs = data.get("packs") or data
                if isinstance(packs, dict):
                    _path_map_cache = {str(k): list(v) for k, v in packs.items()}
                    return _path_map_cache
            except Exception:
                continue
    if pack_paths is not None:
        _path_map_cache = pack_paths.all_pack_path_map(ROOT)
    return _path_map_cache


# Paths that must stay downloadable even during selective pack sync — otherwise
# users hit 99.9% with APK/README "skip" forever (common uTorrent footgun).
_RUNTIME_PREFIXES = (
    "app/", "tools/", "mac/", "mac-tools/", "models/",
)
_RUNTIME_NAMES = {
    "medos.apk", "medos.ico", "medos-phone-data.zip",
    "start.bat", "start.ps1", "stop.bat", "stop.ps1",
    "allow_lan.bat", "allow_lan.ps1", "launch.vbs",
    "medos.command", "medos-setup.command", "medos-stop.command",
    "install_from_packs.bat", "install_from_packs.ps1",
    "export_progress.bat", "export_progress.py",
    "import_progress.bat", "import_progress.py",
    "packs-map.json", "packs-manifest.json",
    "release_readme.txt", "medos_user_guide.md", "upgrade.md",
    "package.json", "package-lock.json", "next.config.ts", "proxy.ts",
    "status_server.py", "medos_kill.ps1",
}


def _norm_torrent_rel(rel_path: str) -> str:
    norm = rel_path.replace("\\", "/").lstrip("./")
    if norm.startswith("MedOS/"):
        norm = norm[len("MedOS/"):]
    return norm


def _is_runtime_path(rel_path: str) -> bool:
    norm = _norm_torrent_rel(rel_path)
    if any(norm.startswith(p) for p in _RUNTIME_PREFIXES):
        return True
    name = Path(norm).name.lower()
    if name in _RUNTIME_NAMES:
        return True
    if name.endswith((".bat", ".ps1", ".command", ".vbs", ".apk", ".ico")):
        return True
    if name.endswith((".txt", ".md")) and name.startswith(
        ("release", "seed", "readme", "upgrade", "medos", "install")
    ):
        return True
    return False


def pack_id_from_filename(name: str) -> Optional[str]:
    m = _PACK_FILENAME_RE.search(name)
    return m.group(1) if m else None


def pack_id_from_torrent_path(rel_path: str) -> Optional[str]:
    """Resolve a torrent-internal path to a pack id (data layout or .7z)."""
    norm = _norm_torrent_rel(rel_path)
    if _is_runtime_path(norm):
        return "core"
    fname = Path(norm).name
    from_7z = pack_id_from_filename(fname)
    if from_7z:
        return from_7z
    mapping = _path_map_cache or _refresh_path_map()
    if pack_paths is not None:
        return pack_paths.pack_id_for_torrent_path(norm, mapping)
    return None


def _detect_layout(info) -> str:
    """data = live tree paths; archives = MedOS-*.7z payload."""
    try:
        n = info.num_files()
    except Exception:
        return "unknown"
    data_hits = 0
    archive_hits = 0
    for i in range(min(n, 200)):
        p = info.file_at(i).path.replace("\\", "/")
        if p.startswith("MedOS/"):
            p = p[len("MedOS/"):]
        name = Path(p).name
        if p.startswith("data/") or p.startswith("models/"):
            data_hits += 1
        if pack_id_from_filename(name):
            archive_hits += 1
    if data_hits > archive_hits:
        return "data"
    if archive_hits:
        return "archives"
    return "data" if data_hits else "unknown"


def _save_path_for_uri(uri: str) -> str:
    """Live MedOS-folder torrents use paths MedOS/app/…, MedOS/data/… →
    save into the PARENT of the install so the tree lands as …/MedOS/….
    Legacy 'packs' archive torrents still drop into .downloads."""
    u = (uri or "").lower()
    if "dn=packs" in u or (u.endswith(".torrent") and "packs-" in u and "medos-data" not in u and "/medos-" not in u.replace("\\", "/")):
        # Heuristic: old MedOS-packs-*.torrent archive layout
        if "medos-packs-" in u or "dn=packs" in u:
            _DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
            return str(_DOWNLOADS_DIR)
    # Default + MedOS-folder / data torrents
    return str(ROOT.parent)


def _find_7z() -> Optional[str]:
    for candidate in (
        ROOT / "tools" / "7z" / "7za.exe",
        ROOT / "tools" / "7z" / "7z.exe",
        ROOT / "app" / "backend" / "bin" / "7za.exe",
        Path("C:/Program Files/7-Zip/7z.exe"),
        Path("C:/Program Files (x86)/7-Zip/7z.exe"),
    ):
        if candidate.exists():
            return str(candidate)
    return shutil.which("7z") or shutil.which("7za")


def _sha256_file(path: Path, chunk_size: int = 4 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def verify_and_extract(archive_path: Path, expected_sha256: str | None = None, passphrase: str | None = None) -> dict:
    """Archive-layout only: sha256-check, extract into ROOT, re-verify pack."""
    if not archive_path.exists():
        return {"ok": False, "detail": f"{archive_path} not found"}

    if expected_sha256:
        actual = _sha256_file(archive_path)
        if actual.lower() != expected_sha256.lower():
            return {"ok": False, "detail": f"sha256 mismatch: expected {expected_sha256[:12]}…, got {actual[:12]}…"}

    seven_zip = _find_7z()
    if not seven_zip:
        return {"ok": False, "detail": "no 7z binary available — extract manually and re-verify"}

    cmd = [seven_zip, "x", str(archive_path), f"-o{ROOT}", "-y"]
    if passphrase:
        cmd.append(f"-p{passphrase}")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    except Exception as exc:
        return {"ok": False, "detail": f"extract failed to start: {exc}"}
    if proc.returncode != 0:
        return {"ok": False, "detail": f"7z exited {proc.returncode}: {proc.stderr[-400:]}"}

    pack_id = pack_id_from_filename(archive_path.name)
    verify_result = None
    if pack_id:
        try:
            import packs
            verify_result = packs.refresh(pack_id)
        except Exception as exc:
            verify_result = [{"id": pack_id, "state": "red", "detail": f"post-extract verify failed: {exc}"}]
    return {"ok": True, "detail": f"extracted {archive_path.name}", "pack_id": pack_id, "verify": verify_result}


def _verify_data_pack(pack_id: str) -> dict:
    try:
        import packs
        result = packs.refresh(pack_id)
        return {"ok": True, "pack_id": pack_id, "verify": result, "detail": f"verified {pack_id} in place"}
    except Exception as exc:
        return {"ok": False, "pack_id": pack_id, "detail": str(exc)}


# ── libtorrent path ─────────────────────────────────────────────────────────

def _ensure_session():
    global _session
    if _session is None and HAVE_LIBTORRENT:
        try:
            settings = {
                "listen_interfaces": "0.0.0.0:6881,[::]:6881",
                "enable_dht": True,
                "enable_lsd": True,
                "enable_upnp": True,
                "enable_natpmp": True,
                # The public MedOS torrent contains many runtime files. Its
                # metadata is intentionally larger than libtorrent's 10 MB
                # decode default, so accept the artifact the builder emits.
                "max_metadata_size": 64 * 1024 * 1024,
                "alert_mask": lt.alert.category_t.error_notification | lt.alert.category_t.status_notification,
            }
            _session = lt.session(settings)
        except Exception:
            _session = lt.session()
            try:
                _session.listen_on(6881, 6891)
            except Exception:
                pass
    return _session


def _infohash_from_magnet(uri: str) -> str:
    """Return lowercase hex infohash from a magnet, or ''."""
    u = (uri or "").strip()
    if not u.lower().startswith("magnet:"):
        return ""
    m = re.search(r"xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})", u)
    if not m:
        return ""
    raw = m.group(1)
    if len(raw) == 40:
        return raw.lower()
    # base32 → hex
    try:
        import base64
        pad = raw.upper() + "=" * ((8 - len(raw) % 8) % 8)
        return base64.b32decode(pad).hex()
    except Exception:
        return raw.lower()


def _load_torrent_info(path: Path):
    """Load a MedOS torrent with explicit limits for its large file table."""
    path = Path(path)
    if hasattr(lt, "load_torrent_file"):
        size = path.stat().st_size
        params = lt.load_torrent_file(
            str(path),
            {
                "max_buffer_size": max(64 * 1024 * 1024, size + 1024 * 1024),
                "max_decode_tokens": 10_000_000,
                "max_pieces": 0x400000,
            },
        )
        info = getattr(params, "ti", None)
        if info is not None:
            return info
    return lt.torrent_info(str(path))


def _local_torrent_for_uri(uri: str) -> Optional[Path]:
    """Prefer on-disk MedOS.torrent so we never wait on swarm metadata."""
    candidates = (
        ROOT / "MedOS.torrent",
        ROOT / "dist" / "medos-torrent" / "MedOS.torrent",
    )
    want = _infohash_from_magnet(uri) if (uri or "").lower().startswith("magnet:") else ""
    for path in candidates:
        if not path.is_file():
            continue
        if not want:
            return path
        try:
            info = _load_torrent_info(path)
            if str(info.info_hash()).lower() == want:
                return path
        except Exception:
            continue
    # Non-magnet file path that already points at a .torrent
    if uri and not uri.lower().startswith("magnet:"):
        p = Path(uri)
        if p.is_file() and p.suffix.lower() == ".torrent":
            return p
    return None


def _add_torrent(sess, uri: str, save_path: str):
    local = _local_torrent_for_uri(uri)
    add_uri = str(local) if local is not None else uri
    try:
        if add_uri.lower().startswith("magnet:"):
            params = lt.parse_magnet_uri(add_uri)
            params.save_path = save_path
            return sess.add_torrent(params)
        info = _load_torrent_info(Path(add_uri))
        params = lt.add_torrent_params()
        params.ti = info
        params.save_path = save_path
        h = sess.add_torrent(params)
        try:
            # Hash local MedOS/ tree immediately (don't wait for peers).
            h.force_recheck()
        except Exception:
            pass
        return h
    except Exception:
        p = {"save_path": save_path}
        if add_uri.lower().startswith("magnet:"):
            return lt.add_magnet_uri(sess, add_uri, p)
        p["ti"] = _load_torrent_info(Path(add_uri))
        return sess.add_torrent(p)


def _magnet_from_torrent_file(path: Path) -> Optional[str]:
    """Build a magnet:?xt=urn:btih:… URI from a .torrent on disk."""
    if not path.exists():
        return None
    if HAVE_LIBTORRENT:
        try:
            info = _load_torrent_info(path)
            ih = info.info_hash()
            hex_hash = str(ih)
            name = info.name() or path.stem
            trackers = []
            try:
                for tier in info.trackers():
                    url = getattr(tier, "url", None) or str(tier)
                    if url:
                        trackers.append(url)
            except Exception:
                pass
            parts = [f"magnet:?xt=urn:btih:{hex_hash}", f"dn={name}"]
            for t in trackers[:8]:
                parts.append(f"tr={t}")
            return "&".join(parts)
        except Exception:
            pass
    try:
        from torf import Torrent  # type: ignore
        t = Torrent.read(str(path))
        return str(t.magnet())
    except Exception:
        return None


def embedded_magnet() -> Optional[str]:
    """Magnet the app ships / last built — used as the default sync link."""
    for path in (
        ROOT / "data" / "sync_magnet.txt",
        ROOT / "MedOS.magnet.txt",
    ):
        if path.exists():
            try:
                text = path.read_text(encoding="utf-8").strip()
                if text.startswith("magnet:"):
                    return text.splitlines()[0].strip()
            except OSError:
                continue
    dist = ROOT / "dist" / "medos-torrent"
    if dist.exists():
        for p in sorted(dist.glob("*.magnet.txt"), key=lambda x: x.stat().st_mtime, reverse=True):
            try:
                text = p.read_text(encoding="utf-8").strip()
                if text.startswith("magnet:"):
                    return text.splitlines()[0].strip()
            except OSError:
                continue
    for tpath in (ROOT / "MedOS.torrent",):
        if tpath.exists():
            m = _magnet_from_torrent_file(tpath)
            if m:
                return m
    return None


def packs_dist_dir() -> Optional[Path]:
    """Return the folder containing the canonical MedOS distribution files."""
    configured = os.environ.get("MEDOS_PACKS_DIR", "").strip()
    candidates = (
        ROOT / "dist" / "medos-torrent",
        ROOT,
        ROOT / "dist" / "data-torrent",
        ROOT / "dist" / "packs",
        Path(configured) if configured else None,
        Path("D:/dist/medos-torrent"),
        Path("D:/dist/data-torrent"),
        Path("D:/dist/packs"),
    )
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            if candidate.exists() and (
                any(candidate.glob("MedOS*.torrent"))
                or any(candidate.glob("*.magnet.txt"))
                or (candidate / "packs-map.json").exists()
                or (candidate / "packs-manifest.json").exists()
            ):
                return candidate
        except OSError:
            continue
    return ROOT / "dist" / "medos-torrent"


def local_distribution() -> dict:
    """Describe the one live-folder torrent and its canonical magnet."""
    dist = packs_dist_dir()
    magnet = embedded_magnet()
    out: dict = {
        "dir": str(dist) if dist else None,
        "layout": "medos-folder",
        "manifest": None,
        "packs_map": None,
        "torrent_file": None,
        "torrent_url": None,
        "magnet": magnet,
        "artifact_consistent": None,
        "archives": [],
        "hint": (
            "Use this same torrent in MedOS or any BitTorrent client. "
            f"Set the download location to {ROOT.parent}, the parent of the MedOS folder."
        ),
    }

    for map_path in (
        ROOT / "packs-map.json",
        ROOT / "data" / "packs-map.json",
        (dist / "packs-map.json") if dist else None,
    ):
        if map_path is None or not map_path.is_file():
            continue
        try:
            out["packs_map"] = json.loads(map_path.read_text(encoding="utf-8"))
            break
        except Exception:
            continue

    torrents: list[Path] = []
    root_torrent = ROOT / "MedOS.torrent"
    if root_torrent.is_file():
        torrents.append(root_torrent)
    if dist and dist.exists():
        try:
            known = {path.resolve() for path in torrents}
            for candidate in sorted(
                dist.glob("MedOS*.torrent"),
                key=lambda path: path.stat().st_mtime,
                reverse=True,
            ):
                if candidate.resolve() not in known:
                    torrents.append(candidate)
                    known.add(candidate.resolve())
        except OSError:
            pass

    if torrents:
        torrent_path = torrents[0]
        torrent_hash = ""
        if HAVE_LIBTORRENT:
            try:
                torrent_hash = str(_load_torrent_info(torrent_path).info_hash()).lower()
            except Exception:
                pass
        magnet_hash = _infohash_from_magnet(magnet or "")
        consistent = not torrent_hash or not magnet_hash or torrent_hash == magnet_hash
        out["artifact_consistent"] = consistent
        if consistent:
            out["torrent_file"] = str(torrent_path)
            out["torrent_url"] = f"/content/torrent/file?name={torrent_path.name}"
            if not out["magnet"]:
                out["magnet"] = _magnet_from_torrent_file(torrent_path)
        else:
            out["hint"] = (
                "The magnet and local .torrent have different infohashes. "
                "Rebuild with MAKE_MEDOS_TORRENT.ps1 before sharing or seeding."
            )

    if dist and dist.exists():
        for archive in sorted(dist.glob("MedOS-*.7z")):
            try:
                out["archives"].append(
                    {
                        "name": archive.name,
                        "pack_id": pack_id_from_filename(archive.name),
                        "size_bytes": archive.stat().st_size,
                        "sha256": None,
                    }
                )
            except OSError:
                continue
    return out


def set_provider(uri: str) -> None:
    with _lock:
        _state["provider_uri"] = uri.strip()
        _save_state()


def _tray_pid_file() -> Path:
    return ROOT / "data" / "seed_tray.pid"


def _process_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _tray_pid() -> Optional[int]:
    path = _tray_pid_file()
    try:
        value = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    if _process_running(value):
        return value
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    return None


def _tray_running() -> bool:
    return _tray_pid() is not None


def set_seed_after_download(enabled: bool) -> None:
    with _lock:
        _state["seed_after_download"] = bool(enabled)
        _save_state()


def set_auto_seed_on_start(enabled: bool) -> None:
    with _lock:
        _state["auto_seed_on_start"] = bool(enabled)
        _save_state()


def set_upload_limit_kbps(kbps: int) -> None:
    value = max(0, int(kbps))
    with _lock:
        _state["upload_limit_kbps"] = value
        _save_state()
    if _handle is not None:
        try:
            _handle.set_upload_limit(value * 1024 if value else -1)
        except Exception:
            pass


def set_background_tray(enabled: bool) -> dict:
    enabled = bool(enabled)
    with _lock:
        _state["background_tray"] = enabled
        _save_state()

    if not enabled:
        pid = _tray_pid()
        if pid is not None:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            deadline = time.monotonic() + 3.0
            while _process_running(pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            if _process_running(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except (AttributeError, OSError):
                    pass
        try:
            _tray_pid_file().unlink(missing_ok=True)
        except OSError:
            pass
        return {"ok": True, "running": False, "detail": "background seeder off"}

    if _tray_running():
        return {"ok": True, "running": True, "detail": "background seeder already running"}
    script = ROOT / "app" / "backend" / "scripts" / "medos_seed_tray.py"
    if not script.is_file():
        with _lock:
            _state["background_tray"] = False
            _save_state()
        return {"ok": False, "running": False, "detail": f"seeder helper missing: {script}"}
    if not HAVE_LIBTORRENT:
        with _lock:
            _state["background_tray"] = False
            _save_state()
        return {"ok": False, "running": False, "detail": "libtorrent is not installed"}

    log_dir = ROOT / "data"
    log_dir.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(script), "--root", str(ROOT)]
    upload_cap = int(_state.get("upload_limit_kbps") or 0)
    if upload_cap:
        command.extend(["--upload-limit-kbps", str(upload_cap)])
    kwargs: dict = {"cwd": str(ROOT)}
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    else:
        kwargs["start_new_session"] = True
    try:
        with (
            (log_dir / "seed_tray.log").open("ab") as stdout,
            (log_dir / "seed_tray.err").open("ab") as stderr,
        ):
            process = subprocess.Popen(command, stdout=stdout, stderr=stderr, **kwargs)
    except OSError as exc:
        with _lock:
            _state["background_tray"] = False
            _save_state()
        return {"ok": False, "running": False, "detail": f"could not start background seeder: {exc}"}

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if _tray_running():
            return {
                "ok": True,
                "running": True,
                "pid": _tray_pid(),
                "detail": "background seeder running",
            }
        if process.poll() is not None:
            break
        time.sleep(0.05)
    with _lock:
        _state["background_tray"] = False
        _save_state()
    return {
        "ok": False,
        "running": False,
        "detail": f"background seeder exited before startup (code {process.poll()})",
    }


def auto_start_seed() -> dict:
    if not bool(_state.get("auto_seed_on_start", True)):
        return {"ok": True, "started": False, "detail": "auto-seed disabled"}
    if bool(_state.get("background_tray", False)):
        result = set_background_tray(True)
        return {**result, "started": bool(result.get("ok"))}
    result = start(list(_state.get("selected_packs") or []))
    return {**result, "started": bool(result.get("ok"))}


def get_state() -> dict:
    canonical = embedded_magnet()
    with _lock:
        return {
            **_state,
            "provider_uri": canonical or _state.get("provider_uri", ""),
            "have_libtorrent": HAVE_LIBTORRENT,
            "seven_zip_available": _find_7z() is not None,
            "save_path": _state.get("save_path") or str(ROOT.parent),
            "embedded_magnet": canonical,
            "background_tray_running": _tray_running(),
        }


def start(selected_packs: Optional[list[str]] = None) -> dict:
    """Open the provider link. Save path is the parent of MedOS for live-folder
    torrents (MedOS/data/… lands in place). Archive torrents still extract .7z."""
    canonical = embedded_magnet()
    with _lock:
        if selected_packs is not None:
            _state["selected_packs"] = selected_packs
            _save_state()
        uri = (canonical or _state.get("provider_uri") or "").strip()
        if canonical and _state.get("provider_uri") != canonical:
            _state["provider_uri"] = canonical
            _save_state()

    if not uri:
        uri = embedded_magnet() or ""
        if not uri:
            tfile = ROOT / "MedOS.torrent"
            if tfile.is_file():
                uri = str(tfile)
        if uri:
            set_provider(uri)

    _refresh_path_map()
    _start_watch_folder()

    if not uri:
        return {
            "ok": False,
            "detail": (
                "No magnet/torrent link set. Paste one in Content Manager, "
                "or place data/sync_magnet.txt / MedOS.magnet.txt from MAKE_MEDOS_TORRENT.ps1."
            ),
        }
    if not HAVE_LIBTORRENT:
        _state["mode"] = "watch-folder"
        _save_state()
        return {
            "ok": True,
            "mode": "watch-folder",
            "detail": (
                "libtorrent isn't installed — open the link in your own torrent client "
                f"with download folder set to {ROOT.parent} (parent of MedOS) or drop finished "
                f".7z files into {_DOWNLOADS_DIR}"
            ),
        }

    global _handle
    sess = _ensure_session()
    _DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    save_path = _save_path_for_uri(uri)
    local_t = _local_torrent_for_uri(uri)
    add_source = str(local_t) if local_t is not None else uri
    try:
        # Replacing an existing handle avoids a silent no-op when Start is clicked again.
        if _handle is not None:
            try:
                sess.remove_torrent(_handle, 0)
            except Exception:
                pass
            _handle = None
        _handle = _add_torrent(sess, uri, save_path)
    except Exception as exc:
        _state["mode"] = "watch-folder"
        _save_state()
        return {"ok": False, "detail": f"libtorrent failed to open link ({exc}); falling back to watch-folder"}
    try:
        cap = int(_state.get("upload_limit_kbps", 0))
        _handle.set_upload_limit(cap * 1024 if cap else -1)
    except Exception:
        pass

    _apply_selection(selected_packs or _state.get("selected_packs") or [])
    _state["mode"] = "libtorrent"
    _state["save_path"] = save_path
    _save_state()
    threading.Thread(target=_poll_completion, daemon=True).start()
    used_local = local_t is not None
    return {
        "ok": True,
        "mode": "libtorrent",
        "save_path": save_path,
        "detail": (
            f"Torrent opened from {'local MedOS.torrent (re-checking files)' if used_local else 'magnet'} "
            f"— save path {save_path}. "
            "Close uTorrent/qBittorrent on this folder while seeding in-app (two clients conflict)."
        ),
    }


def pause() -> dict:
    if _handle is None:
        return {"ok": False, "detail": "no active torrent"}
    try:
        _handle.pause()
        return {"ok": True, "detail": "paused"}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


def resume() -> dict:
    if _handle is None:
        return {"ok": False, "detail": "no active torrent"}
    try:
        _handle.resume()
        return {"ok": True, "detail": "resumed"}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


def update_selection(selected_packs: list[str]) -> dict:
    selected = list(selected_packs)
    with _lock:
        _state["selected_packs"] = selected
        _save_state()
    _apply_selection(selected)
    return {"ok": True, "selected_packs": selected}


def _poll_completion() -> None:
    """When selected packs finish: data layout → verify in place; archives → extract."""
    seen_complete: set[str] = set()
    applied_meta = False
    while _state.get("mode") == "libtorrent" and _handle is not None:
        time.sleep(3)
        info = _torrent_info()
        if info is None:
            continue
        if not applied_meta:
            _apply_selection(_state.get("selected_packs") or [])
            applied_meta = True
            _refresh_path_map()

        layout = _detect_layout(info)
        try:
            fp = _handle.file_progress()
        except Exception:
            continue

        if layout == "data":
            by_pack: dict[str, list[tuple[int, int]]] = {}
            for i in range(info.num_files()):
                rel = info.file_at(i).path.replace("\\", "/")
                pid = pack_id_from_torrent_path(rel)
                if not pid:
                    continue
                done = int(fp[i]) if i < len(fp) else 0
                size = int(info.file_at(i).size)
                by_pack.setdefault(pid, []).append((done, size))
            selected = _state.get("selected_packs") or []
            for pid, parts in by_pack.items():
                if selected and pid not in selected:
                    continue
                if pid in seen_complete:
                    continue
                if parts and all(d >= s > 0 for d, s in parts):
                    _verify_data_pack(pid)
                    seen_complete.add(pid)
        else:
            manifest = load_manifest()
            hashes = {e.get("id"): e.get("sha256") for e in manifest.get("packs", [])} if manifest else {}
            for i in range(info.num_files()):
                f = info.file_at(i)
                rel = Path(f.path)
                done = int(fp[i]) if i < len(fp) else 0
                if done < int(f.size):
                    continue
                key = str(rel)
                if key in seen_complete:
                    continue
                archive = ROOT / rel
                if not archive.exists():
                    archive = _DOWNLOADS_DIR / rel
                if not archive.exists() or not archive.name.lower().endswith(".7z"):
                    continue
                pack_id = pack_id_from_filename(archive.name)
                verify_and_extract(archive, hashes.get(pack_id) if pack_id else None)
                seen_complete.add(key)

        if not _state.get("seed_after_download"):
            try:
                unfinished = False
                selected = _state.get("selected_packs") or []
                for i in range(info.num_files()):
                    rel = info.file_at(i).path.replace("\\", "/")
                    pid = pack_id_from_torrent_path(rel)
                    if selected and pid not in selected and pid is not None:
                        continue
                    if int(fp[i]) < int(info.file_at(i).size):
                        unfinished = True
                        break
                if not unfinished:
                    _handle.pause()
            except Exception:
                pass


def _start_watch_folder() -> None:
    global _watch_thread
    _DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    if _watch_thread and _watch_thread.is_alive():
        return
    _watch_stop.clear()
    _watch_thread = threading.Thread(target=_watch_loop, daemon=True)
    _watch_thread.start()


def _watch_loop(poll_seconds: float = 10.0) -> None:
    manifest = load_manifest()
    hashes = {e.get("id"): e.get("sha256") for e in manifest.get("packs", [])} if manifest else {}
    seen_done: set[str] = set()
    while not _watch_stop.is_set():
        try:
            for archive in list(_DOWNLOADS_DIR.glob("*.7z")) + list(ROOT.glob("MedOS-*.7z")):
                key = f"{archive.name}:{archive.stat().st_mtime_ns}"
                marker = archive.with_suffix(archive.suffix + ".medos-done")
                if marker.exists() or key in seen_done:
                    continue
                pack_id = pack_id_from_filename(archive.name)
                result = verify_and_extract(archive, hashes.get(pack_id))
                if result.get("ok"):
                    marker.write_text(json.dumps(result), encoding="utf-8")
                seen_done.add(key)
        except Exception:
            pass
        _watch_stop.wait(poll_seconds)


def stop_watch_folder() -> None:
    _watch_stop.set()


def _torrent_info():
    if _handle is None:
        return None
    for getter in ("torrent_file", "get_torrent_info"):
        try:
            fn = getattr(_handle, getter, None)
            if fn is None:
                continue
            info = fn()
            if info is not None:
                return info
        except Exception:
            continue
    return None


def _apply_selection(selected_packs: list[str]) -> None:
    if _handle is None:
        return
    try:
        _handle.resume()
    except Exception:
        pass
    info = _torrent_info()
    if info is None:
        return
    layout = _detect_layout(info)
    _state["layout"] = layout
    _save_state()
    # Try to pull packs-map.json out of the torrent once it exists on disk.
    map_on_disk = ROOT / "packs-map.json"
    if not map_on_disk.exists():
        map_on_disk = ROOT / "data" / "packs-map.json"
    if map_on_disk.exists():
        _refresh_path_map()

    priorities = []
    for i in range(info.num_files()):
        rel = info.file_at(i).path.replace("\\", "/")
        fname = Path(rel).name
        pack_id = pack_id_from_torrent_path(rel)
        is_sidecar = pack_id is None and (
            fname.lower() in ("packs-map.json", "packs-manifest.json", "readme.txt")
            or fname.lower().endswith((".json", ".txt", ".torrent", ".magnet.txt", ".md"))
        )
        is_runtime = _is_runtime_path(rel) or pack_id == "core"
        # Empty selection = full swarm. Selective still always keeps runtime so
        # START.bat / APK / README never sit at "skip" blocking 100%.
        wanted = (not selected_packs) or (pack_id in selected_packs) or is_sidecar or is_runtime
        priorities.append(4 if wanted else 0)
    try:
        _handle.prioritize_files(priorities)
    except Exception:
        pass


def clear_skips(include_optional: bool = True) -> dict:
    """Un-skip every file (or at least runtime + selected) so 99.9% can finish."""
    if _handle is None:
        return {"ok": False, "detail": "no active torrent"}
    info = _torrent_info()
    if info is None:
        return {"ok": False, "detail": "metadata not ready yet"}
    selected = list(_state.get("selected_packs") or [])
    if include_optional or not selected:
        priorities = [4] * info.num_files()
        with _lock:
            _state["selected_packs"] = []
            _save_state()
    else:
        _apply_selection(selected)
        return {"ok": True, "detail": "restored selection priorities (runtime always on)"}
    try:
        _handle.prioritize_files(priorities)
        _handle.resume()
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}
    return {"ok": True, "detail": f"all {len(priorities)} files set to download/seed"}


def force_recheck() -> dict:
    if _handle is None:
        return {"ok": False, "detail": "no active torrent"}
    try:
        _handle.force_recheck()
        _handle.resume()
        return {"ok": True, "detail": "re-check started — matches pieces you already have on disk"}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


def force_announce() -> dict:
    if _handle is None:
        return {"ok": False, "detail": "no active torrent"}
    try:
        _handle.force_reannounce()
        return {"ok": True, "detail": "announced to trackers"}
    except Exception as exc:
        return {"ok": False, "detail": str(exc)}


def incomplete_files(limit: int = 40) -> dict:
    """List incomplete or priority-skipped files (explains 99.9% stalls)."""
    if _handle is None or not HAVE_LIBTORRENT:
        return {"files": [], "incomplete_count": 0, "skipped_count": 0}
    info = _torrent_info()
    if info is None:
        return {"files": [], "incomplete_count": 0, "skipped_count": 0}
    # During hash-check every file looks incomplete — skip the 80k-file walk.
    try:
        st = _handle.status()
        state_name = str(getattr(st, "state", "")).lower()
        if "check" in state_name:
            return {
                "files": [],
                "incomplete_count": 0,
                "skipped_count": 0,
                "checking": True,
                "truncated": False,
            }
    except Exception:
        pass
    try:
        fp = _handle.file_progress()
    except Exception:
        fp = []
    try:
        prios = list(_handle.get_file_priorities())
    except Exception:
        prios = []
    out = []
    incomplete = skipped = 0
    for i in range(info.num_files()):
        f = info.file_at(i)
        size = int(f.size)
        done = int(fp[i]) if i < len(fp) else 0
        prio = int(prios[i]) if i < len(prios) else 4
        if prio <= 0:
            skipped += 1
        if done < size:
            incomplete += 1
        if done >= size and prio > 0:
            continue
        if len(out) < limit:
            out.append({
                "path": f.path.replace("\\", "/"),
                "size": size,
                "downloaded": done,
                "progress": round(done / size, 4) if size else 1.0,
                "priority": prio,
                "skipped": prio <= 0,
                "pack_id": pack_id_from_torrent_path(f.path),
            })
    return {
        "files": out,
        "incomplete_count": incomplete,
        "skipped_count": skipped,
        "truncated": incomplete + skipped > limit,
    }


def _eta_seconds(remaining_bytes: int, rate_bytes: float) -> Optional[int]:
    if remaining_bytes <= 0:
        return 0
    if rate_bytes <= 0:
        return None
    return int(remaining_bytes / rate_bytes)


def status() -> dict:
    with _lock:
        mode = _state.get("mode", "idle")
        selected = list(_state.get("selected_packs") or [])
        layout = _state.get("layout", "unknown")
    base = {
        "mode": mode,
        "layout": layout,
        "have_libtorrent": HAVE_LIBTORRENT,
        "selected_packs": selected,
        "save_path": _state.get("save_path") or str(ROOT.parent),
        "seed_after_download": bool(_state.get("seed_after_download", True)),
        "auto_seed_on_start": bool(_state.get("auto_seed_on_start", True)),
        "background_tray": bool(_state.get("background_tray", False)),
        "upload_limit_kbps": int(_state.get("upload_limit_kbps") or 0),
        "packs": [],
    }
    if mode != "libtorrent" or _handle is None or not HAVE_LIBTORRENT:
        return base
    try:
        s = _handle.status()
    except Exception as exc:
        return {**base, "error": str(exc)}

    info = _torrent_info()
    dl_rate = float(getattr(s, "download_rate", 0) or 0)
    ul_rate = float(getattr(s, "upload_rate", 0) or 0)
    num_seeds = int(getattr(s, "num_seeds", 0) or 0)
    num_peers = int(getattr(s, "num_peers", 0) or 0)
    total_seeds = int(getattr(s, "num_complete", -1) or -1)
    total_peers = int(getattr(s, "num_incomplete", -1) or -1)
    availability = float(getattr(s, "distributed_copies", -1.0) or -1.0)
    progress = float(getattr(s, "progress", 0) or 0)
    total_done = int(getattr(s, "total_done", 0) or 0)
    total_wanted = int(getattr(s, "total_wanted", 0) or 0)
    total_wanted_done = int(getattr(s, "total_wanted_done", 0) or 0)
    all_time_upload = int(getattr(s, "all_time_upload", 0) or 0)
    all_time_download = int(getattr(s, "all_time_download", 0) or 0)
    total_upload = int(getattr(s, "total_upload", 0) or all_time_upload or 0)
    total_download = int(getattr(s, "total_download", 0) or all_time_download or 0)
    ratio = (total_upload / total_download) if total_download > 0 else (1.0 if progress >= 0.999 else 0.0)
    paused = bool(getattr(s, "paused", False))
    is_seeding = progress >= 0.999 or str(getattr(s, "state", "")).endswith("seeding")
    pieces_have = int(getattr(s, "num_pieces", 0) or 0)
    try:
        pieces_total = int(info.num_pieces()) if info is not None else 0
    except Exception:
        pieces_total = 0

    # Health 0–100: availability + peer presence + completeness
    health = 10
    if progress >= 0.999:
        health = 55
    if num_peers > 0:
        health += min(25, 5 + num_peers * 2)
    if num_seeds > 0:
        health += min(15, 5 + num_seeds * 3)
    if availability > 0:
        health += min(30, int(availability * 10))
    if paused:
        health = max(5, health - 20)
    health = max(0, min(100, health))

    packs_out: list[dict] = []
    has_metadata = info is not None
    incomplete_hint = incomplete_files(12) if has_metadata else {
        "files": [], "incomplete_count": 0, "skipped_count": 0, "truncated": False,
    }
    if has_metadata:
        layout = _detect_layout(info)
        _state["layout"] = layout
        try:
            fp = _handle.file_progress()
        except Exception:
            fp = []
        agg: dict[str, dict] = {}
        order: list[str] = []
        for i in range(info.num_files()):
            f = info.file_at(i)
            rel = f.path.replace("\\", "/")
            pid = pack_id_from_torrent_path(rel) or "_other"
            if pid not in agg:
                agg[pid] = {"pack_id": None if pid == "_other" else pid, "size": 0, "downloaded": 0, "files": 0}
                order.append(pid)
            a = agg[pid]
            a["size"] += int(f.size)
            a["downloaded"] += int(fp[i]) if i < len(fp) else 0
            a["files"] += 1
        for pid in order:
            a = agg[pid]
            remaining = max(0, a["size"] - a["downloaded"])
            prog = (a["downloaded"] / a["size"]) if a["size"] else 0.0
            wanted = (not selected) or (a["pack_id"] in selected) or a["pack_id"] is None or a["pack_id"] == "core"
            packs_out.append({
                **a,
                "progress": round(prog, 4),
                "selected": bool(wanted),
                "complete": a["size"] > 0 and a["downloaded"] >= a["size"],
                "eta_seconds": _eta_seconds(remaining, dl_rate) if wanted and not (a["downloaded"] >= a["size"]) else 0,
            })

    return {
        **base,
        "layout": _state.get("layout", layout),
        "has_metadata": has_metadata,
        "state": str(getattr(s, "state", "")),
        "paused": paused,
        "is_seeding": is_seeding,
        "progress": round(progress, 4),
        "download_rate_kbps": round(dl_rate / 1024, 1),
        "upload_rate_kbps": round(ul_rate / 1024, 1),
        "num_seeds": num_seeds,
        "num_peers": num_peers,
        "total_seeds": total_seeds,
        "total_peers": total_peers,
        "availability": round(availability, 2),
        "health": health,
        "ratio": round(ratio, 3),
        "uploaded_bytes": total_upload,
        "downloaded_bytes": total_download,
        "total_download_bytes": total_done,
        "total_wanted_bytes": total_wanted,
        "total_wanted_done_bytes": total_wanted_done,
        "pieces_have": pieces_have,
        "pieces_total": pieces_total,
        "list_peers": int(getattr(s, "list_peers", 0) or 0),
        "list_seeds": int(getattr(s, "list_seeds", 0) or 0),
        "eta_seconds": _eta_seconds(max(0, total_wanted - total_wanted_done), dl_rate),
        "incomplete_count": incomplete_hint.get("incomplete_count", 0),
        "skipped_count": incomplete_hint.get("skipped_count", 0),
        "stuck_at_end": bool(
            progress >= 0.99 and progress < 0.9999
            and (incomplete_hint.get("skipped_count", 0) > 0 or incomplete_hint.get("incomplete_count", 0) > 0)
        ),
        "incomplete_files": incomplete_hint.get("files") or [],
        "packs": packs_out,
    }

"""
/content — content-pack status, fetching, and content-folder import.

Two audiences share this router:
  - The phone (LAN, token-gated): catalog/books/book — unchanged, see below.
  - The desktop Content Manager (local, no token — same trust boundary as
    every other /… endpoint the Next.js app calls on localhost): packs,
    prepare-utd, import-folder, torrent/*.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

import content_transfer
import lan_sync
import packs
import qbank_import
import torrent_fetch
from utd_content import configured_bundle_dir, content_status
from config import (
    AMBOSS_DIR,
    DRUG_REF_DB,
    LEXI_DB_PATH,
    LIBRARY_PATH,
    MICROMEDEX_DB,
    MICROMEDEX_INTERACTION_DB,
    ROOT,
    SANFORD_DIR,
    STEP1_DB_PATH,
    STEP2_DB_PATH,
    STEP3_DB_PATH,
    USER_CONTENT_FILE,
    UTD_DB_PATH,
)

router = APIRouter(prefix="/content", tags=["Content"])
BASE = Path(__file__).parent.parent  # app/backend/


def _require_token(x_medos_sync_token: Optional[str] = Header(default=None)) -> None:
    if not lan_sync.token_ok(x_medos_sync_token):
        raise HTTPException(status_code=403, detail="sync token required")


def _dir_size(p: Path) -> int:
    if not p.exists():
        return 0
    if p.is_file():
        try:
            return p.stat().st_size
        except OSError:
            return 0
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def _bank_label(info) -> str:
    if info.category == "uworld":
        return f"UWorld Step {info.step}"
    if info.category == "nbme":
        return f"NBME Step {info.step} · Form {info.form}"
    if info.category == "cms":
        return f"CMS {info.subject} · Form {info.form}"
    return info.label or info.key


# Module folders the phone understands (desktop path → phone data-relative path).
_MODULES = [
    ("AMBOSS library", AMBOSS_DIR, "amboss"),
    ("UpToDate", UTD_DB_PATH, "uptodate"),
    ("Drug reference", DRUG_REF_DB, "drugs"),
]


@router.get("/catalog")
def catalog(_: None = Depends(_require_token)):
    """Desktop-side sizes for the modules + qbanks the phone can manage."""
    out: list[dict] = []
    try:
        from qbank_reader import _bank_registry
        for key, info in _bank_registry().items():
            out.append({
                "key": f"qbank/{key}", "label": _bank_label(info),
                "kind": "qbank", "size": _dir_size(info.db_path.parent),
            })
    except Exception:
        pass
    for label, path, rel in _MODULES:
        if Path(path).exists():
            out.append({"key": rel, "label": label, "kind": "module", "size": _dir_size(Path(path))})
    out.append({"key": "library", "label": "Library (books)", "kind": "books", "size": _dir_size(LIBRARY_PATH)})
    return {"groups": out}


@router.get("/books")
def list_books(_: None = Depends(_require_token)):
    """Every PDF in the desktop library, with size, so the phone can pick some."""
    out: list[dict] = []
    if LIBRARY_PATH.exists():
        for p in sorted(LIBRARY_PATH.rglob("*.pdf")):
            try:
                rel = p.relative_to(LIBRARY_PATH).as_posix()
                folder = rel.split("/")[0] if "/" in rel else ""
                out.append({"path": rel, "title": p.stem, "folder": folder, "size": p.stat().st_size})
            except OSError:
                continue
    return {"books": out, "count": len(out)}


@router.get("/book")
def get_book(path: str = Query(...), _: None = Depends(_require_token)):
    """Stream a single PDF (sandboxed under LIBRARY_PATH)."""
    base = LIBRARY_PATH.resolve()
    target = (base / path).resolve()
    if base != target and base not in target.parents:
        raise HTTPException(403, "path outside library")
    if not target.is_file() or target.suffix.lower() != ".pdf":
        raise HTTPException(404, "book not found")
    return FileResponse(str(target), media_type="application/pdf", filename=target.name)


# ── Pack status (Content Manager) ──────────────────────────────────────────

@router.get("/packs")
def list_packs():
    return {"packs": packs.all_pack_status(), "checked_at": time.time()}


@router.post("/packs/{pack_id}/refresh")
def refresh_pack(pack_id: str):
    result = packs.refresh(pack_id)
    if not result:
        raise HTTPException(404, f"unknown pack: {pack_id}")
    return {"pack": result[0]}


_DIST_PACKS_DIR = ROOT / "dist" / "packs"


@router.get("/packs/{pack_id}/archive")
def get_pack_archive(pack_id: str, _: None = Depends(_require_token)):
    """Serve a locally-built pack 7z to a LAN peer (the 'friend on Wi-Fi'
    fallback — no internet needed once ONE classmate has downloaded a pack).
    Starlette's FileResponse supports Range requests, so this is resumable."""
    if packs.get_pack(pack_id) is None:
        raise HTTPException(404, f"unknown pack: {pack_id}")
    if not _DIST_PACKS_DIR.exists():
        raise HTTPException(404, "no packs built on this machine (dist/packs missing)")
    candidates = sorted(_DIST_PACKS_DIR.glob(f"MedOS-{pack_id}-*.7z"))
    if not candidates:
        raise HTTPException(404, f"no built archive found for pack '{pack_id}'")
    archive = candidates[-1]
    return FileResponse(str(archive), media_type="application/x-7z-compressed", filename=archive.name)


# ── UpToDate local decrypt ("Prepare UpToDate") ────────────────────────────

_prepare_utd_lock = threading.Lock()
_prepare_utd_state: dict = {"running": False, "log": [], "ok": None, "started_at": None, "finished_at": None}


def _run_prepare_utd(force: bool) -> None:
    script = BASE / "scripts" / "utd_decrypt_assets.py"
    cmd = [sys.executable, str(script), "--utd-dir", str(configured_bundle_dir(UTD_DB_PATH))]
    if force:
        cmd.append("--force")
    try:
        child_env = {**os.environ, "PYTHONUTF8": "1"}
        with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, env=child_env) as proc:
            for line in proc.stdout:  # type: ignore[union-attr]
                with _prepare_utd_lock:
                    _prepare_utd_state["log"].append(line.rstrip())
                    _prepare_utd_state["log"] = _prepare_utd_state["log"][-300:]
            proc.wait()
            ok = proc.returncode == 0
    except Exception:
        with _prepare_utd_lock:
            _prepare_utd_state["log"].append("ERROR: Could not run UpToDate preparation; restart MedOS and retry.")
        ok = False
    with _prepare_utd_lock:
        _prepare_utd_state.update(running=False, ok=ok, finished_at=time.time())
    try:
        packs.refresh("uptodate")
    except Exception:
        pass


@router.post("/prepare-utd")
def prepare_utd(force: bool = Query(default=False)):
    global _prepare_utd_state
    # Reserve synchronously so an immediate poll sees running=True, and two
    # concurrent requests cannot both start a cache build.
    with _prepare_utd_lock:
        if _prepare_utd_state["running"]:
            return {"status": "already_running"}
        _prepare_utd_state = {"running": True, "log": [], "ok": None, "started_at": time.time(), "finished_at": None}
        try:
            threading.Thread(target=_run_prepare_utd, args=(force,), daemon=True).start()
        except RuntimeError:
            _prepare_utd_state.update(running=False, ok=False, finished_at=time.time())
            raise HTTPException(503, "Could not start UpToDate preparation; retry after restarting MedOS.") from None
    return {"status": "started"}


@router.get("/prepare-utd/status")
def prepare_utd_status():
    with _prepare_utd_lock:
        state = {**_prepare_utd_state, "log": list(_prepare_utd_state["log"])}
    state["content"] = content_status(configured_bundle_dir(UTD_DB_PATH))
    return state


# ── Content folder import ───────────────────────────────────────────────────

class ImportFolderRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=1000)
    confirm_key: Optional[str] = Field(default=None, description="config_key to actually apply (2nd call after preview)")
    refresh_index: bool = Field(default=True, description="Kick a global search reindex after applying (batch importers disable this)")


def _latest_mtime(path: Path, patterns: tuple[str, ...] = ("*",)) -> float:
    best = 0.0
    if path.is_file():
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0
    for pattern in patterns:
        for f in path.glob(pattern):
            try:
                best = max(best, f.stat().st_mtime)
            except OSError:
                continue
    return best


def _detect_uptodate(folder: Path) -> Optional[dict]:
    if (folder / "utdtoc.db").exists() and (folder / "utdasset.sqlite").exists():
        return {"config_key": "UTD_DB_PATH", "value": str(folder), "current": UTD_DB_PATH}
    return None


def _detect_sanford(folder: Path) -> Optional[dict]:
    if (folder / "sanfordguide").exists() or (folder / "search_base.db").exists() or list(folder.glob("FTS.db")):
        return {"config_key": "SANFORD_DIR", "value": str(folder), "current": SANFORD_DIR}
    return None


def _detect_amboss_library(folder: Path) -> Optional[dict]:
    if list(folder.glob("amboss-*.db")):
        return {"config_key": "AMBOSS_DIR", "value": str(folder), "current": AMBOSS_DIR}
    return None


def _detect_micromedex(folder: Path) -> list[dict]:
    out = []
    ref = next((p for p in folder.rglob("imdiMDX_DrugRef.sqlite")), None)
    if ref:
        out.append({"config_key": "MICROMEDEX_DB", "value": str(ref), "current": MICROMEDEX_DB})
    inter = next((p for p in folder.rglob("imdiMDX_DrugInt.sqlite")), None)
    if inter:
        out.append({"config_key": "MICROMEDEX_INTERACTION_DB", "value": str(inter), "current": MICROMEDEX_INTERACTION_DB})
    return out


def _detect_epocrates(folder: Path) -> Optional[dict]:
    rx = next((p for p in folder.rglob("RX.sqlite")), None)
    if rx:
        return {"config_key": "LEXI_DB_PATH", "value": str(rx), "current": LEXI_DB_PATH}
    return None


def _detect_lexi(folder: Path) -> Optional[dict]:
    for p in folder.rglob("*.sqlite"):
        if "lexi" in p.name.lower() or "lexi" in p.parent.name.lower():
            return {"config_key": "LEXI_DB_PATH", "value": str(p), "current": LEXI_DB_PATH}
    return None


def _detect_uworld_qbanks(folder: Path) -> list[dict]:
    out = []
    step_targets = {"1": ("STEP1_DB_PATH", STEP1_DB_PATH), "2": ("STEP2_DB_PATH", STEP2_DB_PATH), "3": ("STEP3_DB_PATH", STEP3_DB_PATH)}
    for db in folder.rglob("uworldSTEP*-*.db"):
        m = __import__("re").search(r"uworldSTEP([123])-", db.name)
        if not m:
            continue
        key, current = step_targets[m.group(1)]
        out.append({"config_key": key, "value": str(db), "current": current, "label": f"UWorld Step {m.group(1)}"})
    return out


def _detect_amboss_qbank_root(folder: Path) -> Optional[dict]:
    # Only directories count as qbank bundles.  Windows globbing is
    # case-insensitive, so `Amboss-*` also matches `amboss-2025.db`; without the
    # is_dir() check the AMBOSS library folder was mistaken for a qbank root and
    # stole AMBOSS_QBANK_DIR from the real Step 1/2/3 bundle folders.
    bundles = [
        p for pattern in ("Amboss - *", "Amboss-*")
        for p in folder.glob(pattern) if p.is_dir()
    ]
    if bundles:
        return {"config_key": "AMBOSS_QBANK_DIR", "value": str(folder), "current": None, "label": "AMBOSS qbank root"}
    # A MedOS content export stores each qbank as its own top-level folder, e.g.
    # data/Amboss - USMLE Step 12025/ambossqb-*.db.  Pointing AMBOSS_QBANK_DIR
    # at the parent lets qbank_reader discover all three step banks at once.
    if list(folder.glob("ambossqb-*.db")):
        return {
            "config_key": "AMBOSS_QBANK_DIR", "value": str(folder.parent),
            "current": None, "label": "AMBOSS qbank bundle (registers sibling banks)",
        }
    return None


def _detect_nbme_root(folder: Path) -> Optional[dict]:
    if list(folder.glob("nbme-*")):
        return {"config_key": "ASSESSMENT_DIR", "value": str(folder), "current": None, "label": "NBME/CMS assessment root"}
    return None


def _detect_books(folder: Path) -> Optional[dict]:
    pdfs = next((p for p in folder.rglob("*.pdf")), None)
    epubs = None if pdfs else next((p for p in folder.rglob("*.epub")), None)
    if pdfs or epubs:
        return {"config_key": "LIBRARY_PATH", "value": str(folder), "current": LIBRARY_PATH}
    return None


def _mehlman_bundle_db(folder: Path) -> Optional[Path]:
    """The qbank .db inside a single Mehlman bundle folder, or None."""
    db = folder / f"{folder.name}.db"
    if db.exists() and db.stat().st_size > 0:
        return db
    return next((p for p in sorted(folder.glob("*.db")) if p.stat().st_size > 0), None)


def _detect_mehlman(folder: Path) -> list[dict]:
    """Detect Mehlman HY qbanks. Handles three shapes:
      1. The folder IS one bundle  (folder/<name>.db)          -> import its PARENT as the root
      2. The folder CONTAINS bundles (folder/mehlman-*/…)      -> import the folder as the root
      3. A named-but-empty bundle (mehlman-* with no usable db) -> report as incomplete, no apply
    All three resolve to the single MEHLMAN_DIR override (the reader scans it for
    every mehlman-* subfolder), so pointing at a parent picks up siblings too."""
    from config import _env  # noqa: F401 (only for current value below)
    current = os.environ.get("MEHLMAN_DIR") or str(ROOT / "data")
    out: list[dict] = []
    name_is_bundle = bool(re.match(r"^mehlman-", folder.name, re.IGNORECASE))

    if name_is_bundle:
        db = _mehlman_bundle_db(folder)
        if db is not None:
            title = _read_title(folder)
            out.append({
                "config_key": "MEHLMAN_DIR", "value": str(folder.parent), "current": current,
                "label": f"Mehlman bundle · {title or folder.name}", "count_hint": 1,
            })
        else:
            out.append({
                "config_key": "MEHLMAN_DIR", "value": str(folder.parent), "current": current,
                "label": f"Mehlman bundle · {folder.name} (incomplete — no question database)",
                "incomplete": True,
            })
        return out

    child_bundles = [p for p in sorted(folder.glob("mehlman-*")) if p.is_dir() and _mehlman_bundle_db(p)]
    if child_bundles:
        out.append({
            "config_key": "MEHLMAN_DIR", "value": str(folder), "current": current,
            "label": f"Mehlman HY qbank root ({len(child_bundles)} bank(s))", "count_hint": len(child_bundles),
        })
    return out


def _read_title(folder: Path) -> str:
    t = folder / "title.txt"
    if not t.exists():
        return ""
    try:
        raw = t.read_text(encoding="utf-8", errors="ignore").strip()
    except OSError:
        return ""
    return "" if raw.lower() == "system.object[]" else raw


@router.post("/import-folder")
def import_folder(body: ImportFolderRequest):
    folder = Path(body.path).expanduser()
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(400, f"folder does not exist: {folder}")

    detections: list[dict] = []

    single = _detect_uptodate(folder)
    if single:
        detections.append({"id": "uptodate", "label": "UpToDate bundle", "kind": "content", **single})
    single = _detect_sanford(folder)
    if single:
        detections.append({"id": "sanford", "label": "Sanford Guide bundle", "kind": "content", **single})
    single = _detect_amboss_library(folder)
    if single:
        detections.append({"id": "amboss", "label": "AMBOSS library", "kind": "content", **single})
    for d in _detect_micromedex(folder):
        detections.append({"id": "micromedex", "label": "Micromedex drug data", "kind": "drug", **d})
    single = _detect_epocrates(folder)
    if single:
        detections.append({"id": "epocrates", "label": "Epocrates drug data", "kind": "drug", **single})
    else:
        single = _detect_lexi(folder)
        if single:
            detections.append({"id": "lexi", "label": "Lexicomp bundle", "kind": "drug", **single})
    for d in _detect_uworld_qbanks(folder):
        detections.append({"id": f"qbank-{d['label']}", "label": d["label"], "kind": "qbank", **d})
    single = _detect_amboss_qbank_root(folder)
    if single:
        detections.append({"id": "qbank-amboss-root", "label": single["label"], "kind": "qbank", **single})
    single = _detect_nbme_root(folder)
    if single:
        detections.append({"id": "qbank-nbme-root", "label": single["label"], "kind": "qbank", **single})
    for d in _detect_mehlman(folder):
        detections.append({"id": "qbank-mehlman", "kind": "qbank", **d})
    single = _detect_books(folder)
    if single:
        detections.append({"id": "books", "label": "Book library", "kind": "book", **single})

    if not detections:
        return {
            "detected": [],
            "message": (
                "No known content signature found in this folder. Looked for: "
                "UpToDate (utdtoc.db + utdasset.sqlite), Sanford Guide, AMBOSS library "
                "(amboss-*.db), Micromedex (DrugRef/DrugInt sqlite), Epocrates "
                "(RX.sqlite), Lexicomp, UWorld/AMBOSS/NBME/Mehlman qbanks, or a folder of PDFs/EPUBs."
            ),
        }

    for d in detections:
        current = d.get("current")
        if current and Path(str(current)).exists():
            new_mtime = _latest_mtime(Path(d["value"]))
            cur_mtime = _latest_mtime(Path(str(current)))
            d["newer"] = new_mtime > cur_mtime + 1  # 1s slack
        else:
            d["newer"] = None  # nothing currently configured — first install, not a "replace"
        d.pop("current", None)

    if body.confirm_key:
        applied = [d for d in detections if d["config_key"] == body.confirm_key]
        if not applied:
            raise HTTPException(400, f"confirm_key '{body.confirm_key}' not among detections for this folder")
        if applied[0].get("incomplete"):
            raise HTTPException(400, "this detection is incomplete (missing database) — cannot apply")
        _apply_override(applied[0]["config_key"], applied[0]["value"])
        # Qbank roots (Mehlman/AMBOSS/NBME) are served straight from disk by the
        # quiz engine, not the global index — re-scan the bank registry so the
        # new banks show up immediately instead of after a backend restart.
        if applied[0]["config_key"] in ("MEHLMAN_DIR", "AMBOSS_QBANK_DIR", "ASSESSMENT_DIR"):
            try:
                import qbank_reader
                applied[0]["banks_now"] = qbank_reader.reset_bank_registry()
            except Exception as exc:  # never fail the import over a cache refresh
                print(f"[content] qbank registry refresh failed: {exc}")
        if body.refresh_index:
            _kick_index_refresh(applied[0]["id"])
        packs.refresh()
        return {"detected": detections, "applied": applied[0]}

    return {"detected": detections}


def _load_user_content() -> dict:
    if USER_CONTENT_FILE.exists():
        try:
            return json.loads(USER_CONTENT_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"overrides": {}}


def _save_user_content(data: dict) -> None:
    USER_CONTENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    USER_CONTENT_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _apply_override(config_key: str, value: str) -> None:
    import os
    data = _load_user_content()
    data.setdefault("overrides", {})[config_key] = value
    _save_user_content(data)
    os.environ[config_key] = value  # take effect immediately for this process


_INDEX_REFRESH_LOCK = threading.Lock()
_INDEX_REFRESH_RUNNING = False
_INDEX_REFRESH_PENDING = 0


def _kick_index_refresh(source_hint: str) -> None:
    """Best-effort incremental rebuild in the background; failures are logged,
    never surfaced to the caller — the import itself already succeeded.

    A single content import can apply several overrides.  Starting one rebuild
    per override made two subprocesses fight over ``global_search.sqlite.tmp``;
    this coalesces requests into one rebuild at a time.
    """
    global _INDEX_REFRESH_RUNNING, _INDEX_REFRESH_PENDING
    with _INDEX_REFRESH_LOCK:
        _INDEX_REFRESH_PENDING += 1
        if _INDEX_REFRESH_RUNNING:
            return
        _INDEX_REFRESH_RUNNING = True

    def _work():
        global _INDEX_REFRESH_RUNNING, _INDEX_REFRESH_PENDING
        try:
            while True:
                with _INDEX_REFRESH_LOCK:
                    _INDEX_REFRESH_PENDING = 0
                try:
                    subprocess.run(
                        [sys.executable, str(BASE / "scripts" / "build_global_search_index.py")],
                        check=False, timeout=600,
                    )
                    packs.refresh()
                except Exception as exc:
                    print(f"[content] index refresh after import ({source_hint}) failed: {exc}")
                with _INDEX_REFRESH_LOCK:
                    if _INDEX_REFRESH_PENDING:
                        continue
                    _INDEX_REFRESH_RUNNING = False
                    return
        except Exception:  # defensive: never leave the gate stuck closed
            with _INDEX_REFRESH_LOCK:
                _INDEX_REFRESH_RUNNING = False

    threading.Thread(target=_work, daemon=True).start()


@router.get("/user-content")
def get_user_content():
    return _load_user_content()


# ── Cleanup (explicit, never automatic — see plan's Upgrades section) ─────

_CLEANUP_TARGETS: dict[str, tuple[str, ...]] = {
    # Build-time-only inputs that never get read by the runtime reader — safe
    # to delete once utdasset_decrypted.sqlite exists.
    "uptodate": ("fcontentsearch.db", "utd_index.sqlite"),
}


@router.post("/cleanup/{pack_id}")
def cleanup_pack(pack_id: str):
    if packs.get_pack(pack_id) is None:
        raise HTTPException(404, f"unknown pack: {pack_id}")
    targets = _CLEANUP_TARGETS.get(pack_id, ())
    base = UTD_DB_PATH if pack_id == "uptodate" else None
    removed: list[dict] = []
    if base is not None:
        for name in targets:
            p = base / name
            if not p.exists():
                continue
            try:
                size = p.stat().st_size
                p.unlink()
                removed.append({"file": name, "freed_bytes": size})
            except OSError as exc:
                removed.append({"file": name, "error": str(exc)})
    return {"pack_id": pack_id, "removed": removed}


# ── Torrent fetch (Content Manager) ────────────────────────────────────────

class ProviderLinkRequest(BaseModel):
    uri: str = Field(..., min_length=1, max_length=4000)


class StartFetchRequest(BaseModel):
    packs: list[str] = Field(default_factory=list)


class SeedToggleRequest(BaseModel):
    enabled: bool = True


class UploadLimitRequest(BaseModel):
    kbps: int = Field(default=0, ge=0)


@router.get("/torrent/state")
def torrent_state():
    return torrent_fetch.get_state()


@router.post("/torrent/provider")
def torrent_provider(body: ProviderLinkRequest):
    torrent_fetch.set_provider(body.uri)
    return torrent_fetch.get_state()


@router.post("/torrent/start")
def torrent_start(body: StartFetchRequest):
    return torrent_fetch.start(body.packs)


@router.get("/torrent/status")
def torrent_status():
    return torrent_fetch.status()


@router.post("/torrent/seed")
def torrent_seed(body: SeedToggleRequest):
    torrent_fetch.set_seed_after_download(body.enabled)
    return torrent_fetch.get_state()


class AutoSeedRequest(BaseModel):
    enabled: bool = True


class TrayRequest(BaseModel):
    enabled: bool = False


@router.post("/torrent/auto-seed")
def torrent_auto_seed(body: AutoSeedRequest):
    torrent_fetch.set_auto_seed_on_start(body.enabled)
    return torrent_fetch.get_state()


@router.post("/torrent/tray")
def torrent_tray(body: TrayRequest):
    return torrent_fetch.set_background_tray(body.enabled)


@router.post("/torrent/upload-limit")
def torrent_upload_limit(body: UploadLimitRequest):
    torrent_fetch.set_upload_limit_kbps(body.kbps)
    return torrent_fetch.get_state()


@router.post("/torrent/recheck")
def torrent_recheck():
    return torrent_fetch.force_recheck()


@router.post("/torrent/announce")
def torrent_announce():
    return torrent_fetch.force_announce()


@router.post("/torrent/clear-skips")
def torrent_clear_skips():
    """Un-skip every file — fixes 99.9% stalls from skipped APK/README pieces."""
    return torrent_fetch.clear_skips(include_optional=True)


@router.get("/torrent/files")
def torrent_files(limit: int = Query(40, ge=1, le=200)):
    return torrent_fetch.incomplete_files(limit=limit)


# ── Companion downloads (APK, Chrome extension) ────────────────────────────
# These are rooted IN the app so a user can hand their phone/browser the file
# without hunting the install folder: the Content Manager cards link here.

_APK_PATH = ROOT / "MedOS.apk"
_CHROME_EXT_DIR = ROOT / "app" / "chrome-extension" / "medos-reference-sidebar"
_CHROME_EXT_ZIP = ROOT / "data" / "cache" / "medos-chrome-extension.zip"


@router.get("/apk")
def download_apk():
    if not _APK_PATH.exists():
        raise HTTPException(404, "MedOS.apk not found at the MedOS root")
    return FileResponse(
        _APK_PATH,
        filename="MedOS.apk",
        media_type="application/vnd.android.package-archive",
    )


@router.get("/apk/info")
def apk_info():
    if not _APK_PATH.exists():
        return {"available": False}
    st = _APK_PATH.stat()
    return {"available": True, "size_bytes": st.st_size, "modified": st.st_mtime}


def _build_chrome_ext_zip() -> Path:
    """(Re)zip the unpacked extension folder into data/cache, keyed on the
    newest source mtime so edits invalidate the cached zip."""
    import zipfile
    if not _CHROME_EXT_DIR.exists():
        raise HTTPException(404, f"extension folder not found: {_CHROME_EXT_DIR}")
    src_files = [p for p in _CHROME_EXT_DIR.rglob("*") if p.is_file()]
    if not src_files:
        raise HTTPException(404, "extension folder is empty")
    newest = max(p.stat().st_mtime for p in src_files)
    if _CHROME_EXT_ZIP.exists() and _CHROME_EXT_ZIP.stat().st_mtime >= newest:
        return _CHROME_EXT_ZIP
    _CHROME_EXT_ZIP.parent.mkdir(parents=True, exist_ok=True)
    tmp = _CHROME_EXT_ZIP.with_suffix(".zip.tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(src_files):
            z.write(p, p.relative_to(_CHROME_EXT_DIR.parent))
    tmp.replace(_CHROME_EXT_ZIP)
    return _CHROME_EXT_ZIP


@router.get("/chrome-extension")
def download_chrome_extension():
    path = _build_chrome_ext_zip()
    return FileResponse(path, filename="medos-chrome-extension.zip", media_type="application/zip")


@router.get("/chrome-extension/info")
def chrome_extension_info():
    if not _CHROME_EXT_DIR.exists():
        return {"available": False}
    return {"available": True, "unpacked_path": str(_CHROME_EXT_DIR)}


@router.post("/torrent/pause")
def torrent_pause():
    return torrent_fetch.pause()


@router.post("/torrent/resume")
def torrent_resume():
    return torrent_fetch.resume()


@router.post("/torrent/selection")
def torrent_selection(body: StartFetchRequest):
    return torrent_fetch.update_selection(body.packs)


@router.get("/torrent/local")
def torrent_local():
    """Describe the live MedOS-folder torrent / magnet / optional archives."""
    return torrent_fetch.local_distribution()


@router.get("/torrent/file")
def torrent_file(name: str = Query(..., min_length=1, max_length=200)):
    """Serve a .torrent from install root or local dist folder."""
    safe = Path(name).name
    if not safe.endswith(".torrent"):
        raise HTTPException(400, "expected a .torrent filename")
    candidates = [
        ROOT / safe,
        ROOT / "dist" / "medos-torrent" / safe,
    ]
    dist = torrent_fetch.packs_dist_dir()
    if dist is not None:
        candidates.append(dist / safe)
    path = next((p for p in candidates if p.exists() and p.is_file()), None)
    if path is None:
        raise HTTPException(404, f"torrent not found: {safe}")
    return FileResponse(path, filename=safe, media_type="application/x-bittorrent")


@router.get("/sync")
def sync_overview():
    """Embedded magnet + hierarchical content rooms (sizes on disk)."""
    import pack_paths
    tstatus = torrent_fetch.status()
    tree = pack_paths.build_sync_tree(
        ROOT,
        pack_status=packs.all_pack_status(),
        torrent_packs=tstatus.get("packs") or [],
    )
    local = torrent_fetch.local_distribution()
    magnet = local.get("magnet") or torrent_fetch.embedded_magnet()
    return {
        **tree,
        "magnet": magnet,
        "torrent_file": local.get("torrent_file"),
        "torrent_url": local.get("torrent_url") or (
            "/content/torrent/file?name=MedOS.torrent" if (ROOT / "MedOS.torrent").exists() else None
        ),
        "hint": local.get("hint"),
        "torrent": {
            k: tstatus.get(k)
            for k in (
                "mode", "state", "progress", "download_rate_kbps", "upload_rate_kbps",
                "num_seeds", "num_peers", "total_seeds", "total_peers", "eta_seconds",
                "has_metadata", "error", "save_path", "paused", "is_seeding",
                "health", "ratio", "availability", "uploaded_bytes", "downloaded_bytes",
                "pieces_have", "pieces_total", "incomplete_count", "skipped_count",
                "stuck_at_end", "incomplete_files", "seed_after_download",
                "auto_seed_on_start", "background_tray", "upload_limit_kbps",
                "list_peers", "list_seeds",
            )
        },
    }


@router.get("/sync/tree")
def sync_tree():
    """Rooms / entries only (lighter than /sync)."""
    import pack_paths
    tstatus = torrent_fetch.status()
    return pack_paths.build_sync_tree(
        ROOT,
        pack_status=packs.all_pack_status(),
        torrent_packs=tstatus.get("packs") or [],
    )


@router.get("/sync/magnet")
def sync_magnet():
    magnet = torrent_fetch.embedded_magnet()
    if not magnet:
        raise HTTPException(404, "No embedded magnet yet. Run MAKE_MEDOS_TORRENT.ps1 on a seeder machine.")
    return {"magnet": magnet, "save_path_hint": str(ROOT.parent)}


@router.get("/app-update/info")
def app_update_info():
    """Latest MedOS-core-*.7z for one-file app updates (data/ untouched)."""
    candidates = _core_update_candidates()
    if not candidates:
        return {"available": False, "file": None, "size_bytes": 0, "url": None}
    latest = max(
        candidates,
        key=lambda path: (path.stat().st_mtime_ns, path.name.casefold()),
    )
    return {
        "available": True,
        "file": latest.name,
        "size_bytes": latest.stat().st_size,
        "url": f"/content/app-update/file?name={latest.name}",
    }


def _core_update_candidates() -> list[Path]:
    candidates: list[Path] = []
    for folder in (
        ROOT / "dist" / "packs",
        Path("D:/dist/packs"),
        torrent_fetch.packs_dist_dir() or Path(),
    ):
        directory = Path(folder)
        if not folder or not directory.is_dir() or directory.is_symlink():
            continue
        for candidate in directory.glob("MedOS-core-*.7z"):
            if (
                candidate.is_file()
                and not candidate.is_symlink()
                and re.fullmatch(r"MedOS-core-[0-9A-Za-z._+-]+\.7z", candidate.name)
            ):
                candidates.append(candidate)
    return candidates


@router.get("/app-update/file")
def app_update_file(name: str = Query(..., min_length=1, max_length=200)):
    """Serve only a declared MedOS core update from a bounded local folder."""
    if (
        Path(name).name != name
        or re.fullmatch(r"MedOS-core-[0-9A-Za-z._+-]+\.7z", name) is None
    ):
        raise HTTPException(400, "expected a MedOS core update filename")
    candidate = next(
        (path for path in _core_update_candidates() if path.name == name),
        None,
    )
    if candidate is None:
        raise HTTPException(404, f"core update not found: {name}")
    return FileResponse(
        candidate,
        filename=candidate.name,
        media_type="application/x-7z-compressed",
    )


# -- Transfer & backup: personal data + content exports (RAR/7z) ------------
# Archives always carry a medos-export.json manifest so any other MedOS can
# inspect and import them from Content Manager ? Import content.

class TransferListRequest(BaseModel):
    list: dict


class TransferExportRequest(BaseModel):
    destination: str = Field(..., min_length=1, max_length=1000)
    name: str = Field(default="", max_length=160)
    personal: list[str] = Field(default_factory=list)
    content: list[str] = Field(default_factory=list)
    max_part_mb: float = Field(default=2048, ge=0, le=1024 * 1024)


class TransferInspectRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4000)


class TransferImportRequest(BaseModel):
    token: str = ""
    path: str = ""
    personal: list[str] = Field(default_factory=list)
    content: list[str] = Field(default_factory=list)


class TransferQuickImportRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4000)


class TransferRevealRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4000)


@router.get("/transfer/inventory")
def transfer_inventory():
    return content_transfer.inventory()


@router.get("/transfer/storage")
def transfer_storage(force: bool = False):
    return content_transfer.storage(force=force)


@router.get("/transfer/content-list")
def transfer_content_list():
    from datetime import datetime
    payload = json.dumps(content_transfer.content_list(), indent=2, ensure_ascii=False)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return Response(
        content=payload,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="MedOS-content-list-{stamp}.json"'},
    )


@router.post("/transfer/parse-list")
def transfer_parse_list(body: TransferListRequest):
    try:
        return content_transfer.parse_list(body.list)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/transfer/export")
def transfer_export(body: TransferExportRequest):
    result = content_transfer.start_export(
        body.destination, body.name, body.personal, body.content, body.max_part_mb,
    )
    if result.get("status") == "busy":
        raise HTTPException(409, "Another transfer is already running.")
    return result


@router.post("/transfer/inspect")
def transfer_inspect(body: TransferInspectRequest):
    result = content_transfer.start_inspect(body.path)
    if result.get("status") == "busy":
        raise HTTPException(409, "Another transfer is already running.")
    return result


@router.post("/transfer/import")
def transfer_import(body: TransferImportRequest):
    result = content_transfer.start_import(body.token, body.path, body.personal, body.content)
    if result.get("status") == "busy":
        raise HTTPException(409, "Another transfer is already running.")
    return result


@router.post("/transfer/import-quick")
def transfer_import_quick(body: TransferQuickImportRequest):
    """Extract a content archive and wire it in without touching personal data."""
    result = content_transfer.start_quick_import(body.path)
    if result.get("status") == "busy":
        raise HTTPException(409, "Another transfer is already running.")
    return result


@router.get("/transfer/status")
def transfer_status():
    return content_transfer.status()


@router.post("/transfer/reveal")
def transfer_reveal(body: TransferRevealRequest):
    try:
        return content_transfer.reveal(body.path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class TransferPickRequest(BaseModel):
    kind: str = Field(default="folder", pattern="^(folder|destination|archive|pdf)$")
    initial: str = Field(default="", max_length=4000)


class TransferFreeRequest(BaseModel):
    path: str = Field(default="", max_length=4000)


@router.post("/transfer/pick")
def transfer_pick(body: TransferPickRequest):
    try:
        if body.kind == "archive":
            return content_transfer.pick_archive(body.initial)
        if body.kind == "pdf":
            return content_transfer.pick_pdf(body.initial)
        if body.kind == "destination":
            return content_transfer.pick_destination(body.initial)
        return content_transfer.pick_folder(body.initial)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/transfer/free")
def transfer_free(body: TransferFreeRequest):
    return content_transfer.free_space(body.path)


# -- Leftover exported archives ----------------------------------------------
# The user can clear old MedOS export/backup archives straight from the UI.
# Only files that `leftovers()` is currently offering can be deleted.

class LeftoverDeleteRequest(BaseModel):
    paths: list[str] = Field(default_factory=list)


@router.get("/exports/leftovers")
def exports_leftovers():
    return content_transfer.leftovers()


@router.post("/exports/delete")
def exports_delete(body: LeftoverDeleteRequest):
    return content_transfer.delete_leftovers(body.paths)


# -- Import non-MedOS files ---------------------------------------------------
# A book PDF drops onto an existing shelf (optionally indexed right away); a
# Q-Bank PDF is scanned, previewed, then rendered into a native bank.

class BookImportRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4000)
    shelf: str = Field(default="", max_length=600)
    name: str = Field(default="", max_length=240)
    index: bool = True
    overwrite: bool = False


class QbankAnalyzeRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=4000)
    name: str = Field(default="", max_length=240)


class QbankBuildRequest(BaseModel):
    analysis_id: str = Field(..., min_length=1, max_length=64)
    name: str = Field(default="", max_length=240)
    overwrite: bool = False


@router.get("/library/shelves")
def library_shelves():
    return content_transfer.library_shelves()


@router.post("/import/book")
def import_book(body: BookImportRequest):
    try:
        return content_transfer.import_book(
            body.path, shelf=body.shelf, name=body.name,
            index=body.index, overwrite=body.overwrite,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/import/qbank/analyze")
def import_qbank_analyze(body: QbankAnalyzeRequest):
    result = qbank_import.start_analyze(body.path, body.name)
    if result.get("status") == "busy":
        raise HTTPException(409, "Another import job is already running.")
    return result


@router.post("/import/qbank/build")
def import_qbank_build(body: QbankBuildRequest):
    result = qbank_import.start_build(body.analysis_id, body.name, body.overwrite)
    if result.get("status") == "busy":
        raise HTTPException(409, "Another import job is already running.")
    return result


@router.get("/import/qbank/status")
def import_qbank_status():
    return qbank_import.status()


@router.get("/import/qbank/banks")
def import_qbank_banks():
    return qbank_import.catalog()

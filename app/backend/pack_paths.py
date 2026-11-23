"""
Pack ↔ on-disk path map for the *data torrent* distribution mode.

Why this exists: shipping each pack as a separate .7z forces every seeder to
keep BOTH the extracted MedOS tree they use daily AND a second copy of the
same bytes inside archives. Sharing the live `data/` (and a few siblings like
`models/`) as a multi-file torrent means:

  - Seeders point their client at their existing MedOS folder — zero extra disk.
  - Downloaders tick packs → libtorrent only fetches those path prefixes.
  - Files land exactly where readers already look — no extract / password step.

`PACK_TORRENT_PATHS` keys MUST match pack ids in packs.py. Paths are relative
to the MedOS root (forward slashes). A trailing-less path is a file; a path
that exists as a directory on disk is included recursively (minus EXCLUDE_*).
"""
from __future__ import annotations

import os
import time as _time
from pathlib import Path
from typing import Iterable

# Files/dirs never shipped even when their parent pack is selected.
EXCLUDE_NAMES = {
    "utdasset_decrypted.sqlite",
    "fcontentsearch.db",
    "utd_index.sqlite",
    "qbank_state.sqlite3",
    "anki_progress.sqlite",
    "anki_userdecks.sqlite",
    "users.sqlite",
    "sync_node.json",
    "user_content.json",
    "torrent_state.json",
    "status.json",  # data/.packs/status.json — machine-local verify cache
    "ctgov_cache.sqlite",
}
EXCLUDE_SUFFIXES = (
    "-wal",
    "-shm",
    "-journal",
    ".log",
    ".pid",
    ".tmp",
    ".err",
)
EXCLUDE_DIR_NAMES = {
    ".downloads",
    "cache",
    "_fa_snippet_cache",
    "__pycache__",
    ".cache",
    "phone",
    "scratch",
    "archive",
    ".git",
    # Loose Anki media (74k+ files) — torrent ships collection.media.7z instead.
    # Content Manager still counts and exports it through TRANSFER_EXTRAS.
    "collection.media",
    "node_modules",
}

# Vendor/source drops that have no fixed folder name across releases: the raw
# RxNorm distribution carries a download date (`RxNorm_full_05042026`) and the
# offline MDCalc pages ship as `WSA`. They are exposed as their own local-only
# Content Manager rows (see `transfer_extras`), so the torrent pack walk must
# skip them without hardcoding one release's folder name.
def _is_excluded_dir_name(name: str) -> bool:
    lowered = name.lower()
    if lowered in EXCLUDE_DIR_NAMES:
        return True
    if lowered.startswith("rxnorm_full"):
        return True
    if lowered == "wsa":
        return True
    return False

# Names excluded only when they sit directly inside the UpToDate bundle; the
# same filenames under data/Lexi are live content.
_UTD_ONLY_EXCLUDES = {"utdasset_decrypted.sqlite", "fcontentsearch.db", "utd_index.sqlite"}
# A file that marks a directory as the UpToDate bundle, whichever folder name
# the user's copy uses.
_UTD_BUNDLE_MARKERS = ("unidex.en.sqlite", "utdtoc.db", "utdasset.sqlite")


def _is_utd_bundle_dir(path: Path) -> bool:
    return any((path / marker).exists() for marker in _UTD_BUNDLE_MARKERS)

# The First Aid PDF sits inside the books folder but ships as its own pack, so
# the books pack must not count or ship those bytes a second time.
FIRSTAID_PDF_REL = "data/books/USMLE/First Aid for the USMLE Step 1 2026.pdf"

# A file that lives inside a broader pack's folder but is shipped by the pack
# named in its own key. Excluded from the parent pack's file list and sizes.
PACK_EXCLUDE_FILES: dict[str, tuple[str, ...]] = {
    "books": (FIRSTAID_PDF_REL,),
}

PACK_TORRENT_PATHS: dict[str, tuple[str, ...]] = {
    "core": (
        "data/global_search.sqlite",
        "data/umls_lite.sqlite",
        "data/sanfordguide",
        "data/utdpathways",
        "data/uptodate ddx",
        "data/drug_reference.sqlite",
        "data/acls",
        "data/ao",
        "data/anatomy",
        "data/Assesment",
        "data/concept_links.sqlite",
        "data/content_concepts.sqlite",
        "data/paragraph_concepts.sqlite",
        "data/reference_entities.sqlite",
        "data/reference_lookup.sqlite",
        "data/glossary.db",
        "data/cliniccons_disease_reference.sqlite",
        "data/Lexi/calc",
        "data/openfda_labels.sqlite",
    ),
    "umls-full": ("data/umls.sqlite",),
    "uptodate": (
        "data/uptodate/utdasset.sqlite",
        "data/uptodate/unidex.en.sqlite",
        "data/uptodate/utdtoc.db",
        "data/uptodate/utdqf.sqlite",
        "data/uptodate/thumbs.db",
        "data/uptodate/background.png",
        "data/uptodate/uptodate.png",
        "data/uptodate/info.vbe",
    ),
    "books": (
        "data/books",
        "data/book_chapter_index.sqlite",
    ),
    # First Aid is split out of the books pack so the PDF, its search index and
    # the FAISS/BM25 retrieval can be moved around independently.
    "firstaid": (FIRSTAID_PDF_REL,),
    "firstaid-index": ("data/firstaid_index.sqlite",),
    "rag": (
        "data/faiss",
        "data/bm25",
        "models",
    ),
    "uworld-step1": (
        "data/uworld/STEP-1-2026-march",
        "data/uworldstep1library-March-2026",
    ),
    "uworld-step2": ("data/uworld/STEP2-2026-march",),
    "uworld-step3": ("data/uworld/STEP3-2026-march",),
    "amboss": (
        "data/amboss",
        "data/Amboss - USMLE Step 12025",
        "data/Amboss - USMLE Step 2 CK2025",
        "data/Amboss - USMLE Step 32025",
    ),
    "drugs-pro": (
        "data/Lexi/1-patch",
        "data/Lexi/Cliniccons",
        "data/Lexi/e-TG",
        "data/Lexi/martindalf",
        "data/Lexi/mm",
        "data/Lexi/triselff",
        "data/rxnorm.sqlite",
    ),
    "mehlman": (),  # filled dynamically — every complete data/mehlman-* folder
    "mksap19": ("data/mksap19part2db",),
    "boardvitals": ("data/boardvitals-15-2025",),
    "amboss-abim": ("data/Amboss - Internal Medicine (ABIM)2025",),
    "uworld-abim": ("data/INTERNAL-2026-march",),
    "qbanks-imported": ("data/qbanks-imported",),
    "anki": ("data/anki",),
}

# These four banks were added as completed, first-class export packs. Keep
# their primary completeness markers beside the path registry so torrent,
# portable-release, and Setup audits all consume one declaration.
ADDITIONAL_QBANK_PACK_IDS: tuple[str, ...] = (
    "mksap19",
    "boardvitals",
    "amboss-abim",
    "uworld-abim",
)

_REQUIRED_PACK_MARKERS: dict[str, tuple[str, ...]] = {
    "mksap19": ("data/mksap19part2db/medos-mksap19-qbank.db",),
    "boardvitals": (
        "data/boardvitals-15-2025/boardvitals-15-2025.db",
    ),
    "amboss-abim": (
        "data/Amboss - Internal Medicine (ABIM)2025/"
        "ambossqb-Internal Medicine (ABIM)2025.db",
    ),
    "uworld-abim": (
        "data/INTERNAL-2026-march/uworldINTERNAL-2026-march.db",
    ),
}


def required_marker_records_for_pack(pack_id: str) -> tuple[str, ...]:
    """Return canonical MedOS-root-relative completeness markers."""
    return _REQUIRED_PACK_MARKERS.get(pack_id, ())


def required_markers_for_pack(pack_id: str, root: Path) -> tuple[Path, ...]:
    return tuple(root / Path(record) for record in required_marker_records_for_pack(pack_id))


def _is_excluded(path: Path) -> bool:
    name = path.name
    # These names are derived/superseded *inside the UpToDate bundle only*.
    # Lexi keeps live `fcontentsearch.db` files under data/Lexi/* — the same
    # filename must not hide 336 MB of real drug content from Content Manager.
    if name in _UTD_ONLY_EXCLUDES:
        return _is_utd_bundle_dir(path.parent)
    if name in EXCLUDE_NAMES:
        return True
    if _is_excluded_dir_name(name) and path.is_dir():
        return True
    lower = name.lower()
    for suf in EXCLUDE_SUFFIXES:
        if lower.endswith(suf):
            return True
    return False


def mehlman_path_entries(root: Path) -> tuple[str, ...]:
    data = root / "data"
    if not data.exists():
        return ()
    out: list[str] = []
    for folder in sorted(data.glob("mehlman-*")):
        if not folder.is_dir():
            continue
        db = folder / f"{folder.name}.db"
        if not db.exists() or db.stat().st_size <= 0:
            continue
        out.append(f"data/{folder.name}")
    return tuple(out)


def paths_for_pack(pack_id: str, root: Path) -> tuple[str, ...]:
    if pack_id == "mehlman":
        return mehlman_path_entries(root)
    return PACK_TORRENT_PATHS.get(pack_id, ())


def all_pack_path_map(root: Path) -> dict[str, list[str]]:
    """pack_id → list of relative path prefixes included in the data torrent."""
    return {pid: list(paths_for_pack(pid, root)) for pid in PACK_TORRENT_PATHS}


def pack_id_for_torrent_path(rel_path: str, path_map: dict[str, list[str]] | None = None) -> str | None:
    """Map a torrent file path (e.g. data/umls.sqlite or MedOS/data/…)
    back to a pack id. Longest matching prefix wins."""
    norm = rel_path.replace("\\", "/").lstrip("./")
    if norm.startswith("MedOS/"):
        norm = norm[len("MedOS/"):]
    base = Path(norm).name.lower()
    if base in ("packs-map.json", "packs-manifest.json", "readme.txt"):
        return None
    mapping = path_map or {k: list(v) for k, v in PACK_TORRENT_PATHS.items()}
    best: tuple[int, str] | None = None
    for pid, prefixes in mapping.items():
        for pref in prefixes:
            p = pref.replace("\\", "/").rstrip("/")
            if norm == p or norm.startswith(p + "/"):
                score = len(p)
                if best is None or score > best[0]:
                    best = (score, pid)
    return best[1] if best else None


def iter_files_for_pack(root: Path, pack_id: str) -> Iterable[Path]:
    """Absolute file paths under root that belong to pack_id (after exclusions)."""
    excluded_rels = PACK_EXCLUDE_FILES.get(pack_id, ())
    for rel in paths_for_pack(pack_id, root):
        target = root / Path(rel)
        if not target.exists():
            continue
        if target.is_file():
            if not _is_excluded(target):
                yield target
            continue
        for f in target.rglob("*"):
            if not f.is_file():
                continue
            rel_parts = f.relative_to(root).parts
            # Skip if any path component is an excluded dir name
            if any(_is_excluded_dir_name(part) for part in rel_parts):
                continue
            if _is_excluded(f):
                continue
            if excluded_rels and f.relative_to(root).as_posix() in excluded_rels:
                continue
            yield f


# Only machine-local noise is dropped when moving local content around; real
# payload files (loose Anki media, decrypted caches, raw build inputs) stay.
_TRANSIENT_SUFFIXES = ("-wal", "-shm", "-journal", ".log", ".pid", ".tmp", ".err")


def _is_transient(path: Path) -> bool:
    lower = path.name.lower()
    return any(lower.endswith(suffix) for suffix in _TRANSIENT_SUFFIXES)


def iter_files_for_transfer(root: Path, rels: Iterable[str]) -> Iterable[Path]:
    """Absolute files for a Content Manager row.

    Unlike :func:`iter_files_for_pack` this does not apply the torrent
    exclusions (loose Anki media, decrypted caches, …) because those are real
    content the user asked to see and move. SQLite WAL/SHM and log noise are
    still skipped.
    """
    for rel in rels:
        target = root / Path(rel)
        if not target.exists():
            continue
        if target.is_file():
            if not _is_transient(target):
                yield target
            continue
        for f in target.rglob("*"):
            if f.is_file() and not _is_transient(f):
                yield f


_TRANSFER_SIZE_CACHE: dict[str, tuple[float, int]] = {}
_TRANSFER_SIZE_TTL = 180.0


def transfer_paths_bytes(root: Path, rels: Iterable[str]) -> int:
    """Payload bytes for a transfer row, cached briefly (Anki media = 74k files)."""
    rels = tuple(rels)
    key = f"{root.resolve()}::{'|'.join(rels)}"
    now = _time.time()
    hit = _TRANSFER_SIZE_CACHE.get(key)
    if hit and now - hit[0] < _TRANSFER_SIZE_TTL:
        return hit[1]
    total = 0
    for f in iter_files_for_transfer(root, rels):
        try:
            total += f.stat().st_size
        except OSError:
            continue
    _TRANSFER_SIZE_CACHE[key] = (now, total)
    return total


def _extra_entry(root: Path, extra: dict) -> dict | None:
    paths = tuple(extra.get("paths") or ())
    size = transfer_paths_bytes(root, paths)
    if size <= 0:
        return None
    return {
        "id": extra["id"],
        "pack_id": extra["pack_id"],
        "label": extra["label"],
        "description": extra["description"],
        "required": False,
        "state": "green",
        "detail": "Local data — included in Content Manager exports",
        "paths": list(paths),
        "scope": "paths",
        "local_only": True,
        "size_on_disk": size,
        "size_approx": size,
        "present_ratio": 1.0,
        "torrent_progress": 0.0,
        "torrent_selected": False,
        "torrent_complete": False,
        "torrent_downloaded": 0,
        "torrent_size": 0,
        "children": [],
    }


_SIZE_CACHE: dict[str, tuple[float, int, float]] = {}
_SIZE_CACHE_TTL = 180.0  # seconds — size scans on big packs are expensive
_SIZE_CACHE_TRUNCATED_TTL = 20.0  # retry sooner after a budget-limited walk


def path_bytes_on_disk(root: Path, rel: str) -> int:
    """Bytes present on disk for a torrent path prefix (file or directory)."""
    import os
    import time as _time

    cache_key = f"{root.resolve()}::{rel}"
    now = _time.time()
    hit = _SIZE_CACHE.get(cache_key)
    if hit and now - hit[0] < hit[2]:
        return hit[1]

    target = root / Path(rel)
    total = 0
    truncated = False
    if not target.exists():
        total = 0
    elif target.is_file():
        try:
            total = 0 if _is_excluded(target) else int(target.stat().st_size)
        except OSError:
            total = 0
    else:
        # Fast directory walk via scandir (avoids Path.rglob overhead on huge trees).
        stack = [target]
        deadline = now + 5.0  # soft cap so /content/sync never hangs the UI
        while stack:
            if _time.time() > deadline:
                truncated = True
                break
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for entry in it:
                        name = entry.name
                        if _is_excluded_dir_name(name):
                            continue
                        if name in EXCLUDE_NAMES:
                            if name not in _UTD_ONLY_EXCLUDES or _is_utd_bundle_dir(cur):
                                continue
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(Path(entry.path))
                            elif entry.is_file(follow_symlinks=False):
                                if _is_excluded(Path(entry.path)):
                                    continue
                                total += int(entry.stat(follow_symlinks=False).st_size)
                        except OSError:
                            continue
            except OSError:
                continue
    _SIZE_CACHE[cache_key] = (
        now,
        total,
        _SIZE_CACHE_TRUNCATED_TTL if truncated else _SIZE_CACHE_TTL,
    )
    return total


def pack_bytes_on_disk(root: Path, pack_id: str) -> int:
    total = sum(path_bytes_on_disk(root, rel) for rel in paths_for_pack(pack_id, root))
    # Subtract files that belong to a sibling pack (e.g. the First Aid PDF is
    # inside the books folder but is reported by its own pack).
    for excluded_rel in PACK_EXCLUDE_FILES.get(pack_id, ()):
        try:
            total -= int((root / Path(excluded_rel)).stat().st_size)
        except OSError:
            continue
    total = max(0, total)
    if pack_id != "anki":
        return total

    # Portable builds may deliberately keep the already-extracted 74k-file
    # media directory while omitting the redundant 10+ GB archive.  The normal
    # torrent walk excludes collection.media for speed, so use the launcher's
    # verified archive identity as the bounded size record instead of scanning
    # every loose media file whenever Content Manager opens.
    anki_dir = root / "data" / "anki"
    archive = anki_dir / "collection.media.7z"
    media = anki_dir / "collection.media"
    complete = anki_dir / "collection.media.complete"
    identity = anki_dir / "collection.media.complete.identity"
    if archive.is_file() or not media.is_dir() or not complete.is_file():
        return total
    try:
        digest = complete.read_text(encoding="ascii").strip()
        recorded = identity.read_text(encoding="ascii").strip()
        size_text, _separator, stamp_text = recorded.partition(":")
        recorded_size = int(size_text)
        int(stamp_text)
    except (OSError, UnicodeError, ValueError):
        return total
    if (
        len(digest) != 64
        or any(character not in "0123456789abcdefABCDEF" for character in digest)
        or recorded_size <= 0
    ):
        return total
    return total + recorded_size


# Hierarchical sync "rooms" shown in Content Manager.
# pack ids must match packs.py / PACK_TORRENT_PATHS.
SYNC_ROOMS: tuple[dict, ...] = (
    {
        "id": "core-refs",
        "label": "Core references",
        "glyph": "home_storage",
        "pack_ids": ("core",),
    },
    {
        "id": "databases",
        "label": "Databases",
        "glyph": "database",
        "pack_ids": ("umls-full", "uptodate", "drugs-pro"),
    },
    {
        "id": "qbanks",
        "label": "Question banks",
        "glyph": "quiz",
        "pack_ids": (
            "uworld-step1", "uworld-step2", "uworld-step3", "amboss", "mehlman",
            "mksap19", "boardvitals", "amboss-abim", "uworld-abim", "qbanks-imported",
        ),
    },
    {
        "id": "books",
        "label": "Books, First Aid & retrieval",
        "glyph": "menu_book",
        "pack_ids": ("books", "firstaid", "firstaid-index", "rag"),
    },
    {
        "id": "flashcards",
        "label": "Flashcards",
        "glyph": "style",
        "pack_ids": ("anki",),
    },
)


# ── local-only content (not in any shipped torrent pack) ────────────────────
# Some of the most useful bytes under data/ are deliberately *not* part of a
# shipped 7z: user-gathered Anki media, the derived UpToDate article cache, the
# Epocrates bundle, the raw RxNorm distribution and the offline MDCalc pages.
# They used to be invisible in Content Manager (and therefore not exportable),
# which made the on-disk total much larger than the sum of the pack rows.
# Each entry below is shown as its own row next to its related pack and is
# copied by Content Manager → Export using `iter_files_for_transfer`.
#
# Paths are discovered at call time: the raw RxNorm drop, the offline MDCalc
# pages and the UpToDate bundle all carry release-specific folder names, so a
# hardcoded name silently hides gigabytes of transferable content on the next
# release (or after the user imports a renamed bundle).

_UPTODATE_CACHE_FILES = (
    "utdasset_decrypted.sqlite",
    "fsearch.db",
    "fcontentsearch.db",
    "utd_index.sqlite",
)


def _root_relative(root: Path, candidate: Path) -> str | None:
    try:
        return candidate.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return None


def _uptodate_bundle_rel(root: Path) -> str | None:
    raw = (os.getenv("UTD_DB_PATH") or "").strip()
    candidates: list[Path] = []
    if raw:
        candidates.append(Path(raw))
    candidates.append(root / "data" / "uptodate")
    for candidate in candidates:
        try:
            if not candidate.is_dir() or not _is_utd_bundle_dir(candidate):
                continue
        except OSError:
            continue
        relative = _root_relative(root, candidate)
        if relative:
            return relative
    return None


def _extra_paths(
    root: Path,
    *,
    preferred: Iterable[str] = (),
    patterns: Iterable[tuple[str, str]] = (),
) -> tuple[str, ...]:
    """Existing root-relative paths for a local-only Content Manager row."""
    out: list[str] = []
    seen: set[str] = set()

    def add(rel: str) -> None:
        if rel in seen:
            return
        try:
            if (root / Path(rel)).exists():
                seen.add(rel)
                out.append(rel)
        except OSError:
            pass

    for rel in preferred:
        add(rel)
    for parent, pattern in patterns:
        base = root / Path(parent)
        try:
            for child in sorted(base.glob(pattern)):
                add(f"{parent}/{child.name}")
        except OSError:
            continue
    return tuple(out)


def transfer_extras(root: Path) -> list[dict]:
    root = Path(root)
    utd_rel = _uptodate_bundle_rel(root)
    uptodate_paths = (
        tuple(f"{utd_rel}/{name}" for name in _UPTODATE_CACHE_FILES) if utd_rel else ()
    )
    extras: list[dict] = [
        {
            "id": "anki-media",
            "pack_id": "anki",
            "label": "Anki media (collection.media)",
            "description": (
                "Images and audio referenced by your Anki notes. Needed to study the "
                "same cards with pictures on another machine."
            ),
            "paths": _extra_paths(root, preferred=("data/anki/collection.media",)),
        },
        {
            "id": "uptodate-cache",
            "pack_id": "uptodate",
            "label": "UpToDate article cache",
            "description": (
                "Prepared (decrypted) UpToDate articles plus the search caches. "
                "Transferring these skips the one-time Prepare step on the other machine."
            ),
            "paths": _extra_paths(root, preferred=uptodate_paths),
        },
        {
            "id": "epocrates",
            "pack_id": "drugs-pro",
            "label": "Epocrates drug data",
            "description": "Epocrates formulary and dosing bundle used by the drug reference.",
            "paths": _extra_paths(
                root,
                preferred=("data/epocrates-imd",),
                patterns=(("data", "epocrates*"),),
            ),
        },
        {
            "id": "rxnorm-source",
            "pack_id": "drugs-pro",
            "label": "RxNorm source data",
            "description": (
                "Full RxNorm distribution (prescribe/rrf) and its zip, used when "
                "rebuilding the RxNorm database."
            ),
            "paths": _extra_paths(root, patterns=(("data", "RxNorm_full*"),)),
        },
        {
            "id": "mdcalc-offline",
            "pack_id": "core",
            "label": "MDCalc offline calculators",
            "description": "Offline MDCalc catalog and pages used by the calculators tab.",
            "paths": _extra_paths(
                root,
                preferred=("data/WSA",),
                patterns=(("data", "WSA*"), ("data", "mdcalc*")),
            ),
        },
    ]
    return [extra for extra in extras if extra["paths"]]


def _entry_label(pack_id: str, pack_name: str | None = None) -> str:
    return pack_name or pack_id


_RETRIEVAL_CHILD_LABELS = {
    "data/faiss": "FAISS vectors",
    "data/bm25": "BM25 text index",
    "models": "Embedding models",
}


def _pack_child_bytes(root: Path, pack_id: str, rel: str) -> int:
    """Child size with files that belong to a sibling pack removed."""
    total = path_bytes_on_disk(root, rel)
    prefix = rel.rstrip("/") + "/"
    for excluded in PACK_EXCLUDE_FILES.get(pack_id, ()):
        if excluded == rel or excluded.startswith(prefix):
            try:
                total -= int((root / Path(excluded)).stat().st_size)
            except OSError:
                continue
    return max(0, total)


def build_sync_tree(
    root: Path,
    *,
    pack_status: list[dict] | None = None,
    torrent_packs: list[dict] | None = None,
) -> dict:
    """Hierarchical rooms with on-disk sizes + optional torrent progress."""
    root = Path(root)
    status_by_id = {p["id"]: p for p in (pack_status or []) if isinstance(p, dict) and "id" in p}
    torrent_by_id = {
        p["pack_id"]: p
        for p in (torrent_packs or [])
        if isinstance(p, dict) and p.get("pack_id")
    }
    extras_by_pack: dict[str, list[dict]] = {}
    for extra in transfer_extras(root):
        extras_by_pack.setdefault(extra["pack_id"], []).append(extra)
    rooms_out: list[dict] = []
    total_on_disk = 0
    total_approx = 0

    for room in SYNC_ROOMS:
        entries: list[dict] = []
        room_disk = 0
        room_approx = 0
        for pack_id in room["pack_ids"]:
            st = status_by_id.get(pack_id) or {}
            paths = list(paths_for_pack(pack_id, root))
            disk = pack_bytes_on_disk(root, pack_id)
            approx_gb = float(st.get("approx_size_gb") or 0)
            approx = int(approx_gb * (1024 ** 3)) if approx_gb else disk
            tp = torrent_by_id.get(pack_id) or {}
            children: list[dict] = []
            if pack_id == "mehlman":
                for rel in paths:
                    folder = Path(rel).name
                    title_path = root / rel / "title.txt"
                    label = folder
                    if title_path.exists():
                        try:
                            raw = title_path.read_text(encoding="utf-8", errors="ignore").strip()
                            if raw and raw.lower() != "system.object[]":
                                label = raw
                        except OSError:
                            pass
                    c_disk = path_bytes_on_disk(root, rel)
                    children.append({
                        "id": folder,
                        "label": label,
                        "path": rel,
                        "size_on_disk": c_disk,
                        "present": c_disk > 0,
                    })
            elif pack_id == "books":
                books_dir = root / "data" / "books"
                if books_dir.is_dir():
                    for sub in sorted(books_dir.iterdir()):
                        if not sub.is_dir() or sub.name.startswith("."):
                            continue
                        rel = f"data/books/{sub.name}"
                        c_disk = _pack_child_bytes(root, "books", rel)
                        children.append({
                            "id": sub.name,
                            "label": sub.name,
                            "path": rel,
                            "size_on_disk": c_disk,
                            "present": c_disk > 0,
                        })
            elif pack_id in ("firstaid", "firstaid-index", "rag"):
                for rel in paths:
                    c_disk = path_bytes_on_disk(root, rel)
                    children.append({
                        "id": Path(rel).name,
                        "label": _RETRIEVAL_CHILD_LABELS.get(rel, Path(rel).name),
                        "path": rel,
                        "size_on_disk": c_disk,
                        "present": c_disk > 0,
                    })
            present_ratio = (disk / approx) if approx > 0 else (1.0 if disk > 0 else 0.0)
            present_ratio = max(0.0, min(1.0, present_ratio))
            entry = {
                "id": pack_id,
                "pack_id": pack_id,
                "label": _entry_label(pack_id, st.get("name")),
                "description": st.get("description") or "",
                "required": bool(st.get("required")),
                "state": st.get("state") or ("green" if disk > 0 else "grey"),
                "detail": st.get("detail") or "",
                "paths": paths,
                "size_on_disk": disk,
                "size_approx": approx,
                "present_ratio": round(present_ratio, 4),
                "torrent_progress": float(tp.get("progress") or 0),
                "torrent_selected": bool(tp.get("selected")) if tp else False,
                "torrent_complete": bool(tp.get("complete")) if tp else False,
                "torrent_downloaded": int(tp.get("downloaded") or 0),
                "torrent_size": int(tp.get("size") or 0),
                "children": children,
            }
            entries.append(entry)
            room_disk += disk
            room_approx += approx
            # Local-only content that lives beside this pack (Anki media, the
            # UpToDate cache, Epocrates, raw RxNorm, offline MDCalc). It is not
            # shipped by the torrent but must show up — and be transferable —
            # so the room total matches the real size under data/.
            for extra in extras_by_pack.get(pack_id, ()):
                extra_entry = _extra_entry(root, extra)
                if extra_entry is None:
                    continue
                entries.append(extra_entry)
                room_disk += extra_entry["size_on_disk"]
                room_approx += extra_entry["size_approx"]
        rooms_out.append({
            "id": room["id"],
            "label": room["label"],
            "glyph": room["glyph"],
            "size_on_disk": room_disk,
            "size_approx": room_approx,
            "entries": entries,
        })
        total_on_disk += room_disk
        total_approx += room_approx

    return {
        "layout": "medos-folder",
        "root": str(root),
        "save_path_hint": str(root.parent),
        "size_on_disk": total_on_disk,
        "size_approx": total_approx,
        "rooms": rooms_out,
    }

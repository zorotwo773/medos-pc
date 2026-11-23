"""
MedOS Anki Router — Anki schema v18 (Anki 2.1.55+).
Reads the user's local Anki collection (read-only), renders card templates,
tracks study progress with SM-2 scheduling, and serves media files.
Never writes to Anki's own DB.
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
import tempfile
import threading
import time
from contextlib import closing
from html import unescape
from pathlib import Path
from typing import Optional
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from config import (
    ANKI_COLLECTION,
    ANKI_MEDIA_DIR,
    ANKI_PROGRESS_DB,
    ANKI_USERDECKS_DB,
)
import firstaid

router = APIRouter(prefix="/anki", tags=["anki"])

# ── DB snapshot (avoids WAL lock while Anki is open) ──────────────────────

_SNAP_PATH   = Path(tempfile.gettempdir()) / "medos_anki_snap.db"
_snap_lock   = threading.Lock()
_snap_ts: float = 0.0
_SNAP_INTERVAL  = 60.0

# In-memory notetype cache (rebuilt on each snapshot refresh)
_nt_cache: dict = {}        # {ntid: {name, is_cloze, fields:[str], templates:[{qfmt,afmt}]}}
_deck_cache: dict = {}      # {did: {id, name}}
_cache_lock = threading.Lock()


def _refresh_snap(force: bool = False) -> None:
    global _snap_ts
    tmp_path: Path | None = None
    with _snap_lock:
        if not force and (time.time() - _snap_ts) < _SNAP_INTERVAL:
            return
        if not ANKI_COLLECTION.exists():
            return
        try:
            tmp = tempfile.NamedTemporaryFile(
                prefix="medos_anki_snap_",
                suffix=".db",
                dir=str(_SNAP_PATH.parent),
                delete=False,
            )
            tmp_path = Path(tmp.name)
            tmp.close()

            shutil.copy2(str(ANKI_COLLECTION), str(tmp_path))
            nt, dk = _read_cache(tmp_path)
            tmp_path.replace(_SNAP_PATH)

            with _cache_lock:
                _nt_cache.clear();  _nt_cache.update(nt)
                _deck_cache.clear(); _deck_cache.update(dk)
            _snap_ts = time.time()
            print(f"[anki] cache: {len(nt)} notetypes, {len(dk)} decks")
        except Exception as e:
            if _SNAP_PATH.exists():
                _snap_ts = time.time()
            print(f"[anki] snapshot failed: {e}")
        finally:
            if tmp_path and tmp_path.exists():
                try:
                    tmp_path.unlink()
                except Exception:
                    pass


def _raw_conn(path: Path = _SNAP_PATH) -> sqlite3.Connection:
    """Open a snapshot DB directly — no refresh check, no lock."""
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.create_collation(
        "unicase",
        lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()),
    )
    return conn


def _read_cache(path: Path) -> tuple[dict, dict]:
    conn = _raw_conn(path)
    try:
        nt = _load_notetypes(conn)
        dk = _load_decks(conn)
        return nt, dk
    finally:
        conn.close()


def _rebuild_cache() -> None:
    """Reload notetype + deck cache from snapshot. Must be called while _snap_lock is held."""
    if not _SNAP_PATH.exists():
        return
    try:
        nt, dk = _read_cache(_SNAP_PATH)
        with _cache_lock:
            _nt_cache.clear();  _nt_cache.update(nt)
            _deck_cache.clear(); _deck_cache.update(dk)
        print(f"[anki] cache: {len(nt)} notetypes, {len(dk)} decks")
    except Exception as e:
        print(f"[anki] cache rebuild failed: {e}")


def _cache_ready() -> bool:
    with _cache_lock:
        return bool(_nt_cache) and bool(_deck_cache)


def _ensure_cache_ready() -> None:
    if _cache_ready() or not _SNAP_PATH.exists():
        return
    with _snap_lock:
        if not _cache_ready() and _SNAP_PATH.exists():
            _rebuild_cache()


def _open_snap() -> sqlite3.Connection:
    """Open the snapshot DB. Triggers a background refresh if stale but doesn't block."""
    # If snap is stale, kick off a non-blocking background refresh
    if (time.time() - _snap_ts) > _SNAP_INTERVAL:
        threading.Thread(target=_refresh_snap, daemon=True).start()
    if not _SNAP_PATH.exists():
        # Snap not ready yet — block on initial copy only
        _refresh_snap(force=True)
        if not _SNAP_PATH.exists():
            raise HTTPException(503, "Anki collection not found or snapshot failed")
    _ensure_cache_ready()
    return _raw_conn()

# ── Protobuf helpers ──────────────────────────────────────────────────────

def _varint(data: bytes, offset: int) -> tuple[int, int]:
    result = shift = 0
    while offset < len(data):
        b = data[offset]; offset += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    return result, offset


def _decode_proto_strings(data: bytes) -> dict[int, list[str]]:
    """Decode protobuf bytes → {field_num: [string_value, ...]} for LEN fields only."""
    fields: dict[int, list[str]] = {}
    offset = 0
    while offset < len(data):
        try:
            tag, offset = _varint(data, offset)
            fn, wt = tag >> 3, tag & 7
            if wt == 2:      # LEN
                length, offset = _varint(data, offset)
                val = data[offset:offset + length]
                offset += length
                try:
                    fields.setdefault(fn, []).append(val.decode("utf-8", errors="replace"))
                except Exception:
                    pass
            elif wt == 0:    # varint
                _, offset = _varint(data, offset)
            elif wt == 1:    offset += 8   # 64-bit
            elif wt == 5:    offset += 4   # 32-bit
            else:            break
        except Exception:
            break
    return fields


def _decode_template_config(config_bytes: bytes | None) -> tuple[str, str]:
    """Extract qfmt (field 1) and afmt (field 2) from template.config protobuf."""
    if not config_bytes:
        return "", ""
    fields = _decode_proto_strings(config_bytes)
    qfmt = fields.get(1, [""])[0]
    afmt = fields.get(2, [""])[0]
    return qfmt, afmt


def _is_cloze(config_bytes: bytes | None) -> bool:
    """Return True if notetype.config encodes kind=1 (cloze)."""
    if not config_bytes:
        return False
    # Protobuf field 1, wire type 0 (varint) = tag byte 0x08 → value 1 means cloze
    offset = 0
    while offset < len(config_bytes):
        try:
            tag, offset = _varint(config_bytes, offset)
            fn, wt = tag >> 3, tag & 7
            if fn == 1 and wt == 0:
                val, offset = _varint(config_bytes, offset)
                return val == 1
            elif wt == 2:
                l, offset = _varint(config_bytes, offset)
                offset += l
            elif wt == 0:
                _, offset = _varint(config_bytes, offset)
            elif wt == 1: offset += 8
            elif wt == 5: offset += 4
            else: break
        except Exception:
            break
    return False


# ── Schema v18 loaders ────────────────────────────────────────────────────

def _load_notetypes(conn: sqlite3.Connection) -> dict:
    result: dict = {}
    for row in conn.execute("SELECT id, name, config FROM notetypes"):
        ntid = row["id"]
        result[ntid] = {
            "name":      row["name"],
            "is_cloze":  _is_cloze(row["config"]),
            "fields":    [],
            "templates": [],
        }
    for row in conn.execute("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord"):
        if row["ntid"] in result:
            result[row["ntid"]]["fields"].append(row["name"])
    for row in conn.execute("SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord"):
        if row["ntid"] in result:
            qfmt, afmt = _decode_template_config(row["config"])
            result[row["ntid"]]["templates"].append({"qfmt": qfmt, "afmt": afmt})
    return result


def _load_decks(conn: sqlite3.Connection) -> dict:
    result: dict = {}
    for row in conn.execute("SELECT id, name FROM decks"):
        # v18 uses \x1f as hierarchy separator
        display = row["name"].replace("\x1f", "::")
        result[row["id"]] = {"id": row["id"], "name": display}
    return result


def _nt(ntid: int) -> dict:
    """Get notetype from cache (or return empty stub)."""
    with _cache_lock:
        return _nt_cache.get(ntid, {"name": "Unknown", "is_cloze": False, "fields": [], "templates": []})


def _deck_name(did: int) -> str:
    with _cache_lock:
        return _deck_cache.get(did, {}).get("name", "Unknown Deck")


def _deck_subtree_ids(deck_id: int) -> list[int]:
    """Return a deck id plus all descendants using Anki's hierarchy separator."""
    with _cache_lock:
        parent = _deck_cache.get(deck_id)
        if not parent:
            return [deck_id]
        parent_name = parent.get("name", "").replace("::", "\x1f")
        ids = [
            d["id"] for d in _deck_cache.values()
            if d["name"].replace("::", "\x1f") == parent_name
            or d["name"].replace("::", "\x1f").startswith(parent_name + "\x1f")
        ]
    return ids or [deck_id]


# Boot-time snapshot in background, after schema loaders are defined.
threading.Thread(target=lambda: _refresh_snap(force=True), daemon=True).start()


# ── Progress DBs ──────────────────────────────────────────────────────────

def _progress_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(ANKI_PROGRESS_DB), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS card_state (
        card_id INTEGER PRIMARY KEY,
        ivl     INTEGER DEFAULT 1,
        factor  INTEGER DEFAULT 2500,
        reps    INTEGER DEFAULT 0,
        due_day INTEGER DEFAULT 0
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS buried (
        card_id     INTEGER,
        buried_date TEXT
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_buried_date ON buried(buried_date)")
    conn.commit()
    return conn


def _userdecks_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(ANKI_USERDECKS_DB), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_decks (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        front_html TEXT,
        back_html  TEXT,
        tags       TEXT DEFAULT '',
        deck_id    INTEGER DEFAULT 0,
        created_at INTEGER
    )""")
    conn.commit()
    return conn


_today_day = lambda: int(time.time() / 86400)


# ── Template renderer ──────────────────────────────────────────────────────

_FIELD_RE    = re.compile(r"\{\{([^#/^{][^}]*?)\}\}")
_COND_RE     = re.compile(r"\{\{#([^}]+)\}\}(.*?)\{\{/\1\}\}", re.DOTALL)
_INV_RE      = re.compile(r"\{\{\^([^}]+)\}\}(.*?)\{\{/\1\}\}", re.DOTALL)
_CLOZE_RE    = re.compile(r"\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}", re.DOTALL)
_SRC_DQ_RE   = re.compile(r'src="(?!https?://|/|data:)([^"]+)"', re.IGNORECASE)
_SRC_SQ_RE   = re.compile(r"src='(?!https?://|/|data:)([^']+)'", re.IGNORECASE)
_HREF_RE     = re.compile(r'href="(?!https?://|#|/)([^"]+\.[a-zA-Z0-9]{2,5})"', re.IGNORECASE)
_SOUND_RE    = re.compile(r'\[sound:([^\]]+)\]')
_TAG_RE      = re.compile(r"<[^>]+>")
_ANKI_CLOZE_RE = re.compile(r"\{\{c\d+::(.*?)(?:::[^{}]*)?\}\}", re.DOTALL)
_FA_TAG_SKIP = {
    "ak", "anking", "ankihub", "fa", "first aid", "firstaid", "firstaid2026",
    "step", "step1", "step 1", "usmle", "resources", "reference",
}

# Decorator images that are purely cosmetic (logos, icons, promotional)
_DECO_RE = re.compile(
    r'<img[^>]+src="/api/anki/media/('
    r'_AnKingRound[^"]*|_Anking_v[^"]*|_OME_AnkiFlashcards_[^"]+|'
    r'_pathoma\.icon[^"]*|_first-aid\.icon[^"]*|_sketchy\.icon[^"]*|'
    r'_picmonic\.icon[^"]*|_pixorize\.icon[^"]*|_physeo\.icon[^"]*|'
    r'_bootcamp\.icon[^"]*|_b&b\.icon[^"]*|_AnkingStep[^"]*'
    r')[^>]*>',
    re.IGNORECASE,
)
_MEDIA_TAG_RE = re.compile(
    r'<(?:img|source)\b(?=[^>]*\bsrc=(["\'])/api/anki/media/([^"\']+)\1)[^>]*>',
    re.IGNORECASE,
)
_BLOCKED_MEDIA_FILENAMES = {
    # Repeated "Calculate by QxMD" promotional screenshot seen under several
    # AMBOSS/Anki media aliases.
    "big_5f60715a617b1.jpg",
    "big_5f61d6243023a.jpg",
    "big_5f68987d166f5.jpg",
}


def _clean_media_filename(raw: str) -> str:
    name = unquote(unescape(raw or "")).split("?", 1)[0].split("#", 1)[0]
    return name.replace("\\", "/").lstrip("/")


def _anki_media_available(raw: str) -> bool:
    filename = _clean_media_filename(raw)
    if not filename or Path(filename).name.lower() in _BLOCKED_MEDIA_FILENAMES:
        return False
    path = ANKI_MEDIA_DIR.joinpath(*[part for part in filename.split("/") if part])
    try:
        path.resolve().relative_to(ANKI_MEDIA_DIR.resolve())
    except ValueError:
        return False
    return path.exists()


def _strip_unavailable_media(html: str) -> str:
    return _MEDIA_TAG_RE.sub(
        lambda m: m.group(0) if _anki_media_available(m.group(2)) else "",
        html,
    )


def _sanitize(html: str) -> str:
    """Strip AnKing template noise; transform hint buttons to <details> accordions."""
    # 1. Strip script and style blocks
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style\b[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    # 2. Strip HTML comments
    html = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)
    # 3. Strip external links but keep their inner content
    html = re.sub(r'<a\s[^>]*href="https?://[^"]*"[^>]*>(.*?)</a>', r'\1', html,
                  flags=re.DOTALL | re.IGNORECASE)
    # 4. Strip decorator images (logos, icons, promo images)
    html = _DECO_RE.sub('', html)
    html = _strip_unavailable_media(html)
    # 5. Strip utility/chrome divs that serve no study purpose
    _STRIP_DIVS = [
        r'<div[^>]+id=["\']?one-by-one["\']?[^>]*>.*?</div>',
        r'<div[^>]+id=["\']?1by1-btns["\']?[^>]*>.*?</div>',
        r'<div[^>]+class=["\']?editcloze["\']?[^>]*>.*?</div>',
        r'<div[^>]+class=["\']?timer["\']?[^>]*>.*?</div>',
        r'<div[^>]+id=["\']?tags-container["\']?[^>]*>.*?</div>',
        r'<div[^>]+class=["\']?banner-ome["\']?[^>]*>.*?</div>',
    ]
    for pat in _STRIP_DIVS:
        html = re.sub(pat, '', html, flags=re.DOTALL | re.IGNORECASE)
    # 6. Transform hint-button spans → <details> accordions (show content, skip empties)
    _AUTO_OPEN_HINTS = {"First Aid", "Lecture Notes"}
    def _hint_to_details(m: re.Match) -> str:
        span = m.group(0)
        name_m = re.search(r'data-name\s*=\s*["\']([^"\']+)["\']', span)
        label = name_m.group(1) if name_m else "Reference"
        content_m = re.search(r'<div[^>]+class=["\']hints["\'][^>]*>(.*?)</div>', span, re.DOTALL)
        if not content_m:
            return ''
        content = content_m.group(1).strip()
        if not content:
            return ''
        open_attr = ' open' if label in _AUTO_OPEN_HINTS else ''
        return (
            f'<details class="anki-hint"{open_attr}>'
            f'<summary class="anki-hint-label">{label}</summary>'
            f'<div class="anki-hint-content">{content}</div>'
            f'</details>'
        )
    html = re.sub(r'<span[^>]+class=["\']hintBtn["\'][^>]*>.*?</span>',
                  _hint_to_details, html, flags=re.DOTALL | re.IGNORECASE)
    # 7. Collapse nested empty divs/spans left behind
    for _ in range(5):
        html = re.sub(r'<(div|span|p)[^>]*>\s*</\1>', '', html, flags=re.IGNORECASE)
    # 8. Strip orphaned closing tags from stripped containers
    html = re.sub(r'</?(div|span)[^>]*>\s*(?=</?(div|span|details|br|hr|p)\b)', '', html, flags=re.IGNORECASE)
    # 9. Normalise excess whitespace / line breaks
    html = re.sub(r'\n\s*\n\s*\n+', '\n\n', html)        # max 2 blank lines
    html = re.sub(r'(<br\s*/?>\s*){3,}', '<br><br>', html, flags=re.IGNORECASE)
    html = re.sub(r'(<br\s*/?>|\s)+$', '', html)          # trailing br/whitespace
    html = re.sub(r'^(\s*<br\s*/?>)+', '', html)          # leading br tags
    return html.strip()


def _rewrite_media(html: str) -> str:
    # Rewrite bare image/media src to go through our endpoint
    # Use /api/anki/media/ which Next.js proxies — works from any network device
    html = _SRC_DQ_RE.sub(lambda m: f'src="/api/anki/media/{m.group(1)}"', html)
    html = _SRC_SQ_RE.sub(lambda m: f"src='/api/anki/media/{m.group(1)}'", html)
    html = _HREF_RE.sub(lambda m: f'href="/api/anki/media/{m.group(1)}"', html)
    # [sound:filename.mp3] → HTML5 audio player
    html = _SOUND_RE.sub(
        lambda m: (
            f'<audio controls style="max-width:100%;margin:4px 0">'
            f'<source src="/api/anki/media/{m.group(1)}">'
            f'</audio>'
        ),
        html,
    )
    return html


def _plain_text(html: str | None) -> str:
    text = unescape(html or "")
    text = _ANKI_CLOZE_RE.sub(r"\1", text)
    text = re.sub(r"<(br|/p|/div|/li|/tr)\b[^>]*>", " ", text, flags=re.IGNORECASE)
    text = _TAG_RE.sub(" ", text)
    text = re.sub(r"\[sound:[^\]]+\]", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"/api/anki/media/\S+", " ", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


def _tag_phrase_candidates(tags: list[str]) -> list[tuple[str, int]]:
    candidates: list[tuple[str, int]] = []
    for tag in tags:
        for part in re.split(r"::|/|\\\\", tag):
            phrase = part.replace("_", " ").replace("-", " ")
            phrase = re.sub(r"^[#\s]+", "", phrase)
            phrase = re.sub(r"^\d+[\s.)_-]*", "", phrase)
            phrase = re.sub(r"\bv\d+\b", " ", phrase, flags=re.IGNORECASE)
            phrase = re.sub(r"\s+", " ", phrase).strip()
            key = firstaid.normalize(phrase)
            if len(key) < 4 or key in _FA_TAG_SKIP:
                continue
            if len(key.split()) > 7:
                continue
            candidates.append((phrase, 95))
    return candidates


def _firstaid_text_candidates(text: str, limit: int = 12) -> list[tuple[str, int]]:
    normalized = firstaid.normalize(text)
    if not normalized:
        return []
    haystack = f" {normalized} "
    out: list[tuple[str, int]] = []
    seen: set[str] = set()
    for entry in firstaid.scan_entries():
        term = entry.get("term") or ""
        key = firstaid.normalize(term)
        if not key or key in seen:
            continue
        if f" {key} " not in haystack:
            continue
        seen.add(key)
        token_count = len(key.split())
        score = 70 + min(24, len(key) // 3) + min(10, token_count * 2)
        out.append((term, score))
        if len(out) >= limit:
            break
    return out


def _score_firstaid_ref(region: dict, term: str, base_score: int) -> int:
    title_key = firstaid.normalize(str(region.get("title") or ""))
    term_key = firstaid.normalize(term)
    score = base_score
    if title_key == term_key:
        score += 80
    elif title_key.startswith(term_key) or term_key.startswith(title_key):
        score += 45
    elif term_key and term_key in title_key:
        score += 25
    hierarchy_key = firstaid.normalize(str(region.get("hierarchy") or ""))
    if term_key and term_key in hierarchy_key:
        score += 12
    return score


def _firstaid_refs_for_card(front_html: str, back_html: str, tags: list[str], limit: int = 4) -> list[dict]:
    if not firstaid.index_exists():
        return []

    content_text = " ".join([_plain_text(front_html), _plain_text(back_html)])
    raw_candidates = _tag_phrase_candidates(tags) + _firstaid_text_candidates(content_text)
    if not raw_candidates:
        return []

    candidates: dict[str, tuple[str, int]] = {}
    for phrase, score in raw_candidates:
        key = firstaid.normalize(phrase)
        if not key:
            continue
        current = candidates.get(key)
        if current is None:
            candidates[key] = (phrase, score)
        else:
            candidates[key] = (current[0], min(160, current[1] + max(8, score // 3)))

    refs: dict[int, dict] = {}
    sorted_candidates = sorted(candidates.values(), key=lambda item: (item[1], len(item[0])), reverse=True)[:18]
    for phrase, score in sorted_candidates:
        for region in firstaid.search_regions(phrase, 3):
            heading_id = int(region["heading_id"])
            ref_score = _score_firstaid_ref(region, phrase, score)
            current = refs.get(heading_id)
            if current and int(current.get("score") or 0) >= ref_score:
                continue
            refs[heading_id] = {
                "heading_id": heading_id,
                "title": region.get("title") or phrase,
                "hierarchy": region.get("hierarchy") or "",
                "page": int(region.get("page") or 1),
                "score": ref_score,
            }

    return sorted(refs.values(), key=lambda item: (-int(item["score"]), int(item["page"]), str(item["title"]).lower()))[:limit]


def _build_fields(flds_str: str, nt: dict) -> dict[str, str]:
    vals  = flds_str.split("\x1f")
    names = nt.get("fields", [])
    return {name: (vals[i] if i < len(vals) else "") for i, name in enumerate(names)}


def _apply_conditionals(html: str, fields: dict[str, str]) -> str:
    def _c(m):
        return m.group(2) if fields.get(m.group(1).strip(), "").strip() else ""
    def _i(m):
        return m.group(2) if not fields.get(m.group(1).strip(), "").strip() else ""
    html = _COND_RE.sub(_c, html)
    html = _INV_RE.sub(_i, html)
    return html


def _sub_fields(html: str, fields: dict[str, str]) -> str:
    def _s(m):
        key = m.group(1).strip()
        # Strip filter prefix e.g. "cloze:Text" → handled separately; "text:X" → X
        if ":" in key and not key.startswith("cloze"):
            key = key.split(":", 1)[-1].strip()
        if key.startswith("cloze"):
            # handled by cloze renderer — leave placeholder untouched for now
            return m.group(0)
        return fields.get(key, "")
    return _FIELD_RE.sub(_s, html)


def _render_cloze_front(html: str, card_ord: int) -> str:
    target = card_ord + 1  # Anki cloze numbers are 1-based
    def _r(m):
        n, text, hint = int(m.group(1)), m.group(2), m.group(3) or "…"
        return f'<span class="anki-cloze-blank">[{hint}]</span>' if n == target else text
    return _CLOZE_RE.sub(_r, html)


def _render_cloze_back(html: str, card_ord: int) -> str:
    target = card_ord + 1
    def _r(m):
        n, text = int(m.group(1)), m.group(2)
        return f'<span class="anki-cloze">{text}</span>' if n == target else text
    return _CLOZE_RE.sub(_r, html)


def _render_side(flds_str: str, ntid: int, card_ord: int, side: str) -> str:
    nt = _nt(ntid)
    fields = _build_fields(flds_str, nt)

    tmpls = nt.get("templates", [])
    tmpl_idx = card_ord if not nt["is_cloze"] else 0
    if tmpl_idx >= len(tmpls):
        tmpl_idx = 0

    if not tmpls:
        # Fallback: join non-empty fields
        content = "<br>".join(v for v in fields.values() if v.strip())
        return _sanitize(_rewrite_media(content))

    tmpl = tmpls[tmpl_idx]
    raw = tmpl["qfmt"] if side == "q" else tmpl["afmt"]

    if nt["is_cloze"]:
        # First substitute the cloze field into {{cloze:FieldName}}
        def _inject_cloze(m):
            fname = m.group(1).strip()
            field_content = fields.get(fname, "")
            if side == "q":
                return _render_cloze_front(field_content, card_ord)
            else:
                return _render_cloze_back(field_content, card_ord)
        raw = re.sub(r"\{\{cloze:([^}]+)\}\}", _inject_cloze, raw)
    else:
        raw = _apply_conditionals(raw, fields)

    # {{FrontSide}} on back
    if side == "a" and "{{FrontSide}}" in raw:
        front = _render_side(flds_str, ntid, card_ord, "q")
        raw = raw.replace("{{FrontSide}}", front)

    raw = _sub_fields(raw, fields)
    raw = _rewrite_media(raw)

    # Strip leftover unfilled {{...}} placeholders
    raw = re.sub(r"\{\{[^}]+\}\}", "", raw)
    return _sanitize(raw)


# ── SM-2 scheduling ────────────────────────────────────────────────────────

def _schedule(card_id: int, rating: int, base_ivl: int, base_factor: int) -> dict:
    with closing(_progress_conn()) as pc:
        row = pc.execute("SELECT * FROM card_state WHERE card_id=?", (card_id,)).fetchone()
        ivl    = row["ivl"]    if row else max(1, base_ivl)
        factor = row["factor"] if row else base_factor
        today  = _today_day()

        if rating == 1:
            ivl, factor, due = 1, max(1300, factor - 200), today + 1
        elif rating == 2:
            ivl    = max(1, int(ivl * 1.2))
            factor = max(1300, factor - 150)
            due    = today + ivl
        elif rating == 3:
            ivl  = max(1, int(ivl * factor / 1000))
            due  = today + ivl
        else:
            ivl    = max(1, int(ivl * factor / 1000 * 1.3))
            factor = min(9999, factor + 150)
            due    = today + ivl

        pc.execute("""INSERT INTO card_state(card_id, ivl, factor, reps, due_day)
                      VALUES(?,?,?,1,?)
                      ON CONFLICT(card_id) DO UPDATE SET
                        ivl=excluded.ivl, factor=excluded.factor,
                        reps=reps+1, due_day=excluded.due_day""",
                   (card_id, ivl, factor, due))
        pc.commit()
        return {"ivl": ivl, "factor": factor, "due_day": due}


def _bury(card_id: int) -> None:
    today_str = str(_today_day())
    with closing(_progress_conn()) as pc:
        pc.execute("DELETE FROM buried WHERE card_id=? AND buried_date=?", (card_id, today_str))
        pc.execute("INSERT INTO buried(card_id, buried_date) VALUES(?,?)", (card_id, today_str))
        pc.commit()


def _buried_today() -> set[int]:
    today_str = str(_today_day())
    with closing(_progress_conn()) as pc:
        rows = pc.execute("SELECT card_id FROM buried WHERE buried_date=?", (today_str,)).fetchall()
        return {r["card_id"] for r in rows}


# ── Card packaging ────────────────────────────────────────────────────────

def _package_card(conn: sqlite3.Connection, card_id: int) -> dict:
    row = conn.execute("""
        SELECT c.id, c.nid, c.did, c.ord, c.queue, c.type, c.ivl, c.factor,
               n.flds, n.mid, n.tags
        FROM cards c JOIN notes n ON c.nid = n.id
        WHERE c.id = ?
    """, (card_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Card not found")

    front = _render_side(row["flds"], row["mid"], row["ord"], "q")
    back  = _render_side(row["flds"], row["mid"], row["ord"], "a")
    tags  = [t for t in row["tags"].strip().split() if t]
    nt    = _nt(row["mid"])
    firstaid_refs = _firstaid_refs_for_card(front, back, tags)

    return {
        "card_id":     card_id,
        "deck_id":     row["did"],
        "deck_name":   _deck_name(row["did"]),
        "tags":        tags,
        "front_html":  front,
        "back_html":   back,
        "firstaid_refs": firstaid_refs,
        "base_ivl":    row["ivl"],
        "base_factor": row["factor"] or 2500,
        "queue":       row["queue"],
        "card_type":   row["type"],
        "is_cloze":    nt["is_cloze"],
    }


# ── Endpoints ─────────────────────────────────────────────────────────────

@router.get("/decks")
def list_decks():
    try:
        buried = _buried_today()
        today  = _today_day()
        with closing(_open_snap()) as conn, closing(_progress_conn()) as pc:
            state_rows = pc.execute("SELECT card_id, due_day FROM card_state").fetchall()
            state_map  = {r["card_id"]: r["due_day"] for r in state_rows}

            with _cache_lock:
                decks_snapshot = dict(_deck_cache)

            result = []
            for did, deck in decks_snapshot.items():
                cards = conn.execute(
                    "SELECT id, queue FROM cards WHERE did=?", (did,)
                ).fetchall()

                new_c = lrn_c = due_c = 0
                for c in cards:
                    if c["id"] in buried:
                        continue
                    if c["id"] in state_map:
                        if state_map[c["id"]] <= today:
                            due_c += 1
                    elif c["queue"] == 0:
                        new_c += 1
                    elif c["queue"] in (1, 3):
                        lrn_c += 1
                    elif c["queue"] == 2:
                        due_c += 1

                result.append({
                    "id":       did,
                    "name":     deck["name"],
                    "new":      new_c,
                    "learning": lrn_c,
                    "due":      due_c,
                    "total":    new_c + lrn_c + due_c,
                })

        # Top-level decks first, then sub-decks; sort by name
        result.sort(key=lambda d: d["name"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/card/random")
def random_card(
    deck_id: Optional[int] = Query(None),
    exclude_card_id: Optional[int] = Query(None),
):
    import random
    try:
        buried = _buried_today()
        today  = _today_day()
        with closing(_open_snap()) as conn, closing(_progress_conn()) as pc:
            q = "SELECT c.id, c.queue, c.ivl, c.factor FROM cards c WHERE c.queue IN (0,1,2,3)"
            params: list = []
            if deck_id:
                sub_ids = _deck_subtree_ids(deck_id)
                ph = ",".join("?" * len(sub_ids))
                q += f" AND c.did IN ({ph})"
                params.extend(sub_ids)

            cards = conn.execute(q, params).fetchall()
            state_rows = pc.execute("SELECT card_id, due_day FROM card_state").fetchall()
            state_map  = {r["card_id"]: r["due_day"] for r in state_rows}

            candidates = []
            excluded_candidate: int | None = None
            for c in cards:
                if c["id"] in buried:
                    continue
                is_candidate = False
                if c["id"] in state_map:
                    if state_map[c["id"]] <= today:
                        is_candidate = True
                else:
                    is_candidate = True
                if not is_candidate:
                    continue
                if exclude_card_id is not None and c["id"] == exclude_card_id:
                    excluded_candidate = c["id"]
                else:
                    candidates.append(c["id"])

            if not candidates:
                if excluded_candidate is not None:
                    candidates.append(excluded_candidate)
                else:
                    return JSONResponse({"card_id": None, "message": "No cards due"})

            card_id = random.choice(candidates)
            return _package_card(conn, card_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))

@router.get("/card/{card_id}/front")
def card_front(card_id: int):
    with closing(_open_snap()) as conn:
        return _package_card(conn, card_id)


@router.get("/card/{card_id}/back")
def card_back(card_id: int):
    with closing(_open_snap()) as conn:
        data = _package_card(conn, card_id)
        return {"card_id": card_id, "back_html": data["back_html"]}


@router.get("/study")
def study_next(
    deck_id: Optional[int] = Query(None),
    tag:     Optional[str] = Query(None),
    exclude_card_id: Optional[int] = Query(None),
):
    try:
        buried = _buried_today()
        today  = _today_day()
        with closing(_open_snap()) as conn, closing(_progress_conn()) as pc:
            q = "SELECT c.id, c.queue, c.type, c.ivl, c.factor, n.tags FROM cards c JOIN notes n ON c.nid=n.id WHERE c.queue NOT IN (-1,-2,-3)"
            params: list = []
            if deck_id:
                sub_ids = _deck_subtree_ids(deck_id)
                ph = ",".join("?" * len(sub_ids))
                q += f" AND c.did IN ({ph})"
                params.extend(sub_ids)

            all_cards = conn.execute(q, params).fetchall()
            state_rows = pc.execute("SELECT card_id, due_day FROM card_state").fetchall()
            state_map  = {r["card_id"]: r["due_day"] for r in state_rows}

            overdue: list[int] = []
            learning: list[int] = []
            new_ones: list[int] = []
            excluded_candidate: tuple[int, bool] | None = None

            def add_candidate(bucket: list[int], card_id: int, is_new: bool = False) -> None:
                nonlocal excluded_candidate
                if exclude_card_id is not None and card_id == exclude_card_id:
                    excluded_candidate = (card_id, is_new)
                else:
                    bucket.append(card_id)

            for c in all_cards:
                if c["id"] in buried:
                    continue
                if tag:
                    card_tags = c["tags"].strip().split()
                    if not any(tag.lower() in t.lower() for t in card_tags):
                        continue
                if c["id"] in state_map:
                    if state_map[c["id"]] <= today:
                        add_candidate(overdue, c["id"])
                elif c["queue"] in (1, 3):
                    add_candidate(learning, c["id"])
                elif c["queue"] == 0:
                    add_candidate(new_ones, c["id"], is_new=True)
                elif c["queue"] == 2:
                    add_candidate(overdue, c["id"])

            chosen = None
            chosen_is_new = False
            if overdue:   chosen = overdue[0]
            elif learning: chosen = learning[0]
            elif new_ones:
                chosen = new_ones[0]
                chosen_is_new = True

            if chosen is None:
                if excluded_candidate is not None:
                    chosen, chosen_is_new = excluded_candidate
                else:
                    studied = pc.execute("SELECT COUNT(*) FROM card_state WHERE due_day > ?", (today,)).fetchone()[0]
                    return JSONResponse({
                        "card_id": None,
                        "message": "All caught up!",
                        "studied_today": studied,
                        "total_remaining": 0,
                    })

            remaining = len(overdue) + len(learning) + len(new_ones)
            if remaining == 0 and excluded_candidate is not None and chosen == excluded_candidate[0]:
                remaining = 1

            data = _package_card(conn, chosen)
            data["total_remaining"] = remaining
            data["is_new"] = chosen_is_new or chosen in new_ones
            return data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class ReviewBody(BaseModel):
    rating: Optional[int] = None
    action: Optional[str] = None


@router.post("/card/{card_id}/review")
def review_card(card_id: int, body: ReviewBody):
    try:
        if body.action == "bury":
            _bury(card_id)
            return {"ok": True, "action": "buried"}
        if body.rating not in (1, 2, 3, 4):
            raise HTTPException(400, "rating must be 1-4")
        with closing(_open_snap()) as conn:
            row  = conn.execute("SELECT ivl, factor FROM cards WHERE id=?", (card_id,)).fetchone()
            base_ivl    = row["ivl"]    if row else 1
            base_factor = (row["factor"] if row and row["factor"] else 2500)
        result = _schedule(card_id, body.rating, base_ivl, base_factor)
        return {"ok": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/media/{filename:path}")
def serve_media(filename: str):
    path = ANKI_MEDIA_DIR / filename
    if not path.exists():
        raise HTTPException(404, f"Media not found: {filename}")
    try:
        path.resolve().relative_to(ANKI_MEDIA_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "Forbidden")
    return FileResponse(str(path))


@router.get("/tags")
def list_tags(limit: int = 200):
    try:
        with closing(_open_snap()) as conn:
            rows = conn.execute("SELECT tags FROM notes WHERE tags != ''").fetchall()
            freq: dict[str, int] = {}
            for r in rows:
                for t in r["tags"].strip().split():
                    if t:
                        freq[t] = freq.get(t, 0) + 1
            return [{"tag": t, "count": c} for t, c in sorted(freq.items(), key=lambda x: -x[1])[:limit]]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/search")
def search_cards(
    q:       str           = Query(..., min_length=1),
    deck_id: Optional[int] = Query(None),
    limit:   int           = Query(30),
):
    try:
        with closing(_open_snap()) as conn:
            base_q = """SELECT c.id, c.did, c.ord, n.flds, n.mid, n.tags
                        FROM notes n JOIN cards c ON c.nid=n.id
                        WHERE n.flds LIKE ?"""
            params: list = [f"%{q}%"]
            if deck_id:
                base_q += " AND c.did=?"; params.append(deck_id)
            base_q += f" LIMIT {limit}"

            rows  = conn.execute(base_q, params).fetchall()
            seen: set[int] = set()
            out   = []
            for r in rows:
                if r["id"] in seen:
                    continue
                seen.add(r["id"])
                front = _render_side(r["flds"], r["mid"], r["ord"], "q")
                out.append({
                    "card_id":    r["id"],
                    "deck_name":  _deck_name(r["did"]),
                    "front_html": front,
                    "tags":       r["tags"].strip().split(),
                })
            return out
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


class CreateCardBody(BaseModel):
    front_html: str
    back_html:  str
    tags:       str = ""
    deck_id:    int = 0
    deck_name:  str = "MedOS Cards"


@router.post("/cards")
def create_card(body: CreateCardBody):
    try:
        with closing(_userdecks_conn()) as uc:
            uc.execute("INSERT OR IGNORE INTO user_decks(name) VALUES(?)", (body.deck_name,))
            uc.commit()
            deck_row = uc.execute("SELECT id FROM user_decks WHERE name=?", (body.deck_name,)).fetchone()
            deck_id  = deck_row["id"]
            cur = uc.execute(
                "INSERT INTO user_notes(front_html, back_html, tags, deck_id, created_at) VALUES(?,?,?,?,?)",
                (body.front_html, body.back_html, body.tags, deck_id, int(time.time()))
            )
            uc.commit()
            return {"ok": True, "id": cur.lastrowid}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/status")
def anki_status():
    with _cache_lock:
        nt_count   = len(_nt_cache)
        deck_count = len(_deck_cache)
    return {
        "collection_found": ANKI_COLLECTION.exists(),
        "snapshot_ready":   _SNAP_PATH.exists(),
        "notetypes_cached": nt_count,
        "decks_cached":     deck_count,
        "collection_path":  str(ANKI_COLLECTION),
        "media_dir":        str(ANKI_MEDIA_DIR),
    }

"""Validated local UpToDate content access, shared by reader and preparation.

The bundled default belongs only to the shipped encrypted dataset, identified
by an exact ciphertext fingerprint. A configured password always takes priority.
No helper returns passwords or decrypted medical content in status messages.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path

from utd_crypto import UTDKey

# Verified against topic 1 of the 22,406-topic dataset shipped in MedOS 1.1.4.
# This is the content key, independent of any release/archive password.
_SHIPPED_TOPIC_SHA256 = "d93d79607217d4f1df306a0d374f0e0f292bb6cd99357504bfda846a08590b23"
_SHIPPED_CONTENT_PASSWORD = "hs;d,hghdk[;ak"


class UTDContentError(ValueError):
    """An actionable message safe for logs and public status responses."""


class UTDTopicUnavailable(UTDContentError):
    """A source record decrypted successfully but contains zero bytes."""


def open_readonly(path: Path) -> sqlite3.Connection:
    # as_uri also escapes spaces, # and ? in portable installation paths.
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)


def configured_bundle_dir(default: Path) -> Path:
    """Honor a content-folder import immediately, without restarting readers."""
    raw = os.environ.get("UTD_DB_PATH", "").strip()
    configured = Path(raw) if raw else None
    return configured if configured and configured.exists() else Path(default)


def resolve_key(bundle_dir: Path, password: str | None = None) -> UTDKey | None:
    explicit = (password if password is not None else os.environ.get("UTD_PASSWORD", "")).strip()
    if explicit:
        return UTDKey(password=explicit)
    try:
        with closing(open_readonly(Path(bundle_dir) / "utdasset.sqlite")) as c:
            row = c.execute("SELECT payload FROM topic_asset WHERE id=1").fetchone()
        if row and isinstance(row[0], str):
            digest = hashlib.sha256(row[0].encode("utf-8")).hexdigest()
            if digest == _SHIPPED_TOPIC_SHA256:
                return UTDKey(password=_SHIPPED_CONTENT_PASSWORD)
    except (OSError, sqlite3.Error):
        pass
    return None


def decode_topic_content(raw: str | bytes) -> dict:
    try:
        data = json.loads(raw)
    except (ValueError, TypeError, UnicodeError):
        raise UTDContentError("UpToDate topic payload is not valid JSON.") from None
    if not isinstance(data, dict) or not isinstance(data.get("bodyHtml"), str) or not data["bodyHtml"].strip():
        raise UTDContentError("UpToDate topic payload has no readable article body.")
    return data


def decrypt_topic(key: UTDKey, topic_id: int, payload: str) -> dict:
    try:
        raw = key.decrypt_payload(topic_id, payload)
    except Exception:
        raise UTDContentError(
            "UpToDate content could not be decrypted or validated. Check UTD_PASSWORD "
            "for this content bundle or repair the installed content pack. "
            "The content key is separate from the download ZIP password."
        ) from None
    if raw == b"":
        raise UTDTopicUnavailable("This topic has no article content in the installed UpToDate bundle.")
    return decode_topic_content(raw)


def cache_status(bundle_dir: Path, *, full: bool = False) -> dict:
    """Probe schema, coverage, and sample bodies; full=True checks every body."""
    bundle_dir = Path(bundle_dir).resolve()
    if full:
        return _probe_cache(bundle_dir, full=True)
    # A prepared cache can be several GB; repeated health/status polling should
    # not rescan it. Invalidate when either database (or an active WAL) changes.
    signatures = []
    for name in ("utdasset.sqlite", "utdasset.sqlite-wal", "utdasset_decrypted.sqlite", "utdasset_decrypted.sqlite-wal"):
        try:
            stat = (bundle_dir / name).stat()
            signatures.append((stat.st_size, stat.st_mtime_ns, stat.st_ino))
        except OSError:
            signatures.append(None)
    return dict(_cached_cache_status(bundle_dir, tuple(signatures)))


@lru_cache(maxsize=16)
def _cached_cache_status(bundle_dir: Path, _signatures: tuple) -> dict:
    return _probe_cache(bundle_dir, full=False)


def _probe_cache(bundle_dir: Path, *, full: bool) -> dict:
    bundle_dir = Path(bundle_dir)
    result = {"ready": False, "count": 0, "unavailable_count": 0, "detail": "Article cache has not been prepared."}
    cache = bundle_dir / "utdasset_decrypted.sqlite"
    if not cache.is_file():
        return result
    try:
        with closing(open_readonly(cache)) as c:
            count = c.execute("SELECT count(*) FROM topic_content").fetchone()[0]
            result["count"] = count
            has_unavailable = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='topic_unavailable'").fetchone()
            unavailable = c.execute("SELECT count(*) FROM topic_unavailable").fetchone()[0] if has_unavailable else 0
            result["unavailable_count"] = unavailable
            if not count:
                raise UTDContentError("Article cache is empty; run Prepare UpToDate to repair it.")
            src = bundle_dir / "utdasset.sqlite"
            if src.is_file():
                c.execute("ATTACH DATABASE ? AS encrypted", (src.resolve().as_uri() + "?mode=ro",))
                source_count = c.execute("SELECT count(*) FROM encrypted.topic_asset").fetchone()[0]
                if count + unavailable != source_count:
                    raise UTDContentError("Article cache is incomplete; run Prepare UpToDate to repair it.")
                ids_query = "SELECT id FROM topic_content"
                if has_unavailable:
                    ids_query += " UNION SELECT id FROM topic_unavailable"
                missing = c.execute(f"SELECT id FROM encrypted.topic_asset EXCEPT SELECT id FROM ({ids_query}) LIMIT 1").fetchone()
                if missing:
                    raise UTDContentError("Article cache does not match this bundle; run Prepare UpToDate.")
            if full:
                for row in c.execute("SELECT content FROM topic_content"):
                    decode_topic_content(row[0])
                if c.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise UTDContentError("Article cache failed SQLite integrity checks.")
            else:
                for offset in sorted({0, count // 2, count - 1}):
                    row = c.execute("SELECT content FROM topic_content ORDER BY id LIMIT 1 OFFSET ?", (offset,)).fetchone()
                    decode_topic_content(row[0])
        detail = f"Article cache verified ({count:,} readable topics, {unavailable:,} empty source records)."
        return {"ready": True, "count": count, "unavailable_count": unavailable, "detail": detail}
    except UTDContentError as exc:
        result["detail"] = str(exc)
    except (OSError, sqlite3.Error):
        result["detail"] = "Article cache is unreadable; run Prepare UpToDate to repair it."
    return result


def content_status(bundle_dir: Path) -> dict:
    """Read-only readiness probe, including a real encrypted sample when needed."""
    bundle_dir = Path(bundle_dir)
    cache = cache_status(bundle_dir)
    if cache["ready"]:
        return {"ready": True, "mode": "prepared", "detail": cache["detail"], "cache": cache}
    result = {"ready": False, "mode": "unavailable", "detail": "Encrypted UpToDate bundle is missing or unreadable.", "cache": cache}
    try:
        with closing(open_readonly(bundle_dir / "utdasset.sqlite")) as c:
            key = resolve_key(bundle_dir)
            if key is None:
                result["detail"] = "Set UTD_PASSWORD to this bundle's content key; the download ZIP password is separate."
                return result
            for row in c.execute("SELECT id, payload FROM topic_asset ORDER BY id"):
                try:
                    decrypt_topic(key, row[0], row[1])
                except UTDTopicUnavailable:
                    continue
                result.update(ready=True, mode="encrypted", detail="Articles are ready from the encrypted bundle; preparation is optional.")
                break
            else:
                result["detail"] = "Encrypted UpToDate bundle has no readable topics."
    except UTDContentError as exc:
        result["detail"] = str(exc)
    except (OSError, sqlite3.Error):
        pass
    return result

"""
MedlinePlus Connect client with 7-day SQLite cache.

MedlinePlus Connect is a FREE NIH REST service — no API key required.
It maps ICD-10-CM codes and RxNorm CUIs to consumer-friendly health-topic
summaries from medlineplus.gov.

Reference: https://medlineplus.gov/connect/service.html

Usage:
    from medlineplus import by_icd, by_rxcui, for_term
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx

from config import ROOT

# ── Paths & tuning ─────────────────────────────────────────────────────────
_CACHE_DB  = ROOT / "data" / "medlineplus_cache.sqlite"
_CACHE_TTL = 7 * 24 * 3600   # 7 days in seconds

_BASE_URL  = "https://connect.medlineplus.gov/application"
_PARAMS_ICD = {
    "mainSearchCriteria.v.cs": "2.16.840.1.113883.6.90",  # ICD-10-CM OID
}
_PARAMS_RX = {
    "mainSearchCriteria.v.cs": "2.16.840.1.113883.6.88",  # RxNorm OID
}
_COMMON_PARAMS = {
    "knowledgeResponseType": "application/json",
    "informationRecipient.languageCode.c": "en",
}
_HTTP_TIMEOUT = 3.0   # seconds (was 6s — keep an offline definition lookup snappy)

# Offline circuit breaker (see openfda_reader): trip on a network failure so repeat
# lookups fail fast while offline instead of each waiting out the timeout.
_NET_COOLDOWN = 60.0
_net_down_until = 0.0


def _network_is_down() -> bool:
    return time.time() < _net_down_until


def _trip_network_breaker() -> None:
    global _net_down_until
    _net_down_until = time.time() + _NET_COOLDOWN

# ── Cache bootstrap ─────────────────────────────────────────────────────────

def _cache_conn() -> sqlite3.Connection:
    _CACHE_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(_CACHE_DB), timeout=5)
    con.row_factory = sqlite3.Row
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS mlp_cache (
            key        TEXT PRIMARY KEY,
            fetched_at REAL NOT NULL,
            payload    TEXT NOT NULL
        )
        """
    )
    con.commit()
    return con


def _cache_get(key: str) -> dict[str, Any] | None:
    try:
        con = _cache_conn()
        row = con.execute(
            "SELECT payload, fetched_at FROM mlp_cache WHERE key=?", (key,)
        ).fetchone()
        con.close()
        if not row:
            return None
        age = time.time() - float(row["fetched_at"])
        if age > _CACHE_TTL:
            return None  # stale
        return json.loads(row["payload"])
    except Exception:
        return None


def _cache_set(key: str, payload: dict[str, Any]) -> None:
    try:
        con = _cache_conn()
        con.execute(
            "INSERT OR REPLACE INTO mlp_cache (key, fetched_at, payload) VALUES (?, ?, ?)",
            (key, time.time(), json.dumps(payload, ensure_ascii=False)),
        )
        con.commit()
        con.close()
    except Exception:
        pass   # cache write failure is non-fatal


# ── Response parsing ─────────────────────────────────────────────────────────

def _parse_response(data: Any) -> dict[str, Any] | None:
    """
    Extract the first health-topic entry from a MedlinePlus Connect JSON response.

    Response shape (abbreviated):
      { "feed": { "entry": [ { "title": {"_value": "..."},
                                "summary": {"_value": "..."},
                                "link": [{"@href": "...", "@rel": "alternate"}] } ] } }
    """
    try:
        feed  = data.get("feed") or {}
        total = int((feed.get("total") or {}).get("_value") or 0)
        if total == 0:
            return None
        entries = feed.get("entry") or []
        if not entries:
            return None

        results: list[dict[str, Any]] = []
        for entry in entries:
            title   = (entry.get("title") or {}).get("_value") or ""
            summary = (entry.get("summary") or {}).get("_value") or ""
            url     = ""
            for link in (entry.get("link") or []):
                if link.get("@rel") == "alternate":
                    url = link.get("@href") or ""
                    break

            # Strip HTML tags from summary (MedlinePlus sometimes includes them)
            summary_clean = re.sub(r"<[^>]+>", "", summary).strip()
            if not summary_clean:
                continue

            results.append({
                "title":   title.strip(),
                "summary": summary_clean,
                "url":     url,
                "source":  "MEDLINEPLUS",
                "source_label": "MedlinePlus",
            })

        return {"topics": results, "total": total} if results else None
    except Exception:
        return None


# ── HTTP fetch (with cache) ──────────────────────────────────────────────────

def _fetch(cache_key: str, extra_params: dict[str, str]) -> dict[str, Any] | None:
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    if _network_is_down():
        return None

    params = {**extra_params, **_COMMON_PARAMS}
    try:
        resp = httpx.get(_BASE_URL, params=params, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        raw = resp.json()
    except Exception:
        _trip_network_breaker()
        return None

    parsed = _parse_response(raw)
    if parsed is not None:
        _cache_set(cache_key, parsed)
    else:
        # Cache negative results for 1 day to avoid hammering the API
        _cache_set(cache_key, {"topics": [], "total": 0, "_negative": True})
    return parsed


# ── Public API ───────────────────────────────────────────────────────────────

def by_icd(code: str) -> dict[str, Any] | None:
    """Look up a MedlinePlus health topic by ICD-10-CM code.

    Returns {"topics": [...], "total": N} or None.
    """
    code = (code or "").strip().upper()
    if not code:
        return None
    cache_key = f"icd:{code}"
    return _fetch(
        cache_key,
        {"mainSearchCriteria.v.cs": "2.16.840.1.113883.6.90",
         "mainSearchCriteria.v.c": code,
         **_COMMON_PARAMS},
    )


def by_rxcui(rxcui: str) -> dict[str, Any] | None:
    """Look up a MedlinePlus health topic by RxNorm CUI.

    Returns {"topics": [...], "total": N} or None.
    """
    rxcui = (rxcui or "").strip()
    if not rxcui:
        return None
    cache_key = f"rxcui:{rxcui}"
    return _fetch(
        cache_key,
        {"mainSearchCriteria.v.cs": "2.16.840.1.113883.6.88",
         "mainSearchCriteria.v.c": rxcui,
         **_COMMON_PARAMS},
    )


def for_term(term: str) -> dict[str, Any] | None:
    """High-level lookup: resolve UMLS → ICD-10 or RxNorm → MedlinePlus.

    Tries ICD-10 codes first (diseases), then RxNorm (drugs).
    Returns the first successful result or None.
    """
    if not term:
        return None

    try:
        import umls_reader as _ur
    except ImportError:
        return None

    resolved = _ur.resolve(term)
    if not resolved:
        return None
    cui = resolved["cui"]

    # Try ICD-10-CM first (diseases/conditions)
    icd_codes = _ur.icd10_codes(cui, 3)
    for code_row in icd_codes:
        code = (code_row.get("code") if isinstance(code_row, dict) else str(code_row)).strip()
        if not code:
            continue
        result = by_icd(code)
        if result and result.get("topics"):
            return result

    # Try RxNorm (drugs)
    data = _ur.concept(cui) or resolved
    for code_item in (data.get("codes") or []):
        if (code_item.get("source") or "").upper() == "RXNORM":
            rxcui_val = (code_item.get("code") or "").strip()
            if rxcui_val:
                result = by_rxcui(rxcui_val)
                if result and result.get("topics"):
                    return result

    return None


def first_summary(term: str) -> dict[str, Any] | None:
    """Return the single best MedlinePlus topic for a term, or None.

    Convenience wrapper: returns the first element of topics[], flattened.
    Suitable for injecting into a definitions list.
    """
    result = for_term(term)
    if not result or not result.get("topics"):
        return None
    topic = result["topics"][0]
    return {
        "source":       "MEDLINEPLUS",
        "source_label": "MedlinePlus",
        "text":         topic.get("summary") or "",
        "url":          topic.get("url") or "",
        "title":        topic.get("title") or "",
    }

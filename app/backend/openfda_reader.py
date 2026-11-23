"""
OpenFDA Drug Labels reader — lazy fetch with 30-day SQLite cache.

Uses the FDA Open API (no API key required, public data).
Reference: https://open.fda.gov/apis/drug/label/

Key fields exposed:
  boxed_warning, indications_and_usage, contraindications,
  dosage_and_administration, warnings, adverse_reactions,
  drug_interactions, pregnancy, nursing_mothers,
  pediatric_use, geriatric_use, set_id, brand/generic names
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
_CACHE_DB  = ROOT / "data" / "openfda_labels.sqlite"
_CACHE_TTL = 30 * 24 * 3600   # 30 days
_BASE_URL  = "https://api.fda.gov/drug/label.json"
_HTTP_TIMEOUT = 2.5           # keep a single failed lookup snappy (was 8s)

# Offline circuit breaker: a live fetch that fails on the network (not a real 404)
# trips this for a short window so the remaining lookups in for_drug() — and any
# other drug opened soon after — short-circuit instantly instead of each eating a
# full timeout. This keeps an offline drug open at ~one timeout, not ~5×.
_NET_COOLDOWN = 60.0          # seconds to skip live fetches after a network failure
_net_down_until = 0.0


def _network_is_down() -> bool:
    return time.time() < _net_down_until


def _trip_network_breaker() -> None:
    global _net_down_until
    _net_down_until = time.time() + _NET_COOLDOWN

# OpenFDA keys we want to retain in the normalized payload
_SECTION_KEYS = (
    "boxed_warning",
    "indications_and_usage",
    "contraindications",
    "dosage_and_administration",
    "warnings",
    "adverse_reactions",
    "drug_interactions",
    "pregnancy",
    "pregnancy_or_breast_feeding",
    "nursing_mothers",
    "pediatric_use",
    "geriatric_use",
    "clinical_pharmacology",
    "pharmacokinetics",
    "mechanism_of_action",
    "overdosage",
    "storage_and_handling",
)

# Human-readable section labels for the UI
SECTION_LABELS: dict[str, str] = {
    "boxed_warning":               "⚠ Black Box Warning",
    "indications_and_usage":       "Indications & Usage",
    "contraindications":           "Contraindications",
    "dosage_and_administration":   "Dosage & Administration",
    "warnings":                    "Warnings & Precautions",
    "adverse_reactions":           "Adverse Reactions",
    "drug_interactions":           "Drug Interactions",
    "pregnancy":                   "Pregnancy",
    "pregnancy_or_breast_feeding": "Pregnancy / Breastfeeding",
    "nursing_mothers":             "Nursing Mothers",
    "pediatric_use":               "Pediatric Use",
    "geriatric_use":               "Geriatric Use",
    "clinical_pharmacology":       "Clinical Pharmacology",
    "pharmacokinetics":            "Pharmacokinetics",
    "mechanism_of_action":         "Mechanism of Action",
    "overdosage":                  "Overdosage",
    "storage_and_handling":        "Storage & Handling",
}


# ── Cache bootstrap ─────────────────────────────────────────────────────────

def _cache_conn() -> sqlite3.Connection:
    _CACHE_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(_CACHE_DB), timeout=5)
    con.row_factory = sqlite3.Row
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS openfda_labels (
            drug_key   TEXT PRIMARY KEY,
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
            "SELECT payload, fetched_at FROM openfda_labels WHERE drug_key=?", (key,)
        ).fetchone()
        con.close()
        if not row:
            return None
        age = time.time() - float(row["fetched_at"])
        if age > _CACHE_TTL:
            return None
        payload = json.loads(row["payload"])
        if payload.get("_negative"):
            return None   # cached negative — no result from OpenFDA
        return payload
    except Exception:
        return None


def _cache_set(key: str, payload: dict[str, Any]) -> None:
    try:
        con = _cache_conn()
        con.execute(
            "INSERT OR REPLACE INTO openfda_labels (drug_key, fetched_at, payload) VALUES (?, ?, ?)",
            (key, time.time(), json.dumps(payload, ensure_ascii=False)),
        )
        con.commit()
        con.close()
    except Exception:
        pass


# ── Response normaliser ─────────────────────────────────────────────────────

def _pick(raw: dict, *keys: str) -> str:
    """Return first non-empty value from `raw` for the given keys (supports arrays)."""
    for key in keys:
        val = raw.get(key)
        if isinstance(val, list) and val:
            return val[0]
        if isinstance(val, str) and val:
            return val
    return ""


def _parse_result(result: dict) -> dict[str, Any]:
    """Normalise one FDA label result dict into a clean payload."""
    openfda = result.get("openfda") or {}

    brand_names  = openfda.get("brand_name") or []
    generic_names = openfda.get("generic_name") or []
    manufacturers = openfda.get("manufacturer_name") or []
    rxcuis = openfda.get("rxcui") or []
    ndcs   = (openfda.get("product_ndc") or [])[:6]

    set_id = result.get("set_id") or ""
    doc_id = result.get("id") or ""

    sections: list[dict[str, str]] = []
    for key in _SECTION_KEYS:
        raw_val = result.get(key)
        text = ""
        if isinstance(raw_val, list):
            text = "\n\n".join(v.strip() for v in raw_val if v and v.strip())
        elif isinstance(raw_val, str):
            text = raw_val.strip()
        if text:
            sections.append({
                "key":   key,
                "label": SECTION_LABELS.get(key, key.replace("_", " ").title()),
                "text":  text,
            })

    has_bbw = bool(result.get("boxed_warning"))

    return {
        "set_id":        set_id,
        "doc_id":        doc_id,
        "brand_names":   brand_names[:6],
        "generic_names": generic_names[:4],
        "manufacturer":  manufacturers[0] if manufacturers else "",
        "rxcuis":        rxcuis[:4],
        "ndcs":          ndcs,
        "has_black_box": has_bbw,
        "sections":      sections,
        "fda_url":       f"https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid={set_id}" if set_id else "",
    }


# ── HTTP fetch ───────────────────────────────────────────────────────────────

def _fetch_by_search(query: str, cache_key: str) -> dict[str, Any] | None:
    """Fetch OpenFDA label by `search` query; cache the result."""
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Recent network failure → don't stall on another doomed live call.
    if _network_is_down():
        return None

    try:
        resp = httpx.get(
            _BASE_URL,
            params={"search": query, "limit": 1},
            timeout=_HTTP_TIMEOUT,
        )
        if resp.status_code == 404:
            _cache_set(cache_key, {"_negative": True})
            return None
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        # Network/timeout failure (not a real 404): trip the breaker so the rest of
        # this drug's lookups — and nearby drug opens — fail fast while offline.
        _trip_network_breaker()
        return None

    results = data.get("results") or []
    if not results:
        _cache_set(cache_key, {"_negative": True})
        return None

    payload = _parse_result(results[0])
    _cache_set(cache_key, payload)
    return payload


# ── Public API ────────────────────────────────────────────────────────────────

def _norm_key(name: str) -> str:
    """Normalise a drug name to a stable cache key."""
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def by_rxcui(rxcui: str) -> dict[str, Any] | None:
    """Look up an FDA label by RxNorm CUI (most reliable match)."""
    rxcui = (rxcui or "").strip()
    if not rxcui:
        return None
    cache_key = f"rxcui:{rxcui}"
    return _fetch_by_search(f'openfda.rxcui:"{rxcui}"', cache_key)


def by_generic_name(name: str) -> dict[str, Any] | None:
    """Look up an FDA label by generic name (case-insensitive)."""
    nk = _norm_key(name)
    if not nk:
        return None
    cache_key = f"generic:{nk}"
    return _fetch_by_search(f'openfda.generic_name:"{nk}"', cache_key)


def by_brand_name(name: str) -> dict[str, Any] | None:
    """Look up an FDA label by brand/trade name."""
    nk = _norm_key(name)
    if not nk:
        return None
    cache_key = f"brand:{nk}"
    return _fetch_by_search(f'openfda.brand_name:"{nk}"', cache_key)


def for_drug(
    generic_name: str,
    rxcui: str | None = None,
    brand_names: list[str] | None = None,
) -> dict[str, Any] | None:
    """High-level lookup: try RxCUI → generic name → first brand name in order.

    Returns the normalised FDA label payload or None.
    """
    # 1. RxCUI is most specific
    if rxcui:
        result = by_rxcui(rxcui)
        if result:
            return result

    # 2. Generic name
    if generic_name:
        result = by_generic_name(generic_name)
        if result:
            return result

    # 3. Brand names (try each)
    for bn in (brand_names or [])[:3]:
        if bn:
            result = by_brand_name(bn)
            if result:
                return result

    return None

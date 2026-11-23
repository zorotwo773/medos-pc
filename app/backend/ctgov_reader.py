"""
ClinicalTrials.gov REST API v2 client — lazy fetch with 24-hour SQLite cache.

No API key required. Official API: https://clinicaltrials.gov/data-api/api

Lookup strategies supported:
  - by_condition(name)  — query.cond, returns active/recruiting studies
  - by_cui(cui)         — resolves UMLS → ICD-10 / preferred name → by_condition
  - by_drug(name)       — query.intr (intervention)
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from typing import Any

import httpx

from config import ROOT

# ── Config ──────────────────────────────────────────────────────────────────
_CACHE_DB  = ROOT / "data" / "ctgov_cache.sqlite"
_CACHE_TTL = 24 * 3600   # 24 hours
_BASE_URL  = "https://clinicaltrials.gov/api/v2/studies"
_HTTP_TIMEOUT = 3.0      # was 8s — keep an offline concept page from stalling
_DEFAULT_PAGE_SIZE = 10
_MAX_PAGE_SIZE     = 20

# Offline circuit breaker (see openfda_reader): a network failure trips this so
# subsequent concept-page trial lookups fail fast instead of each eating a timeout.
_NET_COOLDOWN = 60.0
_net_down_until = 0.0


def _network_is_down() -> bool:
    return time.time() < _net_down_until


def _trip_network_breaker() -> None:
    global _net_down_until
    _net_down_until = time.time() + _NET_COOLDOWN

# Status categories displayed to the user
_ACTIVE_STATUSES = {
    "RECRUITING",
    "ACTIVE_NOT_RECRUITING",
    "ENROLLING_BY_INVITATION",
    "NOT_YET_RECRUITING",
}
_COMPLETED_STATUSES = {"COMPLETED", "TERMINATED", "WITHDRAWN", "SUSPENDED"}


# ── Cache bootstrap ─────────────────────────────────────────────────────────

def _cache_conn() -> sqlite3.Connection:
    _CACHE_DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(_CACHE_DB), timeout=5)
    con.row_factory = sqlite3.Row
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS ctgov_cache (
            cache_key  TEXT PRIMARY KEY,
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
            "SELECT payload, fetched_at FROM ctgov_cache WHERE cache_key=?", (key,)
        ).fetchone()
        con.close()
        if not row:
            return None
        age = time.time() - float(row["fetched_at"])
        if age > _CACHE_TTL:
            return None
        return json.loads(row["payload"])
    except Exception:
        return None


def _cache_set(key: str, payload: dict[str, Any]) -> None:
    try:
        con = _cache_conn()
        con.execute(
            "INSERT OR REPLACE INTO ctgov_cache (cache_key, fetched_at, payload) VALUES (?, ?, ?)",
            (key, time.time(), json.dumps(payload, ensure_ascii=False)),
        )
        con.commit()
        con.close()
    except Exception:
        pass


# ── Response normaliser ─────────────────────────────────────────────────────

def _norm_study(study: dict) -> dict[str, Any]:
    proto = study.get("protocolSection") or {}
    id_mod     = proto.get("identificationModule") or {}
    status_mod = proto.get("statusModule") or {}
    cond_mod   = proto.get("conditionsModule") or {}
    design_mod = proto.get("designModule") or {}
    desc_mod   = proto.get("descriptionModule") or {}

    nct_id = id_mod.get("nctId") or ""
    title  = id_mod.get("briefTitle") or id_mod.get("officialTitle") or nct_id
    status = (status_mod.get("overallStatus") or "").upper()
    phases = design_mod.get("phases") or []
    phase_str = ", ".join(
        p.replace("PHASE", "Phase ").replace("_", " ").strip()
        for p in phases if p and p not in ("NA", "N_A")
    )

    enroll_info = design_mod.get("enrollmentInfo") or {}
    enrollment  = enroll_info.get("count")

    start_date  = (status_mod.get("startDateStruct") or {}).get("date") or ""
    conditions  = cond_mod.get("conditions") or []
    brief_summary = (desc_mod.get("briefSummary") or "")[:300]

    return {
        "nct_id":      nct_id,
        "title":       title,
        "status":      status,
        "phase":       phase_str,
        "enrollment":  enrollment,
        "start_date":  start_date,
        "conditions":  conditions[:5],
        "summary":     brief_summary,
        "url":         f"https://clinicaltrials.gov/study/{nct_id}" if nct_id else "",
        "is_recruiting": status in _ACTIVE_STATUSES,
    }


# ── Fetch helpers ────────────────────────────────────────────────────────────

def _fetch(cache_key: str, params: dict[str, Any]) -> dict[str, Any]:
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Recent network failure → return the error payload immediately, no stall.
    if _network_is_down():
        return {"studies": [], "total_count": 0, "recruiting_count": 0, "_error": True}

    try:
        resp = httpx.get(_BASE_URL, params=params, timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        _trip_network_breaker()
        return {"studies": [], "total_count": 0, "recruiting_count": 0, "_error": True}

    raw_studies = data.get("studies") or []
    total_count = data.get("totalCount") or 0
    studies = [_norm_study(s) for s in raw_studies if s]
    recruiting = sum(1 for s in studies if s["is_recruiting"])

    payload = {
        "studies":          studies,
        "total_count":      total_count,
        "recruiting_count": recruiting,
    }
    _cache_set(cache_key, payload)
    return payload


# ── Public API ────────────────────────────────────────────────────────────────

def by_condition(
    condition: str,
    limit: int = _DEFAULT_PAGE_SIZE,
    recruiting_only: bool = False,
) -> dict[str, Any]:
    """Return clinical trials matching a disease/condition name.

    Returns {"studies": [...], "total_count": N, "recruiting_count": N}.
    """
    condition = (condition or "").strip()
    if not condition:
        return {"studies": [], "total_count": 0, "recruiting_count": 0}
    limit = max(1, min(limit, _MAX_PAGE_SIZE))
    key = f"cond:{condition.lower()}:lim{limit}:rec{int(recruiting_only)}"
    params: dict[str, Any] = {
        "query.cond": condition,
        "pageSize":   limit,
        "fields":     "NCTId,BriefTitle,OfficialTitle,OverallStatus,Phase,EnrollmentCount,StartDate,Condition,BriefSummary",
    }
    if recruiting_only:
        params["filter.overallStatus"] = "RECRUITING"
    return _fetch(key, params)


def by_drug(
    drug_name: str,
    limit: int = _DEFAULT_PAGE_SIZE,
    recruiting_only: bool = False,
) -> dict[str, Any]:
    """Return clinical trials where a drug is listed as an intervention."""
    drug_name = (drug_name or "").strip()
    if not drug_name:
        return {"studies": [], "total_count": 0, "recruiting_count": 0}
    limit = max(1, min(limit, _MAX_PAGE_SIZE))
    key = f"drug:{drug_name.lower()}:lim{limit}:rec{int(recruiting_only)}"
    params: dict[str, Any] = {
        "query.intr": drug_name,
        "pageSize":   limit,
        "fields":     "NCTId,BriefTitle,OfficialTitle,OverallStatus,Phase,EnrollmentCount,StartDate,Condition,BriefSummary",
    }
    if recruiting_only:
        params["filter.overallStatus"] = "RECRUITING"
    return _fetch(key, params)


def by_cui(cui: str, limit: int = _DEFAULT_PAGE_SIZE) -> dict[str, Any]:
    """Look up trials by UMLS CUI — resolves CUI → preferred name → by_condition."""
    cui = (cui or "").strip().upper()
    if not re.fullmatch(r"C\d{7}", cui):
        return {"studies": [], "total_count": 0, "recruiting_count": 0}
    try:
        import umls_reader as _ur
        concept = _ur.concept(cui)
        preferred_name = (concept or {}).get("preferred_name") or ""
    except Exception:
        preferred_name = ""
    if not preferred_name:
        return {"studies": [], "total_count": 0, "recruiting_count": 0}
    return by_condition(preferred_name, limit=limit)

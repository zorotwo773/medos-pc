"""
ClinicalTrials.gov router — lazy REST lookup with 24-hour cache.

Endpoints:
  GET /trials/by-condition       — search by disease/condition name
  GET /trials/by-drug            — search by intervention (drug name)
  GET /trials/by-cui/{cui}       — resolve UMLS CUI → condition name → trials
"""
from __future__ import annotations

from fastapi import APIRouter, Query

import ctgov_reader as _ct

router = APIRouter(prefix="/trials", tags=["trials"])


@router.get("/by-condition")
def trials_by_condition(
    condition: str = Query(..., min_length=2, max_length=200),
    limit:     int  = Query(default=10, ge=1, le=20),
    recruiting_only: bool = Query(False, description="Only return actively recruiting studies"),
):
    """Return clinical trials for a disease/condition. Cached 24 hours."""
    return _ct.by_condition(condition, limit=limit, recruiting_only=recruiting_only)


@router.get("/by-drug")
def trials_by_drug(
    drug:  str = Query(..., min_length=2, max_length=200),
    limit: int = Query(default=10, ge=1, le=20),
    recruiting_only: bool = Query(False),
):
    """Return clinical trials where a drug is the primary intervention. Cached 24 hours."""
    return _ct.by_drug(drug, limit=limit, recruiting_only=recruiting_only)


@router.get("/by-cui/{cui}")
def trials_by_cui(
    cui:   str,
    limit: int = Query(default=10, ge=1, le=20),
):
    """Resolve a UMLS CUI to its preferred name, then search ClinicalTrials.gov. Cached 24 hours."""
    return _ct.by_cui(cui, limit=limit)

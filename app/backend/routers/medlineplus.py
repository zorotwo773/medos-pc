"""
MedlinePlus Connect router.

Endpoints:
  GET /medlineplus/by-icd/{code}     — look up by ICD-10-CM code
  GET /medlineplus/by-rxcui/{rxcui}  — look up by RxNorm CUI
  GET /medlineplus/for-term          — resolve UMLS → ICD/RxNorm → MedlinePlus
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import medlineplus as _mlp

router = APIRouter(prefix="/medlineplus", tags=["medlineplus"])


@router.get("/by-icd/{code}")
def mlp_by_icd(code: str):
    """Return MedlinePlus health topic(s) for an ICD-10-CM code.

    Cached 7 days. Returns 404 if no topic found.
    """
    result = _mlp.by_icd(code)
    if not result or not result.get("topics"):
        raise HTTPException(status_code=404, detail=f"No MedlinePlus topic for ICD-10 code '{code}'")
    return result


@router.get("/by-rxcui/{rxcui}")
def mlp_by_rxcui(rxcui: str):
    """Return MedlinePlus health topic(s) for an RxNorm CUI.

    Cached 7 days. Returns 404 if no topic found.
    """
    result = _mlp.by_rxcui(rxcui)
    if not result or not result.get("topics"):
        raise HTTPException(status_code=404, detail=f"No MedlinePlus topic for RxNorm CUI '{rxcui}'")
    return result


@router.get("/for-term")
def mlp_for_term(
    term: str = Query(..., min_length=1, max_length=200),
):
    """Resolve a medical term → UMLS → ICD-10 / RxNorm → MedlinePlus topics.

    Returns the full topics payload or 404.
    """
    result = _mlp.for_term(term)
    if not result or not result.get("topics"):
        raise HTTPException(status_code=404, detail=f"No MedlinePlus topic for term '{term}'")
    return result

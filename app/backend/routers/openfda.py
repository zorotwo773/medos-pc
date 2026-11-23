"""
OpenFDA Drug Labels router.

Endpoints:
  GET /openfda/by-rxcui/{rxcui}          — label by RxNorm CUI
  GET /openfda/by-generic/{name}         — label by generic name
  GET /openfda/for-drug                  — high-level: try rxcui → generic → brand
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
import openfda_reader as _fda

router = APIRouter(prefix="/openfda", tags=["openfda"])


@router.get("/by-rxcui/{rxcui}")
def fda_by_rxcui(rxcui: str):
    """Return FDA structured product label for an RxNorm CUI. Cached 30 days."""
    result = _fda.by_rxcui(rxcui)
    if not result:
        raise HTTPException(404, detail=f"No FDA label for RxNorm CUI '{rxcui}'")
    return result


@router.get("/by-generic/{name}")
def fda_by_generic(name: str):
    """Return FDA structured product label by generic name. Cached 30 days."""
    result = _fda.by_generic_name(name)
    if not result:
        raise HTTPException(404, detail=f"No FDA label found for '{name}'")
    return result


@router.get("/for-drug")
def fda_for_drug(
    generic_name: str  = Query(""),
    rxcui:        str  = Query(""),
    brand_names:  str  = Query("", description="Comma-separated brand names"),
):
    """High-level FDA label lookup: tries RxCUI → generic → brands in order."""
    brands = [b.strip() for b in brand_names.split(",") if b.strip()]
    result = _fda.for_drug(
        generic_name=generic_name,
        rxcui=rxcui or None,
        brand_names=brands,
    )
    if not result:
        raise HTTPException(
            404,
            detail=f"No FDA label found for generic='{generic_name}' rxcui='{rxcui}'",
        )
    return result

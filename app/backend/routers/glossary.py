"""
Glossary router — hover-to-define tooltip endpoint.

Data source: glossary.db (built by scripts/glossary/build_glossary.py).
Lookup is case-insensitive and exact-match on `term`.
SESLHDPR rows take precedence in tie-breaks (source_rank = 0).
"""
from __future__ import annotations

import re
import sqlite3
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from config import GLOBAL_SEARCH_DB as _GLOBAL_SEARCH_DB, GLOSSARY_DB, ROOT
import umls_reader
import medlineplus as _mlp

router = APIRouter(prefix="/glossary", tags=["glossary"])
_SOURCE_REF_ORDER = {"amboss": 0, "uworld": 1}


def _conn() -> sqlite3.Connection:
    if not GLOSSARY_DB.exists():
        raise HTTPException(status_code=503, detail="Glossary DB not built yet. Run scripts/glossary/build_glossary.py")
    c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _normalize(text: str) -> str:
    value = (text or "").lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _source_refs_for_terms(*terms: str) -> list[dict]:
    keys = []
    for term in terms:
        key = _normalize(term)
        if key and key not in keys:
            keys.append(key)
    if not keys or not _GLOBAL_SEARCH_DB.exists():
        return []

    placeholders = ",".join("?" for _ in keys)
    try:
        c = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                f"""
                SELECT source, kind, external_id, title, subtitle, href, weight
                FROM entries
                WHERE title_norm IN ({placeholders})
                  AND source IN ('amboss', 'uworld')
                ORDER BY
                  CASE source WHEN 'amboss' THEN 0 WHEN 'uworld' THEN 1 ELSE 9 END,
                  CASE kind WHEN 'article' THEN 0 ELSE 1 END,
                  weight DESC,
                  length(title)
                """,
                tuple(keys),
            ).fetchall()
        finally:
            c.close()
    except sqlite3.Error:
        return []

    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        source = str(row["source"] or "")
        if source in seen:
            continue
        seen.add(source)
        out.append({
            "source": source,
            "label": "AMBOSS" if source == "amboss" else "UWorld",
            "kind": row["kind"] or "article",
            "id": row["external_id"] or "",
            "title": row["title"] or "",
            "subtitle": row["subtitle"] or "",
            "href": row["href"] or "",
        })
    out.sort(key=lambda item: _SOURCE_REF_ORDER.get(str(item.get("source") or ""), 9))
    return out


@router.get("/lookup")
def glossary_lookup(
    term: str = Query(..., min_length=1, max_length=120),
    lay: bool = Query(False, description="Prefer lay-language definitions (MedlinePlus, CHV) over clinical sources"),
):
    """
    Look up a medical term / abbreviation.

    Returns the top match with:
      - term (normalized)
      - expansion (full form for abbreviations)
      - definition (1–2 sentence explanation)
      - source ('SESLHDPR' | 'amboss' | 'utd' | 'umls')
      - source_id (article ID in the originating database, if any)
      - umls (optional, present when term resolves to a UMLS concept): rich block
        with definitions[], synonyms[], icd10cm_codes[], snomed_codes[], rxnorm_codes[],
        loinc_codes[], related[], mention_count
    """
    try:
        c = _conn()
    except HTTPException:
        raise
    try:
        row = c.execute(
            """
            SELECT term, expansion, definition, source, source_id
            FROM glossary
            WHERE lower(term) = lower(?)
            ORDER BY source_rank ASC, CASE lower(source) WHEN 'seslhdpr' THEN 0 ELSE 1 END
            LIMIT 1
            """,
            (term.strip(),),
        ).fetchone()
    finally:
        c.close()

    umls_block = umls_reader.tooltip_payload(term, prefer_lay=lay)

    # When patient/lay mode is requested, inject a real MedlinePlus summary as
    # the first definition in the UMLS block (overrides the UMLS-internal NCI
    # reordering with a genuine consumer-friendly explanation).
    if lay and umls_block:
        mlp = _mlp.first_summary(term)
        if mlp and mlp.get("text"):
            existing = umls_block.get("definitions") or []
            # Deduplicate: don't prepend if a MEDLINEPLUS entry already exists
            if not any(
                (d.get("source") or "").upper() == "MEDLINEPLUS" for d in existing
            ):
                umls_block["definitions"] = [
                    {
                        "source":       "MEDLINEPLUS",
                        "source_label": "MedlinePlus",
                        "text":         mlp["text"],
                        "url":          mlp.get("url") or "",
                    },
                    *existing,
                ]
            umls_block["medlineplus_url"] = mlp.get("url") or ""
            umls_block["medlineplus_title"] = mlp.get("title") or ""

    if not row:
        fallback = umls_reader.definition_chip(term)
        if fallback:
            if umls_block:
                fallback["umls"] = umls_block
            source_refs = _source_refs_for_terms(term, fallback.get("term") or "", fallback.get("expansion") or "")
            if source_refs:
                fallback["source_refs"] = source_refs
            return fallback
        raise HTTPException(status_code=404, detail=f"Term '{term}' not found in glossary")

    payload = dict(row)
    source_refs = _source_refs_for_terms(term, payload.get("term") or "", payload.get("expansion") or "")
    if source_refs:
        payload["source_refs"] = source_refs
    if umls_block:
        payload["umls"] = umls_block
    return payload


@router.get("/search")
def glossary_search(q: str = Query(..., min_length=1, max_length=120), limit: int = Query(10, ge=1, le=50)):
    """Prefix search across all glossary terms (for auto-complete)."""
    try:
        c = _conn()
    except HTTPException:
        raise
    try:
        rows = c.execute(
            """
            SELECT term, expansion, definition, source, source_id
            FROM glossary
            WHERE lower(term) LIKE lower(?)
            ORDER BY source_rank ASC, CASE lower(source) WHEN 'seslhdpr' THEN 0 ELSE 1 END, length(term) ASC
            LIMIT ?
            """,
            (f"{q.strip()}%", limit),
        ).fetchall()
    finally:
        c.close()

    results = [dict(r) for r in rows]
    if len(results) < limit:
        seen = {str(item.get("term") or "").lower() for item in results}
        for item in umls_reader.search(q, limit=limit - len(results)):
            term = item.get("preferred_name") or item.get("matched_term") or ""
            key = term.lower()
            if not term or key in seen:
                continue
            seen.add(key)
            results.append({
                "term": term,
                "expansion": item.get("preferred_name") or term,
                "definition": item.get("definition") or "",
                "source": "umls",
                "source_id": item.get("cui") or "",
                "semantic_group": item.get("semantic_group") or "",
            })
            if len(results) >= limit:
                break

    return {"results": results}


@router.get("/stats")
def glossary_stats():
    """Return row count and source breakdown."""
    if not GLOSSARY_DB.exists():
        return {"total": 0, "sources": {}, "built": False}
    c = sqlite3.connect(f"file:{GLOSSARY_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    try:
        total = c.execute("SELECT count(*) AS n FROM glossary").fetchone()["n"]
        by_source = c.execute(
            "SELECT source, count(*) AS n FROM glossary GROUP BY source ORDER BY n DESC"
        ).fetchall()
    finally:
        c.close()
    return {
        "total": total,
        "sources": {r["source"]: r["n"] for r in by_source},
        "umls_built": umls_reader.enabled(),
        "built": True,
    }

from __future__ import annotations

import sqlite3
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import umls_reader
import loinc_panels
from config import GLOBAL_SEARCH_DB as _GLOBAL_SEARCH_DB, ROOT, UMLS_DB, UMLS_META_DIR


router = APIRouter(prefix="/umls", tags=["umls"])

_PARAGRAPH_CONCEPTS_DB = ROOT / "data" / "paragraph_concepts.sqlite"


class PhenotypeRequest(BaseModel):
    phenotypes: list[str] = Field(default_factory=list, max_length=24)


@router.get("/status")
def status():
    return {
        "built": umls_reader.enabled(),
        "full": umls_reader.is_full(),
        "db": umls_reader.active_db_path() or str(UMLS_DB),
        "meta_dir": str(UMLS_META_DIR),
        "meta_dir_exists": UMLS_META_DIR.exists(),
        "meta": umls_reader.metadata(),
    }


@router.get("/search")
def search(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(default=20, ge=1, le=80),
    source: str | None = Query(default=None, max_length=40),
    semantic_group: str | None = Query(default=None, max_length=40),
):
    return {
        "query": q,
        "results": list(umls_reader.search(q, limit=limit, source=source, semantic_group=semantic_group)),
        "built": umls_reader.enabled(),
    }


@router.get("/resolve")
def resolve(q: str = Query(..., min_length=1, max_length=200)):
    result = umls_reader.resolve(q)
    if not result:
        raise HTTPException(404, "UMLS concept not found")
    return result


@router.get("/autocomplete")
def autocomplete(q: str = Query(..., min_length=1, max_length=120), limit: int = Query(default=8, ge=1, le=20)):
    """Type-ahead concept suggestions: prefix/clinical-ranked matches, with
    abbreviation expansions (e.g. 'PE' → Pulmonary embolism) prepended for short
    queries via the global_search abbr_suggestions table resolved to concepts."""
    key = (q or "").strip()
    sugs = umls_reader.autocomplete(key, limit=limit)
    kl = key.lower()
    _CLIN = {"disease", "finding", "pathology", "drug", "procedure", "anatomy"}
    top_ok = bool(sugs) and (sugs[0].get("semantic_group", "") or "").lower() in _CLIN
    # Only fall back to the abbreviation table when the ranked match is weak/non-clinical
    # (e.g. "PE", which UMLS only has as gene aliases). Resolve each expansion through
    # the smart autocomplete so plural/variant forms still map (Pulmonary emboli → ‑ism).
    if 2 <= len(kl) <= 6 and not top_ok and _GLOBAL_SEARCH_DB.exists():
        try:
            gs = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True, timeout=2)
            gs.row_factory = sqlite3.Row
            rows = gs.execute(
                "SELECT expansion, MAX(weight) AS w FROM abbr_suggestions "
                "WHERE abbr_norm=? GROUP BY expansion_norm ORDER BY w DESC LIMIT 8",
                (kl,),
            ).fetchall()
            gs.close()
            seen = {s["cui"] for s in sugs}
            expansions: list[dict] = []
            for r in rows:
                exp = umls_reader.autocomplete(r["expansion"], limit=1)
                if exp and exp[0]["cui"] not in seen:
                    seen.add(exp[0]["cui"])
                    expansions.append(exp[0])
            if expansions:
                sugs = (expansions + sugs)[:limit]
        except Exception:
            pass
    return {"query": q, "suggestions": sugs}


@router.get("/context")
def context(q: str = Query(..., min_length=1, max_length=240)):
    result = umls_reader.concept_context(q)
    if not result:
        raise HTTPException(404, "UMLS concept context not found")
    return result


@router.get("/expand")
def expand(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(default=8, ge=1, le=20)):
    concept = umls_reader.resolve(q)
    return {
        "query": q,
        "concept": concept,
        "variants": list(umls_reader.query_variants(q, limit=limit)),
        "built": umls_reader.enabled(),
    }


@router.get("/concept/{cui}")
def concept(cui: str):
    result = umls_reader.concept(cui)
    if not result:
        raise HTTPException(404, "UMLS concept not found")
    return result


@router.get("/concept/{cui}/mimics")
def concept_mimics(cui: str, limit: int = Query(default=6, ge=1, le=20)):
    """Return phenotypically-similar diseases (IC-weighted Jaccard on HPO sets).

    Only available for disease/pathology concepts that have HPO phenotype links.
    Returns an empty list when the HPO disease-link table has no entry for this CUI.
    """
    results = umls_reader.disease_mimics(cui, limit=limit)
    return {
        "cui": cui.upper(),
        "mimics": list(results),
        "count": len(results),
    }


def _concept_terms(cui: str, max_terms: int = 24) -> list[str]:
    try:
        c = umls_reader.concept(cui)
    except Exception:
        c = None
    if not c:
        return []
    out: list[str] = []
    if c.get("preferred_name"):
        out.append(c["preferred_name"])
    for t in (c.get("terms") or []):
        term = t.get("term")
        if term:
            out.append(term)
        if len(out) >= max_terms:
            break
    return out


def _tagged_ids(cui: str, source: str, n: int) -> list[str]:
    """Top-N article ids of `source` tagged to this concept (by mention frequency)."""
    if not _PARAGRAPH_CONCEPTS_DB.exists():
        return []
    try:
        pc = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True, timeout=2)
        pc.row_factory = sqlite3.Row
        try:
            rows = pc.execute(
                "SELECT source_id, MAX(hit_count) AS hc FROM paragraph_concepts "
                "WHERE cui=? AND source=? GROUP BY source_id ORDER BY hc DESC LIMIT ?",
                (cui, source, n),
            ).fetchall()
        finally:
            pc.close()
        return [r["source_id"] for r in rows]
    except sqlite3.Error:
        return []


@lru_cache(maxsize=1)
def _media_entries_map() -> dict[tuple[str, str], tuple[str, str, str]]:
    """One-time map of every media-kind global_search entry → (title, href, kind).
    Avoids joining paragraph_concepts↔entries on the un-indexed external_id (which
    was a full 140k-row scan per row, ~10s). Built once, then lookups are O(1)."""
    out: dict[tuple[str, str], tuple[str, str, str]] = {}
    if not _GLOBAL_SEARCH_DB.exists():
        return out
    try:
        gs = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True, timeout=5)
        gs.row_factory = sqlite3.Row
        try:
            rows = gs.execute(
                "SELECT source, external_id, title, href, kind FROM entries "
                "WHERE kind IN ('clinic_image', 'uworld_table')"
            ).fetchall()
        finally:
            gs.close()
        for r in rows:
            out[(r["source"], str(r["external_id"]))] = (r["title"] or "", r["href"] or "", r["kind"])
    except sqlite3.Error:
        pass
    return out


_MEDIA_CACHE: dict[str, list[dict]] = {}


def _gather_media(cui: str) -> list[dict]:
    """Aggregate renderable media for a concept from every source: tagged clinical
    images + UWorld exhibit tables, UpToDate graphics (by the concept's terms), and
    the figures embedded INSIDE the UWorld-library / AMBOSS articles tagged to it.
    Cached per CUI (the extraction decrypts articles, so it isn't free)."""
    if cui in _MEDIA_CACHE:
        return _MEDIA_CACHE[cui]
    items: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(source: str, source_id, title: str, href: str, kind: str, media_type: str, **extra) -> None:
        if not href:
            return
        key = (source, href)
        if key in seen:
            return
        seen.add(key)
        item = {"source": source, "source_id": str(source_id), "title": title or "",
                "href": href, "kind": kind, "media_type": media_type}
        item.update({k: v for k, v in extra.items() if v})
        items.append(item)

    # 1. Tagged clinical images + UWorld exhibit tables — look the concept's tagged
    #    ids up against the cached media map (no slow external_id join).
    media_map = _media_entries_map()
    if media_map and _PARAGRAPH_CONCEPTS_DB.exists():
        try:
            pc = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True, timeout=2)
            pc.row_factory = sqlite3.Row
            try:
                rows = pc.execute(
                    "SELECT source, source_id, MAX(hit_count) AS hc FROM paragraph_concepts "
                    "WHERE cui=? GROUP BY source, source_id ORDER BY hc DESC",
                    (cui,),
                ).fetchall()
            finally:
                pc.close()
            for r in rows:
                hit = media_map.get((r["source"], str(r["source_id"])))
                if hit:
                    title, href, kind = hit
                    add(r["source"], r["source_id"], title, href, kind,
                        "image" if kind == "clinic_image" else "exhibit")
        except sqlite3.Error:
            pass

    # 2. UpToDate graphics matching the concept's terms.
    try:
        import utd_reader
        for g in utd_reader.graphics_for_terms(_concept_terms(cui), limit=18):
            add("utd", g["id"], g["title"], g["url"], "graphic", "image",
                preview_href=g.get("thumb_url"), source_href=g.get("source_href"))
    except Exception:
        pass

    # 3. Figures embedded inside the UWorld-library articles tagged to the concept.
    try:
        import uworld_library_reader
        for doc_id in _tagged_ids(cui, "uworld", 6):
            try:
                for im in uworld_library_reader.article_images(int(doc_id), 8):
                    add("uworld", im["name"], im["title"], im["url"], "image", "image",
                        source_href=f"/library/uworld?doc={int(doc_id)}")
            except (ValueError, TypeError):
                continue
    except Exception:
        pass

    # 4. Figures embedded inside the AMBOSS learning cards tagged to the concept.
    try:
        import amboss_reader
        for doc_id in _tagged_ids(cui, "amboss", 5):
            try:
                for im in amboss_reader.card_images(int(doc_id), 8):
                    add("amboss", im["name"], im["title"], im["url"], "image", "image",
                        source_href=f"/amboss?doc={int(doc_id)}")
            except (ValueError, TypeError):
                continue
    except Exception:
        pass

    if len(_MEDIA_CACHE) > 400:
        _MEDIA_CACHE.clear()
    _MEDIA_CACHE[cui] = items
    return items


@router.get("/concept/{cui}/media")
def concept_media(cui: str, limit: int = Query(default=90, ge=1, le=200)):
    """Renderable visual content for a concept, pulled from every source — clinical
    images, UpToDate graphics, UWorld-library & AMBOSS in-article figures, and
    UWorld exhibit tables. media_type 'image' (<img>) or 'exhibit' (HTML/iframe).
    Images first so the wall leads with diagrams."""
    value = (cui or "").strip().upper()
    import re as _re
    if not _re.fullmatch(r"C\d{7}", value):
        raise HTTPException(400, "Invalid CUI format")
    items = list(_gather_media(value))
    items.sort(key=lambda x: 0 if x["media_type"] == "image" else 1)  # diagrams first, tables after
    return {"cui": value, "items": items[:limit], "total": len(items)}


@router.get("/concept/{cui}/causal-graph")
def concept_causal_graph(
    cui: str,
    depth: int = Query(default=1, ge=1, le=2, description="Graph depth: 1=direct, 2=two-hop"),
    limit: int = Query(default=12, ge=1, le=24),
):
    """Return a causal/conceptual neighbour graph for the concept walk view.

    Nodes: the query concept + up to `limit` related concepts.
    Edges: directed UMLS relations (cause_of, manifestation_of, induces, isa, etc.)

    Returns:
      { nodes: [{cui, preferred_name, semantic_group, href}],
        edges: [{source_cui, target_cui, rela, label}],
        center_cui: str }
    """
    _CAUSAL_RELA = {
        "cause_of", "has_causative_agent", "causative_agent_of",
        "manifestation_of", "has_manifestation",
        "induces", "induced_by",
        "isa", "inverse_isa",
        "has_finding_site", "finding_site_of",
        "associated_with", "has_associated_finding",
    }
    _RELA_LABELS = {
        "cause_of":            "causes",
        "has_causative_agent": "caused by",
        "causative_agent_of":  "causes",
        "manifestation_of":    "manifests as",
        "has_manifestation":   "manifests in",
        "induces":             "induces",
        "induced_by":          "induced by",
        "isa":                 "is a",
        "inverse_isa":         "is type of",
        "has_finding_site":    "found at",
        "finding_site_of":     "site of",
        "associated_with":     "associated",
        "has_associated_finding": "associated finding",
    }

    value = (cui or "").strip().upper()
    if not UMLS_DB.exists():
        raise HTTPException(503, "UMLS DB not built")
    import re as _re
    if not _re.fullmatch(r"C\d{7}", value):
        raise HTTPException(400, "Invalid CUI format")

    con = sqlite3.connect(f"file:{UMLS_DB}?mode=ro", uri=True, timeout=3)
    con.row_factory = sqlite3.Row
    try:
        # Load center concept
        center = con.execute(
            "SELECT cui, preferred_name, semantic_group FROM umls_concepts WHERE cui=?", (value,)
        ).fetchone()
        if not center:
            raise HTTPException(404, "Concept not found")

        nodes: dict[str, dict] = {
            value: {
                "cui": value,
                "preferred_name": center["preferred_name"] or value,
                "semantic_group": center["semantic_group"] or "",
                "href": f"/umls?cui={value}",
                "is_center": True,
            }
        }
        edges: list[dict] = []

        # Hop 1: direct causal/conceptual relations
        rela_filter = ",".join(f"'{r}'" for r in _CAUSAL_RELA)
        hop1_rows = con.execute(
            f"""
            SELECT r.cui2 AS target_cui, r.rela, c.preferred_name, c.semantic_group
            FROM umls_relations r
            JOIN umls_concepts c ON c.cui=r.cui2
            WHERE r.cui1=? AND r.rela IN ({rela_filter})
            ORDER BY r.source_rank ASC, c.semantic_group, c.preferred_name
            LIMIT ?
            """,
            (value, limit),
        ).fetchall()

        hop1_cuis: set[str] = set()
        for row in hop1_rows:
            tc = row["target_cui"]
            if tc == value or tc in nodes:
                continue
            nodes[tc] = {
                "cui": tc,
                "preferred_name": row["preferred_name"] or tc,
                "semantic_group": row["semantic_group"] or "",
                "href": f"/umls?cui={tc}",
                "is_center": False,
            }
            edges.append({
                "source_cui": value,
                "target_cui": tc,
                "rela": row["rela"],
                "label": _RELA_LABELS.get(row["rela"], row["rela"] or "related"),
            })
            hop1_cuis.add(tc)

        # Hop 2: optional second-hop
        if depth >= 2 and hop1_cuis:
            h1_list = list(hop1_cuis)[:8]
            placeholders = ",".join("?" * len(h1_list))
            hop2_rows = con.execute(
                f"""
                SELECT r.cui1 AS source_cui, r.cui2 AS target_cui, r.rela,
                       c.preferred_name, c.semantic_group
                FROM umls_relations r
                JOIN umls_concepts c ON c.cui=r.cui2
                WHERE r.cui1 IN ({placeholders})
                  AND r.cui2 != ?
                  AND r.rela IN ({rela_filter})
                ORDER BY r.source_rank ASC
                LIMIT ?
                """,
                (*h1_list, value, max(0, limit - len(nodes) + 1)),
            ).fetchall()
            for row in hop2_rows:
                tc = row["target_cui"]
                if tc in nodes:
                    edges.append({
                        "source_cui": row["source_cui"],
                        "target_cui": tc,
                        "rela": row["rela"],
                        "label": _RELA_LABELS.get(row["rela"], row["rela"] or "related"),
                    })
                    continue
                if len(nodes) >= limit + 1:
                    break
                nodes[tc] = {
                    "cui": tc,
                    "preferred_name": row["preferred_name"] or tc,
                    "semantic_group": row["semantic_group"] or "",
                    "href": f"/umls?cui={tc}",
                    "is_center": False,
                }
                edges.append({
                    "source_cui": row["source_cui"],
                    "target_cui": tc,
                    "rela": row["rela"],
                    "label": _RELA_LABELS.get(row["rela"], row["rela"] or "related"),
                })
    except HTTPException:
        raise
    except sqlite3.Error as e:
        raise HTTPException(500, str(e))
    finally:
        con.close()

    return {
        "center_cui":   value,
        "nodes":        list(nodes.values()),
        "edges":        edges,
        "total_nodes":  len(nodes),
        "total_edges":  len(edges),
    }


@router.get("/tooltip")
def tooltip(term: str = Query(..., min_length=1, max_length=140), limit: int = Query(default=10, ge=1, le=24)):
    return umls_reader.tooltip(term, limit=limit)


@router.get("/labs/search")
def labs_search(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(default=20, ge=1, le=80)):
    return {"query": q, "results": list(umls_reader.labs_search(q, limit=limit))}


@router.get("/labs/groups")
def labs_groups():
    """Return curated clinical lab panels with LOINC codes + reference ranges.

    Cross-references each LOINC code against umls_codes for the canonical
    LOINC display name; falls back to the curated display when missing.
    """
    panels = loinc_panels.panel_summary()
    if not UMLS_DB.exists():
        return {"panels": panels, "umls_enriched": False}
    try:
        con = sqlite3.connect(f"file:{UMLS_DB}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            for panel in panels:
                for entry in panel["codes"]:
                    row = con.execute(
                        "SELECT cui, term FROM umls_codes WHERE sab='LNC' AND code=? ORDER BY source_rank LIMIT 1",
                        (entry["loinc"],),
                    ).fetchone()
                    if row:
                        entry["cui"] = row["cui"]
                        entry["loinc_long_name"] = row["term"]
        finally:
            con.close()
    except sqlite3.Error:
        pass
    return {"panels": panels, "umls_enriched": True}


@router.get("/labs/code/{loinc}")
def labs_code(loinc: str):
    """Return full detail for a LOINC code: name, related conditions, related panels."""
    if not UMLS_DB.exists():
        raise HTTPException(503, "UMLS DB not built")
    con = sqlite3.connect(f"file:{UMLS_DB}?mode=ro", uri=True, timeout=2)
    con.row_factory = sqlite3.Row
    try:
        code_row = con.execute(
            "SELECT cui, term FROM umls_codes WHERE sab='LNC' AND code=? ORDER BY source_rank LIMIT 1",
            (loinc,),
        ).fetchone()
        if not code_row:
            raise HTTPException(404, f"LOINC code '{loinc}' not found")
        cui = code_row["cui"]
        synonyms = [
            row["term"]
            for row in con.execute(
                "SELECT DISTINCT term FROM umls_terms WHERE cui=? ORDER BY is_pref DESC, length(term) LIMIT 12",
                (cui,),
            ).fetchall()
        ]
        related = [
            {"cui": r["cui2"], "name": r["preferred_name"], "rela": r["rela"], "sab": r["sab"]}
            for r in con.execute(
                """
                SELECT r.cui2, r.rela, r.sab, c.preferred_name
                FROM umls_relations r JOIN umls_concepts c ON c.cui=r.cui2
                WHERE r.cui1=? AND r.rela IN ('has_component','component_of','has_system','system_of','measures','measured_by')
                ORDER BY r.sab, c.preferred_name
                LIMIT 20
                """,
                (cui,),
            ).fetchall()
        ]
    finally:
        con.close()
    panels = [
        {"id": p.id, "name": p.name}
        for p in loinc_panels.PANELS
        if any(c.loinc == loinc for c in p.codes)
    ]
    curated = next(
        (asdict_safe(c) for p in loinc_panels.PANELS for c in p.codes if c.loinc == loinc),
        None,
    )
    return {
        "loinc": loinc,
        "cui": cui,
        "preferred_name": code_row["term"],
        "curated": curated,
        "synonyms": synonyms,
        "related": related,
        "in_panels": panels,
        "href": f"/umls?cui={cui}",
    }


def asdict_safe(obj):
    if obj is None:
        return None
    from dataclasses import asdict, is_dataclass
    return asdict(obj) if is_dataclass(obj) else dict(obj)


@router.get("/qbank-concepts")
def qbank_concepts(
    question_id: int = Query(..., ge=1, description="QBank question numeric ID"),
    db: str = Query(default="step2", max_length=20, description="QBank database key, e.g. step1/step2/step3"),
    limit: int = Query(default=16, ge=1, le=40),
):
    """Return UMLS concepts tagged to a QBank question stem + explanation.

    Source ID format in paragraph_concepts is '{db}:{question_id}'.
    Returns chips suitable for the QBank review screen.
    """
    if not _PARAGRAPH_CONCEPTS_DB.exists():
        return {"question_id": question_id, "db": db, "concepts": []}

    source_id = f"{db}:{question_id}"
    try:
        pc = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True, timeout=2)
        pc.row_factory = sqlite3.Row
        try:
            rows = pc.execute(
                """
                SELECT DISTINCT cui, semantic_group, matched_term,
                       SUM(hit_count) AS total_hits, MAX(confidence) AS max_conf
                FROM paragraph_concepts
                WHERE source='qbank' AND source_id=?
                GROUP BY cui
                ORDER BY total_hits DESC, max_conf DESC
                LIMIT ?
                """,
                (source_id, limit),
            ).fetchall()
        finally:
            pc.close()
    except sqlite3.Error:
        return {"question_id": question_id, "db": db, "concepts": []}

    if not rows:
        return {"question_id": question_id, "db": db, "concepts": []}

    # Enrich with preferred names from UMLS
    cuis = [r["cui"] for r in rows]
    preferred: dict[str, str] = {}
    if UMLS_DB.exists():
        try:
            umls_con = sqlite3.connect(f"file:{UMLS_DB}?mode=ro", uri=True, timeout=2)
            umls_con.row_factory = sqlite3.Row
            try:
                placeholders = ",".join("?" * len(cuis))
                name_rows = umls_con.execute(
                    f"SELECT cui, preferred_name FROM umls_concepts WHERE cui IN ({placeholders})",
                    tuple(cuis),
                ).fetchall()
                preferred = {r["cui"]: r["preferred_name"] for r in name_rows}
            finally:
                umls_con.close()
        except sqlite3.Error:
            pass

    concepts = []
    for r in rows:
        cui = r["cui"]
        pn = preferred.get(cui) or r["matched_term"] or cui
        concepts.append({
            "cui":            cui,
            "preferred_name": pn,
            "semantic_group": r["semantic_group"] or "",
            "matched_term":   r["matched_term"] or "",
            "hit_count":      int(r["total_hits"] or 1),
            "href":           f"/umls?cui={cui}",
        })

    return {"question_id": question_id, "db": db, "concepts": concepts}


@router.get("/adverse-events/search")
def adverse_event_search(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(default=20, ge=1, le=80)):
    return {"query": q, "results": list(umls_reader.adverse_event_search(q, limit=limit))}


@router.get("/concept/{cui}/mentions")
def concept_mentions(
    cui: str,
    limit: int = Query(default=40, ge=1, le=400),
    source: str | None = Query(default=None, max_length=40),
    per_source: int | None = Query(
        default=None, ge=1, le=40,
        description="Balanced hub view: return up to N hits PER source so low-volume "
                    "databases (UWorld, AMBOSS) aren't starved by high-volume ones (books).",
    ),
):
    """Return every paragraph across all surfaces that mentions this CUI.

    Output is grouped by source. Joins paragraph_concepts → global_search.entries
    so titles/hrefs come along for free, with the rich firstaid_full body kept
    separate so callers can pivot to /firstaid/region detail.
    """
    if not _PARAGRAPH_CONCEPTS_DB.exists() or not _GLOBAL_SEARCH_DB.exists():
        raise HTTPException(503, "Paragraph index not built. Run scripts/umls/tag_paragraphs.py")
    if not cui or not cui.startswith("C"):
        raise HTTPException(400, "CUI must look like C0000000")
    pc = sqlite3.connect(f"file:{_PARAGRAPH_CONCEPTS_DB}?mode=ro", uri=True, timeout=2)
    pc.row_factory = sqlite3.Row
    gs = sqlite3.connect(f"file:{_GLOBAL_SEARCH_DB}?mode=ro", uri=True, timeout=2)
    gs.row_factory = sqlite3.Row
    try:
        # True per-source coverage — every database that mentions this concept,
        # counted independently of the display cap so the hub can show
        # "12 UWorld articles" even when only a few rows are listed. firstaid_full
        # is the rich-body twin of firstaid, so merge them for display.
        source_counts: dict[str, int] = {}
        for row in pc.execute(
            "SELECT source, count(DISTINCT source_id) n FROM paragraph_concepts WHERE cui=? GROUP BY source",
            (cui,),
        ).fetchall():
            key = "firstaid" if row["source"] == "firstaid_full" else row["source"]
            source_counts[key] = source_counts.get(key, 0) + int(row["n"] or 0)

        if per_source and not source:
            # Balanced hub view: top-N per source via a window so rarer databases
            # always appear alongside the high-volume ones.
            hits = pc.execute(
                """
                SELECT source, source_id, semantic_group, matched_term, hit_count, confidence
                FROM (
                  SELECT source, source_id, semantic_group, matched_term, hit_count, confidence,
                         ROW_NUMBER() OVER (
                           PARTITION BY source ORDER BY hit_count DESC, confidence DESC
                         ) AS rn
                  FROM paragraph_concepts
                  WHERE cui=?
                )
                WHERE rn <= ?
                ORDER BY hit_count DESC, confidence DESC
                """,
                (cui, per_source),
            ).fetchall()
        else:
            params: list = [cui]
            source_filter = ""
            if source:
                source_filter = " AND source=?"
                params.append(source)
            params.append(limit)
            hits = pc.execute(
                f"""
                SELECT source, source_id, semantic_group, matched_term, hit_count, confidence
                FROM paragraph_concepts
                WHERE cui=?{source_filter}
                ORDER BY hit_count DESC, confidence DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        entries_by_source: dict[str, dict[str, sqlite3.Row]] = {}
        for hit in hits:
            entries_by_source.setdefault(hit["source"], {}).setdefault(hit["source_id"], hit)
        # batch fetch titles/hrefs for the standard global_search-backed sources
        out: list[dict] = []
        for src, by_id in entries_by_source.items():
            if src == "firstaid_full":
                # join firstaid_regions for titles
                fa_db = ROOT / "data" / "firstaid_index.sqlite"
                if fa_db.exists():
                    fa = sqlite3.connect(f"file:{fa_db}?mode=ro", uri=True, timeout=2)
                    fa.row_factory = sqlite3.Row
                    try:
                        ids = list(by_id.keys())
                        placeholders = ",".join("?" for _ in ids)
                        rows = fa.execute(
                            f"SELECT heading_id, title, hierarchy, page FROM firstaid_regions WHERE heading_id IN ({placeholders})",
                            ids,
                        ).fetchall()
                        for row in rows:
                            sid = str(row["heading_id"])
                            hit = by_id[sid]
                            out.append({
                                "source": "firstaid",
                                "source_id": sid,
                                "title": row["title"],
                                "subtitle": row["hierarchy"] or f"p.{row['page']}",
                                "href": f"/firstaid?region={sid}",
                                "matched_term": hit["matched_term"],
                                "hit_count": int(hit["hit_count"] or 1),
                                "semantic_group": hit["semantic_group"],
                            })
                    finally:
                        fa.close()
                continue
            ids = list(by_id.keys())
            placeholders = ",".join("?" for _ in ids)
            rows = gs.execute(
                f"SELECT source, external_id, title, subtitle, href, kind FROM entries WHERE source=? AND external_id IN ({placeholders})",
                (src, *ids),
            ).fetchall()
            for row in rows:
                sid = str(row["external_id"])
                hit = by_id[sid]
                out.append({
                    "source": row["source"],
                    "source_id": sid,
                    "title": row["title"],
                    "subtitle": row["subtitle"],
                    "href": row["href"],
                    "kind": row["kind"],
                    "matched_term": hit["matched_term"],
                    "hit_count": int(hit["hit_count"] or 1),
                    "semantic_group": hit["semantic_group"],
                })
        out.sort(key=lambda item: (-int(item.get("hit_count") or 0), item.get("title", "")))
        # In balanced mode the per_source cap already bounds the set; don't re-trim
        # by `limit` or a tail source could be dropped.
        result_items = out if (per_source and not source) else out[:limit]
        return {
            "cui": cui,
            "total_mentions": len(hits),
            "results": result_items,
            "source_counts": source_counts,
        }
    finally:
        pc.close()
        gs.close()


@router.post("/phenotype/differential")
def phenotype_differential(body: PhenotypeRequest, limit: int = Query(default=30, ge=1, le=100)):
    phenotypes = [item.strip() for item in body.phenotypes if item and item.strip()]
    return umls_reader.phenotype_differential(phenotypes, limit=limit)

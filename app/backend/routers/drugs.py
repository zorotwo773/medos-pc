"""
Drug Reference router — serves drug_reference.sqlite

Endpoints (all prefixed /drugs):
  GET /drugs/health                 DB health check
  GET /drugs/search                 FTS5 drug search with quick-info inline
  GET /drugs/compare                Side-by-side multi-drug comparison (2-4 drugs)
  GET /drugs/calculate-dose         Regex-based dose calculator with renal adjustment
  GET /drugs/{drug_id}              Full drug profile (all clinical sections)
"""
from __future__ import annotations

import re
import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from dose_engine import calculate_dose as calculate_structured_dose
from dose_engine import popup_payload, resolve_drug_id
from config import CONCEPT_LINKS_DB, DRUG_REF_DB
from rxnorm_reader import normalize_name
import openfda_reader as _fda

router = APIRouter(prefix="/drugs", tags=["drugs"])


# ── DB connection ─────────────────────────────────────────────────────────────

def _conn() -> sqlite3.Connection:
    if not DRUG_REF_DB.exists():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Drug reference database not built yet.",
                "action": "Run: python scripts/build_drug_reference.py",
            },
        )
    c = sqlite3.connect(f"file:{DRUG_REF_DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA cache_size=-32000")
    return c


def _has_table(c: sqlite3.Connection, name: str) -> bool:
    row = c.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (name,),
    ).fetchone()
    return bool(row)


def _has_column(c: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        return column in {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return False


# ── Health ────────────────────────────────────────────────────────────────────

@router.get("/health")
def drugs_health():
    if not DRUG_REF_DB.exists():
        return {"configured": False, "exists": False, "path": str(DRUG_REF_DB)}
    try:
        c = _conn()
        drug_count = c.execute("SELECT COUNT(*) FROM drugs").fetchone()[0]
        meta_rows  = c.execute("SELECT key, value FROM build_meta").fetchall()
        meta       = {r["key"]: r["value"] for r in meta_rows}
        c.close()
        return {
            "configured":    True,
            "exists":        True,
            "path":          str(DRUG_REF_DB),
            "drug_count":    drug_count,
            "built_at":      meta.get("built_at"),
            "mm_version":    meta.get("mm_version"),
            "section_count": meta.get("section_count"),
            "utd_used":      meta.get("utd_used"),
            "rxnorm_linked_at": meta.get("rxnorm_linked_at"),
            "rxcui_match_rate": meta.get("rxcui_match_rate"),
            "rxcui_dedupe_alias_count": meta.get("rxcui_dedupe_alias_count"),
            "rxcui_dedupe_skipped_conflicts": meta.get("rxcui_dedupe_skipped_conflicts"),
            "clinical_extracted_at": meta.get("clinical_extracted_at"),
            "structured_dosing_rate": meta.get("structured_dosing_rate"),
            "rx_ready_dosing_rate": meta.get("rx_ready_dosing_rate"),
            "mm_interaction_db_used": meta.get("mm_interaction_db_used"),
            "mm_interaction_quick_rows": meta.get("mm_interaction_quick_rows"),
        }
    except Exception as e:
        return {"configured": True, "exists": True, "error": str(e)}


# ── Search ────────────────────────────────────────────────────────────────────

def _sanitize_fts(q: str) -> str:
    return re.sub(r"[^\w\s]", "", q).strip()


@router.get("/search")
def drug_search(
    q:     str = Query(..., min_length=1, max_length=120),
    limit: int = Query(default=15, ge=1, le=50),
):
    """Fast drug search using FTS5, with brand names and dose snippet inline."""
    c = _conn()
    try:
        results = []
        seen: set[int] = set()

        # Exact alias hits should rank ahead of broad FTS. This makes clinical
        # shorthand such as APAP resolve to acetaminophen before combination
        # products whose brand strings merely contain the shorthand.
        if _has_table(c, "drug_aliases"):
            qnorm_exact = normalize_name(q)
            if qnorm_exact:
                alias_rows = c.execute(
                    """
                    SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                           qi.drug_class, qi.dose_snippet, qi.bbw_snippet,
                           qi.regulatory_status, d.has_black_box,
                           da.alias AS alias_match
                    FROM drug_aliases da
                    JOIN drug_quick_info qi ON qi.drug_id = da.drug_id
                    JOIN drugs d ON d.drug_id = qi.drug_id
                    WHERE da.alias_norm = ?
                    ORDER BY CASE da.source
                        WHEN 'clinical_alias' THEN 0 WHEN 'drug_reference' THEN 1
                        WHEN 'drug_brand' THEN 2 WHEN 'rxnorm' THEN 3 ELSE 4 END,
                        lower(qi.generic_name)
                    LIMIT ?
                    """,
                    (qnorm_exact, limit),
                ).fetchall()
                for r in alias_rows:
                    did = int(r["drug_id"])
                    if did not in seen:
                        seen.add(did)
                        results.append(_row_to_result(r))

        # FTS5 prefix search
        fts_q = _sanitize_fts(q) + "*"
        if fts_q.strip() != "*":
            try:
                rows = c.execute(
                    """
                    SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                           qi.drug_class, qi.dose_snippet, qi.bbw_snippet,
                           qi.regulatory_status, d.has_black_box
                    FROM drug_fts
                    JOIN drug_quick_info qi ON qi.drug_id = drug_fts.drug_id
                    JOIN drugs d ON d.drug_id = qi.drug_id
                    WHERE drug_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (fts_q, limit),
                ).fetchall()
                for r in rows:
                    did = int(r["drug_id"])
                    if did not in seen:
                        seen.add(did)
                        results.append(_row_to_result(r))
            except sqlite3.OperationalError:
                pass  # FTS may not be built yet, fall through to LIKE

        # LIKE fallback
        if len(results) < limit:
            qlow = q.lower().strip()
            rows2 = c.execute(
                """
                SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                       qi.drug_class, qi.dose_snippet, qi.bbw_snippet,
                       qi.regulatory_status, d.has_black_box
                FROM drug_quick_info qi
                JOIN drugs d ON d.drug_id = qi.drug_id
                WHERE lower(qi.generic_name) LIKE ?
                   OR lower(qi.brand_names) LIKE ?
                ORDER BY lower(qi.generic_name)
                LIMIT ?
                """,
                (f"{qlow}%", f"%{qlow}%", limit - len(results)),
            ).fetchall()
            for r in rows2:
                did = int(r["drug_id"])
                if did not in seen:
                    seen.add(did)
                    results.append(_row_to_result(r))

        # Alias fallback: APAP -> acetaminophen, brand/foreign names, RxNorm
        # synonyms, and manually curated clinical aliases.
        if len(results) < limit and _has_table(c, "drug_aliases"):
            qnorm = normalize_name(q)
            if qnorm:
                rows3 = c.execute(
                    """
                    SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                           qi.drug_class, qi.dose_snippet, qi.bbw_snippet,
                           qi.regulatory_status, d.has_black_box,
                           da.alias AS alias_match
                    FROM drug_aliases da
                    JOIN drug_quick_info qi ON qi.drug_id = da.drug_id
                    JOIN drugs d ON d.drug_id = qi.drug_id
                    WHERE da.alias_norm LIKE ?
                    ORDER BY
                        CASE WHEN da.alias_norm = ? THEN 0 ELSE 1 END,
                        length(da.alias_norm),
                        lower(qi.generic_name)
                    LIMIT ?
                    """,
                    (f"{qnorm}%", qnorm, limit - len(results)),
                ).fetchall()
                for r in rows3:
                    did = int(r["drug_id"])
                    if did not in seen:
                        seen.add(did)
                        results.append(_row_to_result(r))

        return {"query": q, "results": results}
    finally:
        c.close()


def _row_to_result(r) -> dict:
    out = {
        "drug_id":          int(r["drug_id"]),
        "generic_name":     r["generic_name"] or "",
        "brand_names":      r["brand_names"] or "",
        "drug_class":       r["drug_class"] or "",
        "dose_snippet":     r["dose_snippet"] or "",
        "bbw_snippet":      r["bbw_snippet"],
        "regulatory_status": r["regulatory_status"] or "RX",
        "has_black_box":    bool(r["has_black_box"]),
        "href":             f"/drugs?id={int(r['drug_id'])}",
    }
    if "alias_match" in r.keys() and r["alias_match"]:
        out["alias_match"] = r["alias_match"]
    return out


# ── Medication class browser ─────────────────────────────────────────────────

_ANTIARRHYTHMIC_GROUP_RE = re.compile(
    r"\bAntiarrhythmic,\s*Group\s+(IA|IB|IC|II|III|IV)\b",
    re.IGNORECASE,
)


def _class_labels(raw: str) -> list[str]:
    labels: list[str] = []
    for part in re.split(r"[|;]", raw or ""):
        text = re.sub(r"\s+", " ", part).strip(" ,")
        if not text:
            continue

        # Keep Vaughan Williams classes browseable instead of splitting them
        # into several overly broad words.
        m = _ANTIARRHYTHMIC_GROUP_RE.search(text)
        if m:
            labels.append(f"Antiarrhythmic, Group {m.group(1).upper()}")
            continue

        labels.append(text)

    return list(dict.fromkeys(labels))


def _class_label_norm(label: str) -> str:
    return re.sub(r"\s+", " ", label or "").strip().lower()


@router.get("/classes")
def drug_classes():
    """Return medication classes with counts for the left-side class browser."""
    c = _conn()
    try:
        counts: dict[str, int] = {}
        if _has_table(c, "drug_class_tags"):
            rows = c.execute(
                """
                SELECT label, COUNT(*) AS n
                FROM drug_class_tags
                GROUP BY label_norm
                ORDER BY lower(label)
                """
            ).fetchall()
            for row in rows:
                counts[row["label"]] = int(row["n"])
        else:
            rows = c.execute(
                "SELECT drug_id, drug_class FROM drugs WHERE COALESCE(TRIM(drug_class), '') <> ''"
            ).fetchall()
            for row in rows:
                for label in _class_labels(row["drug_class"]):
                    counts[label] = counts.get(label, 0) + 1

        classes = [
            {"class_name": name, "count": count}
            for name, count in counts.items()
            if count > 0
        ]
        classes.sort(key=lambda item: item["class_name"].lower())
        return {"classes": classes}
    finally:
        c.close()


@router.get("/class-tree")
def drug_class_tree():
    """Hierarchical medication browser: therapeutic areas → subclasses → drugs.

    Returns the 2-level tree with distinct-drug counts, sorted by clinical
    weight (most-populated areas/subclasses first). Falls back to an empty tree
    when the class-tree tables have not been built yet (frontend then keeps the
    flat /classes browser)."""
    c = _conn()
    try:
        if not _has_table(c, "drug_class_nodes"):
            return {"available": False, "areas": []}

        areas = c.execute(
            """
            SELECT a.id, a.name, COUNT(DISTINCT m.drug_id) AS drug_count
            FROM drug_class_nodes a
            JOIN drug_class_nodes s ON s.parent_id = a.id
            JOIN drug_class_membership m ON m.node_id = s.id
            WHERE a.level = 0
            GROUP BY a.id
            ORDER BY drug_count DESC, lower(a.name)
            """
        ).fetchall()

        subs_by_area: dict[int, list[dict]] = {}
        for row in c.execute(
            """
            SELECT s.parent_id AS area_id, s.id, s.name, s.source,
                   COUNT(DISTINCT m.drug_id) AS drug_count
            FROM drug_class_nodes s
            JOIN drug_class_membership m ON m.node_id = s.id
            WHERE s.level = 1
            GROUP BY s.id
            ORDER BY drug_count DESC, lower(s.name)
            """
        ).fetchall():
            subs_by_area.setdefault(int(row["area_id"]), []).append({
                "id": int(row["id"]),
                "name": row["name"],
                "source": row["source"],
                "drug_count": int(row["drug_count"]),
            })

        out = []
        for a in areas:
            out.append({
                "id": int(a["id"]),
                "name": a["name"],
                "drug_count": int(a["drug_count"]),
                "subclasses": subs_by_area.get(int(a["id"]), []),
            })
        return {"available": True, "areas": out}
    finally:
        c.close()


@router.get("/by-node")
def drugs_by_node(
    node_id: int = Query(...),
    limit: int = Query(default=500, ge=1, le=1000),
):
    """Drugs under one class-tree node — an area (aggregates all its subclasses)
    or a single subclass. Returns the same quick-info shape as search."""
    c = _conn()
    try:
        if not _has_table(c, "drug_class_nodes"):
            raise HTTPException(status_code=404, detail="Class tree not built")
        node = c.execute(
            "SELECT id, name, level FROM drug_class_nodes WHERE id = ?", (node_id,)
        ).fetchone()
        if not node:
            raise HTTPException(status_code=404, detail="Class node not found")

        if node["level"] == 0:
            node_filter = """m.node_id IN (
                SELECT id FROM drug_class_nodes WHERE parent_id = :nid)"""
        else:
            node_filter = "m.node_id = :nid"

        # LEFT JOIN quick_info (with drugs-table fallbacks) so /by-node never
        # returns fewer drugs than the count /class-tree shows for the node,
        # even if a drug is missing its quick_info row from a partial build.
        rows = c.execute(
            f"""
            SELECT d.drug_id AS drug_id,
                   COALESCE(qi.generic_name, d.generic_name) AS generic_name,
                   COALESCE(qi.brand_names, '')       AS brand_names,
                   COALESCE(qi.drug_class, d.drug_class) AS drug_class,
                   COALESCE(qi.dose_snippet, '')      AS dose_snippet,
                   qi.bbw_snippet                     AS bbw_snippet,
                   COALESCE(qi.regulatory_status, d.regulatory_status, 'RX') AS regulatory_status,
                   d.has_black_box                    AS has_black_box,
                   MAX(m.is_primary)                  AS is_primary
            FROM drug_class_membership m
            JOIN drugs d ON d.drug_id = m.drug_id
            LEFT JOIN drug_quick_info qi ON qi.drug_id = m.drug_id
            WHERE {node_filter}
            GROUP BY d.drug_id
            ORDER BY lower(COALESCE(qi.generic_name, d.generic_name))
            LIMIT :lim
            """,
            {"nid": node_id, "lim": limit},
        ).fetchall()
        return {
            "node_id": node_id,
            "node_name": node["name"],
            "level": int(node["level"]),
            "results": [_row_to_result(r) for r in rows],
        }
    finally:
        c.close()


@router.get("/by-class")
def drugs_by_class(
    class_name: str = Query(..., min_length=2, max_length=160),
    limit: int = Query(default=200, ge=1, le=500),
):
    """Return quick-info rows for all drugs matching one medication class."""
    target = re.sub(r"\s+", " ", class_name).strip()
    target_norm = _class_label_norm(target)
    c = _conn()
    try:
        if _has_table(c, "drug_class_tags"):
            rows = c.execute(
                """
                SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                       d.drug_class, qi.dose_snippet, qi.bbw_snippet,
                       qi.regulatory_status, d.has_black_box
                FROM drug_class_tags t
                JOIN drugs d ON d.drug_id = t.drug_id
                JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
                WHERE t.label_norm = ?
                ORDER BY lower(qi.generic_name)
                LIMIT ?
                """,
                (target_norm, limit),
            ).fetchall()
            out = [_row_to_result(row) for row in rows]
        else:
            rows = c.execute(
                """
                SELECT qi.drug_id, qi.generic_name, qi.brand_names,
                       d.drug_class, qi.dose_snippet, qi.bbw_snippet,
                       qi.regulatory_status, d.has_black_box
                FROM drugs d
                JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
                WHERE lower(d.drug_class) LIKE ?
                ORDER BY lower(qi.generic_name)
                LIMIT ?
                """,
                (f"%{target_norm}%", limit * 3),
            ).fetchall()

            out = []
            for row in rows:
                if target_norm in {_class_label_norm(label) for label in _class_labels(row["drug_class"])}:
                    out.append(_row_to_result(row))
                    if len(out) >= limit:
                        break

        return {"class_name": target, "results": out}
    finally:
        c.close()


def _related_links(d: sqlite3.Row) -> list[dict]:
    links: list[dict] = []
    utd_topic_id = d["utd_topic_id"]
    if utd_topic_id:
        links.append({
            "source": "utd",
            "href": f"/uptodate?t={int(utd_topic_id)}",
            "title": f"{d['generic_name']}: UpToDate drug information",
        })

    if not utd_topic_id or not CONCEPT_LINKS_DB.exists():
        return links

    try:
        c = sqlite3.connect(f"file:{CONCEPT_LINKS_DB}?mode=ro", uri=True)
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                """
                SELECT source_b AS src, id_b AS eid, title_b AS title, similarity
                FROM concept_links
                WHERE source_a = 'utd' AND id_a = ?
                UNION ALL
                SELECT source_a AS src, id_a AS eid, title_a AS title, similarity
                FROM concept_links
                WHERE source_b = 'utd' AND id_b = ?
                ORDER BY similarity DESC
                LIMIT 6
                """,
                (str(utd_topic_id), str(utd_topic_id)),
            ).fetchall()
        finally:
            c.close()
    except Exception:
        return links

    seen = {("utd", str(utd_topic_id))}
    for row in rows:
        src = (row["src"] or "").strip()
        eid = str(row["eid"] or "").strip()
        if not src or not eid or (src, eid) in seen:
            continue
        seen.add((src, eid))
        href = (
            f"/amboss?doc={eid}" if src == "amboss" else
            f"/uptodate?t={eid}" if src == "utd" else
            f"/library?path={eid}" if src == "books" else
            f"#{eid}"
        )
        links.append({
            "source": src,
            "href": href,
            "title": row["title"] or src.upper(),
        })
    return links


# ── Compare (must be BEFORE /{drug_id} to avoid path collision) ───────────────

@router.get("/compare")
def compare_drugs(
    ids:      str = Query(..., description="Comma-separated drug_ids, 2-4 drugs", max_length=100),
    sections: str = Query(
        default="adult_dosing,renal_dosing,adverse_effects,interactions_major,black_box_warning,mechanism",
        description="Comma-separated section keys",
    ),
):
    """Side-by-side comparison of 2-4 drugs."""
    try:
        drug_ids = [int(x.strip()) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be comma-separated integers")
    if len(drug_ids) < 2:
        raise HTTPException(status_code=400, detail="Provide at least 2 drug IDs")
    if len(drug_ids) > 4:
        raise HTTPException(status_code=400, detail="Maximum 4 drugs for comparison")

    section_keys = [s.strip() for s in sections.split(",") if s.strip()]

    c = _conn()
    try:
        drugs_out = []
        for did in drug_ids:
            d = c.execute(
                """SELECT d.drug_id, d.generic_name, d.drug_class, d.has_black_box,
                          d.regulatory_status, d.is_generic_available, qi.brand_names,
                          qi.dose_snippet, qi.bbw_snippet
                   FROM drugs d
                   JOIN drug_quick_info qi ON qi.drug_id = d.drug_id
                   WHERE d.drug_id = ?""",
                (did,),
            ).fetchone()
            if not d:
                raise HTTPException(status_code=404, detail=f"Drug {did} not found")
            brands = [r["brand_name"] for r in c.execute(
                "SELECT brand_name FROM drug_brands WHERE drug_id = ? ORDER BY country, brand_name LIMIT 5",
                (did,),
            ).fetchall()]
            drugs_out.append({
                "drug_id":          did,
                "generic_name":     d["generic_name"],
                "brand_names":      brands,
                "drug_class":       (d["drug_class"] or "").split("|"),
                "has_black_box":    bool(d["has_black_box"]),
                "regulatory_status": d["regulatory_status"],
                "dose_snippet":     d["dose_snippet"] or "",
                "bbw_snippet":      d["bbw_snippet"],
            })

        # Gather sections
        sections_out: dict[str, list[dict]] = {}
        for sk in section_keys:
            col: list[dict] = []
            for did in drug_ids:
                row = c.execute(
                    "SELECT content_text, source FROM drug_sections WHERE drug_id = ? AND section_key = ?",
                    (did, sk),
                ).fetchone()
                text = row["content_text"] if row else ""
                col.append({
                    "drug_id": did,
                    "content": text[:600] + ("…" if len(text) > 600 else ""),
                    "source":  row["source"] if row else None,
                })
            sections_out[sk] = col

        return {"drugs": drugs_out, "sections": sections_out}
    finally:
        c.close()


# ── Clinical popup + structured dose engine ──────────────────────────────────

@router.get("/popup/{drug_id}")
def get_drug_popup(drug_id: int):
    """Compact clinical popup payload for search-result clicks."""
    c = _conn()
    try:
        try:
            return popup_payload(c, drug_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Drug not found")
    finally:
        c.close()


@router.get("/dose")
def structured_dose(
    drug_id:       int = Query(...),
    indication_id: Optional[int] = Query(None),
    weight_kg:     Optional[float] = Query(None, ge=0.5, le=500.0),
    age_years:     Optional[float] = Query(None, ge=0, le=130),
    crcl:          Optional[float] = Query(None, ge=0.0, le=300.0),
    child_pugh:    Optional[str] = Query(None, pattern="^[ABCabc]$"),
    dose_form:     Optional[str] = Query(None, max_length=80),
    route:         Optional[str] = Query(None, max_length=40),
):
    """Deterministic structured dose lookup with prescription formatting."""
    c = _conn()
    try:
        try:
            return calculate_structured_dose(
                c,
                drug_id=drug_id,
                indication_id=indication_id,
                weight_kg=weight_kg,
                age_years=age_years,
                crcl=crcl,
                child_pugh=child_pugh.upper() if child_pugh else None,
                dose_form=dose_form,
                route=route,
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="Drug not found")
    finally:
        c.close()


@router.get("/resolve")
def resolve_drug_name(
    name: str = Query(..., min_length=1, max_length=160),
):
    """Resolve a name or alias to the local drug row."""
    c = _conn()
    try:
        qnorm = normalize_name(name)
        rows = []
        if _has_table(c, "drug_aliases") and qnorm:
            rows = c.execute(
                """
                SELECT d.drug_id, d.generic_name, d.rxcui, d.rxcui_tty,
                       da.alias AS matched_alias, da.source
                FROM drug_aliases da
                JOIN drugs d ON d.drug_id = da.drug_id
                WHERE da.alias_norm = ?
                ORDER BY CASE da.source
                    WHEN 'drug_reference' THEN 0 WHEN 'clinical_alias' THEN 1
                    WHEN 'rxnorm' THEN 2 ELSE 3 END,
                    lower(d.generic_name)
                LIMIT 10
                """,
                (qnorm,),
            ).fetchall()
        if not rows:
            rows = c.execute(
                """
                SELECT drug_id, generic_name, rxcui, rxcui_tty,
                       generic_name AS matched_alias, 'generic_name' AS source
                FROM drugs
                WHERE lower(generic_name) = lower(?)
                LIMIT 10
                """,
                (name.strip(),),
            ).fetchall()
        return {"query": name, "matches": [dict(row) for row in rows]}
    finally:
        c.close()


@router.get("/by-ingredient")
def drugs_by_ingredient(
    rxcui: str = Query(..., min_length=1, max_length=40),
    limit: int = Query(default=100, ge=1, le=500),
):
    """Return local drugs containing an RxNorm ingredient RXCUI."""
    c = _conn()
    try:
        if not _has_table(c, "drug_ingredients"):
            return {"rxcui": rxcui, "results": []}
        rows = c.execute(
            """
            SELECT DISTINCT qi.drug_id, qi.generic_name, qi.brand_names,
                   qi.drug_class, qi.dose_snippet, qi.bbw_snippet,
                   qi.regulatory_status, d.has_black_box
            FROM drug_ingredients ing
            JOIN drug_quick_info qi ON qi.drug_id = ing.drug_id
            JOIN drugs d ON d.drug_id = qi.drug_id
            WHERE ing.ingredient_rxcui = ?
            ORDER BY lower(qi.generic_name)
            LIMIT ?
            """,
            (rxcui, limit),
        ).fetchall()
        return {"rxcui": rxcui, "results": [_row_to_result(row) for row in rows]}
    finally:
        c.close()


# ── Dose calculator ───────────────────────────────────────────────────────────

_DOSE_RANGE_RE  = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*(mg|mcg|g|mEq|units?|mL|tab|cap)",
    re.IGNORECASE,
)
_DOSE_SINGLE_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(mg|mcg|g|mEq|units?|mL|tab|cap)",
    re.IGNORECASE,
)
_PER_KG_RE   = re.compile(r"(?:per\s*kg|/\s*kg)", re.IGNORECASE)
_FREQ_RE     = re.compile(
    r"(once daily|twice daily|three times daily|every\s+\d+\s+hours?|q\d+h|daily|BID|TID|QID|PRN)",
    re.IGNORECASE,
)
_ROUTE_RE    = re.compile(
    r"\b(oral(?:ly)?|intravenous(?:ly)?|IV|intramuscular(?:ly)?|IM|subcutaneous(?:ly)?|SC|topical(?:ly)?)\b",
    re.IGNORECASE,
)
_CRCL_RE     = re.compile(
    r"CrCl\s*(?:less\s*than|<|greater\s*than|>|between\s*)?\s*(\d+).*?"
    r"(reduce|avoid|contraindicated|no\s*adjustment|use\s*with\s*caution)",
    re.IGNORECASE | re.DOTALL,
)


@router.get("/calculate-dose")
def calculate_dose(
    drug_id:          int   = Query(...),
    weight_kg:        float = Query(..., ge=0.5, le=500.0),
    crcl:             Optional[float] = Query(None, ge=0.0, le=300.0,
                                              description="Creatinine Clearance mL/min"),
    child_age_months: Optional[int]   = Query(None, ge=0, le=216),
    indication:       Optional[str]   = Query(None, max_length=120),
):
    """
    Text-parsing-based dose calculator. Returns weight-adjusted and renal-adjusted
    dose extracted from the drug's dosing section.
    Always includes a clinical disclaimer.
    """
    c = _conn()
    try:
        d = c.execute("SELECT generic_name FROM drugs WHERE drug_id = ?", (drug_id,)).fetchone()
        if not d:
            raise HTTPException(status_code=404, detail="Drug not found")
        generic = d["generic_name"]

        # Choose section key
        use_peds    = child_age_months is not None
        section_key = "pediatric_dosing" if use_peds else "adult_dosing"

        row = c.execute(
            "SELECT content_text, source FROM drug_sections WHERE drug_id = ? AND section_key = ?",
            (drug_id, section_key),
        ).fetchone()
        if not row or not row["content_text"]:
            raise HTTPException(
                status_code=400,
                detail=f"No {section_key} section available for {generic}",
            )

        text   = row["content_text"]
        source = row["source"]

        # ── Parse dose ──────────────────────────────────────────────────────
        m_range  = _DOSE_RANGE_RE.search(text)
        m_single = _DOSE_SINGLE_RE.search(text)
        weight_adjusted: Optional[str] = None
        confidence = "low"

        if m_range:
            low_val  = float(m_range.group(1))
            high_val = float(m_range.group(2))
            unit     = m_range.group(3)
            base_dose_text = f"{low_val}-{high_val} {unit}"
            confidence = "high"

            if _PER_KG_RE.search(text[:m_range.start() + 100]):
                adj_low  = round(low_val * weight_kg, 1)
                adj_high = round(high_val * weight_kg, 1)
                weight_adjusted = f"{adj_low}-{adj_high} {unit} (for {weight_kg} kg)"
        elif m_single:
            base_val  = float(m_single.group(1))
            unit      = m_single.group(2)
            base_dose_text = f"{base_val} {unit}"
            confidence = "medium"

            if _PER_KG_RE.search(text[:m_single.start() + 100]):
                adj = round(base_val * weight_kg, 1)
                weight_adjusted = f"{adj} {unit} (for {weight_kg} kg)"
        else:
            # No numeric dose found — return first sentence with a dose word
            for sent in re.split(r"[.!?\n]", text):
                if re.search(r"\b(?:dose|dosing|administer)\b", sent, re.I) and len(sent.strip()) > 10:
                    base_dose_text = sent.strip()[:200]
                    break
            else:
                base_dose_text = text[:200]

        # ── Parse frequency & route ─────────────────────────────────────────
        m_freq  = _FREQ_RE.search(text)
        m_route = _ROUTE_RE.search(text)
        frequency = m_freq.group(0).lower()  if m_freq  else None
        route     = m_route.group(0).lower() if m_route else None

        # ── Renal note ──────────────────────────────────────────────────────
        renal_note: Optional[str] = None
        if crcl is not None:
            renal_row = c.execute(
                "SELECT content_text FROM drug_sections WHERE drug_id = ? AND section_key = 'renal_dosing'",
                (drug_id,),
            ).fetchone()
            renal_text = renal_row["content_text"] if renal_row else ""
            if renal_text:
                m_crcl = _CRCL_RE.search(renal_text)
                if m_crcl:
                    thresh    = float(m_crcl.group(1))
                    action    = m_crcl.group(2)
                    renal_note = (f"CrCl threshold: {thresh} mL/min — {action}. "
                                  f"Your CrCl: {crcl:.0f} mL/min.")
                else:
                    renal_note = renal_text[:200]
            else:
                renal_note = "No specific renal dosing section found."

        return {
            "drug_id":      drug_id,
            "generic_name": generic,
            "weight_kg":    weight_kg,
            "crcl":         crcl,
            "indication":   indication,
            "deprecated":    True,
            "replacement_endpoint": "/drugs/dose",
            "source_section": section_key,
            "source":       source,
            "calculated": {
                "base_dose_text":   base_dose_text,
                "weight_adjusted":  weight_adjusted,
                "renal_note":       renal_note,
                "frequency":        frequency,
                "route":            route,
                "confidence":       confidence,
            },
            "disclaimer": (
                "Calculated doses are extracted by text parsing and may be incomplete. "
                "Always verify with a pharmacist or current prescribing information "
                "before clinical use."
            ),
        }
    finally:
        c.close()


# ── Full drug profile — must be last to avoid swallowing /compare and /health ─

@router.get("/{drug_id}")
def get_drug(
    drug_id:  int = ...,
    sections: str = Query(default="all",
                          description="Comma-separated section keys, or 'all'"),
):
    """Full drug profile with all clinical sections."""
    c = _conn()
    try:
        drug_id = resolve_drug_id(c, drug_id)
        d = c.execute("SELECT * FROM drugs WHERE drug_id = ?", (drug_id,)).fetchone()
        if not d:
            raise HTTPException(status_code=404, detail=f"Drug {drug_id} not found")

        brands = [r["brand_name"] for r in c.execute(
            "SELECT brand_name, country FROM drug_brands WHERE drug_id = ? ORDER BY country, brand_name",
            (drug_id,),
        ).fetchall()]

        qi = c.execute("SELECT * FROM drug_quick_info WHERE drug_id = ?", (drug_id,)).fetchone()

        icd_codes = [
            {"icd9": r["icd9"], "icd10": r["icd10"], "description": r["description"]}
            for r in c.execute("SELECT * FROM drug_icd WHERE drug_id = ?", (drug_id,)).fetchall()
        ]

        identity = {
            "rxcui": d["rxcui"] if _has_column(c, "drugs", "rxcui") else None,
            "rxcui_tty": d["rxcui_tty"] if _has_column(c, "drugs", "rxcui_tty") else None,
            "coverage_tier": d["coverage_tier"] if _has_column(c, "drugs", "coverage_tier") else 0,
            "coverage_status": d["coverage_status"] if _has_column(c, "drugs", "coverage_status") else None,
            "ingredients": [],
            "atc": [],
            "ndcs": [],
            "dose_forms": [],
            "strengths": [],
        }
        if _has_table(c, "drug_ingredients"):
            identity["ingredients"] = [
                dict(r) for r in c.execute(
                    "SELECT ingredient_rxcui, ingredient_name, strength, unit FROM drug_ingredients WHERE drug_id = ? ORDER BY lower(ingredient_name)",
                    (drug_id,),
                ).fetchall()
            ]
        if _has_table(c, "drug_atc"):
            identity["atc"] = [
                dict(r) for r in c.execute(
                    "SELECT atc_code, atc_name, level FROM drug_atc WHERE drug_id = ? ORDER BY level, atc_code",
                    (drug_id,),
                ).fetchall()
            ]
        if _has_table(c, "drug_ndc"):
            identity["ndcs"] = [
                dict(r) for r in c.execute(
                    "SELECT ndc, package_desc FROM drug_ndc WHERE drug_id = ? ORDER BY ndc LIMIT 50",
                    (drug_id,),
                ).fetchall()
            ]
        if _has_table(c, "drug_dose_forms"):
            identity["dose_forms"] = [
                dict(r) for r in c.execute(
                    "SELECT dose_form, route FROM drug_dose_forms WHERE drug_id = ? ORDER BY lower(dose_form) LIMIT 50",
                    (drug_id,),
                ).fetchall()
            ]
        if _has_table(c, "drug_strengths"):
            identity["strengths"] = [
                dict(r) for r in c.execute(
                    "SELECT strength_num, strength_unit, strength_text, dose_form, route FROM drug_strengths WHERE drug_id = ? ORDER BY strength_unit, strength_num LIMIT 50",
                    (drug_id,),
                ).fetchall()
            ]

        # Sections
        want_all = sections.strip().lower() == "all"
        want_set  = set() if want_all else {s.strip() for s in sections.split(",") if s.strip()}

        sec_rows = c.execute(
            "SELECT section_key, content_html, content_text, source FROM drug_sections WHERE drug_id = ?",
            (drug_id,),
        ).fetchall()

        sections_out: dict[str, dict] = {}
        for row in sec_rows:
            sk = row["section_key"]
            if want_all or sk in want_set:
                sections_out[sk] = {
                    "html":   row["content_html"] or "",
                    "text":   row["content_text"] or "",
                    "source": row["source"],
                }

        clinical_umls = _clinical_umls_for_drug(c, drug_id)

        # OpenFDA label — lazy fetch from FDA Open API, cached 30 days
        rxcui_val = (d["rxcui"] if _has_column(c, "drugs", "rxcui") else None) or None
        openfda_label = _fda.for_drug(
            generic_name=d["generic_name"] or "",
            rxcui=str(rxcui_val) if rxcui_val else None,
            brand_names=brands[:3],
        )

        return {
            "drug_id":              drug_id,
            "generic_name":         d["generic_name"],
            "brand_names":          brands,
            "drug_class":           [c2.strip() for c2 in (d["drug_class"] or "").split("|") if c2.strip()],
            "has_black_box":        bool(d["has_black_box"]),
            "regulatory_status":    d["regulatory_status"] or "RX",
            "is_generic_available": bool(d["is_generic_available"]),
            "utd_topic_id":         d["utd_topic_id"],
            "quick_info": {
                "dose_snippet": qi["dose_snippet"] if qi else "",
                "bbw_snippet":  qi["bbw_snippet"]  if qi else None,
            },
            "sections":             sections_out,
            "icd_codes":            icd_codes,
            "related_links":        _related_links(d),
            "identity":             identity,
            "clinical_umls":        clinical_umls,
            "openfda":              openfda_label,
        }
    finally:
        c.close()


def _clinical_umls_for_drug(c: sqlite3.Connection, drug_id: int) -> dict:
    """Return MED-RT-derived mechanism, indications, and adverse-event lists.

    All four tables are populated by scripts/build_drug_reference_umls_pass.py.
    Returns empty lists when a table is absent so the response shape is stable.
    """
    out: dict = {
        "cui": None,
        "mechanism_class": [],
        "physiologic_effects": [],
        "indications": [],
        "may_prevent": [],
        "contraindications": [],
        "reactions": [],
    }
    if _has_table(c, "drug_umls_links"):
        link = c.execute(
            "SELECT cui FROM drug_umls_links WHERE drug_id = ?", (drug_id,)
        ).fetchone()
        if link:
            out["cui"] = link["cui"]
    if _has_table(c, "drug_mechanism"):
        for row in c.execute(
            """
            SELECT mechanism_cui AS cui, mechanism_name AS name, kind, source
            FROM drug_mechanism
            WHERE drug_id = ?
            ORDER BY kind, rank
            """,
            (drug_id,),
        ).fetchall():
            entry = {"cui": row["cui"], "name": row["name"], "source": row["source"]}
            if row["kind"] == "class":
                out["mechanism_class"].append(entry)
            elif row["kind"] == "physiologic_effect":
                out["physiologic_effects"].append(entry)
    if _has_table(c, "drug_indications_umls"):
        for row in c.execute(
            """
            SELECT indication_cui AS cui, indication_name AS name, relation, source
            FROM drug_indications_umls
            WHERE drug_id = ?
            ORDER BY relation, rank
            """,
            (drug_id,),
        ).fetchall():
            entry = {"cui": row["cui"], "name": row["name"], "source": row["source"]}
            bucket = "indications" if row["relation"] == "may_treat" else "may_prevent"
            out[bucket].append(entry)
    if _has_table(c, "drug_adverse_events"):
        for row in c.execute(
            """
            SELECT ae_cui AS cui, ae_name AS name, kind, source
            FROM drug_adverse_events
            WHERE drug_id = ?
            ORDER BY kind, rank
            """,
            (drug_id,),
        ).fetchall():
            entry = {"cui": row["cui"], "name": row["name"], "source": row["source"]}
            bucket = "contraindications" if row["kind"] == "contraindication" else "reactions"
            out[bucket].append(entry)
    return out

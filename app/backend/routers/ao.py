"""
AO Surgery Reference router — serves scraped offline corpus.

Endpoints:
  GET /ao/tree              → tree.json (full nav hierarchy)
  GET /ao/page?slug=...     → per-page JSON (title, sections, figures)
  GET /ao/figure?slug=...&fig=...  → stream webp figure
  GET /ao/mesh?name=...     → {slugs: [...]} from mesh_map.json
  GET /ao/search?q=...      → fuzzy title/breadcrumb search across the corpus
  GET /ao/manifest          → MANIFEST.json + computed `stale` flag
  GET /ao/bone/{name}       → static AO/OTA classification JSON
"""
import json
import re
import time
from pathlib import Path
from functools import lru_cache

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from config import AO_DATA_PATH

router = APIRouter(prefix="/ao", tags=["ao"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-/]*$")
_STALE_DAYS = 90

# Keep in sync with ANATOMY_SYNONYMS in app/scripts/ao_scrape.py — only
# the mesh-name-side synonyms that 3D cleanNames are likely to contain.
_MESH_SYNONYMS = {
    "femoral": "femur", "humeral": "humerus", "tibial": "tibia",
    "fibular": "fibula", "radial": "radius", "ulnar": "ulna",
    "patellar": "patella", "vertebrae": "vertebra",
    "phalanges": "phalanx", "metacarpals": "metacarpal",
    "metatarsals": "metatarsal", "malleoli": "malleolus",
    "carpals": "carpus", "carpal bones": "carpus",
}


def _normalise_mesh_name(name: str) -> list[str]:
    """Tokenise a 3D mesh cleanName into candidate anatomy terms.

    Examples:
        "Humerus_R"        → ["humerus"]
        "Distal_Femur_001" → ["distal", "femur"]
        "L_Patella"        → ["patella"]
    """
    s = name.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\b(l|r|left|right|\d+)\b", " ", s)
    tokens: list[str] = []
    for tok in s.split():
        tokens.append(_MESH_SYNONYMS.get(tok, tok))
    return tokens


def _safe_slug(slug: str) -> Path:
    """Validate slug against path traversal and return absolute path under AO_DATA_PATH."""
    slug = slug.strip("/")
    if not slug or not _SLUG_RE.match(slug) or ".." in slug:
        raise HTTPException(status_code=400, detail="Invalid slug")
    return AO_DATA_PATH / "pages" / slug


@lru_cache(maxsize=1)
def _tree() -> dict:
    p = AO_DATA_PATH / "tree.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _mesh_map() -> dict:
    p = AO_DATA_PATH / "mesh_map.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _page_index() -> list[dict]:
    """Flat list of {slug, title, breadcrumbs} for search. Built once per process."""
    pages_dir = AO_DATA_PATH / "pages"
    if not pages_dir.exists():
        return []
    out: list[dict] = []
    for idx_file in pages_dir.rglob("index.json"):
        slug = str(idx_file.parent.relative_to(pages_dir)).replace("\\", "/")
        try:
            data = json.loads(idx_file.read_text(encoding="utf-8"))
            out.append({
                "slug": slug,
                "title": data.get("title", ""),
                "breadcrumbs": data.get("breadcrumbs", []),
            })
        except Exception:
            continue
    return out


@lru_cache(maxsize=1)
def _manifest() -> dict:
    p = AO_DATA_PATH / "MANIFEST.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


@router.get("/tree")
def get_tree():
    data = _tree()
    if not data:
        raise HTTPException(status_code=503, detail="AO data not yet scraped — run ao_scrape.py first")
    return data


@router.get("/page")
def get_page(slug: str = Query(..., min_length=1, max_length=300)):
    page_dir = _safe_slug(slug)
    index = page_dir / "index.json"
    if not index.exists():
        raise HTTPException(status_code=404, detail=f"Page not found: {slug}")
    return json.loads(index.read_text(encoding="utf-8"))


@router.get("/children")
def get_children(slug: str = Query(..., min_length=1, max_length=300)):
    """Return list of child pages (sub-directories with index.json) for a given slug."""
    page_dir = _safe_slug(slug)
    if not page_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Page not found: {slug}")
    children = []
    for child in sorted(page_dir.iterdir()):
        if child.is_dir() and (child / "index.json").exists():
            idx = json.loads((child / "index.json").read_text(encoding="utf-8"))
            children.append({
                "slug": f"{slug}/{child.name}",
                "title": idx.get("title", child.name.replace("-", " ").title()),
            })
    return {"children": children}


@router.get("/figure")
def get_figure(
    slug: str = Query(..., min_length=1, max_length=300),
    fig: str = Query(..., min_length=1, max_length=80),
):
    fig = fig.strip()
    if not re.match(r"^fig-\d+\.webp$", fig):
        raise HTTPException(status_code=400, detail="Invalid figure name")
    page_dir = _safe_slug(slug)
    path = page_dir / fig
    if not path.exists():
        raise HTTPException(status_code=404, detail="Figure not found")
    return FileResponse(str(path), media_type="image/webp")


@router.get("/mesh")
def get_mesh(name: str = Query(..., min_length=1, max_length=200)):
    """Resolve a 3D mesh cleanName to AO page slugs.

    Tokenises the mesh name and unions slugs across all matching anatomy
    terms. Returns more-specific terms first (e.g. "patella" > "distal").
    """
    mm = _mesh_map()
    if not mm:
        return {"slugs": []}

    tokens = _normalise_mesh_name(name)
    # Direct hit on the whole normalised name first
    full = " ".join(tokens).strip()
    if full and full in mm:
        return {"slugs": mm[full], "matched_terms": [full]}

    # Otherwise union per-token hits, preserving order (specific tokens first)
    seen: set[str] = set()
    slugs: list[str] = []
    matched: list[str] = []
    for tok in tokens:
        hits = mm.get(tok)
        if not hits:
            continue
        matched.append(tok)
        for s in hits:
            if s not in seen:
                seen.add(s)
                slugs.append(s)
    return {"slugs": slugs, "matched_terms": matched}


@router.get("/search")
def search_pages(q: str = Query(..., min_length=2, max_length=80),
                 limit: int = Query(20, ge=1, le=100)):
    """Case-insensitive substring search across page titles + breadcrumbs."""
    needle = q.lower().strip()
    if not needle:
        return {"results": []}
    results: list[dict] = []
    for entry in _page_index():
        title = entry["title"]
        hay = " ".join([title, *entry["breadcrumbs"]]).lower()
        if needle in hay:
            results.append(entry)
            if len(results) >= limit:
                break
    return {"results": results, "count": len(results)}


@router.get("/manifest")
def get_manifest():
    """Return MANIFEST.json + a computed `stale` flag (>90 days old)."""
    m = dict(_manifest())  # copy so we don't mutate the cached dict
    if not m:
        return {"available": False}
    m["available"] = True
    m["stale"] = False
    m["stale_days"] = _STALE_DAYS
    scraped_at = m.get("scraped_at")
    if scraped_at:
        try:
            ts = time.strptime(scraped_at, "%Y-%m-%dT%H:%M:%SZ")
            age_seconds = time.time() - time.mktime(ts)
            m["age_days"] = int(age_seconds // 86400)
            m["stale"] = m["age_days"] > _STALE_DAYS
        except Exception:
            pass
    return m


@router.get("/bone/{bone_name}")
def get_bone_classification(bone_name: str):
    """Returns static AO/OTA classification data for a named bone."""
    safe = re.sub(r"[^a-z0-9_-]", "", bone_name.lower().replace(" ", "_"))
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid bone name")
    p = AO_DATA_PATH / f"{safe}_classification.json"
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"No classification data for '{bone_name}'")
    data = json.loads(p.read_text(encoding="utf-8"))
    return data.get(safe, data)

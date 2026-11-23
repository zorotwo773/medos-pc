"""
AO Surgery Reference scraper — mirrors surgeryreference.aofoundation.org offline.

Usage:
    # Smoke-test on one region (~few minutes)
    python ao_scrape.py --only /orthopedic-trauma/adult-trauma/proximal-humerus --out D:/MedOS/data/ao

    # Full scrape (leave overnight)
    python ao_scrape.py --out D:/MedOS/data/ao

    # Force re-fetch pages already on disk
    python ao_scrape.py --out D:/MedOS/data/ao --refresh

Personal/educational use only. Do not redistribute the scraped corpus.
"""

import argparse
import asyncio
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from collections import deque
from urllib.parse import urljoin, urlparse, urldefrag

import httpx
from selectolax.parser import HTMLParser
from PIL import Image
import io

# ── Constants ───────────────────────────────────────────────────────────────
BASE_URL = "https://surgeryreference.aofoundation.org"
SEED_PATHS = [
    "/orthopedic-trauma",
    "/cmf",
    "/spine",
    "/vet",
    "/reconstruction",
]
SKIP_PREFIXES = ["/news", "/login", "/search", "/logout", "/register", "/shop"]
ALLOWED_TAGS = {
    "p", "ul", "ol", "li", "b", "i", "strong", "em", "br",
    "h3", "h4", "table", "tr", "td", "th", "sub", "sup", "a",
}
SECTION_HEADINGS = {
    "diagnosis", "indications", "approach",
    "reduction", "fixation", "aftercare", "further reading",
}
REQ_DELAY = 1.1        # seconds between requests
MAX_RETRIES = 4
IMG_MAX_WIDTH = 1200
IMG_QUALITY = 78
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


# ── Utilities ────────────────────────────────────────────────────────────────

def slug_from_path(path: str) -> str:
    """Strip leading slash and normalise."""
    return path.strip("/")


def path_for_slug(out_dir: Path, slug: str) -> Path:
    return out_dir / "pages" / slug


def cache_key(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def is_in_scope(path: str) -> bool:
    path = path.split("?")[0].split("#")[0]
    if any(path.startswith(p) for p in SKIP_PREFIXES):
        return False
    return any(path.startswith(p) for p in SEED_PATHS)


def sanitize_html(node, out_dir_page: Path, slug: str, fig_counter: list) -> str:
    """
    Recursively render a node tree to sanitised HTML.
    Downloads <img> elements, saves as webp, replaces src.
    Returns HTML string.
    """
    if node.tag == "-text":
        text = node.text(strip=False) or ""
        return _escape(text)

    tag = node.tag.lower() if node.tag else ""
    if tag not in ALLOWED_TAGS and tag != "[document]":
        # Render children but not the wrapper tag
        return "".join(sanitize_html(c, out_dir_page, slug, fig_counter) for c in node.iter())

    attrs = ""
    if tag == "a":
        href = (node.attributes.get("href") or "").strip()
        if href.startswith("/") and is_in_scope(href):
            href = f"/ortho/{slug_from_path(href)}"
        elif not href.startswith(("http://", "https://", "/ortho/", "#")):
            href = ""
        if href:
            attrs = f' href="{_escape_attr(href)}"'

    inner = "".join(sanitize_html(c, out_dir_page, slug, fig_counter) for c in node.iter())

    if tag in ("br",):
        return "<br>"
    return f"<{tag}{attrs}>{inner}</{tag}>"


def _escape(text: str) -> str:
    return (text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))


def _escape_attr(text: str) -> str:
    return text.replace('"', "&quot;").replace("'", "&#39;")


async def fetch_with_retry(
    client: httpx.AsyncClient,
    url: str,
    cache_dir: Path,
    refresh: bool,
) -> tuple[bytes | None, int]:
    """Return (raw_bytes, status_code). Uses on-disk cache unless --refresh."""
    key = cache_key(url)
    cached = cache_dir / key
    if cached.exists() and not refresh:
        return cached.read_bytes(), 200

    delay = REQ_DELAY
    for attempt in range(MAX_RETRIES):
        try:
            await asyncio.sleep(delay if attempt == 0 else delay * (2 ** attempt))
            r = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=30)
            if r.status_code in (429, 503):
                wait = int(r.headers.get("Retry-After", 10 * (attempt + 1)))
                print(f"  Rate-limited ({r.status_code}) — waiting {wait}s")
                await asyncio.sleep(wait)
                continue
            if r.status_code == 200:
                cached.write_bytes(r.content)
            return r.content, r.status_code
        except httpx.RequestError as e:
            if attempt == MAX_RETRIES - 1:
                print(f"  FAIL {url}: {e}")
                return None, 0
    return None, 0


def extract_links(html: HTMLParser, base_url: str) -> list[str]:
    paths = []
    for a in html.css("a[href]"):
        href = (a.attributes.get("href") or "").strip()
        href, _ = urldefrag(href)
        if not href:
            continue
        parsed = urlparse(href)
        if parsed.scheme in ("http", "https"):
            if parsed.netloc != urlparse(BASE_URL).netloc:
                continue
            path = parsed.path
        elif href.startswith("/"):
            path = href.split("?")[0]
        else:
            continue
        if is_in_scope(path):
            paths.append(path)
    return list(set(paths))


def extract_breadcrumbs(html: HTMLParser) -> list[str]:
    """Extract breadcrumbs from og:title meta (AO uses comma-separated hierarchy there)."""
    for meta in html.css("meta"):
        prop = meta.attributes.get("property", "") or meta.attributes.get("name", "")
        if prop in ("og:title", "og:description"):
            content = (meta.attributes.get("content") or "").strip()
            if "," in content:
                parts = [p.strip().title() for p in content.split(",") if p.strip()]
                if parts:
                    return parts
    return []


def extract_title(html: HTMLParser) -> str:
    # AO uses <h1 class="h1"> for the page title
    h1 = html.css_first("h1.h1") or html.css_first("h1")
    if h1:
        t = h1.text(strip=True)
        if t:
            return t
    title = html.css_first("title")
    return title.text(strip=True).split("|")[0].strip() if title else ""


def _node_to_html(node) -> str:
    """Recursively render a selectolax node to sanitised HTML."""
    if node.tag == "-text":
        return _escape(node.text(strip=False) or "")
    tag = (node.tag or "").lower()
    if tag in ALLOWED_TAGS:
        inner = "".join(_node_to_html(c) for c in node.iter())
        if tag == "br":
            return "<br>"
        return f"<{tag}>{inner}</{tag}>"
    # Unknown tag — just render children (strip wrapper)
    return "".join(_node_to_html(c) for c in node.iter())


def extract_sections(html: HTMLParser, img_srcs_by_section: list | None = None) -> list[dict]:
    """
    AO leaf pages use:
      div.decks > div.detail[data-id='...']
        h2.detail__header   ← section heading
        div.detail__body    ← body (paragraphs, lists, h3/h4)
        img                 ← inline figures (collected per-section into img_srcs_by_section)

    Listing pages (all-approaches, all-diagnoses) use:
      article.information-reference-card

    Fall back to a generic H2/H3 sweep when neither is found.
    """
    sections = []

    # ── Primary: AO leaf page deck structure ─────────────────────────────
    details = html.css("div.detail")
    if details:
        for detail in details:
            heading_node = detail.css_first("h2.detail__header")
            if not heading_node:
                continue
            heading = re.sub(r"^\d+\.\s*", "", heading_node.text(strip=True))
            body = detail.css_first("div.detail__body, div.detail__description")
            body_html = ""
            if body:
                for child in body.css("p, ul, ol, li, h3, h4, table, tr, td, th"):
                    t = child.text(strip=True)
                    if t:
                        body_html += f"<{child.tag}>{_escape(t)}</{child.tag}>"
            # Collect img srcs from THIS detail block
            if img_srcs_by_section is not None:
                srcs = []
                for img in detail.css("img[src]"):
                    src = (img.attributes.get("src") or "").strip()
                    alt = (img.attributes.get("alt") or img.attributes.get("title") or "").strip()
                    if src and not src.lower().endswith(".svg") and ".svg?" not in src.lower():
                        if src.startswith("//"):
                            src = "https:" + src
                        elif src.startswith("/"):
                            src = BASE_URL + src
                        if src.startswith("http"):
                            srcs.append({"src": src, "alt": alt})
                img_srcs_by_section.append(srcs)
            if heading or body_html:
                data_id = detail.attributes.get("data-id", "")
                sid = data_id or heading.lower().replace(" ", "-")[:60]
                sections.append({"id": sid, "heading": heading, "html": body_html, "_nodes": []})
        if sections:
            return sections

    # ── Secondary: AO listing card structure ─────────────────────────────
    cards = html.css("article.information-reference-card")
    if cards:
        for card in cards:
            heading_node = card.css_first("h2.information-reference-card__headline, h2")
            heading = heading_node.text(strip=True) if heading_node else ""
            text_node = card.css_first("div.information-reference-card__text")
            body_html = ""
            if text_node:
                for child in text_node.css("p, li, h3, h4"):
                    t = child.text(strip=True)
                    if t:
                        body_html += f"<{child.tag}>{_escape(t)}</{child.tag}>"
            if heading or body_html:
                sid = heading.lower().replace(" ", "-")[:60] if heading else f"card-{len(sections)}"
                sections.append({"id": sid, "heading": heading, "html": body_html, "_nodes": []})
        if sections:
            return sections

    # ── Fallback: generic H2/H3 sweep ────────────────────────────────────
    current_heading: str | None = None
    current_html = ""
    body_root = html.css_first("main") or html.root

    def flush():
        nonlocal current_html
        if current_heading:
            sid = current_heading.lower().replace(" ", "-")[:60]
            sections.append({"id": sid, "heading": current_heading, "html": current_html, "_nodes": []})
        current_html = ""

    for node in body_root.iter():
        if node.tag in ("h2", "h3"):
            flush()
            current_heading = node.text(strip=True)
        elif current_heading and node.tag in ("p", "li", "h4"):
            t = node.text(strip=True)
            if t:
                current_html += f"<{node.tag}>{_escape(t)}</{node.tag}>"

    flush()
    return sections


async def download_images(
    html: HTMLParser,
    page_dir: Path,
    client: httpx.AsyncClient,
    cache_dir: Path,
    refresh: bool,
) -> list[dict]:
    """Download raster <img> in page (skip SVGs), convert to webp."""
    figures = []
    idx = 0
    for img in html.css("img[src]"):
        src = (img.attributes.get("src") or "").strip()
        if not src:
            continue
        # Skip SVG icons (nav logos, social media, etc.)
        if src.lower().endswith(".svg") or ".svg?" in src.lower():
            continue
        if src.startswith("//"):
            src = "https:" + src
        elif src.startswith("/"):
            src = BASE_URL + src
        elif not src.startswith("http"):
            continue

        fig_name = f"fig-{idx:02d}.webp"
        fig_path = page_dir / fig_name
        caption = (
            img.attributes.get("alt", "") or
            img.attributes.get("title", "") or ""
        ).strip()

        if not fig_path.exists() or refresh:
            raw, status = await fetch_with_retry(client, src, cache_dir, refresh)
            if raw and status == 200:
                try:
                    pil = Image.open(io.BytesIO(raw)).convert("RGB")
                    if pil.width > IMG_MAX_WIDTH:
                        ratio = IMG_MAX_WIDTH / pil.width
                        pil = pil.resize(
                            (IMG_MAX_WIDTH, int(pil.height * ratio)),
                            Image.LANCZOS,
                        )
                    pil.save(str(fig_path), "webp", quality=IMG_QUALITY)
                except Exception:
                    continue  # silently skip unreadable images (SVG, corrupt, etc.)

        figures.append({"file": fig_name, "caption": caption, "original_src": src})
        idx += 1

    return figures


def build_tree(page_map: dict[str, dict]) -> dict:
    """Build nested nav tree from scraped pages using slug structure for hierarchy.

    Intermediate nodes use slug-derived labels (e.g. 'orthopedic-trauma' →
    'Orthopedic Trauma'). Leaf nodes use the scraped page title when available.
    This avoids the breadcrumb-depth mismatch that caused adult-trauma to appear
    at the root level.
    """
    root: dict = {"label": "AO Surgery Reference", "slug": "", "children": []}

    # Build a slug → title lookup for exact page matches
    slug_titles: dict[str, str] = {
        slug: page.get("title", "")
        for slug, page in page_map.items()
        if page.get("title")
    }

    def get_or_create(parent: dict, slug: str) -> dict:
        for child in parent["children"]:
            if child["slug"] == slug:
                return child
        # Use scraped title if this slug has a page, else slug-derived label
        label = slug_titles.get(slug, slug.split("/")[-1].replace("-", " ").title())
        node: dict = {"label": label, "slug": slug, "children": []}
        parent["children"].append(node)
        return node

    for slug in sorted(page_map.keys()):
        parts = slug.split("/")
        node = root
        for i in range(len(parts)):
            partial_slug = "/".join(parts[: i + 1])
            node = get_or_create(node, partial_slug)

    return root


# Anatomy vocabulary: the singular base form is what we emit as a map key.
# Plural and common variants are normalised to these. Cross-checked against
# AO breadcrumb terms + GLB mesh cleanNames in the 3D anatomy scene.
ANATOMY_TERMS: set[str] = {
    # Upper limb
    "humerus", "scapula", "clavicle", "radius", "ulna",
    "carpus", "scaphoid", "lunate", "triquetrum", "pisiform",
    "trapezium", "trapezoid", "capitate", "hamate",
    "metacarpal", "phalanx",
    # Lower limb
    "femur", "patella", "tibia", "fibula",
    "talus", "calcaneus", "navicular", "cuboid", "cuneiform",
    "metatarsal",
    # Axial
    "skull", "mandible", "maxilla", "zygoma", "orbit", "nasal",
    "rib", "sternum", "vertebra", "sacrum", "coccyx",
    "pelvis", "acetabulum", "ilium", "ischium", "pubis",
    # Region descriptors that map to bone surfaces
    "shaft", "proximal", "distal", "head", "neck", "condyle",
    "malleolus", "olecranon", "trochanter",
}

# Plural / spelling normalisations applied before vocabulary lookup.
ANATOMY_SYNONYMS: dict[str, str] = {
    "phalanges": "phalanx",
    "metacarpals": "metacarpal",
    "metatarsals": "metatarsal",
    "vertebrae": "vertebra",
    "cuneiforms": "cuneiform",
    "ribs": "rib",
    "malleoli": "malleolus",
    "condyles": "condyle",
    "trochanters": "trochanter",
    "carpals": "carpus",
    "carpal bones": "carpus",
    "femoral": "femur",
    "humeral": "humerus",
    "tibial": "tibia",
    "fibular": "fibula",
    "radial": "radius",
    "ulnar": "ulna",
    "patellar": "patella",
}


def _normalise_term(raw: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation/side suffixes."""
    s = raw.lower().strip()
    s = re.sub(r"[^a-z0-9\s\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return ANATOMY_SYNONYMS.get(s, s)


def _anatomy_tokens(text: str) -> set[str]:
    """Return the subset of ANATOMY_TERMS found as whole tokens in text."""
    norm = _normalise_term(text)
    if not norm:
        return set()
    # Direct hit on the whole phrase
    if norm in ANATOMY_TERMS:
        return {norm}
    # Word-by-word and synonym lookup
    hits: set[str] = set()
    for token in norm.split():
        canonical = ANATOMY_SYNONYMS.get(token, token)
        if canonical in ANATOMY_TERMS:
            hits.add(canonical)
    return hits


def build_mesh_map(page_map: dict[str, dict]) -> tuple[dict[str, list[str]], list[str]]:
    """
    Map anatomy term → list of AO slugs, using ANATOMY_TERMS as the universe.

    Optionally consults `data/ao/_mesh_names.json` (one-time dump of GLB mesh
    cleanNames) to restrict the term universe further; if absent, the curated
    ANATOMY_TERMS set is used as-is.

    Returns (map, unmatched_terms).
    """
    # If a mesh-name dump exists, intersect with our anatomy vocabulary to
    # avoid emitting terms the 3D scene can't surface (e.g. veterinary-only).
    # Path is resolved by the caller; here we accept a side-channel via env.
    slug_for_term: dict[str, set[str]] = {}
    unmatched_set: set[str] = set()

    for slug, page in page_map.items():
        crumbs = page.get("breadcrumbs", [])
        for crumb in crumbs[1:]:  # skip "AO Surgery Reference" root
            terms = _anatomy_tokens(crumb)
            if terms:
                for t in terms:
                    slug_for_term.setdefault(t, set()).add(slug)
            else:
                norm = _normalise_term(crumb)
                if norm:
                    unmatched_set.add(norm)

    mesh_map = {t: sorted(slugs) for t, slugs in slug_for_term.items()}
    unmatched = sorted(unmatched_set)
    return mesh_map, unmatched


# ── Main scrape loop ─────────────────────────────────────────────────────────

async def scrape(out_dir: Path, refresh: bool, only: str | None):
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = out_dir / "_cache"
    cache_dir.mkdir(exist_ok=True)
    pages_dir = out_dir / "pages"
    pages_dir.mkdir(exist_ok=True)

    page_map: dict[str, dict] = {}
    visited: set[str] = set()
    broken: list[str] = []
    total_bytes = 0

    queue: deque[str] = deque()

    only_prefix: str | None = None
    if only:
        only_prefix = only if only.startswith("/") else f"/{only}"
        queue.append(only_prefix)
    else:
        for p in SEED_PATHS:
            queue.append(p)

    async with httpx.AsyncClient() as client:
        while queue:
            path = queue.popleft()
            # When --only is set, restrict BFS to pages under that prefix
            if only_prefix and not path.startswith(only_prefix):
                continue
            if path in visited:
                continue
            visited.add(path)

            url = urljoin(BASE_URL, path)
            slug = slug_from_path(path)
            page_dir = path_for_slug(out_dir, slug)
            index_file = page_dir / "index.json"

            if index_file.exists() and not refresh:
                # Load existing page into map and continue BFS from its links
                try:
                    existing = json.loads(index_file.read_text(encoding="utf-8"))
                    page_map[slug] = existing
                    for link in existing.get("links", []):
                        lpath = "/" + link.get("slug", "")
                        if lpath not in visited and is_in_scope(lpath):
                            queue.append(lpath)
                except Exception:
                    pass
                continue

            print(f"  Fetching {url}")
            raw, status = await fetch_with_retry(client, url, cache_dir, refresh)
            if raw is None or status not in (200,):
                if status not in (200,):
                    broken.append(url)
                continue

            total_bytes += len(raw)
            html = HTMLParser(raw)
            page_dir.mkdir(parents=True, exist_ok=True)

            title = extract_title(html)
            breadcrumbs = extract_breadcrumbs(html)

            # Per-section image srcs collected during section extraction
            img_srcs_by_section: list = []
            raw_sections = extract_sections(html, img_srcs_by_section)

            # Download per-section figures; fallback to global sweep for non-detail pages
            sections = []
            if img_srcs_by_section and len(img_srcs_by_section) == len(raw_sections):
                # Primary path: figures assigned per detail block
                fig_idx = 0
                for i, s in enumerate(raw_sections):
                    sec_figs = []
                    for item in img_srcs_by_section[i]:
                        src, alt = item["src"], item["alt"]
                        fig_name = f"fig-{fig_idx:02d}.webp"
                        fig_path = page_dir / fig_name
                        if not fig_path.exists() or refresh:
                            raw_img, status = await fetch_with_retry(client, src, cache_dir, refresh)
                            if raw_img and status == 200:
                                try:
                                    pil = Image.open(io.BytesIO(raw_img)).convert("RGB")
                                    if pil.width > IMG_MAX_WIDTH:
                                        ratio = IMG_MAX_WIDTH / pil.width
                                        pil = pil.resize((IMG_MAX_WIDTH, int(pil.height * ratio)), Image.LANCZOS)
                                    pil.save(str(fig_path), "webp", quality=IMG_QUALITY)
                                except Exception:
                                    fig_idx += 1
                                    continue
                        sec_figs.append({"file": fig_name, "caption": alt})
                        fig_idx += 1
                    sections.append({"id": s["id"], "heading": s["heading"], "html": s.get("html", ""), "figures": sec_figs})
            else:
                # Fallback: global image download, distribute to last section
                figures = await download_images(html, page_dir, client, cache_dir, refresh)
                for s in raw_sections:
                    sections.append({"id": s["id"], "heading": s["heading"], "html": s.get("html", ""), "figures": []})
                if sections and figures:
                    sections[-1]["figures"] = figures
                elif figures:
                    sections.append({"id": "figures", "heading": "Figures", "html": "", "figures": figures})

            # Discover in-scope links for BFS + cross-page link list
            link_paths = extract_links(html, BASE_URL)
            cross_links = []
            for lp in link_paths:
                ls = slug_from_path(lp)
                cross_links.append({"slug": ls, "label": ls.replace("-", " ").title()})
                if lp not in visited:
                    queue.append(lp)

            page_data = {
                "title": title,
                "breadcrumbs": breadcrumbs,
                "sections": sections,
                "links": cross_links,
            }
            page_map[slug] = page_data
            index_file.write_text(json.dumps(page_data, ensure_ascii=False, indent=2), encoding="utf-8")

    write_indexes(out_dir, page_map, broken=broken, total_bytes=total_bytes)


def write_indexes(
    out_dir: Path,
    page_map: dict[str, dict],
    *,
    broken: list[str] | None = None,
    total_bytes: int = 0,
) -> None:
    """Generate tree.json, mesh_map.json, _unmatched.txt, MANIFEST.json + report."""
    broken = broken or []

    tree = build_tree(page_map)
    (out_dir / "tree.json").write_text(
        json.dumps(tree, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    mesh_map, unmatched = build_mesh_map(page_map)
    (out_dir / "mesh_map.json").write_text(
        json.dumps(mesh_map, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (out_dir / "_unmatched.txt").write_text(
        "\n".join(unmatched), encoding="utf-8"
    )

    # Per-category counts: top-level slug segment (e.g. "orthopedic-trauma")
    category_counts: dict[str, int] = {}
    for slug in page_map.keys():
        top = slug.split("/", 1)[0] if slug else "(root)"
        category_counts[top] = category_counts.get(top, 0) + 1

    # Estimate on-disk bytes if not provided (covers --rebuild-indexes runs).
    if not total_bytes:
        pages_dir = out_dir / "pages"
        if pages_dir.exists():
            total_bytes = sum(
                f.stat().st_size for f in pages_dir.rglob("*") if f.is_file()
            )

    manifest = {
        "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "page_count": len(page_map),
        "bytes_on_disk": total_bytes,
        "category_counts": dict(sorted(category_counts.items())),
        "mesh_terms": len(mesh_map),
        "unmatched_terms": len(unmatched),
        "broken_links": len(broken),
    }
    (out_dir / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("\n-- AO Scrape Report --")
    print(f"  Pages collected : {len(page_map)}")
    print(f"  Bytes on disk   : {total_bytes:,}")
    print(f"  Mesh terms      : {len(mesh_map)}")
    print(f"  Unmatched terms : {len(unmatched)}")
    print(f"  Broken links    : {len(broken)}")
    print("  By category:")
    for cat, n in sorted(category_counts.items()):
        print(f"    {cat:30s} {n:5d}")
    if broken:
        print("  Broken (first 10):")
        for b in broken[:10]:
            print(f"    {b}")
    print("----------------------")


def rebuild_indexes(out_dir: Path) -> None:
    """Walk pages/**/index.json on disk and regenerate tree/mesh/manifest.

    No network. Useful after a partial scrape, or to apply a new mesh-map
    vocabulary without re-fetching.
    """
    pages_dir = out_dir / "pages"
    if not pages_dir.exists():
        print(f"No pages directory at {pages_dir} — nothing to rebuild.")
        return

    page_map: dict[str, dict] = {}
    for idx_file in pages_dir.rglob("index.json"):
        slug = str(idx_file.parent.relative_to(pages_dir)).replace("\\", "/")
        try:
            page_map[slug] = json.loads(idx_file.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"  Skipping unreadable {idx_file}: {exc}")

    print(f"Loaded {len(page_map)} pages from {pages_dir}")
    write_indexes(out_dir, page_map)


def main():
    parser = argparse.ArgumentParser(description="AO Surgery Reference offline scraper")
    default_out = str(Path(__file__).resolve().parents[2] / "data" / "ao")
    parser.add_argument("--out", default=default_out, help="Output directory")
    parser.add_argument("--refresh", action="store_true", help="Re-fetch all pages ignoring cache")
    parser.add_argument("--reprocess", action="store_true",
                        help="Delete pages/ and re-extract from _cache/ without re-fetching")
    parser.add_argument("--only", default=None, help="Restrict crawl to a single path prefix")
    parser.add_argument("--rebuild-indexes", action="store_true",
                        help="Skip network; rebuild tree.json / mesh_map.json / MANIFEST.json from pages/ on disk")
    args = parser.parse_args()

    out_dir = Path(args.out)

    if args.rebuild_indexes:
        rebuild_indexes(out_dir)
        return

    if args.reprocess:
        import shutil
        pages_dir = out_dir / "pages"
        if pages_dir.exists():
            shutil.rmtree(pages_dir)
            print(f"Wiped {pages_dir} — will re-extract from _cache/")

    print(f"AO scraper -> {out_dir}")
    # --reprocess wipes pages/ but reuses the HTTP _cache/ (refresh=False)
    # --refresh wipes both: forces new HTTP fetches
    asyncio.run(scrape(out_dir, refresh=args.refresh, only=args.only))


if __name__ == "__main__":
    main()

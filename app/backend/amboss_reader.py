"""
AMBOSS reader — FastAPI router.

Serves the iMedicalDoctor `amboss-2025` bundle at full fidelity by decrypting
the `Docs.doc` column (see `amboss_crypto.py`) and rewriting asset URLs to
point at our static mount (`/amboss/static/…`) and image endpoint
(`/amboss/image/…`).

Endpoints
---------
- `/amboss/specialties`          Root TOC entries
- `/amboss/toc/{toc_id}`         Children of a TOC node
- `/amboss/search`, `/autocomplete`
                                  Title-prefix / substring lookup
- `/amboss/article/{doc_id}`     Fully decrypted article HTML (iframe-ready)
- `/amboss/article/{doc_id}/json` Decrypted HTML + metadata as JSON
- `/amboss/image/{image_name}`   JPEG from the bundled Images/ directory
- `/amboss/articles`             Paginated list of all articles
- `/amboss/health`               Decryption self-test (one row)

The `Search_content` FTS table (plaintext) is used for title/search indexes;
the encrypted `Docs.doc` is now fully decrypted for content rendering, so the
old FTS-based text extraction has been retired.
"""
from __future__ import annotations

import base64
import binascii
import io
import hashlib
import html as html_lib
import json
import os
import re
import sqlite3
import unicodedata
import zipfile
import difflib
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field
from selectolax.parser import HTMLParser

import umls_reader
from article_export import (
    PrintDocument,
    PrintSection,
    render_print_document,
    sanitize_print_fragment,
)
from config import AMBOSS_DIR
from amboss_crypto import decrypt_doc, lcid_to_id, self_test
from media_interop import media_interop_head
from reader_annotations import annotation_bridge

# ─── Config ─────────────────────────────────────────────────────────────────
BASE       = Path(__file__).parent
STATIC_DIR = BASE / "amboss_static"

router = APIRouter(prefix="/amboss", tags=["AMBOSS"])


class ScanRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=120000)
    limit: int = Field(default=80, ge=1, le=250)


def _bundle_dir() -> Path:
    raw = os.environ.get("AMBOSS_DIR", "").strip()
    configured = Path(raw) if raw else None
    p = configured if configured and configured.exists() else AMBOSS_DIR
    if not p.exists():
        raise HTTPException(503, f"AMBOSS_DIR does not exist: {p}")
    return p


def images_dir() -> Optional[Path]:
    """Return the bundle's Images/ folder if it exists, for static mounting."""
    raw = os.environ.get("AMBOSS_DIR", "").strip()
    configured = Path(raw) if raw else None
    base = configured if configured and configured.exists() else AMBOSS_DIR
    p = base / "Images"
    return p if p.exists() else None


def _db_path() -> Path:
    p = _bundle_dir() / "amboss-2025.db"
    if not p.exists():
        raise HTTPException(503, f"amboss-2025.db not found in {_bundle_dir()}")
    return p


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{_db_path()}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


# ─── HTML rewriter ──────────────────────────────────────────────────────────
#
# Turns the self-contained APK-side HTML into an iframe-hostable document that
# pulls assets from our backend instead of relative paths on a filesystem.

# Every stylesheet / script / font URL the article template references.
_LOCAL_ASSETS = {
    "animation.css", "base.css",
    "a.min.js", "blueshift.js", "2.js", "3.js", "9.js",
    # am1.css / am3.css are referenced but never shipped by the app —
    # they get rewritten to harmless empty files too (handled below).
    "am1.css", "am3.css",
    "Lato.300.italic.woff", "Lato.300.italic.woff2",
    "Lato.300.normal.woff", "Lato.300.normal.woff2",
    "Lato.400.italic.woff", "Lato.400.italic.woff2",
    "Lato.400.normal.woff", "Lato.400.normal.woff2",
    "Lato.600.normal.woff", "Lato.600.normal.woff2",
    "Lato.700.italic.woff", "Lato.700.italic.woff2",
    "Lato.700.normal.woff", "Lato.700.normal.woff2",
    "Lato.900.normal.woff", "Lato.900.normal.woff2",
}

_ASSETS_MISSING = {"am1.css", "am3.css"}  # never shipped; stub with empty files
_BLOCKED_IMAGE_NAMES = {
    # Promotional calculator screenshot that overwhelms Anki/concept media cards.
    "big_5f61d6243023a.jpg",
    "big_5f60715a617b1.jpg",
}
_BLOCKED_IMAGE_SIZES = {25005}
_BLOCKED_IMAGE_SHA256 = {
    # Same "Calculate by QxMD" promo screenshot appears under many AMBOSS names.
    "278e88214f64eb4e0b07d8943ccf27d11fa529aab723372c279823d5073ed2a8",
}

# Precompile once
_RE_HREF = re.compile(r'(href=")([^"]+\.css)(")')
_RE_HREF_SINGLE = re.compile(r"(href=')([^']+\.css)(')", re.IGNORECASE)
_RE_SRC  = re.compile(r'(src=")([^"]+\.js)(")')
_RE_SRC_SINGLE = re.compile(r"(src=')([^']+\.js)(')", re.IGNORECASE)
_RE_URL  = re.compile(r'url\("([^"]+\.woff2?)"\)')
_RE_URL_SINGLE = re.compile(r"url\('([^']+\.woff2?)'\)", re.IGNORECASE)
_RE_IMG_DATA_SOURCE = re.compile(r'(data-source=")\.\./Images/([^"]+)(")')
_RE_IMG_DATA_SOURCE_SINGLE = re.compile(
    r"(data-source=')\.\./Images/([^']+)(')", re.IGNORECASE
)
_RE_IMG_DATA_SOURCE_URL = re.compile(
    r'(data-source=")([^"]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"]*)?)(")',
    re.IGNORECASE,
)
_RE_IMG_DATA_SOURCE_URL_SINGLE = re.compile(
    r"(data-source=')([^']+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^']*)?)(')",
    re.IGNORECASE,
)
_RE_IMG_SRC_REL     = re.compile(r'(<img[^>]*\ssrc=")\.\./Images/([^"]+)(")')
_RE_IMG_SRC_REL_SINGLE = re.compile(
    r"(<img[^>]*\ssrc=')\.\./Images/([^']+)(')", re.IGNORECASE
)
_RE_IMG_TAG         = re.compile(r'<img\b[^>]*>', re.IGNORECASE)
_RE_IMG_ATTR_URL    = re.compile(r'\b(?:src|data-source)=["\']([^"\']+)["\']', re.IGNORECASE)
_RE_SCRIPT_BLOCK    = re.compile(
    r'(<script\b[^>]*>)(.*?)(</script>)',
    re.DOTALL | re.IGNORECASE,
)
_RE_BODY_CLOSE      = re.compile(r'</body>', re.IGNORECASE)


def _image_basename(image_name: str) -> str:
    return Path(str(image_name).split("?", 1)[0]).name


@lru_cache(maxsize=8192)
def _is_blocked_image_hash(image_name: str) -> bool:
    name = _image_basename(image_name)
    if not name:
        return False
    try:
        img_path = _bundle_dir() / "Images" / name
        if not img_path.is_file():
            return False
        if img_path.stat().st_size not in _BLOCKED_IMAGE_SIZES:
            return False
        digest = hashlib.sha256(img_path.read_bytes()).hexdigest()
    except (OSError, HTTPException):
        return False
    return digest in _BLOCKED_IMAGE_SHA256


def _is_blocked_image_name(image_name: str) -> bool:
    basename = _image_basename(image_name).lower()
    return basename in _BLOCKED_IMAGE_NAMES or _is_blocked_image_hash(basename)


def _strip_blocked_images(html: str) -> str:
    def _keep_or_strip(match: re.Match) -> str:
        tag = match.group(0)
        if any(_is_blocked_image_name(url) for url in _RE_IMG_ATTR_URL.findall(tag)):
            return ""
        if any(name in tag.lower() for name in _BLOCKED_IMAGE_NAMES):
            return ""
        return tag

    return _RE_IMG_TAG.sub(_keep_or_strip, html)


@lru_cache(maxsize=4096)
def card_images(doc_id: int, limit: int = 10) -> list[dict]:
    """Image filenames embedded in one decrypted AMBOSS learning card, as /image
    URLs — for the UMLS media wall. Best-effort; returns [] on any failure.
    Cached per card (decryption of the ~700KB card is the cost)."""
    try:
        c = _conn()
        try:
            row = c.execute("SELECT id, title, doc FROM Docs WHERE id=?", (doc_id,)).fetchone()
        finally:
            c.close()
        if not row or not row["doc"]:
            return []
        html = decrypt_doc(row["id"], row["doc"])
    except Exception:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for rx in (_RE_IMG_SRC_REL, _RE_IMG_DATA_SOURCE):
        for m in rx.finditer(html):
            name = m.group(2)
            if _is_blocked_image_name(name):
                continue
            if name in seen:
                continue
            seen.add(name)
            out.append({"name": name, "url": f"/amboss/image/{name}", "title": row["title"] or ""})
            if len(out) >= limit:
                return out
    return out


def _rewrite_asset_name(name: str) -> str:
    """Map an asset basename to its served URL."""
    base = name.rsplit("/", 1)[-1]
    if base in _ASSETS_MISSING:
        return f"/amboss/stub/{base}"
    if base in _LOCAL_ASSETS:
        return f"/amboss/static/{base}"
    return name  # unknown — leave untouched


def _rewrite_article_assets(html: str) -> str:
    """Route bundled AMBOSS assets through local endpoints."""
    html = _strip_blocked_images(html or "")
    html = _RE_HREF.sub(
        lambda match: (
            f'{match.group(1)}{_rewrite_asset_name(match.group(2))}{match.group(3)}'
        ),
        html,
    )
    html = _RE_HREF_SINGLE.sub(
        lambda match: (
            f'{match.group(1)}{_rewrite_asset_name(match.group(2))}{match.group(3)}'
        ),
        html,
    )
    html = _RE_SRC.sub(
        lambda match: (
            f'{match.group(1)}{_rewrite_asset_name(match.group(2))}{match.group(3)}'
        ),
        html,
    )
    html = _RE_SRC_SINGLE.sub(
        lambda match: (
            f'{match.group(1)}{_rewrite_asset_name(match.group(2))}{match.group(3)}'
        ),
        html,
    )
    html = _RE_URL.sub(
        lambda match: f'url("{_rewrite_asset_name(match.group(1))}")', html
    )
    html = _RE_URL_SINGLE.sub(
        lambda match: f"url('{_rewrite_asset_name(match.group(1))}')", html
    )
    html = _RE_IMG_DATA_SOURCE.sub(
        lambda match: (
            f'{match.group(1)}/amboss/image/{match.group(2)}{match.group(3)}'
        ),
        html,
    )
    html = _RE_IMG_DATA_SOURCE_SINGLE.sub(
        lambda match: (
            f'{match.group(1)}/amboss/image/{match.group(2)}{match.group(3)}'
        ),
        html,
    )

    def rewrite_data_source(match: re.Match) -> str:
        value = match.group(2)
        if _is_network_reference(value):
            return match.group(0)
        return (
            f'{match.group(1)}/amboss/image/'
            f'{value.split("/")[-1].split("?")[0]}{match.group(3)}'
        )

    html = _RE_IMG_DATA_SOURCE_URL.sub(rewrite_data_source, html)
    html = _RE_IMG_DATA_SOURCE_URL_SINGLE.sub(rewrite_data_source, html)
    html = _RE_IMG_SRC_REL.sub(
        lambda match: (
            f'{match.group(1)}/amboss/image/{match.group(2)}{match.group(3)}'
        ),
        html,
    )
    return _RE_IMG_SRC_REL_SINGLE.sub(
        lambda match: (
            f'{match.group(1)}/amboss/image/{match.group(2)}{match.group(3)}'
        ),
        html,
    )


def _is_network_reference(value: str) -> bool:
    return bool(re.match(r"^(?:https?:)?//", str(value).strip(), re.IGNORECASE))


_SAFE_DATA_IMAGE = re.compile(
    r"^data:image/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/]+={0,2}$",
    re.IGNORECASE,
)
_PRINT_IMAGE_EXTENSION = re.compile(
    r"\.(?:avif|gif|jpe?g|png|webp)$", re.IGNORECASE
)


def _print_image_url(value: str) -> str:
    """Return a safe local/data image URL, rewriting bundled relative paths."""
    candidate = str(value or "").strip()
    if not candidate or _is_network_reference(candidate):
        return ""
    if candidate.lower().startswith("data:"):
        return candidate if _SAFE_DATA_IMAGE.fullmatch(candidate) else ""
    if re.match(r"^[a-z][a-z0-9+.-]*:", candidate, re.IGNORECASE):
        return ""

    path = candidate.split("#", 1)[0].split("?", 1)[0]
    basename = path.replace("\\", "/").rsplit("/", 1)[-1]
    if basename and _is_blocked_image_name(basename):
        return ""
    if candidate.startswith("/amboss/image/"):
        return candidate
    if candidate.startswith("/amboss/Images/"):
        return f"/amboss/image/{basename}"
    if candidate.startswith("/"):
        return candidate
    if _PRINT_IMAGE_EXTENSION.search(path):
        return f"/amboss/image/{basename}"
    return ""


def _srcset_candidates(value: str) -> list[tuple[str, str]]:
    """Parse ordinary srcset candidates without splitting a data-URI comma."""
    source = str(value or "")
    candidates: list[tuple[str, str]] = []
    position = 0
    length = len(source)
    while position < length:
        while position < length and (source[position].isspace() or source[position] == ","):
            position += 1
        if position >= length:
            break

        url_start = position
        is_data = source[position : position + 5].lower() == "data:"
        if is_data:
            data_separator = source.find(",", position)
            if data_separator < 0:
                break
            position = data_separator + 1
            while position < length and not source[position].isspace() and source[position] != ",":
                position += 1
        else:
            while position < length and not source[position].isspace() and source[position] != ",":
                position += 1
        url = source[url_start:position]

        while position < length and source[position].isspace():
            position += 1
        descriptor_start = position
        while position < length and source[position] != ",":
            position += 1
        descriptor = " ".join(source[descriptor_start:position].split())
        if url:
            candidates.append((url, descriptor))
        if position < length:
            position += 1
    return candidates


def _print_srcset(value: str) -> str:
    retained: list[str] = []
    for url, descriptor in _srcset_candidates(value):
        rewritten = _print_image_url(url)
        if not rewritten:
            continue
        retained.append(f"{rewritten} {descriptor}".strip())
    return ", ".join(retained)


def _best_print_srcset_image(value: str) -> str:
    """Choose the largest safe local candidate for static print output."""
    candidates: list[tuple[str, str]] = []
    for url, descriptor in _srcset_candidates(value):
        rewritten = _print_image_url(url)
        if rewritten:
            candidates.append((rewritten, descriptor.lower()))
    if not candidates:
        return ""

    width_candidates: list[tuple[float, int, str]] = []
    density_candidates: list[tuple[float, int, str]] = []
    fallback: list[tuple[int, str]] = []
    for index, (url, descriptor) in enumerate(candidates):
        width = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)w", descriptor)
        density = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)x", descriptor)
        if width:
            width_candidates.append((float(width.group(1)), index, url))
        elif density:
            density_candidates.append((float(density.group(1)), index, url))
        else:
            fallback.append((index, url))
    if width_candidates:
        return max(width_candidates)[2]
    if density_candidates:
        return max(density_candidates)[2]
    return fallback[-1][1] if fallback else candidates[-1][0]


def _normalize_amboss_print_images(tree: HTMLParser) -> None:
    """Promote full local sources and collapse responsive previews for print."""
    for host in tree.css("[data-source]"):
        lazy_source = _print_image_url(host.attributes.get("data-source") or "")
        targets = [host] if host.tag in {"img", "source"} else host.css("img,source")
        for target in targets:
            if target is not host and target.attributes.get("data-source"):
                continue
            if lazy_source:
                target.attrs["src"] = lazy_source
                for attribute in ("srcset", "sizes"):
                    if attribute in target.attributes:
                        del target.attrs[attribute]
        del host.attrs["data-source"]

    for node in tree.css("img,source"):
        source = _print_image_url(node.attributes.get("src") or "")
        responsive_source = _best_print_srcset_image(
            node.attributes.get("srcset") or ""
        )
        if responsive_source and not source.startswith("/amboss/image/big_"):
            source = responsive_source
        if source:
            node.attrs["src"] = source
        elif "src" in node.attributes:
            del node.attrs["src"]

        if "srcset" in node.attributes:
            del node.attrs["srcset"]
        if "sizes" in node.attributes:
            del node.attrs["sizes"]


def _decode_amboss_metadata_text(value: str) -> str:
    """Decode AMBOSS metadata to inert readable text."""
    token = str(value or "").strip()
    if not token:
        return ""
    try:
        decoded = base64.b64decode(token, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ""
    return " ".join(HTMLParser(decoded).text(separator=" ", strip=True).split())


def _add_amboss_print_image_context(tree: HTMLParser) -> None:
    """Turn AMBOSS image tokens into full-resolution, captioned print figures."""
    for host in list(tree.css('[data-type="image"]')):
        image = host.css_first("img")
        if image is None:
            continue
        full_source = _print_image_url(host.attributes.get("data-source") or "")
        if full_source:
            image.attrs["src"] = full_source
        for attribute in ("srcset", "sizes"):
            if attribute in image.attributes:
                del image.attrs[attribute]

        title = _decode_amboss_metadata_text(host.attributes.get("data-title") or "")
        description = _decode_amboss_metadata_text(
            host.attributes.get("data-description") or ""
        )
        caption_parts: list[str] = []
        if title:
            caption_parts.append(f"<strong>{html_lib.escape(title)}</strong>")
        if description and description.casefold() != title.casefold():
            caption_parts.append(f"<span>{html_lib.escape(description)}</span>")
        caption = ""
        if caption_parts:
            caption = "<figcaption>" + " — ".join(caption_parts) + "</figcaption>"
        fragment = HTMLParser(
            '<figure class="amboss-context-figure">'
            + image.html
            + caption
            + "</figure>"
        ).css_first("figure")
        if fragment is None:
            continue
        host.insert_before(fragment)
        host.decompose()


def _normalize_amboss_print_backgrounds(tree: HTMLParser) -> None:
    """Route bundled legacy backgrounds through the local AMBOSS image endpoint."""

    for node in tree.css("[background]"):
        rewritten = _print_image_url(node.attributes.get("background") or "")
        if rewritten.startswith("/amboss/image/") or rewritten.lower().startswith(
            "data:image/"
        ):
            node.attrs["background"] = rewritten
        else:
            del node.attrs["background"]


def _fragment_inner_html(tree: HTMLParser) -> str:
    if not tree.body:
        return tree.html
    markup = tree.body.html
    start = markup.find(">") + 1
    end = markup.rfind("</")
    return markup[start:end] if start > 0 and end >= start else markup


def _sanitize_amboss_print_fragment(fragment: str) -> str:
    """Make rewritten AMBOSS markup inert and prevent automatic network loads."""
    rewritten = HTMLParser(_rewrite_article_assets(fragment))
    _add_amboss_print_image_context(rewritten)
    _normalize_amboss_print_backgrounds(rewritten)
    _normalize_amboss_print_images(rewritten)
    tree = HTMLParser(sanitize_print_fragment(rewritten.html))
    for node in tree.css("style,link"):
        node.decompose()
    for node in tree.css("[data-content]"):
        del node.attrs["data-content"]
    for node in tree.css("video,audio,track,image,use"):
        for attribute in (
            "src",
            "poster",
            "href",
            "xlink:href",
        ):
            value = node.attributes.get(attribute)
            if not value:
                continue
            if _is_network_reference(str(value)):
                del node.attrs[attribute]
    for node in tree.css("[style]"):
        style = str(node.attributes.get("style") or "")
        scrubbed = re.sub(
            r"url\(\s*(['\"]?)(.*?)\1\s*\)",
            lambda match: (
                "none" if _is_network_reference(match.group(2)) else match.group(0)
            ),
            style,
            flags=re.IGNORECASE,
        )
        if scrubbed.strip():
            node.attrs["style"] = scrubbed
        else:
            del node.attrs["style"]
    return _fragment_inner_html(tree)


def _decode_print_linked_content(html: str) -> list[tuple[str, str]]:
    """Return labelled visual/table popups; omit interactive glossary prose."""
    fragments: list[tuple[str, str]] = []
    seen: set[str] = set()
    tree = HTMLParser(html or "")
    for node in tree.css("[data-content]"):
        token = str(node.attributes.get("data-content") or "")
        try:
            decoded = base64.b64decode(token, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
        fragment = _sanitize_amboss_print_fragment(decoded)
        parsed = HTMLParser(fragment)
        if parsed.css_first("img,table,figure,figcaption") is None:
            continue
        digest = hashlib.sha256(fragment.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        label = " ".join(node.text(separator=" ", strip=True).split())
        if not label:
            caption = parsed.css_first("figcaption")
            label = (
                " ".join(caption.text(separator=" ", strip=True).split())
                if caption is not None
                else "Linked clinical media"
            )
        fragments.append((label, fragment))
    return fragments


def _render_amboss_print(doc_id: int, title: str, decrypted_html: str) -> str:
    """Render a complete AMBOSS article and its locally bundled popup appendix."""
    rewritten = _rewrite_article_assets(decrypted_html)
    tree = HTMLParser(rewritten)
    article_node = tree.css_first("article")
    body_html = article_node.html if article_node else _fragment_inner_html(tree)
    body_html = _sanitize_amboss_print_fragment(body_html)
    linked = _decode_print_linked_content(decrypted_html)
    sections = (
        (
            PrintSection(
                "Linked content",
                "".join(
                    '<section class="amboss-linked-content-item">'
                    f"<h3>{html_lib.escape(label)}</h3>{fragment}</section>"
                    for label, fragment in linked
                ),
            ),
        )
        if linked
        else ()
    )
    return render_print_document(
        PrintDocument(
            title=title,
            source="AMBOSS",
            source_url=f"/amboss/article/{doc_id}",
            body_html=body_html,
            sections=sections,
            citation="AMBOSS local licensed content",
        )
    )


_DARK_ARTICLE_CSS = r"""
<style id="medos-amboss-dark-theme">
html,
body {
  color-scheme: dark !important;
  background: #0f172a !important;
  color: #e5edf8 !important;
}
body,
article,
article > div,
article section,
[name="article-canvas"],
[class*="container-"],
[class*="articleContainer-"],
[class*="flushTop-"] {
  background: #0f172a !important;
  color: #e5edf8 !important;
}
p,
li,
div,
span,
td,
th,
label,
dd,
dt,
blockquote {
  color: #e5edf8 !important;
}
h1,
h2,
h3,
h4,
h5,
h6,
strong,
b {
  color: #f8fafc !important;
}
h2 {
  border-bottom-color: #2dd4bf !important;
}
a {
  color: #5eead4 !important;
}
table,
.table-default-style,
.table-header-footer-style,
.table-footer-only-style {
  background: #111827 !important;
  border-color: #334155 !important;
  color: #e5edf8 !important;
}
thead,
tbody,
tfoot,
tr {
  background: transparent !important;
}
th,
td {
  background: #111827 !important;
  border-color: #334155 !important;
  color: #e5edf8 !important;
}
tr:nth-child(even) td {
  background: #172033 !important;
}
img,
video,
canvas {
  background: #ffffff !important;
}
.medos-acc-hdr:hover {
  background: linear-gradient(90deg, rgba(45,212,191,0.18), rgba(15,23,42,0) 78%) !important;
}
.medos-acc-hdr.medos-closed {
  box-shadow: 0 1px 0 rgba(45,212,191,0.22) !important;
}
.medos-ch {
  background: rgba(45,212,191,0.16) !important;
  color: #99f6e4 !important;
}
.amboss-popup-card,
.amboss-popup-header,
.amboss-popup-body {
  background: #111827 !important;
  color: #e5edf8 !important;
  border-color: #334155 !important;
}
.amboss-popup-close {
  background: #172033 !important;
  border-color: #334155 !important;
  color: #e5edf8 !important;
}
[class*="highlight"],
.highlight {
  background: rgba(251, 191, 36, 0.28) !important;
  color: #f8fafc !important;
}
</style>
"""


def _rewrite_html(
    doc_id: int,
    html: str,
    theme: str = "light",
    title: str = "",
) -> str:
    """Rewrite resource URLs + inject navigation bridge into decrypted HTML."""
    html = _rewrite_article_assets(html)

    # 3) Replace the in-article navigation script so clicks bubble up to our
    #    React host instead of doing a navigate to `<lcid>.html` that would
    #    404 inside the iframe.
    nav_script = media_interop_head(
        "AMBOSS",
        title or f"AMBOSS article {doc_id}",
        f"/amboss/article/{doc_id}",
        f"/amboss/article/{doc_id}/print",
    ) + r"""
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=3.0, user-scalable=yes">
<style>
/* ── Base reset for mobile-first rendering ────────────────── */
html,
body {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  overflow-x: hidden;
  background: #ffffff;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
body {
  margin: 0 !important;
  padding: 0 !important;
  font-family: Lato, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: #1a1c1c;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ── Full-width article container (like native AMBOSS app) ── */
.base-1538397270,
[name="article-canvas"],
[class*="container-3147505579"],
[class*="flushTop-3533219155"],
[class*="articleContainer-4000328499"],
article {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
}
article {
  padding: 12px 20px 60px !important;
}
/* The reader toolbar already shows the article title + ICD, so hide the
   in-article title header (the duplicate <h1> + "Last updated" + divider) and
   collapse the native "island"/"flushTop" wrapper spacing (added at runtime by
   a.min.js). The article begins directly at its first content section (e.g.
   "Summary"), tight under the toolbar — matching the UWorld reader.
   NOTE: per the AMBOSS structure, `article > section` is ONLY the title header;
   content sections live at `article > div > section`, so this never hides body. */
article > section {
  display: none !important;
}
.base-1538397270,
[name="article-canvas"],
[class*="container-3147505579"],
[class*="flushTop-3533219155"],
[class*="island-2933729044"],
[class*="articleContainer-4000328499"],
article > div:first-child {
  padding-top: 0 !important;
  margin-top: 0 !important;
  min-height: 0 !important;
}
/* First content section sits tight under the toolbar. */
article > div:first-of-type section:first-of-type h2 {
  margin-top: 6px !important;
}
[class*="articleMaxWidth"],
[class*="widePadding"],
[class*="container-"][class*="widePadding"],
[class*="header-"][class*="widePadding"],
article section,
article > div {
  width: 100% !important;
  max-width: none !important;
}
[class*="widePadding"],
[class*="container-"][class*="widePadding"],
[class*="header-"][class*="widePadding"] {
  padding-left: 0 !important;
  padding-right: 0 !important;
}

/* ── Article title (h1) — AMBOSS native styling ───────────── */
h1 {
  font-size: 26px !important;
  font-weight: 900 !important;
  line-height: 1.2 !important;
  color: #364149 !important;
  margin: 0 0 8px !important;
}

/* ── Section headers (h2) — AMBOSS green accent ───────────── */
h2 {
  font-size: 18px !important;
  font-weight: 800 !important;
  line-height: 1.3 !important;
  color: #364149 !important;
  margin: 28px 0 12px !important;
  padding: 12px 0 8px !important;
  border-bottom: 2px solid #0DBF8F !important;
  letter-spacing: -0.01em;
}

/* ── Sub-section headers ──────────────────────────────────── */
h3 {
  font-size: 16px !important;
  font-weight: 700 !important;
  color: #4c5b66 !important;
  margin: 20px 0 8px !important;
}

h4 {
  font-size: 15px !important;
  font-weight: 700 !important;
  color: #627583 !important;
  margin: 16px 0 6px !important;
}

/* ── Body text ────────────────────────────────────────────── */
p {
  margin: 0 0 12px !important;
  line-height: 1.6 !important;
}

/* ── Lists — proper spacing for readability ───────────────── */
ul, ol {
  padding-left: 20px !important;
  margin: 8px 0 12px !important;
}

li {
  margin-bottom: 4px !important;
  line-height: 1.5 !important;
}

/* ── Tables — horizontal scroll on mobile ─────────────────── */
table {
  border-collapse: collapse;
  margin: 16px 0;
  border: 1px solid #d8e2f0 !important;
  background: #ffffff;
  font-size: 14px;
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-width: 100%;
}
th, td {
  border: 1px solid #d8e2f0 !important;
  padding: 10px 12px;
  vertical-align: top;
  white-space: normal;
  min-width: 80px;
}
th {
  background: #f4f7fb;
  color: #0f172a;
  font-weight: 700;
  font-size: 13px;
  text-transform: none;
  position: sticky;
  top: 0;
  z-index: 1;
}
tr:nth-child(even) td {
  background: #fbfdff;
}
/* Make tables scrollable in a container */
.table-default-style,
.table-header-footer-style,
.table-footer-only-style {
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  margin: 12px 0;
  border-radius: 6px;
}

/* ── Images — responsive with tap-to-zoom ─────────────────── */
img {
  max-width: 100% !important;
  height: auto !important;
  border-radius: 6px;
  display: block;
  margin: 12px auto;
}
[data-type="image"][data-source] {
  display: block;
  margin: 16px 0 20px;
  padding: 0 0 10px;
  border: 1px solid rgba(13, 191, 143, 0.22);
  border-radius: 8px;
  background: rgba(13, 191, 143, 0.025);
  cursor: zoom-in;
  overflow: hidden;
}
[data-type="image"][data-source]:focus-visible,
[data-learningcard-id]:focus-visible {
  outline: 3px solid rgba(13, 191, 143, 0.42);
  outline-offset: 3px;
}
.amboss-image-caption {
  display: block;
  padding: 0 12px;
  color: #475569;
  font-size: 13px;
  line-height: 1.45;
}
.amboss-image-caption strong,
.amboss-image-caption span {
  display: block;
}
.amboss-image-caption strong {
  color: #1f2937;
  font-size: 14px;
  margin-bottom: 3px;
}

/* ── Links — AMBOSS green accent ──────────────────────────── */
a,
[data-learningcard-id] {
  color: #0DBF8F;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  cursor: pointer;
}
a:hover, a:active,
[data-learningcard-id]:hover,
[data-learningcard-id]:active {
  color: #087f65;
  text-decoration-thickness: 2px;
}

/* ── Highlighted text (AMBOSS yellow highlight) ───────────── */
[class*="highlight"],
.highlight {
  background: rgba(251, 188, 118, 0.25) !important;
  padding: 1px 2px;
  border-radius: 2px;
}

/* ── Date/metadata text ───────────────────────────────────── */
[class*="dateText"],
.dateText-1280492965 {
  color: #99a7b3 !important;
  font-size: 13px !important;
}

/* ── Accordion section styling ────────────────────────────── */
.medos-acc-hdr {
  cursor: pointer !important;
  user-select: none !important;
  -webkit-tap-highlight-color: transparent;
  position: relative !important;
  padding: 8px 34px 8px 0 !important;
  border-radius: 7px 7px 0 0;
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.medos-acc-hdr:hover {
  background: linear-gradient(90deg, rgba(13,191,143,0.08), rgba(255,255,255,0) 78%);
}
.medos-acc-hdr.medos-closed {
  box-shadow: 0 1px 0 rgba(13,191,143,0.08);
}
.medos-acc-hdr:active {
  opacity: 0.7;
}
.medos-ch {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: rgba(13,191,143,0.1);
  color: #078966;
  font-size: 12px;
  opacity: 1;
  margin-left: 8px;
  transition: transform 0.22s ease, background 0.2s ease;
}
.medos-acc-body {
  display: block !important;
  overflow: hidden !important;
  max-height: none;
  opacity: 1;
  transform: translateY(0);
  -webkit-mask-image: none;
  mask-image: none;
  transition: max-height 0.4s cubic-bezier(0.22,0.61,0.36,1), opacity 0.24s ease, transform 0.24s ease, -webkit-mask-image 0.2s ease, mask-image 0.2s ease;
  will-change: max-height, opacity, transform;
}
.medos-acc-body.medos-closed {
  display: block !important;
  max-height: 128px;
  opacity: 1;
  transform: translateY(-1px);
  cursor: pointer;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 46%, rgba(0,0,0,0.72) 68%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 46%, rgba(0,0,0,0.72) 68%, transparent 100%);
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}

/* ── Safe area padding for notched devices ─────────────────── */
@supports(padding: env(safe-area-inset-bottom)) {
  article {
    padding-bottom: calc(60px + env(safe-area-inset-bottom)) !important;
  }
}

/* ── Mobile-specific refinements ──────────────────────────── */
@media (max-width: 768px) {
  body {
    font-size: 16px !important;
    line-height: 1.65 !important;
  }
  article {
    padding: 16px 16px 80px !important;
  }
  h1 {
    font-size: 22px !important;
  }
  h2 {
    font-size: 17px !important;
    margin: 24px 0 10px !important;
    padding: 10px 0 6px !important;
  }
  table {
    font-size: 13px !important;
  }
  th, td {
    padding: 8px 10px !important;
    min-width: 60px !important;
  }
}

/* ── Touch device: larger tap targets for interactive elements */
@media (pointer: coarse) {
  .medos-acc-hdr {
    min-height: 48px !important;
    display: flex !important;
    align-items: center !important;
  }
  .medos-acc-body.medos-closed {
    max-height: 116px;
  }
  a[data-learningcard-id],
  [data-content] {
    padding: 4px 2px !important;
  }
}

/* ── Popup/overlay styles ─────────────────────────────────── */
.amboss-popup-backdrop {
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.62);
  z-index: 9999;
}
.amboss-popup-card {
  width: min(920px, 100%);
  max-height: min(88vh, 100%);
  overflow: auto;
  -webkit-overflow-scrolling: touch;
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
  border: 1px solid #d8e2f0;
}
.amboss-popup-header {
  display: flex;
  justify-content: flex-end;
  padding: 10px 12px 0;
  position: sticky;
  top: 0;
  background: #ffffff;
  z-index: 1;
}
.amboss-popup-close {
  border: 1px solid #d8e2f0;
  background: #ffffff;
  color: #475569;
  border-radius: 999px;
  width: 36px;
  height: 36px;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.amboss-popup-body {
  padding: 8px 20px 20px;
}
.amboss-popup-body img {
  max-width: 100%;
  height: auto;
}
</style>
<script>
(function(){
  function normalizeAmbossImageSource(raw){
    if (!raw) return '';
    if (raw.indexOf('/amboss/') === 0) return raw;
    if (raw.indexOf('../Images/') === 0) return '/amboss/image/' + raw.split('/').pop();
    var match = raw.match(/(?:^|\/)([^\/?#]+\.(?:jpe?g|png|gif|webp))(?:\?[^#]*)?$/i);
    return match ? '/amboss/image/' + match[1] : '';
  }

  function hydrateImages(root){
    var scope = root && root.querySelectorAll ? root : document;
    var hosts = [];
    if (scope.matches && scope.matches('[data-source]')) hosts.push(scope);
    if (scope.querySelectorAll) {
      hosts = hosts.concat(Array.from(scope.querySelectorAll('[data-source]')));
    }
    hosts.forEach(function(host){
      var raw = host.getAttribute('data-source') || '';
      var src = normalizeAmbossImageSource(raw);
      if (!src) return;
      var imgs = host.tagName === 'IMG' ? [host] : Array.from(host.querySelectorAll('img'));
      imgs.forEach(function(img){
        img.setAttribute('src', src);
        img.removeAttribute('srcset');
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
      });
    });
  }

  function decodeBase64Utf8(raw){
    var bin = atob(raw);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function decodeMetadataText(raw){
    if (!raw) return '';
    try {
      var parser = new DOMParser();
      var parsed = parser.parseFromString(decodeBase64Utf8(raw), 'text/html');
      return String((parsed.body && parsed.body.textContent) || '').replace(/\s+/g, ' ').trim();
    } catch (err) {
      return '';
    }
  }

  function hydrateArticleInteractions(root){
    var scope = root && root.querySelectorAll ? root : document;
    var links = [];
    var images = [];
    if (scope.matches && scope.matches('[data-learningcard-id]')) links.push(scope);
    if (scope.matches && scope.matches('[data-type="image"][data-source]')) images.push(scope);
    if (scope.querySelectorAll) {
      links = links.concat(Array.from(scope.querySelectorAll('[data-learningcard-id]')));
      images = images.concat(Array.from(scope.querySelectorAll('[data-type="image"][data-source]')));
    }
    links.forEach(function(link){
      if (!link.hasAttribute('role')) link.setAttribute('role', 'link');
      if (!link.hasAttribute('tabindex')) link.setAttribute('tabindex', '0');
      var title = decodeMetadataText(link.getAttribute('data-title') || '');
      if (title && !link.hasAttribute('title')) link.setAttribute('title', 'Open ' + title);
    });
    images.forEach(function(host){
      if (host.getAttribute('data-medos-image-context') === 'ready') return;
      host.setAttribute('data-medos-image-context', 'ready');
      host.setAttribute('role', 'button');
      host.setAttribute('tabindex', '0');
      var title = decodeMetadataText(host.getAttribute('data-title') || '');
      var description = decodeMetadataText(host.getAttribute('data-description') || '');
      host.setAttribute('aria-label', title ? 'Open image: ' + title : 'Open clinical image');
      if (!title && !description) return;
      var caption = document.createElement('span');
      caption.className = 'amboss-image-caption';
      if (title) {
        var heading = document.createElement('strong');
        heading.textContent = title;
        caption.appendChild(heading);
      }
      if (description) {
        var detail = document.createElement('span');
        detail.textContent = description;
        caption.appendChild(detail);
      }
      host.appendChild(caption);
    });
  }

  var modalEls = null;
  function ensureModal(){
    if (modalEls) return modalEls;
    var backdrop = document.createElement('div');
    backdrop.className = 'amboss-popup-backdrop';
    backdrop.innerHTML =
      '<div class="amboss-popup-card" role="dialog" aria-modal="true">' +
        '<div class="amboss-popup-header">' +
          '<button class="amboss-popup-close" type="button" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="amboss-popup-body"></div>' +
      '</div>';
    document.body.appendChild(backdrop);
    var card = backdrop.querySelector('.amboss-popup-card');
    var body = backdrop.querySelector('.amboss-popup-body');
    function closeModal(){
      backdrop.style.display = 'none';
      body.innerHTML = '';
      document.body.style.overflow = '';
    }
    backdrop.addEventListener('click', function(ev){
      if (ev.target === backdrop) closeModal();
    });
    backdrop.querySelector('.amboss-popup-close').addEventListener('click', closeModal);
    document.addEventListener('keydown', function(ev){
      if (ev.key === 'Escape' && backdrop.style.display === 'flex') closeModal();
    });
    modalEls = { backdrop: backdrop, card: card, body: body, close: closeModal };
    return modalEls;
  }

  function openContentPopup(encoded){
    if (!encoded) return;
    var modal = ensureModal();
    try {
      modal.body.innerHTML = decodeBase64Utf8(encoded);
    } catch (err) {
      console.error('[amboss-popup] decode failed', err);
      return;
    }
    hydrateImages(modal.body);
    modal.backdrop.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function openImagePopup(host){
    var modal = ensureModal();
    var raw = host.getAttribute('data-source') || '';
    var src = normalizeAmbossImageSource(raw);
    var title = decodeMetadataText(host.getAttribute('data-title') || '');
    var description = decodeMetadataText(host.getAttribute('data-description') || '');
    var copyright = decodeMetadataText(host.getAttribute('data-copyright') || '');
    modal.body.innerHTML = '';
    if (title) {
      var heading = document.createElement('h3');
      heading.textContent = title;
      modal.body.appendChild(heading);
    }
    if (src) {
      var image = document.createElement('img');
      image.src = src;
      image.alt = title || 'Clinical image';
      modal.body.appendChild(image);
    }
    [description, copyright].forEach(function(value, index){
      if (!value) return;
      var paragraph = document.createElement('p');
      paragraph.textContent = value;
      if (index === 1) paragraph.style.fontSize = '12px';
      modal.body.appendChild(paragraph);
    });
    modal.backdrop.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      hydrateImages(document);
      hydrateArticleInteractions(document);
    });
  } else {
    hydrateImages(document);
    hydrateArticleInteractions(document);
  }

  var observer = new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      m.addedNodes.forEach(function(node){
        if (node && node.nodeType === 1) {
          hydrateImages(node);
          hydrateArticleInteractions(node);
        }
      });
    });
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', function(e){
    var imageTrigger = e.target.closest && e.target.closest('[data-type="image"][data-source]');
    if (imageTrigger && !imageTrigger.closest('.amboss-popup-card')) {
      e.preventDefault();
      e.stopPropagation();
      openImagePopup(imageTrigger);
      return false;
    }
    var trigger = e.target.closest && e.target.closest('[data-content]');
    if (!trigger) return;
    if (trigger.closest('.amboss-popup-card')) return;
    if (trigger.hasAttribute('data-learningcard-id')) return;
    e.preventDefault();
    e.stopPropagation();
    openContentPopup(trigger.getAttribute('data-content') || '');
    return false;
  }, true);
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var trigger = ev.target.closest && ev.target.closest(
      '[data-learningcard-id], [data-type="image"][data-source]'
    );
    if (!trigger) return;
    ev.preventDefault();
    trigger.click();
  }, true);
})();
</script>
<script>
(function(){
  function postNav(lcid, section){
    if (window.parent) {
      window.parent.postMessage({type:'amboss_navigate', lcid: lcid, section: section || ''}, '*');
    }
  }
  function cleanText(value){
    return String(value||'').replace(/\s+/g,' ').trim().slice(0,140);
  }
  function postImages(){
    var seen={},items=[];
    Array.prototype.forEach.call(document.images||[],function(img){
      var src=img.currentSrc||img.getAttribute('src')||'';
      if(!src||seen[src]) return;
      var w=img.naturalWidth||img.width||0;
      var h=img.naturalHeight||img.height||0;
      if(w&&h&&w<80&&h<80) return;
      seen[src]=true;
      var figure=img.closest&&img.closest('figure');
      var caption=figure&&figure.querySelector&&figure.querySelector('figcaption');
      var title=cleanText(img.getAttribute('alt')||img.getAttribute('title')||(caption&&caption.textContent)||'');
      items.push({src:src,title:title,width:w,height:h});
    });
    if(window.parent) window.parent.postMessage({type:'medos_article_images', source:'amboss', items:items}, '*');
  }
  window.__medosPostImages=postImages;
  document.addEventListener('click', function(e){
    var el = e.target.closest && e.target.closest('[data-learningcard-id]');
    if (el) {
      e.preventDefault(); e.stopPropagation();
      var lcid = el.getAttribute('data-learningcard-id');
      var sec  = el.getAttribute('data-section-id') || '';
      postNav(lcid, sec);
      return false;
    }
    // Fallback: any <a href="xxxx.html"> that points at a learning card
    var a = e.target.closest && e.target.closest('a[href$=".html"]');
    if (a) {
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      var m = href.match(/([A-Za-z0-9_\\-]+)\\.html(?:#(.*))?$/);
      if (m) postNav(m[1], m[2] || '');
    }
  }, true);
  // Report scroll position so the parent can persist it (rAF-throttled), and
  // accept a saved offset back for restore on load / back-navigation.
  var _ambRaf = 0, _ambLastY = -1;
  window.addEventListener('scroll', function(){
    if (_ambRaf) return;
    _ambRaf = requestAnimationFrame(function(){
      _ambRaf = 0;
      var y = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
      if (Math.abs(y - _ambLastY) < 2) return;
      _ambLastY = y;
      if (window.parent) window.parent.postMessage({type:'amboss_scroll', y:y}, '*');
    });
  }, { passive: true });
  window.addEventListener('message', function(e){
    var d = e.data;
    if (d && d.type === 'amboss_scroll' && typeof d.y === 'number') {
      try { window.scrollTo(0, d.y); } catch (err) {}
    }
  });
  function sendReady(){
    var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    if (window.parent) window.parent.postMessage({type:'amboss_ready', height:h}, '*');
  }
  function scheduleImages(){
    [120,600,1500].forEach(function(t){setTimeout(postImages,t);});
  }
  document.addEventListener('load',function(e){
    if(e.target&&e.target.tagName==='IMG') setTimeout(postImages,80);
  },true);
  if (document.readyState === 'complete') { sendReady(); scheduleImages(); }
  else window.addEventListener('load', function(){ sendReady(); scheduleImages(); });
  scheduleImages();
})();
</script>
<script>
(function(){
  var done=false;
  function closedHeight(){
    return window.matchMedia&&window.matchMedia('(max-width:640px)').matches?116:128;
  }

  function setState(header,body,ch,open,instant){
    header.classList.toggle('medos-closed',!open);
    header.setAttribute('aria-expanded',open?'true':'false');
    if(ch) ch.textContent=open?'\u25BE':'\u25B8';
    if(instant){
      body.classList.toggle('medos-open',open);
      body.classList.toggle('medos-closed',!open);
      body.style.maxHeight=open?'none':'';
      return;
    }
    var targetClosed=closedHeight();
    var start=body.getBoundingClientRect().height||targetClosed;
    body.style.maxHeight=start+'px';
    body.offsetHeight;
    if(open){
      body.classList.remove('medos-closed');
      body.classList.add('medos-open');
      requestAnimationFrame(function(){
        body.style.maxHeight=body.scrollHeight+'px';
      });
      var doneTransition=function(ev){
        if(ev.propertyName!=='max-height') return;
        body.style.maxHeight='none';
        body.removeEventListener('transitionend',doneTransition);
      };
      body.addEventListener('transitionend',doneTransition);
    }else{
      body.style.maxHeight=body.scrollHeight+'px';
      body.offsetHeight;
      requestAnimationFrame(function(){
        body.classList.add('medos-closed');
        body.classList.remove('medos-open');
        body.style.maxHeight=targetClosed+'px';
      });
    }
  }

  function run(){
    if(done) return;
    var article=document.querySelector('article');
    if(!article) return;
    // Real AMBOSS structure: article > div > section (content sections are NOT direct children).
    // article > section is only the title header (has h1, no h2).
    // Each content section lives inside a wrapper div: article > div > section.container-...
    var sections=Array.from(article.querySelectorAll(':scope > div > section')).filter(function(s){
      return s.querySelector('h2');
    });
    if(sections.length<2) return;
    done=true;
    sections.forEach(function(sec,idx){
      var h2=sec.querySelector('h2');
      if(!h2) return;
      // h2 is inside a header wrapper div inside the section
      var hdrDiv=(h2.parentElement!==sec)?h2.parentElement:h2;
      // Wrap everything after the header wrapper into a collapsible body
      var body=document.createElement('div');
      body.className='medos-acc-body'+(idx>0?' medos-closed':'');
      var el=hdrDiv.nextElementSibling;
      while(el){var n=el.nextElementSibling;body.appendChild(el);el=n;}
      sec.appendChild(body);
      // Chevron inline inside h2
      var ch=document.createElement('span');
      ch.className='medos-ch';ch.textContent=idx===0?'\u25BE':'\u25B8';
      h2.appendChild(ch);
      hdrDiv.classList.add('medos-acc-hdr');
      if(idx>0) hdrDiv.classList.add('medos-closed');
      hdrDiv.setAttribute('role','button');
      hdrDiv.setAttribute('tabindex','0');
      setState(hdrDiv,body,ch,idx===0,true);
      hdrDiv.addEventListener('click',function(){
        var closing=!body.classList.contains('medos-closed');
        setState(hdrDiv,body,ch,!closing,false);
      });
      hdrDiv.addEventListener('keydown',function(e){
        if(e.key==='Enter'||e.key===' '){
          e.preventDefault();
          var closing=!body.classList.contains('medos-closed');
          setState(hdrDiv,body,ch,!closing,false);
        }
      });
      body.addEventListener('click',function(e){
        if(!body.classList.contains('medos-closed')) return;
        e.preventDefault();
        e.stopPropagation();
        setState(hdrDiv,body,ch,true,false);
      },true);
      hdrDiv.medosAccBody=body;
      hdrDiv.medosSetAccordionState=function(open,instant){setState(hdrDiv,body,ch,open,instant);};
    });
    // Build a hierarchical outline (h2 sections -> h3 subsections) and hand it to
    // the parent reader so it can render an "On this page" navigator.
    var __outline=[];
    sections.forEach(function(sec,idx){
      if(!sec.id) sec.id='medos-sec-'+idx;
      var h2=sec.querySelector('h2'); if(!h2) return;
      __outline.push({id:sec.id, text:(h2.textContent||'').replace(/\u25B8|\u25BE/g,'').trim(), level:2});
      var bodyEl=sec.querySelector('.medos-acc-body');
      if(bodyEl){
        Array.prototype.forEach.call(bodyEl.querySelectorAll('h3'),function(h3,j){
          if(!h3.id) h3.id=sec.id+'-h'+j;
          var t=(h3.textContent||'').trim();
          if(t) __outline.push({id:h3.id, text:t, level:3});
        });
      }
    });
    if(window.parent) window.parent.postMessage({type:'medos_outline', items:__outline}, '*');
    if(window.__medosPostImages) window.__medosPostImages();
    window.addEventListener('resize',function(){
      sections.forEach(function(sec){
        var hdr=sec.querySelector('.medos-acc-hdr');
        var body=hdr&&hdr.medosAccBody;
        if(body&&body.classList.contains('medos-closed')) body.style.maxHeight='';
      });
    });
  }
  // Jump to a section/subsection when the parent reader clicks the outline:
  // expand its accordion (if collapsed) then smooth-scroll it into view.
  window.addEventListener('message',function(e){
    var d=e.data; if(!d||d.type!=='medos_scrollto'||!d.id) return;
    var target=document.getElementById(d.id); if(!target) return;
    var sec=target.closest&&target.closest('section');
    var hdr=sec&&sec.querySelector('.medos-acc-hdr');
    if(hdr&&hdr.medosSetAccordionState) hdr.medosSetAccordionState(true,true);
    setTimeout(function(){ try{ target.scrollIntoView({behavior:'smooth',block:'start'}); }catch(_){} },60);
  });
  // Try at 300 ms, 800 ms, 1500 ms to survive React hydration in a.min.js
  function schedule(){[300,800,1500].forEach(function(t){setTimeout(run,t);});}
  if(document.readyState==='complete') schedule();
  else window.addEventListener('load',schedule);
})();
</script>
"""

    if theme == "dark":
        nav_script = nav_script.replace("</style>", "</style>\n" + _DARK_ARTICLE_CSS, 1)

    nav_script = nav_script + annotation_bridge("amboss", doc_id)

    # Remove the original in-article script that did `document.location.href = ...`
    def _maybe_strip(m):
        body = m.group(2)
        if "data-learningcard-id" in body and "document.location" in body:
            return ""
        if "data-source" in body and "img.setAttribute('src'" in body:
            # Strip the APK's generic image-hydration script: on many bonus
            # spans `data-source` is only an internal token (e.g. `L3475...`),
            # not an image URL, so it breaks thumbnails by overwriting `src`.
            return ""
        return m.group(0)

    html = _RE_SCRIPT_BLOCK.sub(_maybe_strip, html)

    # Inject our nav bridge just before </body>
    if _RE_BODY_CLOSE.search(html):
        html = _RE_BODY_CLOSE.sub(lambda _m: nav_script + "</body>", html, count=1)
    else:
        html = html + nav_script

    return html


# ─── TOC endpoints ──────────────────────────────────────────────────────────

@router.get("/specialties")
def specialties():
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, name, docId, section, leaf "
            "FROM TOC WHERE parentId=0 ORDER BY name"
        ).fetchall()
    finally:
        c.close()
    return [
        {"id": r["id"], "name": r["name"] or "",
         "docId": r["docId"], "section": r["section"] or "",
         "leaf": r["leaf"]}
        for r in rows
    ]


@router.get("/toc/{toc_id}")
def toc_children(toc_id: int):
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, name, docId, section, leaf "
            "FROM TOC WHERE parentId=? ORDER BY name",
            (toc_id,)
        ).fetchall()
    finally:
        c.close()
    return [
        {"id": r["id"], "name": r["name"] or "",
         "docId": r["docId"], "section": r["section"] or "",
         "leaf": r["leaf"]}
        for r in rows
    ]


# ─── Search ─────────────────────────────────────────────────────────────────

@router.get("/search")
def search(q: str = Query(..., min_length=1, max_length=200)):
    q = q.strip()
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, title FROM Docs WHERE title LIKE ? ESCAPE '\\' "
            "ORDER BY title LIMIT 80",
            (f"%{q}%",)
        ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "title": r["title"] or ""} for r in rows]


@router.get("/autocomplete")
def autocomplete(q: str = Query(..., min_length=1, max_length=100)):
    q = q.strip()
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, title FROM Docs WHERE title LIKE ? ESCAPE '\\' "
            "ORDER BY title LIMIT 15",
            (f"{q}%",)
        ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "title": r["title"] or ""} for r in rows]


# ─── Article (decrypted HTML) ───────────────────────────────────────────────

@router.get("/article/{doc_id}/print", response_class=HTMLResponse)
def article_print(doc_id: int):
    """Complete, inert AMBOSS article for the browser's native print flow."""
    if not (1 <= doc_id <= 9_999_999):
        raise HTTPException(422, "invalid doc_id")

    c = _conn()
    try:
        row = c.execute(
            "SELECT id, title, doc FROM Docs WHERE id=?", (doc_id,)
        ).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, f"Article {doc_id} not found")
    if not row["doc"]:
        raise HTTPException(410, f"Article {doc_id} has empty payload")

    try:
        decrypted_html = decrypt_doc(row["id"], row["doc"])
    except Exception as error:
        raise HTTPException(
            500, f"Decryption failed for article {doc_id}: {error}"
        ) from error

    return HTMLResponse(
        _render_amboss_print(row["id"], row["title"] or "", decrypted_html),
        headers={"Cache-Control": "no-store"},
    )

@router.get("/article/{doc_id}", response_class=HTMLResponse)
def article(doc_id: int, theme: str = Query("light")):
    c = _conn()
    try:
        row = c.execute(
            "SELECT id, title, doc FROM Docs WHERE id=?", (doc_id,)
        ).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, f"Article {doc_id} not found")
    if not row["doc"]:
        raise HTTPException(410, f"Article {doc_id} has empty payload")

    try:
        html = decrypt_doc(row["id"], row["doc"])
    except Exception as e:
        raise HTTPException(500, f"Decryption failed for article {doc_id}: {e}")

    article_theme = "dark" if str(theme).lower() == "dark" else "light"
    return HTMLResponse(
        _rewrite_html(row["id"], html, article_theme, row["title"] or "")
    )


@router.get("/article/{doc_id}/meta")
def article_meta(doc_id: int):
    c = _conn()
    try:
        row = c.execute(
            "SELECT id, title, path FROM Docs WHERE id=?", (doc_id,)
        ).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, f"Article {doc_id} not found")
    title = row["title"] or ""
    return {
        "id": row["id"],
        "title": title,
        "path": row["path"] or "",
        "umls": umls_reader.concept_context(title),
    }


@router.get("/article/{doc_id}/json")
def article_json(doc_id: int, theme: str = Query("light")):
    """Return decrypted HTML + title as JSON (for SSR / non-iframe callers)."""
    c = _conn()
    try:
        row = c.execute(
            "SELECT id, title, path, doc FROM Docs WHERE id=?", (doc_id,)
        ).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, f"Article {doc_id} not found")
    if not row["doc"]:
        raise HTTPException(410, f"Article {doc_id} has empty payload")
    try:
        html = decrypt_doc(row["id"], row["doc"])
    except Exception as e:
        raise HTTPException(500, f"Decryption failed: {e}")
    article_theme = "dark" if str(theme).lower() == "dark" else "light"
    return {
        "id":       row["id"],
        "title":    row["title"] or "",
        "path":     row["path"] or "",
        "umls":     umls_reader.concept_context(row["title"] or ""),
        "html":     _rewrite_html(
            row["id"], html, article_theme, row["title"] or ""
        ),
        "html_len": len(html),
    }


# ─── Learning-card ID resolution ────────────────────────────────────────────

_ABBREV_EXPANSIONS = {
    "hf": ["heart failure"],
    "chf": ["congestive heart failure", "heart failure"],
    "copd": ["chronic obstructive pulmonary disease"],
    "ckd": ["chronic kidney disease"],
    "aki": ["acute kidney injury"],
    "cad": ["coronary artery disease"],
    "acs": ["acute coronary syndrome"],
    "mi": ["myocardial infarction"],
    "af": ["atrial fibrillation"],
    "dvt": ["deep vein thrombosis"],
    "pe": ["pulmonary embolism"],
    "sids": ["sudden infant death syndrome"],
    "tia": ["transient ischemic attack"],
    "gbs": ["guillain-barré syndrome", "guillain-barre syndrome"],
    "dka": ["diabetic ketoacidosis"],
    "hhs": ["hyperosmolar hyperglycemic state"],
    "t1dm": ["type 1 diabetes mellitus"],
    "t2dm": ["type 2 diabetes mellitus"],
    "gerd": ["gastroesophageal reflux disease"],
    "ibd": ["inflammatory bowel disease"],
    "ibs": ["irritable bowel syndrome"],
    "sle": ["systemic lupus erythematosus"],
    "ra": ["rheumatoid arthritis"],
    "ms": ["multiple sclerosis"],
    "uti": ["urinary tract infection"],
    "bph": ["benign prostatic hyperplasia"],
    "hcc": ["hepatocellular carcinoma"],
    "hiv": ["human immunodeficiency virus"],
    "tb": ["tuberculosis"],
    "cap": ["community-acquired pneumonia"],
    "cpr": ["cardiopulmonary resuscitation"],
    "afib": ["atrial fibrillation"],
    "htn": ["hypertension"],
    "hld": ["hyperlipidemia"],
    "hx": ["history"],
    "ct": ["computed tomography"],
    "mri": ["magnetic resonance imaging"],
    "gi": ["gastrointestinal"],
    "cns": ["central nervous system"],
    "pns": ["peripheral nervous system"],
    "ekg": ["electrocardiogram"],
    "ecg": ["electrocardiogram"],
    "ppi": ["proton pump inhibitors"],
    "h2 blocker": ["antihistamines"],
    "h2 blockers": ["antihistamines"],
    "h2 receptor blocker": ["antihistamines"],
    "h2 receptor blockers": ["antihistamines"],
}


_TAG_RE = re.compile(r"<[^>]+>")
_NONCONTENT_BLOCK_RE = re.compile(r"(?is)<(script|style|noscript)\b[^>]*>.*?</\1>")
_CSS_FONT_FACE_RE = re.compile(r"(?is)@font-face\s*\{.*?\}")
_WS_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[a-z0-9]+")


def _strip_html(html: str, max_len: int = 380) -> str:
    text = _NONCONTENT_BLOCK_RE.sub(" ", html or "")
    text = _CSS_FONT_FACE_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    text = html_lib.unescape(text)
    text = _WS_RE.sub(" ", text).strip()
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text


@lru_cache(maxsize=2048)
def _article_abstract(doc_id: int) -> str:
    try:
        c = _conn()
        try:
            row = c.execute("SELECT id, doc FROM Docs WHERE id=?", (doc_id,)).fetchone()
        finally:
            c.close()
        if not row or not row["doc"]:
            return ""
        html = decrypt_doc(row["id"], row["doc"])
    except Exception:
        return ""
    clean_html = _NONCONTENT_BLOCK_RE.sub(" ", html)
    for m in re.finditer(r"<p[^>]*>(.*?)</p>", clean_html, flags=re.IGNORECASE | re.DOTALL):
        snippet = _strip_html(m.group(1))
        if len(snippet) > 40 and not snippet.lower().startswith(("@font-face", "font-family")):
            return snippet
    m = re.search(r"<p[^>]*>(.*?)</p>", clean_html, flags=re.IGNORECASE | re.DOTALL)
    if m:
        snippet = _strip_html(m.group(1))
        if len(snippet) > 40:
            return snippet
    return _strip_html(clean_html)


def _norm_term(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return _WS_RE.sub(" ", re.sub(r"[^a-z0-9]+", " ", value.lower())).strip()


def _tokens(value: str) -> list[str]:
    return _WORD_RE.findall(_norm_term(value))


def _token_close(a: str, b: str) -> bool:
    if a == b:
        return True
    if len(a) >= 5 and len(b) >= 5 and (a.startswith(b[:5]) or b.startswith(a[:5])):
        return True
    if len(a) > 4 and a.endswith("s") and a[:-1] == b:
        return True
    if len(b) > 4 and b.endswith("s") and b[:-1] == a:
        return True
    return False


def _title_score(query: str, title: str) -> float:
    q = _norm_term(query)
    t = _norm_term(title)
    if not q or not t:
        return 0.0
    if q == t:
        return 130.0
    if t.startswith(q + " "):
        return 110.0
    if re.search(rf"(?<![a-z0-9]){re.escape(q)}(?![a-z0-9])", t):
        return 94.0 if len(q) >= 6 else 64.0

    q_tokens = _tokens(q)
    t_tokens = _tokens(t)
    if not q_tokens or not t_tokens:
        return 0.0
    if len(q_tokens) == 1:
        return 0.0
    matched = sum(1 for qt in q_tokens if any(_token_close(qt, tt) for tt in t_tokens))
    coverage = matched / len(q_tokens)
    if coverage == 1:
        return 88.0 - min(20.0, abs(len(t_tokens) - len(q_tokens)) * 3.0)
    if len(q) >= 8:
        return difflib.SequenceMatcher(None, q, t).ratio() * 78.0
    return 0.0


@lru_cache(maxsize=1)
def _article_title_rows() -> tuple[tuple[int, str], ...]:
    c = _conn()
    try:
        rows = c.execute("SELECT id, title FROM Docs WHERE title IS NOT NULL").fetchall()
    finally:
        c.close()
    return tuple((int(r["id"]), r["title"] or "") for r in rows if (r["title"] or "").strip())


@lru_cache(maxsize=20000)
def _ranked_title_matches(term: str, limit: int = 8) -> tuple[tuple[int, str, float], ...]:
    scored: list[tuple[int, str, float]] = []
    seen_titles: set[str] = set()
    for doc_id, title in _article_title_rows():
        score = _title_score(term, title)
        if score < 68:
            continue
        key = _norm_term(title)
        if key in seen_titles and score < 125:
            continue
        seen_titles.add(key)
        scored.append((doc_id, title, score))
    scored.sort(key=lambda item: (-item[2], len(item[1]), item[1].lower(), item[0]))
    return tuple(scored[:limit])


@lru_cache(maxsize=1)
def _amboss_terms_index() -> list[str]:
    """Compact list of AMBOSS article titles + medical abbreviations. Used by
    the frontend <AmbossAutoText> to auto-highlight hover-able medical terms."""
    out: set[str] = set()
    try:
        c = _conn()
        try:
            rows = c.execute("SELECT title FROM Docs WHERE title IS NOT NULL").fetchall()
        finally:
            c.close()
        for r in rows:
            t = (r["title"] or "").strip()
            if 3 <= len(t) <= 60:
                out.add(t)
    except Exception:
        pass
    for abbr in _ABBREV_EXPANSIONS.keys():
        out.add(abbr.upper())
    for term in _extension_terms_map().keys():
        if 3 <= len(term) <= 80:
            out.add(term)
    return sorted(out)


@router.get("/terms")
def amboss_terms():
    return {"terms": _amboss_terms_index()}


def _crx_zip_bytes(path: Path) -> bytes:
    """Return the ZIP payload from a CRX/ZIP file."""
    raw = path.read_bytes()
    offset = raw.find(b"PK\x03\x04")
    if offset < 0:
        raise ValueError("ZIP payload not found")
    return raw[offset:]


@lru_cache(maxsize=1)
def _extension_crx_path() -> Path | None:
    candidates: list[Path] = []
    configured = os.environ.get("AMBOSS_EXTENSION_CRX", "").strip()
    if configured:
        candidates.append(Path(configured))
    candidates.extend(
        [
            BASE.parents[1] / "archive" / "hnlpidgbnmikgkmccephgaljihheckii.crx",
            BASE.parent / "archive" / "hnlpidgbnmikgkmccephgaljihheckii.crx",
        ]
    )
    return next((p for p in candidates if p.is_file()), None)


@lru_cache(maxsize=1)
def _extension_terms_map() -> dict[str, str]:
    """Load the AMBOSS browser extension's offline phrase dictionary.

    Values are phrase-group IDs from the extension. They are not local Docs IDs.
    """
    crx = _extension_crx_path()
    if not crx:
        return {}
    try:
        with zipfile.ZipFile(io.BytesIO(_crx_zip_bytes(crx))) as zf:
            payload = json.loads(zf.read("data/en/terms.json").decode("utf-8"))
    except Exception:
        return {}

    out: dict[str, str] = {}
    groups = payload.get("caseInsensitiveTerms", [])
    if not groups:
        return out
    for item in groups:
        if not isinstance(item, list) or len(item) != 2:
            continue
        lcid, phrases = item
        if not isinstance(lcid, str) or not isinstance(phrases, list):
            continue
        for phrase in phrases:
            if not isinstance(phrase, str):
                continue
            clean = _WS_RE.sub(" ", phrase.strip())
            key = clean.lower()
            if 3 <= len(clean) <= 80 and key not in out:
                out[key] = lcid
    aliases = {
        # Natural wording used in QBank stems; the CRX has the concept under
        # a formal synonym, so map the visible phrase to the same phrase group.
        "dry eyes": "k_amoM",
        "breastfed": "qdVCIt0",
        "thyroid stimulating hormone": "jKa_Tl",
        "thyroid-stimulating hormone": "jKa_Tl",
        "tsh": "jKa_Tl",
    }
    phrase_groups = _extension_phrase_groups()
    for group_id, group in phrase_groups.items():
        if not isinstance(group, dict):
            continue
        title = _WS_RE.sub(" ", str(group.get("title") or "").strip())
        key = title.lower()
        if 3 <= len(title) <= 80 and key not in out:
            out[key] = group_id
    for alias, group_id in aliases.items():
        if group_id in phrase_groups:
            out.setdefault(alias, group_id)
    return out


@lru_cache(maxsize=1)
def _extension_case_sensitive_terms_map() -> dict[str, str]:
    crx = _extension_crx_path()
    if not crx:
        return {}
    try:
        with zipfile.ZipFile(io.BytesIO(_crx_zip_bytes(crx))) as zf:
            payload = json.loads(zf.read("data/en/terms.json").decode("utf-8"))
    except Exception:
        return {}

    out: dict[str, str] = {}
    groups = payload.get("caseSensitiveTerms", [])
    if not isinstance(groups, list):
        return out
    for item in groups:
        if not isinstance(item, list) or len(item) != 2:
            continue
        lcid, phrases = item
        if not isinstance(lcid, str) or not isinstance(phrases, list):
            continue
        for phrase in phrases:
            if not isinstance(phrase, str):
                continue
            clean = _WS_RE.sub(" ", phrase.strip())
            if 2 <= len(clean) <= 80 and clean not in out:
                out[clean] = lcid
    return out


@lru_cache(maxsize=1)
def _extension_phrase_groups() -> dict[str, dict]:
    crx = _extension_crx_path()
    if not crx:
        return {}
    try:
        with zipfile.ZipFile(io.BytesIO(_crx_zip_bytes(crx))) as zf:
            payload = json.loads(zf.read("data/en/phrase-groups.json").decode("utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _extension_group_for_term(term: str) -> dict | None:
    clean = _WS_RE.sub(" ", term.strip())
    group_id = _extension_terms_map().get(clean.lower()) or _extension_case_sensitive_terms_map().get(clean)
    if not group_id:
        return None
    group = _extension_phrase_groups().get(group_id)
    return group if isinstance(group, dict) else None


def _slugify(value: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", _norm_term(value))).strip("-")


@lru_cache(maxsize=1)
def _doc_slug_map() -> dict[str, tuple[int, str]]:
    c = _conn()
    try:
        rows = c.execute("SELECT id, title, path FROM Docs WHERE title IS NOT NULL").fetchall()
    finally:
        c.close()

    out: dict[str, tuple[int, str]] = {}
    for row in rows:
        doc_id = int(row["id"])
        title = row["title"] or ""
        path = row["path"] or ""
        for candidate in (title, Path(path).stem, path):
            slug = _slugify(candidate)
            if slug and slug not in out:
                out[slug] = (doc_id, title)
    return out


def _extension_destination_matches(group: dict, limit: int) -> list[dict]:
    matches: list[dict] = []
    seen: set[int] = set()
    doc_slugs = _doc_slug_map()
    destinations = group.get("destinations") or []
    if not isinstance(destinations, list):
        return matches
    for dest in destinations:
        if not isinstance(dest, dict):
            continue
        candidates = [
            dest.get("slug") or "",
            (dest.get("label") or "").split("→", 1)[0],
            dest.get("label") or "",
        ]
        resolved = next((doc_slugs.get(_slugify(candidate)) for candidate in candidates if candidate), None)
        if not resolved:
            continue
        doc_id, title = resolved
        if doc_id in seen:
            continue
        seen.add(doc_id)
        label = dest.get("label") or title
        matches.append(
            {
                "id": doc_id,
                "title": label,
                "href": f"/amboss?doc={doc_id}",
                "source": "extension",
            }
        )
        if len(matches) >= limit:
            break
    return matches


def _extension_media(group: dict, limit: int = 3) -> list[dict]:
    media = group.get("media") or []
    if not isinstance(media, list):
        return []
    out: list[dict] = []
    image_dir = images_dir()
    for item in media:
        if not isinstance(item, dict):
            continue
        filename = Path(str(item.get("filename") or "")).name
        if not filename:
            continue
        candidates = [
            f"big_{filename}.jpg",
            f"{filename}.jpg",
            f"big_{filename}.png",
            f"{filename}.png",
        ]
        image_name = next((name for name in candidates if image_dir and (image_dir / name).is_file()), None)
        if not image_name:
            continue
        if _is_blocked_image_name(image_name):
            continue
        out.append(
            {
                "title": item.get("title") or "",
                "url": f"/amboss/image/{image_name}",
            }
        )
        if len(out) >= limit:
            break
    return out


@lru_cache(maxsize=1)
def _scan_terms() -> list[tuple[str, str, bool]]:
    terms: dict[tuple[str, bool], str] = {}
    for term in _extension_terms_map().keys():
        if _scan_term_worth_highlighting(term):
            terms[(term, False)] = term
    for term in _extension_case_sensitive_terms_map().keys():
        if _scan_term_worth_highlighting(term):
            terms[(term, True)] = term
    for term in _amboss_terms_index():
        key = term.lower()
        if _scan_term_worth_highlighting(key):
            terms.setdefault((key, False), term)
    # Longest first improves specificity when phrases overlap.
    return sorted(
        ((key, display, sensitive) for (key, sensitive), display in terms.items()),
        key=lambda x: (-len(x[0]), x[0]),
    )


_SCAN_STOP_TERMS = {
    "acid", "age", "antigen", "assay", "biopsy", "blocker", "cells", "contact",
    "control", "diagnosis", "disease", "factor", "factors", "gene", "genes",
    "hygiene", "infection", "isolation", "management", "presentation", "recent",
    "risk", "stool", "strains", "toxin", "use", "water",
    "medical history", "risk factors",
}


def _scan_term_worth_highlighting(term: str) -> bool:
    key = term.strip().lower()
    if key in _ABBREV_EXPANSIONS:
        return True
    if len(key) < 3 or len(key) > 80:
        return False
    if key in _SCAN_STOP_TERMS:
        return False
    if _extension_group_for_term(key):
        return True
    if " " not in key and len(key) < 6 and key not in _ABBREV_EXPANSIONS:
        return False
    return True


@lru_cache(maxsize=30000)
def _term_can_show_tooltip(term: str) -> bool:
    key = term.strip().lower()
    if not _scan_term_worth_highlighting(key):
        return False
    if key in _ABBREV_EXPANSIONS:
        return True
    if _extension_group_for_term(key):
        return True
    key_tokens = _tokens(key)
    if len(key_tokens) == 1:
        for _doc_id, title in _article_title_rows():
            title_norm = _norm_term(title)
            if title_norm == key or title_norm.startswith(key + " "):
                return True
        return False
    if _ranked_title_matches(key, 1):
        return True

    return False


def _is_term_boundary(ch: str) -> bool:
    return not (ch.isalnum() or ch in "_+-")


@router.post("/scan")
def scan_terms(req: ScanRequest):
    text = req.text
    lower = text.lower()
    hits: list[dict] = []
    occupied: list[tuple[int, int]] = []

    for key, display, case_sensitive in _scan_terms():
        haystack = text if case_sensitive else lower
        needle = key if case_sensitive else key.lower()
        start = 0
        while True:
            idx = haystack.find(needle, start)
            if idx < 0:
                break
            end = idx + len(needle)
            before_ok = idx == 0 or _is_term_boundary(haystack[idx - 1])
            after_ok = end == len(haystack) or _is_term_boundary(haystack[end])
            overlaps = any(idx < e and end > s for s, e in occupied)
            if before_ok and after_ok and not overlaps and _term_can_show_tooltip(display):
                hits.append({"start": idx, "end": end, "term": display})
                occupied.append((idx, end))
            start = end

    hits.sort(key=lambda h: (h["start"], -(h["end"] - h["start"])))
    return {"matches": hits[: req.limit]}


@router.get("/tooltip")
def tooltip(
    term: str = Query(..., min_length=1, max_length=120),
    limit: int = Query(default=6, ge=1, le=20),
):
    """Return AMBOSS tooltip matches for a term or abbreviation, including multiple
    candidate articles and a short local abstract for the top match.

    Designed to be called on hover anywhere in the MedOS app.
    """
    if not isinstance(limit, int):
        limit = 6
    raw = term.strip()
    if not raw:
        return {"term": raw, "matches": []}
    key = raw.lower()
    expansions = _ABBREV_EXPANSIONS.get(key, [])

    extension_group = None if key == "gbs" else _extension_group_for_term(raw)
    if extension_group:
        extension_matches = _extension_destination_matches(extension_group, limit)
        return {
            "term": raw,
            "title": extension_group.get("title") or raw,
            "expansions": expansions if key in _ABBREV_EXPANSIONS else [],
            "matches": extension_matches[:limit],
            "abstract": _strip_html(extension_group.get("description") or ""),
            "media": _extension_media(extension_group),
        }

    c = _conn()
    try:
        matches: list[dict] = []
        seen: set[int] = set()
        seen_title_keys: set[str] = set()

        def add_rows(rows, source_label: str):
            for r in rows:
                rid = int(r["id"])
                if rid in seen:
                    continue
                title_key = _norm_term(r["title"] or "")
                if title_key in seen_title_keys:
                    continue
                seen.add(rid)
                seen_title_keys.add(title_key)
                matches.append(
                    {
                        "id": rid,
                        "title": r["title"] or "",
                        "href": f"/amboss?doc={rid}",
                        "source": source_label,
                    }
                )

        title_rows = [
            {"id": doc_id, "title": title}
            for doc_id, title, _score in _ranked_title_matches(key, limit)
        ]
        add_rows(title_rows, "article")

        # Abbreviation expansion (explicit map + acronym in first letters of title)
        for exp in expansions:
            if len(matches) >= limit:
                break
            # Prefer exact title match first.
            add_rows(
                c.execute(
                    "SELECT id, title FROM Docs WHERE lower(title)=? LIMIT ?",
                    (exp, limit - len(matches)),
                ).fetchall(),
                "abbreviation",
            )
            if len(matches) >= limit:
                break
            add_rows(
                c.execute(
                    "SELECT id, title FROM Docs WHERE lower(title) LIKE ? "
                    "ORDER BY length(title), title LIMIT ?",
                    (f"%{exp}%", limit - len(matches)),
                ).fetchall(),
                "abbreviation",
            )

        # Fulltext fallback via AMBOSS FTS (Search) — maps section titles to articles.
        if len(matches) < limit and len(key) >= 7:
            try:
                fts_rows = c.execute(
                    "SELECT DISTINCT s.contentId AS cid, d.title AS dtitle, s.text AS stext "
                    "FROM Search s JOIN Docs d ON d.id = s.contentId "
                    "WHERE lower(s.text) LIKE ? AND s.type=1 "
                    "LIMIT ?",
                    (f"%{key}%", limit - len(matches)),
                ).fetchall()
                for r in fts_rows:
                    label = r["stext"] or r["dtitle"] or ""
                    if _title_score(key, label) < 62 and _title_score(key, r["dtitle"] or "") < 62:
                        continue
                    rid = int(r["cid"])
                    if rid in seen:
                        continue
                    seen.add(rid)
                    seen_title_keys.add(_norm_term(label))
                    matches.append(
                        {
                            "id": rid,
                            "title": label,
                            "href": f"/amboss?doc={rid}",
                            "source": "section",
                        }
                    )
            except sqlite3.OperationalError:
                pass

        # TOC / chapter-level fallback
        if len(matches) < limit and len(key) >= 7:
            toc_rows = c.execute(
                "SELECT t.id AS tid, t.name AS name, t.docId AS docId, d.title AS dtitle "
                "FROM TOC t LEFT JOIN Docs d ON d.id = t.docId "
                "WHERE t.docId > 0 AND lower(t.name) LIKE ? ORDER BY t.name LIMIT ?",
                (f"%{key}%", limit - len(matches)),
            ).fetchall()
            for r in toc_rows:
                label = r["name"] or r["dtitle"] or ""
                if _title_score(key, label) < 62 and _title_score(key, r["dtitle"] or "") < 62:
                    continue
                rid = int(r["docId"])
                if rid in seen:
                    continue
                title_key = _norm_term(label)
                if title_key in seen_title_keys:
                    continue
                seen.add(rid)
                seen_title_keys.add(title_key)
                matches.append(
                    {
                        "id": rid,
                        "title": label,
                        "href": f"/amboss?doc={rid}",
                        "source": "chapter",
                    }
                )
    finally:
        c.close()

    abstract = ""
    if matches:
        abstract = _article_abstract(matches[0]["id"])

    return {
        "term": raw,
        "title": matches[0]["title"] if matches else raw,
        "expansions": expansions if key in _ABBREV_EXPANSIONS else [],
        "matches": matches[:limit],
        "abstract": abstract,
        "media": [],
    }


@router.get("/resolve/{lcid}")
def resolve_lcid(lcid: str):
    """Map a learning-card id (`data-learningcard-id`) to a Docs.id."""
    if not re.match(r"^[A-Za-z0-9_\-]{1,32}$", lcid):
        raise HTTPException(400, "Invalid lcid format")
    doc_id = lcid_to_id(str(_db_path()), lcid)
    if doc_id is None:
        raise HTTPException(404, f"No article for lcid={lcid!r}")
    c = _conn()
    try:
        row = c.execute("SELECT id, title FROM Docs WHERE id=?", (doc_id,)).fetchone()
    finally:
        c.close()
    return {"id": doc_id, "title": row["title"] if row else ""}


# ─── Image + stylesheet stubs ───────────────────────────────────────────────

@router.get("/image/{image_name}")
def image(image_name: str):
    # Prevent path traversal
    name = Path(image_name).name
    if _is_blocked_image_name(name):
        raise HTTPException(404, f"Image not found: {name}")
    img_path = _bundle_dir() / "Images" / name
    if not img_path.exists():
        raise HTTPException(404, f"Image not found: {name}")
    # Let the browser cache images aggressively — the bundle is immutable.
    return FileResponse(
        str(img_path), media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/Images/{image_name}")
def image_static_alias(image_name: str):
    return image(image_name)


@router.get("/stub/{name}", response_class=HTMLResponse)
def stub(name: str):
    """Serve an empty body for assets AMBOSS references but never ships."""
    if name.endswith(".css"):
        return HTMLResponse("/* stub */", media_type="text/css")
    if name.endswith(".js"):
        return HTMLResponse("/* stub */", media_type="application/javascript")
    return HTMLResponse("")


# ─── Browsing + health ──────────────────────────────────────────────────────

@router.get("/articles")
def articles(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
):
    offset = (page - 1) * limit
    c = _conn()
    try:
        total = c.execute("SELECT COUNT(*) FROM Docs").fetchone()[0]
        rows  = c.execute(
            "SELECT id, title FROM Docs ORDER BY title LIMIT ? OFFSET ?",
            (limit, offset)
        ).fetchall()
    finally:
        c.close()
    return {
        "total":    total,
        "page":     page,
        "limit":    limit,
        "articles": [{"id": r["id"], "title": r["title"] or ""} for r in rows],
    }


@router.get("/health")
def health():
    try:
        info = self_test(str(_db_path()), sample_id=1)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    info["db"] = str(_db_path())
    return info

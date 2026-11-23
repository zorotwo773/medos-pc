"""
UWorld Library reader — FastAPI router.

The UWorld reference-article library (`uworldstep1library-*.db`) is the UWorld
counterpart of the AMBOSS article library: same iMedicalDoctor bundle shape
(Docs / TOC / images / Search). The only structural difference is that its
`Docs.doc` column uses the newer **v2 AES-GCM scheme** (AAD = str(doc_id)) —
the same scheme `qbank_reader._decrypt_v2` uses for question content — rather
than the AMBOSS library's per-row PBKDF2/CBC scheme. We decrypt + rewrite the
HTML to host it in an iframe, pulling images from our static mount.

Endpoints
---------
- `/uworld-library/specialties`        Root TOC entries (parentId = 0)
- `/uworld-library/organized`         Discipline → topic → article tree (whole library)
- `/uworld-library/toc/{toc_id}`       Children of a TOC node
- `/uworld-library/search`, `/autocomplete`
                                        Title lookup over Docs
- `/uworld-library/article/{doc_id}`   Decrypted article HTML (iframe-ready)
- `/uworld-library/article/{doc_id}/print` Complete native-print article
- `/uworld-library/article/{doc_id}/meta`  Title metadata as JSON
- `/uworld-library/article/{doc_id}/json`  Decrypted HTML + metadata as JSON
- `/uworld-library/resolve-title?title=`   Title → doc id (qbank Refs join)
- `/uworld-library/image/{image_name}` Image from the bundled Images/ directory
- `/uworld-library/articles`           Paginated list of all articles
- `/uworld-library/health`             Decryption self-test (one row)
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from selectolax.parser import HTMLParser

from Crypto.Cipher import AES
from article_export import (
    PrintDocument,
    render_print_document,
    sanitize_print_fragment,
)
from media_interop import media_interop_head
from reader_annotations import annotation_bridge

try:
    from config import UWORLD_LIBRARY_DIR
except Exception:  # pragma: no cover - config always present in app
    UWORLD_LIBRARY_DIR = None

BASE = Path(__file__).parent
router = APIRouter(prefix="/uworld-library", tags=["UWorld Library"])


# ─── Bundle resolution ───────────────────────────────────────────────────────

def _bundle_dir() -> Path:
    """Resolve the library bundle directory, tolerating the dated folder name."""
    raw = os.environ.get("UWORLD_LIBRARY_DIR", "").strip()
    if raw and Path(raw).exists():
        return Path(raw)
    if UWORLD_LIBRARY_DIR and Path(UWORLD_LIBRARY_DIR).exists():
        return Path(UWORLD_LIBRARY_DIR)
    # Fall back to globbing data/ for a uworld*library* bundle.
    try:
        from config import ROOT
    except Exception:
        ROOT = BASE.parent.parent
    data = Path(ROOT) / "data"
    if data.exists():
        for cand in sorted(data.glob("uworld*library*")):
            if cand.is_dir():
                return cand
    raise HTTPException(503, "UWorld library bundle not found. Set UWORLD_LIBRARY_DIR.")


@lru_cache(maxsize=1)
def _db_path() -> Path:
    bundle = _bundle_dir()
    db = next((p for p in sorted(bundle.glob("*.db"))), None)
    if db is None:
        raise HTTPException(503, f"No .db found in UWorld library bundle: {bundle}")
    return db


def images_dir() -> Optional[Path]:
    """Return the bundle's Images/ folder if present, for static mounting."""
    try:
        p = _bundle_dir() / "Images"
    except HTTPException:
        return None
    return p if p.exists() else None


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{_db_path()}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


# ─── v2 decryption (AAD = str(doc_id)) ──────────────────────────────────────
_V2_PREFIX = "v2:"
_V2_KEY = hashlib.sha256(b"YHYZYNVLBEKPQCGDWFNPDAAIO").digest()


def _decrypt_doc(doc_id: int, payload: Optional[str]) -> str:
    """Decrypt one `Docs.doc` v2 cell into UTF-8 HTML. Raises on malformed input."""
    if not payload:
        return ""
    if not payload.startswith(_V2_PREFIX):
        raise HTTPException(500, "Unexpected (non-v2) doc encoding in UWorld library")
    blob = base64.b64decode(payload[len(_V2_PREFIX):].strip())
    if len(blob) < 31 or blob[0] != 2:
        raise HTTPException(500, "Malformed v2 doc blob")
    flags, nonce, tag, ct = blob[1], blob[2:14], blob[-16:], blob[14:-16]
    cipher = AES.new(_V2_KEY, AES.MODE_GCM, nonce=nonce)
    cipher.update(f"{doc_id}|128".encode("utf-8"))
    raw = cipher.decrypt_and_verify(ct, tag)
    if flags & 1:
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", "replace")


# ─── HTML rewriting ─────────────────────────────────────────────────────────
# The article template links 3 stylesheets the bundle never ships
# (all.min.css / all2.min.css / tablemedia.css) and references images as
# ../Images/Lxxxxx.jpg. We drop the dead links, route images through our
# endpoint, and inject a readable base + dark stylesheet of our own.
_RE_IMG_REL = re.compile(r'(<img[^>]*\bsrc=")\.\./Images/([^"]+)(")', re.IGNORECASE)
_RE_HEAD_CLOSE = re.compile(r"</head>", re.IGNORECASE)
_NETWORK_REFERENCE = re.compile(r"^(?:https?:)?//", re.IGNORECASE)
_IMAGE_EXTENSION = re.compile(r"\.(?:avif|gif|jpe?g|png|svg|webp)$", re.IGNORECASE)
_SAFE_DATA_IMAGE = re.compile(
    r"^data:image/(?:avif|gif|jpe?g|png|svg\+xml|webp);base64,[a-z0-9+/]+={0,2}$",
    re.IGNORECASE,
)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
_CSS_EXTERNAL_IMPORT = re.compile(
    r"@import\s+(?:url\(\s*)?['\"]?(?:https?:)?//[^;\n}]+;?",
    re.IGNORECASE,
)
_PRINT_CONTAINER_SIZE_PROPERTIES = {
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "inline-size",
    "block-size",
    "min-inline-size",
    "min-block-size",
    "max-inline-size",
    "max-block-size",
}

_BASE_CSS = """
<style id="medos-uwlib-base">
html,body{margin:0;padding:0;background:#fff;color:#1a1c1c;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  font-size:16px;line-height:1.6;-webkit-text-size-adjust:100%;}
body{padding:16px 20px 64px;max-width:none;}
h1{font-size:25px;font-weight:800;color:#0b3d63;margin:0 0 10px;}
h2{font-size:19px;font-weight:800;color:#0b3d63;margin:26px 0 10px;
  padding:8px 0 6px;border-bottom:2px solid #1f7ec4;}
h3{font-size:16px;font-weight:700;color:#27485e;margin:18px 0 6px;}
p{margin:0 0 12px;}
ul,ol{padding-left:20px;margin:8px 0 12px;}
li{margin-bottom:4px;}
a{color:#1f7ec4;text-decoration:none;}
img{max-width:100%;height:auto;border-radius:4px;background:#fff;}
table{border-collapse:collapse;margin:16px 0;display:block;overflow-x:auto;
  border:1px solid #d8e2f0;font-size:14px;-webkit-overflow-scrolling:touch;max-width:100%;}
th,td{border:1px solid #d8e2f0;padding:9px 12px;vertical-align:top;min-width:80px;}
th{background:#eef5fb;color:#0f172a;font-weight:700;}
tr:nth-child(even) td{background:#f7fafd;}
</style>
"""

_DARK_CSS = """
<style id="medos-uwlib-dark">
html,body{background:#0f172a !important;color:#e5edf8 !important;color-scheme:dark;}
p,li,div,span,td,th,dd,dt{color:#e5edf8 !important;}
h1,h2,h3,h4,strong,b{color:#f8fafc !important;}
h2{border-bottom-color:#38bdf8 !important;}
a{color:#7dd3fc !important;}
table,th,td{border-color:#334155 !important;}
th{background:#172033 !important;}
td{background:#111827 !important;}
tr:nth-child(even) td{background:#172033 !important;}
img{background:#fff !important;}
</style>
"""


# A controlled, MedOS-only script appended AFTER the original scripts are
# stripped. It exposes the article's heading outline to the parent reader
# (postMessage) and scrolls to a heading on request — powering the "On this
# page" navigator. No other scripts run in the iframe.
_OUTLINE_SCRIPT = """
<script id="medos-uwlib-outline">
(function(){
  function postScroll(){
    var y=window.scrollY||document.documentElement.scrollTop||document.body.scrollTop||0;
    if(window.parent) window.parent.postMessage({type:'medos_reader_scroll', source:'uworld-library', y:y}, '*');
  }
  function cleanText(value){
    return String(value||'').replace(/\\s+/g,' ').trim().slice(0,140);
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
    if(window.parent) window.parent.postMessage({type:'medos_article_images', source:'uworld-library', items:items}, '*');
  }
  function build(){
    var hs=document.querySelectorAll('h2,h3,[data-node-name="h1"],[data-node-name="h2"],[data-node-name="h3"],.article-body-headers');
    var items=[];
    Array.prototype.forEach.call(hs,function(h,i){
      if(!h.id) h.id='medos-uwh-'+i;
      var t=(h.textContent||'').trim(); if(!t) return;
      var node=(h.getAttribute('data-node-name')||h.tagName||'').toLowerCase();
      items.push({id:h.id, text:t, level: node==='h3'?3:2});
    });
    if(window.parent) window.parent.postMessage({type:'medos_outline', items:items}, '*');
    postImages();
    if(window.parent) window.parent.postMessage({type:'medos_reader_ready', source:'uworld-library'}, '*');
    postScroll();
  }
  window.addEventListener('message',function(e){
    var d=e.data; if(!d) return;
    if(d.type==='medos_restore_scroll'&&Number.isFinite(Number(d.y))){
      try{ window.scrollTo(0,Math.max(0,Number(d.y))); }catch(_){}
      return;
    }
    if(d.type!=='medos_scrollto'||!d.id) return;
    var el=document.getElementById(d.id); if(!el) return;
    try{ el.scrollIntoView({behavior:'smooth',block:'start'}); }catch(_){}
  });
  window.addEventListener('scroll',function(){
    if(window.__medosUwScrollFrame) window.cancelAnimationFrame(window.__medosUwScrollFrame);
    window.__medosUwScrollFrame=window.requestAnimationFrame(postScroll);
  },{passive:true});
  document.addEventListener('load',function(e){
    if(e.target&&e.target.tagName==='IMG') setTimeout(postImages,80);
  },true);
  if(document.readyState==='complete'||document.readyState==='interactive') setTimeout(build,80);
  else window.addEventListener('DOMContentLoaded',function(){ setTimeout(build,80); });
  [250,900,1800].forEach(function(t){setTimeout(postImages,t);});
})();
</script>
"""


def _is_network_reference(value: str) -> bool:
    return bool(_NETWORK_REFERENCE.match(str(value or "").strip()))


def _uworld_image_url(value: str) -> str:
    """Return a bundled image endpoint or safe inline image, never a network URL."""
    candidate = str(value or "").strip()
    if not candidate or _is_network_reference(candidate):
        return ""
    if candidate.lower().startswith("data:"):
        return candidate if _SAFE_DATA_IMAGE.fullmatch(candidate) else ""
    if re.match(r"^[a-z][a-z0-9+.-]*:", candidate, re.IGNORECASE):
        return ""

    path = candidate.split("#", 1)[0].split("?", 1)[0].replace("\\", "/")
    basename = path.rsplit("/", 1)[-1]
    if candidate.startswith("/uworld-library/image/"):
        return candidate
    if not basename or not (
        _IMAGE_EXTENSION.search(path) or "/images/" in f"/{path.lower()}"
    ):
        return ""
    return f"/uworld-library/image/{basename}"


def _srcset_candidates(value: str) -> list[tuple[str, str]]:
    """Parse srcset candidates while preserving a data URI's payload comma."""
    source = str(value or "")
    candidates: list[tuple[str, str]] = []
    position = 0
    length = len(source)
    while position < length:
        while position < length and (
            source[position].isspace() or source[position] == ","
        ):
            position += 1
        if position >= length:
            break

        url_start = position
        if source[position : position + 5].lower() == "data:":
            data_separator = source.find(",", position)
            if data_separator < 0:
                break
            position = data_separator + 1
            while (
                position < length
                and not source[position].isspace()
                and source[position] != ","
            ):
                position += 1
        else:
            while (
                position < length
                and not source[position].isspace()
                and source[position] != ","
            ):
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


def _uworld_srcset(value: str) -> str:
    retained: list[str] = []
    for url, descriptor in _srcset_candidates(value):
        rewritten = _uworld_image_url(url)
        if rewritten:
            retained.append(f"{rewritten} {descriptor}".strip())
    return ", ".join(retained)


def _rewrite_css_urls(css: str) -> str:
    without_imports = _CSS_EXTERNAL_IMPORT.sub("", str(css or ""))

    def replace_url(match: re.Match) -> str:
        value = match.group(2).strip()
        if _is_network_reference(value):
            return "none"
        rewritten = _uworld_image_url(value)
        return f"url({rewritten})" if rewritten else match.group(0)

    return _CSS_URL.sub(replace_url, without_imports)


def _rewrite_article_assets(html: str) -> str:
    """Remove source code and route bundled UWorld article media locally."""
    tree = HTMLParser(html or "")
    for node in tree.css("script"):
        node.decompose()
    for node in tree.css("link"):
        href = str(node.attributes.get("href") or "").strip()
        basename = href.split("?", 1)[0].replace("\\", "/").rsplit("/", 1)[-1]
        if _is_network_reference(href) or basename.lower() in {
            "all.min.css",
            "all2.min.css",
            "tablemedia.css",
        }:
            node.decompose()

    for node in tree.css("*"):
        if "style" in node.attributes:
            node.attrs["style"] = _rewrite_css_urls(node.attributes["style"])
        if "background" in node.attributes:
            background = _uworld_image_url(node.attributes["background"])
            if background:
                node.attrs["background"] = background
            else:
                del node.attrs["background"]

        if node.tag in {"img", "source"}:
            for name in ("src", "data-source"):
                if name not in node.attributes:
                    continue
                rewritten = _uworld_image_url(node.attributes[name])
                if rewritten:
                    node.attrs[name] = rewritten
                else:
                    del node.attrs[name]
            if "srcset" in node.attributes:
                srcset = _uworld_srcset(node.attributes["srcset"])
                if srcset:
                    node.attrs["srcset"] = srcset
                else:
                    del node.attrs["srcset"]
        else:
            if "data-source" in node.attributes:
                data_source = _uworld_image_url(node.attributes["data-source"])
                if data_source:
                    node.attrs["data-source"] = data_source
                else:
                    del node.attrs["data-source"]
            for name in ("src", "poster"):
                if name in node.attributes and _is_network_reference(
                    node.attributes[name]
                ):
                    del node.attrs[name]
            if node.tag not in {"a", "area"}:
                for name in ("href", "xlink:href"):
                    if name in node.attributes and _is_network_reference(
                        node.attributes[name]
                    ):
                        del node.attrs[name]

    rewritten = tree.html
    return re.sub(
        r"(?is)(<style\b[^>]*>)(.*?)(</style>)",
        lambda match: (
            f"{match.group(1)}{_rewrite_css_urls(match.group(2))}{match.group(3)}"
        ),
        rewritten,
    )


def _inner_html(node) -> str:
    markup = node.html
    start = markup.find(">") + 1
    end = markup.rfind("</")
    return markup[start:end] if start > 0 and end >= start else markup


def _remove_print_container_sizing(style: str) -> str:
    retained: list[str] = []
    for declaration in str(style or "").split(";"):
        if ":" not in declaration:
            continue
        property_name, value = declaration.split(":", 1)
        if property_name.strip().lower() in _PRINT_CONTAINER_SIZE_PROPERTIES:
            continue
        retained.append(f"{property_name.strip()}: {value.strip()}")
    return "; ".join(retained)


_ARTICLE_CONTENT_SELECTORS = (
    "#article-content",
    "[data-article-content]",
    ".article-content",
    ".articleContent",
    "[class*='article-content']",
    "[class*='articleContent']",
)
_UNRELATED_BODY_MARKERS = (
    "recommend",
    "qbank",
    "navigation",
    "navbar",
    "toolbar",
    "toolbox",
    "reader-tools",
    "medos-media",
)


def _is_unrelated_body_sibling(node) -> bool:
    if node.tag in {"nav", "header", "footer"}:
        return True
    attributes = node.attributes
    identity = " ".join(
        str(attributes.get(name) or "")
        for name in ("id", "class", "role", "aria-label", "data-testid")
    ).lower()
    return any(marker in identity for marker in _UNRELATED_BODY_MARKERS)


def _uworld_print_source(document: HTMLParser):
    article = document.css_first("article")
    if article is not None:
        return article
    body = document.body
    if body is None:
        return None
    for selector in _ARTICLE_CONTENT_SELECTORS:
        content = body.css_first(selector)
        if content is not None:
            return content
    for child in list(body.iter()):
        if _is_unrelated_body_sibling(child):
            child.decompose()
    return body


def _sanitize_uworld_print_article(html: str) -> str:
    """Extract the article only, reveal it, and keep local media inert."""
    rewritten = _rewrite_article_assets(html)
    document = HTMLParser(rewritten)
    source = _uworld_print_source(document)
    if source is None:
        return ""

    for node in source.css(
        "script,#medos-media-status,.medos-media-actions,.medos-media-action"
    ):
        node.decompose()

    tree = HTMLParser(sanitize_print_fragment(_inner_html(source)))
    for node in tree.css("style,link,video,audio,track"):
        node.decompose()
    for node in tree.css("[style]"):
        style = _remove_print_container_sizing(node.attributes.get("style") or "")
        if style:
            node.attrs["style"] = style
        else:
            del node.attrs["style"]
    for host in tree.css("[data-source]"):
        lazy_source = _uworld_image_url(host.attributes.get("data-source") or "")
        targets = [host] if host.tag in {"img", "source"} else host.css("img,source")
        for target in targets:
            if target is not host and target.attributes.get("data-source"):
                continue
            current = _uworld_image_url(target.attributes.get("src") or "")
            if not current and lazy_source:
                target.attrs["src"] = lazy_source
        del host.attrs["data-source"]
    for node in tree.css("[controls]"):
        del node.attrs["controls"]
    return _inner_html(tree.body) if tree.body else tree.html


def _render_uworld_print(doc_id: int, title: str, decrypted_html: str) -> str:
    """Render one complete, sanitized UWorld Library article for native print."""
    return render_print_document(
        PrintDocument(
            title=title,
            source="UWorld Library",
            source_url=f"/uworld-library/article/{doc_id}",
            body_html=_sanitize_uworld_print_article(decrypted_html),
            citation="UWorld Library local licensed content",
        )
    )


def _rewrite_html(
    doc_id: int,
    html: str,
    theme: str = "light",
    title: str = "",
) -> str:
    html = _rewrite_article_assets(html)
    inject = (
        _BASE_CSS
        + (_DARK_CSS if theme == "dark" else "")
        + media_interop_head(
            "UWorld Library",
            title or f"UWorld Library article {doc_id}",
            f"/uworld-library/article/{doc_id}",
            f"/uworld-library/article/{doc_id}/print",
        )
        + _OUTLINE_SCRIPT
        + annotation_bridge("uworld", doc_id)
    )
    if _RE_HEAD_CLOSE.search(html):
        html = _RE_HEAD_CLOSE.sub(lambda _m: inject + "</head>", html, count=1)
    else:
        html = inject + html
    return html


@lru_cache(maxsize=4096)
def article_images(doc_id: int, limit: int = 10) -> list[dict]:
    """Image filenames embedded in one decrypted library article, as /image URLs.

    Used by the UMLS media wall to surface the figures that live INSIDE a UWorld
    library article tagged to a concept. Best-effort — returns [] on any failure.
    Cached per doc (decryption is the cost) so popular articles only decrypt once.
    """
    try:
        c = _conn()
        try:
            row = c.execute("SELECT id, title, doc FROM Docs WHERE id=?", (doc_id,)).fetchone()
        finally:
            c.close()
        if not row or not row["doc"]:
            return []
        html = _decrypt_doc(doc_id, row["doc"])
    except Exception:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for m in _RE_IMG_REL.finditer(html):
        name = m.group(2)
        if name in seen:
            continue
        seen.add(name)
        out.append({"name": name, "url": f"/uworld-library/image/{name}", "title": row["title"] or ""})
        if len(out) >= limit:
            break
    return out


# ─── Endpoints ──────────────────────────────────────────────────────────────

# TOC shape (verified): leaf=1 marks the 23 specialty roots (parentId=0) and the
# 1,529 article nodes; there are NO intermediate folders. leaf=0 nodes are
# in-article section anchors (same docId, a `section` value) — noise for browsing,
# so toc/children returns only the article-level (leaf=1) children of a specialty.

@router.get("/specialties")
def specialties():
    """Root TOC entries (the specialty list). Each is an expandable folder."""
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, name, docId FROM TOC "
            "WHERE parentId IS NULL OR parentId=0 ORDER BY name"
        ).fetchall()
    finally:
        c.close()
    return [
        {"id": r["id"], "name": r["name"], "docId": r["docId"], "isArticle": False}
        for r in rows
    ]


# ─── "Topics organized" (subject-based tree) ────────────────────────────────
#
# The vendor TOC is flat: 23 specialties → 1,529 articles, with no middle layer.
# MedOS adds a discipline layer on top so the same articles can ALSO be browsed
# as Category → main topic → subtopic (e.g. Surgery → Esophagus → GERD). The
# mapping is generated once and stored beside the bundle as `uworld-topics.json`
# so it survives application updates; this endpoint only joins it against Docs,
# which keeps article titles authoritative and detects drift in either direction.

_TOPICS_FILE = "uworld-topics.json"
_TOPICS_CACHE: dict = {"key": None, "data": None}


def _topics_path() -> Optional[Path]:
    try:
        bundle = _bundle_dir()
    except HTTPException:
        return None
    p = bundle / _TOPICS_FILE
    return p if p.exists() else None


def _load_topics_json() -> Optional[dict]:
    p = _topics_path()
    if p is None:
        return None
    try:
        st = p.stat()
        key = (str(p), st.st_mtime_ns, st.st_size)
    except OSError:
        return None
    if _TOPICS_CACHE["key"] == key:
        return _TOPICS_CACHE["data"]
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    _TOPICS_CACHE["key"] = key
    _TOPICS_CACHE["data"] = data
    return data


def _numbered(index: int, name: str) -> str:
    name = re.sub(r"^\s*\d+\)\s*", "", str(name or "").strip()) or "Untitled"
    return f"{index}) {name}"


@router.get("/organized")
def organized_topics():
    """Discipline → topic → article tree over the whole library.

    Every article in `Docs` appears exactly once. Anything missing from the
    generated taxonomy is surfaced under a final "Other articles → Unfiled"
    bucket rather than being silently dropped.
    """
    c = _conn()
    try:
        rows = c.execute("SELECT id, title FROM Docs ORDER BY title").fetchall()
    finally:
        c.close()
    titles = {int(r["id"]): (r["title"] or "") for r in rows}

    taxonomy = _load_topics_json()
    assigned: set[int] = set()
    categories: list[dict] = []

    for cat in (taxonomy or {}).get("categories", []):
        topics_out: list[dict] = []
        for topic in cat.get("topics", []):
            articles = []
            for raw_id in topic.get("docIds", []):
                try:
                    doc_id = int(raw_id)
                except (TypeError, ValueError):
                    continue
                if doc_id in assigned or doc_id not in titles:
                    continue
                assigned.add(doc_id)
                articles.append({"docId": doc_id, "title": titles[doc_id]})
            if articles:
                articles.sort(key=lambda a: a["title"].lower())
                for pos, article in enumerate(articles, start=1):
                    article["position"] = pos
                topics_out.append({
                    "name": _numbered(len(topics_out) + 1, topic.get("name")),
                    "articleCount": len(articles),
                    "articles": articles,
                })
        if topics_out:
            categories.append({
                "name": _numbered(len(categories) + 1, cat.get("name")),
                "articleCount": sum(t["articleCount"] for t in topics_out),
                "topics": topics_out,
            })

    leftover = [{"docId": did, "title": t} for did, t in titles.items() if did not in assigned]
    if leftover:
        leftover.sort(key=lambda a: a["title"].lower())
        for pos, article in enumerate(leftover, start=1):
            article["position"] = pos
        categories.append({
            "name": _numbered(len(categories) + 1, "Other articles"),
            "articleCount": len(leftover),
            "topics": [{
                "name": "1) Unfiled",
                "articleCount": len(leftover),
                "articles": leftover,
            }],
        })

    return {
        "total": len(titles),
        "covered": len(assigned),
        "taxonomyAvailable": taxonomy is not None,
        "categories": categories,
    }


@router.get("/toc/{toc_id}")
def toc_children(toc_id: int):
    """Article-level children of a specialty node (leaf=1, openable by docId)."""
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, name, docId FROM TOC WHERE parentId=? AND leaf=1 ORDER BY id",
            (toc_id,),
        ).fetchall()
    finally:
        c.close()
    return [
        {"id": r["id"], "name": r["name"], "docId": r["docId"], "isArticle": True}
        for r in rows
    ]


@router.get("/search")
def search(q: str = Query(..., min_length=1, max_length=200)):
    """Title search over Docs (prefix-first, then substring)."""
    term = q.strip()
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, title FROM Docs WHERE title LIKE ? "
            "ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, length(title), title LIMIT 40",
            (f"%{term}%", f"{term}%"),
        ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "title": r["title"]} for r in rows]


@router.get("/autocomplete")
def autocomplete(q: str = Query(..., min_length=1, max_length=100)):
    term = q.strip()
    c = _conn()
    try:
        rows = c.execute(
            "SELECT id, title FROM Docs WHERE title LIKE ? "
            "ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, length(title) LIMIT 12",
            (f"%{term}%", f"{term}%"),
        ).fetchall()
    finally:
        c.close()
    return [{"id": r["id"], "title": r["title"]} for r in rows]


def _article_row(doc_id: int) -> sqlite3.Row:
    c = _conn()
    try:
        row = c.execute("SELECT id, title, doc FROM Docs WHERE id=?", (doc_id,)).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, f"Article {doc_id} not found")
    return row


@router.get("/article/{doc_id}/print", response_class=HTMLResponse)
def article_print(doc_id: int):
    """Complete, inert UWorld Library article for the native print flow."""
    if not (1 <= doc_id <= 9_999_999):
        raise HTTPException(422, "invalid doc_id")

    row = _article_row(doc_id)
    if not row["doc"]:
        raise HTTPException(410, f"Article {doc_id} has no content")
    try:
        decrypted = _decrypt_doc(doc_id, row["doc"])
    except Exception as exc:
        raise HTTPException(500, f"Article {doc_id} could not be decrypted") from exc
    if not decrypted.strip():
        raise HTTPException(410, f"Article {doc_id} is empty")
    return HTMLResponse(
        content=_render_uworld_print(doc_id, row["title"] or "", decrypted),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/article/{doc_id}", response_class=HTMLResponse)
def article(doc_id: int, theme: str = Query("light")):
    row = _article_row(doc_id)
    if not row["doc"]:
        raise HTTPException(410, f"Article {doc_id} has no content")
    try:
        decrypted = _decrypt_doc(doc_id, row["doc"])
    except Exception as exc:
        raise HTTPException(500, f"Article {doc_id} could not be decrypted") from exc
    if not decrypted.strip():
        raise HTTPException(410, f"Article {doc_id} is empty")
    html = _rewrite_html(doc_id, decrypted, theme, row["title"] or "")
    return HTMLResponse(content=html)


@router.get("/article/{doc_id}/meta")
def article_meta(doc_id: int):
    c = _conn()
    try:
        row = c.execute("SELECT id, title FROM Docs WHERE id=?", (doc_id,)).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, f"Article {doc_id} not found")
    return {"id": row["id"], "title": row["title"]}


@router.get("/article/{doc_id}/json")
def article_json(doc_id: int, theme: str = Query("light")):
    row = _article_row(doc_id)
    if not row["doc"]:
        raise HTTPException(410, f"Article {doc_id} has no content")
    try:
        decrypted = _decrypt_doc(doc_id, row["doc"])
    except Exception as exc:
        raise HTTPException(500, f"Article {doc_id} could not be decrypted") from exc
    if not decrypted.strip():
        raise HTTPException(410, f"Article {doc_id} is empty")
    html = _rewrite_html(doc_id, decrypted, theme, row["title"] or "")
    return {"id": row["id"], "title": row["title"], "html": html}


@router.get("/resolve-title")
def resolve_title(title: str = Query(..., min_length=1, max_length=300)):
    """Resolve an exact (case-insensitive) article title to its doc id.

    Backs the UWorld qbank ⇄ library link: a question's `Refs` (refType=18)
    titles are matched to library articles by exact title.
    """
    t = title.strip()
    c = _conn()
    try:
        row = c.execute(
            "SELECT id, title FROM Docs WHERE lower(title)=lower(?) LIMIT 1", (t,)
        ).fetchone()
    finally:
        c.close()
    if not row:
        return {"id": None, "title": None}
    return {"id": row["id"], "title": row["title"]}


@router.get("/articles")
def articles(
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
):
    c = _conn()
    try:
        total = c.execute("SELECT COUNT(*) FROM Docs").fetchone()[0]
        rows = c.execute(
            "SELECT id, title FROM Docs ORDER BY title LIMIT ? OFFSET ?", (limit, offset)
        ).fetchall()
    finally:
        c.close()
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "articles": [{"id": r["id"], "title": r["title"]} for r in rows],
    }


@router.get("/image/{image_name}")
def image(image_name: str):
    name = Path(image_name).name  # strip any path traversal
    base = images_dir()
    if not base:
        raise HTTPException(404, "Images directory not available")
    path = base / name
    if not path.exists():
        # tolerate extension-less or case differences
        stem = Path(name).stem
        cand = next((p for p in base.glob(f"{stem}.*")), None)
        if cand is None:
            raise HTTPException(404, f"Image not found: {name}")
        path = cand
    return FileResponse(str(path))


@router.get("/health")
def health():
    try:
        db = _db_path()
        c = _conn()
        try:
            doc_count = c.execute("SELECT COUNT(*) FROM Docs").fetchone()[0]
            toc_count = c.execute("SELECT COUNT(*) FROM TOC").fetchone()[0]
            row = c.execute(
                "SELECT id, title, doc FROM Docs WHERE doc IS NOT NULL LIMIT 1"
            ).fetchone()
        finally:
            c.close()
        html_len = len(_decrypt_doc(row["id"], row["doc"])) if row else 0
        return {
            "ok": True,
            "db": str(db),
            "docs": doc_count,
            "toc_nodes": toc_count,
            "sample_id": row["id"] if row else None,
            "sample_title": row["title"] if row else None,
            "sample_html_len": html_len,
            "images_dir": str(images_dir()) if images_dir() else None,
        }
    except HTTPException as e:
        return {"ok": False, "error": e.detail}
    except Exception as e:  # pragma: no cover
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

"""
UpToDate reader — FastAPI router.

Reads the Android iMedicalDoctor `imduptodate2026-*` bundle:
  utdasset_decrypted.sqlite → pre-decrypted topic_content (id, content JSON)
  utdasset.sqlite           → encrypted graphic_asset / other_asset
  utdtoc.db                 → TOC hierarchy + TOCMap (tocId ↔ topicId)
  unidex.en.sqlite          → topic (topic_id, title) and FTS
  utdqf.sqlite              → quick-find autocomplete
  thumbs.db                 → unencrypted base64 JPEG thumbnails

Topic HTML uses a prepared cache when available, otherwise decrypts one topic
on demand. The recognized shipped bundle includes its content key; UTD_PASSWORD
can override it for another content bundle.
"""
from __future__ import annotations

import base64
import datetime
import json
import os
import re
import sqlite3
import unicodedata
from functools import lru_cache
from html import escape, unescape
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from selectolax.parser import HTMLParser

import umls_reader
from article_export import (
    PrintDocument,
    PrintSection,
    data_uri,
    missing_asset,
    render_print_document,
    sanitize_print_fragment,
)
from config import UTD_DB_PATH
from media_interop import media_interop_head
from reader_annotations import annotation_bridge
from utd_crypto import UTDKey
from utd_content import UTDContentError, UTDTopicUnavailable, configured_bundle_dir, decode_topic_content, decrypt_topic, resolve_key

# ─── Paths / config ────────────────────────────────────────────────────────
BASE = Path(__file__).parent
STATIC_DIR = BASE / "utd_static"

router = APIRouter(prefix="/utd", tags=["UpToDate"])


class ScanRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=120000)
    limit: int = Field(default=80, ge=1, le=250)


_ABBREVIATION_EXPANSIONS = {
    "dvt": "deep vein thrombosis",
    "pe": "pulmonary embolism",
    "sids": "sudden infant death syndrome",
    "tia": "transient ischemic attack",
    "vte": "venous thromboembolism",
}


def _bundle_dir() -> Path:
    p = configured_bundle_dir(UTD_DB_PATH)
    if not p.exists():
        raise HTTPException(503, f"UTD_DB_PATH does not exist: {p}")
    return p


def _key() -> Optional[UTDKey]:
    return resolve_key(_bundle_dir())


def _need_key() -> UTDKey:
    k = _key()
    if k is None:
        raise HTTPException(
            503,
            "Set UTD_PASSWORD to this bundle's content key. The download ZIP "
            "password is separate. Thumbnails remain available without it.",
        )
    return k


def _conn(filename: str) -> sqlite3.Connection:
    p = _bundle_dir() / filename
    if not p.exists():
        if filename == "utdasset_decrypted.sqlite":
            raise HTTPException(
                503,
                "UpToDate articles need a one-time local decrypt step. Open Content "
                "Manager -> UpToDate -> 'Prepare UpToDate' (or run "
                "scripts/utd_decrypt_assets.py) — see POST /content/prepare-utd.",
            )
        raise HTTPException(503, f"UTD bundle missing file: {filename}")
    c = sqlite3.connect(p.resolve().as_uri() + "?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _decrypted_conn() -> sqlite3.Connection:
    return _conn("utdasset_decrypted.sqlite")


def _topic_data(topic_id: int) -> dict:
    """Read a validated cached row, or decrypt just the requested article."""
    try:
        dc = _decrypted_conn()
        try:
            row = dc.execute("SELECT content FROM topic_content WHERE id=?", (topic_id,)).fetchone()
            if row:
                return decode_topic_content(row["content"])
        finally:
            dc.close()
    except (HTTPException, sqlite3.Error, UTDContentError):
        # An old failed preparation may have created an empty or corrupt cache.
        # Never modify it while serving; the explicit Prepare action repairs it.
        pass
    try:
        ac = _conn("utdasset.sqlite")
        try:
            row = ac.execute("SELECT payload FROM topic_asset WHERE id=?", (topic_id,)).fetchone()
        finally:
            ac.close()
        if not row:
            raise HTTPException(404, f"topic {topic_id} not in bundle")
        return decrypt_topic(_need_key(), topic_id, row["payload"])
    except UTDTopicUnavailable as exc:
        raise HTTPException(404, str(exc)) from None
    except UTDContentError as exc:
        raise HTTPException(503, str(exc)) from None
    except sqlite3.Error:
        raise HTTPException(503, "UpToDate content is unreadable; repair the installed content pack.") from None


# ─── HTML template ─────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _templates() -> tuple[str, str]:
    hdr = (STATIC_DIR / "UTDHeader.css").read_text(encoding="utf-8")
    ftr = (STATIC_DIR / "UTDFooter.css").read_text(encoding="utf-8")
    return hdr, ftr


# JS bridge injected before </body>:
#   • intercepts app/web custom-scheme links → postMessage to React parent
#   • listens for {type:"utd-scroll", section:"H34"} from parent → smooth-scroll to section
_NAV_BRIDGE = r"""
<script>
(function () {
  function post(msg) {
    try { if (window.parent) window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  window.onBodyLoad      = window.onBodyLoad      || function () {};
  window.getResource     = window.getResource     || function (r) { post({type:"utd-resource", resource: String(r||"")}); };
  window.highlightSearchTerm = window.highlightSearchTerm || function () {};
  window.setHighlightClass   = window.setHighlightClass   || function () {};
  window.clearHighlight      = window.clearHighlight      || function () {};

  // appAction() called directly from inline event handlers in the HTML
  window.appAction = window.appAction || function (payload) {
    if (!payload) return;
    var data = typeof payload === "string" ? JSON.parse(payload) : payload;
    post({ type: "utd-app", data: data });
  };

  function parseAction(href) {
    var idx = href.indexOf("//");
    return idx < 0 ? "" : href.substring(idx + 2);
  }

  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href) return;

    if (href.indexOf("uptodateappaction") === 0) {
      e.preventDefault();
      var payload = parseAction(href);
      try { post({ type: "utd-app", data: JSON.parse(decodeURIComponent(payload)) }); }
      catch (err) { console.error("[utd-bridge] app payload:", err); }
      return;
    }
    if (href.indexOf("uptodatewebaction") === 0) {
      e.preventDefault();
      var slug = parseAction(href);
      if (slug[0] === "/") slug = slug.slice(1);
      post({ type: "utd-web", action: slug });
      return;
    }
    if (href.indexOf("javascript:") === 0) {
      e.preventDefault();
      var m = href.match(/appAction\((.+)\)/);
      if (m) {
        try {
          var d = JSON.parse(m[1]);
          post({ type: "utd-app", data: d });
        } catch (_) {}
      }
      var m2 = href.match(/getResource\(['"]([^'"]+)['"]\)/);
      if (m2) post({ type: "utd-resource", resource: m2[1] });
      return;
    }
    if (href[0] === "#") {
      e.preventDefault();
      var el = document.getElementById(href.slice(1));
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (href.indexOf("http://") === 0 || href.indexOf("https://") === 0) {
      e.preventDefault();
      post({ type: "utd-external", url: href });
      return;
    }
  }, true);

  // Listen for scroll commands from the sidebar outline
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "utd-scroll" && d.section) {
      var el = document.getElementById(d.section);
      if (el) {
        // Auto-expand if the section body is collapsed
        var bodyEl = el.nextElementSibling;
        if (bodyEl && bodyEl.classList && bodyEl.classList.contains("medos-closed")) {
          if (window.medosOpenAccordion) {
            window.medosOpenAccordion(el, true);
          } else {
            bodyEl.classList.remove("medos-closed");
            el.classList.remove("medos-closed");
            var chEl = el.querySelector(".medos-ch");
            if (chEl) chEl.textContent = "\u25BE";
          }
        }
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    // Restore a saved scroll offset (back-navigation / app-restart resume)
    if (d.type === "utd-scroll" && typeof d.y === "number") {
      try { window.scrollTo(0, d.y); } catch (e) {}
    }
    if (d.type === "utd-find" && d.query) {
      // Simple find-in-page: clear previous highlights, find and scroll
      var prev = document.querySelectorAll(".medos-find-hl");
      for (var i = 0; i < prev.length; i++) {
        var p = prev[i];
        p.outerHTML = p.textContent || "";
      }
      if (window.find) {
        window.getSelection().removeAllRanges();
        window.find(d.query, false, false, true);
      }
    }
  });

  // Report scroll position so the parent can persist it (rAF-throttled).
  var _utdRaf = 0, _utdLastY = -1;
  window.addEventListener("scroll", function () {
    if (_utdRaf) return;
    _utdRaf = requestAnimationFrame(function () {
      _utdRaf = 0;
      var y = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
      if (Math.abs(y - _utdLastY) < 2) return;
      _utdLastY = y;
      post({ type: "utd-scroll", y: y });
    });
  }, { passive: true });

  function sendReady() {
    var h = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0);
    post({ type: "utd-ready", height: h });
  }
  if (document.readyState === "complete") sendReady();
  else window.addEventListener("load", sendReady);
})();
</script>
"""

_SIDEBAR_ARTICLE_CSS = r"""
<style id="medos-utd-sidebar-layout">
html {
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  margin: 0 !important;
  overflow-x: hidden !important;
  background: #ffffff !important;
}
body {
  width: auto !important;
  max-width: 100% !important;
  min-width: 0 !important;
  margin: 0 !important;
  overflow-x: hidden !important;
  background: #ffffff !important;
  box-sizing: border-box !important;
  overflow-wrap: break-word !important;
  word-wrap: break-word !important;
  word-break: normal !important;
}
body {
  padding: 12px 16px 40px !important;
}
*,
*::before,
*::after {
  box-sizing: border-box !important;
}
body > *,
#contentBody,
#contentBody > *,
#topicContent,
#topicText,
#topicText > *,
.topic,
.topicContent,
.topicText,
.content,
.body,
.main,
article,
section {
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
}
#contentBody,
#topicContent,
#topicText {
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
}
#topicText p,
#topicText li,
#topicText div,
#topicText span {
  max-width: 100% !important;
  overflow-wrap: anywhere !important;
  word-wrap: break-word !important;
}
#topicText table,
table {
  width: 100% !important;
  max-width: 100% !important;
  table-layout: auto !important;
  display: block !important;
  overflow-x: auto !important;
  -webkit-overflow-scrolling: touch;
}
#topicText tbody,
#topicText thead,
#topicText tfoot,
#topicText tr {
  max-width: 100% !important;
}
#topicText td,
#topicText th {
  min-width: 0 !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
}
#topicText .figure,
#topicText .FIGURE,
#topicText .FG,
#topicText .TB {
  width: auto !important;
  max-width: 100% !important;
  overflow-x: auto !important;
}
#topicText img,
#topicText video,
img,
video {
  width: auto !important;
  max-width: 100% !important;
  height: auto !important;
}
/* Mobile-optimised reading */
@media (max-width: 640px) {
  body {
    padding: 10px 12px 60px !important;
    font-size: 15px !important;
    line-height: 1.65 !important;
    -webkit-text-size-adjust: 100% !important;
  }
  #topicText p,
  #topicText li {
    font-size: 15px !important;
    line-height: 1.65 !important;
    text-align: left !important;
    hyphens: auto;
  }
  #topicText table {
    font-size: 13px !important;
  }
  p.headingAnchor span.h1 {
    font-size: 19px !important;
  }
  p.headingAnchor span.h2 {
    font-size: 16px !important;
  }
  p.headingAnchor.medos-acc-h {
    padding: 10px 0 !important;
    min-height: 44px !important;
  }
}
</style>
"""

_DARK_ARTICLE_CSS = r"""
<style id="medos-utd-dark-theme">
:root {
  --medos-utd-accordion-fade: #0f172a;
}
html,
body {
  color-scheme: dark !important;
  background: #0f172a !important;
  color: #e5edf8 !important;
}
body,
#contentBody,
#topicContent,
#topicText,
.topic,
.topicContent,
.topicText,
.content,
.body,
.main,
article,
section {
  background: #0f172a !important;
  color: #e5edf8 !important;
}
#topicText p,
#topicText li,
#topicText div,
#topicText span,
#topicText td,
#topicText th,
#topicText label,
#topicText dd,
#topicText dt,
#topicText blockquote,
body p,
body li,
body div,
body td,
body th {
  color: #e5edf8 !important;
}
#topicText h1,
#topicText h2,
#topicText h3,
#topicText h4,
#topicText h5,
#topicText h6,
#topicText .h1,
#topicText .h2,
#topicText .h3,
#topicText .h4,
#topicText .h5,
#topicText .h6,
#topicText strong,
#topicText b,
body h1,
body h2,
body h3,
body h4,
body strong,
body b {
  color: #f8fafc !important;
}
#topicText a,
body a {
  color: #67e8f9 !important;
}
#topicText table,
body table,
.table-default-style,
.table-header-footer-style,
.table-footer-only-style {
  background: #111827 !important;
  border-color: #334155 !important;
  color: #e5edf8 !important;
}
#topicText thead,
#topicText tbody,
#topicText tfoot,
#topicText tr,
body thead,
body tbody,
body tfoot,
body tr {
  background: transparent !important;
}
#topicText th,
#topicText td,
body th,
body td {
  background: #111827 !important;
  border-color: #334155 !important;
  color: #e5edf8 !important;
}
#topicText tr:nth-child(even) td,
body tr:nth-child(even) td {
  background: #172033 !important;
}
#topicText img,
body img,
#topicText video,
body video {
  background: #ffffff !important;
  border-color: #334155 !important;
}
p.headingAnchor.medos-acc-h {
  background: linear-gradient(90deg, rgba(20,184,166,.18), rgba(15,23,42,0) 76%) !important;
  border-left-color: rgba(45,212,191,.82) !important;
}
p.headingAnchor.medos-acc-h:hover {
  background: linear-gradient(90deg, rgba(20,184,166,.25), rgba(15,23,42,0) 80%) !important;
}
.medos-acc-body {
  background: transparent !important;
}
.medos-ch {
  color: #99f6e4 !important;
}
hr,
.headingEndMark {
  border-color: #334155 !important;
}
mark,
.medos-find-hl {
  background: rgba(250,204,21,.32) !important;
  color: #f8fafc !important;
}
</style>
"""


_ACCORDION_SCRIPT = r"""
<style>
/* UTD accordion */
p.headingAnchor.medos-acc-h{
  cursor:pointer!important;
  user-select:none!important;
  -webkit-tap-highlight-color:transparent;
  position:relative!important;
  padding:10px 34px 9px 12px!important;
  margin:18px 0 8px!important;
  border:0!important;
  border-left:3px solid rgba(0,133,124,.72)!important;
  border-radius:7px!important;
  background:linear-gradient(90deg,rgba(0,133,124,.07),rgba(255,255,255,0) 72%)!important;
  transition:background .22s ease,border-color .22s ease,box-shadow .22s ease!important;
}
p.headingAnchor.medos-acc-h:hover{
  background:linear-gradient(90deg,rgba(0,133,124,.11),rgba(255,255,255,0) 78%)!important;
  border-left-color:rgba(0,133,124,.9)!important;
}
p.headingAnchor.medos-acc-h.medos-closed{
  border-left-color:rgba(0,133,124,.42)!important;
  box-shadow:0 1px 0 rgba(0,133,124,.08)!important;
}
p.headingAnchor.medos-acc-h .headingEndMark{
  display:none!important;
}
p.headingAnchor.medos-acc-h span.h1 .medos-ch{
  position:absolute;
  right:12px;
  top:50%;
  transform:translateY(-50%);
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:20px;
  height:20px;
  border-radius:999px;
  background:rgba(0,133,124,.1);
  color:#00756e;
  font-size:11px;
  line-height:1;
  opacity:1;
  font-weight:normal;
  transition:transform .25s ease,background .2s ease;
}
.medos-acc-body{
  display:block!important;
  overflow:hidden!important;
  position:relative!important;
  max-height:none;
  opacity:1;
  transform:translateY(0);
  -webkit-mask-image:none;
  mask-image:none;
  transition:max-height .4s cubic-bezier(.22,.61,.36,1),opacity .24s ease,transform .24s ease,-webkit-mask-image .2s ease,mask-image .2s ease;
  will-change:max-height,opacity,transform;
}
.medos-acc-body.medos-closed{
  max-height:128px;
  opacity:1;
  transform:translateY(-1px);
  cursor:pointer;
  -webkit-mask-image:linear-gradient(to bottom,#000 0%,#000 46%,rgba(0,0,0,.72) 68%,transparent 100%);
  mask-image:linear-gradient(to bottom,#000 0%,#000 46%,rgba(0,0,0,.72) 68%,transparent 100%);
  -webkit-mask-size:100% 100%;
  mask-size:100% 100%;
  -webkit-mask-repeat:no-repeat;
  mask-repeat:no-repeat;
}
.medos-acc-body.medos-closed::after{
  content:"";
  position:absolute;
  left:0;
  right:0;
  bottom:0;
  height:56px;
  pointer-events:none;
  background:linear-gradient(to bottom,rgba(255,255,255,0),var(--medos-utd-accordion-fade,#fff) 82%);
}
.medos-acc-body .medos-empty-leader{
  display:none!important;
}
@media (max-width:640px){
  .medos-acc-body.medos-closed{max-height:116px;}
}
</style>
<script>
(function(){
  function closedHeight(){
    return window.matchMedia&&window.matchMedia("(max-width:640px)").matches?116:128;
  }

  function hideEmptyLeaders(body){
    var el=body.firstElementChild;
    var guard=0;
    while(el&&guard<4){
      var text=(el.textContent||"").replace(/\s+/g," ").trim();
      if(text&&/^[\u2010-\u2015\-\u2212\/\\|]+$/.test(text)){
        el.classList.add("medos-empty-leader");
        el=el.nextElementSibling;
        guard++;
        continue;
      }
      break;
    }
  }

  function setState(header,body,ch,open,instant){
    header.classList.toggle("medos-closed",!open);
    header.setAttribute("aria-expanded",open?"true":"false");
    if(ch) ch.textContent=open?"\u25BE":"\u25B8";
    if(instant){
      body.classList.toggle("medos-open",open);
      body.classList.toggle("medos-closed",!open);
      body.style.maxHeight=open?"none":"";
      return;
    }
    var targetClosed=closedHeight();
    var start=body.getBoundingClientRect().height||targetClosed;
    body.style.maxHeight=start+"px";
    body.offsetHeight;
    if(open){
      body.classList.remove("medos-closed");
      body.classList.add("medos-open");
      requestAnimationFrame(function(){
        body.style.maxHeight=body.scrollHeight+"px";
      });
      var done=function(e){
        if(e.propertyName!=="max-height") return;
        body.style.maxHeight="none";
        body.removeEventListener("transitionend",done);
      };
      body.addEventListener("transitionend",done);
    }else{
      body.style.maxHeight=body.scrollHeight+"px";
      body.offsetHeight;
      requestAnimationFrame(function(){
        body.classList.add("medos-closed");
        body.classList.remove("medos-open");
        body.style.maxHeight=targetClosed+"px";
      });
    }
  }

  function run(){
    var root=document.getElementById('topicText');
    if(!root) return;
    // UTD uses <p class="headingAnchor"> with <span class="h1"> for top-level sections.
    var all=Array.from(root.querySelectorAll('p.headingAnchor'));
    var tops=all.filter(function(p){return p.querySelector('span.h1');});
    if(tops.length<2) return;
    tops.forEach(function(p,idx){
      var sib=[],el=p.nextElementSibling;
      while(el){
        if(el.classList&&el.classList.contains('headingAnchor')&&el.querySelector('span.h1')) break;
        sib.push(el);el=el.nextElementSibling;
      }
      if(!sib.length) return;
      var body=document.createElement('div');
      body.className='medos-acc-body'+(idx>0?' medos-closed':'');
      p.parentNode.insertBefore(body,sib[0]);
      sib.forEach(function(s){body.appendChild(s);});
      hideEmptyLeaders(body);
      // Place chevron inside span.h1 (display:block) so it floats right on the title line
      var titleSpan=p.querySelector('span.h1');
      var endMark=p.querySelector('.headingEndMark');
      if(endMark) endMark.remove();
      var ch=document.createElement('span');
      ch.className='medos-ch';ch.textContent=idx===0?'\u25BE':'\u25B8';
      if(titleSpan) titleSpan.appendChild(ch); else p.appendChild(ch);
      p.classList.add('medos-acc-h');
      if(idx>0) p.classList.add('medos-closed');
      p.setAttribute('role','button');
      p.setAttribute('tabindex','0');
      setState(p,body,ch,idx===0,true);
      p.addEventListener('click',function(){
        var closing=!body.classList.contains('medos-closed');
        setState(p,body,ch,!closing,false);
      });
      p.addEventListener('keydown',function(e){
        if(e.key==='Enter'||e.key===' '){
          e.preventDefault();
          var closing=!body.classList.contains('medos-closed');
          setState(p,body,ch,!closing,false);
        }
      });
      body.addEventListener('click',function(e){
        if(!body.classList.contains('medos-closed')) return;
        e.preventDefault();
        e.stopPropagation();
        setState(p,body,ch,true,false);
      },true);
      p.medosAccBody=body;
      p.medosAccChevron=ch;
      p.medosSetAccordionState=function(open,instant){setState(p,body,ch,open,instant);};
    });
    window.medosOpenAccordion=function(header,instant){
      if(header&&header.medosSetAccordionState) header.medosSetAccordionState(true,!!instant);
    };
    window.addEventListener('resize',function(){
      tops.forEach(function(p){
        var body=p.medosAccBody;
        if(body&&body.classList.contains('medos-closed')) body.style.maxHeight='';
      });
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run);
  else run();
})();
</script>
"""


def _render_topic(
    title: str,
    body_html: str,
    theme: str = "light",
    source_url: str = "/utd",
    print_url: str = "",
    ref_id: str = "",
) -> str:
    hdr, ftr = _templates()
    hdr = hdr.replace("[size]", "100").replace("[Title]", title or "")
    hdr = re.sub(r'(<script\b[^>]*\bsrc=["\'])(?!https?://|/)([^"\']+)(["\'])', r'\1/utd/static/\2\3', hdr)
    hdr = re.sub(r'url\((["\']?)(?!data:|https?://|/)([^)"\']+)(["\']?)\)', r'url(\1/utd/static/\2\3)', hdr)
    ftr = ftr.replace("[year]", str(datetime.date.today().year))
    article_theme_css = _DARK_ARTICLE_CSS if theme == "dark" else ""
    injected_head = (
        '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">\n'
        + _SIDEBAR_ARTICLE_CSS
        + article_theme_css
        + media_interop_head("UpToDate", title, source_url, print_url)
    )
    if "</head>" in hdr:
        hdr = hdr.replace("</head>", injected_head + "\n</head>", 1)
    else:
        hdr += injected_head
    return hdr + body_html + ftr.replace(
        "</body>",
        _NAV_BRIDGE + _ACCORDION_SCRIPT + annotation_bridge("utd", ref_id) + "\n</body>",
    )


# ─── TOC navigation ────────────────────────────────────────────────────────

@router.get("/specialties")
def specialties():
    c = _conn("utdtoc.db")
    try:
        rows = c.execute(
            "SELECT id,title,leaf,section FROM TOC "
            "WHERE parentId=0 ORDER BY title"
        ).fetchall()
    finally:
        c.close()
    return [
        {"id": r["id"], "title": r["title"] or "",
         "leaf": r["leaf"], "section": r["section"] or ""}
        for r in rows
    ]


@router.get("/toc/{node_id}")
def toc_children(node_id: int):
    c = _conn("utdtoc.db")
    try:
        rows = c.execute(
            """
            SELECT t.id, t.title, t.leaf, t.section, m.topicId
            FROM TOC t LEFT JOIN TOCMap m ON m.tocId = t.id
            WHERE t.parentId = ?
            ORDER BY t.title
            """,
            (node_id,),
        ).fetchall()
    finally:
        c.close()
    return [
        {"id": r["id"], "title": r["title"] or "",
         "leaf": r["leaf"], "section": r["section"] or "",
         "topicId": r["topicId"]}
        for r in rows
    ]


def _breadcrumb(conn: sqlite3.Connection, toc_id: int) -> list[str]:
    path: list[str] = []
    node = toc_id
    for _ in range(12):
        r = conn.execute("SELECT title,parentId FROM TOC WHERE id=?", (node,)).fetchone()
        if not r:
            break
        path.insert(0, r["title"] or "")
        if r["parentId"] == 0:
            break
        node = r["parentId"]
    return path


# ─── Topic ─────────────────────────────────────────────────────────────────

def _parse_related_topics(rt_raw) -> list[dict]:
    """Parse relatedTopics JSON field → [{id, title, subtype}]."""
    if not rt_raw:
        return []
    try:
        if isinstance(rt_raw, str):
            rt_raw = json.loads(rt_raw)
        topics = rt_raw.get("topics", []) if isinstance(rt_raw, dict) else rt_raw
        return [
            {
                "id": int(t["id"]),
                "title": t.get("title", ""),
                "subtype": t.get("subtype", ""),
            }
            for t in topics
            if t.get("id") and not t.get("hideInResults", False)
        ]
    except Exception:
        return []


def _parse_related_graphics(rg_raw) -> list[dict]:
    """Parse relatedGraphics JSON field → [{id, title, label, subtype}]."""
    if not rg_raw:
        return []
    try:
        if isinstance(rg_raw, str):
            rg_raw = json.loads(rg_raw)
        out = []
        groups = rg_raw if isinstance(rg_raw, list) else [rg_raw]
        for group in groups:
            for g in group.get("graphics", []):
                info = g.get("graphicInfo", {})
                gid = info.get("id")
                if not gid:
                    continue
                out.append({
                    "id": int(gid),
                    "title": info.get("displayName", ""),
                    "label": g.get("label", ""),
                    "subtype": info.get("subtype", ""),
                })
        return out
    except Exception:
        return []


def _extract_print_graphic_ids(body_html: str, related_graphics) -> list[int]:
    """Collect body graphic references first, followed by related graphics."""
    decoded_body = unescape(body_html or "")
    ids: list[int] = []
    seen: set[int] = set()

    def add(raw_id) -> None:
        try:
            graphic_id = int(raw_id)
        except (TypeError, ValueError):
            return
        if graphic_id <= 0 or graphic_id in seen:
            return
        seen.add(graphic_id)
        ids.append(graphic_id)

    for match in re.finditer(
        r'["\']graphicId["\']\s*:\s*["\']?(\d+)',
        decoded_body,
        flags=re.IGNORECASE,
    ):
        add(match.group(1))

    parsed_related = related_graphics
    if not (
        isinstance(parsed_related, list)
        and all(isinstance(item, dict) and "id" in item for item in parsed_related)
    ):
        parsed_related = _parse_related_graphics(related_graphics)
    for graphic in parsed_related or []:
        add(graphic.get("id") if isinstance(graphic, dict) else None)
    return ids


def _graphic_value(obj: dict, *names: str) -> str:
    info = obj.get("graphicInfo") if isinstance(obj.get("graphicInfo"), dict) else {}
    for name in names:
        value = obj.get(name)
        if value not in (None, ""):
            return str(value)
        value = info.get(name)
        if value not in (None, ""):
            return str(value)
    return ""


_UTD_PRINT_BACKGROUND = re.compile(
    r"^(?:\.\./)*(graphic|thumb)/(\d+)(?:/(?:html|meta))?$", re.IGNORECASE
)


def _utd_print_background_url(value: str) -> str:
    """Map a bundled legacy background to an existing UpToDate endpoint."""

    candidate = str(value or "").strip()
    if re.fullmatch(r"/utd/(?:graphic|thumb)/\d+(?:/(?:html|meta))?", candidate):
        return candidate
    match = _UTD_PRINT_BACKGROUND.fullmatch(candidate)
    if not match:
        return ""
    return f"/utd/{match.group(1).lower()}/{match.group(2)}"


def _rewrite_utd_print_backgrounds(fragment: str) -> str:
    tree = HTMLParser(fragment or "")
    for node in tree.css("[background]"):
        rewritten = _utd_print_background_url(node.attributes.get("background") or "")
        if rewritten:
            node.attrs["background"] = rewritten
        else:
            del node.attrs["background"]
    return tree.html


def _sanitize_utd_print_fragment(fragment: str) -> str:
    """Sanitize source markup and prevent automatic external resource loads."""
    def is_network_reference(value: str) -> bool:
        return bool(re.match(r"^(?:https?:)?//", value.strip(), re.IGNORECASE))

    tree = HTMLParser(
        sanitize_print_fragment(_rewrite_utd_print_backgrounds(fragment or ""))
    )
    for node in tree.css("style,link"):
        node.decompose()
    for node in tree.css("img,source,video,audio,track,image,use"):
        for attribute in ("src", "srcset", "poster", "href", "xlink:href"):
            value = node.attributes.get(attribute)
            if not value:
                continue
            if attribute == "srcset":
                candidates = re.split(
                    r",\s*(?=(?:(?:https?:)?//|/|\.{1,2}/|data:))",
                    str(value),
                    flags=re.IGNORECASE,
                )
                retained = [
                    candidate.strip()
                    for candidate in candidates
                    if candidate.strip()
                    and not is_network_reference(candidate.split(maxsplit=1)[0])
                ]
                if retained:
                    node.attrs[attribute] = ", ".join(retained)
                else:
                    del node.attrs[attribute]
            elif is_network_reference(str(value)):
                del node.attrs[attribute]
    for node in tree.css("[style]"):
        style = str(node.attributes.get("style") or "")
        scrubbed = re.sub(
            r"url\(\s*(['\"]?)(.*?)\1\s*\)",
            lambda match: "none" if is_network_reference(match.group(2)) else match.group(0),
            style,
            flags=re.IGNORECASE,
        )
        if scrubbed.strip():
            node.attrs["style"] = scrubbed
        else:
            del node.attrs["style"]
    if not tree.body:
        return tree.html
    body_markup = tree.body.html
    start = body_markup.find(">") + 1
    end = body_markup.rfind("</")
    return body_markup[start:end] if start > 0 and end >= start else body_markup


def _render_print_graphic(graphic_id: int) -> str:
    """Render one decrypted graphic as inert table HTML or an embedded image."""
    obj = _decode_graphic(graphic_id)
    title = _graphic_value(obj, "title", "displayName") or f"Graphic {graphic_id}"
    label = _graphic_value(obj, "label")
    subtype = _graphic_value(obj, "subtype")
    caption = _graphic_value(obj, "caption")
    legend = _graphic_value(obj, "legendText", "legend")
    image_html = _graphic_value(obj, "imageHtml", "imagehtml")

    safe_table = ""
    if re.search(r"<table\b", image_html, flags=re.IGNORECASE):
        candidate = _sanitize_utd_print_fragment(image_html)
        candidate_tree = HTMLParser(candidate)
        meaningful_cells = any(
            re.search(r"\S", unescape(cell.text()).replace("\xa0", " "))
            for cell in candidate_tree.css("table th,table td")
        )
        if meaningful_cells:
            safe_table = candidate

    if safe_table:
        media = safe_table
    else:
        image_bytes, mime = _image_bytes_and_mime(obj)
        media = f'<img src="{data_uri(image_bytes, mime)}" alt="{escape(title)}">'

    descriptors = " · ".join(escape(value) for value in (label, subtype) if value)
    descriptor_html = f'<p class="print-graphic-label">{descriptors}</p>' if descriptors else ""
    caption_parts = [
        f'<p class="print-graphic-caption">{_sanitize_utd_print_fragment(caption)}</p>'
        for caption in (caption, legend)
        if caption
    ]
    figcaption = f"<figcaption>{''.join(caption_parts)}</figcaption>" if caption_parts else ""
    return (
        f'<figure id="utd-graphic-{graphic_id}">'
        f"<h3>{escape(title)}</h3>{descriptor_html}{media}{figcaption}</figure>"
    )


def _render_topic_print(title: str, data: dict) -> str:
    """Render the complete topic and its locally bundled graphic appendix."""
    original_body_html = data.get("bodyHtml", "") if isinstance(data, dict) else ""
    related = _parse_related_graphics(data.get("relatedGraphics")) if isinstance(data, dict) else []
    graphic_ids = _extract_print_graphic_ids(original_body_html, related)
    body_html = _sanitize_utd_print_fragment(original_body_html)
    appendix: list[str] = []
    for graphic_id in graphic_ids:
        try:
            appendix.append(_render_print_graphic(graphic_id))
        except Exception as error:
            detail = getattr(error, "detail", None) or str(error) or "Could not decode bundled graphic"
            appendix.append(missing_asset(f"Graphic {graphic_id}", str(detail)))

    sections = (
        (PrintSection("Figures and tables", "".join(appendix)),)
        if appendix
        else ()
    )
    source_url = str(data.get("_print_source_url") or "/utd") if isinstance(data, dict) else "/utd"
    return render_print_document(
        PrintDocument(
            title=title,
            source="UpToDate",
            source_url=source_url,
            body_html=body_html,
            sections=sections,
            citation="UpToDate local licensed content",
        )
    )


_GRAPHIC_STOP_TERMS = {
    "left", "right", "figure", "table", "image", "overview", "algorithm",
    "approach", "management", "treatment", "diagnosis", "evaluation",
    "this patient", "the patient", "these patients", "patients", "patient",
}


def _graphic_term_ok(term: str) -> bool:
    key = re.sub(r"\s+", " ", term or "").strip("()[]{}:;,. ").lower()
    if len(key) < 8 or len(key) > 110:
        return False
    if key in _GRAPHIC_STOP_TERMS:
        return False
    if re.fullmatch(r"(?:this|the|these|those)\s+\w+(?:\s+\w+)?", key):
        return False
    words = re.findall(r"[a-z0-9]+", key)
    if len(words) == 1 and len(words[0]) < 9:
        return False
    if re.fullmatch(r"(?:left|right|upper|lower|medial|lateral)(?:\s+\w+)?", key):
        return False
    return bool(words)


def _graphic_aliases(term: str) -> list[str]:
    base = re.sub(r"\s+", " ", term or "").strip()
    candidates = {base}
    for sep in (" on ", " in ", " due to ", " caused by "):
        if sep in base.lower():
            idx = base.lower().find(sep)
            candidates.add(base[:idx])
    lower = base.lower()
    replacements = {
        " infarcts": " infarct",
        " strokes": " stroke",
        " arteries": " artery",
        " reflexes": " reflex",
        " centers": " center",
    }
    for candidate in list(candidates):
        lower_candidate = candidate.lower()
        for old, new in replacements.items():
            if lower_candidate.endswith(old):
                candidates.add(candidate[: -len(old)] + new)
    return [candidate for candidate in candidates if _graphic_term_ok(candidate)]


def _graphic_index_path() -> Path:
    return BASE / "utd_graphic_index.sqlite3"


def _read_graphic_index_db() -> tuple[dict, ...]:
    path = _graphic_index_path()
    if not path.exists():
        return ()
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute("SELECT payload FROM graphic_terms ORDER BY length(term) DESC, term").fetchall()
    except sqlite3.OperationalError:
        return ()
    finally:
        c.close()
    out: list[dict] = []
    for row in rows:
        try:
            out.append(json.loads(row["payload"]))
        except Exception:
            continue
    return tuple(out)


def _write_graphic_index_db(items: tuple[dict, ...]) -> None:
    path = _graphic_index_path()
    c = sqlite3.connect(path)
    try:
        c.execute("DROP TABLE IF EXISTS graphic_terms")
        c.execute(
            "CREATE TABLE graphic_terms ("
            "term TEXT NOT NULL, term_lc TEXT NOT NULL, graphic_id INTEGER NOT NULL, payload TEXT NOT NULL)"
        )
        c.executemany(
            "INSERT INTO graphic_terms(term, term_lc, graphic_id, payload) VALUES(?, ?, ?, ?)",
            [
                (
                    item["term"],
                    item["term"].lower(),
                    int(item["id"]),
                    json.dumps(item, ensure_ascii=False),
                )
                for item in items
            ],
        )
        c.execute("CREATE INDEX idx_graphic_terms_lc ON graphic_terms(term_lc)")
        c.commit()
    finally:
        c.close()


@lru_cache(maxsize=1)
def _graphic_index() -> tuple[dict, ...]:
    cached = _read_graphic_index_db()
    if cached:
        return cached

    out: dict[tuple[str, int], dict] = {}
    dc = _decrypted_conn()
    try:
        cursor = dc.execute("SELECT id, content FROM topic_content ORDER BY id")
        for row in cursor:
            try:
                data = json.loads(row["content"])
            except Exception:
                continue
            topic_id = int(row["id"])
            for graphic in _parse_related_graphics(data.get("relatedGraphics")):
                title = re.sub(r"\s+", " ", graphic.get("title") or "").strip()
                if not title:
                    continue
                gid = int(graphic["id"])
                for alias in _graphic_aliases(title):
                    out.setdefault(
                        (alias.lower(), gid),
                        {
                            "term": alias,
                            "title": title,
                            "id": gid,
                            "topic_id": topic_id,
                            "label": graphic.get("label") or "",
                            "subtype": graphic.get("subtype") or "",
                        },
                    )
    finally:
        dc.close()
    result = tuple(out.values())
    _write_graphic_index_db(result)
    return result


def _is_graphic_boundary(ch: str) -> bool:
    return not (ch.isalnum() or ch in "_+-")


def _topic_term_ok(term: str) -> bool:
    raw = re.sub(r"\s+", " ", term or "").strip("()[]{}:;,. ")
    key = raw.lower()
    if len(key) < 4 or len(key) > 120:
        if not (raw.isupper() and re.fullmatch(r"[A-Z0-9/-]{2,8}", raw)):
            return False
    if key in _GRAPHIC_STOP_TERMS:
        return False
    words = re.findall(r"[a-z0-9]+", key)
    if len(words) == 1 and len(words[0]) < 5 and not raw.isupper():
        return False
    if re.fullmatch(r"(?:left|right|upper|lower|medial|lateral)(?:\s+\w+)?", key):
        return False
    return bool(words)


def _topic_aliases(title: str) -> list[str]:
    base = re.sub(r"\s+", " ", title or "").strip()
    candidates = {base}
    if ": " in base:
        candidates.add(base.split(": ", 1)[0].strip())
        candidates.add(base.split(": ", 1)[1].strip())
    for match in re.finditer(r"\(([^)]{2,24})\)", base):
        alias = match.group(1).strip()
        if alias.isupper() and re.fullmatch(r"[A-Z][A-Z0-9/-]{1,12}", alias):
            candidates.add(alias)
    for alias in re.findall(r"\b[A-Z][A-Z0-9/-]{1,7}\b", base):
        candidates.add(alias)
    cleaned = re.sub(r"\s*\([^)]*\)", "", base).strip()
    if cleaned and cleaned != base:
        candidates.add(cleaned)
    for candidate in list(candidates):
        without_parens = re.sub(r"\s*\([^)]*\)", "", candidate).strip()
        if without_parens:
            candidates.add(without_parens)
    for prefix in (
        "Diagnosis of ",
        "Evaluation and management of ",
        "Initial evaluation and management of ",
        "Management of ",
        "Treatment of ",
        "Pathophysiology of ",
        "Clinical manifestations and diagnosis of ",
    ):
        if cleaned.lower().startswith(prefix.lower()):
            candidates.add(cleaned[len(prefix):].strip())
    for candidate in list(candidates):
        lowered = candidate.lower()
        for suffix in (" in adults", " during pregnancy", " in infants and children", " in children"):
            if lowered.endswith(suffix):
                candidates.add(candidate[: -len(suffix)].strip())
        for divider in (" and ", " or "):
            if divider in lowered:
                first = re.split(divider, candidate, maxsplit=1, flags=re.I)[0].strip()
                if first:
                    candidates.add(first)
    return [candidate for candidate in candidates if _topic_term_ok(candidate)]


@lru_cache(maxsize=1)
def _topic_index() -> tuple[dict, ...]:
    out: dict[tuple[str, int], dict] = {}
    c = _conn("unidex.en.sqlite")
    try:
        rows = c.execute("SELECT topic_id, title FROM topic WHERE title IS NOT NULL ORDER BY topic_id").fetchall()
    finally:
        c.close()
    for row in rows:
        title = re.sub(r"\s+", " ", row["title"] or "").strip()
        if not title:
            continue
        topic_id = int(row["topic_id"])
        for alias in _topic_aliases(title):
            out.setdefault(
                (alias.lower(), topic_id),
                {
                    "term": alias,
                    "title": title,
                    "id": topic_id,
                },
            )
        title_lc = title.lower()
        for abbr, expansion in _ABBREVIATION_EXPANSIONS.items():
            if expansion in title_lc:
                out.setdefault(
                    (abbr, topic_id),
                    {
                        "term": abbr.upper(),
                        "title": title,
                        "id": topic_id,
                    },
                )
    return tuple(out.values())


def _fold_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", value).strip().lower()


def _topic_score(term: str, title: str) -> int:
    q = _fold_text(term)
    t = _fold_text(title)
    score = 0
    if t == q:
        score += 200
    if q and q in t:
        score += 100
    q_words = re.findall(r"[a-z0-9]+", q)
    t_words = re.findall(r"[a-z0-9]+", t)
    if q_words and all(word in t for word in q_words):
        score += 80
    if len(q_words) >= 2:
        coverage = sum(1 for word in q_words if word in t_words or word in t) / len(q_words)
        score += int(coverage * 75)
    acronym = "".join(word[0] for word in q_words if len(word) > 2).upper()
    if len(acronym) >= 3 and re.search(rf"\b{re.escape(acronym.lower())}\b", t):
        score += 90
    if re.search(r"\b(initial evaluation|evaluation and management|management|treatment|initial treatment)\b", t):
        score += 80
    elif re.search(r"\b(diagnosis|evaluation|clinical manifestations|clinical features)\b", t):
        score += 45
    if re.search(r"\b(patient education|patient perspective|gene test)\b", t):
        score -= 170
    if re.search(r"\bcalculator\b", t):
        score -= 95
    if re.search(r"\b(pregnancy|infants and children|congenital)\b", t):
        score -= 40
    if t.startswith(("diagnosis of ", "evaluation and management of ", "management of ")):
        score += 15
    if t.startswith(("treatment of ", "initial evaluation and management of ")):
        score += 25
    return score


def _hide_from_hover_topic(title: str) -> bool:
    return bool(re.search(r"\b(patient education|patient perspective)\b", title or "", re.I))


def _topic_matches_for_term(term: str, limit: int = 4) -> list[dict]:
    key = _fold_text(term)
    if not key:
        return []
    search_key = _ABBREVIATION_EXPANSIONS.get(key, key)
    q_words = re.findall(r"[a-z0-9]+", search_key)
    acronym = "".join(word[0] for word in q_words if len(word) > 2)
    candidates: dict[int, dict] = {}
    for item in _topic_index():
        if _hide_from_hover_topic(item["title"]):
            continue
        item_key = _fold_text(item["term"])
        if (
            item_key == key
            or item_key == search_key
            or (len(search_key) >= 5 and search_key in item_key)
            or (len(item_key) >= 8 and item_key in search_key)
            or (len(acronym) >= 3 and item_key == acronym)
        ):
            score = _topic_score(search_key, item["title"])
            if len(q_words) >= 2 and all(word not in _fold_text(item["title"]) for word in q_words[:2]):
                score -= 90
            current = candidates.get(int(item["id"]))
            if not current or score > current["score"]:
                candidates[int(item["id"])] = {**item, "score": score}
    if len(candidates) < limit:
        c = _conn("unidex.en.sqlite")
        try:
            likes = [f"%{search_key}%"] if len(search_key) >= 5 else []
            if len(acronym) >= 3:
                likes.append(f"%{acronym.upper()}%")
            for like in likes:
                for row in c.execute(
                    "SELECT topic_id, title FROM topic WHERE title LIKE ? ORDER BY length(title) LIMIT 30",
                    (like,),
                ).fetchall():
                    topic_id = int(row["topic_id"])
                    title = row["title"] or ""
                    if _hide_from_hover_topic(title):
                        continue
                    score = _topic_score(search_key, title)
                    current = candidates.get(topic_id)
                    if not current or score > current["score"]:
                        candidates[topic_id] = {"term": term, "title": title, "id": topic_id, "score": score}
        finally:
            c.close()
    ranked = sorted(candidates.values(), key=lambda item: (-int(item.get("score", 0)), len(item["title"])))
    return ranked[:limit]


def _scan_entries(text: str, entries: tuple[dict, ...], source: str, kind: str, limit: int) -> list[dict]:
    lower = text.lower()
    hits: list[dict] = []
    occupied: list[tuple[int, int]] = []
    for item in sorted(entries, key=lambda row: (-len(row["term"]), row["term"].lower())):
        needle = item["term"].lower()
        start = 0
        while True:
            idx = lower.find(needle, start)
            if idx < 0:
                break
            end = idx + len(needle)
            before_ok = idx == 0 or _is_graphic_boundary(lower[idx - 1])
            after_ok = end == len(lower) or _is_graphic_boundary(lower[end])
            overlaps = any(idx < e and end > s for s, e in occupied)
            if before_ok and after_ok and not overlaps:
                hits.append({"start": idx, "end": end, "term": item["term"], "source": source, "kind": kind})
                occupied.append((idx, end))
            start = end
            if len(hits) >= limit:
                break
    return hits


@router.get("/topic/{topic_id}")
def topic_meta(topic_id: int):
    """Full topic metadata including outline HTML, related topics, and related graphics."""
    if not (1 <= topic_id <= 9_999_999):
        raise HTTPException(422, "invalid topic_id")

    data = _topic_data(topic_id)

    toc = _conn("utdtoc.db")
    unc = _conn("unidex.en.sqlite")
    try:
        tr = unc.execute("SELECT title FROM topic WHERE topic_id=?", (topic_id,)).fetchone()
        translated_infos = data.get("topicInfo", {}).get("translatedTopicInfos") or []
        translated = translated_infos[0] if translated_infos else {}
        title = tr["title"] if tr else (
            translated.get("topicName", f"Topic {topic_id}")
            if data.get("topicInfo") else f"Topic {topic_id}"
        )
        mr = toc.execute(
            "SELECT tocId FROM TOCMap WHERE topicId=? LIMIT 1", (topic_id,)
        ).fetchone()
        toc_path = _breadcrumb(toc, mr["tocId"]) if mr else []
    finally:
        unc.close()
        toc.close()

    return {
        "topic_id": topic_id,
        "title": title,
        "toc_path": toc_path,
        "content_url": f"/utd/topic/{topic_id}/html",
        "outline_html": data.get("outlineHtml", ""),
        "related_topics": _parse_related_topics(data.get("relatedTopics")),
        "related_graphics": _parse_related_graphics(data.get("relatedGraphics")),
        "umls": umls_reader.concept_context(title),
    }


@router.get("/topic/{topic_id}/html", response_class=HTMLResponse)
def topic_html(topic_id: int, theme: str = Query("light")):
    """Fully-rendered iframe-ready HTML from cache or the encrypted bundle."""
    if not (1 <= topic_id <= 9_999_999):
        raise HTTPException(422, "invalid topic_id")

    data = _topic_data(topic_id)
    body_html = data.get("bodyHtml", "")

    unc = _conn("unidex.en.sqlite")
    try:
        tr = unc.execute("SELECT title FROM topic WHERE topic_id=?", (topic_id,)).fetchone()
    finally:
        unc.close()
    title = tr["title"] if tr else f"Topic {topic_id}"
    article_theme = "dark" if str(theme).lower() == "dark" else "light"

    return HTMLResponse(
        _render_topic(
            title,
            body_html,
            article_theme,
            f"/utd/topic/{topic_id}/html",
            f"/utd/topic/{topic_id}/print",
            str(topic_id),
        ),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/topic/{topic_id}/print", response_class=HTMLResponse)
def topic_print(topic_id: int):
    """Complete, inert UpToDate topic for the browser's native print flow."""
    if not (1 <= topic_id <= 9_999_999):
        raise HTTPException(422, "invalid topic_id")

    data = _topic_data(topic_id)
    unc = _conn("unidex.en.sqlite")
    try:
        title_row = unc.execute(
            "SELECT title FROM topic WHERE topic_id=?", (topic_id,)
        ).fetchone()
    finally:
        unc.close()
    title = title_row["title"] if title_row else f"Topic {topic_id}"
    print_data = dict(data)
    print_data["_print_source_url"] = f"/utd/topic/{topic_id}/html"
    return HTMLResponse(
        _render_topic_print(title, print_data),
        headers={"Cache-Control": "no-store"},
    )


# ─── Graphic ───────────────────────────────────────────────────────────────

@router.post("/graphic-scan")
def graphic_scan(req: ScanRequest):
    hits = _scan_entries(req.text, _graphic_index(), "utd", "graphic", req.limit)
    hits.sort(key=lambda h: (h["start"], -(h["end"] - h["start"])))
    return {"matches": hits[: req.limit]}


@router.post("/topic-scan")
def topic_scan(req: ScanRequest):
    hits = _scan_entries(req.text, _topic_index(), "utd", "topic", req.limit)
    hits.sort(key=lambda h: (h["start"], -(h["end"] - h["start"])))
    return {"matches": hits[: req.limit]}


@router.post("/scan")
def concept_scan(req: ScanRequest):
    raw = [
        *_scan_entries(req.text, _topic_index(), "utd", "topic", req.limit),
        *_scan_entries(req.text, _graphic_index(), "utd", "graphic", req.limit),
    ]
    raw.sort(key=lambda h: (h["start"], h["kind"] != "topic", -(h["end"] - h["start"])))
    occupied: list[tuple[int, int]] = []
    hits: list[dict] = []
    for hit in raw:
        if any(hit["start"] < e and hit["end"] > s for s, e in occupied):
            continue
        occupied.append((hit["start"], hit["end"]))
        hits.append(hit)
        if len(hits) >= req.limit:
            break
    hits.sort(key=lambda h: (h["start"], -(h["end"] - h["start"])))
    return {"matches": hits}


@router.get("/topic-tooltip")
def topic_tooltip(term: str = Query(..., min_length=1, max_length=140)):
    topics = _topic_matches_for_term(term, 5)
    if not topics:
        return {"term": term, "source": "utd", "matches": []}
    primary = topics[0]
    return {
        "term": term,
        "title": primary["title"],
        "source": "utd",
        "kind": "topic",
        "matches": [
            {
                "id": int(item["id"]),
                "title": item["title"],
                "href": f"/uptodate?t={int(item['id'])}",
                "source": "utd",
                "kind": "topic",
            }
            for item in topics
        ],
        "abstract": "UpToDate topic",
        "media": [],
    }


@router.get("/tooltip")
def concept_tooltip(term: str = Query(..., min_length=1, max_length=140)):
    topic_payload = topic_tooltip(term)
    graphic_payload = graphic_tooltip(term)
    matches = []
    seen: set[str] = set()
    seen_topic_ids: set[int] = set()
    for payload in (topic_payload, graphic_payload):
        for match in payload.get("matches", []):
            if match.get("source") == "utd" and match.get("kind") == "topic":
                topic_id = int(match.get("id") or 0)
                if topic_id in seen_topic_ids:
                    continue
                seen_topic_ids.add(topic_id)
            key = f"{match.get('source')}:{match.get('kind')}:{match.get('href')}"
            if key in seen:
                continue
            seen.add(key)
            matches.append(match)
    if topic_payload.get("matches"):
        return {
            **topic_payload,
            "matches": matches,
            "media": graphic_payload.get("media", []),
            "html": graphic_payload.get("html", ""),
        }
    if graphic_payload.get("matches"):
        return {**graphic_payload, "matches": matches}
    return {"term": term, "source": "utd", "matches": []}


def graphics_for_terms(terms, limit: int = 16) -> list[dict]:
    """UpToDate graphics whose indexed term/title CONTAINS one of `terms` (a
    concept's preferred name + close synonyms) — e.g. "asthma" matches "Stepwise
    approach to asthma management". Powers the UMLS media wall; deduped by graphic id."""
    cand = [re.sub(r"\s+", " ", (t or "")).strip().lower() for t in (terms or [])]
    cand = [t for t in cand if len(t) >= 4][:5]  # specific-enough, bounded
    if not cand:
        return []
    out: list[dict] = []
    seen: set[int] = set()
    for e in _graphic_index():
        gt = (e.get("term") or "").lower()
        if any(t in gt for t in cand):
            gid = int(e["id"])
            if gid in seen:
                continue
            seen.add(gid)
            topic_id = e.get("topic_id")
            out.append({
                "id": gid,
                "title": e.get("title") or "",
                "url": f"/utd/graphic/{gid}",
                "thumb_url": f"/utd/thumb/{gid}",
                "source_href": f"/uptodate?t={int(topic_id)}&g={gid}" if topic_id else "",
            })
            if len(out) >= limit:
                break
    return out


@router.get("/graphic-tooltip")
def graphic_tooltip(term: str = Query(..., min_length=1, max_length=140)):
    key = re.sub(r"\s+", " ", term or "").strip().lower()
    item = next((entry for entry in _graphic_index() if entry["term"].lower() == key), None)
    if not item:
        return {"term": term, "source": "utd", "matches": []}
    gid = int(item["id"])
    topic_id = item.get("topic_id")
    matches = []
    if topic_id:
        matches.append({
            "id": int(topic_id),
            "title": f"Open UpToDate topic",
            "href": f"/uptodate?t={int(topic_id)}&g={gid}",
            "source": "utd",
            "kind": "topic",
        })
    matches.append({"id": gid, "title": "Open UpToDate graphic", "href": f"/utd/graphic/{gid}", "source": "utd", "kind": "graphic"})

    media = [{"title": item["title"], "url": f"/utd/graphic/{gid}"}]
    html_fragment = ""
    try:
        obj = _decode_graphic(gid)
        image_html = obj.get("imageHtml") or obj.get("imagehtml") or ""
        if image_html:
            html_fragment = re.sub(r"(?is)<script\b[^>]*>.*?</script>", "", image_html)
            html_fragment = re.sub(r"\s+on[a-z]+\s*=\s*(['\"]).*?\1", "", html_fragment)
            if re.search(r"(?i)<img\b", html_fragment):
                html_fragment = re.sub(r"(?is)<img\b[^>]*>", "", html_fragment)
            else:
                media = []
    except HTTPException:
        media = [{"title": item["title"], "url": f"/utd/thumb/{gid}"}]
    return {
        "term": term,
        "title": item["title"],
        "source": "utd",
        "kind": "graphic",
        "matches": matches,
        "abstract": "UpToDate graphic",
        "media": media,
        "html": html_fragment,
    }


def _decode_graphic(graphic_id: int) -> dict:
    key = _need_key()
    ac = _conn("utdasset.sqlite")
    try:
        r = ac.execute(
            "SELECT payload FROM graphic_asset WHERE id=?", (graphic_id,)
        ).fetchone()
    finally:
        ac.close()
    if not r:
        raise HTTPException(404, f"graphic {graphic_id} not in bundle")
    try:
        data = json.loads(key.decrypt_payload(graphic_id, r["payload"]))
        if not isinstance(data, dict):
            raise ValueError("graphic must be an object")
        return data
    except Exception:
        raise HTTPException(503, "UpToDate graphic could not be decrypted or validated. Check the content key or repair the installed pack.") from None


def _image_bytes_and_mime(obj: dict) -> tuple[bytes, str]:
    b64 = (obj.get("base64Image") or obj.get("base64image") or obj.get("image") or "")
    if not b64:
        raise HTTPException(404, "graphic has no image field")
    try:
        img = base64.b64decode(b64)
    except Exception as e:
        raise HTTPException(500, f"base64 decode: {e}")
    if img[:2] == b"\xff\xd8":
        mime = "image/jpeg"
    elif img[:8].startswith(b"\x89PNG"):
        mime = "image/png"
    elif img[:4] == b"GIF8":
        mime = "image/gif"
    else:
        mime = "application/octet-stream"
    return img, mime


@router.get("/graphic/{graphic_id}")
def graphic_image(graphic_id: int):
    """Full-resolution graphic image (requires UTD_PASSWORD)."""
    obj = _decode_graphic(graphic_id)
    img, mime = _image_bytes_and_mime(obj)
    return Response(content=img, media_type=mime,
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/graphic/{graphic_id}/meta")
def graphic_meta(graphic_id: int):
    """Graphic metadata (title, caption, etc.) — requires UTD_PASSWORD."""
    obj = _decode_graphic(graphic_id)
    return {k: v for k, v in obj.items()
            if k not in ("base64Image", "base64image", "image")}


@router.get("/graphic/{graphic_id}/html", response_class=HTMLResponse)
def graphic_html(graphic_id: int):
    """Standalone, inert view for a bundled HTML-only graphic."""
    obj = _decode_graphic(graphic_id)
    raw_html = _graphic_value(obj, "imageHtml", "imagehtml")
    if not raw_html:
        raise HTTPException(404, "graphic has no HTML content")
    title = _graphic_value(obj, "title", "displayName") or f"Graphic {graphic_id}"
    caption = _graphic_value(obj, "caption", "legendText", "legend")
    safe_html = _sanitize_utd_print_fragment(raw_html)
    safe_caption = _sanitize_utd_print_fragment(caption) if caption else ""
    source_url = f"/utd/graphic/{graphic_id}/html"
    interop = media_interop_head("UpToDate", title, source_url)
    caption_html = f"<figcaption>{safe_caption}</figcaption>" if safe_caption else ""
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{escape(title)}</title>{interop}
<style>
html{{color-scheme:light}}body{{margin:0;padding:24px;background:#eef3f8;color:#0f172a;font:14px/1.5 system-ui,sans-serif}}
figure{{max-width:1200px;margin:0 auto;padding:20px;overflow:auto;border:1px solid #cbd5e1;border-radius:10px;background:#fff}}
h1{{margin:0 0 16px;font-size:20px}}table{{width:100%;border-collapse:collapse}}th,td{{padding:8px 10px;border:1px solid #cbd5e1;text-align:left;vertical-align:top}}th{{background:#f8fafc}}figcaption{{margin-top:14px;color:#475569}}
</style></head><body><figure><h1>{escape(title)}</h1>{safe_html}{caption_html}</figure></body></html>"""
    return HTMLResponse(document, headers={"Cache-Control": "no-store"})


@router.get("/thumb/{graphic_id}")
def thumb(graphic_id: int):
    """Return a thumbnail, falling back to the bundled full graphic."""
    c = _conn("thumbs.db")
    try:
        r = c.execute("SELECT image FROM thumbs WHERE id=?", (graphic_id,)).fetchone()
    finally:
        c.close()
    if not r:
        return graphic_image(graphic_id)
    try:
        img = base64.b64decode(r["image"])
    except Exception as e:
        raise HTTPException(500, f"base64 decode: {e}")
    mime = ("image/jpeg" if img[:2] == b"\xff\xd8"
            else "image/png" if img[:8].startswith(b"\x89PNG")
            else "application/octet-stream")
    return Response(content=img, media_type=mime,
                    headers={"Cache-Control": "public, max-age=86400"})


# ─── Search / autocomplete ─────────────────────────────────────────────────

@router.get("/search")
def search(q: str = Query(..., min_length=2, max_length=200),
           limit: int = Query(30, ge=1, le=100)):
    safe = q.strip()
    c = _conn("unidex.en.sqlite")
    try:
        rows = c.execute(
            "SELECT topic_id, title FROM topic "
            "WHERE title LIKE ? ORDER BY title LIMIT ?",
            (f"%{safe}%", limit),
        ).fetchall()
    finally:
        c.close()
    return [{"topic_id": r["topic_id"], "title": r["title"]} for r in rows]


@router.get("/autocomplete")
def autocomplete(q: str = Query(..., min_length=1, max_length=80),
                 limit: int = Query(15, ge=1, le=30)):
    safe = q.strip().lower()
    c = _conn("utdqf.sqlite")
    try:
        rows = c.execute(
            "SELECT u, t, p, xp, f FROM qf "
            "WHERE u LIKE ? ORDER BY f DESC LIMIT ?",
            (f"{safe}%", limit),
        ).fetchall()
    finally:
        c.close()
    return [
        {"label": r["u"] or "", "type": r["p"] or "",
         "target": r["xp"] or "", "title": r["t"] or "", "score": r["f"]}
        for r in rows
    ]


# ─── Health ────────────────────────────────────────────────────────────────

@router.get("/health")
def utd_health():
    bundle_ok = False
    decrypted_ok = False
    msg = ""
    try:
        bd = _bundle_dir()
        bundle_ok = bd.exists()
        decrypted_ok = (bd / "utdasset_decrypted.sqlite").exists()
    except HTTPException as e:
        msg = e.detail
    return {
        "bundle_ok":        bundle_ok,
        "decrypted_db_ok":  decrypted_ok,
        "bundle_path":      str(UTD_DB_PATH),
        "key_configured":   _key() is not None,
        "static_dir_ok":    STATIC_DIR.exists() and (STATIC_DIR / "UTDHeader.css").exists(),
        "message":          msg or "ok",
    }

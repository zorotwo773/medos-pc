"""Offline PDF generation for MedOS exports.

Pure PyMuPDF (``fitz``) — no FastAPI coupling, no network access and no new
dependencies.  Every public renderer returns PDF *bytes* and is deliberately
defensive:

* oversized or malformed input is clamped (see the ``MAX_*`` caps below),
* user supplied HTML is sanitised to a small, inert tag whitelist,
* text is rendered through PyMuPDF's HTML layout engine, which also provides
  glyph fallback for non-Latin scripts (the PDF stays valid for any unicode),
* if layout ever fails the renderer degrades to a plain-text PDF so callers can
  always stream a valid document.

Public API
----------
``render_page_pdf(title, subtitle=None, html=None, text=None, meta=None)``
``render_topic_pdf(...)``      — alias of :func:`render_page_pdf`
``render_text_pdf(title, text=None, subtitle=None, meta=None)``
``render_rows_pdf(title, columns, rows, meta=None)``
``render_qbank_pdf(title, questions, meta=None)``
``capability_info()``

All renderers accept an optional keyword-only ``paper`` argument
(``"a4"`` — default — or ``"letter"``).
"""

from __future__ import annotations

import base64
import html as _html
import io
import re
import unicodedata
from datetime import datetime
from html.parser import HTMLParser
from typing import Any, Iterable, Sequence

import fitz

__all__ = [
    "render_page_pdf",
    "render_topic_pdf",
    "render_text_pdf",
    "render_rows_pdf",
    "render_qbank_pdf",
    "capability_info",
    "MAX_QUESTIONS",
    "MAX_ROWS",
    "MAX_TOTAL_TEXT",
]

# ─── Caps (always produce a valid PDF, never raise) ─────────────────────────
MAX_QUESTIONS = 800  # interleaved export uses >= 2 pages per question
MAX_ROWS = 20_000
MAX_COLUMNS = 40
MAX_CELL_CHARS = 2_000
MAX_TITLE_CHARS = 300
MAX_SUBTITLE_CHARS = 500
MAX_META_ITEMS = 12
MAX_HTML_CHARS = 2_000_000          # per-page HTML payload
MAX_TEXT_CHARS = 5_000_000          # per-page plain-text payload
MAX_TOTAL_TEXT = 20 * 1024 * 1024   # aggregate text across a Q-Bank session
MAX_QUESTION_STEM_CHARS = 20_000
MAX_QUESTION_EXPLANATION_CHARS = 40_000
MAX_QUESTION_CHOICE_CHARS = 4_000
MAX_QUESTION_CHOICES = 26           # A..Z; Q-Bank uses A..H
MAX_QUESTION_TAGS = 50
MAX_QUESTION_TAG_CHARS = 80
MAX_QUESTION_MEDIA = 8
MAX_IMAGE_DATA_CHARS = 6_000_000           # base64 payload per embedded image
# Enrichment inlines each local figure as a base64 data URL, so a single rich
# HTML field can legitimately be far larger than the pre-enrichment source.
# Never clip it with a plain character slice: that cuts inside a `src` value
# and PyMuPDF Story then prints the whole data URL as page text.
MAX_RICH_HTML_CHARS = 32_000_000
MAX_PAGES = 2_000

_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_PAPERS = {"a4", "letter"}

# Page geometry (points).  A4 = 595x842, Letter = 612x792.
_MARGIN = 56.0
_HEADER_RULE_Y = 50.0
_BODY_TOP = 66.0
_BODY_BOTTOM = 62.0
_FOOTER_Y = 30.0
_HEADER_FONT_SIZE = 7.5
_FOOTER_FONT_SIZE = 7.0
_RULE_COLOR = (0.72, 0.72, 0.72)
_TEXT_MUTED = (0.30, 0.30, 0.30)

_STORY_CSS = """
body { font-family: sans-serif; font-size: 10pt; line-height: 1.38; color: #111111; }
h1 { font-size: 17pt; color: #0f172a; margin: 0 0 6pt 0; }
h2 { font-size: 12pt; color: #0f172a; margin: 14pt 0 4pt 0; }
h3 { font-size: 10.5pt; color: #1f2937; margin: 10pt 0 3pt 0; }
h4, h5, h6 { font-size: 10pt; color: #1f2937; margin: 8pt 0 2pt 0; }
p { margin: 0 0 5pt 0; }
p.subtitle { font-size: 11pt; color: #334155; margin: 0 0 4pt 0; }
p.meta { font-size: 8pt; color: #475569; margin: 0 0 10pt 0; }
.choice { margin: 0 0 3pt 0; margin-left: 14pt; }
p.answer-line { margin: 0 0 3pt 0; }
ul, ol { margin: 0 0 7pt 0; padding-left: 18pt; }
li { margin: 0 0 2pt 0; }
blockquote { margin: 6pt 14pt; color: #334155; }
table { width: 100%; font-size: 9pt; margin: 6pt 0 8pt 0; border-collapse: collapse; }
th { text-align: left; background-color: #e2e8f0; font-weight: bold; padding: 3pt 5pt;
     border: 0.6pt solid #94a3b8; }
td { padding: 3pt 5pt; vertical-align: top; border: 0.6pt solid #94a3b8; }
img { max-width: 100%; }
figure { margin: 6pt 0 8pt 0; }
figcaption { font-size: 8pt; color: #475569; margin-top: 2pt; }
pre, code { font-family: monospace; font-size: 9pt; }
hr { margin: 8pt 0; }
"""

# ─── Small helpers ──────────────────────────────────────────────────────────

def _as_text(value: Any, limit: int = MAX_TEXT_CHARS) -> str:
    """Coerce *value* to a bounded, control-character-free string."""
    if value is None:
        return ""
    if not isinstance(value, str):
        try:
            value = str(value)
        except Exception:
            return ""
    # Strip lone control characters (keep \n, \t) — they upset some layout paths.
    value = "".join(
        ch for ch in value
        if ch in ("\n", "\t") or unicodedata.category(ch)[0] != "C"
    )
    if len(value) > limit:
        value = value[:limit]
    return value


def _clip_html_safe(value: Any, limit: int) -> str:
    """Bound HTML without leaving a half-written tag or data URL behind.

    Plain character slicing can cut inside an attribute value — most commonly
    the long base64 ``src`` of an embedded figure. HTMLParser then reports the
    unterminated tag as *text*, and PyMuPDF Story prints megabytes of base64
    letters onto the page. Drop any trailing incomplete tag instead.
    """
    text = _as_text(value, limit)
    if not text:
        return ""
    last_open = text.rfind("<")
    last_close = text.rfind(">")
    if last_open > last_close:
        return text[:last_open]
    return text


def _escape(value: Any) -> str:
    return _html.escape(_as_text(value), quote=False)


def _clip(value: Any, limit: int) -> str:
    text = _as_text(value, limit + 1)
    return text[:limit]


def _clean_title(value: Any, default: str) -> str:
    title = " ".join(_as_text(value, MAX_TITLE_CHARS + 1).split())
    return title[:MAX_TITLE_CHARS] or default


def _normalise_paper(paper: Any) -> str:
    key = str(paper or "").strip().lower()
    return key if key in _PAPERS else "a4"


def _paper_rect(paper: str) -> fitz.Rect:
    return fitz.paper_rect("letter" if paper == "letter" else "a4")


def _ascii_clip(value: Any, limit: int) -> str:
    """ASCII-safe text for base-14 header/footer fonts (never raises)."""
    text = _as_text(value, limit * 4 if limit else 400)
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "replace").decode("ascii")
    text = " ".join(text.split())
    return text[:limit]


def _generated_stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def _letters(index: int) -> str:
    if 0 <= index < len(_LETTERS):
        return _LETTERS[index]
    return str(index + 1)


def _inline_html(value: Any, limit: int) -> str:
    """Escape plain text and keep its line structure as ``<br>`` breaks."""
    text = _as_text(value, limit)
    lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    kept = [line for line in lines if line]
    if not kept:
        return "&mdash;"
    return "<br>".join(_html.escape(line, quote=False) for line in kept)


def _paragraphs_html(value: Any, limit: int) -> str:
    """Render plain text as one or more escaped ``<p>`` blocks."""
    text = _as_text(value, limit)
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n"))
    parts: list[str] = []
    for block in blocks:
        line_html = _inline_html(block, limit)
        if line_html and line_html != "&mdash;":
            parts.append(f"<p>{line_html}</p>")
    return "\n".join(parts)


# ─── Inert HTML sanitiser (whitelist tags/attributes) ───────────────────────

class _HtmlSanitizer(HTMLParser):
    """Convert arbitrary captured page HTML into an inert, Story-safe fragment.

    Only a small whitelist of structural/typographic tags survives.  Text inside
    script/style/iframe-like elements is dropped entirely; every other unknown
    tag is unwrapped (its text is kept).  Attributes are dropped except safe
    table spans, ``class`` (used by our own CSS) and ``title``.
    """

    _ALLOWED = {
        "a", "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small",
        "sub", "sup", "p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4",
        "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre",
        "code", "kbd", "samp", "table", "thead", "tbody", "tfoot", "tr", "th",
        "td", "caption", "figure", "figcaption", "cite", "img",
    }
    _VOID = {"br", "hr", "img"}
    _DROP_WITH_CONTENT = {
        "script", "style", "noscript", "iframe", "frame", "frameset", "object",
        "embed", "svg", "math", "template", "head", "title", "meta", "link",
        "base", "canvas", "video", "audio", "form", "button", "input",
        "select", "textarea", "option", "nav",
    }
    _ALLOWED_ATTRS = {"class", "colspan", "rowspan", "title", "href", "alt", "src", "width"}
    _DATA_IMAGE_RE = re.compile(
        r"^data:image/(?:png|jpeg|jpg|gif|webp|bmp);base64,[A-Za-z0-9+/=\s]+$",
        re.IGNORECASE,
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self._DROP_WITH_CONTENT:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "img":
            values = dict(attrs)
            attrs_html = self._safe_attrs(tag, attrs)
            if " src=" in attrs_html:
                # Base64 data URI images are rendered inline by PyMuPDF Story.
                self.parts.append(f"<img{attrs_html}/>")
            else:
                # Remote/unsupported sources cannot be fetched offline: keep a
                # readable caption instead of silently dropping the figure.
                alt = _clip(values.get("alt") or "", 200) or "embedded figure"
                self.parts.append(
                    f"<p><i>[Image: {_html.escape(alt, quote=False)} — source not embedded]</i></p>"
                )
            return
        if tag not in self._ALLOWED:
            return  # unwrap: drop tag, keep its text content
        self.parts.append(f"<{tag}{self._safe_attrs(tag, attrs)}>")

    def handle_startendtag(self, tag: str, attrs) -> None:  # type: ignore[override]
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self._DROP_WITH_CONTENT:
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag in self._ALLOWED and tag not in self._VOID:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._skip_depth or not data:
            return
        self.parts.append(_html.escape(data, quote=False))

    @classmethod
    def _safe_attrs(cls, tag: str, attrs) -> str:
        out: list[str] = []
        for name, value in attrs:
            name = (name or "").lower()
            if name not in cls._ALLOWED_ATTRS or value is None:
                continue
            if name == "src":
                # Only embedded base64 images work in an offline export.  Never
                # allow remote URLs (no network access, no tracking pixels).
                if tag != "img":
                    continue
                src = "".join(_as_text(value, MAX_IMAGE_DATA_CHARS + 64).split())
                if not _valid_data_url(src):
                    continue
                out.append(f' src="{src}"')
                continue
            value = _clip(value, 300)
            if name == "class":
                value = " ".join(re.findall(r"[A-Za-z0-9_\- ]+", value))[:120]
                if not value.strip():
                    continue
            elif name == "href":
                # Offline exports: keep only in-document anchors.
                if not value.strip().startswith("#"):
                    continue
            elif name in ("colspan", "rowspan", "width"):
                if not value.strip().isdigit() or int(value.strip()) > 2000:
                    continue
            out.append(f' {name}="{_html.escape(value, quote=True)}"')
        return "".join(out)


def _valid_data_url(src: str) -> bool:
    """Only accept a complete, decodable base64 image payload."""
    if (
        not isinstance(src, str)
        or not src
        or len(src) > MAX_IMAGE_DATA_CHARS
        or not _HtmlSanitizer._DATA_IMAGE_RE.match(src)
    ):
        return False
    try:
        payload = src.split(",", 1)[1]
        if len(payload) % 4:
            return False
        return bool(base64.b64decode(payload, validate=True))
    except Exception:
        return False


def _sanitize_html(fragment: Any) -> str:
    if not isinstance(fragment, str) or not fragment.strip():
        return ""
    parser = _HtmlSanitizer()
    try:
        parser.feed(_clip_html_safe(fragment, MAX_HTML_CHARS))
        parser.close()
    except Exception:
        return ""
    cleaned = "".join(parser.parts).strip()
    # Collapse the worst of the whitespace noise left by DOM serialisation.
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


# ─── HTML composition ───────────────────────────────────────────────────────

def _meta_html(meta: Any) -> str:
    if not isinstance(meta, dict) or not meta:
        return ""
    items: list[str] = []
    for key, value in list(meta.items())[:MAX_META_ITEMS]:
        if value is None or value == "":
            continue
        label = " ".join(_as_text(key, 60).split())
        if isinstance(value, (list, tuple, set)):
            value = ", ".join(_as_text(item, 120) for item in list(value)[:12])
        elif isinstance(value, dict):
            continue
        text = " ".join(_as_text(value, 300).split())
        if not label or not text:
            continue
        items.append(f"{_html.escape(label, quote=False)}: {_html.escape(text, quote=False)}")
    if not items:
        return ""
    return f'<p class="meta">{_html.escape(" · ".join(items), quote=False)}</p>'


def _compose_document_html(
    title: str,
    subtitle: str | None,
    body_html: str,
    meta: Any,
) -> str:
    parts: list[str] = [f"<h1>{_html.escape(title, quote=False)}</h1>"]
    if subtitle:
        parts.append(f'<p class="subtitle">{_html.escape(_clip(subtitle, MAX_SUBTITLE_CHARS), quote=False)}</p>')
    meta_block = _meta_html(meta)
    if meta_block:
        parts.append(meta_block)
    if body_html:
        parts.append(body_html)
    return "\n".join(parts)


# ─── Story layout + page stamping ───────────────────────────────────────────

def _render_story_document(document_html: str, paper: str) -> fitz.Document:
    """Lay out one HTML document with PyMuPDF's Story engine."""
    page_rect = _paper_rect(paper)
    body_rect = fitz.Rect(page_rect) + (_MARGIN, _BODY_TOP, -_MARGIN, -_BODY_BOTTOM)
    buffer = io.BytesIO()
    writer = fitz.DocumentWriter(buffer)
    story = fitz.Story(html=document_html, user_css=_STORY_CSS)
    more = 1
    pages = 0
    while more and pages < MAX_PAGES:
        device = writer.begin_page(page_rect)
        more, _ = story.place(body_rect)
        story.draw(device)
        writer.end_page()
        pages += 1
    writer.close()
    return fitz.open(stream=buffer.getvalue(), filetype="pdf")


def _stamp_document(doc: fitz.Document, title: str, section_labels: Sequence[str]) -> None:
    """Draw the header rule, header labels and page-number footer on every page."""
    total = doc.page_count
    if total <= 0:
        return
    stamp = _generated_stamp()
    header_left = _ascii_clip(title, 70)
    footer_left = _ascii_clip(f"MedOS export · {stamp}", 80)
    for index, page in enumerate(doc):
        width = page.rect.width
        height = page.rect.height
        label = _ascii_clip(section_labels[index] if index < len(section_labels) else "", 40)

        page.draw_line(
            fitz.Point(_MARGIN, _HEADER_RULE_Y),
            fitz.Point(width - _MARGIN, _HEADER_RULE_Y),
            color=_RULE_COLOR,
            width=0.6,
        )
        baseline = _HEADER_RULE_Y - 7
        if header_left:
            page.insert_text(
                fitz.Point(_MARGIN, baseline), header_left,
                fontsize=_HEADER_FONT_SIZE, fontname="helv", color=_TEXT_MUTED,
            )
        if label:
            width_label = fitz.get_text_length(label, fontname="helv", fontsize=_HEADER_FONT_SIZE)
            page.insert_text(
                fitz.Point(width - _MARGIN - width_label, baseline), label,
                fontsize=_HEADER_FONT_SIZE, fontname="helv", color=_TEXT_MUTED,
            )

        footer_y = height - _FOOTER_Y
        page.draw_line(
            fitz.Point(_MARGIN, footer_y - 8),
            fitz.Point(width - _MARGIN, footer_y - 8),
            color=_RULE_COLOR,
            width=0.6,
        )
        if footer_left:
            page.insert_text(
                fitz.Point(_MARGIN, footer_y), footer_left,
                fontsize=_FOOTER_FONT_SIZE, fontname="helv", color=_TEXT_MUTED,
            )
        page_label = f"Page {index + 1} of {total}"
        width_label = fitz.get_text_length(page_label, fontname="helv", fontsize=_FOOTER_FONT_SIZE)
        page.insert_text(
            fitz.Point(width - _MARGIN - width_label, footer_y), page_label,
            fontsize=_FOOTER_FONT_SIZE, fontname="helv", color=_TEXT_MUTED,
        )


def _merge_and_stamp(
    sections: Sequence[tuple[fitz.Document, str]],
    title: str,
) -> bytes:
    merged = fitz.open()
    labels: list[str] = []
    try:
        for part, label in sections:
            first = merged.page_count
            merged.insert_pdf(part)
            added = merged.page_count - first
            labels.extend([label] * added)
        _stamp_document(merged, title, labels)
        return bytes(merged.tobytes(garbage=3, deflate=True))
    finally:
        merged.close()
        for part, _label in sections:
            try:
                part.close()
            except Exception:
                pass


def _serialise_single(document: fitz.Document, title: str, label: str) -> bytes:
    return _merge_and_stamp([(document, label)], title)


# ─── Plain-text fallback (guaranteed valid PDF) ─────────────────────────────

def _fallback_pdf(title: str, body_text: str, paper: str = "a4") -> bytes:
    """Last-resort renderer: always returns a valid PDF."""
    page_rect = _paper_rect(paper)
    doc = fitz.open()
    try:
        page = doc.new_page(width=page_rect.width, height=page_rect.height)
        text_rect = fitz.Rect(page_rect) + (_MARGIN, _BODY_TOP, -_MARGIN, -_BODY_BOTTOM)
        lines: list[str] = [_ascii_clip(title, 120), ""]
        for raw in _as_text(body_text, MAX_TOTAL_TEXT).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            line = raw.strip()
            lines.append(line)
        buffer = "\n".join(lines)
        # insert_textbox returns a negative spare height when the text does not fit.
        while buffer:
            spare = page.insert_textbox(
                text_rect, buffer,
                fontsize=9.5, fontname="helv", color=(0.1, 0.1, 0.1),
                lineheight=1.3, align=fitz.TEXT_ALIGN_LEFT,
            )
            if spare >= 0:
                break
            # Roughly split the buffer: keep what fits by trimming from the end.
            cut = max(1, int(len(buffer) * 0.8))
            head, buffer = buffer[:cut], buffer[cut:]
            page.insert_textbox(
                text_rect, head,
                fontsize=9.5, fontname="helv", color=(0.1, 0.1, 0.1),
                lineheight=1.3, align=fitz.TEXT_ALIGN_LEFT,
            )
            page = doc.new_page(width=page_rect.width, height=page_rect.height)
            text_rect = fitz.Rect(page_rect) + (_MARGIN, _BODY_TOP, -_MARGIN, -_BODY_BOTTOM)
        total = doc.page_count
        for index, stamp_page in enumerate(doc):
            footer = f"MedOS export · {_generated_stamp()}"
            stamp_page.insert_text(
                fitz.Point(_MARGIN, stamp_page.rect.height - _FOOTER_Y), footer,
                fontsize=_FOOTER_FONT_SIZE, fontname="helv", color=_TEXT_MUTED,
            )
            page_label = f"Page {index + 1} of {total}"
            width_label = fitz.get_text_length(page_label, fontname="helv", fontsize=_FOOTER_FONT_SIZE)
            stamp_page.insert_text(
                fitz.Point(stamp_page.rect.width - _MARGIN - width_label, stamp_page.rect.height - _FOOTER_Y),
                page_label, fontsize=_FOOTER_FONT_SIZE, fontname="helv", color=_TEXT_MUTED,
            )
        return bytes(doc.tobytes(garbage=3, deflate=True))
    finally:
        doc.close()


def _safe_result(
    factory,
    title: str,
    fallback_text: str,
    paper: str,
) -> bytes:
    """Run *factory*; on any failure return a valid plain-text PDF instead."""
    try:
        data = factory()
        if isinstance(data, (bytes, bytearray)) and bytes(data[:5]) == b"%PDF-":
            return bytes(data)
    except Exception:
        pass
    try:
        return _fallback_pdf(title, fallback_text, paper)
    except Exception:
        # Extremely defensive: a blank single-page PDF is still a valid export.
        try:
            doc = fitz.open()
            doc.new_page(width=595, height=842)
            return bytes(doc.tobytes())
        except Exception:
            return b"%PDF-1.4\n%%EOF\n"


# ─── Page / topic / text renderers ─────────────────────────────────────────

def render_page_pdf(
    title: str,
    subtitle: str | None = None,
    html: str | None = None,
    text: str | None = None,
    meta: dict | None = None,
    *,
    paper: str = "a4",
) -> bytes:
    """Render a captured page/article as a clean, paginated PDF."""
    paper = _normalise_paper(paper)
    clean_title = _clean_title(title, "MedOS export")
    clean_subtitle = _clip(subtitle, MAX_SUBTITLE_CHARS) or None

    def factory() -> bytes:
        body = _sanitize_html(html)
        if not body and isinstance(text, str) and text.strip():
            body = _paragraphs_html(text, MAX_TEXT_CHARS)
        if not body:
            body = "<p>This page has no exportable content.</p>"
        document_html = _compose_document_html(clean_title, clean_subtitle, body, meta)
        doc = _render_story_document(document_html, paper)
        return _serialise_single(doc, clean_title, "MedOS export")

    fallback_body = text if isinstance(text, str) and text.strip() else _strip_tags(html)
    return _safe_result(factory, clean_title, fallback_body, paper)


def render_topic_pdf(
    title: str,
    subtitle: str | None = None,
    html: str | None = None,
    text: str | None = None,
    meta: dict | None = None,
    *,
    paper: str = "a4",
) -> bytes:
    """Alias of :func:`render_page_pdf` (topic/article exports)."""
    return render_page_pdf(
        title, subtitle=subtitle, html=html, text=text, meta=meta, paper=paper,
    )


def render_text_pdf(
    title: str,
    text: str | None = None,
    subtitle: str | None = None,
    meta: dict | None = None,
    *,
    paper: str = "a4",
) -> bytes:
    """Render a plain-text document (used as the universal fallback)."""
    paper = _normalise_paper(paper)
    clean_title = _clean_title(title, "MedOS export")
    raw_text = _as_text(text, MAX_TEXT_CHARS)

    def factory() -> bytes:
        body = _paragraphs_html(raw_text, MAX_TEXT_CHARS) or "<p>No text provided.</p>"
        document_html = _compose_document_html(
            clean_title, _clip(subtitle, MAX_SUBTITLE_CHARS) or None, body, meta,
        )
        doc = _render_story_document(document_html, paper)
        return _serialise_single(doc, clean_title, "MedOS export")

    return _safe_result(factory, clean_title, raw_text, paper)


def render_rows_pdf(
    title: str,
    columns: Sequence[str] | None,
    rows: Iterable[Sequence[Any]] | None,
    meta: dict | None = None,
    *,
    paper: str = "a4",
) -> bytes:
    """Render column headers + rows as a PDF table."""
    paper = _normalise_paper(paper)
    clean_title = _clean_title(title, "MedOS table export")
    header_cells = [_clip(col, MAX_CELL_CHARS) for col in list(columns or [])[:MAX_COLUMNS]]
    body_rows: list[list[str]] = []
    for row in rows or []:
        if not isinstance(row, (list, tuple)):
            continue
        if len(body_rows) >= MAX_ROWS:
            break
        body_rows.append([_clip(cell, MAX_CELL_CHARS) for cell in list(row)[:MAX_COLUMNS]])
    if not header_cells:
        width = max((len(row) for row in body_rows), default=0)
        header_cells = [f"Column {index + 1}" for index in range(width)]

    def factory() -> bytes:
        head = "".join(f"<th>{_html.escape(cell, quote=False)}</th>" for cell in header_cells)
        body = "".join(
            "<tr>" + "".join(f"<td>{_html.escape(cell, quote=False)}</td>" for cell in row) + "</tr>"
            for row in body_rows
        )
        table = f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"
        document_html = _compose_document_html(clean_title, None, table, meta)
        doc = _render_story_document(document_html, paper)
        return _serialise_single(doc, clean_title, "Table")

    fallback_lines = [" | ".join(header_cells)]
    fallback_lines.extend(" | ".join(row) for row in body_rows)
    return _safe_result(factory, clean_title, "\n".join(fallback_lines), paper)


# ─── Q-Bank renderer ────────────────────────────────────────────────────────

def _as_data_images(value: Any) -> list[str]:
    """Keep only safe, bounded base64 image payloads from a media list."""
    if not isinstance(value, (list, tuple)):
        return []
    images: list[str] = []
    for item in list(value)[:MAX_QUESTION_MEDIA]:
        src = "".join(_as_text(item, MAX_IMAGE_DATA_CHARS + 64).split())
        if _valid_data_url(src):
            images.append(src)
    return images


_FIGURE_BLOCK_RE = re.compile(r"<figure\b[^>]*>.*?</figure>", re.IGNORECASE | re.DOTALL)
_IMG_TAG_RE = re.compile(r"<img\b[^>]*/?>", re.IGNORECASE)


def _defer_inline_images(html: str) -> str:
    """Move embedded figures after the surrounding text.

    PyMuPDF Story can stop laying out the remainder of a section when a data-URL
    image is the first item on a new page (seen when a one-line subtitle shifted
    an explanation figure across the page boundary).  Keeping images inline is
    not worth silently truncating the answer, so place them at the end of the
    field instead.  Captions travel with their figure.
    """
    if not html or "<img" not in html.lower():
        return html
    figures: list[str] = []

    def take_figure(match: re.Match) -> str:
        block = match.group(0)
        if "<img" in block.lower():
            figures.append(block)
            return ""
        return block

    body = _FIGURE_BLOCK_RE.sub(take_figure, html)

    def take_bare_img(match: re.Match) -> str:
        figures.append(f"<figure>{match.group(0)}</figure>")
        return ""

    body = _IMG_TAG_RE.sub(take_bare_img, body)
    if not figures:
        return html
    return body + "\n" + "\n".join(figures)


def _rich_html(raw_html: Any, plain: Any, limit: int) -> str:
    """Prefer sanitised source HTML (tables/images); fall back to plain text."""
    cleaned = _sanitize_html(raw_html)
    return _defer_inline_images(cleaned) or _inline_html(plain, limit)


def _append_images(html: str, images: Sequence[str]) -> str:
    if not images:
        return html
    tags = [
        f'<figure><img src="{src}" alt="Question media" width="480"/></figure>'
        for src in images
    ]
    return html + "\n" + "\n".join(tags)


def _prepare_questions(questions: Any) -> tuple[list[dict[str, Any]], int]:
    """Normalise question dicts, enforce caps. Returns (questions, dropped_count)."""
    if not isinstance(questions, (list, tuple)):
        return [], 0
    prepared: list[dict[str, Any]] = []
    dropped = 0
    total_chars = 0
    for raw in questions:
        if len(prepared) >= MAX_QUESTIONS:
            dropped += 1
            continue
        if not isinstance(raw, dict):
            dropped += 1
            continue
        stem = _as_text(raw.get("stem"), MAX_QUESTION_STEM_CHARS)
        explanation = _as_text(raw.get("explanation"), MAX_QUESTION_EXPLANATION_CHARS)
        raw_choices = raw.get("choices")
        choices = []
        if isinstance(raw_choices, (list, tuple)):
            for choice in list(raw_choices)[:MAX_QUESTION_CHOICES]:
                choices.append(_as_text(choice, MAX_QUESTION_CHOICE_CHARS))
        raw_choice_html = raw.get("choices_html")
        choices_html = []
        if isinstance(raw_choice_html, (list, tuple)):
            choices_html = [
                _clip_html_safe(item, MAX_RICH_HTML_CHARS)
                for item in list(raw_choice_html)[:MAX_QUESTION_CHOICES]
            ]
        tags = []
        raw_tags = raw.get("tags")
        if isinstance(raw_tags, (list, tuple)):
            tags = [_as_text(tag, MAX_QUESTION_TAG_CHARS) for tag in list(raw_tags)[:MAX_QUESTION_TAGS]]
        subject = _as_text(raw.get("subject"), 300)
        system = _as_text(raw.get("system"), 300)

        try:
            correct = int(raw.get("correct") or 1)
        except Exception:
            correct = 1
        if choices:
            correct = min(max(correct, 1), len(choices))
        else:
            correct = max(correct, 1)
        chosen_raw = raw.get("chosen")
        chosen: int | None
        try:
            chosen = None if chosen_raw is None else int(chosen_raw)
        except Exception:
            chosen = None
        if chosen is not None:
            if not choices or chosen < 0 or chosen >= len(choices):
                chosen = None

        record = {
            "id": _as_text(raw.get("id"), 120),
            "stem": stem,
            "stem_html": _clip_html_safe(raw.get("stem_html"), MAX_RICH_HTML_CHARS),
            "choices": choices,
            "choices_html": choices_html,
            "correct": correct,
            "explanation": explanation,
            "explanation_html": _clip_html_safe(raw.get("explanation_html"), MAX_RICH_HTML_CHARS),
            "media": _as_data_images(raw.get("media")),
            "explanation_media": _as_data_images(raw.get("explanation_media")),
            "subject": subject,
            "system": system,
            "tags": tags,
            "chosen": chosen,
        }
        total_chars += len(stem) + len(explanation) + sum(len(c) for c in choices)
        total_chars += len(subject) + len(system) + sum(len(t) for t in tags)
        if total_chars > MAX_TOTAL_TEXT:
            dropped += 1
            continue
        prepared.append(record)
    return prepared, dropped


def _question_page_html(question: dict[str, Any], index: int) -> str:
    """One question page: stem (with tables/images) plus every choice."""
    parts: list[str] = [f"<h2>Question {index + 1}</h2>"]
    parts.append(
        f"<div>{_rich_html(question['stem_html'], question['stem'], MAX_QUESTION_STEM_CHARS)}</div>"
    )
    choices_html = question["choices_html"]
    choices = question["choices"]
    if choices:
        for choice_index, choice in enumerate(choices):
            rich = _rich_html(
                choices_html[choice_index] if choice_index < len(choices_html) else "",
                choice,
                MAX_QUESTION_CHOICE_CHARS,
            )
            parts.append(
                f'<div class="choice"><b>{_letters(choice_index)}.</b> {rich}</div>'
            )
    else:
        parts.append('<p class="choice"><i>(no choices provided)</i></p>')
    return _append_images("\n".join(parts), question["media"])


def _answers_summary(questions: Sequence[dict[str, Any]]) -> str:
    correct = sum(
        1 for q in questions
        if q["chosen"] is not None and q["chosen"] + 1 == q["correct"]
    )
    answered = sum(1 for q in questions if q["chosen"] is not None)
    incorrect = answered - correct
    unanswered = len(questions) - answered
    return (
        f"{len(questions)} question{'s' if len(questions) != 1 else ''} · "
        f"{correct} correct · {incorrect} incorrect · {unanswered} not answered"
    )


def _answer_page_html(question: dict[str, Any], index: int) -> str:
    """The following page: answer, your result, then the full explanation."""
    correct = question["correct"]
    choices = question["choices"]
    choices_html = question["choices_html"]
    chosen = question["chosen"]
    correct_letter = _letters(correct - 1)
    parts: list[str] = [f"<h2>Question {index + 1} — Answer</h2>"]

    answer_line = f"<b>Correct answer: {correct_letter}.</b>"
    if 0 <= correct - 1 < len(choices):
        correct_text = _rich_html(
            choices_html[correct - 1] if correct - 1 < len(choices_html) else "",
            choices[correct - 1],
            MAX_QUESTION_CHOICE_CHARS,
        )
        answer_line += f" {correct_text}"
    parts.append(f'<p class="answer-line">{answer_line}</p>')

    if chosen is None:
        status = '<span style="color:#b45309"><b>Not answered</b></span>'
    elif chosen + 1 == correct:
        status = '<span style="color:#15803d"><b>Correct</b></span>'
    else:
        status = (
            '<span style="color:#b91c1c"><b>Incorrect</b></span>'
            f" — chose {_letters(chosen)}."
        )
    parts.append(f'<p class="answer-line"><b>Your answer:</b> {status}</p>')

    parts.append("<h3>Explanation</h3>")
    parts.append(
        f"<div>{_rich_html(question['explanation_html'], question['explanation'], MAX_QUESTION_EXPLANATION_CHARS)}</div>"
    )
    parts.append(
        _append_images("", question["explanation_media"])
    )

    meta_bits = []
    if question["subject"]:
        meta_bits.append(f"Subject: {_html.escape(question['subject'], quote=False)}")
    if question["system"]:
        meta_bits.append(f"System: {_html.escape(question['system'], quote=False)}")
    if question["tags"]:
        meta_bits.append(
            "Tags: " + _html.escape(", ".join(question["tags"]), quote=False)
        )
    if question["id"]:
        meta_bits.append(f"QID: {_html.escape(question['id'], quote=False)}")
    if meta_bits:
        parts.append(f'<p class="meta">{" · ".join(meta_bits)}</p>')
    return "\n".join(part for part in parts if part)


def _questions_plain_text(questions: Sequence[dict[str, Any]]) -> str:
    """Fallback text uses the same interleaved question → answer ordering."""
    lines: list[str] = []
    for index, question in enumerate(questions):
        lines.append(f"Question {index + 1}")
        lines.append(_strip_tags(question["stem_html"]) or question["stem"])
        for choice_index, choice in enumerate(question["choices"]):
            rich = _strip_tags(
                question["choices_html"][choice_index]
                if choice_index < len(question["choices_html"])
                else ""
            )
            lines.append(f"{_letters(choice_index)}. {rich or choice}")
        lines.append("")
        lines.append(f"Question {index + 1} — Answer")
        correct = question["correct"]
        chosen = question["chosen"]
        if chosen is None:
            status = "Not answered"
        elif chosen + 1 == correct:
            status = "Correct"
        else:
            status = f"Incorrect, chose {_letters(chosen)}"
        lines.append(f"Correct answer: {_letters(correct - 1)} ({status})")
        lines.append(
            "Explanation: "
            + (_strip_tags(question["explanation_html"]) or question["explanation"])
        )
        lines.append("")
    return "\n".join(lines)


def render_qbank_pdf(
    title: str,
    questions: Any,
    meta: dict | None = None,
    *,
    paper: str = "a4",
) -> bytes:
    """Render a Q-Bank session interleaved: question/choices, then answer/explanation.

    Each question gets its own two sections, so a choice is never on the same
    page as its answer.  Long questions or explanations may span further pages.
    Source HTML is preserved, so tables and embedded base64 images survive.
    """
    paper = _normalise_paper(paper)
    clean_title = _clean_title(title, "Q-Bank export")
    prepared, dropped = _prepare_questions(questions)
    clean_meta = dict(meta) if isinstance(meta, dict) else {}
    if dropped:
        clean_meta.setdefault("truncated", f"{dropped} question(s) omitted by export caps")

    def factory() -> bytes:
        if not prepared:
            body = '<p>No questions were included in this export.</p>'
            document_html = _compose_document_html(clean_title, None, body, clean_meta)
            doc = _render_story_document(document_html, paper)
            return _serialise_single(doc, clean_title, "Question")

        summary = _answers_summary(prepared)
        total = len(prepared)
        merged = fitz.open()
        labels: list[str] = []
        try:
            for index, question in enumerate(prepared):
                sections = (
                    (
                        f"Question {index + 1}",
                        _compose_document_html(
                            clean_title,
                            f"Question {index + 1} of {total} · {summary}",
                            _question_page_html(question, index),
                            clean_meta if index == 0 else {},
                        ),
                    ),
                    (
                        f"Answer {index + 1}",
                        _compose_document_html(
                            clean_title,
                            f"Answer {index + 1} of {total}",
                            _answer_page_html(question, index),
                            {},
                        ),
                    ),
                )
                for label, document_html in sections:
                    part = _render_story_document(document_html, paper)
                    try:
                        first = merged.page_count
                        merged.insert_pdf(part)
                        labels.extend([label] * (merged.page_count - first))
                    finally:
                        part.close()
            _stamp_document(merged, clean_title, labels)
            return bytes(merged.tobytes(garbage=3, deflate=True))
        finally:
            merged.close()

    return _safe_result(factory, clean_title, _questions_plain_text(prepared), paper)


# ─── Misc ───────────────────────────────────────────────────────────────────

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_tags(fragment: Any) -> str:
    if not isinstance(fragment, str):
        return ""
    text = _TAG_RE.sub(" ", fragment[:MAX_HTML_CHARS])
    return _html.unescape(" ".join(text.split()))


def capability_info() -> dict[str, Any]:
    """Machine-readable limits/engine info for ``GET /export/pdf/status``."""
    return {
        "engine": "pymupdf",
        "fitz_version": getattr(fitz, "__version__", "unknown"),
        "papers": sorted(_PAPERS),
        "max_questions": MAX_QUESTIONS,
        "max_rows": MAX_ROWS,
        "max_columns": MAX_COLUMNS,
        "max_html_chars": MAX_HTML_CHARS,
        "max_text_chars": MAX_TEXT_CHARS,
        "max_total_text_bytes": MAX_TOTAL_TEXT,
        "max_pages": MAX_PAGES,
        "qbank_page_order": "question-and-choices-then-answer-and-explanation",
        "tables": True,
        "embedded_images": True,
        "unicode_safe": True,
    }

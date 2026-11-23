"""Safe, self-contained native-print documents for bundled articles."""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from datetime import date
from html import escape, unescape
from urllib.parse import urlsplit

from selectolax.parser import HTMLParser


@dataclass(frozen=True)
class PrintSection:
    """A sanitized appendix section in a print document."""

    heading: str
    html: str


@dataclass(frozen=True)
class PrintDocument:
    """Source content and metadata needed for a local print preview."""

    title: str
    source: str
    source_url: str
    body_html: str
    sections: tuple[PrintSection, ...] = ()
    citation: str = ""


_REMOVE_LOCAL_NAMES = {
    "applet",
    "animate",
    "animatecolor",
    "animatemotion",
    "animatetransform",
    "area",
    "audio",
    "base",
    "button",
    "discard",
    "embed",
    "fencedframe",
    "form",
    "frame",
    "frameset",
    "iframe",
    "input",
    "link",
    "map",
    "meta",
    "noembed",
    "noframes",
    "noscript",
    "object",
    "optgroup",
    "option",
    "output",
    "portal",
    "script",
    "select",
    "set",
    "style",
    "textarea",
    "track",
    "video",
    "webview",
}
_EXPANDING_STYLE_PROPERTIES = {
    "clip",
    "clip-path",
    "mask",
    "mask-image",
    "max-height",
    "max-width",
    "overflow",
    "overflow-x",
    "overflow-y",
}
_SIZE_STYLE_PROPERTIES = {
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
_SIZE_CONSTRAINED_TAGS = {
    "img", "table", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td"
}
_SAFE_PRINT_DATA_IMAGE = re.compile(
    r"^data:image/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/]+={0,2}$",
    re.IGNORECASE,
)
_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_CSS_ESCAPE = re.compile(
    r"\\(?:([0-9a-f]{1,6})[\t\n\f\r ]?|([^0-9a-f\n\f\r]))",
    re.IGNORECASE,
)
_CSS_URL_START = re.compile(r"url\s*\(", re.IGNORECASE)
_CSS_UNSAFE_IMAGE_FUNCTION = re.compile(
    r"(?:^|[^-\w])(?:-webkit-)?(?:image-set|cross-fade|image|element|src)\s*\(",
    re.IGNORECASE,
)
_PRESENTATION_RESOURCE_ATTRIBUTES = {
    "clip-path",
    "cursor",
    "fill",
    "filter",
    "marker",
    "marker-end",
    "marker-mid",
    "marker-start",
    "mask",
    "mask-image",
    "stroke",
}
_NAVIGATION_HREF_TAGS = {"a"}
_NAVIGATION_SIDE_CHANNEL_ATTRIBUTES = {
    "attributionsrc",
    "download",
    "ismap",
    "ping",
    "referrerpolicy",
    "target",
    "usemap",
}
_URL_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
_SCHEME_IGNORED_CHARACTERS = re.compile(r"[\x00-\x20\x7f]")
_MEDOS_ACTION_PREFIXES = (
    "appaction",
    "medos-action",
    "medosaction",
    "uptodateappaction",
)


def _canonical_navigation_url(value: str) -> str:
    """Return an inert/readable citation URL using browser-like scheme parsing."""

    decoded = unescape(str(value or ""))
    candidate = _URL_CONTROL_CHARACTERS.sub("", decoded).strip()
    if not candidate or "\\" in candidate:
        return ""

    first_delimiter = min(
        (index for token in ("/", "?", "#") if (index := candidate.find(token)) >= 0),
        default=len(candidate),
    )
    colon = candidate.find(":")
    if 0 <= colon < first_delimiter:
        scheme = _SCHEME_IGNORED_CHARACTERS.sub("", candidate[:colon]).lower()
        if not re.fullmatch(r"[a-z][a-z0-9+.-]*", scheme):
            return ""
        if scheme not in {"http", "https"}:
            return ""
        candidate = f"{scheme}:{candidate[colon + 1:]}"
        try:
            parsed = urlsplit(candidate)
            parsed.port
        except ValueError:
            return ""
        if (
            not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or any(character.isspace() for character in parsed.netloc)
        ):
            return ""
        return candidate

    compact = _SCHEME_IGNORED_CHARACTERS.sub("", candidate).lower()
    if compact.startswith(_MEDOS_ACTION_PREFIXES):
        return ""
    if candidate.startswith("//"):
        return ""
    return candidate


def _is_safe_print_resource(value: str, *, allow_fragment: bool = False) -> bool:
    """Accept only adapter-rewritten same-host, fragment, or inline image URLs."""

    candidate = str(value or "").strip()
    if not candidate or any(ord(character) < 32 for character in candidate):
        return False
    if allow_fragment and candidate.startswith("#"):
        return not any(character.isspace() for character in candidate)
    if candidate.startswith("/") and not candidate.startswith("//"):
        return "\\" not in candidate
    return bool(_SAFE_PRINT_DATA_IMAGE.fullmatch(candidate))


def _decode_css_escapes(value: str) -> str:
    without_continuations = re.sub(r"\\(?:\r\n|[\n\f\r])", "", str(value))

    def replace(match: re.Match) -> str:
        if match.group(1):
            codepoint = int(match.group(1), 16)
            if not codepoint or codepoint > 0x10FFFF:
                return "\ufffd"
            return chr(codepoint)
        return match.group(2) or ""

    return _CSS_ESCAPE.sub(replace, without_continuations)


def _canonical_css(value: str) -> str:
    return _decode_css_escapes(_CSS_COMMENT.sub("", str(value))).strip()


def _split_css_declarations(style: str) -> list[str]:
    declarations: list[str] = []
    start = 0
    depth = 0
    quote = ""
    escaped = False
    source = str(style)
    for index, character in enumerate(source):
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if quote:
            if character == quote:
                quote = ""
            continue
        if character in {"'", '"'}:
            quote = character
        elif character == "(":
            depth += 1
        elif character == ")" and depth:
            depth -= 1
        elif character == ";" and not depth:
            declarations.append(source[start:index])
            start = index + 1
    declarations.append(source[start:])
    return declarations


def _css_resources_are_safe(value: str) -> bool:
    """Validate every CSS URL after comments and identifier escapes are decoded."""

    canonical = _canonical_css(value)
    if "/*" in canonical or "*/" in canonical:
        return False
    if _CSS_UNSAFE_IMAGE_FUNCTION.search(canonical):
        return False

    position = 0
    while True:
        match = _CSS_URL_START.search(canonical, position)
        if match is None:
            return True
        cursor = match.end()
        while cursor < len(canonical) and canonical[cursor].isspace():
            cursor += 1
        quote = canonical[cursor] if cursor < len(canonical) and canonical[cursor] in {"'", '"'} else ""
        if quote:
            cursor += 1
            end = canonical.find(quote, cursor)
            if end < 0:
                return False
            resource = canonical[cursor:end].strip()
            cursor = end + 1
            while cursor < len(canonical) and canonical[cursor].isspace():
                cursor += 1
            if cursor >= len(canonical) or canonical[cursor] != ")":
                return False
        else:
            end = canonical.find(")", cursor)
            if end < 0:
                return False
            resource = canonical[cursor:end].strip()
            cursor = end
        if not _is_safe_print_resource(resource, allow_fragment=True):
            return False
        position = cursor + 1


def _srcset_candidates(value: str) -> list[tuple[str, str]]:
    source = str(value or "")
    candidates: list[tuple[str, str]] = []
    position = 0
    while position < len(source):
        while position < len(source) and (
            source[position].isspace() or source[position] == ","
        ):
            position += 1
        if position >= len(source):
            break
        start = position
        if source[position : position + 5].lower() == "data:":
            separator = source.find(",", position)
            if separator < 0:
                break
            position = separator + 1
        while (
            position < len(source)
            and not source[position].isspace()
            and source[position] != ","
        ):
            position += 1
        url = source[start:position]
        while position < len(source) and source[position].isspace():
            position += 1
        descriptor_start = position
        while position < len(source) and source[position] != ",":
            position += 1
        descriptor = " ".join(source[descriptor_start:position].split())
        if url:
            candidates.append((url, descriptor))
    return candidates


def _safe_srcset(value: str) -> str:
    return ", ".join(
        f"{url} {descriptor}".strip()
        for url, descriptor in _srcset_candidates(value)
        if _is_safe_print_resource(url)
    )


def _clean_style(style: str, *, strip_sizing: bool = False) -> str:
    """Preserve harmless style declarations while undoing source clipping."""

    safe_declarations: list[str] = []
    for declaration in _split_css_declarations(style):
        if ":" not in declaration:
            continue
        property_name, value = declaration.split(":", 1)
        canonical_name = _canonical_css(property_name)
        canonical_value = _canonical_css(value)
        normalized_name = canonical_name.lower()
        normalized_value = re.sub(
            r"\s*!\s*important\s*$", "", canonical_value, flags=re.IGNORECASE
        ).lower()
        if (
            not re.fullmatch(r"-?[_a-z][-_a-z0-9]*", canonical_name, re.IGNORECASE)
            or normalized_name.startswith("--")
            or len(_split_css_declarations(canonical_value)) != 1
            or not _css_resources_are_safe(canonical_value)
        ):
            continue
        if normalized_name in _EXPANDING_STYLE_PROPERTIES:
            continue
        if strip_sizing and normalized_name in _SIZE_STYLE_PROPERTIES:
            continue
        if normalized_name == "display" and normalized_value == "none":
            continue
        if normalized_name == "visibility" and normalized_value in {"hidden", "collapse"}:
            continue
        if normalized_name in {"height", "width"} and normalized_value in {
            "0",
            "0px",
            "0rem",
            "0em",
        }:
            continue
        safe_declarations.append(f"{canonical_name}: {canonical_value}")
    return "; ".join(safe_declarations)


def _inner_html(node) -> str:
    markup = node.html
    start = markup.find(">") + 1
    end = markup.rfind("</")
    return markup[start:end] if start > 0 and end >= start else markup


def sanitize_print_fragment(fragment: str) -> str:
    """Remove active content and reveal article text needed on paper."""

    tree = HTMLParser(fragment or "")
    for node in reversed(tree.css("*")):
        local_name = node.tag.rsplit(":", 1)[-1].lower()
        if local_name in _REMOVE_LOCAL_NAMES or "data-medos-print-ignore" in node.attributes:
            node.decompose()
    for node in tree.css("*"):
        local_tag = node.tag.rsplit(":", 1)[-1].lower()
        for name, value in list(node.attributes.items()):
            normalized_name = name.lower()
            local_attribute = normalized_name.rsplit(":", 1)[-1]
            if local_attribute.startswith("on") or local_attribute in {
                "base",
                "hidden",
                "aria-hidden",
            }:
                del node.attrs[name]
            elif local_tag in _SIZE_CONSTRAINED_TAGS and local_attribute in {
                "width",
                "height",
            }:
                del node.attrs[name]
            elif local_attribute == "srcset":
                safe_srcset = _safe_srcset(str(value))
                if safe_srcset:
                    node.attrs[name] = safe_srcset
                else:
                    del node.attrs[name]
            elif local_attribute in {"src", "poster", "data"} and not _is_safe_print_resource(
                str(value)
            ):
                del node.attrs[name]
            elif local_attribute in _NAVIGATION_SIDE_CHANNEL_ATTRIBUTES:
                del node.attrs[name]
            elif local_attribute == "href" and local_tag in _NAVIGATION_HREF_TAGS:
                navigation_url = _canonical_navigation_url(str(value))
                if navigation_url:
                    node.attrs[name] = navigation_url
                else:
                    del node.attrs[name]
            elif local_attribute == "href" and local_tag not in _NAVIGATION_HREF_TAGS and not _is_safe_print_resource(
                str(value), allow_fragment=True
            ):
                del node.attrs[name]
            elif local_attribute == "background" and not _is_safe_print_resource(
                str(value)
            ):
                del node.attrs[name]
            elif local_attribute in _PRESENTATION_RESOURCE_ATTRIBUTES and not _css_resources_are_safe(
                str(value)
            ):
                del node.attrs[name]
            elif local_attribute == "style":
                cleaned_style = _clean_style(
                    str(value), strip_sizing=local_tag in _SIZE_CONSTRAINED_TAGS
                )
                if cleaned_style:
                    node.attrs[name] = cleaned_style
                else:
                    del node.attrs[name]
        if local_tag == "details":
            node.attrs["open"] = ""
    return _inner_html(tree.body) if tree.body else tree.html


def data_uri(data: bytes, mime: str) -> str:
    """Encode locally bundled media without network access."""

    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def missing_asset(title: str, detail: str) -> str:
    """Return an inert, labeled replacement for an unavailable local asset."""

    return (
        '<aside class="print-asset-missing" role="note">'
        f"<strong>{escape(title)}</strong><span>{escape(detail)}</span></aside>"
    )


def _sections_html(sections: tuple[PrintSection, ...]) -> str:
    return "".join(
        "<section class=\"print-appendix\">"
        f"<h2>{escape(section.heading)}</h2>"
        f"{sanitize_print_fragment(section.html)}"
        "</section>"
        for section in sections
    )


def render_print_document(document: PrintDocument, prepared_on: date | None = None) -> str:
    """Render a complete local print preview; native printing stays user initiated."""

    prepared = prepared_on or date.today()
    title = escape(document.title)
    source = escape(document.source)
    source_url = escape(document.source_url)
    citation = escape(document.citation)
    body = sanitize_print_fragment(document.body_html)
    sections = _sections_html(document.sections)
    citation_html = f'<p class="citation">{citation}</p>' if citation else ""

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — {source}</title>
<style>
:root {{ color-scheme: light; font-family: Georgia, 'Times New Roman', serif; }}
* {{ box-sizing: border-box; }}
body {{ margin: 0; color: #141414; background: #fff; line-height: 1.45; }}
.print-toolbar {{ position: sticky; top: 0; z-index: 2; display: flex; gap: .75rem; align-items: center; padding: .75rem 1rem; background: #f3f5f7; border-bottom: 1px solid #a8b0b8; font-family: system-ui, sans-serif; }}
.print-toolbar button {{ min-height: 2.5rem; padding: .45rem .75rem; color: #fff; background: #084c8d; border: 1px solid #063866; border-radius: .25rem; font: inherit; font-weight: 650; cursor: pointer; }}
.print-toolbar button[disabled] {{ cursor: wait; opacity: .65; }}
.print-toolbar button:focus-visible {{ outline: 3px solid #f0a500; outline-offset: 2px; }}
.print-status {{ margin-left: auto; color: #243746; }}
.print-document {{ width: min(100% - 1.1in, 8.5in); margin: .55in auto; }}
.print-header {{ border-bottom: 2px solid #1e3d59; margin-bottom: .3in; }}
h1 {{ margin: 0; font-size: 1.7rem; line-height: 1.18; }}
h2 {{ margin-top: .42in; break-after: avoid-page; }}
.print-metadata, .citation, .print-footer {{ color: #38434d; font-size: .9rem; }}
.print-metadata {{ overflow-wrap: anywhere; }}
article, section, details, [hidden], [aria-hidden='true'] {{ display: block !important; visibility: visible !important; max-height: none !important; clip: auto !important; clip-path: none !important; mask: none !important; overflow: visible !important; }}
details > * {{ display: block !important; }}
table {{ display: table; width: 100% !important; min-width: 0 !important; max-width: 100% !important; border-collapse: collapse; table-layout: auto; overflow: visible !important; }}
table, colgroup, col, thead, tbody, tfoot, tr, th, td {{ max-width: 100% !important; min-width: 0 !important; }}
th, td {{ border: 1px solid #64748b; padding: .3rem; vertical-align: top; }}
thead {{ display: table-header-group; }}
tr {{ break-inside: avoid; page-break-inside: avoid; }}
figure, figcaption, .callout, blockquote, .print-asset-missing {{ break-inside: avoid; page-break-inside: avoid; }}
figure {{ margin: .25in 0; }}
figcaption {{ color: #38434d; font-size: .9rem; }}
img {{ display: block; min-width: 0 !important; min-height: 0 !important; max-width: 100% !important; max-height: 9.3in !important; width: auto !important; height: auto !important; object-fit: contain; }}
.print-asset-missing {{ display: grid; gap: .2rem; margin: .25in 0; padding: .75rem; color: #531b1b; background: #fff3cd; border: 1px solid #b45309; font-family: system-ui, sans-serif; }}
.print-footer {{ margin-top: .35in; border-top: 1px solid #94a3b8; padding-top: .12in; }}
@page {{ size: Letter; margin: 0.55in; @bottom-center {{ content: counter(page); }} }}
@media print {{
  .print-toolbar {{ display: none !important; }}
  .print-document {{ width: auto; margin: 0; }}
  .print-header {{ position: running(print-header); }}
  .print-footer {{ position: running(print-footer); }}
  a[href]:not([href^='#']):after {{ content: ' (' attr(href) ')'; font-size: .8em; overflow-wrap: anywhere; }}
  a[href^='javascript:']:after {{ content: ''; }}
  body {{ print-color-adjust: exact; -webkit-print-color-adjust: exact; }}
}}
</style>
</head>
<body>
<nav class="print-toolbar" aria-label="Print preview controls">
  <button id="print-button" type="button" disabled>Print / Save PDF</button>
  <button id="return-button" type="button" data-source-url="{source_url}">Return to article</button>
  <span id="print-status" class="print-status" role="status" aria-live="polite">Preparing local figures</span>
</nav>
<main class="print-document">
  <header class="print-header">
    <h1>{title}</h1>
    <p class="print-metadata">Source: {source}<br>Local source: {source_url}<br>Prepared: {prepared.isoformat()}</p>
  </header>
  <article>{body}</article>
  {sections}
  {citation_html}
  <footer class="print-footer">{source} · Prepared {prepared.isoformat()} {citation}</footer>
</main>
<script>
(() => {{
  const printButton = document.getElementById('print-button');
  const returnButton = document.getElementById('return-button');
  const status = document.getElementById('print-status');
  let missing = 0;
  const pending = new Set(document.images);
  const showMissingAsset = (img) => {{
    if (img.dataset.medosMissing) return;
    img.dataset.medosMissing = 'true';
    missing += 1;
    const replacement = document.createElement('aside');
    replacement.className = 'print-asset-missing';
    replacement.setAttribute('role', 'note');
    const label = document.createElement('strong');
    label.textContent = 'Unavailable figure';
    const detail = document.createElement('span');
    detail.textContent = img.alt || 'Could not load bundled image';
    replacement.append(label, detail);
    img.replaceWith(replacement);
  }};
  const waitForImage = (img) => new Promise((resolve) => {{
    let settled = false;
    const complete = () => {{
      if (settled) return;
      settled = true;
      pending.delete(img);
      resolve();
    }};
    const fail = () => {{
      if (settled) return;
      showMissingAsset(img);
      complete();
    }};
    const decode = () => {{
      if (!img.decode) {{ complete(); return; }}
      Promise.resolve(img.decode()).then(complete, fail);
    }};
    if (img.complete) {{
      if (!img.naturalWidth) fail();
      else decode();
      return;
    }}
    img.addEventListener('load', decode, {{ once: true }});
    img.addEventListener('error', fail, {{ once: true }});
  }});
  let finished = false;
  const finish = () => {{
    if (finished) return;
    finished = true;
    printButton.disabled = false;
    status.textContent = missing ? `${{missing}} missing assets; ready to print` : 'Ready to print';
  }};
  const timeout = setTimeout(() => {{
    for (const img of pending) showMissingAsset(img);
    pending.clear();
    finish();
  }}, 8000);
  Promise.all([
    document.fonts && document.fonts.ready ? document.fonts.ready.catch(() => undefined) : Promise.resolve(),
    ...Array.from(document.images, waitForImage),
  ]).then(() => {{ clearTimeout(timeout); finish(); }});
  printButton.addEventListener('click', () => window.print());
  returnButton.addEventListener('click', () => {{
    if (window.name === 'medos-print-preview') {{
      window.close();
      if (window.closed) return;
    }}
    window.location.assign(returnButton.dataset.sourceUrl);
  }});
}})();
</script>
</body>
</html>"""

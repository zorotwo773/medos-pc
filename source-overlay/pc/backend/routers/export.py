"""PDF export API (offline).

Exposes the PyMuPDF renderers in :mod:`pdf_export` to the frontend:

    GET  /export/pdf/status   — engine + limits (used by the top-bar button)
    POST /export/pdf/page     — captured topic/article page (sanitised HTML)
    POST /export/pdf/topic    — alias of ``/pdf/page`` for topic viewers
    POST /export/pdf/qbank    — Q-Bank session: questions + answers section
    POST /export/pdf/rows     — generic table export

All routes stream ``application/pdf`` bytes. Input is validated with Pydantic
models; malformed JSON / wrong types return **400** (not 500 or 422), and the
renderers themselves are defensive so odd unicode or hostile HTML still yields
a valid PDF.
"""

from __future__ import annotations

import base64
import html as html_lib
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, unquote

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

import pdf_export

router = APIRouter(prefix="/export", tags=["export"])

# Request payload caps.  The renderers clamp content further (see MAX_* in
# pdf_export); these limits only stop absurd bodies from being parsed at all.
MAX_HTTP_STRING_CHARS = 30_000_000
MAX_HTTP_QUESTIONS = 20_000
MAX_HTTP_ROWS = 60_000

Paper = Literal["a4", "letter"]


class _Payload(BaseModel):
    model_config = ConfigDict(extra="ignore")


class PagePdfRequest(_Payload):
    """Captured page / article body for ``/export/pdf/page`` and ``/topic``."""

    title: str = Field(default="MedOS export", max_length=2_000)
    subtitle: str | None = Field(default=None, max_length=4_000)
    html: str | None = Field(default=None, max_length=MAX_HTTP_STRING_CHARS)
    text: str | None = Field(default=None, max_length=MAX_HTTP_STRING_CHARS)
    meta: dict[str, Any] | None = None
    paper: Paper = "a4"


class QbankQuestionModel(_Payload):
    """One question as displayed by the Q-Bank engine."""

    id: str | int | None = None
    stem: str = Field(default="", max_length=MAX_HTTP_STRING_CHARS)
    stem_html: str = Field(default="", max_length=MAX_HTTP_STRING_CHARS)
    choices: list[str] = Field(default_factory=list)
    choices_html: list[str] = Field(default_factory=list)
    correct: int = 1
    explanation: str = Field(default="", max_length=MAX_HTTP_STRING_CHARS)
    explanation_html: str = Field(default="", max_length=MAX_HTTP_STRING_CHARS)
    # Source refs (e.g. "/qbank/media/123/fig.png") OR already-embedded data URLs.
    # The backend resolves local refs to base64 so the browser never has to fetch.
    media: list[str] = Field(default_factory=list)
    explanation_media: list[str] = Field(default_factory=list)
    # Bank key used to resolve relative media/exhibit URLs (step1/step2/...).
    db: str = Field(default="step2", max_length=64)
    subject: str = Field(default="", max_length=4_000)
    system: str = Field(default="", max_length=4_000)
    tags: list[str] = Field(default_factory=list)
    chosen: int | None = None


class QbankPdfRequest(_Payload):
    title: str = Field(default="Q-Bank export", max_length=2_000)
    questions: list[QbankQuestionModel] = Field(default_factory=list)
    meta: dict[str, Any] | None = None
    paper: Paper = "a4"


class RowsPdfRequest(_Payload):
    title: str = Field(default="MedOS table export", max_length=2_000)
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    meta: dict[str, Any] | None = None
    paper: Paper = "a4"


def _invalid(endpoint: str, detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=f"{endpoint}: {detail}")


def _validate(model: type[BaseModel], payload: Any, endpoint: str):
    """Validate a raw JSON body against *model*; raise 400 on any problem."""
    if not isinstance(payload, dict):
        raise _invalid(endpoint, "request body must be a JSON object")
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        issues: list[dict[str, Any]] = []
        for error in exc.errors()[:5]:
            issues.append({
                "loc": [str(part) for part in error.get("loc", [])],
                "msg": error.get("msg", "invalid value"),
                "type": error.get("type", "value_error"),
            })
        raise HTTPException(
            status_code=400,
            detail={"endpoint": endpoint, "error": "invalid payload", "issues": issues},
        ) from exc


def _ascii(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    return text.encode("ascii", "replace").decode("ascii")


def _export_filename(title: str, kind: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", _ascii(title).lower()).strip("-")[:64]
    return f"medos-{kind}-{slug or kind}.pdf"


def _pdf_response(pdf: bytes, title: str, kind: str) -> Response:
    filename = _export_filename(title, kind)
    disposition = (
        f'attachment; filename="{filename}"; '
        f"filename*=UTF-8''{quote(filename)}"
    )
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": disposition,
            "Content-Length": str(len(pdf)),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _render(renderer, fallback_title: str, endpoint: str) -> bytes:
    """Run a renderer; degrade to a text PDF instead of ever returning 500."""
    try:
        pdf = renderer()
    except Exception as exc:  # pragma: no cover - renderers are defensive
        print(f"[export] {endpoint} render failed: {exc}", file=sys.stderr)
        pdf = b""
    if not pdf or bytes(pdf[:5]) != b"%PDF-":
        try:
            pdf = pdf_export.render_text_pdf(
                fallback_title,
                "The requested export could not be laid out. "
                "The source content may be malformed.",
            )
        except Exception as exc:  # pragma: no cover
            print(f"[export] {endpoint} fallback failed: {exc}", file=sys.stderr)
            raise _invalid(endpoint, "export could not be generated") from exc
    return pdf


def _title(value: str | None, default: str) -> str:
    title = " ".join(str(value or "").split())
    return title or default


# ─── Q-Bank visual resolution (offline, server-side) ───────────────────────
# Q-Bank figures are NOT plain <img> tags. They are either
#   * <a href="/qbank/media/{qid}/{name}"> or <img src="/qbank/media/...">, or
#   * exhibit pages at /qbank/exhibit/{id} rendered in an iframe (UWorld tables
#     and figures live here).
# The browser cannot embed those reliably (CORS, blob type, iframes), so we
# resolve them here using the very same readers the Q-Bank UI uses. The output
# contains only <table>/<img src="data:..."> markup that pdf_export can draw
# with no network access.

_MAX_EMBED_BYTES = 8 * 1024 * 1024
# A 30-question block commonly carries more than 16 figures.  Budget images per
# question (so one exhibit-heavy question cannot starve the rest), with a generous
# session ceiling and total byte ceiling to keep a pathological payload bounded.
_MAX_EMBEDDED_IMAGES_PER_QUESTION = 40
_MAX_EMBEDDED_IMAGES = 512
_MAX_TOTAL_EMBED_BYTES = 384 * 1024 * 1024
_IMAGE_MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
}

_reader_module: Any = None
_reader_tried = False
visual_stats: dict[str, int] = {
    "media": 0,
    "exhibits": 0,
    "hydrated": 0,
    "failed": 0,
}
_HYDRATION_CACHE: dict[tuple[str, int], dict[str, Any]] = {}
_MAX_HYDRATION_CACHE = 512


def _qbank_reader():
    """Lazily import qbank_reader so PDF export still works if it is absent."""
    global _reader_module, _reader_tried
    if _reader_module is not None:
        return _reader_module  # also allows tests to inject a reader
    if _reader_tried:
        return None
    _reader_tried = True
    try:
        import qbank_reader  # noqa: WPS433 - optional heavy dependency
        _reader_module = qbank_reader
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[export] qbank_reader unavailable for visuals: {exc}", file=sys.stderr)
        _reader_module = None
    return _reader_module


def _ref_db(url: str, db: str) -> str:
    """Prefer an explicit ?db= on the reference, else the question's bank."""
    match = re.search(r"[?&]db=([^&#]+)", url or "")
    return unquote(match.group(1)) if match else (db or "step2")


def _media_key(url: str) -> str:
    match = re.search(r"/qbank/media/(\d+)/([^?#]+)", url or "")
    if not match:
        return (url or "").lower()
    return f"{match.group(1)}/{Path(unquote(match.group(2))).name.lower()}"


def _new_visual_budget() -> dict[str, Any]:
    """Per-export embed accounting.

    ``data`` doubles as a cache: the same local figure can appear as an anchor,
    inside an exhibit and in ``media``/``explanation_media``.  It must only be
    decoded and counted once, or a single image can exhaust the old cap.
    """
    return {
        "images": 0,
        "question_images": 0,
        "bytes": 0,
        "seen": set(),
        "data": {},
    }


def _visual_room(budget: dict[str, Any]) -> bool:
    return (
        budget["images"] < _MAX_EMBEDDED_IMAGES
        and budget["question_images"] < _MAX_EMBEDDED_IMAGES_PER_QUESTION
        and budget["bytes"] < _MAX_TOTAL_EMBED_BYTES
    )


def _data_url_bytes(data_url: str) -> int:
    comma = data_url.find(",")
    return max(0, (len(data_url) - comma - 1) * 3 // 4) if comma >= 0 else 0


def _remember_image(budget: dict[str, Any], url: str, data_url: str) -> str:
    key = _media_key(url)
    cached = budget["data"].get(key)
    if cached:
        return cached
    budget["data"][key] = data_url
    budget["seen"].add(key)
    budget["images"] += 1
    budget["question_images"] += 1
    budget["bytes"] += _data_url_bytes(data_url)
    return data_url


def _question_id(value: Any) -> int | None:
    """Return a usable numeric Q-Bank id, or ``None`` for source ids/GUIDs."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        match = re.fullmatch(r"(?:QID\s*)?(\d+)", value.strip(), re.IGNORECASE)
        if match:
            qid = int(match.group(1))
            return qid if qid > 0 else None
    return None


def _media_urls(value: Any, qid: int | None) -> list[str]:
    """Normalise qbank_reader media dicts / URL strings into URL strings."""
    urls: list[str] = []
    seen: set[str] = set()

    def add(candidate: Any) -> None:
        url = str(candidate or "").strip()
        if not url:
            return
        key = url.lower()
        if key in seen:
            return
        seen.add(key)
        urls.append(url)

    for item in value if isinstance(value, (list, tuple)) else []:
        if isinstance(item, dict):
            url = item.get("url")
            if not url and qid and item.get("name"):
                url = f"/qbank/media/{qid}/{item['name']}"
            add(url)
        else:
            add(item)
    return urls


def _hydrate_qbank_questions(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Restore authoritative rich HTML for saved sessions with stripped fields.

    Q-Bank exam sessions deliberately drop ``explanation_html`` from localStorage
    to keep storage small. When the question has a numeric id and a local bank,
    fetch the same question from the shipped bank and restore its rich HTML and
    media refs here. User answers/correctness are never overwritten.
    """
    reader = _qbank_reader()
    if reader is None or not hasattr(reader, "_conn") or not hasattr(reader, "_fetch_full_question"):
        return questions

    wanted: dict[str, list[int]] = {}
    question_keys: list[tuple[str, int] | None] = []
    for question in questions:
        qid = _question_id(question.get("id"))
        db = str(question.get("db") or "step2")
        question_keys.append((db, qid) if qid is not None else None)
        if qid is not None:
            wanted.setdefault(db, [])
            if qid not in wanted[db]:
                wanted[db].append(qid)
    if not wanted:
        return questions

    full_questions: dict[tuple[str, int], dict[str, Any]] = {}
    for db, qids in wanted.items():
        conn: Any = None
        try:
            conn = reader._conn(db)
            for qid in qids:
                key = (db, qid)
                full = _HYDRATION_CACHE.get(key)
                if full is None:
                    full = reader._fetch_full_question(conn, qid, db) or {}
                    if full:
                        if len(_HYDRATION_CACHE) >= _MAX_HYDRATION_CACHE:
                            _HYDRATION_CACHE.clear()
                        _HYDRATION_CACHE[key] = full
                if full:
                    full_questions[key] = full
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[export] qbank hydration unavailable for {db}: {exc}", file=sys.stderr)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # pragma: no cover - defensive
                    pass
    if not full_questions:
        return questions

    for question, key in zip(questions, question_keys):
        if key is None:
            continue
        full = full_questions.get(key)
        if not full:
            continue
        qid = key[1]
        # Safety check: imported banks may put a source id in `id`, which can
        # collide with an unrelated local row. Never hydrate from a row that
        # is neither the same local id nor the same source id.
        payload_id = str(question.get("id") or "").strip()
        full_ids = {str(full.get("id") or ""), str(full.get("source_id") or "")}
        full_ids.discard("")
        if payload_id and payload_id not in full_ids and qid != _question_id(full.get("id")):
            continue
        # Always prefer authoritative rich HTML: a saved/compacted session may
        # contain only plain text, and the tables/figures live in this HTML.
        for field in ("stem_html", "explanation_html"):
            if full.get(field):
                question[field] = full[field]
        if full.get("choices_html"):
            question["choices_html"] = list(full["choices_html"])
        # Plain text is only a fallback when the rich markup is absent.
        for field in ("stem", "explanation", "choices", "subject", "system", "tags"):
            if not question.get(field) and full.get(field):
                question[field] = full[field]
        for field, source_key in (("media", "media"), ("explanation_media", "explanation_media")):
            urls = _media_urls(full.get(source_key), qid)
            if urls or not question.get(field):
                question[field] = urls
        visual_stats["hydrated"] += 1
    return questions


def _media_data_url(url: str, db: str) -> str | None:
    """Resolve a /qbank/media/... ref (or pass through a data: URL) to base64."""
    url = (url or "").strip()
    if not url:
        return None
    if url.lower().startswith("data:image/"):
        return url
    reader = _qbank_reader()
    if reader is None:
        return None
    match = re.search(r"/qbank/media/(\d+)/([^?#]+)", url)
    if not match:
        return None
    try:
        qid = int(match.group(1))
        name = Path(unquote(match.group(2))).name
        if not name:
            return None
        ref_db = _ref_db(url, db)
        path = reader._resolve_qbank_media_path(ref_db, qid, name)
        if path is None and ref_db != db:
            path = reader._resolve_qbank_media_path(db or "step2", qid, name)
        if path is None or not path.exists():
            return None
        mime = _IMAGE_MIME.get(path.suffix.lower())
        if not mime:  # video/audio/unknown cannot be drawn inline in a PDF
            return None
        data = reader._decrypt_media(path.name, path.read_bytes())
        if not data or len(data) > _MAX_EMBED_BYTES:
            return None
        visual_stats["media"] += 1
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    except Exception:  # pragma: no cover - defensive
        return None


def _exhibit_fragment(url: str, db: str) -> str | None:
    """Resolve a /qbank/exhibit/{id} ref to its HTML fragment (tables/figures)."""
    match = re.search(r"/qbank/exhibit/(\d+)", url or "")
    if not match:
        return None
    reader = _qbank_reader()
    if reader is None:
        return None
    try:
        found = reader._exhibit_html(_ref_db(url, db), match.group(1))
        if not found:
            return None
        _qid, fragment = found
        visual_stats["exhibits"] += 1
        return fragment or None
    except Exception:  # pragma: no cover - defensive
        return None


_MEDIA_ANCHOR_RE = re.compile(
    r"""<a\b[^>]*?href=(["'])([^"']*?/qbank/media/[^"']+)\1[^>]*?>(.*?)</a>""",
    re.IGNORECASE | re.DOTALL,
)
_EXHIBIT_ANCHOR_RE = re.compile(
    r"""<a\b[^>]*?href=(["'])([^"']*?/qbank/exhibit/[^"']+)\1[^>]*?>(.*?)</a>""",
    re.IGNORECASE | re.DOTALL,
)
_IMG_SRC_RE = re.compile(
    r"""<img\b[^>]*?src=(["'])([^"']+)\1[^>]*?/?>""",
    re.IGNORECASE | re.DOTALL,
)


def _anchor_label(inner: str, fallback: str) -> str:
    text = re.sub(r"<[^>]+>", " ", inner or "")
    text = html_lib.unescape(text)
    return " ".join(text.split())[:200] or fallback


def _enrich_html(html: str, db: str, extra_media: list[str] | None, budget: dict[str, Any]) -> str:
    """Replace exhibit/media refs with embedded tables and data-URL images."""
    if not html:
        return ""
    out = html

    def resolve(url: str) -> tuple[str | None, bool]:
        """Return ``(data_url, failed_to_resolve)``.

        Cached images are returned even when a cap is otherwise reached: they
        were already paid for, so reusing them never grows the payload.
        """
        key = _media_key(url)
        cached = budget["data"].get(key)
        if cached:
            return cached, True
        if not _visual_room(budget):
            return None, False
        data = _media_data_url(url, db)
        if not data:
            return None, True
        return _remember_image(budget, url, data), True

    # 1) Exhibit links -> inline the exhibit fragment (this is where UWorld
    #    tables and most figures actually live). Resolve its media in step 3.
    def exhibit_repl(match: re.Match) -> str:
        label = _anchor_label(match.group(3), "Exhibit")
        fragment = _exhibit_fragment(match.group(2), db)
        if not fragment:
            visual_stats["failed"] += 1
            return f'<p><i>[Exhibit: {html_lib.escape(label)} — not available offline]</i></p>'
        return (
            f'<figure class="qbank-exhibit">{fragment}'
            f'<figcaption>{html_lib.escape(label)}</figcaption></figure>'
        )

    out = _EXHIBIT_ANCHOR_RE.sub(exhibit_repl, out)

    # 2) Media anchors -> inline image + caption.
    def anchor_repl(match: re.Match) -> str:
        label = _anchor_label(match.group(3), "Image")
        data, failed = resolve(match.group(2))
        if not data:
            visual_stats["failed"] += int(failed)
            reason = "source not embedded" if failed else "omitted (image cap)"
            return f"<p><i>[Image: {html_lib.escape(label)} — {reason}]</i></p>"
        caption = f"<figcaption>{html_lib.escape(label)}</figcaption>" if label else ""
        return (
            f'<figure><img src="{data}" alt="{html_lib.escape(label, quote=True)}" '
            f'width="480"/>{caption}</figure>'
        )

    out = _MEDIA_ANCHOR_RE.sub(anchor_repl, out)

    # 3) Any remaining <img src="/qbank/media/..."> (including inside an
    #    embedded exhibit) -> replace the source with a data URL.
    def img_repl(match: re.Match) -> str:
        src = match.group(2)
        if src.lower().startswith("data:"):
            return match.group(0)
        data, failed = resolve(src)
        if not data:
            visual_stats["failed"] += int(failed)
            if failed:
                return match.group(0)  # renderer will caption an unembeddable src
            return '<p><i>[Image: source not embedded — image cap]</i></p>'
        return match.group(0).replace(src, data, 1)

    out = _IMG_SRC_RE.sub(img_repl, out)

    # 4) Declared media list (question.media) not already embedded inline.
    appended: list[str] = []
    for url in extra_media or []:
        key = _media_key(url)
        if key in budget["seen"]:
            continue
        data, failed = resolve(url)
        if not data:
            if not failed:
                break
            continue
        appended.append(f'<figure><img src="{data}" alt="Question media" width="480"/></figure>')
    return out + "".join(appended)


def enrich_qbank_questions(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve every visual reference in a Q-Bank payload before rendering."""
    budget = _new_visual_budget()
    enriched: list[dict[str, Any]] = []
    for question in questions:
        budget["question_images"] = 0
        db = str(question.get("db") or "step2")
        item = dict(question)
        item["stem_html"] = _enrich_html(
            str(question.get("stem_html") or ""), db, question.get("media"), budget,
        )
        item["choices_html"] = [
            _enrich_html(str(choice or ""), db, None, budget)
            for choice in (question.get("choices_html") or [])
        ]
        item["explanation_html"] = _enrich_html(
            str(question.get("explanation_html") or ""), db,
            question.get("explanation_media"), budget,
        )
        # The renderer only understands embedded data URLs in these arrays.
        item["media"] = []
        item["explanation_media"] = []
        enriched.append(item)
    return enriched


# ─── Status ────────────────────────────────────────────────────────────────

@router.get("/pdf/status")
def pdf_status() -> dict[str, Any]:
    """Engine capability probe for the frontend Export PDF button."""
    info = pdf_export.capability_info()
    return {
        "ok": True,
        "now": datetime.now().isoformat(timespec="seconds"),
        "content_type": "application/pdf",
        "endpoints": [
            "/export/pdf/page",
            "/export/pdf/topic",
            "/export/pdf/qbank",
            "/export/pdf/rows",
        ],
        **info,
    }


# ─── Page / topic ──────────────────────────────────────────────────────────

@router.post("/pdf/page")
def pdf_page(payload: Any = Body(...)) -> Response:
    request = _validate(PagePdfRequest, payload, "pdf/page")
    if not (request.html or request.text):
        raise _invalid("pdf/page", "one of 'html' or 'text' is required")
    title = _title(request.title, "MedOS export")
    pdf = _render(
        lambda: pdf_export.render_page_pdf(
            title,
            subtitle=request.subtitle,
            html=request.html,
            text=request.text,
            meta=request.meta,
            paper=request.paper,
        ),
        title,
        "pdf/page",
    )
    return _pdf_response(pdf, title, "page")


@router.post("/pdf/topic")
def pdf_topic(payload: Any = Body(...)) -> Response:
    request = _validate(PagePdfRequest, payload, "pdf/topic")
    if not (request.html or request.text):
        raise _invalid("pdf/topic", "one of 'html' or 'text' is required")
    title = _title(request.title, "MedOS topic")
    pdf = _render(
        lambda: pdf_export.render_topic_pdf(
            title,
            subtitle=request.subtitle,
            html=request.html,
            text=request.text,
            meta=request.meta,
            paper=request.paper,
        ),
        title,
        "pdf/topic",
    )
    return _pdf_response(pdf, title, "topic")


# ─── Q-Bank ────────────────────────────────────────────────────────────────

@router.post("/pdf/qbank")
def pdf_qbank(payload: Any = Body(...)) -> Response:
    request = _validate(QbankPdfRequest, payload, "pdf/qbank")
    if len(request.questions) > MAX_HTTP_QUESTIONS:
        raise _invalid(
            "pdf/qbank",
            f"too many questions ({len(request.questions)}; max {MAX_HTTP_QUESTIONS})",
        )
    title = _title(request.title, "Q-Bank export")
    questions = [question.model_dump() for question in request.questions]
    # Resolve exhibits/images server-side so tables and figures actually appear
    # in the PDF. Never let a resolver failure break the whole export.
    visual_stats.update({"media": 0, "exhibits": 0, "hydrated": 0, "failed": 0})
    # Saved exam sessions strip explanation_html before localStorage; restore it
    # from the local bank so answer tables/figures survive the export as well.
    try:
        questions = _hydrate_qbank_questions(questions)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[export] qbank hydration failed: {exc}", file=sys.stderr)
    try:
        questions = enrich_qbank_questions(questions)
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[export] qbank visual enrichment failed: {exc}", file=sys.stderr)
    pdf = _render(
        lambda: pdf_export.render_qbank_pdf(
            title, questions, request.meta, paper=request.paper,
        ),
        title,
        "pdf/qbank",
    )
    response = _pdf_response(pdf, title, "qbank")
    response.headers["X-Medos-Visual-Embeds"] = (
        f"media={visual_stats['media']};exhibits={visual_stats['exhibits']};"
        f"hydrated={visual_stats['hydrated']};failed={visual_stats['failed']}"
    )
    return response


# ─── Rows ──────────────────────────────────────────────────────────────────

@router.post("/pdf/rows")
def pdf_rows(payload: Any = Body(...)) -> Response:
    request = _validate(RowsPdfRequest, payload, "pdf/rows")
    if len(request.rows) > MAX_HTTP_ROWS:
        raise _invalid(
            "pdf/rows",
            f"too many rows ({len(request.rows)}; max {MAX_HTTP_ROWS})",
        )
    title = _title(request.title, "MedOS table export")
    pdf = _render(
        lambda: pdf_export.render_rows_pdf(
            title, request.columns, request.rows, request.meta, paper=request.paper,
        ),
        title,
        "pdf/rows",
    )
    return _pdf_response(pdf, title, "table")

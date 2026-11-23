"""Acceptance test for the offline MedOS PDF export overlay.

Run with the bundled MedOS Python:

    $env:PYTHONDONTWRITEBYTECODE="1"
    $env:PYTHONPATH="<workspace>\\pc\\backend;C:\\MedOS\\app\\backend"
    & "C:\\MedOS\\tools\\python\\python.exe" -B "<workspace>\\pc\\test-output\\test_pdf_export.py"
"""
from __future__ import annotations

import base64
import importlib.util
import io
import os
import sys
import tempfile
from pathlib import Path

import fitz
from fastapi import FastAPI
from fastapi.testclient import TestClient

_HERE = Path(__file__).resolve().parent
_PC_ROOT = _HERE.parent
sys.path[:0] = [str(_PC_ROOT / "backend"), r"C:\MedOS\app\backend"]

import pdf_export

_ROUTER_SPEC = importlib.util.spec_from_file_location(
    "medos_pdf_export_router", _PC_ROOT / "backend" / "routers" / "export.py"
)
if _ROUTER_SPEC is None or _ROUTER_SPEC.loader is None:
    raise RuntimeError("Could not load the export router overlay")
_ROUTER_MODULE = importlib.util.module_from_spec(_ROUTER_SPEC)
sys.modules[_ROUTER_SPEC.name] = _ROUTER_MODULE
_ROUTER_SPEC.loader.exec_module(_ROUTER_MODULE)
export_router = _ROUTER_MODULE.router


def _tiny_png_bytes() -> bytes:
    """A valid PNG, built with the bundled PyMuPDF engine."""
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 12, 12))
    pix.clear_with(255)
    pix.set_pixel(2, 2, (220, 40, 40))
    return pix.tobytes("png")


def _tiny_png_data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(_tiny_png_bytes()).decode()


def sample_questions(count: int = 40) -> list[dict]:
    questions = []
    for index in range(count):
        correct = 1 + (index % 4)
        questions.append(
            {
                "id": 1000 + index,
                "stem": f"Question {index + 1}: a patient presents with finding {index + 1}. What is the diagnosis?",
                "choices": [
                    f"Choice A{index + 1}",
                    f"Choice B{index + 1}",
                    f"Choice C{index + 1}",
                    f"Choice D{index + 1}",
                    f"Choice E{index + 1}",
                ],
                "correct": correct,
                "chosen": correct - 1 if index % 3 else (correct % 4),
                "explanation": f"Explanation {index + 1}: the correct answer is choice {correct} because of mechanism {index + 1}.",
                "subject": "Cardiology" if index % 2 else "Pulmonology",
                "system": "Cardiovascular" if index % 2 else "Respiratory",
                "tags": ["high-yield", f"topic-{index % 5}"],
            }
        )
    return questions


def assert_pdf(pdf: bytes, label: str, min_pages: int = 1) -> fitz.Document:
    assert pdf[:5] == b"%PDF-", f"{label}: missing %PDF magic"
    assert len(pdf) > 2_000, f"{label}: suspiciously small PDF ({len(pdf)} bytes)"
    doc = fitz.open(stream=pdf, filetype="pdf")
    assert doc.page_count >= min_pages, f"{label}: expected >= {min_pages} pages, got {doc.page_count}"
    return doc


def test_direct_renderers() -> None:
    topic = pdf_export.render_topic_pdf(
        "Test topic — Ünïcødé & Épreuve",
        subtitle="Offline acceptance test",
        html="<h2>Overview</h2><p>This topic contains <b>unicode</b>: α β γ, مرحبا, 日本語.</p>"
             "<ul><li>First point</li><li>Second point</li></ul>",
        meta={"source": "test", "paper": "A4"},
    )
    with assert_pdf(topic, "topic") as doc:
        text = "\n".join(page.get_text() for page in doc)
        assert "Test topic" in text, text[:500]
        assert "Overview" in text, text[:500]
        assert "First point" in text, text[:500]

    rows = pdf_export.render_rows_pdf(
        "Test table",
        ["Name", "Value"],
        [["Alpha", "1"], ["Beta", "2"], ["Gamma", "3"]],
    )
    with assert_pdf(rows, "rows") as doc:
        text = "\n".join(page.get_text() for page in doc)
        assert "Alpha" in text and "Gamma" in text, text[:500]

    qbank = pdf_export.render_qbank_pdf("Q-Bank acceptance", sample_questions())
    with assert_pdf(qbank, "qbank", min_pages=80) as doc:
        pages = [doc.load_page(index).get_text() for index in range(doc.page_count)]
        # Interleaved order: one question/choices page, then one answer page.
        for index in range(40):
            question_text = pages[index * 2]
            answer_text = pages[index * 2 + 1]
            assert f"Question {index + 1}\n" in question_text, question_text[:400]
            assert f"Choice A{index + 1}" in question_text, question_text[:400]
            assert f"Explanation {index + 1}" not in question_text, (
                f"explanation leaked onto question page {index + 1}"
            )
            assert f"Question {index + 1} — Answer" in answer_text, answer_text[:400]
            assert "Correct answer" in answer_text, answer_text[:400]
            assert f"Explanation {index + 1}" in answer_text, answer_text[:400]
            # Only the single correct choice is repeated on the answer page;
            # the full A–E list must stay on the question page.
            assert answer_text.count("Choice ") <= 1, (
                f"full choice list leaked onto answer page {index + 1}: {answer_text[:600]}"
            )
            if index == 0:
                assert "Subject:" in answer_text, answer_text[:800]

    rich = [{
        "id": 7,
        "stem": "plain stem",
        "stem_html": (
            "<p>What is shown?</p>"
            "<table><tr><th>Col A</th><th>Col B</th></tr>"
            "<tr><td>Val A</td><td>Val B</td></tr></table>"
        ),
        "choices": ["Alpha", "Beta"],
        "choices_html": ["<p><b>Alpha choice</b></p>", "<p>Beta choice</p>"],
        "correct": 1,
        "chosen": 0,
        "explanation": "plain explanation",
        "explanation_html": "<p>Explanation with <i>markup</i>.</p>",
        "media": [_tiny_png_data_url()],
        "explanation_media": [_tiny_png_data_url()],
        "subject": "Cardiology",
        "system": "Cardiovascular",
        "tags": ["high-yield"],
    }]
    rich_pdf = pdf_export.render_qbank_pdf("Rich Q-Bank", rich)
    with assert_pdf(rich_pdf, "rich qbank", min_pages=2) as doc:
        question_page = doc.load_page(0)
        answer_page = doc.load_page(1)
        question_text = question_page.get_text()
        answer_text = answer_page.get_text()
        assert "Col A" in question_text and "Val B" in question_text, question_text[:600]
        assert "Alpha choice" in question_text, question_text[:600]
        assert len(question_page.get_images(full=True)) >= 1, "question image missing"
        assert "Explanation with markup." in answer_text, answer_text[:600]
        assert len(answer_page.get_images(full=True)) >= 1, "explanation image missing"


def test_http_routes() -> None:
    app = FastAPI()
    app.include_router(export_router)
    client = TestClient(app)

    status = client.get("/export/pdf/status")
    assert status.status_code == 200, status.text
    assert status.json()["ok"] is True

    page = client.post(
        "/export/pdf/topic",
        json={"title": "HTTP topic", "html": "<h1>Topic</h1><p>Body text</p>"},
    )
    assert page.status_code == 200, page.text
    assert page.headers["content-type"].startswith("application/pdf")
    assert "attachment;" in page.headers.get("content-disposition", "")
    with assert_pdf(page.content, "http topic"):
        pass

    qbank = client.post(
        "/export/pdf/qbank",
        json={
            "title": "HTTP Q-Bank",
            "questions": [
                {
                    "id": 99,
                    "stem": "stem",
                    "stem_html": "<p>HTTP stem</p><table><tr><th>T</th></tr><tr><td>V</td></tr></table>",
                    "choices": ["one", "two"],
                    "choices_html": ["<b>One</b>", "Two"],
                    "correct": 1,
                    "chosen": 0,
                    "explanation": "explanation",
                    "explanation_html": "<p>HTTP explanation</p>",
                    "media": [_tiny_png_data_url()],
                    "subject": "Test",
                }
            ],
        },
    )
    assert qbank.status_code == 200, qbank.text
    with assert_pdf(qbank.content, "http qbank", min_pages=2) as doc:
        question_text = doc.load_page(0).get_text()
        answer_text = doc.load_page(1).get_text()
        assert "HTTP stem" in question_text and "T\nV" in question_text, question_text[:500]
        assert len(doc.load_page(0).get_images(full=True)) >= 1
        assert "HTTP explanation" in answer_text, answer_text[:500]

    bad = client.post("/export/pdf/page", json={"title": "empty"})
    assert bad.status_code == 400, bad.text


def test_qbank_visual_resolution() -> None:
    """Exhibits (tables) and <a>/<img> media refs must be embedded server-side.

    Real Q-Bank figures live at /qbank/exhibit/{id} (iframe HTML) and as
    /qbank/media/{qid}/{name} anchors — not as plain <img> tags. We stub the
    qbank_reader helpers so this test needs no shipped question databases.
    """
    png = _tiny_png_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        media_path = Path(tmp) / "fig.png"
        media_path.write_bytes(png)

        class FakeReader:
            def _resolve_qbank_media_path(self, db, qid, name):
                return media_path if name.lower() == "fig.png" else None

            def _decrypt_media(self, name, data):
                return data

            def _exhibit_html(self, db, exhibit_id):
                return (
                    123,
                    "<table><tr><th>Exhibit Col</th></tr>"
                    "<tr><td>Exhibit Val</td></tr></table>"
                    "<img src='/qbank/media/123/fig.png' alt='Exhibit image'/>",
                )

        previous = _ROUTER_MODULE._reader_module
        _ROUTER_MODULE._reader_module = FakeReader()
        try:
            enriched = _ROUTER_MODULE.enrich_qbank_questions([{
                "stem_html": (
                    "<p>See <a href='/qbank/media/123/fig.png'>Figure A</a> and "
                    "<a href='/qbank/exhibit/987654?srcqid=1'>Table Exhibit</a>.</p>"
                ),
                "choices_html": [],
                "explanation_html": "",
                "media": ["/qbank/media/123/fig.png"],  # duplicate: must not double-append
                "explanation_media": [],
                "db": "step2",
            }])
            item = enriched[0]
            assert item["stem_html"].count("data:image/png;base64,") == 2, item["stem_html"][:800]
            assert "Exhibit Col" in item["stem_html"]
            assert item["media"] == []

            app = FastAPI()
            app.include_router(export_router)
            client = TestClient(app)
            response = client.post("/export/pdf/qbank", json={
                "title": "Visual Q-Bank",
                "questions": [{
                    "id": 1,
                    "stem": "stem",
                    "stem_html": (
                        "<p><a href='/qbank/media/123/fig.png'>Figure A</a></p>"
                        "<p><a href='/qbank/exhibit/987654?srcqid=1'>Table Exhibit</a></p>"
                    ),
                    "choices": ["one", "two"],
                    "correct": 1,
                    "explanation": "explanation",
                    "media": ["/qbank/media/123/fig.png"],
                    "db": "step2",
                }],
            })
            assert response.status_code == 200, response.text
            assert "exhibits=1" in response.headers.get("X-Medos-Visual-Embeds", "")
            with assert_pdf(response.content, "visual qbank", min_pages=2) as doc:
                text = doc.load_page(0).get_text()
                assert "Figure A" in text, text[:600]
                assert "Table Exhibit" in text, text[:600]
                assert "Exhibit Col" in text and "Exhibit Val" in text, text[:600]
                assert len(doc.load_page(0).get_images(full=True)) >= 2, (
                    "expected media image + exhibit image in the PDF"
                )
        finally:
            _ROUTER_MODULE._reader_module = previous


def test_frontend_snake_case_mapping() -> None:
    """The browser sends camelCase; the backend model accepts snake_case only."""
    source = (_PC_ROOT / "lib" / "exportPdf.ts").read_text(encoding="utf-8")
    for needle in (
        "stem_html: question.stemHtml",
        "choices_html: question.choicesHtml",
        "explanation_html: question.explanationHtml",
        "explanation_media: question.explanationMedia",
    ):
        assert needle in source, f"missing camelCase-to-snake_case mapping: {needle}"


def test_qbank_hydration_from_authoritative_bank() -> None:
    """Saved/compacted exam sessions must regain tables and figures at export."""
    png = _tiny_png_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        media_path = Path(tmp) / "fig.png"
        media_path.write_bytes(png)
        media_url = "/qbank/media/321/fig.png"

        class FakeConn:
            def close(self) -> None:
                pass

        class HydratingReader:
            def _conn(self, db):
                return FakeConn()

            def _fetch_full_question(self, conn, qid, db):
                assert qid == 321
                return {
                    "id": qid,
                    "stem": "Hydrated stem plain",
                    "stem_html": (
                        "<p>Hydrated stem</p>"
                        "<table><tr><th>Stem Col</th></tr><tr><td>Stem Val</td></tr></table>"
                    ),
                    "choices": ["Choice One", "Choice Two"],
                    "choices_html": ["<b>Choice One</b>", "Choice Two"],
                    "correct": 1,
                    "explanation": "Hydrated explanation plain",
                    "explanation_html": (
                        "<p>Hydrated explanation</p>"
                        "<table><tr><th>Expl Col</th></tr><tr><td>Expl Val</td></tr></table>"
                        f"<img src='{media_url}' alt='Figure'/>"
                    ),
                    "media": [{"name": "fig.png", "url": media_url}],
                    "explanation_media": [{"name": "fig.png", "url": media_url}],
                    "subject": "Hydrated subject",
                    "system": "Hydrated system",
                    "tags": ["hydrated"],
                }

            def _resolve_qbank_media_path(self, db, qid, name):
                return media_path if name.lower() == "fig.png" else None

            def _decrypt_media(self, name, data):
                return data

        previous = _ROUTER_MODULE._reader_module
        _ROUTER_MODULE._reader_module = HydratingReader()
        _ROUTER_MODULE._HYDRATION_CACHE.clear()
        try:
            app = FastAPI()
            app.include_router(export_router)
            client = TestClient(app)
            response = client.post("/export/pdf/qbank", json={
                "title": "Saved session export",
                "questions": [{
                    "id": 321,
                    "stem": "Stripped stem",
                    "choices": ["Choice One", "Choice Two"],
                    "correct": 1,
                    "explanation": "Stripped explanation",
                    "db": "step2",
                }],
            })
            assert response.status_code == 200, response.text
            header = response.headers.get("X-Medos-Visual-Embeds", "")
            assert "hydrated=1" in header, header
            # The same figure appears inline and in explanation_media; it is
            # decoded/embedded once and reused, so the counter is 1, not 2.
            assert "media=1" in header, header
            with assert_pdf(response.content, "hydrated qbank", min_pages=2) as doc:
                question_text = doc.load_page(0).get_text()
                answer_text = doc.load_page(1).get_text()
                assert "Hydrated stem" in question_text, question_text[:600]
                assert "Stem Col" in question_text and "Stem Val" in question_text, question_text[:600]
                assert len(doc.load_page(0).get_images(full=True)) >= 1, "declared media image missing"
                assert "Hydrated explanation" in answer_text, answer_text[:600]
                assert "Expl Col" in answer_text and "Expl Val" in answer_text, answer_text[:600]
                assert len(doc.load_page(1).get_images(full=True)) >= 1, "inline explanation image missing"
                assert "Stripped stem" not in question_text
                assert "Stripped explanation" not in answer_text
        finally:
            _ROUTER_MODULE._reader_module = previous
            _ROUTER_MODULE._HYDRATION_CACHE.clear()


def test_large_embedded_image_is_not_dumped_as_text() -> None:
    """A clipped base64 `src` must never be printed onto PDF pages.

    Regression: a 30-question real session had a 693 KB enriched explanation.
    The old plain-character cap cut it inside a data URL; Story then rendered
    the unterminated `<img src="data:...">` tag as ~70 pages of random letters.
    """
    import random

    width, height = 600, 500
    rng = random.Random(7)
    samples = rng.randbytes(width * height * 3)
    pix = fitz.Pixmap(fitz.csRGB, width, height, samples, 0)
    data_url = "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")
    assert len(data_url) > 600_000, len(data_url)  # larger than the old 500k clip

    html = (
        "<p>Before the image</p>"
        f'<p><img src="{data_url}" alt="Large image"/></p>'
        "<p>After the image</p>"
    )
    pdf = pdf_export.render_qbank_pdf("Large image regression", [{
        "id": 9001,
        "stem": "Short stem",
        "choices": ["Choice A", "Choice B"],
        "correct": 1,
        "explanation": "Short explanation",
        "explanation_html": html,
    }])
    with assert_pdf(pdf, "large embedded image", min_pages=2) as doc:
        text = "\n".join(page.get_text() for page in doc)
        assert "<img" not in text, text[:600]
        assert "data:image" not in text, text[:600]
        assert "base64" not in text, text[:600]
        assert "Before the image" in text and "After the image" in text, text[:600]
        assert doc.page_count <= 12, f"base64 leak inflated the export to {doc.page_count} pages"
        assert any(page.get_images(full=True) for page in doc), "embedded figure was not drawn"


def test_inline_figure_at_page_boundary_keeps_full_explanation() -> None:
    """An inline figure at a page boundary must not truncate the explanation.

    Regression: a real ped-cardio Q1 had a data-URL figure inside a paragraph.
    With the answer subtitle present, the figure became the first item on a new
    page; Story drew the image and one trailing sentence, then silently dropped
    the rest of the answer ((Choice B), (Choice C), (Choice E), educational
    objective). Deferring figures to the end of each rich-text field keeps all
    prose before the images and restores the missing explanation.
    """

    def png_data_url(width: int, height: int) -> str:
        pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, width, height))
        pix.clear_with(255)
        return "data:image/png;base64," + base64.b64encode(pix.tobytes("png")).decode("ascii")

    # Same intrinsic aspect ratios as the two figures in the real question.
    first = png_data_url(700, 414)
    second = png_data_url(700, 445)
    filler = " ".join(f"word{index}" for index in range(200))
    html = (
        f'<p><img src="{first}" alt="First image" width="480"/></p>'
        f"<p>{filler} Before the figure, keep this sentence. "
        f'<figure><img src="{second}" alt="Boundary image" width="480"/>'
        "<figcaption>Boundary image</figcaption></figure> "
        "AFTER_IMAGE_MARKER_ONE beta gamma delta.</p>"
        "<p>AFTER_IMAGE_MARKER_TWO epsilon zeta eta theta.</p>"
        "<p>Educational objective: preserve all trailing prose.</p>"
    )
    markers = (
        "AFTER_IMAGE_MARKER_ONE",
        "AFTER_IMAGE_MARKER_TWO",
        "Educational objective",
    )
    question = {
        "id": 4242,
        "stem": "Short stem",
        "choices": ["Choice A", "Choice B"],
        "correct": 1,
        "explanation": "fallback",
        "explanation_html": html,
    }

    deferred = pdf_export._defer_inline_images(html)
    assert deferred.count("<figure>") == 2, deferred[-800:]
    assert deferred.index("AFTER_IMAGE_MARKER_ONE") < deferred.index("<figure>")

    # Confirm the synthetic layout still reproduces the original Story bug when
    # images are left inline; this keeps the test honest if layout changes.
    original = pdf_export._defer_inline_images
    pdf_export._defer_inline_images = lambda value: value
    try:
        broken_pdf = pdf_export.render_qbank_pdf(
            "Boundary regression", [dict(question)], {"source": "test"}
        )
    finally:
        pdf_export._defer_inline_images = original
    with assert_pdf(broken_pdf, "inline boundary image (unfixed)", min_pages=2) as doc:
        broken_text = "\n".join(page.get_text() for page in doc)
    assert "AFTER_IMAGE_MARKER_TWO" not in broken_text, (
        "synthetic layout no longer reproduces the page-boundary truncation"
    )
    assert "Educational objective" not in broken_text, (
        "synthetic layout no longer reproduces the page-boundary truncation"
    )

    pdf = pdf_export.render_qbank_pdf(
        "Boundary regression", [question], {"source": "test"}
    )
    with assert_pdf(pdf, "deferred boundary image", min_pages=2) as doc:
        text = "\n".join(page.get_text() for page in doc)
        for marker in markers:
            assert marker in text, f"{marker} missing from PDF text: {text[-1200:]}"
        assert "Boundary image" in text, text[-1200:]
        assert "data:image" not in text and "base64" not in text, text[:600]
        assert any(page.get_images(full=True) for page in doc), "figures were not drawn"
        assert doc.page_count <= 8, f"unexpected page inflation: {doc.page_count}"


def test_qbank_image_budget_is_per_question() -> None:
    """A 30-question block must not lose figures after the first 16.

    Regression: the old session-wide cap of 16 images turned every later
    figure into `[Image: ... omitted (image cap)]` even when each question had
    fewer than two images.
    """
    png = _tiny_png_bytes()
    with tempfile.TemporaryDirectory() as tmp:
        media: dict[tuple[int, str], Path] = {}
        for qid in (101, 202):
            for index in range(10):
                name = f"fig-{index}.png"
                path = Path(tmp) / f"{qid}-{name}"
                path.write_bytes(png)
                media[(qid, name)] = path

        class FakeReader:
            def _resolve_qbank_media_path(self, db, qid, name):
                return media.get((qid, name))

            def _decrypt_media(self, name, data):
                return data

        previous = _ROUTER_MODULE._reader_module
        _ROUTER_MODULE._reader_module = FakeReader()
        try:
            questions = []
            for qid in (101, 202):
                links = "".join(
                    f"<a href='/qbank/media/{qid}/fig-{index}.png'>Figure {index}</a>"
                    for index in range(10)
                )
                questions.append({
                    "id": qid,
                    "stem_html": f"<p>{links}</p>",
                    "choices_html": [],
                    "explanation_html": "",
                    "media": [],
                    "db": "step2",
                })
            enriched = _ROUTER_MODULE.enrich_qbank_questions(questions)
            assert len(enriched) == 2
            for item in enriched:
                html = item["stem_html"]
                assert html.count("data:image/png;base64,") == 10, html[:800]
                assert "omitted" not in html, html[:800]
                assert "not embedded" not in html, html[:800]
        finally:
            _ROUTER_MODULE._reader_module = previous


def test_html_clip_and_data_url_validation() -> None:
    """Truncation drops incomplete tags; partial base64 is rejected outright."""
    clipped = pdf_export._clip_html_safe(
        '<p>keep</p><img src="data:image/png;base64,' + "A" * 1000,
        200,
    )
    assert "<p>keep</p>" in clipped, clipped
    assert "<img" not in clipped, clipped

    url = _tiny_png_data_url()
    assert pdf_export._valid_data_url(url)
    assert not pdf_export._valid_data_url(url[:-3])  # broken base64 padding
    assert not pdf_export._valid_data_url("https://example.com/fig.png")


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    workspace_pc = here.parent
    backend = workspace_pc / "backend"
    sys.path[:0] = [str(backend), r"C:\MedOS\app\backend"]
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

    for source in [
        backend / "pdf_export.py",
        backend / "routers" / "export.py",
        backend / "main.py",
    ]:
        compile(source.read_text(encoding="utf-8"), str(source), "exec")
        print("syntax OK:", source.relative_to(workspace_pc))

    test_direct_renderers()
    print("direct PDF renderers OK")
    test_http_routes()
    print("FastAPI export routes OK")
    test_qbank_visual_resolution()
    print("Q-Bank exhibit/media embedding OK")
    test_frontend_snake_case_mapping()
    print("frontend camelCase-to-snake_case mapping OK")
    test_qbank_hydration_from_authoritative_bank()
    print("Q-Bank authoritative hydration OK")
    test_large_embedded_image_is_not_dumped_as_text()
    print("large embedded image text-leak regression OK")
    test_inline_figure_at_page_boundary_keeps_full_explanation()
    print("inline figure page-boundary regression OK")
    test_qbank_image_budget_is_per_question()
    print("Q-Bank per-question image budget OK")
    test_html_clip_and_data_url_validation()
    print("HTML clip / data URL validation OK")
    print("ALL PDF EXPORT TESTS PASSED")

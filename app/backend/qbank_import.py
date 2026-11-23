"""PDF → native MedOS Q-Bank importer.

Turns an arbitrary question-bank PDF into a bank that behaves exactly like the
shipped UWorld / AMBOSS / MKSAP banks:

  * ``analyze_pdf`` parses the PDF (text + images) into a cached JSON document
    and returns a preview — counts, samples, warnings — without touching the
    live catalog.
  * ``build_bank`` renders that cached document into the unified MedOS SQLite
    schema (Questions / Answers / Subjects / Systems / Search) plus a plaintext
    ``media-E`` folder, writes an ``imported.json`` sidecar and registers the
    bank with :mod:`qbank_reader`.

The PDF layout is heuristic by design, because "a q-bank PDF" is not a format.
Every recognised signal is reported in ``warnings`` so the preview can show
what was understood before the user commits to a build.

Layout handled:
  * numbered questions (``12.``, ``Q12``, ``Question 12``, ``[12]``)
  * choices ``A.`` / ``A)`` / ``(A)`` / ``A -`` including inline ``A. x B. y``
  * answers ``Answer: B`` / ``Correct answer is (C)`` / an answer-key section
  * explanations ``Explanation:`` / ``Rationale:`` / ``Discussion:``
  * ids, topics, subjects, systems, references and tags
  * figures placed in the stem, a choice or the explanation by their PDF
    position, so no image is dropped or attached to the wrong question
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import shutil
import sqlite3
import sys
import threading
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from config import IMPORTED_QBANK_ROOT, ROOT

try:  # PyMuPDF is a hard dependency, but keep import failures readable.
    import fitz  # type: ignore
except Exception:  # pragma: no cover - exercised only on a broken install
    fitz = None  # type: ignore


PLAIN_PREFIX = "medos-plain:"
CACHE_DIR = ROOT / "data" / ".cache" / "qbank-import"
CACHE_TTL_SECONDS = 14 * 24 * 3600

MAX_PAGES = 5000
MAX_CHOICES = 8


# ── small helpers ───────────────────────────────────────────────────────────

_RE_WS = re.compile(r"[ \t\u00a0]+")


def _clean(value: str | None) -> str:
    return _RE_WS.sub(" ", (value or "").replace("\r", " ")).strip()


def _slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value or "").strip("-").lower()
    return (slug or "bank")[:48]


def _dir_bytes(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def _require_fitz() -> None:
    if fitz is None:
        raise ValueError(
            "PyMuPDF is not installed for this MedOS Python. "
            f"Install it with: \"{sys.executable}\" -m pip install PyMuPDF"
        )


# ── PDF reading ─────────────────────────────────────────────────────────────

_Q_START_PATTERNS = (
    re.compile(r"^\s*(?:QUESTION|Question|question|Q)\s*(?:no\.?|number|#)?\s*[:\-–.]?\s*(\d{1,5})\b"),
    re.compile(r"^\s*(\d{1,5})\s*[.)\]:]\s*(?=\S)"),
    re.compile(r"^\s*\[\s*(\d{1,5})\s*\]\s*(?=\S)"),
)

_CHOICE_RE = re.compile(
    r"^\s*(?:\(\s*([A-Ha-h])\s*\)|([A-Ha-h])\s*[.)]|([A-Ha-h])\s*[–—\-]\s+)\s*(.*)$"
)
_INLINE_CHOICE_RE = re.compile(r"(?:^|(?<=\s))([A-H])[.)]\s+(?=\S)")

_ANSWER_RE = re.compile(
    r"^\s*(?:the\s+)?(?:correct\s+)?(?:answer|ans)\b\s*(?:is|was|:|=|\-|–|—)?\s*"
    r"(?:option|choice|letter)?\s*[\(\[]?\s*([A-Ha-h])\s*[\)\]]?(?![A-Za-z])",
    re.IGNORECASE,
)
_ANSWER_NUM_RE = re.compile(
    r"^\s*(?:the\s+)?(?:correct\s+)?(?:answer|ans)\b\s*(?:is|was|:|=|\-|–|—)?\s*"
    r"(?:option|choice)?\s*[\(\[]?\s*([1-8])\s*[\)\]]?\s*$",
    re.IGNORECASE,
)
_CORRECT_IS_RE = re.compile(
    r"correct\s+(?:answer|choice|option)\s*(?:is|was|:|=)?\s*(?:option|choice|letter)?\s*"
    r"[\(\[]?\s*([A-H])\s*[\)\]]?(?![A-Za-z])",
    re.IGNORECASE,
)

_EXPL_RE = re.compile(
    r"^\s*(?:answer\s+|full\s+|detailed\s+)?"
    r"(?:explanation|rationale|discussion|commentary|analysis|educational\s+objective|"
    r"key\s+point|pearl|takeaway)s?\b\s*[:\-–—]?\s*",
    re.IGNORECASE,
)

_TAG_RE = re.compile(
    r"^\s*(?P<key>Question\s*(?:ID|#)|QID|ID|Topic|Subject|System|Discipline|Category|"
    r"Specialty|Tag[s]?|Label|Learning\s+(?:Objective|Goal)|Reference[s]?|Source[s]?)\s*"
    r"[:\-–—]\s*(?P<value>.+)$",
    re.IGNORECASE,
)

_ANSWER_KEY_HEADING = re.compile(
    r"^\s*(?:answer\s*key|answers|correct\s*answers|answer\s*&\s*explanation\s*key|"
    r"quick\s*answer\s*key)\s*[:\-–—]?\s*$",
    re.IGNORECASE,
)

_REPEAT_IMAGE_MIN_PAGES = 5


def _qstart(text: str) -> Optional[tuple[int, int]]:
    """Return ``(number, end_offset)`` when ``text`` opens a new question."""
    for pattern in _Q_START_PATTERNS:
        m = pattern.match(text)
        if m:
            try:
                num = int(m.group(1))
            except (TypeError, ValueError):
                continue
            if 0 < num <= 50000:
                return num, m.end()
    return None


def _choice_marker(text: str) -> Optional[tuple[str, str]]:
    m = _CHOICE_RE.match(text)
    if not m:
        return None
    letter = (m.group(1) or m.group(2) or m.group(3) or "").upper()
    if not letter:
        return None
    return letter, _clean(m.group(4))


def _answer_marker(text: str) -> Optional[tuple[Optional[str], Optional[int]]]:
    m = _ANSWER_RE.match(text)
    if m:
        return m.group(1).upper(), None
    m = _ANSWER_NUM_RE.match(text)
    if m:
        return None, int(m.group(1))
    m = _CORRECT_IS_RE.search(text)
    if m:
        return m.group(1).upper(), None
    return None


def _answer_tail(text: str, marker: re.Match | None = None) -> str:
    """Text after the answer letter, e.g. ``Answer: B. Because …`` → ``Because …``."""
    for pattern in (_ANSWER_RE, _ANSWER_NUM_RE):
        m = pattern.match(text)
        if m:
            return _clean(text[m.end():]).lstrip(".:-–— ").strip()
    m = _CORRECT_IS_RE.search(text)
    if m:
        return _clean(text[m.end():]).lstrip(".:-–— ").strip()
    return ""


def _expl_marker(text: str) -> Optional[str]:
    """Return the trailing text for an explanation heading, or ``None``."""
    m = _EXPL_RE.match(text)
    if not m:
        return None
    label = _clean(text[:m.end()])
    tail = _clean(text[m.end():])
    # A bare "Explanation" heading switches region with no body text.
    if not tail and len(label) <= 40:
        return ""
    # "Discussion of the differential …" is prose, not a heading. Require a
    # short label (with or without a colon) for the marker to count.
    if len(label) > 60 and not re.search(r"[:\-–—]\s*$", label):
        return None
    return tail


def _split_inline_choices(text: str) -> Optional[list[tuple[str, str]]]:
    """Split ``A. one B. two C. three`` into a complete A..N choice list."""
    matches = list(_INLINE_CHOICE_RE.finditer(text))
    if not matches:
        return None
    segments: list[tuple[str, str]] = []
    head = _clean(text[: matches[0].start()]).strip(" ;,")
    if head:
        segments.append(("A", head))
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = _clean(text[match.end(): end]).strip(" ;,")
        if body:
            segments.append((match.group(1).upper(), body))
    if len(segments) < 2:
        return None
    letters = [s[0] for s in segments]
    if letters != [chr(ord("A") + i) for i in range(len(letters))]:
        return None
    return segments


def _page_items(page: Any, page_no: int) -> list[dict]:
    """Text lines and placed images for one page, in reading coordinates."""
    items: list[dict] = []
    try:
        data = page.get_text("dict")
    except Exception:
        data = {"blocks": []}
    for block in data.get("blocks") or []:
        if block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            spans = [span for span in line.get("spans") or [] if span.get("text")]
            if not spans:
                continue
            text = "".join(span.get("text") or "" for span in spans)
            if not text.strip():
                continue
            flags = 0
            for span in spans:
                flags |= int(span.get("flags") or 0)
            bbox = line.get("bbox") or block.get("bbox") or (0, 0, 0, 0)
            items.append({
                "kind": "line",
                "page": page_no,
                "x0": float(bbox[0]),
                "y0": float(bbox[1]),
                "x1": float(bbox[2]),
                "y1": float(bbox[3]),
                "text": _clean(text),
                "size": float(max((span.get("size") or 0.0) for span in spans)),
                "bold": bool(flags & 16) or any("bold" in (span.get("font") or "").lower() for span in spans),
                "italic": bool(flags & 2) or any(
                    "italic" in (span.get("font") or "").lower()
                    or "oblique" in (span.get("font") or "").lower()
                    for span in spans
                ),
            })
    try:
        infos = page.get_image_info(xrefs=True)
    except Exception:
        infos = []
    for info in infos or []:
        bbox = info.get("bbox")
        if not bbox:
            continue
        rect = fitz.Rect(bbox)
        if page.rotation:
            try:
                rect = rect * page.rotation_matrix
            except Exception:
                pass
        width, height = rect.width, rect.height
        if width < 60 or height < 40 or width * height < 6000:
            continue
        page_w, page_h = page.rect.width, page.rect.height
        if width > page_w * 0.96 and height > page_h * 0.96:
            continue
        if height <= 45 and (rect.y0 < 45 or rect.y1 > page_h - 45):
            continue  # header/footer rule or logo strip
        items.append({
            "kind": "image",
            "page": page_no,
            "x0": float(rect.x0),
            "y0": float(rect.y0),
            "x1": float(rect.x1),
            "y1": float(rect.y1),
            "xref": int(info.get("xref") or 0),
            "px_w": int(info.get("width") or 0),
            "px_h": int(info.get("height") or 0),
        })
    return items


def _column_split(lines: list[dict], page_width: float) -> Optional[float]:
    """Detect a clean two-column body; returns the split x or ``None``."""
    if len(lines) < 12 or page_width <= 0:
        return None
    centre = page_width / 2.0
    left = [line for line in lines if line["x1"] < centre + page_width * 0.06]
    right = [line for line in lines if line["x0"] > centre - page_width * 0.06]
    if len(left) < len(lines) * 0.3 or len(right) < len(lines) * 0.3:
        return None
    left_edge = max(line["x1"] for line in left)
    right_edge = min(line["x0"] for line in right)
    if left_edge >= right_edge:
        return None
    return (left_edge + right_edge) / 2.0


def _order_items(items: list[dict], page_width: float) -> list[dict]:
    split = _column_split([item for item in items if item["kind"] == "line"], page_width)
    if split is None:
        return sorted(items, key=lambda it: (it["page"], round(it["y0"], 1), it["x0"]))
    return sorted(
        items,
        key=lambda it: (
            it["page"],
            0 if ((it["x0"] + it["x1"]) / 2.0) < split else 1,
            round(it["y0"], 1),
            it["x0"],
        ),
    )


def _drop_repeated_images(items: list[dict], page_count: int) -> tuple[list[dict], int]:
    """Remove recurring logos/watermarks so every question keeps real figures."""
    counts: Counter = Counter()
    for item in items:
        if item["kind"] != "image":
            continue
        px = max(1, item.get("px_w") or 0) * max(1, item.get("px_h") or 0)
        if px > 500 * 500:
            continue
        key = ("xref", item.get("xref")) if item.get("xref") else (
            "box", round(item["x1"] - item["x0"]), round(item["y1"] - item["y0"])
        )
        counts[key] += 1
    threshold = max(_REPEAT_IMAGE_MIN_PAGES, int(page_count * 0.25))
    removed = 0
    kept: list[dict] = []
    for item in items:
        if item["kind"] != "image":
            kept.append(item)
            continue
        px = max(1, item.get("px_w") or 0) * max(1, item.get("px_h") or 0)
        if px > 500 * 500:
            kept.append(item)
            continue
        key = ("xref", item.get("xref")) if item.get("xref") else (
            "box", round(item["x1"] - item["x0"]), round(item["y1"] - item["y0"])
        )
        if counts[key] >= threshold:
            removed += 1
            continue
        kept.append(item)
    return kept, removed


def _read_pdf(path: Path, progress: Optional[Callable[[int, int], None]] = None) -> tuple[list[dict], int, list[str]]:
    _require_fitz()
    doc = fitz.open(str(path))
    try:
        if doc.needs_pass:
            raise ValueError("That PDF is password protected. Remove the password and try again.")
        total = doc.page_count
        if total <= 0:
            raise ValueError("That PDF has no pages.")
        if total > MAX_PAGES:
            raise ValueError(f"That PDF has {total:,} pages; the importer is limited to {MAX_PAGES:,}.")
        items: list[dict] = []
        warnings: list[str] = []
        for page_no in range(total):
            page = doc[page_no]
            page_items = _page_items(page, page_no)
            items.extend(_order_items(page_items, page.rect.width))
            if progress:
                progress(page_no + 1, total)
    finally:
        doc.close()

    removed = 0
    items, removed = _drop_repeated_images(items, total)
    if removed:
        warnings.append(f"Skipped {removed} repeated logo/watermark image(s).")
    if not any(item["kind"] == "line" for item in items):
        warnings.append(
            "No selectable text was found. This PDF is probably a scan; "
            "run OCR on it first, then import again."
        )
    return items, total, warnings


# ── segmentation ────────────────────────────────────────────────────────────

def _looks_like_toc_line(text: str) -> bool:
    """Dot leaders or a right-aligned page number mark a table of contents."""
    if re.search(r"(?:\.\s*){4,}\s*\d{1,5}\s*$", text or ""):
        return True
    return bool(re.search(r"\S\s{3,}\d{1,5}\s*$", text or ""))


def _section_signals(items: list[dict], start: int, stop: int) -> tuple[list[str], bool]:
    stop = min(stop, start + 320, len(items))
    letters: list[str] = []
    has_answer = False
    for idx in range(start + 1, stop):
        item = items[idx]
        if item["kind"] != "line":
            continue
        marker = _choice_marker(item["text"])
        if marker:
            inline = _split_inline_choices(marker[1]) if marker[1] else None
            if inline:
                letters.extend(letter for letter, _ in inline)
            else:
                letters.append(marker[0])
        if _answer_marker(item["text"]):
            has_answer = True
        if len(letters) >= 8 and has_answer:
            break
    return letters, has_answer


def _segment(items: list[dict]) -> tuple[list[tuple[int, int]], list[str]]:
    """Return ``[(start_index, question_number)]`` for the real question bodies."""
    candidates: list[tuple[int, int]] = []
    for idx, item in enumerate(items):
        if item["kind"] != "line":
            continue
        parsed = _qstart(item["text"])
        if parsed and not _looks_like_toc_line(item["text"]):
            candidates.append((idx, parsed[0]))
    if not candidates:
        return [], ["No numbered questions were detected. The PDF may use a different layout."]

    deltas = Counter(
        num - prev
        for (_, prev), (_, num) in zip(candidates, candidates[1:])
        if 0 < num - prev <= 50
    )
    step = deltas.most_common(1)[0][0] if deltas else 1

    accepted: list[tuple[int, int]] = []
    for pos, (idx, num) in enumerate(candidates):
        next_idx = candidates[pos + 1][0] if pos + 1 < len(candidates) else len(items)
        letters, has_answer = _section_signals(items, idx, next_idx)
        if len(letters) < 2:
            continue
        if accepted:
            last_idx, last_num = accepted[-1]
            contiguous = num in (last_num + 1, last_num + step)
            small_gap = 0 < num - last_num <= 6
            reset = num <= 3 and idx - last_idx > 30
            if reset and not (has_answer and letters[0] == "A"):
                continue
            if not (contiguous or small_gap or reset):
                continue
        accepted.append((idx, num))
    if len(accepted) < 2:
        return accepted, ["Only one question-like block was recognised; check the preview carefully."]
    return accepted, []


def _parse_answer_key(items: list[dict]) -> tuple[dict[int, str], Optional[int]]:
    """Read a trailing ``Answer Key`` table into ``{question_number: letter}``.

    Returns the map and the item index where the key starts (so the key is not
    swallowed by the last question's explanation).
    """
    start = None
    for idx, item in enumerate(items):
        if item["kind"] != "line":
            continue
        if _ANSWER_KEY_HEADING.match(item["text"]):
            start = idx
            break
    if start is None or start < len(items) * 0.5:
        return {}, None
    text = " ".join(
        item["text"] for item in items[start + 1:] if item["kind"] == "line"
    )
    key: dict[int, str] = {}
    for match in re.finditer(
        r"(?<![\w])(\d{1,5})\s*[.):\-–]?\s*[\(\[]?\s*([A-H])\s*[\)\]]?(?![\w])", text
    ):
        try:
            num = int(match.group(1))
        except ValueError:
            continue
        if 0 < num <= 50000:
            key.setdefault(num, match.group(2).upper())
    if len(key) < 3:
        return {}, None
    return key, start


# ── question assembly ───────────────────────────────────────────────────────

class _Parts:
    """Ordered text/image fragments for one region (stem, choice, explanation)."""

    __slots__ = ("fragments", "last_item", "size")

    def __init__(self) -> None:
        self.fragments: list[Any] = []
        self.last_item: Optional[dict] = None
        self.size = 11.0

    def text(self, value: str, item: Optional[dict] = None, new_para: bool = False) -> None:
        value = _clean(value)
        if not value:
            return
        if self.fragments and isinstance(self.fragments[-1], str):
            prev = self.fragments[-1]
            if new_para:
                joiner = "\n\n"
            elif prev.endswith("-") and value[:1].islower():
                self.fragments[-1] = prev[:-1]
                joiner = ""
            elif prev.endswith((" ", "\n")):
                joiner = ""
            else:
                joiner = " "
            self.fragments[-1] = prev + joiner + value
        else:
            self.fragments.append(value)
        if item is not None:
            self.last_item = item
            self.size = item.get("size") or self.size

    def image(self, item: dict) -> None:
        self.fragments.append({"img": {
            "page": item["page"],
            "bbox": [item["x0"], item["y0"], item["x1"], item["y1"]],
            "xref": item.get("xref") or 0,
        }})

    def has_text(self) -> bool:
        return any(isinstance(fragment, str) and fragment.strip() for fragment in self.fragments)

    def has_any(self) -> bool:
        return bool(self.fragments) and (self.has_text() or any(isinstance(f, dict) for f in self.fragments))

    def plain(self) -> str:
        out: list[str] = []
        for fragment in self.fragments:
            if isinstance(fragment, str):
                out.append(fragment)
            else:
                out.append(" [image] ")
        text = "".join(out)
        text = re.sub(r"-\s*\n\s*(?=[a-z])", "", text)
        lines = [_clean(line) for line in text.split("\n")]
        text = "\n".join(line for line in lines if line)
        return re.sub(r"\n{3,}", "\n\n", text).strip()


def _gap(previous: Optional[dict], current: dict) -> bool:
    if previous is None:
        return False
    if previous["page"] != current["page"]:
        return True
    return current["y0"] - previous["y1"] > max(4.0, (current.get("size") or 11.0) * 0.55)


_SUBJECT_KEYS = ("subject", "discipline", "specialty", "category", "label")
_SYSTEM_KEYS = ("system", "topic")


def _tag_value(tags: dict[str, str], keys: Iterable[str]) -> str:
    for key in keys:
        value = _clean(tags.get(key))
        if value:
            return value
    return ""


_SYSTEM_KEYWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Cardiology", ("heart", "cardiac", "myocardial", "coronary", "ecg", "angina", "hypertension", "aortic", "valve", "arrhythm", "atrial", "ventricle")),
    ("Pulmonology", ("lung", "pulmonary", "respiratory", "asthma", "copd", "pneumonia", "pleural", "dyspnea", "hypoxemia", "ventilation")),
    ("Gastroenterology", ("liver", "hepatic", "gastro", "intestin", "colon", "bowel", "pancrea", "esophag", "stomach", "cirrhosis", "jaundice")),
    ("Nephrology", ("kidney", "renal", "nephro", "urine", "creatinine", "glomerul", "electrolyte", "acidosis", "dialys")),
    ("Endocrinology", ("thyroid", "diabetes", "insulin", "adrenal", "pituitary", "hormone", "cushing", "calcium", "glucose")),
    ("Hematology", ("anemia", "hemoglobin", "platelet", "coagul", "bleeding", "lymphoma", "leukemia", "sickle", "thromb")),
    ("Oncology", ("tumor", "cancer", "carcinoma", "metasta", "chemotherap", "neoplas")),
    ("Infectious Disease", ("infection", "fever", "bacteria", "viral", "antibiotic", "hiv", "tubercul", "sepsis", "fungal")),
    ("Neurology", ("brain", "neuro", "seizure", "stroke", "headache", "cranial", "spinal", "myelin", "dementia")),
    ("Psychiatry", ("depress", "anxiety", "psycho", "bipolar", "schizophren", "suicid", "mania")),
    ("Rheumatology", ("joint", "arthritis", "lupus", "vasculitis", "rheumat", "autoimmune", "scleroderma")),
    ("Dermatology", ("skin", "rash", "lesion", "dermat", "melanoma", "urticaria")),
    ("Obstetrics & Gynecology", ("pregnan", "uterus", "ovary", "vaginal", "menstrua", "delivery", "fetal", "obstetric", "gynec")),
    ("Pediatrics", ("child", "infant", "neonat", "pediatric", "adolescent")),
    ("Surgery", ("surgical", "operation", "postoperative", "trauma", "hernia", "appendicitis")),
    ("Genetics", ("gene", "genetic", "chromosome", "mutation", "inheritance")),
    ("Biostatistics", ("sensitivity", "specificity", "odds ratio", "confidence interval", "p-value", "study design", "prevalence")),
)


def _infer_system(text: str) -> str:
    lowered = f" {text.lower()} "
    best = ""
    best_hits = 0
    for name, keywords in _SYSTEM_KEYWORDS:
        hits = sum(1 for keyword in keywords if keyword in lowered)
        if hits > best_hits:
            best, best_hits = name, hits
    return best if best_hits >= 2 else ""


def _normalize_system(value: str) -> str:
    """``Cardiology > Heart Failure`` → ``Cardiology (Heart Failure)``.

    Downstream filters split the parenthetical into a topic, so imported banks
    get the same System / Topic grouping as the shipped ones.
    """
    value = _clean(value)
    parts = re.split(r"\s*(?:>|::|\u203a)\s*", value, maxsplit=1)
    if len(parts) == 2 and parts[0] and parts[1]:
        return f"{parts[0]} ({parts[1]})"
    return value


def _system_parent(value: str) -> str:
    return _clean(re.sub(r"\s*\([^)]*\)\s*$", "", value or ""))


def _parse_section(
    items: list[dict],
    start: int,
    stop: int,
    number: int,
    answer_key: dict[int, str],
) -> Optional[dict]:
    stem = _Parts()
    explanation = _Parts()
    choices: list[dict] = []
    tags: dict[str, str] = {}
    refs: list[str] = []
    region = "stem"
    previous: Optional[dict] = None
    choice_indent: Optional[float] = None
    answer_letter: Optional[str] = None
    answer_number: Optional[int] = None
    source_id = ""

    first = items[start]
    prefix_len = 0
    if first["kind"] == "line":
        parsed = _qstart(first["text"])
        prefix_len = parsed[1] if parsed else 0

    for idx in range(start, stop):
        item = items[idx]
        if item["kind"] == "image":
            if region == "stem":
                stem.image(item)
            elif region == "choices" and choices:
                choices[-1]["parts"].image(item)
            else:
                explanation.image(item)
            previous = item
            continue

        text = item["text"]
        if idx == start and prefix_len:
            text = text[prefix_len:].strip()
            if not text:
                previous = item
                continue

        tag = _TAG_RE.match(text)
        if tag:
            key = re.sub(r"\s+", " ", tag.group("key").strip().lower())
            value = _clean(tag.group("value"))[:400]
            if key in ("question id", "question #", "qid", "id"):
                source_id = value[:80]
            elif key.startswith("reference") or key.startswith("source"):
                if 4 <= len(value) <= 400:
                    refs.append(value)
            else:
                tags.setdefault(key, value[:200])
            previous = item
            continue

        answer = _answer_marker(text)
        if answer and region in ("stem", "choices", "explanation"):
            letter, numeric = answer
            if letter:
                answer_letter = letter
            if numeric:
                answer_number = numeric
            tail = _answer_tail(text)
            region = "explanation"
            if tail:
                explanation.text(tail, item, new_para=_gap(previous, item))
            previous = item
            continue

        marker = _expl_marker(text)
        if marker is not None:
            region = "explanation"
            if marker:
                explanation.text(marker, item, new_para=_gap(previous, item))
            previous = item
            continue

        if region in ("stem", "choices"):
            choice = _choice_marker(text)
            if choice:
                letter, rest = choice
                expected = chr(ord("A") + len(choices)) if choices else "A"
                if letter == expected:
                    expanded = _split_inline_choices(rest) if rest else None
                    if expanded:
                        for seg_letter, seg_text in expanded:
                            parts = _Parts()
                            parts.text(seg_text, item)
                            choices.append({"letter": seg_letter, "parts": parts})
                    else:
                        parts = _Parts()
                        if rest:
                            parts.text(rest, item)
                        choices.append({"letter": letter, "parts": parts})
                    if choice_indent is None:
                        choice_indent = item["x0"]
                    region = "choices"
                    previous = item
                    continue

        new_para = _gap(previous, item)
        if region == "stem":
            stem.text(text, item, new_para)
        elif region == "choices" and choices:
            if choice_indent is not None and item["x0"] < choice_indent - 6 and len(text) > 45:
                region = "explanation"
                explanation.text(text, item, new_para=True)
            else:
                choices[-1]["parts"].text(text, item, new_para)
        else:
            explanation.text(text, item, new_para)
        previous = item

    # Trim trailing choices with no text and no image.
    while choices and not choices[-1]["parts"].has_any():
        choices.pop()
    if len(choices) < 2:
        return None

    letters = [c["letter"] for c in choices]
    explanation_text = explanation.plain()
    stem_text = stem.plain()

    correct = 0
    if answer_letter and answer_letter in letters:
        correct = letters.index(answer_letter) + 1
    elif answer_number and 1 <= answer_number <= len(choices):
        correct = answer_number
    if not correct and answer_key.get(number) in letters:
        correct = letters.index(answer_key[number]) + 1
    if not correct:
        found = _CORRECT_IS_RE.search(explanation_text) or _CORRECT_IS_RE.search(stem_text)
        if found and found.group(1).upper() in letters:
            correct = letters.index(found.group(1).upper()) + 1

    subject = _tag_value(tags, _SUBJECT_KEYS)
    system = _normalize_system(_tag_value(tags, _SYSTEM_KEYS))
    if not system:
        system = _infer_system(f"{stem_text} {explanation_text}") or "General"
    if not subject:
        parent = _system_parent(system)
        subject = parent if parent and parent != "General" else "Imported Q-Bank"

    title = _clean(tags.get("topic") or tags.get("label") or tags.get("subject") or "")[:120]
    if not title:
        title = f"Question {number}"

    return {
        "number": number,
        "source_id": source_id or str(number),
        "stem": stem_text,
        "stem_parts": stem.fragments,
        "explanation": explanation_text,
        "explanation_parts": explanation.fragments,
        "choices": [
            {
                "letter": choice["letter"],
                "text": choice["parts"].plain(),
                "parts": choice["parts"].fragments,
            }
            for choice in choices
        ],
        "correct": correct,
        "subject": subject[:160],
        "system": system[:160],
        "title": title,
        "tags": {key: value[:200] for key, value in tags.items()},
        "refs": [ref[:400] for ref in refs[:8]],
        "has_images": any(
            isinstance(fragment, dict)
            for fragment in [
                *stem.fragments,
                *explanation.fragments,
                *[fragment for choice in choices for fragment in choice["parts"].fragments],
            ]
        ),
    }


def _analyze_items(items: list[dict], page_count: int) -> tuple[list[dict], list[str], dict]:
    answer_key, key_start = _parse_answer_key(items)
    body = items[:key_start] if key_start is not None else items
    starts, warnings = _segment(body)
    if len(answer_key) < max(3, int(len(starts) * 0.3)):
        answer_key = {}
    questions: list[dict] = []
    skipped = 0
    for position, (start, number) in enumerate(starts):
        stop = starts[position + 1][0] if position + 1 < len(starts) else len(body)
        parsed = _parse_section(body, start, stop, number, answer_key)
        if parsed is None:
            skipped += 1
            continue
        questions.append(parsed)

    if not questions:
        warnings.append(
            "No complete question blocks were recognised. The preview shows what the "
            "parser found so the layout can be checked before trying again."
        )
    if skipped:
        warnings.append(f"{skipped} numbered block(s) had fewer than two answer choices and were skipped.")

    no_answer = sum(1 for q in questions if not q["correct"])
    if no_answer:
        warnings.append(
            f"{no_answer} question(s) have no recognised correct answer. "
            "They are imported as drafts with the first choice marked correct so no question is lost."
        )
    no_explanation = sum(1 for q in questions if not q["explanation"])
    if no_explanation:
        warnings.append(f"{no_explanation} question(s) have no explanation text.")

    images = sum(
        1
        for question in questions
        for fragments in [question["stem_parts"], question["explanation_parts"],
                          *[choice["parts"] for choice in question["choices"]]]
        for fragment in fragments
        if isinstance(fragment, dict)
    )

    subjects = Counter(q["subject"] for q in questions)
    systems = Counter(q["system"] for q in questions)
    stats = {
        "pages": page_count,
        "questions": len(questions),
        "skipped_blocks": skipped,
        "choices": sum(len(q["choices"]) for q in questions),
        "with_explanations": sum(1 for q in questions if q["explanation"]),
        "with_answers": sum(1 for q in questions if q["correct"]),
        "assumed_answers": no_answer,
        "images": images,
        "answer_key_entries": len(answer_key),
        "subjects": len(subjects),
        "systems": len(systems),
        "avg_choices": round(
            (sum(len(q["choices"]) for q in questions) / len(questions)) if questions else 0.0, 2
        ),
    }
    return questions, warnings, stats


# ── analysis cache / job ────────────────────────────────────────────────────

_JOB_LOCK = threading.Lock()
_JOB: dict[str, Any] = {
    "running": False,
    "mode": None,
    "stage": "",
    "percent": 0.0,
    "error": None,
    "result": None,
    "started_at": None,
    "finished_at": None,
}


def status() -> dict:
    with _JOB_LOCK:
        return json.loads(json.dumps(_JOB))


def _begin(mode: str) -> bool:
    with _JOB_LOCK:
        if _JOB["running"]:
            return False
        _JOB.update({
            "running": True,
            "mode": mode,
            "stage": "Starting…",
            "percent": 0.0,
            "error": None,
            "result": None,
            "started_at": time.time(),
            "finished_at": None,
        })
        return True


def _stage(stage: str, percent: Optional[float] = None) -> None:
    with _JOB_LOCK:
        _JOB["stage"] = stage
        if percent is not None:
            _JOB["percent"] = max(0.0, min(100.0, percent))
        _JOB["finished_at"] = None


def _finish(result: Optional[dict] = None, error: Optional[str] = None) -> None:
    with _JOB_LOCK:
        _JOB.update({
            "running": False,
            "stage": "Done" if error is None else "Failed",
            "percent": 100.0 if error is None else _JOB.get("percent", 0.0),
            "result": result,
            "error": error,
            "finished_at": time.time(),
        })


def _spawn(mode: str, target: Callable[[], None]) -> dict:
    if not _begin(mode):
        return {"status": "busy"}
    thread = threading.Thread(target=target, name=f"qbank-import-{mode}", daemon=True)
    thread.start()
    return {"status": "started", "mode": mode}


def _cleanup_cache() -> None:
    if not CACHE_DIR.is_dir():
        return
    cutoff = time.time() - CACHE_TTL_SECONDS
    for child in CACHE_DIR.glob("*.json"):
        try:
            if child.stat().st_mtime < cutoff:
                child.unlink()
        except OSError:
            continue


def _analysis_id(path: Path) -> str:
    stat = path.stat()
    seed = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8", "replace")
    return hashlib.sha1(seed).hexdigest()[:16]


def _cache_path(analysis_id: str) -> Path:
    return CACHE_DIR / f"{analysis_id}.json"


def _preview(questions: list[dict], limit: int = 8) -> list[dict]:
    out: list[dict] = []
    for question in questions[:limit]:
        choices = [
            {
                "letter": choice["letter"],
                "text": (choice["text"] or "[image option]")[:180],
                "correct": index + 1 == question["correct"],
            }
            for index, choice in enumerate(question["choices"])
        ]
        out.append({
            "number": question["number"],
            "source_id": question["source_id"],
            "title": question["title"],
            "stem": question["stem"][:560],
            "choices": choices,
            "correct": question["correct"],
            "explanation": question["explanation"][:420],
            "subject": question["subject"],
            "system": question["system"],
            "images": sum(
                1
                for fragments in [question["stem_parts"], question["explanation_parts"],
                                  *[choice["parts"] for choice in question["choices"]]]
                for fragment in fragments
                if isinstance(fragment, dict)
            ),
        })
    return out


def analyze_pdf(
    path_text: str,
    *,
    name: str = "",
    progress: Optional[Callable[[int, int], None]] = None,
) -> dict:
    _require_fitz()
    path = Path((path_text or "").strip().strip('"')).expanduser()
    if not path.is_file():
        raise ValueError(f"PDF not found: {path}")
    if path.suffix.lower() != ".pdf":
        raise ValueError("Choose a PDF file.")

    items, page_count, warnings = _read_pdf(path, progress)
    questions, parse_warnings, stats = _analyze_items(items, page_count)
    warnings.extend(parse_warnings)

    analysis_id = _analysis_id(path)
    label = _clean(name) or path.stem
    payload = {
        "version": 1,
        "id": analysis_id,
        "source": str(path.resolve()),
        "name": label,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "pages": page_count,
        "stats": stats,
        "warnings": warnings[:60],
        "questions": questions,
    }
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temp = _cache_path(analysis_id).with_suffix(".json.tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temp.replace(_cache_path(analysis_id))
    except OSError as exc:
        warnings.append(f"Analysis cache could not be written ({exc}); build will re-parse the PDF.")

    return {
        "analysis_id": analysis_id,
        "name": label,
        "source": str(path),
        "pages": page_count,
        "stats": stats,
        "warnings": warnings[:60],
        "samples": _preview(questions),
        "cached": _cache_path(analysis_id).exists(),
    }


def _load_analysis(analysis_id: str) -> dict:
    path = _cache_path(re.sub(r"[^0-9a-f]", "", analysis_id or ""))
    if not path.is_file():
        raise ValueError("That preview expired. Run the scan again.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Could not read the cached analysis: {exc}") from exc


def start_analyze(path_text: str, name: str = "") -> dict:
    _cleanup_cache()
    if not _begin("analyze"):
        return {"status": "busy"}

    def run() -> None:
        try:
            def progress(done: int, total: int) -> None:
                _stage(f"Reading page {done:,} of {total:,}…", (done / max(1, total)) * 92.0)

            _stage("Opening the PDF…", 1.0)
            result = analyze_pdf(path_text, name=name, progress=progress)
            _stage("Preparing preview…", 96.0)
            _finish(result=result)
        except Exception as exc:  # noqa: BLE001
            _finish(error=str(exc) or exc.__class__.__name__)

    thread = threading.Thread(target=run, name="qbank-import-analyze", daemon=True)
    thread.start()
    return {"status": "started", "mode": "analyze"}


# ── rendering / database build ──────────────────────────────────────────────

def _render_parts(parts: list[Any], image_sink: Callable[[dict], Optional[str]]) -> str:
    chunks: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        if not buffer:
            return
        raw = "".join(buffer)
        buffer.clear()
        raw = re.sub(r"-\s*\n\s*(?=[a-z])", "", raw)
        for block in re.split(r"\n{2,}", raw):
            lines = [_clean(line) for line in block.split("\n")]
            text = "\n".join(line for line in lines if line).strip()
            if not text:
                continue
            chunks.append(
                "<p>" + html.escape(text).replace("\n", "<br>") + "</p>"
            )

    for fragment in parts:
        if isinstance(fragment, str):
            buffer.append(fragment)
            continue
        flush()
        name = image_sink(fragment["img"])
        if name:
            chunks.append(
                '<figure class="qbank-figure">'
                f'<img src="{html.escape(name)}" alt="Figure" loading="lazy">'
                "</figure>"
            )
    flush()
    return "".join(chunks)


def _plain(value: str) -> str:
    return _clean(
        html.unescape(
            re.sub(r"<[^>]+>", " ", value or "")
        )
    )


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        CREATE TABLE Questions (
            id INTEGER NOT NULL PRIMARY KEY,
            question TEXT, explanation TEXT, corrAns INTEGER, subId INTEGER,
            sysId INTEGER, pplTaken REAL, corrTaken REAL, lastUpdated TEXT,
            title TEXT, questionType INTEGER, questionFormatType INTEGER,
            mediaName TEXT, otherMedias TEXT, parentQId INTEGER
        );
        CREATE TABLE Answers (
            id INTEGER NOT NULL PRIMARY KEY, qId INTEGER, answerId INTEGER,
            answerText TEXT, correctPercentage INTEGER
        );
        CREATE TABLE Subjects (id INTEGER NOT NULL PRIMARY KEY, name TEXT, count INTEGER);
        CREATE TABLE Systems (id INTEGER NOT NULL PRIMARY KEY, name TEXT, count INTEGER);
        CREATE TABLE SubjectsSystems (
            subId INTEGER, sysId INTEGER, count INTEGER, PRIMARY KEY (subId, sysId)
        );
        CREATE VIRTUAL TABLE Search USING fts4(
            text, content, type, typeText, contentId, tokenize=porter
        );
        CREATE TABLE Refs (
            id INTEGER NOT NULL PRIMARY KEY, qId INTEGER,
            refTitle TEXT, refLink TEXT, refType INTEGER
        );
        CREATE TABLE SourceMetadata (
            qId INTEGER NOT NULL PRIMARY KEY,
            sourceId TEXT NOT NULL UNIQUE,
            sourceKind TEXT NOT NULL,
            tags TEXT NOT NULL
        );
        CREATE INDEX idx_answers_qid ON Answers(qId, answerId);
        CREATE INDEX idx_refs_qid ON Refs(qId);
        CREATE INDEX idx_questions_subject ON Questions(subId);
        CREATE INDEX idx_questions_system ON Questions(sysId);
        """
    )


def _insert_search(conn: sqlite3.Connection, content: str, kind: int, kind_text: str, qid: int) -> None:
    plain = _plain(content)
    if not plain:
        return
    conn.execute(
        "INSERT INTO Search(text,content,type,typeText,contentId) VALUES (?,?,?,?,?)",
        (plain, plain, kind, kind_text, qid),
    )


def _extract_image(doc: Any, image: dict) -> tuple[bytes, str]:
    page = doc[image["page"]]
    rect = fitz.Rect(image["bbox"])
    xref = int(image.get("xref") or 0)
    if xref > 0:
        try:
            info = doc.extract_image(xref)
            data = info.get("image") or b""
            ext = (info.get("ext") or "png").lower()
            if data and len(data) <= 12 * 1024 * 1024 and ext in ("png", "jpg", "jpeg", "gif", "webp"):
                return data, ("jpg" if ext == "jpeg" else ext)
        except Exception:
            pass
    pix = page.get_pixmap(clip=rect, dpi=200, alpha=False)
    return pix.tobytes("png"), "png"


def build_bank(analysis_id: str, name: str = "", overwrite: bool = False) -> dict:
    _require_fitz()
    analysis = _load_analysis(analysis_id)
    source = Path(analysis["source"])
    if not source.is_file():
        raise ValueError(f"The source PDF moved or was deleted: {source}")
    questions = analysis.get("questions") or []
    if not questions:
        raise ValueError("The analysis found no questions to build.")

    label = _clean(name) or _clean(analysis.get("name")) or source.stem
    slug = _slugify(label)
    existing = [
        child for child in IMPORTED_QBANK_ROOT.glob(f"imported-{slug}-*")
        if child.is_dir()
    ] if IMPORTED_QBANK_ROOT.is_dir() else []
    if existing and not overwrite:
        raise ValueError(
            f"A Q-Bank named “{label}” already exists. Enable “Replace existing” to rebuild it."
        )
    if overwrite:
        for child in existing:
            shutil.rmtree(child, ignore_errors=True)
    folder = IMPORTED_QBANK_ROOT / f"imported-{slug}-{analysis['id'][:8]}"
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)
    media_dir = folder / "media-E"
    media_dir.mkdir(parents=True, exist_ok=True)
    db_path = folder / f"{folder.name}.db"
    temp_db = folder / f".{folder.name}.db.tmp"
    if temp_db.exists():
        temp_db.unlink()

    doc = fitz.open(str(source))
    seen_images: dict[str, str] = {}
    image_counter = 0
    image_bytes = 0
    assumed_answers = 0
    skipped = 0

    def image_sink(image: dict) -> Optional[str]:
        nonlocal image_counter, image_bytes
        try:
            data, ext = _extract_image(doc, image)
        except Exception:
            return None
        if not data:
            return None
        digest = hashlib.sha1(data).hexdigest()
        if digest in seen_images:
            return seen_images[digest]
        image_counter += 1
        filename = f"img-{image_counter:05d}.{ext}"
        try:
            (media_dir / filename).write_bytes(data)
        except OSError:
            return None
        image_bytes += len(data)
        seen_images[digest] = filename
        return filename

    questions.sort(key=lambda item: item.get("number") or 0)
    subject_names = sorted({q["subject"] for q in questions})
    system_names = sorted({q["system"] for q in questions})
    subjects = {name: index + 1 for index, name in enumerate(subject_names)}
    systems = {name: index + 1 for index, name in enumerate(system_names)}
    subject_counts = Counter(q["subject"] for q in questions)
    system_counts = Counter(q["system"] for q in questions)
    pair_counts = Counter((q["subject"], q["system"]) for q in questions)

    conn = sqlite3.connect(temp_db)
    try:
        _create_schema(conn)
        conn.executemany(
            "INSERT INTO Subjects(id,name,count) VALUES (?,?,?)",
            [(subjects[name], name, subject_counts[name]) for name in subject_names],
        )
        conn.executemany(
            "INSERT INTO Systems(id,name,count) VALUES (?,?,?)",
            [(systems[name], name, system_counts[name]) for name in system_names],
        )
        conn.executemany(
            "INSERT INTO SubjectsSystems(subId,sysId,count) VALUES (?,?,?)",
            [
                (subjects[subject], systems[system], count)
                for (subject, system), count in sorted(pair_counts.items())
            ],
        )

        answer_pk = 1
        ref_pk = 1
        seen_source_ids: set[str] = set()
        imported = 0
        for qid, question in enumerate(questions, start=1):
            choices = question.get("choices") or []
            if len(choices) < 2:
                skipped += 1
                continue
            correct = int(question.get("correct") or 0)
            if correct < 1 or correct > len(choices):
                correct = 1
                assumed_answers += 1

            stem_html = _render_parts(question.get("stem_parts") or [], image_sink)
            explanation_html = _render_parts(question.get("explanation_parts") or [], image_sink)
            choice_html = [
                _render_parts(choice.get("parts") or [], image_sink)
                for choice in choices
            ]

            title = _clean(question.get("title") or "")[:120] or f"Question {question.get('number')}"
            conn.execute(
                """INSERT INTO Questions(
                    id,question,explanation,corrAns,subId,sysId,pplTaken,corrTaken,lastUpdated,
                    title,questionType,questionFormatType,mediaName,otherMedias,parentQId
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    qid,
                    PLAIN_PREFIX + (stem_html or "<p></p>"),
                    PLAIN_PREFIX + explanation_html,
                    correct,
                    subjects[question["subject"]],
                    systems[question["system"]],
                    0,
                    0,
                    f"PDF import {datetime.now().strftime('%Y-%m-%d')}",
                    title,
                    1,
                    1,
                    "",
                    "",
                    None,
                ),
            )

            source_id = _clean(question.get("source_id") or "") or str(question.get("number") or qid)
            if source_id in seen_source_ids:
                source_id = f"{source_id}#{qid}"
            seen_source_ids.add(source_id)
            tags = ["pdf", *[f"{key}:{value}" for key, value in sorted((question.get("tags") or {}).items())]]
            conn.execute(
                "INSERT INTO SourceMetadata(qId,sourceId,sourceKind,tags) VALUES (?,?,?,?)",
                (qid, source_id[:200], "pdf", json.dumps(tags, ensure_ascii=False)),
            )

            for index, choice in enumerate(choices, start=1):
                conn.execute(
                    "INSERT INTO Answers(id,qId,answerId,answerText,correctPercentage) VALUES (?,?,?,?,?)",
                    (answer_pk, qid, index, PLAIN_PREFIX + choice_html[index - 1], 0),
                )
                answer_pk += 1

            _insert_search(conn, title, 0, "title", qid)
            _insert_search(conn, stem_html, 1, "question", qid)
            _insert_search(conn, explanation_html, 2, "explanation", qid)
            for html_choice in choice_html:
                _insert_search(conn, html_choice, 3, "answer", qid)

            for reference in question.get("refs") or []:
                conn.execute(
                    "INSERT INTO Refs(id,qId,refTitle,refLink,refType) VALUES (?,?,?,?,?)",
                    (ref_pk, qid, reference[:400], "", 18),
                )
                ref_pk += 1
            imported += 1

        conn.commit()
        check = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"The generated bank failed integrity_check: {check}")
        count = conn.execute("SELECT count(*) FROM Questions").fetchone()[0]
        if count != imported:
            raise RuntimeError(f"Generated {count} questions; expected {imported}")
        conn.execute("VACUUM")
    except Exception:
        conn.close()
        shutil.rmtree(folder, ignore_errors=True)
        raise
    else:
        conn.close()
    finally:
        doc.close()

    temp_db.replace(db_path)

    meta = {
        "format": "medos-imported-qbank",
        "version": 1,
        "name": label,
        "source_pdf": str(source),
        "analysis_id": analysis["id"],
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "questions": imported,
        "images": image_counter,
        "image_bytes": image_bytes,
        "assumed_answers": assumed_answers,
        "warnings": (analysis.get("warnings") or [])[:40],
    }
    (folder / "imported.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    try:
        from qbank_reader import reset_bank_registry

        reset_bank_registry()
    except Exception as exc:  # pragma: no cover - registry reset is best effort
        meta["warnings"].append(f"Bank built, but the catalog needs a restart to show it: {exc}")

    return {
        "bank_key": folder.name,
        "label": label,
        "folder": str(folder),
        "db": str(db_path),
        "questions": imported,
        "choices": sum(len(q.get("choices") or []) for q in questions),
        "images": image_counter,
        "image_bytes": image_bytes,
        "assumed_answers": assumed_answers,
        "skipped": skipped,
        "subjects": len(subjects),
        "systems": len(systems),
        "size": _dir_bytes(folder),
        "warnings": meta["warnings"],
    }


def start_build(analysis_id: str, name: str = "", overwrite: bool = False) -> dict:
    if not _begin("build"):
        return {"status": "busy"}

    def run() -> None:
        try:
            _stage("Building the Q-Bank database…", 5.0)
            result = build_bank(analysis_id, name=name, overwrite=overwrite)
            _stage("Registering the bank…", 95.0)
            _finish(result=result)
        except Exception as exc:  # noqa: BLE001
            _finish(error=str(exc) or exc.__class__.__name__)

    thread = threading.Thread(target=run, name="qbank-import-build", daemon=True)
    thread.start()
    return {"status": "started", "mode": "build"}


def catalog() -> dict:
    """Imported banks for the import dialog (label + counts + source PDF)."""
    out: list[dict] = []
    if not IMPORTED_QBANK_ROOT.is_dir():
        return {"banks": out}
    for folder in sorted(IMPORTED_QBANK_ROOT.iterdir()):
        meta_file = folder / "imported.json"
        db_file = folder / f"{folder.name}.db"
        if not folder.is_dir() or not meta_file.is_file() or not db_file.is_file():
            continue
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            meta = {}
        out.append({
            "key": folder.name,
            "label": meta.get("name") or folder.name,
            "source_pdf": meta.get("source_pdf") or "",
            "created_at": meta.get("created_at") or "",
            "questions": meta.get("questions") or 0,
            "images": meta.get("images") or 0,
            "size": _dir_bytes(folder),
        })
    out.sort(key=lambda item: (item["created_at"], item["label"]), reverse=True)
    return {"banks": out}

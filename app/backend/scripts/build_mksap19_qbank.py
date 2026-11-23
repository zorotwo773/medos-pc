"""Build the MedOS-compatible MKSAP 19 question bank.

The source bundle is intentionally never edited.  Questions are normalized
from ``content/questions/*.json`` into a companion SQLite database beside the
vendor files.  ``Docs.rowid`` is retained as the stable numeric MedOS QID,
while the vendor string id and source family live in ``SourceMetadata``.

Usage:
    python build_mksap19_qbank.py
    python build_mksap19_qbank.py --source D:/MedOS/data/mksap19part2db
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote


PLAIN_PREFIX = "medos-plain:"

SPECIALTIES: dict[str, str] = {
    "cv": "Cardiovascular Medicine",
    "en": "Endocrinology and Metabolism",
    "gi": "Gastroenterology and Hepatology",
    "gm": "General Internal Medicine 1",
    "gm2": "General Internal Medicine 2",
    "hm": "Hematology",
    "id": "Infectious Disease",
    "np": "Nephrology",
    "nr": "Neurology",
    "on": "Oncology",
    "pm": "Pulmonary and Critical Care Medicine",
    "rm": "Rheumatology",
}

SOURCE_SYSTEMS: dict[str, str] = {
    "core": "MKSAP 19 Core",
    "quick": "MKSAP Quick Qs",
    "visual_dx": "MKSAP Virtual Dx",
}

ALLOWED_TAGS = {
    "a", "b", "blockquote", "br", "caption", "code", "div", "em",
    "figcaption", "figure", "h3", "h4", "i", "img", "li", "ol", "p",
    "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
    "th", "thead", "tr", "u", "ul", "video", "source",
}
VOID_TAGS = {"br", "img", "source"}
ALLOWED_ATTRS = {
    "class", "href", "target", "rel", "rowspan", "colspan", "title", "id",
    "src", "alt", "width", "height", "loading", "controls", "preload",
}
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v"}


def _safe_fragment(value: Any) -> str:
    """Keep source formatting while removing executable HTML."""
    raw = str(value or "")
    raw = re.sub(r"(?is)<script\b[^>]*>.*?</script>", "", raw)
    raw = re.sub(r"(?is)<iframe\b[^>]*>.*?</iframe>", "", raw)
    raw = re.sub(r"\s+on[a-z]+\s*=\s*(['\"]).*?\1", "", raw)
    raw = re.sub(r"\s+(?:href|src)\s*=\s*(['\"])\s*javascript:[^'\"]*\1", "", raw, flags=re.I)
    return raw


def _safe_href(value: Any) -> str:
    href = str(value or "").strip()
    if not href or re.match(r"(?i)^(?:javascript|data):", href):
        return ""
    return href


def _attrs_html(attrs: dict[str, Any] | None) -> str:
    attrs = attrs or {}
    rendered: list[str] = []
    for raw_name, value in attrs.items():
        name = "class" if raw_name == "className" else raw_name.lower()
        if name not in ALLOWED_ATTRS or value is None or value is False:
            continue
        text = str(value)
        if name in {"href", "src"}:
            text = _safe_href(text)
            if not text:
                continue
        if name == "target" and text not in {"_blank", "_self"}:
            continue
        rendered.append(f' {name}="{html.escape(text, quote=True)}"')
    return "".join(rendered)


def _plain_text(value: str) -> str:
    clean = re.sub(r"(?is)<(?:style|script)\b[^>]*>.*?</(?:style|script)>", " ", value or "")
    clean = re.sub(r"(?i)<br\s*/?>", " ", clean)
    clean = re.sub(r"(?i)</(?:p|div|li|tr|h[1-6]|figcaption)>", " ", clean)
    clean = re.sub(r"<[^>]+>", " ", clean)
    return re.sub(r"\s+", " ", html.unescape(clean)).strip()


def _source_kind(payload: dict[str, Any]) -> str:
    source_id = str(payload.get("id") or "").lower()
    book_id = str(payload.get("bookId") or "").lower()
    if source_id.startswith("mk19_qq_") or book_id == "qq":
        return "quick"
    if source_id.startswith("vdx") or book_id.startswith("vdx"):
        return "visual_dx"
    return "core"


def _specialty_code(payload: dict[str, Any], kind: str) -> str:
    book_id = str(payload.get("bookId") or "").lower().strip()
    if kind == "core" and book_id in SPECIALTIES:
        return book_id
    if kind == "visual_dx" and book_id.startswith("vdx_"):
        candidate = book_id[4:]
        if candidate in SPECIALTIES:
            return candidate

    related = str(payload.get("relatedSection") or "").lower()
    patterns = (
        r"^mk19_[ab]_([a-z0-9]+)_s",
        r"^mk19_([a-z0-9]+)_s",
        r"^vdx\d*_([a-z0-9]+)_s",
    )
    for pattern in patterns:
        match = re.search(pattern, related)
        if match and match.group(1) in SPECIALTIES:
            return match.group(1)

    source_id = str(payload.get("id") or "").lower()
    for pattern in (r"^mk19_[ab]_([a-z0-9]+)_", r"^vdx\d*_([a-z0-9]+)_"):
        match = re.search(pattern, source_id)
        if match and match.group(1) in SPECIALTIES:
            return match.group(1)
    raise ValueError(f"Cannot determine MKSAP specialty for {payload.get('id')!r}")


class Renderer:
    def __init__(self, qid: int, source_dir: Path, payload: dict[str, Any]) -> None:
        self.qid = qid
        self.source_dir = source_dir
        self.figures_dir = source_dir / "figure-images"
        self.payload = payload
        self.figures = payload.get("figuresContent") or {}
        self.tables = payload.get("tablesContent") or {}

    def render(self, node: Any) -> str:
        if node is None:
            return ""
        if isinstance(node, str):
            return html.escape(node)
        if isinstance(node, (int, float)):
            return html.escape(str(node))
        if isinstance(node, list):
            return "".join(self.render(child) for child in node)
        if not isinstance(node, dict):
            return html.escape(str(node))
        if "__html" in node:
            return _safe_fragment(node.get("__html"))

        kind = str(node.get("type") or "")
        children = self.render(node.get("children") or [])
        if kind == "p":
            return f"<p>{children}</p>"
        if kind == "keypoint":
            return f'<p class="mksap-keypoint">{children}</p>'
        if kind == "list-item":
            return f"<li>{children}</li>"
        if kind == "list":
            list_tag = "ol" if str(node.get("listType") or "").lower() in {"ordered", "ol"} else "ul"
            return f"<{list_tag}>{children}</{list_tag}>"
        if kind == "tag":
            return self._tag(node, children)
        if kind in {"figure-link", "table-link", "video-link"}:
            target = str(node.get("target") or "")
            label = children or html.escape(str(node.get("label") or target or "Exhibit"))
            return f'<a href="#mksap-{html.escape(target, quote=True)}">{label}</a>'
        if kind == "inline-wrap":
            ids = node.get("contentIds") or []
            return "".join(self._inline_content(str(target)) for target in ids)
        if kind == "reference-range-link":
            title = str(node.get("title") or node.get("target") or "Reference range")
            return f'<span class="mksap-reference-range" title="{html.escape(title, quote=True)}">{children or html.escape(title)}</span>'
        return children

    def _tag(self, node: dict[str, Any], children: str) -> str:
        tag = str(node.get("tagName") or "span").lower()
        if tag not in ALLOWED_TAGS:
            return children
        attrs = dict(node.get("attrs") or {})
        if tag == "a":
            href = _safe_href(attrs.get("href"))
            if not href:
                attrs.pop("href", None)
            if attrs.get("target") == "_blank":
                attrs["rel"] = "noopener noreferrer"
        attrs_html = _attrs_html(attrs)
        if tag in VOID_TAGS:
            return f"<{tag}{attrs_html}>"
        return f"<{tag}{attrs_html}>{children}</{tag}>"

    def _media_file(self, target: str, info: dict[str, Any] | None = None) -> Path:
        info = info or {}
        image_info = info.get("imageInfo") or {}
        digest = str(image_info.get("hash") or "").strip()
        extension = str(image_info.get("extension") or "").strip().lstrip(".")
        if digest and extension:
            exact = self.figures_dir / f"{target}.{digest}.{extension}"
            if exact.exists():
                return exact
        matches = sorted(self.figures_dir.glob(f"{target}.*"))
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise FileNotFoundError(f"MKSAP media missing for {target!r} (QID {self.qid})")
        raise ValueError(f"Ambiguous MKSAP media for {target!r}: {[p.name for p in matches]}")

    def _media_url(self, path: Path) -> str:
        return f"/qbank/media/{self.qid}/{quote(path.name)}"

    def _inline_content(self, target: str) -> str:
        anchor = f"mksap-{html.escape(target, quote=True)}"
        if target in self.tables:
            table_info = self.tables[target] or {}
            content = table_info.get("jsonContent") or table_info.get("content") or table_info
            title = self.render(table_info.get("title"))
            body = self.render(content)
            caption = f"<figcaption>{title}</figcaption>" if title else ""
            return f'<figure id="{anchor}" class="mksap-table">{body}{caption}</figure>'

        figure_info = self.figures.get(target)
        media_path = self._media_file(target, figure_info)
        media_url = html.escape(self._media_url(media_path), quote=True)
        suffix = media_path.suffix.lower()
        if suffix in VIDEO_SUFFIXES:
            media = f'<video controls preload="metadata" src="{media_url}"></video>'
        else:
            image_info = (figure_info or {}).get("imageInfo") or {}
            attrs: dict[str, Any] = {
                "src": self._media_url(media_path),
                "alt": _plain_text(self.render((figure_info or {}).get("legend"))) or target,
                "loading": "lazy",
            }
            if image_info.get("width"):
                attrs["width"] = image_info["width"]
            if image_info.get("height"):
                attrs["height"] = image_info["height"]
            media = f"<img{_attrs_html(attrs)}>"

        legend = self.render((figure_info or {}).get("legend"))
        footnotes = self.render((figure_info or {}).get("footnotes") or [])
        caption_body = "".join(part for part in (legend, footnotes) if part)
        caption = f"<figcaption>{caption_body}</figcaption>" if caption_body else ""
        return f'<figure id="{anchor}" class="mksap-figure">{media}{caption}</figure>'


def _render_question(qid: int, source_dir: Path, payload: dict[str, Any]) -> tuple[str, str, list[str]]:
    renderer = Renderer(qid, source_dir, payload)
    stimulus = renderer.render(payload.get("stimulus") or [])
    prompt = renderer.render(payload.get("prompt") or [])
    stem = f'<div class="mksap-stimulus">{stimulus}</div><div class="mksap-prompt">{prompt}</div>'

    explanation_parts = [renderer.render(payload.get("exposition") or [])]
    keypoints = renderer.render(payload.get("keypoints") or [])
    if keypoints:
        explanation_parts.append(f"<h3>Key Points</h3>{keypoints}")
    objective = renderer.render(payload.get("objective"))
    if objective:
        explanation_parts.append(f"<h3>Learning Objective</h3><p>{objective}</p>")

    peer = payload.get("peerComparison") or {}
    if peer:
        rows = "".join(
            f"<tr><th>{html.escape(str(letter))}</th><td>{html.escape(str(percent))}%</td></tr>"
            for letter, percent in sorted(peer.items())
        )
        explanation_parts.append(f"<h3>Peer responses</h3><table><tbody>{rows}</tbody></table>")

    rendered_refs: list[str] = []
    for reference in payload.get("references") or []:
        value = renderer.render(reference)
        if value:
            rendered_refs.append(f"<li>{value}</li>")
    if rendered_refs:
        explanation_parts.append(f"<h3>References</h3><ol>{''.join(rendered_refs)}</ol>")

    source_id = str(payload.get("id") or "")
    related = str(payload.get("relatedSection") or "")
    source_line = f"Original ID: <code>{html.escape(source_id)}</code>"
    if related:
        source_line += f" · Section: <code>{html.escape(related)}</code>"
    explanation_parts.append(f'<h3>Source</h3><p class="mksap-source">{source_line}</p>')

    tags = [SOURCE_SYSTEMS[_source_kind(payload)]]
    if payload.get("hospitalist"):
        tags.append("Hospitalist")
    if payload.get("hvc"):
        tags.append("High Value Care")
    return stem, "".join(explanation_parts), tags


def _reference_title_and_url(reference: Any) -> tuple[str, str]:
    if not isinstance(reference, list):
        reference = [reference]
    title = _plain_text(Renderer(0, Path("."), {}).render(reference))
    url = ""

    def walk(node: Any) -> None:
        nonlocal url
        if url:
            return
        if isinstance(node, list):
            for child in node:
                walk(child)
        elif isinstance(node, dict):
            attrs = node.get("attrs") or {}
            if node.get("tagName") == "a" and _safe_href(attrs.get("href")):
                url = _safe_href(attrs.get("href"))
            for child in node.get("children") or []:
                walk(child)

    walk(reference)
    return title, url


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
        CREATE TABLE SubjectsSystems (subId INTEGER, sysId INTEGER, count INTEGER, PRIMARY KEY (subId, sysId));
        CREATE VIRTUAL TABLE Search USING fts4(text, content, type, typeText, contentId, tokenize=porter);
        CREATE TABLE Refs (
            id INTEGER NOT NULL PRIMARY KEY, qId INTEGER, refTitle TEXT, refLink TEXT, refType INTEGER
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


def _load_questions(source_dir: Path) -> list[tuple[int, dict[str, Any]]]:
    source_db = source_dir / "mksap19.db"
    questions_dir = source_dir / "content" / "questions"
    if not source_db.is_file():
        raise FileNotFoundError(f"MKSAP source database not found: {source_db}")
    if not questions_dir.is_dir():
        raise FileNotFoundError(f"MKSAP question JSON folder not found: {questions_dir}")

    conn = sqlite3.connect(f"file:{source_db}?mode=ro", uri=True)
    try:
        docs = conn.execute("SELECT rowid, docName FROM Docs WHERE docName<>''").fetchall()
    finally:
        conn.close()
    ids = {str(name): int(rowid) for rowid, name in docs}
    if len(ids) != len(docs):
        raise ValueError("MKSAP Docs contains duplicate docName values")

    loaded: list[tuple[int, dict[str, Any]]] = []
    seen: set[str] = set()
    for path in sorted(questions_dir.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            # MKSAP ships 24 *_mcq.json book indexes beside the 1,870
            # canonical <source-id>.json files. Their list members are exact
            # duplicates, so importing both would flatten identity and double
            # the bank. Treat only that explicit vendor aggregate shape as an
            # index; unexpected arrays still fail closed.
            if path.stem.endswith("_mcq") and all(isinstance(item, dict) for item in payload):
                continue
            raise ValueError(f"Unexpected question array in {path.name}")
        if not isinstance(payload, dict):
            raise ValueError(f"Unexpected question JSON shape in {path.name}: {type(payload).__name__}")
        source_id = str(payload.get("id") or path.stem)
        if source_id in seen:
            raise ValueError(f"Duplicate MKSAP source question id: {source_id}")
        seen.add(source_id)
        if source_id not in ids:
            raise ValueError(f"Question {source_id!r} has no matching Docs rowid")
        loaded.append((ids[source_id], payload))
    if not loaded:
        raise ValueError("No MKSAP question JSON files found")
    return sorted(loaded, key=lambda item: item[0])


def _insert_search(conn: sqlite3.Connection, docid: int, content: str, kind: int, kind_text: str, qid: int) -> None:
    plain = _plain_text(content)
    conn.execute(
        "INSERT INTO Search(docid,text,content,type,typeText,contentId) VALUES (?,?,?,?,?,?)",
        (docid, plain, plain, kind, kind_text, qid),
    )


def build(source_dir: Path, output: Path) -> dict[str, int]:
    source_dir = source_dir.resolve()
    output = output.resolve()
    questions = _load_questions(source_dir)

    records: list[dict[str, Any]] = []
    subject_names: set[str] = set()
    for qid, payload in questions:
        kind = _source_kind(payload)
        specialty = SPECIALTIES[_specialty_code(payload, kind)]
        stem, explanation, tags = _render_question(qid, source_dir, payload)
        options = payload.get("options") or []
        if len(options) < 2:
            raise ValueError(f"MKSAP question {payload.get('id')} has fewer than two options")
        letters = [str(option.get("letter") or "").upper() for option in options]
        correct_letter = str(payload.get("correctAnswer") or "").upper()
        if correct_letter not in letters:
            raise ValueError(f"Invalid correct answer {correct_letter!r} for {payload.get('id')}")
        renderer = Renderer(qid, source_dir, payload)
        choices = [renderer.render(option.get("text")) for option in options]
        peer = payload.get("peerComparison") or {}
        corr_taken = float(peer.get(correct_letter) or 0)
        subject_names.add(specialty)
        records.append(
            {
                "qid": qid,
                "payload": payload,
                "kind": kind,
                "system": SOURCE_SYSTEMS[kind],
                "subject": specialty,
                "stem": stem,
                "explanation": explanation,
                "choices": choices,
                "letters": letters,
                "correct": letters.index(correct_letter) + 1,
                "corr_taken": corr_taken,
                "ppl_taken": 100 if peer else 0,
                "tags": tags,
            }
        )

    subjects = {name: index + 1 for index, name in enumerate(sorted(subject_names))}
    systems = {SOURCE_SYSTEMS[kind]: index + 1 for index, kind in enumerate(("core", "quick", "visual_dx"))}
    subject_counts = Counter(record["subject"] for record in records)
    system_counts = Counter(record["system"] for record in records)
    pair_counts = Counter((record["subject"], record["system"]) for record in records)

    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(output.name + ".tmp")
    if temp.exists():
        temp.unlink()
    conn = sqlite3.connect(temp)
    try:
        _create_schema(conn)
        conn.executemany(
            "INSERT INTO Subjects(id,name,count) VALUES (?,?,?)",
            [(subject_id, name, subject_counts[name]) for name, subject_id in subjects.items()],
        )
        conn.executemany(
            "INSERT INTO Systems(id,name,count) VALUES (?,?,?)",
            [(system_id, name, system_counts[name]) for name, system_id in systems.items()],
        )
        conn.executemany(
            "INSERT INTO SubjectsSystems(subId,sysId,count) VALUES (?,?,?)",
            [
                (subjects[subject], systems[system], count)
                for (subject, system), count in sorted(pair_counts.items())
            ],
        )

        answer_pk = 1
        search_docid = 1
        ref_pk = 1
        for record in records:
            qid = record["qid"]
            payload = record["payload"]
            conn.execute(
                """INSERT INTO Questions(
                    id,question,explanation,corrAns,subId,sysId,pplTaken,corrTaken,lastUpdated,
                    title,questionType,questionFormatType,mediaName,otherMedias,parentQId
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    qid,
                    PLAIN_PREFIX + record["stem"],
                    PLAIN_PREFIX + record["explanation"],
                    record["correct"],
                    subjects[record["subject"]],
                    systems[record["system"]],
                    record["ppl_taken"],
                    record["corr_taken"],
                    "MKSAP 19",
                    str(payload.get("title") or payload.get("id") or ""),
                    1,
                    1,
                    "",
                    "",
                    None,
                ),
            )
            conn.execute(
                "INSERT INTO SourceMetadata(qId,sourceId,sourceKind,tags) VALUES (?,?,?,?)",
                (qid, str(payload.get("id") or ""), record["kind"], json.dumps(record["tags"])),
            )

            peer = payload.get("peerComparison") or {}
            for index, (letter, choice) in enumerate(zip(record["letters"], record["choices"]), start=1):
                conn.execute(
                    "INSERT INTO Answers(id,qId,answerId,answerText,correctPercentage) VALUES (?,?,?,?,?)",
                    (answer_pk, qid, index, PLAIN_PREFIX + choice, int(float(peer.get(letter) or 0))),
                )
                answer_pk += 1

            search_values: Iterable[tuple[str, int, str]] = (
                (str(payload.get("title") or record["subject"]), 0, "title"),
                (record["stem"], 1, "question"),
                (record["explanation"], 2, "explanation"),
                *((choice, 3, "answer") for choice in record["choices"]),
            )
            for content, kind, kind_text in search_values:
                _insert_search(conn, search_docid, content, kind, kind_text, qid)
                search_docid += 1

            for reference in payload.get("references") or []:
                title, url = _reference_title_and_url(reference)
                if not title and not url:
                    continue
                conn.execute(
                    "INSERT INTO Refs(id,qId,refTitle,refLink,refType) VALUES (?,?,?,?,?)",
                    (ref_pk, qid, title, url, 18),
                )
                ref_pk += 1

        conn.commit()
        check = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"Generated MKSAP database failed integrity_check: {check}")
        count = conn.execute("SELECT count(*) FROM Questions").fetchone()[0]
        if count != len(records):
            raise RuntimeError(f"Generated {count} questions; expected {len(records)}")
    except Exception:
        conn.close()
        if temp.exists():
            temp.unlink()
        raise
    else:
        conn.close()
    os.replace(temp, output)
    return {
        "questions": len(records),
        "answers": answer_pk - 1,
        "subjects": len(subjects),
        "systems": len(systems),
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parents[3]
    default_source = repo_root / "data" / "mksap19part2db"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=default_source)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or (args.source / "medos-mksap19-qbank.db")
    stats = build(args.source, output)
    print(f"Built {output}: {stats}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

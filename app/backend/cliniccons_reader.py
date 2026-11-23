"""
Clinic Consult algorithm reader for MedOS hover reference boxes.

This adapts the derived Lexicomp 5-Minute Clinical Consult database into the
same normalized scan/tooltip/media contract used by AMBOSS, UWorld, and UTD.
"""
from __future__ import annotations

import html
import json
import os
import re
import sqlite3
import unicodedata
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field


BASE = Path(__file__).parent
ROOT = BASE.parent.parent

router = APIRouter(prefix="/cliniccons", tags=["Clinic Consult"])


class ScanRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=120000)
    limit: int = Field(default=80, ge=1, le=250)


_WS_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[A-Za-z0-9]+")

_STOP_TERMS = {
    "algorithm",
    "diagnosis",
    "diagnostic",
    "evaluation",
    "management",
    "patient",
    "patients",
    "therapy",
    "treatment",
}

_ABBREVIATION_EXPANSIONS = {
    "af": "atrial fibrillation",
    "aki": "acute kidney injury",
    "bph": "benign prostatic hyperplasia",
    "cad": "coronary artery disease",
    "chf": "congestive heart failure",
    "ckd": "chronic kidney disease",
    "copd": "chronic obstructive pulmonary disease",
    "dka": "diabetic ketoacidosis",
    "dvt": "deep vein thrombosis",
    "gbs": "guillain-barré syndrome",
    "gerd": "gastroesophageal reflux disease",
    "ibd": "inflammatory bowel disease",
    "ibs": "irritable bowel syndrome",
    "mi": "myocardial infarction",
    "pe": "pulmonary embolism",
    "ra": "rheumatoid arthritis",
    "sle": "systemic lupus erythematosus",
    "sids": "sudden infant death syndrome",
    "tia": "transient ischemic attack",
    "uti": "urinary tract infection",
    "vte": "venous thromboembolism",
}

_PHRASE_SYNONYMS = {
    "deep vein thrombosis": ["deep venous thrombosis", "deep vein thrombophlebitis"],
}


def _db_path() -> Path:
    raw = os.environ.get("CLINICCONS_REFERENCE_DB", "").strip()
    p = Path(raw) if raw else ROOT / "data" / "cliniccons_disease_reference.sqlite"
    if not p.exists():
        raise HTTPException(503, f"Clinic Consult reference DB not found: {p}")
    return p


def _image_dir() -> Path:
    raw = os.environ.get("CLINICCONS_IMAGE_DIR", "").strip()
    p = Path(raw) if raw else ROOT / "data" / "Lexi" / "Cliniccons" / "img"
    if not p.exists():
        raise HTTPException(503, f"Clinic Consult image directory not found: {p}")
    return p


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{_db_path()}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    return c


def _clean(value: str) -> str:
    return _WS_RE.sub(" ", value or "").strip()


def _norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = value.encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^a-z0-9]+", " ", (value or "").lower())
    return _WS_RE.sub(" ", value).strip()


def _strip_algorithm_words(value: str) -> str:
    value = re.sub(r"\([^)]*\)", " ", value or "")
    value = re.sub(r"\b(?:algorithm|diagnosis|diagnostic|treatment|management|evaluation|approach)\b", " ", value, flags=re.I)
    value = value.replace(",", " ")
    return _clean(value)


def _term_ok(term: str) -> bool:
    key = _norm(term)
    if key in _STOP_TERMS:
        return False
    if key in _ABBREVIATION_EXPANSIONS:
        return True
    if len(key) < 5 or len(key) > 90:
        return False
    words = key.split()
    if len(words) == 1 and len(words[0]) < 6:
        return False
    if all(word in _STOP_TERMS for word in words):
        return False
    return bool(words)


def _title_acronym(value: str) -> str:
    words = [
        word
        for word in _WORD_RE.findall(_strip_algorithm_words(value))
        if len(word) > 2 and word.lower() not in _STOP_TERMS
    ]
    if len(words) < 2:
        return ""
    acronym = "".join(word[0] for word in words).upper()
    return acronym if 3 <= len(acronym) <= 6 else ""


def _candidate_terms(title: str, aliases: list[str] | None = None) -> list[tuple[str, bool]]:
    candidates: dict[str, bool] = {}

    def add(term: str, case_sensitive: bool = False) -> None:
        clean = _clean(term).strip(" -:,;")
        if _term_ok(clean):
            candidates.setdefault(clean, case_sensitive)

    add(title)
    add(_strip_algorithm_words(title))
    if "," in title:
        add(title.split(",", 1)[0])
    acronym = _title_acronym(title)
    if acronym:
        add(acronym, True)
    for alias in aliases or []:
        add(alias)
        alias_acronym = _title_acronym(alias)
        if alias_acronym:
            add(alias_acronym, True)
    return sorted(candidates.items(), key=lambda item: (-len(item[0]), item[0].lower()))


def _load_json_list(value: str | None) -> list:
    if not value:
        return []
    try:
        data = json.loads(value)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _image_payloads(images_json: str | None) -> list[dict]:
    out: list[dict] = []
    for item in _load_json_list(images_json):
        if not isinstance(item, dict):
            continue
        filename = Path(str(item.get("filename") or "")).name
        if not filename:
            continue
        title = _clean(str(item.get("title") or Path(filename).stem.replace("_", " ")))
        out.append({"title": title, "url": f"/cliniccons/image/{filename}", "filename": filename})
    return out


def _primary_text(row: sqlite3.Row) -> str:
    for col in ("clinical_synthesis_json", "treatment_pearls_json"):
        for point in _load_json_list(row[col]):
            text = _clean(str(point))
            if text:
                return text
    return _clean(row["content_preview"] or "")


def _read_aliases(c: sqlite3.Connection) -> dict[int, list[str]]:
    aliases: dict[int, list[str]] = {}
    for row in c.execute("SELECT document_id, alias FROM aliases ORDER BY length(alias) DESC, alias"):
        aliases.setdefault(int(row["document_id"]), []).append(row["alias"] or "")
    return aliases


@lru_cache(maxsize=1)
def _reference_index() -> tuple[dict, ...]:
    c = _conn()
    try:
        aliases = _read_aliases(c)
        disease_rows = c.execute("SELECT * FROM diseases ORDER BY disease_name").fetchall()
        algorithm_rows = c.execute("SELECT * FROM algorithms ORDER BY title").fetchall()
        disease_algorithm_rows = c.execute("SELECT * FROM disease_algorithms ORDER BY match_score DESC, title").fetchall()
    finally:
        c.close()

    disease_by_id = {int(row["document_id"]): row for row in disease_rows}
    entries: dict[tuple[str, str, int, str], dict] = {}

    def add_entry(term: str, payload: dict, case_sensitive: bool = False) -> None:
        clean = _clean(term)
        if not _term_ok(clean):
            return
        key = (clean.lower(), payload["kind"], int(payload["id"] or 0), payload.get("href", ""))
        entries.setdefault(
            key,
            {
                "term": clean,
                "term_lc": clean.lower(),
                "case_sensitive": bool(case_sensitive),
                **payload,
            },
        )

    for row in algorithm_rows:
        doc_id = int(row["document_id"])
        images = _image_payloads(row["images_json"])
        payload = {
            "id": doc_id,
            "title": row["title"] or f"Algorithm {doc_id}",
            "source": "cliniccons",
            "kind": "algorithm",
            "href": f"/cliniccons/algorithm/{doc_id}/html",
            "abstract": _clean(row["content_preview"] or "Clinic Consult algorithm"),
            "media": images,
        }
        for term, case_sensitive in _candidate_terms(payload["title"]):
            add_entry(term, payload, case_sensitive)

    for row in disease_rows:
        doc_id = int(row["document_id"])
        disease_aliases = aliases.get(doc_id, [])
        payload = {
            "id": doc_id,
            "title": row["disease_name"] or f"Disease {doc_id}",
            "source": "cliniccons",
            "kind": "disease",
            "href": f"/cliniccons/disease/{doc_id}/html",
            "abstract": _primary_text(row),
            "media": [],
        }
        for term, case_sensitive in _candidate_terms(payload["title"], disease_aliases):
            add_entry(term, payload, case_sensitive)

    for row in disease_algorithm_rows:
        disease_id = int(row["disease_document_id"])
        disease = disease_by_id.get(disease_id)
        algorithm_id = row["algorithm_document_id"]
        doc_id = int(algorithm_id) if algorithm_id is not None else disease_id
        images = _image_payloads(row["images_json"])
        title = row["title"] or (disease["disease_name"] if disease else "Clinic Consult algorithm")
        payload = {
            "id": doc_id,
            "title": title,
            "source": "cliniccons",
            "kind": "algorithm",
            "href": f"/cliniccons/algorithm/{doc_id}/html" if algorithm_id is not None else f"/cliniccons/disease/{disease_id}/html",
            "abstract": "Clinic Consult algorithm",
            "media": images,
            "score": float(row["match_score"] or 0),
        }
        linked_terms: list[tuple[str, bool]] = []
        linked_terms.extend(_candidate_terms(title))
        if disease:
            linked_terms.extend(_candidate_terms(disease["disease_name"], aliases.get(disease_id, [])))
        for term, case_sensitive in linked_terms:
            add_entry(term, payload, case_sensitive)

    for abbr, expansion in _ABBREVIATION_EXPANSIONS.items():
        expansion_key = _norm(expansion)
        for entry in list(entries.values()):
            if _norm(entry["term"]) == expansion_key or _norm(entry["title"]) == expansion_key:
                add_entry(abbr.upper(), {k: v for k, v in entry.items() if k not in {"term", "term_lc", "case_sensitive"}}, True)

    return tuple(sorted(entries.values(), key=lambda item: (-len(item["term"]), item["term_lc"], item["kind"] != "algorithm")))


def _is_boundary(ch: str) -> bool:
    return not (ch.isalnum() or ch in "_+-")


@router.post("/scan")
def scan(req: ScanRequest):
    text = req.text
    lower = text.lower()
    hits: list[dict] = []
    occupied: list[tuple[int, int]] = []
    for item in _reference_index():
        needle = item["term"] if item.get("case_sensitive") else item["term_lc"]
        haystack = text if item.get("case_sensitive") else lower
        start = 0
        while True:
            idx = haystack.find(needle, start)
            if idx < 0:
                break
            end = idx + len(needle)
            before_ok = idx == 0 or _is_boundary(haystack[idx - 1])
            after_ok = end == len(haystack) or _is_boundary(haystack[end])
            overlaps = any(idx < e and end > s for s, e in occupied)
            if before_ok and after_ok and not overlaps:
                hits.append({
                    "start": idx,
                    "end": end,
                    "term": item["term"],
                    "source": "cliniccons",
                    "kind": item["kind"],
                })
                occupied.append((idx, end))
                if len(hits) >= req.limit:
                    break
            start = end
        if len(hits) >= req.limit:
            break
    hits.sort(key=lambda hit: (hit["start"], -(hit["end"] - hit["start"])))
    return {"matches": hits[: req.limit]}


def _candidate_lookup_terms(term: str) -> list[str]:
    clean = _clean(term)
    terms = [clean]
    expanded = _ABBREVIATION_EXPANSIONS.get(clean.lower())
    if expanded:
        terms.append(expanded)
    for synonym in _PHRASE_SYNONYMS.get(_norm(clean), []):
        terms.append(synonym)
    for synonym in _PHRASE_SYNONYMS.get(_norm(expanded or ""), []):
        terms.append(synonym)
    return [item for item in terms if item]


def _ranked_entries(term: str, limit: int) -> list[dict]:
    lookup = {_norm(item) for item in _candidate_lookup_terms(term)}
    if not lookup:
        return []
    query = _norm(term)
    candidates: list[tuple[int, dict]] = []
    for item in _reference_index():
        item_term = _norm(item["term"])
        item_title = _norm(item["title"])
        score = 0
        if item_term in lookup:
            score += 120
        if item_title in lookup:
            score += 140
        if query and item_title.startswith(query + " "):
            score += 90
        if any(len(key) >= 5 and (key in item_term or key in item_title) for key in lookup):
            score += 55
        if not score:
            continue
        if item["kind"] == "algorithm":
            if item_title in lookup or item_term in lookup:
                score += 18
            else:
                score -= 20
        elif item["kind"] == "disease":
            score += 16
        if item.get("media"):
            score += 12
        candidates.append((score, item))

    seen: set[tuple[str, int, str]] = set()
    ranked: list[dict] = []
    for _score, item in sorted(candidates, key=lambda pair: (-pair[0], pair[1]["kind"] != "disease", pair[1]["kind"] != "algorithm", pair[1]["title"])):
        key = (item["kind"], int(item["id"] or 0), item["href"])
        if key in seen:
            continue
        seen.add(key)
        ranked.append(item)
        if len(ranked) >= limit:
            break
    return ranked


@router.get("/tooltip")
def tooltip(term: str = Query(..., min_length=1, max_length=140), limit: int = Query(default=8, ge=1, le=20)):
    if not isinstance(limit, int):
        limit = 8
    entries = _ranked_entries(term, limit)
    if not entries:
        return {"term": term, "source": "cliniccons", "matches": []}

    matches: list[dict] = []
    media: list[dict] = []
    seen_href: set[str] = set()
    seen_media: set[str] = set()

    for item in entries:
        match = {
            "id": int(item["id"] or 0),
            "title": item["title"],
            "href": item["href"],
            "source": "cliniccons",
            "kind": item["kind"],
        }
        if match["href"] not in seen_href:
            seen_href.add(match["href"])
            matches.append(match)

        for image in item.get("media") or []:
            if image["url"] in seen_media:
                continue
            seen_media.add(image["url"])
            media.append({"title": image.get("title") or item["title"], "url": image["url"]})
            matches.append({
                "id": int(item["id"] or 0),
                "title": image.get("title") or item["title"],
                "href": image["url"],
                "source": "cliniccons",
                "kind": "image",
            })
            if len(media) >= 4:
                break

    primary = entries[0]
    return {
        "term": term,
        "title": primary["title"],
        "source": "cliniccons",
        "kind": primary["kind"],
        "matches": matches[: max(limit, 8)],
        "abstract": primary.get("abstract") or "Clinic Consult algorithm",
        "media": media[:4],
        "html": "",
    }


def _image_file(filename: str) -> Path:
    safe = Path(filename).name
    if safe != filename or not re.search(r"\.(?:jpe?g|png|gif|webp)$", safe, re.I):
        raise HTTPException(422, "invalid image name")
    path = _image_dir() / safe
    if not path.is_file():
        raise HTTPException(404, "image not found")
    return path


@router.get("/image/{filename}")
def image(filename: str):
    path = _image_file(filename)
    return FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})


def _render_page(
    title: str,
    abstract: str,
    images: list[dict],
    sections: list[tuple[str, list[str] | str]],
    theme: str = "light",
) -> HTMLResponse:
    image_html = "\n".join(
        f'<figure><img src="/cliniccons/image/{html.escape(Path(img["filename"]).name)}" alt="{html.escape(img.get("title") or title)}">'
        f'<figcaption>{html.escape(img.get("title") or title)}</figcaption></figure>'
        for img in images
    )
    section_html = ""
    for heading, body in sections:
        if isinstance(body, list):
            items = "".join(f"<li>{html.escape(_clean(str(item)))}</li>" for item in body if _clean(str(item)))
            if items:
                section_html += f"<section><h2>{html.escape(heading)}</h2><ul>{items}</ul></section>"
        elif _clean(body):
            section_html += f"<section><h2>{html.escape(heading)}</h2><p>{html.escape(_clean(body))}</p></section>"

    dark = str(theme).lower() == "dark"
    theme_css = """
    :root { color-scheme: dark; }
    body { color: #e5edf8; background: #0b1020; }
    h1 { color: #f8fafc; }
    h2, .source, figcaption { color: #fbbf24; }
    p, ul, li { color: #cbd5e1; }
    figure {
      background: #111827;
      border-color: #3b4d66;
    }
    img { background: #ffffff; }
""" if dark else ""

    body = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    body {{ margin: 0; padding: 20px; font-family: Inter, Arial, sans-serif; color: #111827; background: #fff; line-height: 1.55; }}
    h1 {{ font-size: 24px; margin: 0 0 8px; }}
    h2 {{ font-size: 15px; margin: 22px 0 8px; color: #9a3412; text-transform: uppercase; letter-spacing: .06em; }}
    p {{ margin: 0 0 12px; color: #334155; }}
    ul {{ margin: 0; padding-left: 20px; color: #334155; }}
    li {{ margin: 0 0 8px; }}
    .source {{ color: #f97316; font-size: 11px; font-weight: 800; letter-spacing: .14em; margin-bottom: 8px; }}
    .abstract {{ max-width: 920px; }}
    .images {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 18px 0; }}
    figure {{ margin: 0; border: 1px solid #fed7aa; border-radius: 8px; overflow: hidden; background: #fff7ed; }}
    img {{ display: block; width: 100%; height: auto; object-fit: contain; background: #fff; }}
    figcaption {{ padding: 8px 10px; font-size: 12px; color: #9a3412; font-weight: 700; }}
{theme_css}
  </style>
</head>
<body>
  <div class="source">CLINIC CONSULT</div>
  <h1>{html.escape(title)}</h1>
  <p class="abstract">{html.escape(_clean(abstract))}</p>
  <div class="images">{image_html}</div>
  {section_html}
</body>
</html>"""
    return HTMLResponse(body, headers={"Cache-Control": "private, max-age=3600"})


@router.get("/algorithm/{doc_id}/html", response_class=HTMLResponse)
def algorithm_html(doc_id: int, theme: str = Query(default="light")):
    c = _conn()
    try:
        row = c.execute("SELECT * FROM algorithms WHERE document_id=?", (doc_id,)).fetchone()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, "algorithm not found")
    images = _image_payloads(row["images_json"])
    return _render_page(
        row["title"] or f"Algorithm {doc_id}",
        row["content_preview"] or "Clinic Consult algorithm",
        images,
        [("Preview", row["content_preview"] or "")],
        theme,
    )


@router.get("/disease/{doc_id}/html", response_class=HTMLResponse)
def disease_html(doc_id: int, theme: str = Query(default="light")):
    c = _conn()
    try:
        row = c.execute("SELECT * FROM diseases WHERE document_id=?", (doc_id,)).fetchone()
        refs = c.execute(
            "SELECT title, images_json FROM disease_algorithms WHERE disease_document_id=? ORDER BY match_score DESC, title",
            (doc_id,),
        ).fetchall()
    finally:
        c.close()
    if not row:
        raise HTTPException(404, "disease not found")

    images: list[dict] = []
    seen: set[str] = set()
    for ref in refs:
        for image in _image_payloads(ref["images_json"]):
            if image["filename"] not in seen:
                seen.add(image["filename"])
                images.append(image)

    return _render_page(
        row["disease_name"] or f"Disease {doc_id}",
        _primary_text(row),
        images,
        [
            ("Clinical Synthesis", [str(item) for item in _load_json_list(row["clinical_synthesis_json"])]),
            ("Treatment Pearls", [str(item) for item in _load_json_list(row["treatment_pearls_json"])]),
        ],
        theme,
    )

"""
Gold-standard / priority book registry for search ranking.

Books in the MedOS library are organized into subject folders (Nephrology,
Cardiology, ...). Within each subject one text is the field's standard
reference — Harrison for general internal medicine, Brenner & Rector for
nephrology, Braunwald for cardiology, Robbins for pathology, and so on. This
module recognises those texts and lets the search ranker push them above the
other books that also matched a query.

Two extra jobs:
  * Harrison's Principles of Internal Medicine ships in this library both as
    whole-book editions AND as a chapter-wise split whose files are named only
    "Part 01" … "Part 29". A path rule maps those split volumes back to the
    Harrison identity so they get Harrison's authority and a readable title
    instead of showing up as meaningless "Part 09" rows.
  * The user can mark any book as "priority" from the library UI; that override
    lives in the library state file and is merged on top of the defaults here.

Sources of truth, lowest → highest precedence:
  1. DEFAULTS below (curated, ships with the app).
  2. data/book_priority.json (optional, user-editable overlay).
  3. priority_books in <LIBRARY_PATH>/library_state.json (the UI ★ toggle).

The registry is consulted at query time, so it is cheap and side-effect free.
"""
from __future__ import annotations

import json
import re
import threading
from functools import lru_cache
from pathlib import Path

from config import ROOT, LIBRARY_PATH

PRIORITY_CONFIG: Path = ROOT / "data" / "book_priority.json"
_STATE_FILE: Path = LIBRARY_PATH / "library_state.json"

# Base bonus added to a matching book/chapter result's relevance score.
TIER_BONUS = {"universal": 115.0, "gold": 110.0, "authority": 60.0}
# Harrison is the general default — for most topics it should sit on top of the
# books. It surges when no single subspecialty clearly owns the topic.
GENERAL_DEFAULT_BONUS = 95.0
# A subspecialty standard (Brenner) surges past Harrison only for a topic its
# specialty clearly owns (a kidney topic → Brenner), which the search layer
# decides with a high-confidence subject signal. Otherwise Harrison stays first.
SUBJECT_OWNER_BONUS = 120.0
# Small edge for a clinical-subspecialty gold over a basic-science gold (Robbins,
# Guyton) on general topics, where no specialty owns the topic.
GOLD_CLINICAL_EDGE = 18.0

_VALID_TIERS = ("universal", "gold", "authority")


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (value or "").lower())).strip()


# A topic's "home" subject is usually its clinical subspecialty (minimal change
# disease → Nephrology), not the basic-science book that also describes it
# (Pathology). On a subject-inference tie, prefer the clinical subspecialty so
# the subspecialty standard (Brenner) leads over the general text (Robbins).
_CLINICAL_SPECIALTIES = {
    "nephrology", "cardiology", "neurology", "endocrinology", "pulmonology",
    "gastroenterology", "hematology oncology", "rheumatology", "infectious disease",
    "dermatology", "psychiatry", "pediatrics", "obstetrics gynecology", "surgery",
    "orthopedics", "emergency medicine", "anesthesiology", "radiology",
    "ophthalmology", "urology", "otolaryngology",
}
_BASIC_SCIENCES = {
    "pathology", "physiology", "anatomy", "biochemistry", "microbiology",
    "pharmacology", "immunology", "genetics", "histology", "embryology",
}


def subject_specificity(subject: str) -> int:
    """3 = clinical subspecialty, 1 = basic science, 0 = general/other.
    Used to break subject-inference ties toward the topic's clinical home."""
    s = _norm(subject)
    if s in _CLINICAL_SPECIALTIES:
        return 3
    if s in _BASIC_SCIENCES:
        return 1
    return 0


# ── Curated defaults ─────────────────────────────────────────────────────────
# `match` strings are normalized substrings (lowercase, alphanumeric, single
# spaces) tested against "<title> <folder> <book_id>". Keep them distinctive
# enough not to collide across subjects (prefer the author + work, e.g.
# "williams obstetrics" not bare "williams").

_DEFAULT_UNIVERSAL: list[dict] = [
    {"match": ["harrison"], "subject": "Internal Medicine"},
]

_DEFAULT_GOLD: list[dict] = [
    # Nephrology
    {"match": ["brenner and rector", "brenner rector"], "subject": "Nephrology",
     "display": "Brenner & Rector's The Kidney"},
    {"match": ["campbell walsh", "campbell walsh wein"], "subject": "Nephrology",
     "display": "Campbell-Walsh-Wein Urology"},
    {"match": ["handbook of dialysis"], "subject": "Nephrology", "tier": "authority"},
    # Cardiology
    {"match": ["braunwald"], "subject": "Cardiology", "display": "Braunwald's Heart Disease"},
    {"match": ["fuster and hurst", "hurst s the heart", "hursts the heart"], "subject": "Cardiology",
     "tier": "authority", "display": "Fuster & Hurst's The Heart"},
    # Pathology
    {"match": ["robbins"], "subject": "Pathology",
     "display": "Robbins & Cotran Pathologic Basis of Disease"},
    # Physiology
    {"match": ["guyton"], "subject": "Physiology", "display": "Guyton & Hall Textbook of Physiology"},
    {"match": ["ganong"], "subject": "Physiology", "tier": "authority"},
    # Anatomy
    {"match": ["grays anatomy", "gray s anatomy"], "subject": "Anatomy", "display": "Gray's Anatomy"},
    {"match": ["netter", "netter collection"], "subject": "Anatomy", "tier": "authority"},
    # Pediatrics
    {"match": ["nelson textbook", "nelson textbook of pediatrics"], "subject": "Pediatrics",
     "display": "Nelson Textbook of Pediatrics"},
    # Obstetrics & Gynecology
    {"match": ["williams obstetrics"], "subject": "Obstetrics & Gynecology",
     "display": "Williams Obstetrics"},
    {"match": ["dutta"], "subject": "Obstetrics & Gynecology", "tier": "authority"},
    # Surgery
    {"match": ["sabiston"], "subject": "Surgery", "display": "Sabiston Textbook of Surgery"},
    {"match": ["bailey and love", "bailey love"], "subject": "Surgery", "tier": "authority"},
    {"match": ["schwartz s principles", "schwartzs principles"], "subject": "Surgery", "tier": "authority"},
    # Infectious Disease
    {"match": ["mandell"], "subject": "Infectious Disease",
     "display": "Mandell, Douglas & Bennett's Infectious Diseases"},
    # Neurology
    {"match": ["adams and victor", "adams victor"], "subject": "Neurology",
     "display": "Adams & Victor's Principles of Neurology"},
    {"match": ["bradley and daroff", "bradley s neurology", "daroff"], "subject": "Neurology",
     "display": "Bradley & Daroff's Neurology in Clinical Practice"},
    {"match": ["youmans"], "subject": "Neurology", "tier": "authority"},
    # Rheumatology
    {"match": ["firestein", "kelley s textbook of rheumatology", "kelleys textbook of rheumatology"],
     "subject": "Rheumatology", "display": "Firestein & Kelley's Textbook of Rheumatology"},
    # Hematology-Oncology
    {"match": ["wintrobe"], "subject": "Hematology-Oncology", "display": "Wintrobe's Clinical Hematology"},
    {"match": ["devita"], "subject": "Hematology-Oncology",
     "display": "DeVita, Hellman & Rosenberg's Cancer: Principles & Practice of Oncology"},
    {"match": ["williams manual of hematology", "williams hematology"], "subject": "Hematology-Oncology",
     "tier": "authority"},
    # Pharmacology
    {"match": ["goodman and gilman", "goodman gilman", "gilman s"], "subject": "Pharmacology",
     "display": "Goodman & Gilman's The Pharmacological Basis of Therapeutics"},
    {"match": ["katzung"], "subject": "Pharmacology", "tier": "authority"},
    # Endocrinology
    {"match": ["williams textbook of endocrinology"], "subject": "Endocrinology",
     "display": "Williams Textbook of Endocrinology"},
    # Emergency Medicine
    {"match": ["tintinalli"], "subject": "Emergency Medicine", "display": "Tintinalli's Emergency Medicine"},
    # Pulmonology
    {"match": ["fishman"], "subject": "Pulmonology", "display": "Fishman's Pulmonary Diseases and Disorders"},
    {"match": ["murray and nadel", "murray nadel"], "subject": "Pulmonology", "tier": "authority"},
    # Biochemistry
    {"match": ["lehninger"], "subject": "Biochemistry", "display": "Lehninger Principles of Biochemistry"},
    {"match": ["harper s illustrated", "harpers illustrated", "harper illustrated"], "subject": "Biochemistry",
     "tier": "authority"},
    # Microbiology
    {"match": ["jawetz"], "subject": "Microbiology", "display": "Jawetz, Melnick & Adelberg's Medical Microbiology"},
    {"match": ["ananthanarayan"], "subject": "Microbiology",
     "display": "Ananthanarayan & Paniker's Textbook of Microbiology"},
    {"match": ["murray medical microbiology"], "subject": "Microbiology", "tier": "authority"},
    # Psychiatry
    {"match": ["kaplan and sadock", "kaplan sadock", "sadock"], "subject": "Psychiatry",
     "display": "Kaplan & Sadock's Synopsis of Psychiatry"},
    # Orthopedics
    {"match": ["campbell s operative orthopaedics", "campbells operative orthopaedics", "campbell operative"],
     "subject": "Orthopedics", "display": "Campbell's Operative Orthopaedics"},
    # Anesthesiology
    {"match": ["miller s anesthesia", "millers anesthesia"], "subject": "Anesthesiology",
     "display": "Miller's Anesthesia"},
    # USMLE
    {"match": ["first aid for the usmle"], "subject": "USMLE", "display": "First Aid for the USMLE"},
    # Internal Medicine — strong references behind Harrison
    {"match": ["davidson s principles", "davidsons principles", "davidson s essentials", "davidsons essentials"],
     "subject": "Internal Medicine", "tier": "authority"},
    {"match": ["goldman cecil", "cecil medicine"], "subject": "Internal Medicine", "tier": "authority"},
    {"match": ["oxford handbook of clinical medicine"], "subject": "Internal Medicine", "tier": "authority"},
    {"match": ["current medical diagnosis"], "subject": "Internal Medicine", "tier": "authority"},
]

# Map split/oddly-named files to a known identity. The Harrison chapter-wise
# split lives in the Internal Medicine folder as "Part 01" … "Part 29".
_DEFAULT_PATH_RULES: list[dict] = [
    {"folder": "Internal Medicine", "filename_regex": r"^part\s*\d+\b",
     "subject": "Internal Medicine", "tier": "universal",
     "display_prefix": "Harrison's Internal Medicine —"},
]


# ── Loading & caching ────────────────────────────────────────────────────────

_LOCK = threading.Lock()
_CACHE: dict | None = None
_CACHE_SIG: tuple | None = None


def _file_sig(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _coerce_entry(raw: dict, default_tier: str) -> dict | None:
    if not isinstance(raw, dict):
        return None
    matches_raw = raw.get("match")
    if isinstance(matches_raw, str):
        matches_raw = [matches_raw]
    matches = tuple(m for m in (_norm(x) for x in (matches_raw or [])) if m)
    if not matches:
        return None
    tier = str(raw.get("tier") or default_tier).lower()
    if tier not in _VALID_TIERS:
        tier = default_tier
    bonus = raw.get("bonus")
    return {
        "matches": matches,
        "subject": str(raw.get("subject") or "").strip(),
        "tier": tier,
        "display": str(raw.get("display") or "").strip(),
        "folder": _norm(raw.get("folder") or ""),
        "bonus": float(bonus) if isinstance(bonus, (int, float)) else None,
    }


def _coerce_path_rule(raw: dict) -> dict | None:
    if not isinstance(raw, dict) or not raw.get("filename_regex"):
        return None
    try:
        pattern = re.compile(str(raw["filename_regex"]), re.IGNORECASE)
    except re.error:
        return None
    tier = str(raw.get("tier") or "universal").lower()
    if tier not in _VALID_TIERS:
        tier = "universal"
    return {
        "folder": _norm(raw.get("folder") or ""),
        "pattern": pattern,
        "subject": str(raw.get("subject") or "").strip(),
        "tier": tier,
        "display_prefix": str(raw.get("display_prefix") or "").strip(),
    }


def _load_overrides_json() -> dict:
    if not PRIORITY_CONFIG.exists():
        return {}
    try:
        data = json.loads(PRIORITY_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _load_priority_books() -> dict[str, object]:
    """User ★ overrides from the library state: {book_id(posix): True|False|tier}."""
    if not _STATE_FILE.exists():
        return {}
    try:
        state = json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    raw = state.get("priority_books") if isinstance(state, dict) else None
    if not isinstance(raw, dict):
        return {}
    out: dict[str, object] = {}
    for key, value in raw.items():
        out[str(key).replace("\\", "/").lstrip("/")] = value
    return out


def _build_registry() -> dict:
    overlay = _load_overrides_json()
    universal = list(_DEFAULT_UNIVERSAL) + list(overlay.get("universal") or [])
    gold = list(_DEFAULT_GOLD) + list(overlay.get("gold_standard") or [])
    path_rules_raw = list(_DEFAULT_PATH_RULES) + list(overlay.get("path_rules") or [])

    entries: list[dict] = []
    for raw in universal:
        e = _coerce_entry(raw, "universal")
        if e:
            entries.append(e)
    for raw in gold:
        e = _coerce_entry(raw, "gold")
        if e:
            entries.append(e)
    path_rules = [r for r in (_coerce_path_rule(x) for x in path_rules_raw) if r]
    return {
        "entries": entries,
        "path_rules": path_rules,
        "priority_books": _load_priority_books(),
    }


def _registry() -> dict:
    global _CACHE, _CACHE_SIG
    sig = (_file_sig(PRIORITY_CONFIG), _file_sig(_STATE_FILE))
    if _CACHE is not None and _CACHE_SIG == sig:
        return _CACHE
    with _LOCK:
        if _CACHE is None or _CACHE_SIG != sig:
            _CACHE = _build_registry()
            _CACHE_SIG = sig
    return _CACHE


def refresh() -> None:
    """Drop the cached registry (call after the UI ★ toggle changes state)."""
    global _CACHE, _CACHE_SIG
    with _LOCK:
        _CACHE = None
        _CACHE_SIG = None
    classify.cache_clear()


# ── Classification ───────────────────────────────────────────────────────────

def _filename(book_id: str, title: str) -> str:
    book_id = (book_id or "").replace("\\", "/")
    if "/" in book_id:
        name = book_id.rsplit("/", 1)[-1]
    else:
        name = book_id or title
    return re.sub(r"\.pdf$", "", name, flags=re.IGNORECASE)


@lru_cache(maxsize=16384)
def classify(title: str = "", folder: str = "", book_id: str = "") -> dict | None:
    """Return the best registry match for a book, or None.

    Result dict: {tier, subject, bonus, display, source}. `source` is
    'user' | 'path_rule' | 'registry'. Cached (cleared by refresh()) — this is
    on the search hot path, called for every book candidate of every query, so
    it must not re-scan the registry or stat the config files each time. Callers
    treat the result as read-only.
    """
    reg = _registry()
    book_key = (book_id or "").replace("\\", "/").lstrip("/")
    folder_n = _norm(folder) or _norm(book_key.split("/")[0] if "/" in book_key else "")

    # 1. User ★ override (highest precedence).
    if book_key and book_key in reg["priority_books"]:
        value = reg["priority_books"][book_key]
        if not value:  # explicit False → force non-priority
            return None
        tier = value if isinstance(value, str) and value in _VALID_TIERS else "gold"
        return {"tier": tier, "subject": folder or "", "bonus": TIER_BONUS[tier],
                "display": "", "source": "user"}

    filename_n = _norm(_filename(book_key, title))

    # 2. Path rules (e.g. Harrison "Part NN" split volumes).
    for rule in reg["path_rules"]:
        if rule["folder"] and rule["folder"] != folder_n:
            continue
        if rule["pattern"].search(filename_n):
            return {"tier": rule["tier"], "subject": rule["subject"],
                    "bonus": TIER_BONUS[rule["tier"]], "display": "",
                    "display_prefix": rule["display_prefix"], "source": "path_rule"}

    # 3. Curated / overlay entries — best by tier then longest match.
    hay = _norm(f"{title} {folder} {book_key}")
    best: dict | None = None
    best_rank = (-1, -1)
    tier_rank = {"universal": 3, "gold": 2, "authority": 1}
    for e in reg["entries"]:
        if e["folder"] and e["folder"] != folder_n:
            continue
        hit = next((m for m in e["matches"] if m in hay), None)
        if not hit:
            continue
        rank = (tier_rank.get(e["tier"], 0), len(hit))
        if rank > best_rank:
            best_rank = rank
            best = e
    if best is None:
        return None
    return {"tier": best["tier"], "subject": best["subject"],
            "bonus": best["bonus"] if best["bonus"] is not None else TIER_BONUS[best["tier"]],
            "display": best["display"], "source": "registry"}


def _effective_subject(entry: dict | None, folder: str, book_id: str) -> str:
    """The subject a book counts as. The one definitive (gold) text reports its
    own subject; everything else reports the folder it lives in, so a Netter
    renal volume in Nephrology counts as Nephrology, not Anatomy."""
    if entry and entry["tier"] == "gold" and entry.get("subject"):
        return entry["subject"]
    if folder:
        return folder
    book_key = (book_id or "").replace("\\", "/").lstrip("/")
    return book_key.split("/")[0] if "/" in book_key else ""


def tier_bonus(title: str = "", folder: str = "", book_id: str = "", query_subject: str = "") -> float:
    """Ranking bonus for a book/chapter result.

    ``query_subject`` is the specialty the topic clearly belongs to (or "" when
    no single specialty owns it). Policy:
      * Harrison (universal) — the general default. Surges (+GENERAL_DEFAULT_BONUS)
        when no specialty owns the topic, so it leads most searches.
      * A subspecialty gold (Brenner) — surges (+SUBJECT_OWNER_BONUS) past Harrison
        only for a topic its specialty owns; otherwise it sits below Harrison.
      * A clinical gold on a general topic gets a small edge over a basic-science
        gold (Robbins, Guyton).
    """
    e = classify(title, folder, book_id)
    if not e:
        return 0.0
    bonus = float(e["bonus"])
    owns = bool(query_subject)
    if e["tier"] == "universal":
        if not owns:
            bonus += GENERAL_DEFAULT_BONUS
        return bonus
    if e["tier"] == "gold":
        subject = _effective_subject(e, folder, book_id)
        if owns and _norm(query_subject) == _norm(subject):
            bonus += SUBJECT_OWNER_BONUS
        elif not owns and subject_specificity(subject) >= 3:
            bonus += GOLD_CLINICAL_EDGE
    return bonus


def base_bonus(title: str = "", folder: str = "", book_id: str = "") -> float:
    """Query-independent priority bonus for the offline index weight.

    Bakes only the tier base (+ a small clinical edge for clinical golds); the
    query-time, subject-aware policy lives in tier_bonus() so it is applied once,
    at search time, not double-counted here.
    """
    e = classify(title, folder, book_id)
    if not e:
        return 0.0
    bonus = float(e["bonus"])
    if e["tier"] == "gold" and subject_specificity(_effective_subject(e, folder, book_id)) >= 3:
        bonus += GOLD_CLINICAL_EDGE
    return bonus


def bonus_for_text(text: str, query_subject: str = "") -> float:
    """Back-compat helper for callers that only have a blob of text.

    Prefer tier_bonus() with structured (title, folder, book_id) when available.
    """
    return tier_bonus(title=text, folder="", book_id="", query_subject=query_subject)


def subject_of(title: str = "", folder: str = "", book_id: str = "") -> str:
    """The subject a book represents for query-subject inference.

    The one definitive (gold) text reports its own subject; a universal text
    (Harrison) or a cross-subject set (Netter) reports the folder it lives in so
    it does not bias inference toward the wrong specialty.
    """
    return _effective_subject(classify(title, folder, book_id), folder, book_id)


def display_title(title: str = "", folder: str = "", book_id: str = "") -> str:
    """A clean book label for results — fixes split/oddly-named files."""
    e = classify(title, folder, book_id)
    if not e:
        return title
    if e.get("source") == "path_rule" and e.get("display_prefix"):
        return f"{e['display_prefix']} {title}".strip()
    if e.get("display"):
        return e["display"]
    return title


def is_priority(title: str = "", folder: str = "", book_id: str = "") -> bool:
    e = classify(title, folder, book_id)
    return bool(e) and e["tier"] in ("universal", "gold")

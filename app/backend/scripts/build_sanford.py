"""
build_sanford.py — normalize the Sanford Guide (Antimicrobial Therapy) bundle
into data/sanfordguide/sanford.sqlite.

Source (UNENCRYPTED): data/sanfordguide/sanfordguide/  — the richer of the two
shipped editions. It is an unpacked static-HTML mobile app:
  - FTS.db  → search_base(path, searchableText, keywords, subject, title,
              contentType, tradeName)   (1,248 topics; path = slug, no .html)
  - <slug>.html  → a full standalone page per topic (vendor CSS/JS + Sanford
              custom elements + the real clinical body)
  - *.png/*.jpg  → figures referenced by some topics

We sanitize each body once (strip vendor chrome, rewrite internal links to
data-slugs the reader intercepts, rewrite <img> to /sanford/asset/<name>) and
emit a normalized table the reader serves directly — so the runtime never parses
raw HTML. Re-runnable: writes sanford.sqlite.tmp then atomically replaces.

Run:  python scripts/build_sanford.py
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/ on path
from config import SANFORD_ASSET_DIR, SANFORD_DB  # noqa: E402

try:
    from bs4 import BeautifulSoup
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"BeautifulSoup (bs4) required: {exc}")

SRC_DIR = Path(SANFORD_ASSET_DIR)
SRC_FTS = SRC_DIR / "FTS.db"

# Sanford's numeric contentType codes → human labels + coarse kind. Derived by
# sampling titles per code (drugs carry tradeName; organisms are pathogen pages).
CONTENT_TYPES: dict[str, tuple[str, str]] = {
    "0": ("Reference", "reference"),
    "1": ("Clinical Condition", "condition"),
    "2": ("Antimicrobial", "drug"),
    "3": ("Organism", "organism"),
    "4": ("Prophylaxis & Prevention", "prophylaxis"),
    "5": ("HIV / Specialty", "condition"),
    "6": ("Hepatitis", "condition"),
    "7": ("Tools & Tables", "tool"),
    "8": ("Vaccines", "vaccine"),
}

# Sanford custom / chrome elements that carry no clinical content.
STRIP_TAGS = ["script", "style", "link", "meta", "guidetoc", "bookmarkcontrols",
              "versioninfo", "usernotes", "stewardshipalerts", "noscript"]
STRIP_IDS = ["content-page-header"]  # duplicates the topic title we render ourselves


def sanitize(html: str) -> tuple[str, str]:
    """Return (clean_body_html, plain_text) for one Sanford topic page."""
    soup = BeautifulSoup(html, "html.parser")
    root = soup.find(id="mobile-container-div") or soup.body or soup

    for tag_name in STRIP_TAGS:
        for t in root.find_all(tag_name):
            t.decompose()
    for _id in STRIP_IDS:
        for t in root.find_all(id=_id):
            t.decompose()

    # Rewrite anchors: internal *.html → data-slug the reader opens in-app;
    # external → new tab; drop dead href="#".
    for a in root.find_all("a"):
        href = (a.get("href") or "").strip()
        if href.lower().endswith(".html"):
            slug = re.sub(r"\.html$", "", href.split("/")[-1], flags=re.I)
            a["data-sanford-slug"] = slug
            a["class"] = (a.get("class") or []) + ["sanford-internal-link"]
            a["href"] = "#"
        elif href.startswith(("http://", "https://")):
            a["target"] = "_blank"
            a["rel"] = "noopener noreferrer"
        elif href == "#" or not href:
            a.attrs.pop("href", None)

    # Rewrite images to the reader's asset route (skip absolute/data URIs).
    for img in root.find_all("img"):
        src = (img.get("src") or "").strip()
        if src and not src.startswith(("http://", "https://", "data:", "/")):
            img["src"] = f"/sanford/asset/{src.split('/')[-1]}"
        img["loading"] = "lazy"

    # Drop inline event handlers.
    for t in root.find_all(True):
        for attr in list(t.attrs):
            if attr.lower().startswith("on"):
                del t[attr]

    inner = root.decode_contents() if hasattr(root, "decode_contents") else str(root)
    plain = re.sub(r"\s+", " ", root.get_text(" ", strip=True)).strip()
    return inner.strip(), plain


def build() -> None:
    if not SRC_FTS.exists():
        raise SystemExit(f"Sanford source FTS.db not found at {SRC_FTS}")

    src = sqlite3.connect(f"file:{SRC_FTS}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    rows = src.execute(
        "SELECT path, title, subject, keywords, contentType, tradeName, "
        "searchableText FROM search_base WHERE title IS NOT NULL AND title <> ''"
    ).fetchall()
    src.close()

    tmp = Path(str(SANFORD_DB) + ".tmp")
    if tmp.exists():
        tmp.unlink()
    out = sqlite3.connect(str(tmp))
    out.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE sanford_topics (
            id            INTEGER PRIMARY KEY,
            slug          TEXT UNIQUE,
            title         TEXT NOT NULL,
            subject       TEXT,
            content_type  TEXT,          -- numeric code as-is
            content_label TEXT,          -- human label
            kind          TEXT,          -- drug|organism|condition|prophylaxis|tool|vaccine|reference
            trade_name    TEXT,
            keywords      TEXT,
            is_drug       INTEGER DEFAULT 0,
            body_html     TEXT,
            plain_text    TEXT
        );
        CREATE VIRTUAL TABLE sanford_fts USING fts5(
            title, trade_name, keywords, subject, body,
            tokenize='porter unicode61'
        );
        CREATE INDEX idx_sanford_kind  ON sanford_topics(kind);
        CREATE INDEX idx_sanford_label ON sanford_topics(content_label);
        """
    )

    n = 0
    missing = 0
    for tid, r in enumerate(rows, start=1):
        slug = r["path"]
        html_path = SRC_DIR / f"{slug}.html"
        if not html_path.exists():
            missing += 1
            body_html, plain = "", ""
        else:
            raw = html_path.read_text(encoding="utf-8", errors="replace")
            body_html, plain = sanitize(raw)
        if not plain:
            plain = r["searchableText"] or r["title"]

        ct = str(r["contentType"] or "")
        label, kind = CONTENT_TYPES.get(ct, ("Reference", "reference"))
        is_drug = 1 if kind == "drug" else 0

        out.execute(
            "INSERT INTO sanford_topics(id, slug, title, subject, content_type, "
            "content_label, kind, trade_name, keywords, is_drug, body_html, plain_text) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            (tid, slug, r["title"], (r["subject"] or "").strip(), ct, label, kind,
             (r["tradeName"] or "").strip(), (r["keywords"] or "").strip(),
             is_drug, body_html, plain),
        )
        out.execute(
            "INSERT INTO sanford_fts(rowid, title, trade_name, keywords, subject, body) "
            "VALUES(?,?,?,?,?,?)",
            (tid, r["title"], (r["tradeName"] or ""), (r["keywords"] or ""),
             (r["subject"] or ""), plain),
        )
        n += 1

    out.commit()
    out.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    out.execute("PRAGMA optimize")
    out.close()

    os.replace(tmp, SANFORD_DB)
    print(f"[build_sanford] wrote {SANFORD_DB}  topics={n}  missing_html={missing}")


if __name__ == "__main__":
    build()

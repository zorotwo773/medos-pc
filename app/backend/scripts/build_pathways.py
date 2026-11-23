"""Normalize the UpToDate Pathways bundle into a clean graph DB for MedOS.

The shipped bundle (`data/utdpathways/utdpathways.db`) stores 132 interactive
clinical decision trees as **v2-encrypted HTML** in the `Docs` table. Each doc
decrypts (same AES-256-GCM scheme as the qbank/UWorld-library content, AAD
`"{doc_id}|128"`, key `sha256("YHYZYNVLBEKPQCGDWFNPDAAIO")`) to an Angular shell
whose `window.inlineDt = "<json>"` carries the full tree:

    nodes{}  — contentNode  (a decision step: title, questionForChildren, variable)
               contentLink  (an answer branch: from/to, shortLabel)
               extensionNode(teaching HTML in extension.content)
               extensionLink / rootNode
    resources{} — utd-MED topics, utd-DRG drugs, utd-Graphic, sibling pathways, …

Decrypting + parsing 500 KB of HTML per request would be slow and would break the
shipped-offline build, so this importer does it once and writes a normalized
**`data/utdpathways/pathways.sqlite`** the runtime reader serves directly:

    specialties(id, name, sort)                        — from the source TOC
    pathways(id, content_id, title, specialty_id,
             root_id, scope_html, num_steps,
             num_decisions, num_outcomes, est_minutes)
    pathway_graph(pathway_id, graph_json)              — one clean graph per pathway

`graph_json` shape (what the frontend consumes):
    { rootId, nodes:{ id:{ kind, title, titleHtml, question, variable,
                            teachingHtml, resourceKeys[], branches:[{to,label}] } },
      resources:{ key:{ type, route, label, contentId, inlineHtml } } }

Usage:  python scripts/build_pathways.py [--dry-run] [--limit N]
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import html as _html
import io
import json
import re
import sqlite3
import sys
import urllib.parse
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config import PATHWAYS_SRC_DB, PATHWAYS_DB  # noqa: E402

try:
    from Crypto.Cipher import AES  # pycryptodome
except ImportError:  # pragma: no cover
    sys.exit("pycryptodome is required (Crypto.Cipher.AES). pip install pycryptodome")


# ── v2 decryption (identical to qbank_reader._decrypt_v2 / uworld reader) ─────
_V2_PREFIX = "v2:"
_V2_KEY = hashlib.sha256(b"YHYZYNVLBEKPQCGDWFNPDAAIO").digest()


def _decrypt_doc(doc_id: int, payload: str) -> str:
    blob = base64.b64decode(payload[len(_V2_PREFIX):].strip())
    if len(blob) < 31 or blob[0] != 2:
        raise ValueError("malformed v2 blob")
    flags, nonce, tag, ct = blob[1], blob[2:14], blob[-16:], blob[14:-16]
    cipher = AES.new(_V2_KEY, AES.MODE_GCM, nonce=nonce)
    cipher.update(f"{doc_id}|128".encode("utf-8"))
    raw = cipher.decrypt_and_verify(ct, tag)
    if flags & 1:
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", "replace")


def _extract_inline_dt(html: str) -> dict | None:
    """Return the parsed tree dict from the last `window.inlineDt = "..."`."""
    occ = list(re.finditer(r'window\.inlineDt\s*=\s*', html))
    if not occ:
        return None
    start = occ[-1].end()
    if start >= len(html) or html[start] != '"':
        return None
    j = start + 1
    buf = []
    while j < len(html):
        ch = html[j]
        if ch == "\\":
            buf.append(html[j:j + 2]); j += 2; continue
        if ch == '"':
            break
        buf.append(ch); j += 1
    raw = "".join(buf)
    try:
        out = json.loads(_js_unescape(raw))
        return out if isinstance(out, dict) else None
    except Exception:
        return None


# JS-string escapes that JSON does not share and must be collapsed to reveal the
# embedded JSON document. `\"`/`\\` also expose the JSON layer; `\'`/`\/` are
# JS-only. Every other escape (`\n`, `\t`, `\uXXXX`, …) is left intact for
# json.loads, and real UTF-8 bytes (≥, ≤, µ) pass through untouched — unlike
# `decode("unicode_escape")`, which corrupts multi-byte characters (≥ → â¥).
_JS_COLLAPSE = {'"': '"', "\\": "\\", "/": "/", "'": "'"}


def _js_unescape(s: str) -> str:
    out: list[str] = []
    i, n, bs = 0, len(s), "\\"
    while i < n:
        ch = s[i]
        if ch == bs and i + 1 < n:
            nxt = s[i + 1]
            if nxt in _JS_COLLAPSE:
                out.append(_JS_COLLAPSE[nxt]); i += 2; continue
            out.append(ch); out.append(nxt); i += 2; continue
        out.append(ch); i += 1
    return "".join(out)


# ── HTML helpers ──────────────────────────────────────────────────────────────
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
# A resource reference inside teaching HTML:
#   <span ... tf-resource-id="KEY" ...>text</span>
_RES_SPAN_RE = re.compile(
    r'<span\b([^>]*?)\btf-resource-id="(?P<key>[^"]+)"([^>]*)>(?P<text>.*?)</span>',
    re.IGNORECASE | re.DOTALL,
)
# After clean_html, resource references live as <a data-res="KEY">.
_DATA_RES_RE = re.compile(r'data-res="([^"]+)"')
_STYLE_ATTR_RE = re.compile(r'\s+style="[^"]*"', re.IGNORECASE)
_EDIT_ATTR_RE = re.compile(r'\s+contenteditable="[^"]*"', re.IGNORECASE)
_TFATTR_RE = re.compile(r'\s+tf-[\w-]+="[^"]*"', re.IGNORECASE)
_CLASS_ATTR_RE = re.compile(r'\s+class="[^"]*"', re.IGNORECASE)
_EMPTY_RE = re.compile(r"^(?:\s|&nbsp;| )*$")

# Legal boilerplate we never want to surface as teaching.
_DISCLAIMER_MARKERS = (
    "Licensed Materials describe basic principles",
    "no substitute for individual patient assessment",
)


def strip_text(h: str | None) -> str:
    if not h:
        return ""
    t = _TAG_RE.sub(" ", h)
    t = _html.unescape(t)
    return _WS_RE.sub(" ", t).strip()


def clean_html(h: str | None) -> str:
    """Light clean for display: rewrite resource spans → anchors, drop app cruft."""
    if not h:
        return ""
    def _res(m: re.Match) -> str:
        key = m.group("key")
        text = m.group("text")
        return f'<a data-res="{key}" class="pw-res">{text}</a>'
    out = _RES_SPAN_RE.sub(_res, h)
    out = _EDIT_ATTR_RE.sub("", out)
    out = _STYLE_ATTR_RE.sub("", out)
    out = _TFATTR_RE.sub("", out)
    # keep class only on our injected anchors
    out = re.sub(r'<(?!a\b)([a-z0-9]+)((?:\s+class="[^"]*")+)', lambda m: f"<{m.group(1)}", out, flags=re.IGNORECASE)
    out = _WS_RE.sub(" ", out).strip()
    return out


def is_disclaimer(text: str) -> bool:
    return any(mk in text for mk in _DISCLAIMER_MARKERS)


# ── Resource → MedOS route resolution ─────────────────────────────────────────
def resolve_resource(res: dict, content_to_pathway: dict[int, int]) -> dict:
    """Map one source resource to a MedOS-native chip descriptor."""
    rtype = res.get("resourceType") or res.get("type") or ""
    text = strip_text(res.get("text") or res.get("title") or "")
    cid = res.get("contentId")
    try:
        cid = int(cid) if cid is not None else None
    except (TypeError, ValueError):
        cid = None
    out = {"type": rtype, "label": text, "contentId": cid, "route": None, "inlineHtml": None}

    # UTD content topics (medical, patient-education, guideline-link, lab-i) all
    # open in the existing UpToDate reader by their shared content id.
    if rtype in ("utd-MED", "utd-PAT", "utd-Society_Guidelines", "utd-LabI") and cid:
        out["type"] = "topic"
        out["route"] = f"/uptodate?t={cid}"
    elif rtype == "utd-Graphic" and cid:
        out["type"] = "graphic"
        out["route"] = f"graphic:{cid}"           # frontend opens the graphic drawer
    elif rtype == "utd-DRG":
        out["type"] = "drug"
        out["route"] = f"/drugs?q={urllib.parse.quote(text)}" if text else None
    elif rtype == "utd-Pathway" and cid is not None:
        out["type"] = "pathway"
        target = content_to_pathway.get(cid)
        out["route"] = f"/pathways?p={target}" if target else None
    elif rtype in ("infoPopup", "section"):
        out["type"] = "info"
        out["inlineHtml"] = clean_html(res.get("content"))
        if not out["label"]:
            out["label"] = strip_text(res.get("title"))
    elif rtype == "utd-authors":
        out["type"] = "authors"
        out["inlineHtml"] = clean_html(res.get("content"))
    else:
        out["type"] = rtype or "ref"
        if res.get("content"):
            out["type"] = "info"
            out["inlineHtml"] = clean_html(res.get("content"))
    return out


# ── Tree normalization ────────────────────────────────────────────────────────
def branch_label(link: dict, child: dict) -> str:
    for cand in (link.get("shortLabel"), child.get("shortTitle"), child.get("title")):
        t = strip_text(cand)
        if t:
            words = t.split()
            return " ".join(words[:9]) + ("…" if len(words) > 9 else "")
    return ""


def node_teaching(node: dict, nodes: dict) -> tuple[str, list[str]]:
    """Concatenate a node's extension-content teaching; return (html, resourceKeys)."""
    pieces: list[str] = []
    keys: list[str] = []
    for ext_link_id in node.get("extensionIds", []) or []:
        link = nodes.get(ext_link_id)
        if not link or link.get("type") != "extensionLink":
            continue
        ext_node = nodes.get(link.get("to"))
        if not ext_node:
            continue
        ext = ext_node.get("extension") or {}
        content = ext.get("content")
        if not content:
            continue
        text = strip_text(content)
        if not text or _EMPTY_RE.match(text) or is_disclaimer(text):
            continue
        pieces.append(clean_html(content))
    for k in node.get("resourceIds", []) or []:
        if k:
            keys.append(k)
    return ("\n".join(pieces), keys)


def normalize(tree: dict, content_to_pathway: dict[int, int]) -> tuple[dict, dict, str]:
    """Return (graph, stats, scope_html) for one pathway tree."""
    nodes = tree.get("nodes", {})
    resources = tree.get("resources", {}) or {}

    # entry node
    root_ref = tree.get("rootNodeId")
    root_node = nodes.get(root_ref, {})
    if root_node.get("type") == "contentNode":
        root_id = root_ref
    else:
        root_id = root_node.get("contentId") or (root_node.get("childrenIds") or [None])[0]

    out_nodes: dict[str, dict] = {}
    referenced: set[str] = set()
    n_dec = n_out = 0

    for nid, node in nodes.items():
        if node.get("type") != "contentNode":
            continue
        branches = []
        for clid in node.get("childrenIds", []) or []:
            link = nodes.get(clid)
            if not link or link.get("type") != "contentLink":
                continue
            child = nodes.get(link.get("to"))
            if not child or child.get("type") != "contentNode":
                continue
            branches.append({"to": link["to"], "label": branch_label(link, child)})
        question = strip_text(node.get("questionForChildren"))
        teaching, rkeys = node_teaching(node, nodes)
        title_html = clean_html(node.get("title"))
        # every resource surfaced to the user is referenced as data-res="KEY"
        for m in _DATA_RES_RE.finditer(teaching + " " + title_html):
            referenced.add(m.group(1))
        for k in rkeys:
            referenced.add(k)
        if not branches:
            kind = "outcome"; n_out += 1
        elif question and len(branches) >= 2:
            kind = "decision"; n_dec += 1
        else:
            kind = "action"
        out_nodes[nid] = {
            "kind": kind,
            "title": strip_text(node.get("title")),
            "titleHtml": title_html,
            "question": question,
            "variable": node.get("variable") or "",
            "teachingHtml": teaching,
            "resourceKeys": rkeys,
            "branches": branches,
        }

    # Resolve every resource in the map so any data-res anchor always resolves.
    out_res: dict[str, dict] = {}
    for key, r in resources.items():
        if isinstance(r, dict):
            out_res[key] = resolve_resource(r, content_to_pathway)

    # scope = the root node's teaching
    scope_html = out_nodes.get(root_id, {}).get("teachingHtml", "") if root_id else ""

    graph = {"rootId": root_id, "nodes": out_nodes, "resources": out_res}
    stats = {"steps": len(out_nodes), "decisions": n_dec, "outcomes": n_out,
             "res_refs": len(referenced), "res_resolved": len(out_res)}
    return graph, stats, scope_html


# ── Main build ────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE specialties (id INTEGER PRIMARY KEY, name TEXT, sort INTEGER);
CREATE TABLE pathways (
    id INTEGER PRIMARY KEY, content_id INTEGER, title TEXT,
    specialty_id INTEGER, root_id TEXT, scope_html TEXT,
    num_steps INTEGER, num_decisions INTEGER, num_outcomes INTEGER,
    est_minutes INTEGER
);
CREATE TABLE pathway_graph (pathway_id INTEGER PRIMARY KEY, graph_json TEXT);
CREATE INDEX ix_pathways_specialty ON pathways(specialty_id);
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Parse only; do not write the DB.")
    ap.add_argument("--limit", type=int, default=0, help="Only process the first N docs.")
    args = ap.parse_args()

    src_path = Path(PATHWAYS_SRC_DB)
    if not src_path.exists():
        sys.exit(f"source bundle not found: {src_path}")
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row

    # TOC → specialties + pathway→specialty map
    specialties: list[tuple[int, str, int]] = []
    pathway_specialty: dict[int, int] = {}
    for row in src.execute("SELECT id, name, docId, parentId, leaf FROM TOC"):
        if row["parentId"] == 0 and (row["docId"] or 0) == 0:
            specialties.append((row["id"], row["name"], row["id"]))
        elif (row["docId"] or 0) > 0:
            pathway_specialty.setdefault(int(row["docId"]), int(row["parentId"]))

    docs = src.execute("SELECT id, title, path, doc FROM Docs ORDER BY id").fetchall()
    if args.limit:
        docs = docs[: args.limit]

    # Pass 1: decrypt + extract every tree, and build contentId→pathway.id map.
    trees: dict[int, dict] = {}
    content_to_pathway: dict[int, int] = {}
    fails: list[tuple[int, str]] = []
    for d in docs:
        try:
            html = _decrypt_doc(d["id"], d["doc"])
            tree = _extract_inline_dt(html)
            if not tree or "nodes" not in tree:
                fails.append((d["id"], "no tree")); continue
            trees[d["id"]] = tree
            try:
                content_to_pathway[int(tree.get("id"))] = d["id"]
            except (TypeError, ValueError):
                pass
        except Exception as e:  # noqa: BLE001
            fails.append((d["id"], str(e)[:80]))

    # Pass 2: normalize each tree.
    pathways_rows = []
    graph_rows = []
    agg = Counter()
    label_have = label_total = 0
    res_type_counter: Counter = Counter()
    for d in docs:
        tree = trees.get(d["id"])
        if not tree:
            continue
        graph, stats, scope_html = normalize(tree, content_to_pathway)
        agg["steps"] += stats["steps"]
        agg["decisions"] += stats["decisions"]
        agg["outcomes"] += stats["outcomes"]
        agg["res_refs"] += stats["res_refs"]
        agg["res_resolved"] += stats["res_resolved"]
        for n in graph["nodes"].values():
            for b in n["branches"]:
                label_total += 1
                if b["label"]:
                    label_have += 1
        for r in graph["resources"].values():
            res_type_counter[r["type"]] += 1
        est = max(3, round(stats["decisions"] * 0.75) or 3)
        pathways_rows.append((
            d["id"], _int_or_none(tree.get("id")), d["title"],
            pathway_specialty.get(d["id"]), graph["rootId"], scope_html,
            stats["steps"], stats["decisions"], stats["outcomes"], est,
        ))
        graph_rows.append((d["id"], json.dumps(graph, ensure_ascii=False, separators=(",", ":"))))

    # ── report ──
    print(f"decrypted+parsed : {len(trees)}/{len(docs)} pathways   failures: {len(fails)}")
    for fid, msg in fails[:10]:
        print(f"   FAIL doc {fid}: {msg}")
    print(f"specialties      : {len(specialties)}")
    print(f"decision steps   : {agg['steps']}  (decisions {agg['decisions']}, outcomes {agg['outcomes']})")
    print(f"branch labels    : {label_have}/{label_total} populated "
          f"({100 * label_have // max(1, label_total)}%)")
    print(f"resource refs    : {agg['res_refs']} referenced, {agg['res_resolved']} resolved")
    print(f"resource types   : {dict(res_type_counter)}")
    print(f"sibling-pathway map: {len(content_to_pathway)} contentIds")
    _sample_utd_check(content_to_pathway, graph_rows)

    if args.dry_run:
        print("[dry-run] not writing DB.")
        return

    out_path = Path(PATHWAYS_DB)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()
    dst = sqlite3.connect(str(out_path))
    dst.executescript(SCHEMA)
    dst.executemany("INSERT INTO specialties(id,name,sort) VALUES (?,?,?)", specialties)
    dst.executemany(
        "INSERT INTO pathways(id,content_id,title,specialty_id,root_id,scope_html,"
        "num_steps,num_decisions,num_outcomes,est_minutes) VALUES (?,?,?,?,?,?,?,?,?,?)",
        pathways_rows,
    )
    dst.executemany("INSERT INTO pathway_graph(pathway_id,graph_json) VALUES (?,?)", graph_rows)
    dst.commit()
    dst.execute("VACUUM")
    dst.close()
    print(f"\nwrote {out_path}  ({out_path.stat().st_size // 1024} KB, "
          f"{len(pathways_rows)} pathways)")


def _int_or_none(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _sample_utd_check(content_to_pathway: dict, graph_rows: list) -> None:
    """Best-effort: confirm a few utd-MED contentIds resolve to real UTD topics."""
    try:
        import utd_reader  # noqa
        # gather a handful of topic contentIds
        cids: list[int] = []
        for _pid, gj in graph_rows[:20]:
            g = json.loads(gj)
            for r in g["resources"].values():
                if r["type"] == "topic" and r["contentId"]:
                    cids.append(r["contentId"])
            if len(cids) >= 15:
                break
        if not cids:
            return
        hits = 0
        for cid in cids[:15]:
            try:
                if utd_reader.get_topic_html(cid):  # type: ignore[attr-defined]
                    hits += 1
            except Exception:
                pass
        print(f"utd topic check  : {hits}/{min(15, len(cids))} sampled contentIds resolved")
    except Exception:
        # utd_reader API differs / unavailable — skip silently (id-space is shared).
        pass


if __name__ == "__main__":
    main()

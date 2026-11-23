#!/usr/bin/env python3
"""Import staged MedRoxi export into PC MedOS.

Idempotent / update-in-place:
  * one stable bank folder/key:  imported-medroxi
  * stable question IDs = MedRoxi question IDs (never renumbered)
  * re-running updates changed rows and skips identical ones; no duplicates
  * progress is UNION-merged for admin@medos; existing progress is never erased
No token/password is read, stored, or printed by this script.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import re
import sqlite3
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import websockets

STAGE = Path(r"C:\MedOS\data\imported\medroxi")
BANK_ROOT = Path(r"C:\MedOS\data\qbanks-imported")
BANK_KEY = "imported-medroxi"
BANK_DIR = BANK_ROOT / BANK_KEY
DB_PATH = BANK_DIR / f"{BANK_KEY}.db"
META_PATH = BANK_DIR / "imported.json"
CATALOG_PATH = BANK_DIR / "catalog.json"
MEDIA_DIR = BANK_DIR / "media-E"
STATE_DB = Path(r"C:\MedOS\data\qbank_state.sqlite3")
USER_EMAIL = "admin@medos"
CDP_LIST = "http://127.0.0.1:9222/json/list"
PLAIN = "medos-plain:"
SOURCE_KIND = "medroxi"

SCHEMA = """
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS Questions (
    id INTEGER NOT NULL PRIMARY KEY,
    question TEXT, explanation TEXT, corrAns INTEGER, subId INTEGER,
    sysId INTEGER, pplTaken REAL, corrTaken REAL, lastUpdated TEXT,
    title TEXT, questionType INTEGER, questionFormatType INTEGER,
    mediaName TEXT, otherMedias TEXT, parentQId INTEGER
);
CREATE TABLE IF NOT EXISTS Answers (
    id INTEGER NOT NULL PRIMARY KEY, qId INTEGER, answerId INTEGER,
    answerText TEXT, correctPercentage INTEGER
);
CREATE TABLE IF NOT EXISTS Subjects (id INTEGER NOT NULL PRIMARY KEY, name TEXT, count INTEGER);
CREATE TABLE IF NOT EXISTS Systems (id INTEGER NOT NULL PRIMARY KEY, name TEXT, count INTEGER);
CREATE TABLE IF NOT EXISTS SubjectsSystems (
    subId INTEGER, sysId INTEGER, count INTEGER, PRIMARY KEY (subId, sysId)
);
CREATE VIRTUAL TABLE IF NOT EXISTS Search USING fts4(
    text, content, type, typeText, contentId, tokenize=porter
);
CREATE TABLE IF NOT EXISTS Refs (
    id INTEGER NOT NULL PRIMARY KEY, qId INTEGER,
    refTitle TEXT, refLink TEXT, refType INTEGER
);
CREATE TABLE IF NOT EXISTS SourceMetadata (
    qId INTEGER NOT NULL PRIMARY KEY,
    sourceId TEXT NOT NULL UNIQUE,
    sourceKind TEXT NOT NULL,
    tags TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_qid ON Answers(qId, answerId);
CREATE INDEX IF NOT EXISTS idx_refs_qid ON Refs(qId);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON Questions(subId);
CREATE INDEX IF NOT EXISTS idx_questions_system ON Questions(sysId);
"""

# ── helpers ──────────────────────────────────────────────────────────────────


def clean(value: object) -> str:
    return re.sub(r"[ \t\u00a0]+", " ", str(value or "").replace("\r", " ")).strip()


def plain_text(value: object) -> str:
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    return clean(html.unescape(text))


def text_to_html(value: object, qid: int | None = None, images: list[str] | None = None) -> str:
    """Plain MedRoxi text -> MedOS plaintext-marked HTML, images appended."""
    raw = str(value or "").replace("\r", "")
    parts = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]
    chunks = ["<p>" + html.escape(p).replace("\n", "<br>") + "</p>" for p in parts]
    for url in images or []:
        name = Path(url).name
        prefix = f"/qbank/media/{qid}" if qid else "/qbank/media/0"
        chunks.append(f'<p><img src="{prefix}/{name}"></p>')
    return "".join(chunks) or "<p></p>"


def insert_search(conn: sqlite3.Connection, content: str, kind: int, kind_text: str, qid: int) -> None:
    value = plain_text(content)
    if value:
        conn.execute(
            "INSERT INTO Search(text,content,type,typeText,contentId) VALUES (?,?,?,?,?)",
            (value, value, kind, kind_text, qid),
        )


def find_medroxi_ws() -> str | None:
    try:
        with urllib.request.urlopen(CDP_LIST, timeout=6) as r:
            targets = json.load(r)
    except Exception:
        return None
    for t in targets:
        if t.get("type") == "page" and str(t.get("url", "")).startswith("https://medroxi.site/"):
            return t.get("webSocketDebuggerUrl")
    return None


async def evaluate(ws, expression: str, msg_id: int, timeout: float = 120.0):
    await ws.send(json.dumps({
        "id": msg_id,
        "method": "Runtime.evaluate",
        "params": {"expression": expression, "returnByValue": True, "awaitPromise": True},
    }))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))
        if msg.get("id") != msg_id:
            continue
        if "exceptionDetails" in msg:
            detail = msg["exceptionDetails"]
            raise RuntimeError(detail.get("exception", {}).get("description") or detail.get("text", "JS error"))
        result = msg.get("result", {}).get("result", {})
        if "value" not in result:
            raise RuntimeError("No value from Runtime.evaluate")
        return result["value"]


async def download_images(urls: list[str]) -> dict[str, bytes]:
    ws_url = find_medroxi_ws()
    if not ws_url or not urls:
        return {}
    # Token stays inside the browser; only image bytes come back.
    expression = """
(async () => {
  const urls = %s;
  const s = JSON.parse(localStorage.getItem('rbank.session') || 'null');
  const token = s?.access_token || '';
  const out = {};
  for (const url of urls) {
    try {
      const r = await fetch(url, {headers:{Authorization:'Bearer ' + token}});
      if (!r.ok) { out[url] = {error:r.status}; continue; }
      const blob = await r.blob();
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      out[url] = {b64};
    } catch (e) { out[url] = {error:String(e)}; }
  }
  return out;
})()
""" % json.dumps(urls)
    try:
        async with websockets.connect(ws_url, max_size=None) as ws:
            result = await evaluate(ws, expression, 71001, timeout=300)
    except Exception as exc:
        print(f"image download unavailable: {type(exc).__name__}: {str(exc)[:180]}")
        return {}
    out: dict[str, bytes] = {}
    for url, item in (result or {}).items():
        if isinstance(item, dict) and item.get("b64"):
            try:
                out[url] = base64.b64decode(item["b64"])
            except Exception:
                pass
    return out


def upsert_question(conn: sqlite3.Connection, qid: int, row: dict, tags: list[str], answer_rows: list[tuple]) -> str:
    """INSERT or UPDATE one question in place. Returns inserted|updated|same."""
    old = conn.execute("SELECT * FROM Questions WHERE id=?", (qid,)).fetchone()
    values = (
        qid,
        row["question"], row["explanation"], row["corrAns"], row["subId"], row["sysId"],
        row["pplTaken"], row["corrTaken"], row["lastUpdated"], row["title"],
        1, 1, row["mediaName"], row["otherMedias"], None,
    )
    source_id = f"medroxi:{qid}"
    fingerprint = hashlib.sha256(json.dumps({
        "q": row["question"], "e": row["explanation"], "c": row["corrAns"],
        "t": row["title"], "m": row["mediaName"], "o": row["otherMedias"],
        "s": source_id, "tags": tags,
        "a": [(a[2], a[3]) for a in answer_rows],
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()

    if old is not None:
        old_src = conn.execute("SELECT tags FROM SourceMetadata WHERE qId=?", (qid,)).fetchone()
        # fingerprint is stored as a JSON tag token for cheap comparison
        if old_src and f"fingerprint:{fingerprint}" in (old_src["tags"] or ""):
            return "same"
        conn.execute(
            """UPDATE Questions SET question=?,explanation=?,corrAns=?,subId=?,sysId=?,
               pplTaken=?,corrTaken=?,lastUpdated=?,title=?,questionType=?,questionFormatType=?,
               mediaName=?,otherMedias=?,parentQId=? WHERE id=?""",
            values[1:] + (qid,),
        )
        conn.execute("DELETE FROM Answers WHERE qId=?", (qid,))
        conn.execute("DELETE FROM Search WHERE contentId=?", (qid,))
        conn.execute("DELETE FROM SourceMetadata WHERE qId=? OR sourceId=?", (qid, source_id))
        conn.execute("DELETE FROM Refs WHERE qId=?", (qid,))
        status = "updated"
    else:
        conn.execute(
            """INSERT INTO Questions(id,question,explanation,corrAns,subId,sysId,pplTaken,corrTaken,
               lastUpdated,title,questionType,questionFormatType,mediaName,otherMedias,parentQId)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            values,
        )
        status = "inserted"

    conn.executemany(
        "INSERT INTO Answers(id,qId,answerId,answerText,correctPercentage) VALUES (?,?,?,?,?)",
        answer_rows,
    )
    conn.execute(
        "INSERT INTO SourceMetadata(qId,sourceId,sourceKind,tags) VALUES (?,?,?,?)",
        (qid, source_id, SOURCE_KIND, json.dumps(tags + [f"fingerprint:{fingerprint}"], ensure_ascii=False)),
    )
    insert_search(conn, row["title"], 0, "title", qid)
    insert_search(conn, row["question"], 1, "question", qid)
    insert_search(conn, row["explanation"], 2, "explanation", qid)
    for _, _, _, text, _ in answer_rows:
        insert_search(conn, text, 3, "answer", qid)
    return status


def refresh_dimensions(conn: sqlite3.Connection, dim_map: dict[int, tuple[str, str]]) -> tuple[int, int]:
    rows = [r[0] for r in conn.execute("SELECT id FROM Questions")]
    pairs = {qid: dim_map.get(qid, ("MedRoxi", "MedRoxi")) for qid in rows}
    subject_names = sorted({p[0] for p in pairs.values()})
    system_names = sorted({p[1] for p in pairs.values()})
    subjects = {name: i + 1 for i, name in enumerate(subject_names)}
    systems = {name: i + 1 for i, name in enumerate(system_names)}
    sub_counts, sys_counts, pair_counts = Counter(), Counter(), Counter()
    for qid, (sname, yname) in pairs.items():
        s, y = subjects[sname], systems[yname]
        sub_counts[s] += 1
        sys_counts[y] += 1
        pair_counts[(s, y)] += 1
    conn.execute("DELETE FROM SubjectsSystems")
    conn.execute("DELETE FROM Subjects")
    conn.execute("DELETE FROM Systems")
    conn.executemany("INSERT INTO Subjects(id,name,count) VALUES (?,?,?)",
                     [(i, n, sub_counts[i]) for n, i in subjects.items()])
    conn.executemany("INSERT INTO Systems(id,name,count) VALUES (?,?,?)",
                     [(i, n, sys_counts[i]) for n, i in systems.items()])
    conn.executemany("INSERT INTO SubjectsSystems(subId,sysId,count) VALUES (?,?,?)",
                     [(s, y, c) for (s, y), c in sorted(pair_counts.items())])
    conn.executemany(
        "UPDATE Questions SET subId=?,sysId=? WHERE id=?",
        [(subjects[pairs[qid][0]], systems[pairs[qid][1]], qid) for qid in rows],
    )
    return len(subjects), len(systems)


def merge_progress(answered_ids: list[int], marked_ids: list[int], sessions: list[dict]) -> dict:
    conn = sqlite3.connect(STATE_DB)
    try:
        row = conn.execute(
            "SELECT used_ids, marked_ids FROM qbank_progress WHERE user_email=? AND db=?",
            (USER_EMAIL, BANK_KEY),
        ).fetchone()
        old_used = json.loads(row[0]) if row and row[0] else []
        old_marked = json.loads(row[1]) if row and row[1] else []
        used = sorted({int(x) for x in old_used} | {int(x) for x in answered_ids if x})
        marked = sorted({int(x) for x in old_marked} | {int(x) for x in marked_ids if x})
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """INSERT INTO qbank_progress(user_email,db,used_ids,marked_ids,updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(user_email,db) DO UPDATE SET
                 used_ids=excluded.used_ids, marked_ids=excluded.marked_ids,
                 updated_at=excluded.updated_at""",
            (USER_EMAIL, BANK_KEY, json.dumps(used), json.dumps(marked), now),
        )
        inserted_sessions = 0
        for s in sessions:
            sid = str(s.get("id") or "")
            if not sid:
                continue
            exists = conn.execute("SELECT user_email FROM qbank_sessions WHERE id=?", (sid,)).fetchone()
            if exists and exists[0] and exists[0] != USER_EMAIL:
                continue
            q_count = len(s.get("questions") or [])
            a_count = len(s.get("answers") or {})
            conn.execute(
                """INSERT INTO qbank_sessions(id,db,mode,status,created_at,updated_at,completed_at,
                   question_count,answered_count,score,payload,user_email)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                     db=excluded.db, mode=excluded.mode, status=excluded.status,
                     created_at=excluded.created_at, updated_at=excluded.updated_at,
                     completed_at=excluded.completed_at, question_count=excluded.question_count,
                     answered_count=excluded.answered_count, score=excluded.score,
                     payload=excluded.payload, user_email=excluded.user_email""",
                (sid, BANK_KEY, s.get("mode") or "tutor", s.get("status") or "active",
                 s.get("createdAt") or now, s.get("updatedAt") or now, s.get("completedAt"),
                 q_count, a_count, s.get("score"),
                 json.dumps(s, ensure_ascii=False), USER_EMAIL),
            )
            inserted_sessions += 1
        conn.commit()
        return {"used": len(used), "marked": len(marked), "sessions": inserted_sessions}
    finally:
        conn.close()


def build_sessions(tests: list[dict], questions_by_id: dict[int, dict]) -> list[dict]:
    sessions = []
    for t in tests:
        tid = t.get("id")
        if not tid:
            continue
        qids = [int(x) for x in (t.get("question_ids") or []) if str(x).isdigit()]
        qs = []
        for i, qid in enumerate(qids):
            q = questions_by_id.get(qid)
            corr = 0
            if q:
                for ci, choice in enumerate(q.get("choices") or [], start=1):
                    if len(choice) > 2 and choice[2]:
                        corr = ci
                        break
            qs.append({"id": qid, "correct": corr})
        answers = {}
        raw_answers = t.get("answers") or {}
        for qid, letter in raw_answers.items():
            try:
                pos = qids.index(int(qid))
            except ValueError:
                pos = None
            idx = "ABCDEFGHIJKL".find(str(letter).strip().upper())
            if pos is not None and idx >= 0:
                answers[str(pos)] = idx
        sessions.append({
            "id": f"medroxi-test-{tid}",
            "db": BANK_KEY,
            "mode": "tutor" if t.get("mode") != "exam" else "exam",
            "questions": qs,
            "answers": answers,
            "createdAt": t.get("created_at"),
            "updatedAt": t.get("updated_at"),
            "completedAt": None,
            "title": t.get("title") or f"MedRoxi test {tid}",
            "source": "medroxi",
        })
    return sessions


def main() -> None:
    account_path = STAGE / "account-data.json"
    catalog_path = STAGE / "question-catalog.json"
    if not account_path.exists():
        raise SystemExit("Missing staged account-data.json — run the export script first.")
    data = json.loads(account_path.read_text(encoding="utf-8"))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8")) if catalog_path.exists() else None

    datasets = data.get("datasets") or {}
    sections = {int(s["id"]): s for s in datasets.get("sections", []) if s.get("id")}
    chapters = {int(c["id"]): c for c in datasets.get("chapters", []) if c.get("id")}
    stats = data.get("stats") or {}
    qstats = {int(x["question_id"]): x for x in stats.get("questionStats", []) if x.get("question_id")}
    choice_stats = {}
    for x in stats.get("choiceStats", []):
        choice_stats.setdefault(int(x["question_id"]), {})[str(x.get("choice"))] = x.get("pct") or 0

    questions = [q for q in data.get("questions", []) if q.get("id")]
    BANK_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    # ── images ────────────────────────────────────────────────────────────
    image_urls: set[str] = set()
    for q in questions:
        image_urls.update(u for u in (q.get("images") or []) if u)
        image_urls.update(u for u in (q.get("explanation_images") or []) if u)
    blobs = asyncio.run(download_images(sorted(image_urls)))
    saved = 0
    for url, payload in blobs.items():
        name = Path(url).name
        if not name or "/" in name:
            continue
        try:
            (MEDIA_DIR / name).write_bytes(payload)
            saved += 1
        except OSError:
            pass
    print(f"images: {len(blobs)}/{len(image_urls)} downloaded, {saved} saved")

    # ── database ──────────────────────────────────────────────────────────
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    counts = Counter()
    questions_by_id: dict[int, dict] = {}
    dim_map: dict[int, tuple[str, str]] = {}
    answer_pk = max([r[0] for r in conn.execute("SELECT COALESCE(MAX(id),0) FROM Answers")] or [0])

    for q in questions:
        qid = int(q["id"])
        questions_by_id[qid] = q
        chapter = chapters.get(int(q.get("chapter_id") or 0), {})
        section = sections.get(int(chapter.get("section_id") or 0), {})
        section_name = clean(section.get("name")) or "MedRoxi"
        chapter_name = clean(chapter.get("name")) or f"Chapter {q.get('chapter_id')}"
        dim_map[qid] = (section_name, chapter_name)
        topic = clean(q.get("topic"))
        image_names = [Path(u).name for u in (q.get("images") or []) if u]
        expl_image_names = [Path(u).name for u in (q.get("explanation_images") or []) if u]
        stem_html = text_to_html(q.get("stem"), qid, image_names)
        expl_html = text_to_html(q.get("explanation"), qid, expl_image_names)

        choices = q.get("choices") or []
        correct = 0
        for idx, choice in enumerate(choices, start=1):
            if len(choice) > 2 and choice[2]:
                correct = idx
                break
        if not correct:
            correct = 1
        choice_stats_for_q = choice_stats.get(qid, {})
        answer_rows = []
        for idx, choice in enumerate(choices, start=1):
            answer_pk += 1
            letter = str(choice[0]) if len(choice) > 0 else ""
            text = str(choice[1]) if len(choice) > 1 else ""
            pct = choice_stats_for_q.get(letter, 0)
            answer_rows.append((
                answer_pk, qid, idx,
                PLAIN + (f"<p>{html.escape(text)}</p>" if text else "<p></p>"),
                int(pct) if isinstance(pct, (int, float)) else 0,
            ))

        # temporary dimension ids; refreshed after all questions are upserted
        row = {
            "question": PLAIN + stem_html,
            "explanation": PLAIN + expl_html,
            "corrAns": correct,
            "subId": 0,
            "sysId": 0,
            "pplTaken": (qstats.get(qid) or {}).get("users") or 0,
            "corrTaken": (qstats.get(qid) or {}).get("correct_pct") or 0,
            "lastUpdated": clean(q.get("created_at")) or datetime.now(timezone.utc).isoformat(),
            "title": (topic or f"Question {qid}")[:120],
            "mediaName": ",".join(image_names),
            "otherMedias": ",".join(expl_image_names),
        }
        tags = [
            "medroxi",
            f"section:{section_name}",
            f"chapter:{chapter_name}",
            f"chapter_id:{q.get('chapter_id')}",
        ]
        if topic:
            tags.append(f"topic:{topic}")
        tags.extend(f"tag:{clean(t)}" for t in (q.get("tags") or []) if clean(t))
        status = upsert_question(conn, qid, row, tags, answer_rows)
        counts[status] += 1

    # ── catalog-only questions ────────────────────────────────────────────
    # Every catalog hit gets a stable-ID stub row now; a later full export
    # updates the SAME row in place (no duplicate copies ever created).
    partial_note = (
        "Catalog-only record exported from MedRoxi search. "
        "Full question text, answer choices and explanation will replace this "
        "record in place after the daily study-block limit resets."
    )
    catalog_ids: set[int] = set()
    for ch in (catalog or {}).get("index", []):
        chapter = chapters.get(int(ch.get("chapter_id") or 0), {})
        section = sections.get(int(ch.get("section_id") or 0), {})
        section_name = clean(section.get("name")) or clean(chapter.get("name")) or "MedRoxi"
        chapter_name = clean(ch.get("name")) or f"Chapter {ch.get('chapter_id')}"
        for hit in ch.get("hits", []):
            try:
                qid = int(hit.get("id"))
            except (TypeError, ValueError):
                continue
            catalog_ids.add(qid)
            dim_map[qid] = (section_name, chapter_name)
            if qid in questions_by_id:
                continue  # full version already imported above
            topic = clean(hit.get("topic"))
            stem = clean(hit.get("stem"))
            question_html = text_to_html(stem, qid)
            question_html += f"<p><em>{html.escape(partial_note)}</em></p>"
            row = {
                "question": PLAIN + question_html,
                "explanation": PLAIN + f"<p>{html.escape(partial_note)}</p>",
                "corrAns": 1,
                "subId": 0,
                "sysId": 0,
                "pplTaken": 0,
                "corrTaken": 0,
                "lastUpdated": (catalog or {}).get("exported_at") or datetime.now(timezone.utc).isoformat(),
                "title": (f"[Partial] {topic}" if topic else f"[Partial] Question {qid}")[:120],
                "mediaName": "",
                "otherMedias": "",
            }
            tags = [
                "medroxi", "catalog-only", "partial",
                f"section:{section_name}",
                f"chapter:{chapter_name}",
                f"chapter_id:{ch.get('chapter_id')}",
            ]
            if topic:
                tags.append(f"topic:{topic}")
            answer_pk += 1
            answer_rows = [(
                answer_pk, qid, 1,
                PLAIN + "<p>Full answer choices not yet exported from MedRoxi.</p>",
                0,
            )]
            counts[upsert_question(conn, qid, row, tags, answer_rows)] += 1

    print(f"catalog stubs: {len(catalog_ids)} ids seen, "
          f"{sum(1 for qid in catalog_ids if qid not in questions_by_id)} new stub rows")
    n_subjects, n_systems = refresh_dimensions(conn, dim_map)
    conn.commit()
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM Questions").fetchone()[0]
    conn.execute("VACUUM")
    conn.close()
    if integrity != "ok":
        raise RuntimeError(f"Bank integrity check failed: {integrity}")
    print(f"bank DB: total={total} inserted={counts['inserted']} updated={counts['updated']} "
          f"unchanged={counts['same']} subjects={n_subjects} systems={n_systems}")

    # ── sidecars ──────────────────────────────────────────────────────────
    manifest = json.loads((STAGE / "manifest.json").read_text(encoding="utf-8")) if (STAGE / "manifest.json").exists() else {}
    meta = {
        "format": "medos-imported-qbank",
        "version": 1,
        "name": "MedRoxi",
        "source": "https://medroxi.site/",
        "source_pdf": "https://medroxi.site/",
        "bank_key": BANK_KEY,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "questions": total,
        "full_questions": len(questions),
        "catalog_questions": (catalog or {}).get("catalog_questions", 0),
        "catalog_expected": (catalog or {}).get("expected_questions", 0),
        "catalog_warnings": len((catalog or {}).get("warnings", [])),
        "images": saved,
        "source_kind": SOURCE_KIND,
        "id_policy": "MedRoxi question id used as stable local question id; upsert in place",
        "note": "All catalog IDs exist as stable partial rows; full exports update those same rows in place. Raw catalog retained in catalog.json.",
        "exported_at": manifest.get("created_at"),
    }
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if catalog is not None:
        CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False), encoding="utf-8")

    # ── progress ──────────────────────────────────────────────────────────
    answered_ids = set()
    for a in datasets.get("attempts", []):
        if a.get("question_id"):
            answered_ids.add(int(a["question_id"]))
    for t in datasets.get("tests", []):
        for qid, _letter in (t.get("answers") or {}).items():
            answered_ids.add(int(qid))
    for b in data.get("blocks", {}).values():
        ans = (b.get("data") or {}).get("test", {}).get("answers") or (b.get("data") or {}).get("answers") or {}
        for qid in ans:
            answered_ids.add(int(qid))
    marked_ids = {int(m["question_id"]) for m in datasets.get("marks", []) if m.get("question_id")}
    sessions = build_sessions(datasets.get("tests", []), questions_by_id)
    progress = merge_progress(sorted(answered_ids), sorted(marked_ids), sessions)
    print(f"progress: {progress} (user={USER_EMAIL}, db={BANK_KEY})")

    # ── final report ──────────────────────────────────────────────────────
    print(json.dumps({
        "bank_key": BANK_KEY,
        "db": str(DB_PATH),
        "meta": str(META_PATH),
        "questions_in_bank": total,
        "full_questions": len(questions),
        "catalog_questions": meta["catalog_questions"],
        "catalog_expected": meta["catalog_expected"],
        "bank_size_bytes": sum(p.stat().st_size for p in BANK_DIR.rglob("*") if p.is_file()),
    }, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
MedOS — Progression Backup  (run this BEFORE updating MedOS).

Reads your Q-Bank progression — which UWorld / NBME / CMS questions you have
USED and MARKED — straight from the database file and writes a small portable
JSON. After you update (or move to another computer) you restore it from:

    • In the app:  Admin -> Progression Sync -> Import progression   (merge)
    • Or on the command line:  IMPORT_PROGRESS.bat  <that-file.json>

Only the Python standard library is used, so this runs on ANY MedOS version,
even older builds that don't have the in-app Export button.

Usage:
    EXPORT_PROGRESS.bat                       (just double-click on Windows)

    python EXPORT_PROGRESS.py [DB_PATH] [-o OUT.json] [--per-user]
        DB_PATH     path to data\\qbank_state.sqlite3 (auto-detected if omitted)
        --per-user  write one file per account instead of one combined file
"""
import argparse
import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _read_env_file():
    """Parse app/backend/.env (KEY=VALUE lines) with stdlib only. The launcher stores
    data-location overrides (QBANK_STATE_DB, MEDOS_ROOT) here — e.g. when the data lives
    on an external SSD per DISTRIBUTION.md — so we must honour them too."""
    values = {}
    env_path = HERE / "app" / "backend" / ".env"
    try:
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            values[key.strip()] = val.strip().strip('"').strip("'")
    except Exception:
        pass
    return values


def locate_db(explicit):
    cands = []
    if explicit:
        cands.append(Path(explicit))
    if os.environ.get("QBANK_STATE_DB"):
        cands.append(Path(os.environ["QBANK_STATE_DB"]))
    env = _read_env_file()
    if env.get("QBANK_STATE_DB"):
        cands.append(Path(env["QBANK_STATE_DB"]))
    if env.get("MEDOS_ROOT"):
        cands.append(Path(env["MEDOS_ROOT"]) / "data" / "qbank_state.sqlite3")
    cands += [
        HERE / "data" / "qbank_state.sqlite3",
        HERE / "app" / "data" / "qbank_state.sqlite3",
        HERE.parent / "data" / "qbank_state.sqlite3",
    ]
    for c in cands:
        if c and c.exists():
            return c
    return None


def table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def col_names(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def to_ids(raw):
    try:
        v = json.loads(raw or "[]")
        return sorted({int(x) for x in v if int(x) > 0}) if isinstance(v, list) else []
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser(description="Back up MedOS Q-Bank progression to a portable JSON.")
    ap.add_argument("db", nargs="?", help="path to qbank_state.sqlite3 (auto-detected if omitted)")
    ap.add_argument("-o", "--out", help="output file path")
    ap.add_argument("--per-user", action="store_true", help="one file per account instead of one combined file")
    args = ap.parse_args()

    db = locate_db(args.db)
    if not db:
        print("!! Could not find qbank_state.sqlite3.")
        print('   Pass its path:  python EXPORT_PROGRESS.py "C:\\path\\to\\data\\qbank_state.sqlite3"')
        print("   (If your version kept progress only in the app window, open MedOS, press F12 ->")
        print("    Console, and run the one-liner from UPGRADE.md instead.)")
        return 2
    print(f"Reading: {db}")

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    if not table_exists(conn, "qbank_progress"):
        print("!! No 'qbank_progress' table in this database — nothing to back up.")
        return 2
    has_user = "user_email" in col_names(conn, "qbank_progress")

    by_user = {}
    for r in conn.execute("SELECT * FROM qbank_progress"):
        u = (r["user_email"] if has_user else "local") or "local"
        d = by_user.setdefault(u, {"usedIdsByDb": {}, "markedIdsByDb": {}})
        used, marked = to_ids(r["used_ids"]), to_ids(r["marked_ids"])
        if used:
            d["usedIdsByDb"][r["db"]] = used
        if marked:
            d["markedIdsByDb"][r["db"]] = marked

    searches = []
    if table_exists(conn, "search_history"):
        try:
            for r in conn.execute(
                "SELECT query, scopes, results_count, ts FROM search_history ORDER BY id DESC LIMIT 1000"
            ):
                searches.append({"query": r["query"], "scopes": r["scopes"],
                                 "results_count": r["results_count"], "ts": r["ts"]})
        except sqlite3.Error:
            pass
    conn.close()

    if not by_user:
        print("!! No progression rows found — nothing to back up yet.")
        return 0

    stamp_iso = datetime.now().astimezone().isoformat()
    stamp_day = datetime.now().strftime("%Y%m%d")

    def envelope(used, marked, note):
        return {"app": "medos", "kind": "progression", "version": 1, "exported_at": stamp_iso,
                "note": note, "qbank": {"usedIdsByDb": used, "markedIdsByDb": marked},
                "searches": searches}

    def summarize(used):
        return ", ".join(f"{k}:{len(v)}" for k, v in sorted(used.items())) or "(none)"

    written = []
    if args.per_user:
        for u, d in by_user.items():
            safe = "".join(ch if ch.isalnum() else "_" for ch in u)
            out = HERE / f"medos-progression-{safe}-{stamp_day}.json"
            out.write_text(json.dumps(envelope(d["usedIdsByDb"], d["markedIdsByDb"], f"Account {u}"), indent=2), encoding="utf-8")
            written.append((u, out, d["usedIdsByDb"]))
    else:
        U, M = {}, {}
        for d in by_user.values():
            for k, v in d["usedIdsByDb"].items():
                U[k] = sorted(set(U.get(k, [])) | set(v))
            for k, v in d["markedIdsByDb"].items():
                M[k] = sorted(set(M.get(k, [])) | set(v))
        out = Path(args.out) if args.out else HERE / f"medos-progression-backup-{stamp_day}.json"
        out.write_text(json.dumps(envelope(U, M, "Combined backup (all accounts)"), indent=2), encoding="utf-8")
        written.append(("(all accounts)", out, U))

    print("\n[OK] Backup written:")
    for who, path, used in written:
        print(f"   {path}")
        print(f"     {who}: used QIDs -> {summarize(used)}")
    print("\nKeep this file. After updating, restore it with:")
    print("   - In-app:  Admin -> Progression Sync -> Import progression   (merge)")
    print("   - Or CLI:  IMPORT_PROGRESS.bat  <that-file.json>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

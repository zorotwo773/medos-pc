#!/usr/bin/env python3
"""
MedOS — Restore Progression  (run this AFTER updating MedOS, only if needed).

Merges the USED / MARKED Q-Bank QIDs from a backup file (made by EXPORT_PROGRESS,
or by the in-app Export) into THIS install's database. Union + idempotent:
re-running adds nothing and never erases existing progress.

You usually do NOT need this — if your data\ folder (with qbank_state.sqlite3)
carried over during the update, your progress is already there. Use this only
when you started from a fresh data folder, moved machines, or turned on logins
and need to land old progress on a specific account.

Usage:
    IMPORT_PROGRESS.bat  medos-progression-backup-YYYYMMDD.json  [--user you@email]
        (you can also drag the .json file onto IMPORT_PROGRESS.bat)

    python IMPORT_PROGRESS.py BACKUP.json [DB_PATH] [--user EMAIL] [--replace]
        --user EMAIL   account to attribute the progress to. With logins, use the
                       email you sign in as. With no logins, the default is correct.
        --replace      overwrite that account's banks instead of merging.

Only the Python standard library is used.
"""
import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEGACY = "legacy@medos"   # the implicit single user when logins are off


def _read_env_file():
    """Parse app/backend/.env (KEY=VALUE) with stdlib only, to honour data-location
    overrides (QBANK_STATE_DB, MEDOS_ROOT) — e.g. data on an external SSD."""
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


def to_ids(v):
    try:
        return sorted({int(x) for x in v if int(x) > 0}) if isinstance(v, list) else []
    except Exception:
        return []


def ensure_table(conn):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS qbank_progress (
               user_email TEXT NOT NULL,
               db TEXT NOT NULL,
               used_ids TEXT NOT NULL DEFAULT '[]',
               marked_ids TEXT NOT NULL DEFAULT '[]',
               updated_at TEXT NOT NULL,
               PRIMARY KEY (user_email, db))"""
    )


def main():
    ap = argparse.ArgumentParser(description="Restore MedOS Q-Bank progression from a backup JSON.")
    ap.add_argument("backup", help="backup .json made by EXPORT_PROGRESS or the in-app Export")
    ap.add_argument("db", nargs="?", help="path to qbank_state.sqlite3 (auto-detected if omitted)")
    ap.add_argument("--user", default=LEGACY, help="account email to attribute progress to")
    ap.add_argument("--replace", action="store_true", help="overwrite instead of merge")
    args = ap.parse_args()

    bf = Path(args.backup)
    if not bf.exists():
        print(f"!! Backup not found: {bf}")
        return 2
    try:
        data = json.loads(bf.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"!! Could not read backup as JSON: {e}")
        return 2

    q = data.get("qbank", data)   # tolerate {qbank:{...}} or a bare {usedIdsByDb:...}
    used_map = q.get("usedIdsByDb", {}) or {}
    marked_map = q.get("markedIdsByDb", {}) or {}
    if not used_map and not marked_map:
        print("!! No qbank.usedIdsByDb / markedIdsByDb in that file — is it a MedOS progression backup?")
        return 2

    db = locate_db(args.db)
    if not db:
        print("!! Could not find qbank_state.sqlite3. Run the app once, or pass the path as the 2nd argument.")
        return 2
    print(f"Importing into: {db}")
    print(f"  account: {args.user}   mode: {'replace' if args.replace else 'merge'}\n")

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    ensure_table(conn)
    now = datetime.now(timezone.utc).isoformat()
    banks = sorted(set(used_map) | set(marked_map))
    total_u = total_m = 0
    for dbk in banks:
        cur = conn.execute(
            "SELECT used_ids, marked_ids FROM qbank_progress WHERE user_email=? AND db=?",
            (args.user, dbk),
        ).fetchone()
        cu = set() if (args.replace or not cur) else set(to_ids(json.loads(cur["used_ids"] or "[]")))
        cm = set() if (args.replace or not cur) else set(to_ids(json.loads(cur["marked_ids"] or "[]")))
        nu = cu | set(to_ids(used_map.get(dbk, [])))
        nm = cm | set(to_ids(marked_map.get(dbk, [])))
        total_u += len(nu) - len(cu)
        total_m += len(nm) - len(cm)
        conn.execute(
            """INSERT INTO qbank_progress (user_email, db, used_ids, marked_ids, updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(user_email, db) DO UPDATE SET
                   used_ids=excluded.used_ids, marked_ids=excluded.marked_ids, updated_at=excluded.updated_at""",
            (args.user, dbk, json.dumps(sorted(nu)), json.dumps(sorted(nm)), now),
        )
        print(f"   {dbk:<14} used {len(nu):>5} (+{len(nu) - len(cu)})   marked {len(nm):>4} (+{len(nm) - len(cm)})")
    conn.commit()
    conn.close()
    print(f"\n[OK] Added {total_u} used + {total_m} marked QIDs for {args.user}.")
    print("  Open Q-Bank — those questions are now excluded from new blocks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

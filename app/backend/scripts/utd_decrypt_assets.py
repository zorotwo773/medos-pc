#!/usr/bin/env python3
"""
Build `utdasset_decrypted.sqlite` locally from the shipped `utdasset.sqlite`.

Why this script exists: the uptodate pack used to ship BOTH the original
encrypted iMD bundle (utdasset.sqlite, ~3 GB) AND a pre-decrypted copy of the
same content (utdasset_decrypted.sqlite, ~7.85 GB) so the reader never pays a
per-request decrypt cost. Shipping both doubled the download for no reason —
this script produces the second file on the user's own machine (one-time,
CPU-bound, no network) from the first, using the exact decrypt routine
`utd_reader.py` already uses at request time (utd_crypto.UTDKey).

Run:  python app/backend/scripts/utd_decrypt_assets.py [--utd-dir PATH]

Progress is printed as "[utd-decrypt] N/total" so the Content Manager's
"Prepare UpToDate" button can tail this process's stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))  # app/backend/

from utd_content import UTDContentError, UTDTopicUnavailable, cache_status, decrypt_topic, open_readonly, resolve_key  # noqa: E402

try:
    from config import UTD_DB_PATH as _DEFAULT_UTD_DIR
except Exception:
    _DEFAULT_UTD_DIR = _HERE.parent.parent.parent / "data" / "uptodate"


def log(msg: str) -> None:
    print(f"[utd-decrypt] {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--utd-dir", default=str(_DEFAULT_UTD_DIR), help="Folder holding utdasset.sqlite")
    ap.add_argument("--password", default=None,
                    help="Content key (UTD_PASSWORD override or the recognized shipped bundle's default)")
    ap.add_argument("--force", action="store_true", help="Rebuild even if the output already exists")
    args = ap.parse_args()

    utd_dir = Path(args.utd_dir)
    src_path = utd_dir / "utdasset.sqlite"
    out_path = utd_dir / "utdasset_decrypted.sqlite"
    if out_path.exists() and not args.force:
        status = cache_status(utd_dir, full=True)
        if status["ready"]:
            log(status["detail"] + " Already prepared; pass --force to rebuild.")
            return 0
        log(status["detail"] + " Rebuilding locally.")
    tmp_path = None
    t0 = time.time()
    try:
        if not src_path.is_file():
            raise UTDContentError("Encrypted UpToDate bundle is missing; install or repair the content pack.")
        key = resolve_key(utd_dir, args.password)
        if key is None:
            raise UTDContentError("Set UTD_PASSWORD to this bundle's content key; the download ZIP password is separate.")
        with closing(open_readonly(src_path)) as src:
            total = src.execute("SELECT count(*) FROM topic_asset").fetchone()[0]
            if not total:
                raise UTDContentError("Encrypted UpToDate bundle has no topics.")
            # Reject a wrong key before allocating the multi-GB output cache.
            sample = src.execute("SELECT id, payload FROM topic_asset ORDER BY id LIMIT 1").fetchone()
            try:
                decrypt_topic(key, sample[0], sample[1])
            except UTDTopicUnavailable:
                pass
            log(f"decrypting {total:,} topics from {src_path.name}...")
            fd, temp_name = tempfile.mkstemp(prefix="utdasset_decrypted-", suffix=".sqlite.tmp", dir=utd_dir)
            os.close(fd)
            tmp_path = Path(temp_name)
            with closing(sqlite3.connect(tmp_path)) as dst:
                dst.executescript(
                    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"
                    "CREATE TABLE topic_content (id INTEGER PRIMARY KEY, content TEXT NOT NULL);"
                    "CREATE TABLE topic_unavailable (id INTEGER PRIMARY KEY);"
                )
                done = 0
                unavailable = 0
                batch = []
                for topic_id, payload in src.execute("SELECT id, payload FROM topic_asset ORDER BY id"):
                    try:
                        data = decrypt_topic(key, topic_id, payload)
                    except UTDTopicUnavailable:
                        dst.execute("INSERT INTO topic_unavailable(id) VALUES (?)", (topic_id,))
                        unavailable += 1
                        continue
                    batch.append((topic_id, json.dumps(data, ensure_ascii=False)))
                    done += 1
                    if len(batch) >= 500:
                        dst.executemany("INSERT INTO topic_content (id, content) VALUES (?, ?)", batch)
                        dst.commit()
                        batch.clear()
                        log(f"{done + unavailable}/{total} ({time.time() - t0:.0f}s, {unavailable} empty source records, 0 failed)")
                if batch:
                    dst.executemany("INSERT INTO topic_content (id, content) VALUES (?, ?)", batch)
                dst.commit()
                if not done or done + unavailable != total or dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise UTDContentError("Prepared cache failed validation; the previous cache was kept.")
        # Both connections are closed before replacement, including on Windows.
        os.replace(tmp_path, out_path)
        log(f"DONE - {done:,} readable topics, {unavailable:,} verified empty source records, 0 failures, in {time.time() - t0:.0f}s")
        return 0
    except UTDContentError as exc:
        log(f"ERROR: {exc}")
    except (OSError, sqlite3.Error):
        log("ERROR: Could not read or write the UpToDate cache. Check free disk space, folder permissions, and content integrity.")
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

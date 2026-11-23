"""Regenerate umls_scan_terms in-place with a larger limit.

The full build_umls.py rebuilds the whole DB (30+ min). This script only
re-runs the scan-term materialization against the already-built umls.sqlite,
which takes ~10-20 seconds.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from config import UMLS_DB  # noqa: E402
from scripts.umls.build_umls import build_scan_terms  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Regenerate umls_scan_terms with a new limit.")
    parser.add_argument("--db", default=str(UMLS_DB))
    parser.add_argument("--scan-limit", type=int, default=200_000)
    args = parser.parse_args()

    db = Path(args.db)
    if not db.exists():
        raise SystemExit(f"UMLS DB not found: {db}")

    started = time.perf_counter()
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        # Reset prior is_scan_term flags + scan rows
        con.execute("DELETE FROM umls_scan_terms")
        con.execute("UPDATE umls_terms SET is_scan_term=0")
        con.commit()
        n = build_scan_terms(con, args.scan_limit)
        con.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('scan_term_count', ?)",
            (str(n),),
        )
        con.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('scan_terms_regen_at', ?)",
            (str(int(time.time())),),
        )
        con.commit()
        print(f"Wrote {n:,} scan terms in {time.perf_counter() - started:.1f}s")
    finally:
        con.close()


if __name__ == "__main__":
    main()

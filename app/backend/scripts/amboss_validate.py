"""Validate AMBOSS Docs.doc decryption at scale.

Re-decrypts every row in the shipped AMBOSS bundle and reports successes,
failures, total bytes, and 3 sample heads. Useful after bundle updates.

    python -m scripts.amboss_validate
"""
from __future__ import annotations

import random
import sqlite3
import sys
from pathlib import Path

# Allow running this script directly (without the backend on sys.path).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from amboss_crypto import decrypt_doc  # noqa: E402

DB = Path(r"D:\ML\data\net.imedicaldoctor.imd\files\amboss-2025\amboss-2025.db")


def main() -> int:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = c.execute("SELECT id, title, doc FROM Docs ORDER BY id").fetchall()
    c.close()

    ok = err = total_bytes = 0
    errors: list[tuple[int, str, str]] = []
    sample_ids: list[int] = []

    for i, (doc_id, title, ct) in enumerate(rows):
        try:
            out = decrypt_doc(doc_id, ct)
            ok += 1
            total_bytes += len(out)
            if i < 3 or (random.random() < 0.001 and len(sample_ids) < 3):
                sample_ids.append(doc_id)
        except Exception as e:
            err += 1
            if len(errors) < 5:
                errors.append((doc_id, title or "", f"{type(e).__name__}: {e}"))

    print(f"Decrypted {ok}/{len(rows)} rows  ({err} failures)")
    print(f"Total decompressed HTML bytes: {total_bytes / 1024 / 1024:.1f} MB")
    if errors:
        print("\nFirst failures:")
        for e in errors:
            print(" ", e)

    print("\nSamples (id, title, html_len, body_head):")
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    for sid in sample_ids:
        r = c.execute("SELECT title, doc FROM Docs WHERE id=?", (sid,)).fetchone()
        html = decrypt_doc(sid, r[1])
        flat = " ".join(html.split())
        marker = flat.find("<body")
        body_preview = flat[marker:marker + 240] if marker >= 0 else flat[:240]
        print(f"  id={sid} title={r[0]!r}  html_len={len(html)}")
        print(f"    {body_preview}")
    c.close()

    return 0 if err == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

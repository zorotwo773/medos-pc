#!/usr/bin/env python3
"""Pre-generate book thumbnails in a standalone process.

Run as: python pregen_thumbnails.py <LIBRARY_PATH>

Why a separate process? PyMuPDF's fitz.open()/render are GIL-holding C calls.
When this ran as a background *thread* inside the backend, opening every PDF in a
large library held the GIL for minutes on first boot, freezing the asyncio event
loop so every HTTP request hung until the scan finished (the "app won't start /
yellow state" symptom). A child process has its own GIL, so the server stays
responsive while thumbnails are generated. Already-cached thumbnails are skipped,
so re-runs are a cheap no-op.

Mirrors the file selection in main._library_signature (os.walk for *.pdf, dot-
dirs skipped) and the thumbnail naming/render params of the former _pregen_thumbs
so the library UI finds the same files.
"""
import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    lib = Path(sys.argv[1])
    if not lib.exists():
        return 0
    try:
        import fitz  # PyMuPDF
    except Exception as exc:  # pragma: no cover - missing optional dep
        print(f"[thumbs] PyMuPDF unavailable: {exc}")
        return 0

    thumb_dir = lib / ".thumbnails"
    try:
        thumb_dir.mkdir(exist_ok=True)
    except OSError:
        return 0

    made = 0
    for root, dirs, files in os.walk(lib):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for file in files:
            if not file.lower().endswith(".pdf"):
                continue
            full = Path(root) / file
            rel = os.path.relpath(full, lib).replace("\\", "/")
            safe_name = rel.replace("\\", "_").replace("/", "_") + ".jpg"
            thumb_path = thumb_dir / safe_name
            if thumb_path.exists():
                continue
            try:
                doc = fitz.open(full)
                pix = doc.load_page(0).get_pixmap(matrix=fitz.Matrix(0.25, 0.25))
                thumb_path.write_bytes(pix.tobytes("jpeg"))
                doc.close()
                made += 1
            except Exception:
                # A locked / corrupt / encrypted PDF must not abort the rest.
                continue
    if made:
        print(f"[thumbs] generated {made} thumbnail(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

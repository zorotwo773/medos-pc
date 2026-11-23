"""
Verify and linearize all PDFs in the library.

Linearization restructures a PDF so that the first page is stored at the
beginning of the file — this makes HTTP Range requests maximally efficient
because pdf.js can render page 1 after downloading only the first few KB.

Requirements:
    pip install pikepdf

Run:
    python scripts/verify_pdfs.py
    python scripts/verify_pdfs.py --path "E:/books/MED" --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_BACKEND = Path(__file__).parent.parent
sys.path.insert(0, str(_BACKEND))
from config import LIBRARY_PATH


def verify_and_linearize(library: Path, dry_run: bool, verbose: bool) -> None:
    try:
        import pikepdf
    except ImportError:
        raise SystemExit("pikepdf not installed. pip install pikepdf")

    pdfs = sorted(library.rglob("*.pdf"))
    n = len(pdfs)
    ok = repaired = failed = skipped = 0

    print(f"Scanning {n} PDFs in {library}\n")

    for i, pdf in enumerate(pdfs, 1):
        if "_thumbs" in pdf.parts:
            continue
        prefix = f"[{i}/{n}] {pdf.relative_to(library)}"
        try:
            with pikepdf.open(pdf) as doc:
                already_linear = bool(doc.is_linearized)
        except Exception as e:
            print(f"  UNREADABLE  {prefix}: {e}")
            failed += 1
            continue

        if already_linear:
            if verbose:
                print(f"  OK (linear)  {prefix}")
            ok += 1
            continue

        print(f"  Linearizing  {prefix}")
        if dry_run:
            skipped += 1
            continue

        tmp = pdf.with_suffix(".linearized.pdf")
        try:
            with pikepdf.open(pdf) as doc:
                doc.save(
                    str(tmp),
                    linearize=True,
                    compress_streams=True,
                )
            tmp.replace(pdf)
            repaired += 1
        except Exception as e:
            print(f"    ERROR: {e}")
            tmp.unlink(missing_ok=True)
            failed += 1

    print(f"\nResults: {ok} ok · {repaired} linearized · {failed} failed · {skipped} skipped (dry-run)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify and linearize library PDFs")
    parser.add_argument("--path",    default=str(LIBRARY_PATH), help="Library root directory")
    parser.add_argument("--dry-run", action="store_true",       help="Report but do not modify files")
    parser.add_argument("--verbose", action="store_true",       help="Log every file, not just modified")
    args = parser.parse_args()

    verify_and_linearize(Path(args.path), args.dry_run, args.verbose)


if __name__ == "__main__":
    main()

"""Store the library signature so router skips rglob on next boot."""
import sqlite3, hashlib
from pathlib import Path

LIB   = Path("E:/books/MED")
INDEX = Path(__file__).parent / "library_index.sqlite3"

sig_parts = []
for p in sorted(LIB.rglob("*.pdf")):
    if p.name.startswith(".") or "_thumbs" in p.parts or ".thumbnails" in p.parts:
        continue
    try:
        rel = p.relative_to(LIB).as_posix()
        sig_parts.append(f"{rel}:{int(p.stat().st_mtime)}")
    except Exception:
        pass

sig = hashlib.sha1(";".join(sig_parts).encode()).hexdigest()
print(f"Computed sig for {len(sig_parts)} PDFs: {sig[:12]}...")

c = sqlite3.connect(str(INDEX))
c.execute("PRAGMA journal_mode=WAL")
c.execute("INSERT OR REPLACE INTO meta VALUES ('library_signature', ?)", (sig,))
c.commit()
count = c.execute("SELECT count(*) FROM books").fetchone()[0]
c.close()
print(f"Books in index: {count}")
print("Done — router will skip rglob rebuild on next boot")

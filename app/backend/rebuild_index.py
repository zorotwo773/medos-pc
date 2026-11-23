"""Rebuild library_index.sqlite3 from E:/books/MED."""
import sqlite3
from pathlib import Path

LIB   = Path("E:/books/MED")
INDEX = Path(__file__).parent / "library_index.sqlite3"

INDEX.unlink(missing_ok=True)
conn = sqlite3.connect(str(INDEX))
conn.executescript("""
CREATE TABLE meta     (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE books    (id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, href TEXT, scope TEXT, kind TEXT, search_text TEXT);
CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, href TEXT, scope TEXT, kind TEXT, search_text TEXT);
""")

count = 0
for folder in sorted(LIB.iterdir()):
    if not folder.is_dir() or folder.name.startswith(".") or folder.name.startswith("_"):
        continue
    for pdf in sorted(folder.rglob("*.pdf")):
        rel   = pdf.relative_to(LIB).as_posix()
        title = pdf.stem
        sub   = f"{folder.name} book"
        href  = "/library?path=" + rel.replace(" ", "%20")
        conn.execute(
            "INSERT OR REPLACE INTO books VALUES (?,?,?,?,?,?,?)",
            (rel, title, sub, href, "books", "book", f"{title} {folder.name}"),
        )
        count += 1

conn.execute("INSERT OR REPLACE INTO meta VALUES ('library_index_updated_at', strftime('%s','now'))")
conn.commit()
conn.close()
print(f"Index rebuilt: {count} books in {INDEX}")

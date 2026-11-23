"""Build a fresh, portable SQLite shelf index from an explicit PDF library."""
from __future__ import annotations

import hashlib
import os
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class LibraryIndexReport:
    output: Path
    book_count: int
    logical_bytes: int


def _signature(library: Path) -> str:
    sig_parts: list[str] = []
    for pdf in sorted(library.rglob("*.pdf")):
        if pdf.name.startswith("."):
            continue
        try:
            relative = pdf.relative_to(library).as_posix()
            sig_parts.append(f"{relative}:{int(pdf.stat().st_mtime)}")
        except OSError:
            continue
    return hashlib.sha1(";".join(sig_parts).encode()).hexdigest()


def _book_paths(library: Path) -> list[Path]:
    return [
        pdf
        for pdf in sorted(library.rglob("*.pdf"))
        if not pdf.name.startswith(".") and "_thumbs" not in pdf.parts
    ]


def _initialize_schema(connection: sqlite3.Connection) -> None:
    connection.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    connection.execute(
        """CREATE TABLE books (
            id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, href TEXT,
            scope TEXT, kind TEXT, search_text TEXT)"""
    )
    connection.execute(
        """CREATE TABLE chapters (
            id TEXT PRIMARY KEY, title TEXT, subtitle TEXT, href TEXT,
            scope TEXT, kind TEXT, search_text TEXT)"""
    )


def _fsync(path: Path) -> None:
    with path.open("r+b") as handle:
        os.fsync(handle.fileno())


def build_library_index(library: Path, output: Path) -> LibraryIndexReport:
    """Build a new shelf index without consulting or modifying default paths."""
    library = Path(library)
    output = Path(output)
    if not library.is_dir():
        raise FileNotFoundError(f"Library directory does not exist: {library}")
    if output.exists():
        raise FileExistsError(f"Library index output already exists: {output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.building-{uuid.uuid4().hex}")
    books = _book_paths(library)
    logical_bytes = sum(pdf.stat().st_size for pdf in books)

    try:
        connection = sqlite3.connect(temporary)
        try:
            _initialize_schema(connection)
            for pdf in books:
                relative = pdf.relative_to(library).as_posix()
                folder = pdf.parent.relative_to(library).as_posix()
                if folder == ".":
                    folder = "General"
                connection.execute(
                    "INSERT INTO books (id, title, subtitle, href) VALUES (?, ?, ?, ?)",
                    (relative, pdf.stem, folder, f"/library?path={relative}"),
                )
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('library_signature', ?)",
                (_signature(library),),
            )
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('library_index_updated_at', ?)",
                (str(int(time.time())),),
            )
            connection.commit()
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise RuntimeError(f"Library index integrity check failed: {integrity}")
        finally:
            connection.close()

        _fsync(temporary)
        os.link(temporary, output)
        temporary.unlink()
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    return LibraryIndexReport(
        output=output,
        book_count=len(books),
        logical_bytes=logical_bytes,
    )

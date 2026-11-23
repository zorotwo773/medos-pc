"""Build a tiny MedOS-Setup test bundle for installer regression runs.

Creates a fake payload tree (a few KB), packs it with 7-Zip, appends it to the
real bootstrapper with the same 60-byte footer the production builder uses,
and prints the path of the resulting EXE.
"""
from __future__ import annotations

import hashlib
import shutil
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
SEVEN_ZIP = Path(r"C:\Program Files\7-Zip\7z.exe")
BOOTSTRAPPER = HERE / "MedOS-Setup.exe"
FOOTER = struct.Struct("<8sqq32sI")


def build(tree: Path, name: str) -> Path:
    archive = tree.parent / "payload.7z"
    if archive.exists():
        archive.unlink()
    subprocess.run(
        [str(SEVEN_ZIP), "a", "-t7z", "-mx=5", "-ms=on", str(archive), "."],
        cwd=str(tree),
        check=True,
        stdout=subprocess.DEVNULL,
    )
    digest = hashlib.sha256(archive.read_bytes()).digest()
    exe = tree.parent / name
    with exe.open("wb") as out:
        out.write(BOOTSTRAPPER.read_bytes())
        offset = out.tell()
        data = archive.read_bytes()
        out.write(data)
        out.write(FOOTER.pack(b"MDSPAY01", offset, len(data), digest, 1))
    return exe


def make_tree(root: Path, marker: str) -> Path:
    if root.exists():
        shutil.rmtree(root)
    (root / "tools" / "python").mkdir(parents=True)
    (root / "app" / ".next").mkdir(parents=True)
    (root / "docs").mkdir(parents=True)
    (root / "START.ps1").write_text("# MedOS test launcher\n", encoding="utf-8")
    (root / "START.bat").write_text("@echo off\r\n", encoding="utf-8")
    (root / "app" / "START.ps1").write_text("# app test launcher\n", encoding="utf-8")
    (root / "app" / ".next" / ".medos-shipped").write_text("test-build\n", encoding="ascii")
    (root / "tools" / "python" / "python.exe").write_text("stub\n", encoding="ascii")
    (root / "docs" / "readme.txt").write_text(marker + "\n", encoding="ascii")
    shutil.copy2(PROJECT / "launch.vbs", root / "launch.vbs")
    shutil.copy2(PROJECT / "medos.ico", root / "medos.ico")
    return root


def main() -> int:
    work = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"C:\Users\abdulwahhab\AppData\Local\Temp\medos-installer-test")
    marker = sys.argv[2] if len(sys.argv) > 2 else "version-one"
    name = sys.argv[3] if len(sys.argv) > 3 else "MedOS-Setup-test.exe"
    work.mkdir(parents=True, exist_ok=True)
    tree = make_tree(work / ("tree-" + marker), marker)
    exe = build(tree, name)
    print(exe)
    return 0


if __name__ == "__main__":
    sys.exit(main())

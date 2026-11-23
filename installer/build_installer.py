"""Build the portable MedOS Windows installer.

The installer payload is the *program only*: the Next.js app, the bundled
Python/Node runtimes, the setup-center code, launchers, icons and docs.  No
user content from ``data/`` is included -- the user chooses which content packs
to bring across from Content Manager.

Usage (from any folder):

    python build_installer.py --list-only        # show what would ship
    python build_installer.py --archive-only     # create the payload archive
    python build_installer.py                    # archive + compile + bundle EXE
    python build_installer.py --force            # rebuild everything

The final EXE is a small C# WinForms bootstrapper with the compressed payload
appended to it (one file), or -- if the payload is larger than the safe
per-file limit -- the bootstrapper next to ``MedOS-app.7z.001`` volume parts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = HERE / "src"
BUILD = HERE / "build"

DEFAULT_DIST = Path(r"D:\MedOS-installer-dist") if Path("D:/").exists() else HERE / "dist"

# Keep every produced file comfortably below 1945.5 MB (decimal and binary).
MAX_PART_BYTES = 1_940_000_000
SEVEN_ZIP = Path(r"C:\Program Files\7-Zip\7z.exe")
SEVEN_DLL = Path(r"C:\Program Files\7-Zip\7z.dll")
CSC = Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe")
ICON = ROOT / "medos.ico"
VERSION = os.environ.get("MEDOS_VERSION", "1.1.5")

FOOTER_MAGIC = b"MDSPAY01"
FOOTER = struct.Struct("<8sqq32sI")  # magic, offset, length, sha256, schema

# ── Payload selection ─────────────────────────────────────────────────────
INCLUDE_DIRS = (
    "app",
    "tools",
    "setup_center",
    "docs",
    "linux",
    "mac",
    "MedOS.app",
)

INCLUDE_ROOT_FILES = (
    "START.ps1",
    "START.bat",
    "STOP.ps1",
    "STOP.bat",
    "launch.vbs",
    "ALLOW_LAN.bat",
    "ALLOW_LAN.ps1",
    "EXPORT_PROGRESS.bat",
    "EXPORT_PROGRESS.py",
    "IMPORT_PROGRESS.bat",
    "IMPORT_PROGRESS.py",
    "medos.ico",
    "medos.icns",
    "README.md",
    "DISTRIBUTION.md",
    "UPGRADE.md",
    "PROJECT_STRUCTURE.md",
    "medos_data_manifest.md",
    "MedOS_USER_GUIDE.md",
    "MedOS_USER_GUIDE.pdf",
    "MedOS-Phone-README.md",
    "MedOS-Phone-Install.txt",
    "MedOS-Companion-README.txt",
    "MedOS-Companion.apk",
    "MedOS.command",
    "MedOS-Setup.command",
    "MedOS-Stop.command",
    "START HERE - LINUX.sh",
)

# Directories whose entire subtree is never payload (checked by relative path).
SKIP_RELATIVE_DIRS = (
    "app/.next/cache",
    "app/.next/trace",
    "app/.next/diagnostics",
    "app/test-results",
    "app/node_modules/.cache",
    "tools/python/Lib/site-packages/torch/include",
    "tools/python/Lib/site-packages/torchgen",
    "tools/python/Lib/site-packages/pymupdf/mupdf-devel",
    "tools/python/Lib/site-packages/pip",
    "tools/python/Lib/site-packages/setuptools",
    "tools/python/Lib/site-packages/pkg_resources",
    "tools/node/node_modules/npm/man",
    "tools/node/node_modules/npm/docs",
    "tools/node/node_modules/npm/tap-snapshots",
)

# Any directory with one of these names is skipped wherever it appears.
SKIP_DIR_NAMES = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    ".idea",
    ".vscode",
}

SKIP_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".pdb",
    ".lib",
    ".exp",
    ".ilk",
    ".obj",
    ".swp",
    ".log",
    ".err",
    ".pid",
    ".tmp",
)

SKIP_FILES = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    "tsconfig.tsbuildinfo",
    "calc-debug.png",
    "thumb.jpg",
    "desktop.ini",
    "Thumbs.db",
}


def _rel_parts(rel: str) -> tuple[str, ...]:
    return tuple(part for part in rel.replace("\\", "/").split("/") if part)


def _skip_dir(rel: str, name: str) -> bool:
    if name in SKIP_DIR_NAMES:
        return True
    lowered = name.lower()
    if lowered in ("__pycache__", ".cache"):
        return True
    rel_l = rel.lower()
    for prefix in SKIP_RELATIVE_DIRS:
        if rel_l == prefix.lower() or rel_l.startswith(prefix.lower() + "/"):
            return True
    # The Next build vendors pdfjs-dist through a directory junction. It is a
    # duplicate of app/node_modules/pdfjs-dist; ship it dereferenced so the
    # installed tree never contains a machine-specific reparse point.
    return False


def _skip_file(rel: str, name: str) -> bool:
    if name in SKIP_FILES:
        return True
    if name.startswith(".env.") and not name.endswith(".example"):
        return True
    lowered = name.lower()
    return any(lowered.endswith(suffix) for suffix in SKIP_SUFFIXES)


def _walk(base: Path, rel_prefix: str, stack: list[str] | None = None, depth: int = 0):
    """Yield (relative posix path, absolute path), following reparse dirs once."""
    if stack is None:
        stack = []
    if depth > 64:
        return
    try:
        real = os.path.realpath(str(base))
    except OSError:
        real = str(base)
    if real in stack:
        return
    stack.append(real)
    try:
        with os.scandir(base) as entries:
            for entry in sorted(entries, key=lambda item: item.name.lower()):
                name = entry.name
                rel = f"{rel_prefix}/{name}" if rel_prefix else name
                try:
                    is_dir = entry.is_dir(follow_symlinks=True)
                except OSError:
                    is_dir = False
                if is_dir:
                    if _skip_dir(rel, name):
                        continue
                    yield from _walk(Path(entry.path), rel, stack, depth + 1)
                    continue
                if _skip_file(rel, name):
                    continue
                try:
                    if entry.is_file(follow_symlinks=True):
                        yield rel, Path(entry.path)
                except OSError:
                    continue
    finally:
        stack.pop()


def collect_payload() -> list[tuple[str, Path]]:
    files: list[tuple[str, Path]] = []

    for name in INCLUDE_ROOT_FILES:
        path = ROOT / name
        if path.is_file() and not _skip_file(name, name):
            files.append((name, path))

    for folder in INCLUDE_DIRS:
        base = ROOT / folder
        if not base.is_dir():
            continue
        for rel, path in _walk(base, folder):
            files.append((rel, path))

    # Deterministic order (Windows filesystems are case-insensitive).
    files.sort(key=lambda item: item[0].lower())
    seen: set[str] = set()
    unique: list[tuple[str, Path]] = []
    for rel, path in files:
        key = rel.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append((rel, path))
    return unique


def summarize(files: list[tuple[str, Path]]) -> dict:
    total = 0
    missing = []
    for rel, path in files:
        try:
            total += path.stat().st_size
        except OSError:
            missing.append(rel)
    return {
        "file_count": len(files),
        "uncompressed_bytes": total,
        "missing": missing,
    }


def write_list(files: list[tuple[str, Path]], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        for rel, _path in files:
            handle.write(rel.replace("\\", "/") + "\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_7z(args: list[str], cwd: Path) -> int:
    command = [str(SEVEN_ZIP)] + args
    print("  $ " + " ".join(command))
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    last = 0.0
    assert process.stdout is not None
    for line in process.stdout:
        line = line.strip()
        if line:
            now = time.time()
            if now - last > 2:
                print("    " + line[:160])
                last = now
    return process.wait()


def build_archive(files: list[tuple[str, Path]], force: bool) -> Path:
    BUILD.mkdir(parents=True, exist_ok=True)
    list_path = BUILD / "payload-files.txt"
    write_list(files, list_path)

    archive = BUILD / "MedOS-app.7z"
    if archive.exists() and not force:
        print(f"  archive exists: {archive} ({archive.stat().st_size/1e6:,.1f} MB) -- use --force to rebuild")
        return archive
    if archive.exists():
        archive.unlink()

    # Solid LZMA2 with a 32 MB dictionary: -mx=9 needs ~7 GB of scratch memory on
    # this tree and 7-Zip aborts with exit code 8. 32m/64/fb keeps the encoder
    # inside ~3 GB while still beating the 1.94 GB per-file ceiling.
    code = run_7z(
        [
            "a",
            "-t7z",
            "-mx=7",
            "-m0=lzma2",
            "-md=32m",
            "-mfb=64",
            "-ms=on",
            "-mmt=4",
            "-bso0",
            "-bsp1",
            "-bse1",
            "-scsUTF-8",
            str(archive),
            "@" + str(list_path),
        ],
        ROOT,
    )
    if code not in (0, 1):
        raise SystemExit(f"7-Zip failed with exit code {code}")

    size = archive.stat().st_size
    print(f"  archive: {archive} ({size/1e6:,.1f} MB)")
    return archive


def split_archive(archive: Path, dist: Path) -> list[Path]:
    """Split the finished archive into raw byte parts under the per-file limit."""
    part_bytes = 1_800_000_000
    for stale in dist.glob("MedOS-app.7z.*"):
        stale.unlink()
    parts: list[Path] = []
    with archive.open("rb") as source:
        index = 1
        while True:
            written = 0
            target = dist / f"MedOS-app.7z.{index:03d}"
            with target.open("wb") as out:
                while written < part_bytes:
                    chunk = source.read(min(8 * 1024 * 1024, part_bytes - written))
                    if not chunk:
                        break
                    out.write(chunk)
                    written += len(chunk)
            if written == 0:
                target.unlink()
                break
            parts.append(target)
            index += 1
    digest = sha256_file(archive)
    (dist / "MedOS-app.sha256").write_text(
        f"{digest}  MedOS-app.7z\n", encoding="ascii", newline="\n"
    )
    for part in parts:
        print(f"  part: {part.name} ({part.stat().st_size/1e6:,.1f} MB)")
    print(f"  sha256: {digest}")
    return parts


def compile_bootstrapper(force: bool) -> Path:
    BUILD.mkdir(parents=True, exist_ok=True)
    exe = BUILD / "MedOS-Setup.exe"
    sources = [
        SRC / "MedOSSetup.cs",
        SRC / "SetupForm.cs",
        SRC / "VersionInfo.cs",
    ]
    manifest = SRC / "app.manifest"
    uninstall = SRC / "uninstall-medos.ps1"
    for path in sources + [manifest, uninstall, ICON, SEVEN_ZIP, SEVEN_DLL]:
        if not path.is_file():
            raise SystemExit(f"missing build input: {path}")

    numeric = VERSION.split("-")[0]
    parts = (numeric.split(".") + ["0", "0", "0"])[:4]
    file_version = ".".join(parts)
    sources[2].write_text(
        "// Generated by build_installer.py from MEDOS_VERSION.\n"
        "using System.Reflection;\n"
        "\n"
        "[assembly: AssemblyTitle(\"MedOS Setup\")]\n"
        "[assembly: AssemblyProduct(\"MedOS\")]\n"
        "[assembly: AssemblyCompany(\"MedOS\")]\n"
        "[assembly: AssemblyDescription(\"MedOS installer and updater\")]\n"
        "[assembly: AssemblyCopyright(\"MedOS\")]\n"
        f"[assembly: AssemblyVersion(\"{file_version}\")]\n"
        f"[assembly: AssemblyFileVersion(\"{file_version}\")]\n"
        f"[assembly: AssemblyInformationalVersion(\"{VERSION}\")]\n"
        "\n"
        "namespace MedOS.Setup\n"
        "{\n"
        "    internal static class BuildInfo\n"
        "    {\n"
        '        public const string Product = "MedOS";\n'
        f'        public const string Version = "{VERSION}";\n'
        "    }\n"
        "}\n",
        encoding="utf-8",
        newline="\n",
    )

    newest = max(path.stat().st_mtime for path in sources + [manifest, uninstall])
    if exe.exists() and not force and exe.stat().st_mtime >= newest:
        print(f"  bootstrapper exists: {exe}")
        return exe

    args = [
        str(CSC),
        "/nologo",
        "/target:winexe",
        "/platform:anycpu",
        "/optimize+",
        "/langversion:5",
        "/unsafe-",
        "/warn:4",
        "/codepage:65001",
        f"/out:{exe}",
        f"/win32icon:{ICON}",
        f"/win32manifest:{manifest}",
        "/reference:System.dll",
        "/reference:System.Core.dll",
        "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll",
        "/reference:System.Management.dll",
        f"/resource:{SEVEN_ZIP},MedOS.Setup.7z.exe",
        f"/resource:{SEVEN_DLL},MedOS.Setup.7z.dll",
        f"/resource:{ICON},MedOS.Setup.ico",
        f"/resource:{uninstall},MedOS.Setup.uninstall.ps1",
    ] + [str(path) for path in sources]
    print("  compiling bootstrapper")
    result = subprocess.run(args, capture_output=True, text=True)
    if result.stdout.strip():
        print(result.stdout)
    if result.stderr.strip():
        print(result.stderr)
    if result.returncode != 0:
        raise SystemExit(f"csc failed with exit code {result.returncode}")
    return exe


def bundle(exe: Path, archive: Path, dist: Path) -> dict:
    dist.mkdir(parents=True, exist_ok=True)
    out = dist / "MedOS-Setup.exe"
    archive_size = archive.stat().st_size
    exe_size = exe.stat().st_size

    for stale in dist.glob("MedOS-app.7z*"):
        stale.unlink()
    if out.exists():
        out.unlink()

    if exe_size + archive_size + FOOTER.size <= MAX_PART_BYTES:
        print("  bundling payload into a single EXE")
        total = exe_size + archive_size + FOOTER.size
        digest = sha256_file(archive)
        with out.open("wb") as handle:
            with exe.open("rb") as src:
                shutil.copyfileobj(src, handle, 8 * 1024 * 1024)
            offset = handle.tell()
            with archive.open("rb") as src:
                shutil.copyfileobj(src, handle, 8 * 1024 * 1024)
            handle.write(FOOTER.pack(FOOTER_MAGIC, offset, archive_size, bytes.fromhex(digest), 1))
        print(f"  EXE: {out} ({total/1e6:,.1f} MB)")
        return {
            "mode": "single-exe",
            "files": [str(out)],
            "bytes": total,
            "sha256": sha256_file(out),
            "payload_sha256": digest,
        }

    print("  payload is above the per-file limit; emitting bootstrapper + volume parts")
    shutil.copy2(exe, out)
    parts = split_archive(archive, dist)
    emitted = [out] + parts
    for path in emitted:
        print(f"  file: {path.name} ({path.stat().st_size/1e6:,.1f} MB)")
    return {
        "mode": "bootstrapper-plus-parts",
        "files": [str(path) for path in emitted],
        "bytes": {str(path): path.stat().st_size for path in emitted},
        "sha256": {str(path): sha256_file(path) for path in emitted},
        "payload_sha256": sha256_file(archive),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the MedOS Windows installer")
    parser.add_argument("--dist", default=str(DEFAULT_DIST), help="output directory")
    parser.add_argument("--list-only", action="store_true")
    parser.add_argument("--archive-only", action="store_true")
    parser.add_argument("--compile-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    dist = Path(args.dist)
    files = collect_payload()
    stats = summarize(files)

    print(f"MedOS installer payload (version {VERSION})")
    print(f"  root:   {ROOT}")
    print(f"  files:  {stats['file_count']:,}")
    print(f"  bytes:  {stats['uncompressed_bytes']:,} ({stats['uncompressed_bytes']/1e6:,.1f} MB)")
    if stats["missing"]:
        print(f"  missing while scanning: {len(stats['missing'])}")
        for rel in stats["missing"][:10]:
            print(f"    - {rel}")

    if args.list_only:
        for rel, path in files:
            print(rel)
        return 0

    if args.compile_only:
        exe = compile_bootstrapper(args.force)
        print(f"  bootstrapper: {exe} ({exe.stat().st_size/1e6:,.1f} MB)")
        return 0

    archive = build_archive(files, args.force)
    if args.archive_only:
        return 0

    exe = compile_bootstrapper(args.force)
    info = bundle(exe, archive, dist)

    manifest = {
        "product": "MedOS",
        "version": VERSION,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "root": str(ROOT),
        "file_count": stats["file_count"],
        "uncompressed_bytes": stats["uncompressed_bytes"],
        "included_dirs": list(INCLUDE_DIRS),
        "included_root_files": list(INCLUDE_ROOT_FILES),
        "excluded": [
            "data/ (all user content packs)",
            "android-companion/ (APK build toolchain)",
            "MedOS Update/ (old code-only update kit)",
            ".medos-updates/, _backups/, scratch/",
            ".medos-setup/ + setup-drive.json (stale integrity receipt)",
            ".env files, logs, pid files, caches, __pycache__",
        ],
        "installer": info,
        "max_file_bytes": MAX_PART_BYTES,
    }
    manifest_path = dist / "MedOS-Setup.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"  manifest: {manifest_path}")

    total_files = info["files"]
    too_big = [path for path in total_files if Path(path).stat().st_size > MAX_PART_BYTES]
    if too_big:
        print("ERROR: these outputs exceed the per-file limit:")
        for path in too_big:
            print(f"  {path}")
        return 2
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

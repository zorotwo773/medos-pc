"""Build the portable, single-file MedOS Updater and developer update kits.

The updater EXE contains only program code: a tiny C# WinForms launcher and an
appended ZIP of the update kit (update.json, apply_update.py and payload/).
It never contains data/, models/, exports/, .env files or uploads.

Developer workflow
------------------
  * Full code kit (the existing complete update kit):
        python build_updater.py build

  * Small patch from a folder of changed files laid out in relative paths,
    e.g. changed/app/backend/packs.py and changed/app/components/Foo.tsx:
        python build_updater.py patch --changed changed --notes "fix packs text" --embed --external-kit

  * Verify a built EXE or a kit:
        python build_updater.py verify

Every command prints hashes so the result can be checked after transfer.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_KIT = ROOT / "MedOS Update"
DEFAULT_DIST = Path(r"D:\MedOS-installer-dist") if Path("D:/").exists() else HERE / "dist"

CSC = Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe")
ICON = ROOT / "medos.ico"
MANIFEST = HERE / "app.manifest"
SOURCE = HERE / "Updater.cs"
ENGINE = HERE / "apply_update.py"

FOOTER_MAGIC = b"MDSPAY01"
FOOTER = struct.Struct("<8sqq32sI")  # magic, offset, length, sha256, schema
MAX_PART_BYTES = 1_940_000_000

REFERENCES = (
    "System.dll", "System.Core.dll", "System.Windows.Forms.dll",
    "System.Drawing.dll", "System.IO.Compression.dll",
    "System.IO.Compression.FileSystem.dll",
)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path: Path) -> dict:
    text = Path(path).read_text(encoding="utf-8-sig")
    result = json.loads(text)
    if not isinstance(result, dict):
        raise SystemExit(f"Expected a JSON object in {path}")
    return result


def validate_kit(kit: Path) -> dict:
    kit = Path(kit).resolve()
    if not kit.is_dir():
        raise SystemExit(f"Update kit folder not found: {kit}")
    manifest_path = kit / "update.json"
    payload = kit / "payload"
    if not manifest_path.is_file() or not payload.is_dir():
        raise SystemExit(f"Kit needs update.json and payload/: {kit}")
    if not (kit / "apply_update.py").is_file():
        raise SystemExit(f"Kit is missing apply_update.py: {kit}")
    manifest = read_json(manifest_path)
    if manifest.get("schema_version") != 1 or not isinstance(manifest.get("files"), list):
        raise SystemExit(f"Unsupported update.json in {kit}")
    missing = []
    for record in manifest["files"]:
        rel = record.get("path") if isinstance(record, dict) else None
        if not isinstance(rel, str):
            raise SystemExit("update.json contains an invalid file record")
        source = payload.joinpath(*rel.split("/"))
        if not source.is_file():
            missing.append(rel)
        elif source.stat().st_size != record.get("bytes") or digest(source) != str(record.get("sha256", "")).lower():
            missing.append(rel + " (hash/size mismatch)")
    if missing:
        raise SystemExit("Kit verification failed:\n  " + "\n  ".join(missing[:15]))
    return manifest


def zip_kit(kit: Path, destination: Path, replace_engine: bool = True) -> Path:
    """Zip the kit deterministically. No absolute paths, no data directories.

    The updater engine is always replaced with the copy beside this script, so
    a kit built by a developer can never ship an outdated apply_update.py.
    """
    kit = Path(kit).resolve()
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()
    files = []
    for path in sorted(kit.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(kit).as_posix()
        parts = path.relative_to(kit).parts
        if any(part in ("__pycache__", ".git", ".medos-updates") for part in parts[:-1]):
            continue
        if rel.endswith(".pyc"):
            continue
        files.append((rel, path))
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for rel, path in files:
            if replace_engine and rel == "apply_update.py":
                archive.writestr(rel, ENGINE.read_bytes())
            else:
                archive.write(path, rel)
    return destination


def compile_bootstrapper(output: Path) -> Path:
    if not CSC.is_file():
        raise SystemExit(f"C# compiler not found: {CSC}")
    cmd = [str(CSC), "/nologo", "/target:winexe", "/optimize+", "/langversion:5",
           "/platform:anycpu", "/win32manifest:" + str(MANIFEST)]
    if ICON.is_file():
        cmd.append("/win32icon:" + str(ICON))
    for reference in REFERENCES:
        cmd.append("/r:" + reference)
    cmd.extend(["/out:" + str(output), str(SOURCE)])
    result = subprocess.run(cmd, cwd=str(HERE), capture_output=True, text=True)
    if result.returncode != 0 or not output.is_file():
        raise SystemExit("csc failed:\n" + (result.stdout or "") + (result.stderr or ""))
    return output


def bundle(bootstrapper: Path, archive: Path, final: Path) -> dict:
    bootstrapper = Path(bootstrapper)
    archive = Path(archive)
    final = Path(final)
    final.parent.mkdir(parents=True, exist_ok=True)
    offset = bootstrapper.stat().st_size
    archive_digest = digest(archive)
    with final.open("wb") as out:
        with bootstrapper.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                out.write(chunk)
        with archive.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                out.write(chunk)
        out.write(FOOTER.pack(FOOTER_MAGIC, offset, archive.stat().st_size,
                              bytes.fromhex(archive_digest), 1))
    size = final.stat().st_size
    if size > MAX_PART_BYTES:
        raise SystemExit(f"Updater EXE is {size:,} bytes, above the {MAX_PART_BYTES:,} byte limit")
    return {
        "size": size,
        "sha256": digest(final),
        "payload_sha256": archive_digest,
        "payload_offset": offset,
        "payload_length": archive.stat().st_size,
    }


def build_exe(kit: Path, output: Path, work: Path, external_kit: Path | None) -> dict:
    manifest = validate_kit(kit)
    kit_zip = zip_kit(kit, work / "kit.zip")
    bootstrapper = compile_bootstrapper(work / "MedOS-Updater.bootstrap.exe")
    facts = bundle(bootstrapper, kit_zip, output)

    files = manifest.get("files", [])
    total = sum(int(record.get("bytes", 0)) for record in files if isinstance(record, dict))
    result = {
        "product": "MedOS Updater",
        "version": "1.0.0",
        "built_at": utc_now(),
        "kit_mode": manifest.get("mode", "full"),
        "release_id": manifest.get("release_id"),
        "kit_files": len(files),
        "kit_uncompressed_bytes": total,
        "installer": facts,
    }
    manifest_path = output.with_name(output.stem + ".manifest.json")
    manifest_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    if external_kit is not None:
        zip_kit(kit, external_kit)
        print(f"external kit: {external_kit}  ({external_kit.stat().st_size:,} bytes) sha256={digest(external_kit)}")

    print(f"EXE:          {output}  ({facts['size']:,} bytes) sha256={facts['sha256']}")
    print(f"payload:      sha256={facts['payload_sha256']}")
    print(f"manifest:     {manifest_path}")
    return result


def build_patch_kit(changed: Path, kit_out: Path, release_id: str, notes: str) -> Path:
    sys.path.insert(0, str(HERE))
    import apply_update as engine  # noqa: E402

    changed = Path(changed).resolve()
    kit_out = Path(kit_out).resolve()
    if not changed.is_dir():
        raise SystemExit(f"Changed-files folder not found: {changed}")
    if kit_out.exists():
        raise SystemExit(f"Kit output already exists: {kit_out}. Choose a new path.")
    payload = kit_out / "payload"
    payload.mkdir(parents=True)

    records = []
    for path in sorted(changed.rglob("*")):
        if not path.is_file() or path.name.endswith(".pyc"):
            continue
        rel = path.relative_to(changed).as_posix()
        safe = engine.safe_relative(rel).as_posix()  # rejects data/, .env, traversal, etc.
        if safe != rel:
            raise SystemExit(f"Unsafe relative path in changed folder: {rel}")
        target = payload.joinpath(*safe.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
        records.append({"path": safe, "bytes": target.stat().st_size, "sha256": digest(target)})
    if not records:
        raise SystemExit(f"No files found in {changed}")

    manifest = {
        "schema_version": 1,
        "mode": "patch",
        "release_id": release_id,
        "generated_at": utc_now(),
        "notes": notes or "Developer patch",
        "files": records,
    }
    (kit_out / "update.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (kit_out / "apply_update.py").write_bytes(ENGINE.read_bytes())
    (kit_out / "README.txt").write_text(
        "MedOS patch update kit\r\n"
        "=======================\r\n\r\n"
        f"Mode: patch\r\nRelease: {release_id}\r\n"
        f"Generated: {manifest['generated_at']}\r\n\r\n"
        + manifest["notes"] + "\r\n\r\n"
        "Apply with MedOS-Updater.exe /kit=<this folder> or embed it in a new EXE.\r\n",
        encoding="utf-8",
    )
    print(f"patch kit:    {kit_out}  ({len(records)} file(s))")
    return kit_out


def verify(exe: Path | None, kit: Path | None) -> None:
    if exe is not None:
        exe = Path(exe).resolve()
        size = exe.stat().st_size
        with exe.open("rb") as stream:
            stream.seek(-60, os.SEEK_END)
            footer = stream.read(60)
        magic, offset, length, checksum, schema = FOOTER.unpack(footer)
        if magic != FOOTER_MAGIC or schema != 1 or offset + length + 60 != size:
            raise SystemExit("EXE footer is invalid")
        actual = hashlib.sha256()
        with exe.open("rb") as stream:
            stream.seek(offset)
            remaining = length
            while remaining > 0:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise SystemExit("EXE payload is truncated")
                actual.update(chunk)
                remaining -= len(chunk)
        ok = actual.hexdigest() == checksum.hex()
        print(f"EXE: {exe}\n  size={size:,} payload={length:,} offset={offset:,}")
        print(f"  payload_sha256={actual.hexdigest()} match={ok}")
        if not ok:
            raise SystemExit("EXE payload checksum FAILED")
    if kit is not None:
        manifest = validate_kit(Path(kit))
        print(f"Kit: {Path(kit).resolve()}\n  mode={manifest.get('mode','full')} release={manifest.get('release_id')} files={len(manifest['files'])} OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command")

    p_build = sub.add_parser("build", help="build the updater EXE around a complete update kit")
    p_build.add_argument("--kit", type=Path, default=DEFAULT_KIT, help=f"update kit folder (default: {DEFAULT_KIT})")
    p_build.add_argument("--output", type=Path, default=DEFAULT_DIST / "MedOS-Updater.exe")
    p_build.add_argument("--external-kit", type=Path, nargs="?", const=DEFAULT_DIST / "MedOS-UpdateKit-full.zip",
                         help="also write the kit as a standalone .zip")
    p_build.add_argument("--force", action="store_true")

    p_patch = sub.add_parser("patch", help="create a small patch kit from a folder of changed files")
    p_patch.add_argument("--changed", type=Path, required=True, help="folder of changed files in relative paths")
    p_patch.add_argument("--kit-out", type=Path, default=DEFAULT_DIST / "MedOS-UpdateKit-patch")
    p_patch.add_argument("--release-id", default=None, help="target release (default: from C:\\MedOS\\setup-drive.json)")
    p_patch.add_argument("--notes", default="")
    p_patch.add_argument("--embed", action="store_true", help="build an EXE embedding this patch")
    p_patch.add_argument("--external-kit", action="store_true", help="write this patch as a standalone .zip")
    p_patch.add_argument("--output", type=Path, default=DEFAULT_DIST / "MedOS-Updater.exe")
    p_patch.add_argument("--force", action="store_true")

    p_verify = sub.add_parser("verify", help="verify a built EXE and/or an update kit")
    p_verify.add_argument("--exe", type=Path, default=DEFAULT_DIST / "MedOS-Updater.exe")
    p_verify.add_argument("--kit", type=Path, default=None)

    args = parser.parse_args()
    command = args.command or "build"
    if command == "verify":
        verify(getattr(args, "exe", None), getattr(args, "kit", None))
        return 0

    if command == "patch":
        marker = ROOT / "setup-drive.json"
        fallback = "medos-1.1.5"
        if marker.is_file():
            fallback = str(read_json(marker).get("release_id") or fallback)
        release_id = args.release_id or fallback
        kit = build_patch_kit(args.changed, args.kit_out, release_id, args.notes)
        if not (args.embed or args.external_kit):
            return 0
        with tempfile.TemporaryDirectory(prefix="medos-updater-build-") as temp:
            work = Path(temp)
            if args.external_kit:
                external = args.kit_out.with_suffix(".zip")
                zip_kit(kit, external)
                print(f"external kit: {external}  ({external.stat().st_size:,} bytes) sha256={digest(external)}")
            if args.embed:
                if args.output.exists() and not args.force:
                    raise SystemExit(f"{args.output} exists; pass --force to replace it")
                build_exe(kit, args.output, work, None)
        return 0

    # build
    output = Path(args.output)
    if output.exists() and not args.force:
        raise SystemExit(f"{output} exists; pass --force to replace it")
    with tempfile.TemporaryDirectory(prefix="medos-updater-build-") as temp:
        build_exe(Path(args.kit), output, Path(temp), getattr(args, "external_kit", None))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Self-checks for the updater engine (full + patch modes, safety guards)."""
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_update as au

work = Path(tempfile.mkdtemp(prefix="medos-updater-engine-"))


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def rec(payload, rel):
    p = payload / rel
    return {"path": rel, "bytes": p.stat().st_size, "sha256": digest(p)}


def write_manifest(kit, files, **extra):
    data = {"schema_version": 1, "release_id": "medos-1.1.5", "files": files}
    data.update(extra)
    (kit / "update.json").write_text(json.dumps(data, indent=2), encoding="utf-8")


try:
    # ---------- patch mode ----------
    root, kit = work / "root", work / "patchkit"
    (kit / "payload" / "app" / "backend").mkdir(parents=True)
    (root / "data").mkdir(parents=True)
    (root / "app" / "backend").mkdir(parents=True)
    (root / "setup-drive.json").write_text('{"release_id":"medos-1.1.5"}', encoding="utf-8")
    (root / "data" / "progress.sqlite").write_text("KEEP-DATA", encoding="utf-8")
    (root / "notes.txt").write_text("KEEP-NOTES", encoding="utf-8")
    (root / "app" / "backend" / "old.py").write_text("OLD", encoding="utf-8")
    (root / "app" / "backend" / ".env").write_text("SECRET=1", encoding="utf-8")
    (kit / "payload" / "app" / "backend" / "old.py").write_text("NEW-CODE", encoding="utf-8")
    write_manifest(kit, [rec(kit / "payload", "app/backend/old.py")], mode="patch")
    backup = au.apply_update(root, kit, check_ports=False)
    assert (root / "app/backend/old.py").read_text(encoding="utf-8") == "NEW-CODE"
    assert (root / "data/progress.sqlite").read_text(encoding="utf-8") == "KEEP-DATA"
    assert (root / "notes.txt").read_text(encoding="utf-8") == "KEEP-NOTES"
    assert (root / "app/backend/.env").read_text(encoding="utf-8") == "SECRET=1"
    assert backup.exists()
    print("PATCH apply: OK (data, notes, .env preserved; backup written)")

    # ---------- path guards ----------
    for label, rel in (("data", "data/x.txt"), ("env", "app/backend/.env")):
        bad = work / ("bad-" + label)
        p = bad / "payload" / Path(rel).parent
        p.mkdir(parents=True, exist_ok=True)
        (bad / "payload" / rel).write_text("x", encoding="utf-8")
        write_manifest(bad, [rec(bad / "payload", rel)], mode="patch")
        try:
            au.apply_update(root, bad, check_ports=False)
        except au.UpdateError:
            print(f"PATCH {label} guard: OK")
        else:
            raise AssertionError(f"{label} path was allowed")

    # ---------- verification failure + rollback ----------
    badhash = work / "badhash"
    shutil.copytree(kit, badhash)
    m = json.loads((badhash / "update.json").read_text(encoding="utf-8"))
    m["files"][0]["sha256"] = "0" * 64
    (badhash / "update.json").write_text(json.dumps(m), encoding="utf-8")
    try:
        au.apply_update(root, badhash, check_ports=False)
    except au.UpdateError:
        assert (root / "app/backend/old.py").read_text(encoding="utf-8") == "NEW-CODE"
        assert not (root / ".medos-updates/update.lock").exists()
        print("PATCH hash guard + lock cleanup: OK")
    else:
        raise AssertionError("bad hash was accepted")

    # ---------- full mode minimal kit ----------
    froot, fkit = work / "fullroot", work / "fullkit"
    fp = fkit / "payload"
    required = [
        "app/.next/BUILD_ID", "app/.next/required-server-files.json",
        "app/.next/routes-manifest.json", "app/.next/build-manifest.json",
        "app/.next/prerender-manifest.json", "app/.next/server/pages-manifest.json",
        "app/.next/server/app-paths-manifest.json", "setup-drive.json",
    ]
    for rel in required:
        p = fp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith("BUILD_ID"):
            p.write_text("build-xyz", encoding="utf-8")
        elif rel.endswith("setup-drive.json"):
            p.write_text('{"release_id":"medos-1.1.5"}', encoding="utf-8")
        elif rel.endswith("required-server-files.json"):
            p.write_text('{"files":[]}', encoding="utf-8")
        else:
            p.write_text("{}", encoding="utf-8")
    froot.mkdir(parents=True)
    (froot / "setup-drive.json").write_text('{"release_id":"medos-1.1.5"}', encoding="utf-8")
    (froot / "data").mkdir()
    (froot / "data/progress.sqlite").write_text("FULL-DATA", encoding="utf-8")
    write_manifest(fkit, [rec(fp, r) for r in required],
                   replace_directories=["app/.next"])
    backup2 = au.apply_update(froot, fkit, check_ports=False)
    assert (froot / "app/.next/BUILD_ID").read_text(encoding="utf-8") == "build-xyz"
    assert (froot / "data/progress.sqlite").read_text(encoding="utf-8") == "FULL-DATA"
    assert backup2.exists()
    print("FULL apply: OK (.next replaced, data preserved)")

    print("ALL ENGINE CHECKS PASSED")
finally:
    shutil.rmtree(work, ignore_errors=True)

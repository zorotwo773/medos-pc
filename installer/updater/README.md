# MedOS Updater — developer handoff

A standalone, single-file updater. It is **not** the full installer: it only applies an
update kit to an existing MedOS 1.1.4 / 1.1.5 install. It contains no user data.

## Deliverables

| File | Purpose |
|---|---|
| `D:\MedOS-installer-dist\MedOS-Updater.exe` | Single-file updater with the current full update kit embedded (257,794,356 bytes) |
| `D:\MedOS-installer-dist\MedOS-Updater.manifest.json` | Build metadata and hashes |
| `D:\MedOS-installer-dist\MedOS-UpdateKit-full.zip` | The same kit as a standalone file, for `/kit=` |
| `D:\MedOS-installer-dist\MedOS-UpdateKit-patch-example.zip` | Tiny example patch kit showing the expected layout |
| `C:\MedOS\installer\updater\` | Source: `Updater.cs`, `apply_update.py`, `build_updater.py`, tests |

## New developers: start here

Send the copy-paste block in `DEVELOPER_START_PROMPT.md` (also copied to
`D:\MedOS-installer-dist\MedOS-DEVELOPER-START-PROMPT.md`) as the **first message** of a
new chat with me. It makes me locate MedOS on that PC, find this toolkit, respect the
no-user-data rules, record every edit in `C:\MedOS\.medos-dev\CHANGELOG.md`, stage every
changed file in `C:\MedOS\.medos-dev\changes\`, and build + verify a new EXE when you say
**"add it to the exe"**.

## How a developer adds an update

Give me (the AI) the changed files, laid out in their **relative MedOS paths**, and tell me
whether to embed the update in a new EXE or ship it as an external kit. I run one command:

### Small, targeted patch

```powershell
# changed/ contains e.g. changed/app/backend/packs.py and changed/app/components/Foo.tsx
& C:\MedOS\tools\python\python.exe C:\MedOS\installer\updater\build_updater.py `
  patch --changed changed --notes "fix backend text" --embed --external-kit --force
```

`--embed` produces a tiny self-contained `MedOS-Updater.exe` (a 2-file patch produced a
40,950-byte EXE). `--external-kit` writes `MedOS-UpdateKit-patch.zip` for `/kit=`.
`--release-id` defaults to the release in `C:\MedOS\setup-drive.json`.

Patch kits **never** replace whole directories. They copy only the listed files, so a
one-line fix does not require rebuilding the Next.js frontend.

### Complete code kit

```powershell
& C:\MedOS\tools\python\python.exe C:\MedOS\installer\updater\build_updater.py `
  build --kit "C:\MedOS\MedOS Update" --force --external-kit
```

Use this when the frontend was rebuilt. The kit must contain `update.json` (schema 1),
`payload/`, and `apply_update.py`. The build script **always injects the current engine**
from `C:\MedOS\installer\updater\apply_update.py`, so an outdated engine cannot slip in.

### Verify a build

```powershell
& C:\MedOS\tools\python\python.exe C:\MedOS\installer\updater\build_updater.py verify
& C:\MedOS\tools\python\python.exe C:\MedOS\installer\updater\test_engine.py
```

## Running the updater

GUI: double-click `MedOS-Updater.exe`. It auto-detects the install folder, offers
**Verify only** and **Apply update**, and logs to
`%LOCALAPPDATA%\MedOS\updater.log`.

Silent / automation:

```
MedOS-Updater.exe /silent /root=C:\MedOS /verify /ignoreports /log=C:\temp\updater.log
MedOS-Updater.exe /silent /root=C:\MedOS /kit=C:\kits\patch.zip /log=C:\temp\updater.log
```

| Flag | Meaning |
|---|---|
| `/root=<folder>` | Target install (auto-detected from HKCU registry, the EXE's own folder, then `C:\MedOS`) |
| `/kit=<folder-or-zip>` | External kit; omitted = use the embedded kit |
| `/verify` | Full validation, no files changed |
| `/ignoreports` | Apply while MedOS is running (only from a controlled launcher) |
| `/silent` | No UI; exit 0 = success, 2 = failure |
| `/log=<file>` | Override the log path |

## Safety guarantees (enforced in `apply_update.py`)

- Only whitelisted program paths may be written; `data/`, `models/`, `exports/`, `.env`,
  uploads and native `node_modules` are rejected outright.
- Every file's size and SHA-256 are checked before staging and again after staging.
- Files are staged, then published with an atomic move sequence; a failure rolls back
  and leaves a recovery lock for manual inspection.
- A rollback copy is written under `<install>\.medos-updates\<timestamp>\backup`.
- Port 3000/8002 check prevents updating a running MedOS unless explicitly overridden.
- Full kits replace `app/.next` as one unit. Next's build may place junctions inside
  `.next/node_modules` (e.g. `pdfjs-dist`); those are allowed for full kits because the
  whole directory is replaced. Patch kits keep strict link checks on every target file.

## Tested

- Engine unit checks: patch apply, data/`.env` guards, bad-hash rejection with rollback and
  lock cleanup, full-kit apply with data preserved.
- Embedded full kit `/verify` against `C:\MedOS`: exit 0, no files changed.
- External full kit `.zip` `/verify`: exit 0.
- External patch kit applied to an isolated fake install: patch files written, data and
  `.env` unchanged, backup created.
- Patch EXE with embedded kit applied to an isolated fake install: exit 0.
- GUI launches with title "MedOS Updater" and closes cleanly.
- Final EXE: 257,794,356 bytes (under the 1,940,000,000-byte limit), footer checksum and
  manifest hash verified.

## Important

Only load kits you trust. An external kit supplies the Python engine that the updater runs.
The embedded kit is hashed by the EXE footer; external kits are verified only against their
own `update.json`, so obtain them from the project's normal distribution channel.

# MedOS PC — source repository

This repository contains the **PC/Windows desktop** side of MedOS: the Next.js
app, FastAPI backend, installer/build sources, bundled runtime payload, docs,
tests and the PC overlay sources used to produce the release.

**Android is deliberately excluded.** No Android app source, signing material,
companion APK or phone-only helper files are included in this repository.

## Repository layout

| Path | Contents |
|---|---|
| `app/` | Next.js desktop app and FastAPI backend (including compiled `.next` build) |
| `tools/` | Bundled Python and Node runtimes, bundled 7-Zip, sync helpers |
| `installer/` | `build_installer.py`, bootstrapper source, updater and installer validation scripts |
| `setup_center/`, `docs/`, `linux/`, `mac/`, `MedOS.app/` | PC setup and cross-platform desktop support files |
| `source-overlay/pc/` | Authoritative PC overlay sources, publish map, hashes and PDF regression tests |
| `.medos-dev/` | Developer change log and release record |
| `release/` | Release manifest for the setup EXE |
| Root launchers/docs | `START.ps1`, `STOP.ps1`, `README.md`, user guide, distribution notes |

Large binary payload files are stored with **Git LFS**. Install Git LFS before
cloning if you need the real binaries:

```powershell
git lfs install
git clone https://github.com/zorotwo773/medos-pc.git
git lfs pull
```

## Releases

The prepared installer is attached to the GitHub Release as
`MedOS-Setup.exe`, not committed as a normal repository file.

Current release: `medos-1.1.5`

- EXE SHA-256: `251a645bdc613c509caeffc8aa97239554a84cd480cd114490d049f3252d3cf9`
- Payload SHA-256: `4ddb8e92fdde68f833bee020bb38e11b52ed0d64f40fb2abe764e41203739fd4`

The installer build also excludes the first-party phone/Android-only helper
files and any APK/signing material from the payload.

## Rebuilding the installer

From the repository root:

```powershell
& .\tools\python\python.exe -B .\installer\build_installer.py --force
```

The build writes `MedOS-Setup.exe` and `MedOS-Setup.manifest.json` to
`D:\MedOS-installer-dist` by default.

## Verification

PC PDF regression suite:

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONDONTWRITEBYTECODE='1'
& .\tools\python\python.exe -B .\source-overlay\pc\test-output\test_pdf_export.py
```

Expected final line:

```text
ALL PDF EXPORT TESTS PASSED
```

Installer checks:

```powershell
powershell -File .\installer\build\test_installer.ps1
powershell -File .\installer\build\validate_install.ps1 -Dir <scratch-install-dir>
```

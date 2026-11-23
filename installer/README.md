# MedOS Windows installer

`MedOS-Setup.exe` installs the MedOS program on Windows 10/11. It needs no
administrator rights, no system Python and no system Node — every runtime it
uses ships inside the installer.

The installer deliberately contains **program files only**. Books, media,
caches, notes, models and exports belong to the user, live in Content Manager
and are never bundled, overwritten or deleted by an update.

## What ships inside the payload

Included:

| Item | Notes |
| --- | --- |
| `app/` | Next.js build, backend, node_modules, `.next` |
| `tools/python/` | bundled CPython with FastAPI, FAISS, PyMuPDF, numpy |
| `tools/node/` | bundled Node.js runtime |
| `setup_center/` | setup-center code |
| `docs/`, `linux/`, `mac/`, `MedOS.app/` | documentation and other-platform launchers |
| `START.ps1`, `START.bat`, `STOP.ps1`, `STOP.bat`, `launch.vbs` | launchers |
| `medos.ico`, `medos.icns`, `*.command` | icons and mac/linux helpers |
| `MedOS-Companion.apk` | 41 KB Android companion stub (no `android-companion/` sources) |

Excluded on purpose:

- `data/`, `models/`, `exports/` — user content.
- `app/.env`, `app/backend/.env` — secrets are generated on first start.
- `app/uploads/`, `app/public/uploads/` — user files.
- `.medos-updates/`, `MedOS Update/`, old `release-*` receipts.
- `.next/**/*.map`, `__pycache__`, `*.pyc`, `*.pdb`, `*.lib`, logs, `.env*`.
- `node_modules/torch/include`, `torchgen`, `pip`/`setuptools`/`pkg_resources`,
  npm man/docs, and the `pdfjs-dist` junction (the real folder is shipped).

## Build

```powershell
C:\MedOS\tools\python\python.exe C:\MedOS\installer\build_installer.py --list-only
C:\MedOS\tools\python\python.exe C:\MedOS\installer\build_installer.py            # archive + EXE
C:\MedOS\tools\python\python.exe C:\MedOS\installer\build_installer.py --compile-only --force
C:\MedOS\tools\python\python.exe C:\MedOS\installer\build_installer.py --force    # rebuild all
```

Outputs:

- `installer/build/MedOS-app.7z` — solid LZMA2 payload (~533 MB from ~2.23 GB).
- `D:\MedOS-installer-dist\MedOS-Setup.exe` — bootstrapper + payload + footer.
- `D:\MedOS-installer-dist\MedOS-Setup.manifest.json` — build metadata (version,
  file count, sizes, SHA-256). Optional: the EXE neither reads nor needs it, so
  do **not** ship it to users.

The payload is compressed with `-mx=7 -m0=lzma2 -md=32m -mfb=64 -ms=on -mmt=4`.
`-mx=9` needs far more scratch memory than the build machine has and aborts with
7-Zip exit code 8.

If a future payload exceeds the per-file limit (1,940,000,000 bytes), the
builder emits `MedOS-Setup.exe` plus `MedOS-app.7z.001/.002/...` and
`MedOS-app.sha256`; keep them in one folder. The bootstrapper concatenates and
verifies the parts itself.

While the payload fits (as it does now), the single `MedOS-Setup.exe` is the
only file users need. Nothing else — manifest, archive, checksum file — is
required beside it.

## Layout of the EXE

```
[ bootstrapper PE ][ payload 7z ][ footer 60 bytes ]
```

Footer (`<8sqq32sI`): magic `MDSPAY01`, payload offset, payload length,
SHA-256 of the payload, schema `1`. The installer verifies the checksum before
extracting anything.

## Command line

```
MedOS-Setup.exe                              interactive setup
MedOS-Setup.exe /new /dir=C:\MedOS           install without prompts
MedOS-Setup.exe /update /dir=C:\MedOS        replace program files, keep content
MedOS-Setup.exe /silent /new /dir=D:\MedOS   unattended (used by automation)
MedOS-Setup.exe /uninstall                   start the uninstaller
MedOS-Setup.exe /help
```

Exit codes: `0` success, `1` failure. Log: `%LOCALAPPDATA%\MedOS\setup.log`.

## What an update keeps

`data/`, `models/`, `exports/`, `app/.env`, `app/backend/.env`,
`app/uploads/`, `app/public/uploads/` are moved aside and put back after the
new program files land. The previous program tree is deleted on success; on
failure the old tree is restored.

`app/.next/required-server-files.json` records the build folder, so the
installer rewrites `outputFileTracingRoot` to the actual install path. That is
what makes the same EXE work from any drive or folder.

## After install

- Desktop shortcut: `MedOS.lnk` → `wscript.exe "<dir>\launch.vbs"`, icon `medos.ico`.
- Start menu: `MedOS\MedOS.lnk` and `MedOS\Uninstall MedOS.lnk`.
- Registry (per user): `HKCU\Software\MedOS` and
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS`.
- Marker file: `<dir>\.medos-install.json`.

## Regression tests

```powershell
# fake tiny payload: new install, update keeps data, uninstaller, bare installer
powershell -NoProfile -File C:\MedOS\installer\build\test_installer.ps1

# real payload installed to a scratch folder
powershell -NoProfile -File C:\MedOS\installer\build\validate_install.ps1 -Dir D:\MedOS-install-check
```

`make_test_bundle.py` builds the tiny payload used by the first suite.

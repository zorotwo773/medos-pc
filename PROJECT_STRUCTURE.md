# MedOS Project Structure

This file is a map of the current workspace layout.

Last reviewed: 2026-05-15

## Top-Level Layout

```text
MedOS/
|-- README.md                         # Setup and transfer overview
|-- PROJECT_STRUCTURE.md              # This project map
|-- TRANSFER.md                       # Same-Wi-Fi transfer workflow
|-- medos_data_manifest.md            # Phone/offline data layout manifest
|-- START.bat / START_DEV.bat / STOP.bat
|                                      # Windows runtime launchers
|-- launch.vbs / launch_dev.vbs       # Silent VBS wrappers for the launchers
|-- SETUP_NEW_PC.ps1                  # Dependency setup after GitHub clone
|-- SETUP_DATA.ps1                    # Local data folder / junction setup
|-- BUILD_MEDOS_INSTALLER.cmd         # Builds dist\MedOS_Setup.exe
|-- INSTALL_NEW_PC.cmd / .ps1         # Post-transfer / post-copy installer
|-- TRANSFER_SERVE.ps1                # Source-PC LAN transfer server
|-- TRANSFER_PULL.ps1                 # Target-PC LAN transfer pull
|-- transfer_server.py                # HTTP transfer helper (used by TRANSFER_SERVE)
|-- medos.ico                         # App icon (used by installer + shortcuts)
|-- app/                              # Main Next.js + FastAPI application
|-- docs/                             # Handoff docs, plans, implementation notes
|-- installer/                        # Installer wizard + builder
|-- data/                             # Local licensed/offline data and generated DBs
|-- models/                           # Local embedding/reranker/model files
|-- archive/                          # Retired scripts and recordings
`-- dist/                             # Generated installer output (MedOS_Setup.exe)
```

## Main App Layout

```text
app/
|-- app/                              # Next.js App Router routes
|   |-- layout.tsx                    # Root shell
|   |-- page.tsx                      # Dashboard/home
|   |-- globals.css                   # Global styles
|   |-- amboss/page.tsx
|   |-- anatomy/page.tsx
|   |-- anki/page.tsx
|   |-- calculators/page.tsx
|   |-- chat/page.tsx
|   |-- diseases/page.tsx
|   |-- drugs/page.tsx
|   |-- lexi/page.tsx
|   |-- library/page.tsx
|   |-- qbank/page.tsx
|   |-- uptodate/page.tsx
|   `-- api/
|       |-- anki/media/[...path]/route.ts
|       `-- lexi-calc/list/route.ts
|-- components/                       # Frontend feature components
|   |-- amboss/
|   |-- anatomy/
|   |-- calculators/
|   |-- chat/
|   |-- common/
|   |-- dashboard/
|   |-- diseases/
|   |-- drugs/
|   |-- firstaid/
|   |-- layout/
|   |-- lexi/
|   |-- library/
|   |-- qbank/
|   |-- reader/
|   |-- search/
|   |-- ui/
|   `-- uptodate/
|-- lib/                              # Shared frontend utilities/hooks
|-- public/                           # Static frontend assets
|-- types/                            # Shared TypeScript declarations
|-- chrome-extension/                 # MedOS reference sidebar extension
|-- backend/                          # FastAPI backend
|-- docs/                             # App-level implementation notes
|-- package.json                      # Next.js scripts and dependencies
|-- next.config.ts
|-- tsconfig.json
`-- eslint.config.mjs
```

## Backend Layout

```text
app/backend/
|-- main.py                           # FastAPI app, startup, CORS, mounted routers
|-- config.py                         # Environment/path configuration (ROOT-relative defaults)
|-- requirements.txt                  # Python dependencies
|-- .env.example                      # Template — copy to .env and fill in values
|-- amboss_reader.py
|-- amboss_crypto.py
|-- cliniccons_reader.py
|-- firstaid.py
|-- qbank_reader.py
|-- reference_reader.py
|-- rebuild_index.py
|-- routers/
|   |-- anki.py
|   |-- ao.py
|   |-- drugs.py
|   |-- firstaid.py
|   |-- glossary.py
|   |-- lexi_calc.py
|   |-- library.py
|   `-- search.py
|-- scripts/                          # Index-build and data-pipeline scripts
|-- amboss_static/                    # Vendored AMBOSS static assets
`-- static/pdfjs/                     # Vendored PDF.js runtime
```

## Installer Layout

```text
installer/
|-- MedOS_Setup_Wizard.ps1            # GUI installer wizard (also used by EXE)
|-- BUILD_MEDOS_INSTALLER.ps1         # Builder: produces dist\MedOS_Setup.exe
`-- run_setup.cmd                     # Entry point run by the EXE bootstrapper
```

## Archive

```text
archive/
|-- test.ps1                          # Scratch PowerShell test snippet
|-- vacuum_utd.py                     # One-off SQLite VACUUM utility (hardcoded paths)
|-- adb_push.ps1                      # Android ADB data-push utility
|-- phone app.md                      # Phone app planning notes
|-- export-mdcalc-realm-catalog.mjs   # MDCalc data export utility
`-- recordings/                       # Screen recordings
```

## Docs Layout

```text
docs/
|-- PHASE1_COMPLETE.md
|-- PHASE1_HANDOFF.md
|-- RAG_BUILD_HANDOFF.md
|-- first_aid_plan.md
|-- medos_improvement_roadmap_52cde796.plan.md
`-- hey-i-have-updated-imperative-crayon.md

app/docs/
|-- AO_ORTHO_MODE_HANDOFF.md
|-- HUMERUS_ORTHO_PLAN.md
|-- QBANK_WORKFLOW.md
|-- REFERENCE_BOX_EXTENSION.md
`-- Referance box.md
```

## Local Data Layout

`data/` and `models/` are machine-local and git-ignored. They are copied from another
machine or rebuilt separately. The backend resolves all paths relative to its own file
location so no absolute paths need to be hardcoded — `app\backend\config.py` computes
ROOT as `_HERE.parent.parent` (i.e. the MedOS folder) automatically.

```text
data/
|-- amboss/
|-- anatomy/
|-- ao/
|-- bm25/
|-- books/                           # Usually a junction/link to large PDF storage
|-- faiss/
|-- Lexi/
|-- uptodate/
|-- uworld/
|-- _fa_snippet_cache/
|-- book_chapter_index.sqlite
|-- concept_links.sqlite
|-- drug_reference.sqlite
|-- firstaid_index.sqlite
|-- glossary.db
|-- qbank_state.sqlite3
|-- reference_entities.sqlite
`-- reference_lookup.sqlite
```

## Git-Ignored Areas

These exist locally but are not in version control:

- `data/`, `models/`
- `.venv/`, `venv/`, `__pycache__/`
- `app/node_modules/`, `app/.next/`, `app/tsconfig.tsbuildinfo`
- `dist/`, `installer/build/`
- `.tmp/`, `*.log`, `*.pid`, `*.err`
- `archive/`
- `app/backend/.env`
- IDE and browser profile folders

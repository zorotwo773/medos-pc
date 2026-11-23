# MedOS Current Desktop Architecture

This document is the authoritative map of the current desktop runtime and the release boundary for the universal desktop release work. It describes the executable architecture that exists in the repository today. `BUILD_UNIVERSAL_RELEASE.ps1` is the new canonical full-desktop builder being introduced by this release work; it is planned, not yet created or verified.

## Runtime flow

```text
Windows: START.bat -> START.ps1 -> app/START.ps1
macOS:   MedOS.app or MedOS.command -> mac/start.sh
browser -> Next.js :3000 -> /api rewrites -> FastAPI :8002 -> canonical data readers
status page :4321 observes both services
```

`START.bat` launches the root PowerShell launcher. `START.ps1` validates the portable Windows runtimes, prepares session state and launcher coordination, then delegates to `app/START.ps1`. The app launcher starts the status server first, then `backend/main.py` and `npm start`. The status page waits for HTTP readiness of FastAPI and Next.js before redirecting to the app.

On macOS, `MedOS.app` and `MedOS.command` enter `mac/start.sh`. The Mac launcher performs the same status-first sequence and starts `backend/main.py` and `npm start` in the background. It can serve a device on the same LAN, but the primary desktop URL remains `http://127.0.0.1:3000`.

## Runtime roots and ownership

| Area | Runtime root and owner | Responsibility |
| --- | --- | --- |
| Desktop root | `MedOS/` | Portable release boundary: launchers, `app/`, `data/`, `models/`, and platform runtime folders live under this root. |
| Windows runtime | `tools/python/python.exe`, `tools/node/node.exe` | Root and app launchers prefer these bundled Python and Node runtimes; development fallbacks are secondary. |
| macOS runtime | `mac-tools/<arm64-or-x64>/python/bin/python3`, `mac-tools/<arm64-or-x64>/node/bin/node` | `mac/start.sh` selects an architecture-specific bundled runtime when present, supports the legacy `mac-tools/python` and `mac-tools/node` layout, then falls back to a development or system runtime. |
| Frontend | `app/` | Next.js owns the browser UI. `app/next.config.ts` rewrites `/api/:path*` to `http://127.0.0.1:8002/:path*`; the browser does not read medical databases directly. |
| Backend | `app/backend/` | FastAPI owns API routes and canonical data-reader execution. `backend/config.py` resolves `ROOT` to `MEDOS_ROOT` when configured, otherwise the MedOS desktop root. |
| Canonical medical data | `ROOT/data/` | Backend readers own reference databases, question banks, books, Anki, search indexes, and derived SQLite files. Environment variables and `data/user_content.json` may point a reader to a user-supplied replacement source. |
| Models | `ROOT/models/` | Local embedding and reranker assets for optional retrieval/AI work; they are not required for the base browser, FastAPI, or Next.js processes to run. |
| Pack mapping | `app/backend/pack_paths.py` | The Content Manager/torrent mapping owns pack-to-path membership. The `mehlman` pack is discovered dynamically: each complete `data/mehlman-*` directory with a non-empty matching `.db` is included. |

The backend's `config.py` is the path-resolution authority. Readers consume its ROOT-relative paths (or valid explicit overrides), including `data/uptodate`, `data/amboss`, `data/uworld`, `data/books`, `data/anki`, UMLS, drug, glossary, reference, and search-index databases. The Content Manager can persist selected source overrides in `data/user_content.json`; those do not change the browser-to-API boundary.

## Processes, ports, and diagnostics

| Service | Port | Process | Logs and PID files |
| --- | ---: | --- | --- |
| Status page | `4321` | `app/status_server.py` | `app/status.pid`; it tails the backend and frontend logs and observes readiness. |
| Backend | `8002` | `app/backend/main.py` running FastAPI/Uvicorn | `app/backend.log`, `app/backend.err`, `app/backend.pid` |
| Frontend | `3000` | `npm start` / Next.js | `app/frontend.log`, `app/frontend.err`, `app/frontend.pid` |

The status page is a startup observer, not a data service. It checks the FastAPI health endpoint and the frontend before redirecting the browser. Root launchers also clear stale log and PID files before a new Windows launch; both platform launchers stop prior listeners on these three ports.

## Platform behavior and core scope

Windows desktop releases are portable through the bundled `tools/` Python and Node runtimes. macOS releases use `mac-tools/` when supplied; `mac/start.sh` may also use a configured development or system Python/Node runtime. The Mac launcher supports a shared/external data root through `MEDOS_ROOT` (for example, configured by `mac/attach-data.sh`) and starts even when medical data has not yet been attached, with reference content unavailable until then.

The universal desktop core promise is the offline desktop application and its canonical local data readers. Optional AI behavior is not a Mac core-runtime guarantee: NVIDIA NIM/RAG and Gemini require configured API keys, and local model-backed retrieval requires the relevant model assets. Torrent and in-app data-sync/seeding features are also optional operational features, not a requirement for the Mac core runtime to launch the desktop application.

## Current release boundary

`BUILD_UNIVERSAL_RELEASE.ps1` is the sole current full-desktop builder for this release work. It is intentionally documented as the canonical builder being introduced here; the script does not yet exist and has not been verified.

The following scripts are historical or special-purpose inputs, not the validated universal export path:

- `PACK_EVERYTHING.ps1`
- `PACK_RELEASE.ps1`
- `PACK_FINAL.ps1`
- `PACK_MAC_OVERLAY.ps1`
- `PACK_RELEASE_MAC.sh`

They remain useful as historical packaging references or targeted packaging tools, but no release validation may treat them as the current universal desktop export path.

Phone releases and phone-data archives are separate products. They are absent from the desktop ZIP; a desktop release does not include `MedOS.apk`, phone source, or phone-data archives.

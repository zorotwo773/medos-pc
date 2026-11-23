# Running MedOS on macOS

MedOS was built for Windows, but the app itself (a FastAPI backend + a Next.js
frontend) is fully cross-platform. These scripts replace the Windows launchers
with macOS-native equivalents. **No code in `app/` changes** — only how it's
started.

> Works on Apple Silicon (M-series) and Intel Macs, macOS 12 Monterey or newer.

---

## First time on this Mac (once)

1. Copy the whole MedOS folder onto the Mac (external SSD or network copy).
2. Run setup once. The easiest route is to double-click **MedOS-Setup.command**
   in the main MedOS folder. Setup opens a Terminal window on purpose because it
   has to show download/install progress and any Homebrew prompts.

   If double-clicking is blocked, use Terminal instead: type `cd `, drag the
   MedOS folder into the Terminal window, press Return, then run:

   ```bash
   bash mac/setup.sh
   ```

   This installs Python/Node if missing (via [Homebrew](https://brew.sh)),
   builds a fresh Python environment, reinstalls the Node packages, and builds
   the frontend. The first run downloads a few GB and can take 10–20 minutes.

   **Faster, smaller install** — skip the AI-chat machine-learning stack
   (torch/faiss/transformers, several GB). Every reference feature still works;
   only the AI `/chat` tab is disabled:

   ```bash
   bash mac/setup.sh --lite
   ```

After setup finishes, it creates **MedOS.app** and **MedOS Stop.app** in the
main folder. These are the daily-use launchers and they do **not** keep a
Terminal window open.

---

## Daily use

| Action | Double-click | Visible fallback / Terminal |
|---|---|---|
| **Start hidden** | `MedOS.app` | `MedOS.command` or `bash mac/start.sh` |
| **Stop hidden**  | `MedOS Stop.app` | `MedOS-Stop.command` or `bash mac/stop.sh` |
| **Set up again** | `MedOS-Setup.command` | `bash mac/setup.sh` |

Starting opens a status page in your browser that auto-forwards to the app at
**http://localhost:3000** once it's ready. `MedOS.app` uses your default browser
(Safari, Chrome, etc.) and keeps the Terminal hidden. Use `MedOS.command` only
when you want to see startup output on screen for troubleshooting.

Start options (Terminal): `--no-browser`, `--backend-only`, `--frontend-only`.

### From your phone or iPad

While MedOS is running, open `http://<this-Mac-IP>:3000` on any device on the
**same Wi-Fi**. If you need the exact address, start once with `MedOS.command`
instead of `MedOS.app`; the visible launcher prints it. (You may need to allow
incoming connections the first time — macOS will prompt, or check System
Settings → Network → Firewall.)

---

## Logs & troubleshooting

- Backend: `app/backend.log` · `app/backend.err`
- Frontend: `app/frontend.log` · `app/frontend.err`
- Hidden launcher: `app/mac-launch.log`

**"cannot be opened because it is from an unidentified developer"** — right-click
the `.app` or `.command` file → **Open** → **Open**, once. (Setup also clears
this for you.)

**"command not found: python3 / node"** — run `bash mac/setup.sh`; it will offer
to install them via Homebrew.

**Port already in use / weird state** — `bash mac/stop.sh` then start again.

**Nothing loads after a code change** — `start.sh` rebuilds the frontend
automatically when it detects changed source; give it the 1–3 min it announces.

---

## What setup changes on disk

Only machine-local, rebuildable things — never your data:

- `.venv/` — a fresh macOS Python environment (any Windows `.venv` is removed)
- `app/node_modules/` — reinstalled for macOS
- `app/.next/` — rebuilt for macOS

Your `data/`, `models/`, accounts, and progress are untouched and travel with
the folder exactly as on Windows.

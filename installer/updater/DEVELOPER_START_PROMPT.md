# MedOS developer onboarding prompt

New developers: copy **only** the block between the lines below and paste it as the first
message of a new chat with me. Then tell me what feature you want.

--- BEGIN PROMPT TO SEND ---

You are helping me develop MedOS on this Windows PC. Before we start, discover the
installation and developer toolkit from disk — do not ask me to describe the project.
Then follow the rules below for the whole chat.

## 1. SETUP — do this once at the start of every new chat

1. Find the MedOS installation, in this order:
   - `HKCU\Software\MedOS\InstallDir` (and `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS`)
   - `C:\MedOS`, `D:\MedOS`, `%LOCALAPPDATA%\MedOS`
   - the Desktop shortcut `MedOS.lnk` (target / working directory)
   - a broad but bounded search for a folder containing both `setup-drive.json` and `app\backend\main.py`
   Confirm it with `release_id` in `setup-drive.json` (`medos-1.1.4` or `medos-1.1.5`).
   Report the path you chose. If more than one plausible install exists, ask me which one
   before touching anything.

2. Find the developer toolkit:
   - preferred: `<root>\installer\updater\` containing `apply_update.py`, `build_updater.py`,
     `Updater.cs`, `README.md`, `test_engine.py`
   - otherwise look beside `MedOS-Updater.exe` under `D:\MedOS-installer-dist`, or in a
     project repo folder on this PC.
   If you cannot find it, stop and tell me to copy the `installer` folder from the project
   source. Do not guess or recreate it from memory.

3. Use these exact tools (never a system Python or system 7-Zip for builds):
   - Python: `<root>\tools\python\python.exe`
   - 7-Zip: `C:\Program Files\7-Zip\7z.exe`
   - C# compiler: `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
   - WinRAR (only for archive tests): `C:\Program Files\WinRAR\Rar.exe`

4. Create these if missing, then read them and summarize what is pending and what shipped:
   - `<root>\.medos-dev\CHANGELOG.md`
   - `<root>\.medos-dev\changes\`  (staging area for changed program files)

5. Report a short setup summary: MedOS root, toolkit path, current release, pending change
   count, last shipped EXE hash. Then wait for my feature request.

## 2. RULES — for the entire chat

- Never modify, delete, or move anything under `data\`, `models\`, `exports\`, `uploads\`,
  `app\public\uploads\`, `app\.env`, `app\backend\.env`, or any `.env*` file. These are the
  user's progress, content and secrets. If a task seems to need that, stop and ask.
- Keep everything portable. No absolute paths to this PC in source, config or scripts;
  use paths relative to the MedOS root or environment/portable helpers.
- Do not bundle content into installers. Content and extras move through Content Manager.
- Do not start APK/emulator work unless I explicitly say yes in this chat.
- Before editing an unfamiliar file, read it and match its existing style and naming.
- Treat existing files as user work: use targeted edits, not wholesale rewrites.
- Tell me briefly what you changed and why after each step.

## 3. FEATURE WORKFLOW — every time I ask for a change

1. Inspect the relevant code and state the plan in 2–4 lines before editing.
2. Make the smallest correct change.
3. **Immediately after each edit**, do BOTH of these — do not wait until the end:
   - write the full new file content to `<root>\.medos-dev\changes\<relative path>`,
     preserving the MedOS-relative path (for example `app\backend\packs.py`);
   - append an entry to `<root>\.medos-dev\CHANGELOG.md` under **Pending changes** with:
     date/time, my request, files changed, a one-line description, tests run, and notes.
4. Run the relevant checks afterwards: `test_engine.py` for engine work, the installer
   regression suite for installer work, and a MedOS relaunch/health check for runtime work.
   Record the result in the changelog entry.
5. If a change deletes a file, or touches a path the patch updater cannot write (outside
   its whitelist, e.g. `tools\` or native `node_modules`), flag it immediately — patch kits
   cannot express deletions or runtime replacements. We will need a full kit or a new
   installer instead.

## 4. WHEN I SAY "ADD IT TO THE EXE"

That phrase means: package everything currently pending into a new updater EXE. Do all of
the following in order:

1. Read `<root>\.medos-dev\CHANGELOG.md` and list the pending entries back to me.
2. Validate every staged file in `<root>\.medos-dev\changes\` with the engine's
   `safe_relative()` (import from the toolkit's `apply_update.py`). If any path is rejected,
   stop and explain why — do not silently skip it.
3. Build the patch kit and EXE:

   ```
   & <root>\tools\python\python.exe <toolkit>\build_updater.py `
     patch --changed <root>\.medos-dev\changes `
     --kit-out <dist>\MedOS-UpdateKit-patch `
     --notes "<summary of pending entries>" --embed --external-kit --force
   ```

   (`<dist>` is `D:\MedOS-installer-dist` when present.)
4. Verify the result:

   ```
   & <root>\tools\python\python.exe <toolkit>\build_updater.py verify
   & <root>\tools\python\python.exe <toolkit>\test_engine.py
   ```

   and confirm the EXE size is below 1,940,000,000 bytes.
5. Report the new EXE path, byte size, SHA-256, payload SHA-256, and which changes it contains.
6. Only after the build verifies: move the Pending entries into **Shipped** in the changelog,
   stamping them with the EXE hash and time, and empty `<root>\.medos-dev\changes\`
   (leave the folder in place). Never clear staging before a verified build.
7. If I instead say "rebuild the full installer", run the full installer build and its
   regression suite, and still record the result in the changelog.

## 5. FINAL REPORT FOR EACH SESSION

End with: files changed, tests run and their result, what is still pending, and the exact
command/hash if an EXE was produced.

--- END PROMPT TO SEND ---

# MedOS 1.1.5 — update without losing progress

The cumulative **MedOS Update** kit updates an existing **1.1.4 or 1.1.5** desktop folder while preserving medical data, private `.env`, accounts, and progression. Use a complete new folder for another base release. The [complete guide](docs/MEDOS_COMPLETE_RELEASE_GUIDE_1.1.5.md) is authoritative.

## Before the update

1. Sign in to the working installation with your usual account.
2. Open **Admin → Progression Sync → Export progression** and save the JSON outside the MedOS folder.
3. Keep a private backup of important user state, personal books, and configuration.
4. **Stop MedOS completely**, including its backend/frontend services. Keep the current folder; do not erase or reset databases.

## Apply the cumulative update

1. Extract the update ZIP **into the existing complete MedOS folder**. The result must be `<MedOS folder>/MedOS Update/`.
2. Run the platform updater:

   - Windows: double-click **`MedOS Update/APPLY UPDATE - WINDOWS.cmd`**.
   - Mac: open **`MedOS Update/APPLY UPDATE - MAC.command`**. If macOS requests approval, follow Section 3 of the complete guide.
   - Linux: in a terminal at the MedOS folder, run:

     ```bash
     python3 "MedOS Update/apply_update.py" --root . --kit "MedOS Update"
     ```

3. Wait for verification and completion. The updater backs up old application files and installs the **complete `.next` build together with matching code and release metadata**. It leaves medical `data/` and private `.env` in place.
4. Start the current platform entry point: `START HERE - WINDOWS.cmd`, `MedOS.app` inside the complete folder, or `bash "START HERE - LINUX.sh"`.
5. Confirm sign-in, one recently used question, one marked question, and an UpToDate article. Keep the updater's backup until these checks pass.

If verification fails, preserve the folder and the exact message. Do not bypass checks, edit `BUILD_ID`, overwrite manifests, or combine chunks from different builds. A historical root launcher or Setup ZIP may differ from the exact 1.1.4 release archive; use the cumulative kit to restore a coherent application.

## A new complete folder

Fully extract a new full release into a separate permanent folder. Start it and sign in with the same intended username. If progress is absent, import the exported JSON through **Admin → Progression Sync** with **Replace instead of merge** off. Keep the old folder until confirmed. Do not paste the old entire `data/` tree over a newer content release.

## Preserve private and mutable state

Depending on installation age and overrides, state includes `data/users.sqlite`, the active `qbank_state.sqlite3`, `anki_progress.sqlite`, `anki_userdecks.sqlite`, user-created media/books, `data/user_content.json`, and `app/backend/.env`. Portable state may also live under the user's MedOS application-support directory. Use the active configured paths.

When backing up SQLite files manually, stop MedOS first and keep existing `-wal`/`-shm` companions with their database. Never replace an account database with an empty one to fix launch, sign-in, or sync.

## UpToDate

The recognized bundled encrypted content needs no manual `.env` edit. A custom `UTD_PASSWORD` override still wins. Optional preparation now rejects partial/corrupt output and preserves an existing cache on failure. The source has 22,376 readable articles and 30 verified empty records; those empty records cannot be recovered by redownloading the same data.

## Android

The Android candidate is **1.1.3, version code 5**. Install the matching signed APK over the existing app. Do **not** uninstall or choose **Clear storage**. If Android rejects a signature/package mismatch, stop and obtain the correctly signed APK. Re-import phone data only when the current kit says it changed. Keep the phone awake and allow enough room for ZIP plus extracted data during a large import.

## Rollback and support

Keep the updater backup and final report. If activation fails, stop the services and use the recorded backup/recovery instructions; never restore only a subset of `.next`. Share OS/version, exact failure, release identity, and sanitized diagnostics. Exclude `.env`, passwords, tokens, user databases, and patient files.

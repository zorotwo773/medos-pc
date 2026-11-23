# MedOS 1.1.5 Complete Release, Upgrade, and User Guide

**For Windows, Apple Silicon and Intel Mac, Linux, Android, and browser access from iPhone/iPad**

**Desktop candidate:** 1.1.5 · **Android candidate:** 1.1.3 (version code 5) · **Guide date:** September 15, 2026

This is the canonical guide for the 1.1.5 release candidate and its cumulative update. It preserves the complete clinical-workspace handbook from the 1.1.4 guide. Current instructions below take precedence over older readmes. Exact final artifact names, sizes, checksums, and platform validation results belong to the accompanying `release.json` and checksum sidecars; do not infer them from historical figures in Appendix A.

> **Who this guide is for:** Doctors, trainees, and other users who want clear steps first. Technical and maintainer details are collected near the end.

> **Clinical notice:** MedOS is an educational and reference workspace. It does not replace clinical judgment, institutional policy, a verified prescribing source, or consultation with an appropriate specialist. Independently verify decisions that affect patient care.

### What MedOS is and why it exists

MedOS turns an offline medical library, reference databases, question banks, study progress, calculators, and a clinical concept index into one local workspace. It is designed for doctors and trainees who want to search once, read across several installed sources, study questions, and keep their work on their own device instead of constantly moving among unrelated websites, apps, and PDFs.

Its three central purposes are:

1. **Reference:** read installed UpToDate, AMBOSS, UWorld reference material, First Aid, textbooks, drug information, diseases, anatomy, laboratory references, and calculators.
2. **Study:** build UWorld/AMBOSS-style blocks, take NBME/CMS-style examinations, use additional ABIM banks, review explanations, and preserve per-user progression.
3. **Connection:** use UMLS/RxNorm, global search, related-source links, the Concept Graph, and the reference hover layer to connect the same disease, drug, finding, code, image, table, question, and book chapter across sources.

MedOS is **local-first and offline-capable**. The desktop application is a local web application served by the computer itself; seeing `127.0.0.1` in the browser does not mean MedOS is on the public internet. Optional online lookups, AI providers, torrent retrieval, and LAN access are separate features that the user controls.

> **Content responsibility:** MedOS is software, not a grant of rights to third-party books, articles, question banks, images, or databases. Each user and distributor must have permission to possess, use, and share the content in their copy. Do not redistribute licensed or copyrighted content without authorization.

---

## Contents

1. [Start here: the safest choice](#1-start-here-the-safest-choice)
2. [Upgrade without losing Qbank progress](#2-upgrade-without-losing-qbank-progress)
3. [Install on Windows, Mac, or Linux](#3-install-on-windows-mac-or-linux)
4. [Passwords, UpToDate preparation, first launch, Wi-Fi, and daily use](#4-passwords-uptodate-preparation-first-launch-wi-fi-and-daily-use)
5. [Desktop features and Qbanks](#5-desktop-features-and-qbanks)
6. [Android phone installation and use](#6-android-phone-installation-and-use)
7. [What changed since the July 7 release](#7-what-changed-since-the-july-7-release)
8. [Troubleshooting and recovery](#8-troubleshooting-and-recovery)
9. [Privacy, backup, and important file locations](#9-privacy-backup-and-important-file-locations)
10. [Technical and maintainer appendix](#10-technical-and-maintainer-appendix)
11. [Release verification record](#11-release-verification-record)
12. [Complete troubleshooting index](#12-complete-troubleshooting-index)
13. [Optional help with ChatGPT or Codex](#13-optional-help-with-chatgpt-or-codex)
14. [Historical 1.1.4 distribution appendix](#appendix-a-historical-114-distributions)

---

## Release at a glance

Use the complete extracted MedOS folder. Windows and both Mac architectures use bundled runtimes. Linux has a maintained launcher that installs its native core dependencies on first setup. The Android APK/data kit is a separate product with its own version and checksums.

| Device | Start here |
|---|---|
| Windows 10/11 x64 | `START HERE - WINDOWS.cmd` → **Start MedOS** |
| Apple Silicon or Intel Mac | Open `MedOS.app` **inside the complete folder** |
| Linux | In a terminal in the complete folder, run `bash "START HERE - LINUX.sh"` |
| Android | Install the current signed APK over the existing app; import phone data only when required |

Windows activation creates one MedOS shortcut and no second copy of medical data. Keep the complete folder in its permanent location, including when it lives on an external SSD.

**Already have 1.1.4?** Use the cumulative **MedOS Update** kit in Section 2. It preserves medical data and private settings while replacing the complete application build. A changed `BUILD_ID` or failed hash check must be repaired with a coherent update; changing the marker or skipping verification cannot make mixed files safe to run.

The four additional desktop banks remain available: MKSAP 19 (1,870 questions), BoardVitals 2025 (1,890), AMBOSS ABIM 2025 (2,082), and UWorld ABIM March 2026 (1,249). Installed sources and platform differences are described in Sections 5 and 6.

---

## 1. Start here: the safest choice

### Before extracting

1. Make sure the download completed and matches its checksum sidecar. Use the measured compressed and expanded sizes in `release.json` to plan free space, including space for both ZIP and extracted files when kept on one disk. Historical 1.1.4 sizes do not describe the new candidate.
2. Decide where the complete folder will permanently remain before starting MedOS. Copying or extracting the whole folder is the local installation; the launcher does not make another copy of the medical library.
3. If the archive is encrypted, use the download password supplied for that exact artifact. It is separate from MedOS sign-in and from the UpToDate content key. Do not put the ZIP password in `UTD_PASSWORD`.
4. Use 7-Zip or WinRAR on Windows, or a current ZIP utility on Mac. If the operating system's built-in extractor says the password is wrong or the archive is unsupported, use one of these supported tools.
5. Extract the **entire** archive. Do not run Setup from inside the ZIP and do not extract only selected files.

Use a short, permanent path when possible:

- Windows example: `C:\MedOS-Universal`
- Mac example: `MedOS-Universal` in the user's home folder or another writable local folder
- External storage: a normal writable folder on the SSD, not the root of the disk

Avoid deeply nested folders, cloud-sync folders that may offload files, and read-only locations.

### Which installation choice should I use?

| Your situation | Choose | What happens |
|---|---|---|
| MedOS should remain on this computer after the downloaded ZIP or SSD is removed | **Copy/extract the whole folder to the computer, then run from this folder** | The permanent folder already is the complete local installation. |
| The complete ZIP has been extracted to a permanent folder on this computer and you do not want a second data copy | **Use MedOS from this folder / Start MedOS** | The complete folder is activated in place; only small user-specific setup is created. |
| MedOS is on an external SSD that will stay connected during use | **Use MedOS from this folder** | MedOS runs from that complete SSD folder. |
| The page shows **Full install — Copies 414 MB** or **Space-saving** | **This is an older setup workflow; use the current cumulative update** | 414 MB described only an old activation set. To move the installation, copy the whole folder before starting it. |

**Recommended for downloaded ZIP users:** extract once to the folder where MedOS will permanently remain, then start it in place. **Recommended for SSD users:** run it in place and keep the SSD connected.

### Rules for a portable/in-place folder

- Keep the complete extracted folder together. Do not move only `app`, `data`, or a launcher.
- Do not rename or move it while MedOS is running.
- If the complete folder is moved later on Windows, run `START HERE - WINDOWS.cmd` again from the new location. On Mac, open `MedOS.app` from the moved complete folder.
- Do not delete hidden `.medos-payload`, `.medos-setup`, or release-marker files. Setup uses them to prove that the data and runtime belong together.
- Copying the whole extracted folder to another Windows or Mac computer is supported. Use that computer's Windows entry point or Mac app once so it can select the correct runtime and create/localize its launcher state.

### System requirements

#### Desktop

- **Windows:** Windows 10 or 11, 64-bit
- **Mac:** macOS 12 Monterey or newer, Apple silicon or Intel
- **Linux:** Python 3.11–3.14 (3.12 recommended), Node.js 22 LTS version 22.13 or newer recommended (minimum runtime 20.9), and npm. Use a writable native Linux filesystem when possible.
- **Storage:** use the candidate `release.json`; allow additional room for update backups, user-added content, and an optional prepared UpToDate cache.
- **Memory:** 8 GB minimum; 16 GB recommended for smoother use with a browser, large searches, and multiple reader tabs.
- **Browser:** a current Chrome, Edge, Safari, or Firefox release. Chrome or Edge generally provides the most consistent desktop experience.
- **Internet:** intact Windows/Mac bundles support offline core startup. Linux needs network access for first setup (`requirements-core.txt`, `linux/requirements-lock.txt`, and `npm ci`); later core use is offline. Online lookups, AI, and downloads remain optional.

#### Android

- Android 9 or newer
- Check the current Android manifest for APK/data sizes. The historical 1.1.2 phone data was about 11.9 GB; that is not the new APK size.
- Allow approximately **25 GB free during import** so the phone can temporarily hold both the ZIP and the imported data. After a successful import, the ZIP in Downloads can be removed.
- Keep the phone awake and MedOS in the foreground during the large initial import.

Actual free-space needs can change with future content kits. Follow the preflight or kit manifest supplied with that release when it reports a larger requirement.

---

## 2. Upgrade without losing Qbank progress

### The safest five-minute preparation

Do this in the **old working version** before installing the update:

1. Open MedOS and sign in to the same MedOS username you normally use.
2. Open **Admin → Progression Sync**.
3. Select **Export progression** and save the downloaded `.json` file somewhere outside the old MedOS folder, such as Documents.
4. Close MedOS completely.
5. Keep the old MedOS folder unchanged until the new version opens and your progress is confirmed.

The progression export includes used and marked question identifiers across supported banks, sessions/progression information, and search history. Import is designed to merge by question ID, so importing the same file again does not duplicate answers.

> If an older MedOS folder has `EXPORT_PROGRESS.bat`, it can still be used there. That is a legacy convenience, not the primary instruction for this universal release. Use the in-app **Admin → Progression Sync** controls whenever available.

### Upgrade to the new complete desktop folder

1. Extract the new release completely to a **new permanent folder**.
2. Start the new folder using `START HERE - WINDOWS.cmd` or `MedOS.app`.
3. Sign in with the same MedOS username.
4. Check one recently answered Qbank item and one marked item.
5. If progression is absent, import the saved JSON with merge mode.
6. Keep the old folder until the new release and progression are confirmed.

Do not extract a complete universal release over a running old folder. A separate folder gives you a simple rollback and avoids partially mixing runtime revisions.

### Cumulative update without downloading the medical library again

The **MedOS Update** kit accepts an existing **1.1.4 or 1.1.5** desktop installation. Stop MedOS first. Keep a progression export and a private backup of important user state before applying any update.

1. Extract the update ZIP **into the existing complete MedOS folder**. This creates a child folder named **`MedOS Update`**. Do not extract the full desktop release over the old installation.
2. Open `MedOS Update` and run the updater for your system:

   - Windows: double-click **`APPLY UPDATE - WINDOWS.cmd`**.
   - Mac: open **`APPLY UPDATE - MAC.command`**; follow the trusted-app approval steps in Section 3 if macOS asks.
   - Linux: from the complete MedOS folder, run `python3 "MedOS Update/apply_update.py" --root . --kit "MedOS Update"`.

3. Let verification and the update finish. The updater backs up old application files and restores the complete `.next` build together with matching code and release metadata. It preserves `data/`, private `.env`, and user progression.
4. Start with the current platform entry point. Confirm sign-in, a recently used Qbank item, a marked item, and an UpToDate article.
5. Keep the update backup until those checks pass. Use the updater's recorded backup information if recovery is needed.

If verification reports a mixed `BUILD_ID`, missing chunk, or hash mismatch, preserve the installation and apply the complete trusted kit again. Do not edit `BUILD_ID`, copy selected chunks from another build, change manifests to match broken files, or disable integrity checks. An older Setup ZIP or root launcher is not equivalent to this cumulative update.

For a different base release, use a new complete folder and progression export/import. The old 1.1.4 torrents and split-pack instructions are historical; do not use their magnet as the 1.1.5 candidate. New torrent distribution requires its own newly measured identity.

### Upgrade by using a new portable/in-place folder

A newly extracted portable folder is a new release location. Progress from a separate old folder does not automatically appear there.

1. Export progression from the old version.
2. Extract and activate the new complete folder in place.
3. Open the new MedOS.
4. Go to **Admin → Progression Sync → Import progression**.
5. Leave **Replace instead of merge** unchecked for the safest normal upgrade.
6. Select the exported `.json` file and verify the reported import result.

Use **Replace instead of merge** only when you intentionally want the imported file to become the authoritative progression record.

### If you forgot to export first

Do not delete or modify the old folder. Reopen the old MedOS version and export progression. If the old app no longer starts, keep the folder and see [Progress missing after an upgrade](#progress-missing-after-an-upgrade) before attempting manual file copying.

### Important mutable desktop data

The most important recognized files include:

- `data/qbank_state.sqlite3` — Qbank used/marked state and sessions
- `anki_progress.sqlite` — Anki progress
- `anki_userdecks.sqlite` — user-created Anki deck information
- `users.sqlite` — local MedOS accounts where present
- `app/backend/.env` — optional private configuration and API keys

Never copy these files while MedOS is running. The supported progression JSON export/import is safer across database revisions than manually replacing a database.

### Updating the Android app without losing data

Do **not** uninstall the existing phone app. Install the new APK over it. Android preserves app-private data only when the package identity and signing certificate match. The supplied Android kit records both so Setup can verify release continuity.

---

## 3. Install on Windows, Mac, or Linux

### Windows 10 or 11

1. Extract the entire universal ZIP.
2. Open the extracted folder.
3. Double-click **`START HERE - WINDOWS.cmd`**.
4. If Windows displays a security prompt, confirm that the file is inside the extracted MedOS release you received from the trusted distributor.
5. Setup opens a local page in the browser. It is served only for this setup session and uses an authentication token.
6. Click **Start MedOS**. No install destination is requested and no large medical data is copied.
7. Keep the black launcher window open until the page says MedOS is ready.
8. At completion, use the new **MedOS** shortcut. The page also opens the app after checking the frontend and backend services.

Windows does not need a system Python or Node installation. Setup uses the bundled release runtimes. Administrator access should not be required for the recommended per-user destination.

### Apple Silicon or Intel Mac

1. Extract the complete release to a permanent writable location.
2. Open **`MedOS.app` inside that folder**. Keep it beside `app`, `data`, and the bundled runtimes. Use an alias or Dock item for convenience.
3. If macOS blocks a trusted, verified copy, first attempt to open it, then visit **System Settings → Privacy & Security → Open Anyway** and confirm the prompt. On macOS 15 Sequoia and later, Control-click is no longer the approval override for unsigned or unnotarized software. See [Apple's runtime-protection notice](https://developer.apple.com/news/?id=saqachfa) and [Apple's approval instructions](https://support.apple.com/102445).
4. Let the native arm64 or x64 runtime start the local services. If the browser opens an old `0.0.0.0` address, reopen from the current launcher; the local app uses `http://127.0.0.1:3000`.

Do not move just the `.app` bundle, disable Gatekeeper globally, or treat a source/structure test as a native Mac acceptance test. Native Mac testing for this candidate remains pending until reported in `release.json`.

A dialog asking you to reconnect or locate the MedOS drive is a **folder-location problem**, not a macOS security approval. Reconnect the drive and open `MedOS.app` inside the complete folder. If macOS relocates the app during security handling or the launcher reports missing files, open **`MedOS.command` from the same complete folder** as the dialog directs. Keep all medical data and bundled runtimes together.

### Linux

The maintained entry point is **`START HERE - LINUX.sh`**. Keep the complete folder on a writable native Linux filesystem where possible. Mounted Windows/exFAT locations can have different permission and symbolic-link behavior.

Use a **dedicated extracted copy for Linux**. First setup replaces the frontend dependencies with native Linux packages and may remove Windows-native dependencies. Keep a separate complete copy for Windows or Mac so their offline dependencies remain available. Updating the Linux copy preserves its medical data and progress; rerun the Linux entry point afterward to refresh dependencies when needed.

1. Install Python **3.11–3.14** (3.12 recommended), Node.js **22 LTS version 22.13+** recommended (minimum runtime 20.9), and **npm** using your distribution's supported method.
2. Open a terminal in the complete MedOS folder and run:

   ```bash
   bash "START HERE - LINUX.sh"
   ```

3. On first setup, keep the network available while the launcher creates a local Python environment, installs `requirements-core.txt` together with the verified `linux/requirements-lock.txt` versions, and runs `npm ci` for native frontend dependencies.
4. Leave the terminal open. Use the displayed local address when the services are ready. Stop MedOS with **Ctrl+C in that terminal**.
5. On later runs, the installed core can work offline. Logs are under **`.medos-linux/logs`**.

PyTorch, transformers, FAISS, and an AI provider key are not required for core reading, Qbanks, or startup. Optional AI features have separate dependencies and configuration. The candidate passed startup, health, frontend, login, and encrypted-topic HTTP checks on Ubuntu 24.04 amd64 under WSL1 with Python 3.12.3 and Node 22.11.0. This is a WSL result; physical Linux-machine acceptance remains separate. See Section 11 for the platform evidence and limits.

### What the launchers do

- Uses the appropriate Windows/Mac entry point or maintained Linux launcher.
- Validates the release marker and required component manifests.
- Uses the complete folder in its current permanent location; it does not copy the medical library.
- Selects the matching bundled runtime.
- Shows the current startup phase and local-service health on Windows.
- Creates one MedOS shortcut, launches MedOS, and checks both local services.
- Offers bounded verification/diagnostics through the published Windows setup tools; Mac troubleshooting uses the bundled launch scripts and logs.

### What Setup does not do

- It does not format, repartition, repair, or erase a disk.
- It does not intentionally overwrite user progression, private configuration, or imported content during a managed update.
- It does not install arbitrary system-wide Python, Node, Homebrew, or packages from an unapproved repository.
- It does not create a Stop shortcut.
- Intact bundled Windows/Mac startup is offline; Linux first setup installs native dependencies with network access.
- It does not make a portable folder magically independent of its data location; the whole folder must remain present and writable.

### Internet-assisted repair

MedOS is offline-first. If an approved runtime file is missing, Setup may offer a controlled repair from a release-configured trusted source when internet access is available. It should not fetch arbitrary code or decide to install global package managers. A damaged medical-data component should be restored from a verified MedOS release rather than an unknown public source.

### Torrent and older split-pack downloads

Use only the torrent/checksum identity explicitly named by the current release channel. Appendix A retains the 1.1.4 desktop and Android magnet records for identifying older downloads. A torrent is immutable: updating code requires a new torrent identity or the cumulative MedOS Update kit. A 100% torrent recheck does not prove that separately copied launchers or `.next` files belong to the same build.

---

## 4. Passwords, UpToDate preparation, first launch, Wi-Fi, and daily use

### Do not confuse the three kinds of password

| Credential | Current rule | What it controls |
|---|---|---|
| **Download ZIP password** | Use the password supplied for the exact archive | Extraction only; it is not an UpToDate key or account password |
| **MedOS account password** | Use your established account; the distributor supplies initial administrator credentials | Local sign-in and per-user progression |
| **UpToDate content key** | The recognized shipped bundle works automatically; no `.env` edit is required | Article/graphic content decryption |

An explicit `UTD_PASSWORD` is still honored for custom content and takes priority over the shipped default. A stale or incorrect explicit override can therefore cause a content-key error. Preserve private configuration and change only a confirmed wrong override after backing it up. Passwords and content keys are not interchangeable.

### Change a MedOS account password—the supported method

1. Sign in with an administrator account.
2. Open **Admin / User Management**.
3. Find the user and choose **Password**.
4. Enter a new, unique password and save it.
5. Sign out and test the new password before removing any backup or old installation.

Use at least 12 characters for real shared installations, and do not reuse the archive password. Each doctor should have a separate account because Qbank progress and activity are keyed to the normalized username. An administrator can reset another user's password without deleting that user's progress.

### Advanced account recovery when every administrator is locked out

Preserve the active account and progression databases. First verify that the intended folder is running and that a moved drive did not change `USERS_DB_PATH` or the active root. A database-unavailable error now identifies a database problem separately from an incorrect password.

If another administrator can sign in, reset the affected account through **Admin / User Management**. Otherwise stop MedOS, make a private backup of the complete SQLite file set (including existing `-wal`/`-shm` companions), and request targeted recovery using sanitized diagnostics. Do not delete, replace, or create an empty users database to repair startup or sync. Do not hand-edit password hashes. Recreating users is an intentional administrative change and is not part of this update.

### Where portable/in-place user state lives

The large library remains in the MedOS folder. A verified in-place installation also creates a small writable per-user state directory:

- Windows: `%LOCALAPPDATA%\MedOS\portable\<drive-id>\`
- macOS: `~/Library/Application Support/MedOS/portable/<drive-id>/`

Its `config` directory can contain the portable `qbank_state.sqlite3`; `logs`, `pids`, `cache`, and `locator.json` support startup and relocation. The locator records the active complete MedOS folder. Custom content-key overrides and optional API keys remain in `<MedOS folder>/app/backend/.env`, and the normal accounts database remains `<MedOS folder>/data/users.sqlite` unless an explicit environment override says otherwise. Do not assume AppData contains every MedOS database.

### UpToDate is ready without manual preparation

The shipped encrypted bundle now opens articles and graphics automatically. Its default key is used only when the encrypted dataset matches the verified shipped fingerprint. **Do not add a ZIP password to `.env`; no manual `.env` edit is needed for the bundled UpToDate content.** Custom `UTD_PASSWORD` overrides remain authoritative.

Read-only validation of the shipped source found **22,406 records: 22,376 readable articles and 30 records that decrypt successfully to empty content**. Those 30 records return a clear unavailable-topic message. They are not reported as readable articles, and redownloading the same source cannot create their missing text.

**Prepare UpToDate** remains an optional Content Manager action for creating a local article cache and supporting workflows that build indexes from it:

1. Open **Content Manager → UpToDate → Prepare UpToDate**.
2. Allow approximately 9 GB of additional free space; a forced replacement may also need space for the existing cache.
3. Keep MedOS and the source drive available until the job reports completion.
4. Check one article and graphic afterward.

Preparation validates every nonempty article, records verified empty source rows separately, and atomically replaces the cache only after successful validation. Wrong keys, malformed content, and incomplete output fail the job. A failed rebuild preserves the previous cache; an empty or corrupt old cache is not accepted merely because its filename exists. Do not delete the encrypted source.

### UpToDate password and loading errors

| Message or symptom | Response |
|---|---|
| Old package asks for `UTD_PASSWORD` | Apply the cumulative MedOS Update kit to the stopped supported installation |
| Current package reports a content-key error | Check for a custom explicit override and confirm the selected content folder; the ZIP password is separate |
| Topic has no article content | The source contains a verified empty record; choose another topic or content edition |
| Cache is empty, partial, or corrupt | Articles can use the valid encrypted source; retry optional preparation to repair the cache |
| Preparation script is missing | Apply the complete cumulative update, including matching code/build metadata |
| Every article fails | Save diagnostics and verify the content pack and active folder; preserve medical data |

Never bypass decryption or integrity validation to make a status indicator turn green.

### First launch checklist

1. Start MedOS using the single **MedOS** shortcut.
2. Allow 30–60 seconds on the first start, especially when running from slower external storage.
3. The default browser should open to `http://127.0.0.1:3000`.
4. Confirm that the dashboard appears and that search returns a result.
5. Open one Qbank and confirm a question loads.
6. If upgrading, confirm your username and progression before removing the old release.

`127.0.0.1` means this computer. MedOS's local services can work without internet access.

### Sign in and manage users

When the login gate is enabled, MedOS opens the **Sign in** page. The current built-in administrator username is `admin` and its initial fallback password is `NYC@727264`, unless the distributor set a different `MEDOS_ADMIN_PASSWORD`. Sign in and change the administrator password immediately; do not keep the shared default on a multi-user or network-accessible installation.

After the first successful sign-in:

1. Open **Admin / User Management**.
2. Change the initial administrator password.
3. Create a separate everyday account for each user rather than sharing the administrator account.
4. Give administrator rights only to someone who needs to manage users or progression imports.

The Admin page can create users, rename their display names, change passwords, grant or remove administrator rights, and delete users. Qbank progress is keyed to the MedOS username, so two doctors using separate accounts on one computer keep separate used/marked questions and statistics.

Passwords are stored as salted PBKDF2-SHA256 hashes, not plain text. Normal sessions use signed, HttpOnly cookies and are remembered for a limited period. If the documented fallback does not work, the distributor may have overridden it; do not delete the user database as the first recovery step because that can remove locally managed accounts.

### Moving around the workspace

MedOS behaves like a local clinical web workspace:

- **Global search:** press `/` from most screens. If text is selected, the selected term can be used as the starting query.
- **Command Center:** press `g`, release it, then press `k`, or select the Command Center button. On desktop it opens as a docked extension of the left sidebar, and the active page reflows beside it instead of being covered.
- **Settings:** press `g s`.
- **Help:** press `?` for the built-in quick guide and shortcut list.
- **Reader tabs:** articles, books, questions, and reference views can remain open in MedOS tabs. Use `Ctrl+PageUp` and `Ctrl+PageDown` to cycle tabs.
- **Qbank keyboard use:** number keys `1–8` or letters `A–H` choose an answer where applicable; left/right arrows move between questions.

The most useful `g` shortcuts are:

| Keys | Opens |
|---|---|
| `g d` | Dashboard |
| `g q` | Qbank |
| `g u` | UpToDate |
| `g a` | AMBOSS |
| `g w` | UWorld reference library |
| `g i` | Medical Library |
| `g o` | Content Manager |
| `g t` | Media Tray (when it contains collected items) |
| `g y` | Lexi |
| `g n` | Anki |
| `g m` | Create an Anki card from the current selection |
| `g c` | Clinical calculators |
| `g l` | Quick laboratory ranges |
| `g b` | LOINC laboratory panels |
| `g x` | UMLS concept lookup |
| `g j` | UpToDate Differential Diagnosis; legacy `g x d` remains accepted |
| `g f` | Differential builder |
| `g g` | Concept Graph |
| `g v` | Sanford Guide |
| `g h` | Chat/Tutor |

The ten favorite calculator slots can be opened with `Ctrl+Alt+1` through `Ctrl+Alt+0`. The defaults include commonly used tools such as eGFR, Cockcroft-Gault, anion gap, A–a gradient, CHA₂DS₂-VASc, Wells PE, CURB-65, MELD, GCS, and BMI; they can be reassigned from the Calculators page.

### Dashboard, recent activity, and resuming work

The dashboard is both a search launchpad and a return point. It can show recent articles, topics, PDFs, questions, and searches. **Resume** returns to the last supported item and its saved position; a resumable active examination receives priority. Optional auto-jump can return to the last location once per app start.

Recent activity is associated with the signed-in MedOS account where supported, so clearing ordinary browser cache should not be treated as the main way to reset or recover progression.

### The reference hover layer

The reference layer connects the otherwise separate databases. While reading supported articles, explanations, book material, or other clinical content, recognized terms are underlined. Hover with a mouse or tap on a touch device to open a compact reference card.

Depending on the concept and installed data, a card may show:

- abbreviation expansion and preferred clinical name
- a concise definition and source
- UMLS concept identifier and semantic group
- synonyms
- ICD-10-CM and other linked terminology codes where available
- related concepts and other MedOS sources discussing the term
- a direct jump to a drug monograph, AMBOSS/UpToDate article, First Aid section, UMLS page, image, or Qbank exhibit

Underlines are source- and concept-aware. Common source colors include AMBOSS blue, UpToDate green, Qbank/UWorld amber, Clinic Consult orange, Drug Reference gray, First Aid red, and UMLS teal. Once a concept is resolved, semantic styling can also help distinguish diseases, findings, drugs, procedures/anatomy, laboratory concepts, and genes. Color is a navigation aid, not a clinical severity indicator.

The Command Center provides three reference modes:

- **Off:** no underlines or hover cards.
- **Lite:** uses terms already identified in the content and is the best choice for a slower computer.
- **Full:** includes Lite behavior and scans for additional recognized terms; this is the broadest coverage.

Some cards offer **Clinical** and **Lay** wording. Lay mode may use a cached or online MedlinePlus consumer-health summary when available. Tap outside the card or press `Esc` to close it.

### Articles, PDFs, images, tables, and video

- UpToDate and AMBOSS topics open as local reader pages with supported headings, concept links, and related-source navigation.
- Books open in the built-in PDF viewer with page navigation, zoom, and in-document search. Indexed books can open near the relevant chapter.
- MedOS uses a common media viewer for supported figures, Qbank exhibits/tables, images, audio, and video. It supports close, zoom for images, fullscreen, minimize, and a resizable window where appropriate.
- Press `Esc` to close the current pop-up, drawer, media view, or modal when that surface supports dismissal.

### Use the complete desktop app from another device's browser

This is different from installing the Android app. A phone, iPad, tablet, or second laptop can open the **full desktop MedOS interface** through a browser while the main computer is running MedOS:

1. Put both devices on the same trusted Wi-Fi.
2. Enable MedOS network access in **Settings** on the desktop.
3. Open the LAN address shown by MedOS, such as `http://192.168.1.42:3000`, on the other device.
4. Sign in with the desired MedOS account.

Because the browser is using the original desktop installation, it sees the same accounts and progression directly; there is no separate browser copy to synchronize. The host computer must remain awake and MedOS must keep running.

### iPhone and iPad: what is and is not possible

An iPhone or iPad can use the complete desktop interface in Safari over trusted Wi-Fi, as described above. It cannot run the Windows `.bat`/`.exe` runtime or the macOS `MedOS.app` directly from a plugged-in SSD, and Safari cannot turn a folder on an attached drive into the MedOS backend. The SSD may be readable as storage, but iPadOS still needs an iPad application or a running computer to execute the server.

The practical no-App-Store option is therefore:

1. Connect the SSD to a Windows PC or Mac.
2. Start MedOS on that computer.
3. Enable private LAN access.
4. Open the displayed LAN URL in Safari on the iPad.

A future native iPad shell would require an Apple-compatible build, signing, entitlements, and distribution through an allowed Apple channel. A free browser/PWA shell can display a server that is already running elsewhere, but it cannot bypass iPadOS execution and filesystem restrictions to run the present desktop backend from USB. App Store publication requires an Apple Developer account and compliance with Apple's current review, privacy, licensing, and medical-app rules; content rights remain the distributor's responsibility.

### Daily start and stop

- **Start:** double-click the MedOS shortcut.
- **Normal close:** close the browser tab when finished. The launcher manages the normal local startup flow.
- **Troubleshooting stop:** use the stop command only if services remain stuck. Ordinary users do not need a Stop desktop shortcut.
- **Portable use:** connect or make available the complete MedOS folder before starting.

### Access from a phone or tablet on the same Wi-Fi

The desktop can expose MedOS to trusted devices on the same local network.

1. Connect both devices to the same trusted Wi-Fi network.
2. Open MedOS desktop **Settings** and enable the relevant Wi-Fi/LAN access or sync control.
3. If Windows asks whether to allow network access, choose the trusted/private network only.
4. Use the LAN address shown by MedOS, for example `http://192.168.x.x:3000`, on the other device.

Keep LAN access off on public, hospital-guest, hotel, or other untrusted networks unless you understand the exposure. A VPN, guest-network isolation, or a firewall can prevent devices from seeing each other even when the Wi-Fi name looks the same.

### Qbank progression sync on the same Wi-Fi

In **Settings → LAN Sync**, MedOS can automatically merge Qbank progression among the user's MedOS devices on the same trusted Wi-Fi. The settings panel shows this device and discovered peers and allows sync to be paused. Manual **Admin → Progression Sync** export remains the recommended backup before an upgrade.

### Content Manager and torrent retrieval

Desktop **Content Manager** can verify content rooms, import a content folder, and retrieve approved MedOS content through the release's self-contained torrent. It supports selective rooms, progress, pause/resume, recheck, and optional seeding. If the in-app torrent runtime is unavailable, the same `.torrent` or magnet can be opened in a compatible BitTorrent client using the exact MedOS save location shown by the app.

**Prepare UpToDate** starts a background, one-time local conversion of `data/uptodate/utdasset.sqlite` into the faster `utdasset_decrypted.sqlite` article cache (roughly 7.8 GB). It uses CPU and disk but no internet. Keep MedOS running and the source drive connected until the log says **DONE**. The job writes a `.tmp` database first and atomically replaces the final cache only after completion, so the encrypted source remains intact if the job is interrupted.

Torrent status does not replace file verification. After a download or relocation, use Content Manager/Setup verification so MedOS confirms the actual expected files.

---

## 5. Desktop features and Qbanks

### Main workspace

| Area | What it is for |
|---|---|
| **Dashboard and global search** | Search across installed medical sources and jump directly to a question, article, drug, book, or concept. |
| **Qbank** | Build tutor or timed question blocks, review explanations, mark items, and track progression. |
| **NBME/CMS simulator** | Full-screen, multi-block exam workflow with breaks, answers hidden until completion, resumable exam state, and end-of-exam reporting. |
| **UpToDate and AMBOSS** | Read locally available clinical articles and follow concept links. |
| **Library** | Open the included PDF/textbook collection and use supported search/navigation tools. |
| **Diseases** | Browse structured clinical reference material. |
| **Drugs** | Drug reference, RxNorm-linked information, and dosing material. Always verify patient-specific prescribing independently. |
| **UMLS** | Look up concepts, CUIs, synonyms, and linked coding information such as ICD-10 where available. |
| **Anatomy** | Browse anatomy reference material. |
| **Calculators** | Use clinical calculators with visible inputs and results. Confirm inputs and applicability before clinical use. |
| **Labs & LOINC** | Review lab and panel reference information with LOINC links where included. |
| **Differential** | Organize a differential diagnosis; it is a thinking aid, not an autonomous diagnosis. |
| **Concept Graph** | Explore relationships among medical concepts and sources. |
| **Anki** | Review spaced-repetition cards and supported user decks. |
| **Reference hover layer** | View explanations for recognized medical terms throughout supported pages. |
| **Chat/Tutor** | Optional AI-assisted study. It remains off until a user supplies supported API configuration and should not receive identifiable patient information. |

### How the sources work together

MedOS is more than a folder of unrelated references. A UMLS-based concept layer normalizes abbreviations, synonyms, drugs, diseases, findings, procedures, and codes. The practical workflow is:

1. Search once across installed sources.
2. Open the most appropriate source result.
3. Hover or tap a recognized term for a quick definition.
4. Follow the same concept to another article, drug entry, book chapter, question, First Aid section, code, or related-concept graph without retyping it.

For example, “MI,” “myocardial infarction,” and “heart attack” can resolve to the same underlying concept. Drug names are additionally normalized through RxNorm. The exact codes and links shown depend on the locally installed content and should be checked against an authoritative current source when used clinically.

### Global search

Press `/`, enter a clinical term, drug, syndrome, abbreviation, calculator, or question concept, and review the grouped sources. Results can include UpToDate, AMBOSS, books/chapters, First Aid, UWorld reference material, Qbanks, drugs, calculators, diseases, and UMLS concepts. A result opens in its native MedOS reader rather than being treated as a definitive answer from the snippet alone.

Search keeps source diversity so a very large database does not bury every other category. Book results use clinical-reference ranking: Harrison's is a strong general internal-medicine source, while a subspecialty standard such as Brenner & Rector may rank first for a clearly renal query. A user can mark a book as a priority reference with its star control.

The full Search Results page resolves the entered phrase to a clinical concept without waiting for a UMLS result card to appear in the loaded window. It then uses the same cross-library media collector as Concept Graph to show related images and tables inside the main results column. Image/table filter counts include these linked resources, and **Show all** expands beyond the first 24 cards. Known abbreviations use the preferred clinical expansion, so `PE` enriches pulmonary embolism rather than an unrelated UMLS abbreviation match.

### Library and adding books

The Library organizes the offline PDF collection by specialty. Supported books have searchable outlines or chapter indexes, and First Aid has specialized snippet/heading support. Books placed into the managed library through the app's supported workflow are indexed in the background so they can appear in Library and global search. Keep user-added books within the active managed library rather than dropping them into arbitrary release-manifest directories.

On the phone, most large PDF books are intentionally optional. Use **More → Manage Storage → Find desktop** to download selected books from a running desktop over trusted Wi-Fi.

### Reference modules in more detail

- **UpToDate:** local topic reader with related-source links and supported graphics. No UpToDate web login is required to read the installed offline material.
- **AMBOSS:** local article reader connected to related concepts and parallel sources. Current
  builds render in-article references as visible keyboard-accessible links and use the bundled
  full-resolution clinical figure with its stored title/description in reader and print output.
- **UWorld reference library:** explanatory articles and media separate from the UWorld Qbank itself.
- **Drug Reference and Lexi:** generic/brand lookup, drug classes, indications, dosing/frequency material, warnings, structured sections, and RxNorm-linked naming where available. Always verify dose, route, renal/hepatic adjustment, interaction, pregnancy, and institutional policy independently.
- **Diseases / Clinic Consult:** concise clinical overviews, codes, and available algorithms/flowcharts.
- **Anatomy:** layered anatomical reference with definitions and supported 3D/orthopedic material.
- **Calculators:** searchable clinical calculators with favorite slots and visible inputs/results. Check the calculator's intended population, units, exclusions, and date/version.
- **Labs and LOINC:** quick normal-range reference plus standardized panel/code browsing. Laboratory reference ranges vary by laboratory, assay, age, sex, pregnancy, and unit system.
- **Anki:** local card review plus quick creation from selected text. Anki progression and user-deck data should be backed up separately from Qbank progression.
- **UMLS:** preferred concept name, CUI, semantic group, definitions, codes, and relationships where present.
- **Differential and Concept Graph:** tools for organizing possibilities and exploring relationships. They do not diagnose a patient.
- **Sanford Guide / Clinical pathways / ACLS-related tools:** use the installed views for reference and workflow support, but follow current licensed guidance, local policy, and real-time resuscitation leadership.

### Qbank workflow

1. Open **Qbank**.
2. Select a bank and subject/category.
3. Choose tutor or timed behavior where offered.
4. Select the number of questions and unused/marked/incorrect filters.
5. Start the block, answer, and review.
6. Use the dashboard and progression views to monitor completion.

For NBME/CMS forms, use the simulator's own block and break controls. Do not rely on a browser refresh as an exam-control action. The current exam workflow records resumable state so an unintended close is less likely to lose the entire attempt.

### Tutor, Timed, and exam behavior

- **Tutor:** reveals the answer and explanation during the block and is best for deliberate study.
- **Timed:** keeps explanations hidden until review and runs the selected timer.
- **NBME/CMS exam:** uses multi-block exam behavior with breaks, an exam-focused interface, laboratory values/notes where supported, and continuously saved resumable state.

The builder can filter unused, marked, or broader question pools, choose systems/subjects, and set ordering or focus where supported by the selected bank. Available options differ among UWorld-style banks, the additional ABIM banks, and fixed-form NBME/CMS assessments.

### Qbank review and analytics

MedOS stores used and marked IDs, session/block records, answers, and supported timing/statistics per username. Review views can include recent test performance, right/wrong/omitted counts, system or subject breakdowns, average time, and progression over multiple sessions.

For eligible NBME forms, the report can display an estimated three-digit score, likely range, percentile/distribution context, and a per-block breakdown. Conversions are form-specific estimates rather than official NBME/USMLE results. A form without a defensible conversion should show percent correct rather than inventing a three-digit score. Step 3 self-assessments and CMS forms may therefore use percentage reporting.

Questions and their media are served through the matching bank. Images can open in the common viewer; supported exhibit/table links are reformatted for readability. If a stem loads but an image or exhibit does not, verify the bank rather than copying media from another bank directory.

### Additional Qbanks carried forward from desktop 1.1.4

The following were added to the export and validated before packaging:

- **MKSAP 19:** 1,870 valid questions
- **BoardVitals 2025:** 1,890 valid questions
- **AMBOSS ABIM 2025:** 2,082 valid questions
- **UWorld ABIM March 2026:** 1,249 valid questions

Their database integrity checks passed, and all four are part of the completed desktop search index. If one is absent from the Qbank picker after installation, run **Verify/Repair**; do not manually rename its data directory.

### Search and reading tips

- Start with a specific clinical term, drug, syndrome, or concept.
- Use source filters when the result list is broad.
- Open the source result to see its native context rather than relying only on a search snippet.
- On Android, suggestions and installed-source search are optimized for fast on-device use; the exact desktop and phone result mix can differ because their installed content differs.

### Detailed desktop feature handbook

#### Dashboard, history, and reader tabs

The dashboard is the return point for the workspace. It shows quick entry points, recent reading, recent searches, Qbank activity, and a **Resume** action. MedOS saves supported article, PDF, question, and examination locations so returning to the app does not require finding the item again. A resumable active examination has priority over ordinary recent reading.

The top reader tabs behave like an internal browser. Articles, books, reference pages, media, and the current Qbank session can stay open together. `Ctrl+T` creates a new tab, `Ctrl+W` closes the current tab, and `Ctrl+PageUp`/`Ctrl+PageDown` cycles tabs. The Qbank uses one stable resumable tab: opening another source does not intentionally destroy the active block, and selecting that Qbank tab returns to the unfinished session.

#### Search, suggestions, filters, and related media

The `/` shortcut opens global search from supported screens. Suggestions are shared across the home search, sidebar/Command Center search, full Search page, and Concept Graph rather than existing only on the dashboard. Database-specific search boxes remain source-specific so, for example, an UpToDate search suggests UpToDate titles instead of unrelated books.

The full results page loads a bounded first window and can progressively load more. Filters show sources and result types such as articles, books/PDFs, questions, images, and tables. Text results appear before the related image/table collection so the answer list is not pushed below a large media grid. Related media uses the same concept-linked collector as Concept Graph and resolves both full assets and thumbnails; an absent thumbnail must not be treated as proof that the full local image is absent.

Autocomplete is a navigation aid, not a diagnosis or spelling authority. Review the source title and context before relying on a result.

#### Qbank builder, block continuity, and review

The builder remembers the last selected bank and Step. If the user was working in UWorld Step 2, reopening the builder returns to that selection until the user changes it. Available controls depend on the bank but can include:

- Tutor or Timed mode
- number of questions and allotted time
- unused, marked, incorrect, or all-question pools
- systems, subsystems, subjects, or fixed assessment blocks
- search focus and ordering such as random, hardest, newest, or QID
- Prep/Practice tracking preference

In Tutor mode, feedback appears after an answer and **Previous**, **Next**, and **Save & Exit** remain below the complete explanation instead of floating over its text. In Timed mode, answers/explanations remain hidden until review. Number keys `1–8` or letters `A–H` can choose an answer when the screen is not focused on a text field; arrow keys navigate where enabled.

NBME/CMS forms use their own simulator. Depending on the form, the user can choose native blocks or shorter practice blocks. The simulator supports fullscreen testing, a running block timer, break screens, laboratory values, scratch notes, hidden grading until completion, continuously saved state, per-block reporting, and a final review. A three-digit estimate is shown only when a form-specific conversion is available and remains an unofficial estimate.

Progress records used/answered and marked question IDs, block/session state, answers, timing, and supported analytics per username. Review can show accuracy and average time by system or subject, recent score trends, right/wrong/omitted totals, and NBME progression.

#### UpToDate reader

The installed UpToDate reader provides local title search, topic outlines, collapsible headings, related-source navigation, in-article find, graphics, tables, and a print/PDF view. Article text comes from a validated prepared cache when available, otherwise from per-article decryption. The recognized bundled dataset works without manual configuration. A custom explicit `UTD_PASSWORD` remains authoritative; a wrong override can affect encrypted articles or graphics even when thumbnails or an older prepared article cache still display.

Use **Print / Save PDF** for a clean article export. The print view expands supported local content and uses locally stored figures and tables. It does not fetch missing web content.

#### AMBOSS reader

AMBOSS articles open as clean local HTML with an outline, cross-source references, clinical figures, and the global reference layer. Current builds make in-article references visible, clickable, and keyboard accessible. A clinical figure uses the full local image rather than an embedded thumbnail and carries its stored title/description so it is not displayed without context.

The print/PDF view uses the full local asset, readable caption, and article context. It excludes generic hover/glossary dumps and includes linked visual/table content only when a meaningful originating label exists.

#### UWorld reference library

The UWorld reference library is separate from the Qbank. It contains explanatory articles, images, and tables that can be opened directly, reached from search, or followed from linked concepts. Its article, table, and media actions use the same reader/media system as the other desktop databases.

#### Library and book archive

The Library groups PDF books by specialty, recognizes indexed chapters, and can jump from global search to a relevant chapter or page. Library search matches both book titles and chapter titles. Nonmatching shelves and empty category sections are hidden during filtering so a user searching “Harrison” does not have to scroll past blank sections. Priority stars can raise a preferred book in clinical-reference ranking.

Use the supported **Add book** workflow for personal PDFs. MedOS records the book, updates the chapter index when possible, and refreshes global search in the background. Do not place a personal PDF inside a manifest-owned release directory that repair may later restore.

The PDF viewer supports page navigation, zoom, document search, deterministic indexed-page jumps, open separately, and browser printing. If a chapter link opens the wrong page, record the book title, requested chapter, expected page, and actual page before rebuilding an index.

#### Universal media viewer and Media Tray

Database images and tables—including AMBOSS, UpToDate, UWorld, Qbank exhibits, Concept Graph results, and supported disease/pathway material—open in the common viewer. Depending on the media type and browser, actions include:

- zoom, pan, rotate/reset, fullscreen, minimize, and resize
- Copy, Save, Share, Open separately, Print/PDF, and Add to Tray
- source label, title/caption, and relevant attribution/context
- rich-table copy, tab-separated text, or CSV where supported

When an image is zoomed enough to pan, panning takes priority over drag-to-another-app. Return to fitted view before dragging. Browser security can block direct clipboard/image sharing; **Open separately** is the reliable fallback.

**Add to Tray** is temporary. It stores up to 12 collected items in the current browser session (bounded to roughly 2 MB of serialized content); it does not copy the source into the MedOS folder or database. Reorder, save, share, or print the collection before clearing/reloading the session.

#### Reference hover layer and UMLS

Recognized terms are marked from glossary abbreviations, the reference index, UMLS, RxNorm, source links, and Qbank visual indexes. A reference card can show the preferred term, abbreviation expansion, definition/source, semantic group, CUI, synonyms, ICD-10-CM or other installed codes, related concepts, and links into other MedOS sources.

The **Off / Lite / Full** selector controls cost. Lite uses terms already marked in the content and is best on slower hardware; Full also scans the rendered page for more matches. Clinical/Lay wording can switch between clinician-facing and patient-friendly definitions where available. MedlinePlus consumer summaries require internet when not already cached.

UMLS concept pages and the Concept Graph expose relationships, but a relationship is not proof of causation, diagnosis, contraindication, or treatment. Use the linked source and current clinical guidance.

#### Drugs, Lexi, diseases, anatomy, pathways, and ACLS

Drug search accepts generic and supported brand names and can show class, indications, dosing/frequency material, warnings, interactions, and RxNorm normalization. Verify dose, route, indication, age/weight, kidney/liver function, pregnancy/lactation, interactions, formulation, and local policy before clinical use.

Diseases/Clinic Consult provides concise overviews and installed algorithms. Anatomy provides definitions and supported image/3D/orthopedic material. Sanford, pathways, and ACLS views support reference and workflow but never replace current guidelines, a code leader, or institutional protocol.

#### Calculators, Labs, and LOINC

Calculators are searchable and expose their inputs and results. Ten favorites can be assigned to `Ctrl+Alt+1` through `Ctrl+Alt+0`. Confirm units, population, exclusions, equation version, and clinical interpretation. Laboratory ranges vary by laboratory, assay, age, sex, pregnancy, and units; MedOS ranges are quick references. LOINC panels provide standardized coding/navigation, not a local laboratory's validated reference interval.

#### Anki

MedOS can review the installed Anki collection and media and create a card from selected text with `g m`. Qbank progression export does not replace a backup of `anki_progress.sqlite`, `anki_userdecks.sqlite`, and user-created media. The public torrent ships `collection.media.7z` instead of tens of thousands of loose media files; first start can extract it locally. Content Manager uses a completion identity to avoid repeatedly walking roughly 74,000 files, so a small old display such as 113.5 MB can be a reporting defect rather than missing cards.

#### Content Manager

Content Manager is the operational view for installed rooms. It can run bounded health probes, show green/yellow/red status, import supported content, prepare UpToDate, expose the embedded torrent, select rooms for download, pause/resume/recheck, and seed after download. A green result means the functional probe passed; a filename merely existing is not enough.

The **Prepare UpToDate** job and torrent jobs run in the backend after the button is pressed. Closing only the Content Manager page does not necessarily stop the backend task, but stopping MedOS or disconnecting its source can interrupt it. Read the displayed task state before starting another copy or duplicate job.

#### Optional AI Chat/Tutor

AI features are disabled until a user deliberately supplies a supported provider key in `app/backend/.env`, such as `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` where that provider is supported by the installed build. Restart MedOS after changing `.env`.

AI requires internet, may send the entered prompt and attached context to the chosen provider, and can be wrong. Never submit patient-identifiable information or rely on it as the sole basis for diagnosis, treatment, prescribing, or emergency care.

---

## 6. Android phone installation and use

### Two ways to use MedOS on a phone or tablet

| | Browser access to desktop | Native Android app |
|---|---|---|
| **What it is** | The phone browser opens the complete MedOS running on the computer | A separately installed offline Android application |
| **Needs the computer running?** | Yes | No after data import |
| **Internet required?** | No; both devices need the same local network | No for installed content |
| **Device support** | Any modern phone/tablet browser, including iPhone/iPad | Android 9 or newer |
| **Feature set** | The full desktop application | A phone-focused subset with native readers, search, Qbank, calculators, ACLS tools, and storage management |
| **Progress location** | The desktop account's data directly | Phone-local data that can reconcile supported Qbank progression with desktop over Wi-Fi |

Use browser access at home when you want the entire workstation on a smaller screen. Use the Android app when the phone must work independently away from the computer.

### Requirements

- Android 9 or newer
- Enough free storage for the APK and selected phone data
- The phone unlocked and awake during copy/import
- Permission for the chosen file app to install an APK when Android asks

### Ordinary installation or update

1. In the extracted desktop release, open **`ANDROID - COPY TO PHONE`**.
2. Open **`START HERE - ANDROID.html`** for the kit-specific summary.
3. Copy the supplied APK and phone-data ZIP to the phone's **Downloads** folder using USB file transfer or another trusted copy method.
4. Tap the APK.
5. If Android asks, allow this file app to install unknown apps, then confirm installation.
6. **Do not uninstall an existing MedOS first.** Installing over the existing signed app preserves its private data.
7. Open MedOS on the phone.
8. Choose **Import data (.zip)** and select the supplied phone-data ZIP.
9. Keep MedOS open and the phone awake until import confirms completion.
10. Retain the copied files until the app works. They can then be removed from Downloads to recover space.

Use the current Android artifact manifest for the signed APK and data identity. The historical 1.1.2 torrent record is retained in Appendix A and is not the candidate APK.

### What is native on the phone

The Android 1.1.3 candidate retains a native offline experience for installed search, clinical readers, drug material, calculators, and ACLS-related tools. Recent updates improved search speed and ranking, typo-aware suggestions, article outlines, reading navigation, source switching, calculator output, drug-reader safety, and handling of ACLS timers/voice actions.

The app's main destinations include Home, Search, Clinical, Calculators, Qbank, and a More area for additional installed modules and storage management. Search is grouped by source so a large source does not hide smaller ones. Depending on the imported data, results can include First Aid, AMBOSS, UWorld reference material, UpToDate, drugs, Qbanks, diseases, calculators, and books.

The native Qbank supports installed UWorld/AMBOSS-style banks with Tutor/Timed behavior, recent-block resume, used-question tracking, and phone-local flags. The inspected reusable phone-data ZIP contains UWorld Steps 1–3, AMBOSS Steps 1–3, AMBOSS ABIM 2025, and UWorld ABIM March 2026. MKSAP 19, BoardVitals, and the complete NBME/CMS desktop simulator are not established as phone-kit contents by that inventory.

### Inspected desktop and phone content

This comparison comes from the desktop manifests/top-level metadata and the reusable phone-data ZIP's central directory inspected on September 15, 2026. Presence establishes packaged content, not a successful native-device read of every item. The old APK manifest alongside that ZIP was 1.1.2/code 4; the candidate APK is 1.1.3/code 5 and has its own identity.

| Content | Desktop | Inspected phone-data ZIP |
|---|---|---|
| UpToDate | Encrypted source and local search/reader support; optional prepared cache | Encrypted asset database, title index, and table of contents |
| AMBOSS clinical library | Installed clinical library | Clinical database and bundled assets |
| UWorld reference library | Installed reference packs | Step 1 reference database and assets |
| UWorld/AMBOSS Qbanks | Step banks plus additional installed banks | Steps 1–3 for both providers, plus AMBOSS ABIM and UWorld ABIM |
| Other desktop banks | MKSAP 19, BoardVitals, NBME/CMS, and other installed packs | These are not listed in the inspected phone database inventory |
| Drugs, calculators, diseases, concepts | Installed desktop databases and indexes | Drug reference, Lexi calculator, Cliniccons disease, glossary, UMLS-lite and concept/search indexes |
| PDF books | Large desktop library | First Aid for USMLE Step 1 2026 and Harrison's 22nd edition |
| ACLS material | Desktop ACLS content | ACLS and BLS provider manuals plus ACLS assets |
| Anki and other large desktop rooms | Available when installed on desktop | Not established as phone-kit contents by this inventory |

Additional books can be requested from a running desktop through **Manage Storage**. Use the actual current phone-data manifest before promising a source that is not listed here.

### Phone-to-desktop progression sync

Use the same intended MedOS account on both devices. Start the desktop, enable trusted LAN access, and connect both devices to the same private Wi-Fi. Allow the configured MedOS service through the firewall on the private-network profile, then use the current desktop address and the correct shared sync token.

The current repair distinguishes connection/timeout, authorization/token, server/database, and malformed-response failures. A rejected request or unreadable database is not a successful empty export. If sync reports an account or database problem, preserve both devices' progress and correct that specific problem before retrying. Do not uninstall the Android app, clear storage, or reset the desktop database to force sync.

Export progression before a major change. Retry once after correcting the reported issue, then compare one used and one marked question. The source regression tests cover these failure paths; physical cross-device acceptance must be recorded separately.

### Manage Storage on Android

Open **More → Manage Storage** to view installed content and available space. From there, supported content groups can be offloaded to recover storage. Content removed from the phone does not delete the desktop copy.

To obtain selected books from desktop:

1. Start MedOS on the desktop and enable trusted LAN access.
2. Put the phone and computer on the same Wi-Fi.
3. On the phone, open **Manage Storage → Find desktop**.
4. Select an available book and keep both devices awake while it downloads.

Most desktop PDF books are not included in the standard phone bundle. The current phone kit includes a focused selection, including First Aid and Harrison's material, and lets the user add only the books needed on the phone. A search result for a non-downloaded book can therefore appear as unavailable until the book is downloaded or data is re-imported.

### Desktop and phone are related, but not identical

| Desktop 1.1.5 candidate | Android 1.1.3 candidate |
|---|---|
| Full offline workspace with the large desktop data library and all four additional Qbanks | Smaller on-device package focused on installed phone content and native workflows |
| Setup chooses Windows, Mac arm64, or Mac x64 runtime | Android installs an APK and separately imports its data ZIP |
| Can run locally, from an extracted portable folder, or with SSD-hosted data | Data lives in Android app-managed storage after import |
| Desktop global search and Content Manager/torrent workflows | Fast native installed-source search; no requirement to run the desktop frontend |
| One desktop/app shortcut | Standard Android launcher icon |

Do not expect every large desktop book, Qbank, model, or administrative tool to be duplicated in the phone app. The two releases share the MedOS purpose and content pipeline but have device-appropriate interfaces and storage.

### Updating phone data

Installing a newer APK updates the application. Importing a newer data package updates available offline content. Keep these as separate steps, and do not erase working app data before the replacement has been verified.

---

## 7. What changed since the July 7 release

### 1.1.5 reliability update

- Windows startup and in-place repair carry forward the latest launcher fixes. The current command is not the earlier source of the trailing-quote WinError 123 report.
- Mixed frontend builds are refused. The cumulative updater restores the whole `.next` build, matching source/runtime files, and release metadata together.
- Bundled UpToDate works without manual key configuration; preparation validates output and preserves a previous cache on failure.
- LAN sync reports typed failures and does not interpret errors as empty progression.
- Linux has a maintained core launcher; optional AI/ML dependencies do not gate core startup.
- Android candidate version 1.1.3/code 5 contains the targeted sync repairs. Its new APK identity must come from the current manifest.

The feature improvements below are preserved historical changes between the July 6 baseline and desktop 1.1.4/Android 1.1.2. They describe the retained handbook features, not newly repeated physical-device tests or new 1.1.5 artifact identities.

### For ordinary users

#### One universal, portable-capable desktop release

- One release folder now carries Windows, Apple-silicon Mac, and Intel Mac runtimes.
- The launcher detects the real host system and chooses the correct native runtime.
- A fully extracted ZIP can be activated in place without duplicating the large medical data.
- Windows creates one normal MedOS shortcut and opens the app at completion.
- A complete folder can be moved or copied to another computer and activated again from its new location.
- The misleading 414 MB **Full install** path is now documented as a bounded activation set, not a full medical-data copy; it is not the relocation path for this package.

#### Safer and clearer installation

- Visible current task, bytes, speed, ETA, and activity messages.
- Destination and free-space checks occur before copying.
- Copy operations are resumable and validate partial data before continuing.
- Managed updates preserve recognized progression, settings, and private configuration.
- New runtime files are staged before activation, with rollback after a failed health check.
- Setup can verify, repair, and produce privacy-filtered diagnostics.
- Export preparation blocks a release when required apps, runtimes, Qbanks, or pack data are incomplete.

#### Mac fixes

- Added separate bundled Apple-silicon and Intel runtimes instead of depending on one Intel-only package.
- Physical architecture detection now handles Rosetta correctly.
- Mac launch is bound to a complete matching runtime.
- The Setup app and generated MedOS launcher are packaged with native executable metadata.
- The earlier diagnostics crash that treated progress data as the wrong object type was corrected, so saving diagnostics no longer fails with `dict ... total_bytes`.

#### Portable and shortcut fixes

- Portable activation now uses the same verified extracted directory and does not create a second medical-data copy.
- Interrupted preparation and verified copied work can resume.
- Relocated but matching verified drive data is accepted.
- Startup/reopen handling was hardened.
- The normal desktop result is one MedOS shortcut; no Stop shortcut is created.

#### Networking and content fixes

- Wi-Fi/LAN access and Qbank progression sync were consolidated into current app controls.
- Local URL handling was made more reliable after sleep, Wi-Fi reconnect, VPN changes, or adapter changes.
- Torrent content retrieval now uses the self-contained MedOS torrent, supports selection/recheck/pause/resume, and validates mapped pack paths.
- The historical 1.1.4 desktop torrent was client-compatible; its old identity and validation notes are retained in Appendix A.
- A separate verified Android kit torrent was created so the APK and phone data can be downloaded or seeded independently of the desktop payload.
- Content completeness and release identity are checked before export.
- AMBOSS question stems and images now use the unified desktop media resolver, including media stored outside the simplest legacy bank layout.
- Android shared/encrypted media resolution was repaired so imported question and article images can load from the phone's supported storage layouts.

#### Search, reader, media, and touch improvements

- Global search uses bounded pagination, stable candidate selection, a progressive full-results page, and guarded retries instead of runaway request loops.
- Full Search Results now resolves the query concept independently and embeds Concept Graph's cross-library image/table aggregation in the main result flow. Media counts populate the Images/Tables filters even when the first text-result window contains no UMLS card.
- Search suggestions now use a shared autocomplete model on the home page, sidebar/Command Center, Search page, and Concept Graph; source-specific readers retain suggestions from their own content.
- Library search now matches books and chapter titles while hiding empty nonmatching shelves instead of leaving blank sections above the relevant book.
- PDF index/deep links land on the requested page more reliably; article and PDF print/export behavior was unified.
- AMBOSS print selects the bundled full-resolution figure rather than the 84×84 embedded preview,
  adds the stored clinical caption, and omits the former generic glossary-popup dump. Visual/table
  linked content is retained only with a readable originating label.
- AMBOSS article references are visually identifiable, clickable, and keyboard accessible.
- Images and tables support consistent expand, copy, save, share, drag, print/PDF, and citation-aware actions where available.
- Database-reader images and tables now open through the same universal media viewer used for Qbank media, including copy, save, print/PDF, share, open-separately, and tray actions where supported.
- Touch/tablet readers gained the contextual Command Halo and a temporary **Media Tray** for collecting up to 12 images, tables, or excerpts for reorder, share, or print/PDF.
- **Add to Tray** stores content only in the current browser session; it does not copy an image into the MedOS folder or database. Save, share, or print it before closing/reloading if a permanent copy is needed.
- Command Center is docked into reserved left-sidebar space on desktop, preventing it from covering the active article or Qbank. Its general shortcut parser now supports two- and three-key sequences, keeps legacy `g x d`, and adds `g i` (Library), `g o` (Content Manager), and `g t` (Media Tray).

#### Qbank additions

- MKSAP 19 and BoardVitals 2025 were added.
- AMBOSS ABIM 2025 (2,082 questions) was added.
- UWorld ABIM March 2026 (1,249 questions) was added.
- All four additional Qbanks are included in desktop global search.
- Progression export/import supports carrying question state across refreshed databases and releases by question ID.
- The main tab bar keeps one resumable active-Qbank tab, and the builder remembers the exact last
  bank/Step. Tutor navigation now follows the full explanation instead of overlaying its text.

#### Anki portable-size reporting

- Space-limited portable copies may retain the verified extracted `collection.media` directory
  while omitting the redundant `collection.media.7z` archive.
- Content Manager reads the launcher's completion identity to report that media without walking
  74,000+ loose files. A former ~113.5 MB display could therefore be a counting error, not missing
  media; the current bounded result is consistent across the maintained D:, F:, and G: copies.

#### Android improvements

- Faster first search and cached installed-search state.
- Broader, ranked cross-source clinical search with typo-aware suggestions and preserved term casing.
- Better article semantics, outlines, source headings, and reading navigation.
- Improved First Aid and drug-reader search/navigation behavior.
- More complete calculator results and safer formula/input validation.
- Hardened ACLS timers, state recovery, voice grammar, notifications, and bedside control behavior.
- Android package/update verification and a guided copy/import kit.

### Known boundaries, stated plainly

- The Mac app is not notarized; use the approval instructions in Section 3. Native Mac candidate testing remains pending.
- USB/extracted folders cannot safely autorun on modern Windows or macOS; the user must open the Windows entry point or Mac app once.
- In-place mode depends on the complete source folder staying available. To install locally, move the whole folder to the computer first.
- Phone and desktop content are not identical.
- Online repair is bounded to approved release resources; a complete release should install offline.
- Private `.env` remains user-owned. The current recognized UpToDate bundle does not require users to supply its content key.
- An old torrent/root/Setup ZIP can carry an older code revision. Use the cumulative updater for the supported base instead of mixing individual files.
- BitTorrent magnets are immutable. Application changes can be delivered as a small core update, but they cannot be inserted into an already published magnet without producing a new infohash.

### Previous-guide instructions intentionally not carried forward

The prior guide also described older distribution variants. They are not the ordinary path for this published universal ZIP:

- Direct `START.bat`, `ALLOW_LAN.bat`, `EXPORT_PROGRESS.bat`, `STOP.bat`, and modular-pack commands are legacy/developer conveniences and are not guaranteed as top-level universal-package entry points. Use the current Windows/Mac entry point, Settings, Admin → Progression Sync, and bounded diagnostics first.
- Old pre-created `u1/u2/u3` account lists are not a release contract. Fresh installs seed/manage accounts according to current configuration; use the documented fallback only when it has not been overridden, then change it immediately.
- The unpacked Chrome/Edge reference-sidebar extension exists in the development source but its unpacked source folder is not part of the verified 1.1.4 public release allowlist, so this guide does not tell ordinary users to load it.
- Earlier phone instructions said Android 7 and roughly 12 GB free. The verified current application requires Android 9 or newer, and the ~11.91 GB data ZIP needs about 25 GB of temporary free space during import.
- Older instructions to delete account databases, overwrite application folders manually, or extract individual packs into a running installation are recovery/developer operations, not normal upgrade steps.

---

## 8. Troubleshooting and recovery

Start with the visible symptom below. Avoid deleting folders, reinstalling system Python/Node, or manually moving databases as a first response.

### Setup appears stuck at 99%

The final percentage can include verification, permission normalization, shortcut creation, and health checks after the large copy has finished. On a slow SSD or antivirus-scanned local disk, this can take longer than earlier percentages.

1. Read the current task and activity log; do not judge only by the percentage.
2. Keep the computer awake and the source connected.
3. If bytes, filename, or log text is still changing, allow it to finish.
4. If the source was disconnected or Setup closed, reconnect it and reopen the same Setup entry point. Resume validates existing partial bytes before continuing.
5. If Setup reports a health or verification failure, use its **Repair** or **Save diagnostics** action instead of starting a second copy into another folder.

### Setup says “file does not exist”

- Confirm the universal ZIP was completely extracted.
- Make sure hidden release folders were not omitted by a selective copy.
- Do not run Setup while browsing inside the ZIP.
- Do not paste an old Terminal command containing wildcard paths from a different installation.
- Reopen the Setup app from this release and let it locate the release marker itself.
- If one payload file is genuinely missing, use a fresh verified extraction or the bounded online repair offered by Setup.

### Windows reports `[WinError 123]` or shows a path ending in a quote

That historical error involved an invalid path ending in a literal quotation mark. The current Windows command has the corrected path handling. A screenshot of the older error does not prove that the current command or the medical data is defective.

1. Stop the failed instance and confirm which complete MedOS folder and launcher actually ran.
2. Apply the complete current **MedOS Update** kit for base 1.1.4/1.1.5, then start `START HERE - WINDOWS.cmd` inside that folder.
3. If a checksum or `BUILD_ID` mismatch appears, stop and restore a coherent build with the updater. Do not bypass the check, edit the marker, or copy isolated `.next` chunks.
4. If the exact current build still reports WinError 123, save the full error and sanitized diagnostics, including the platform and folder location.

An older root folder, Setup ZIP, and exact original 1.1.4 archive can contain different application bytes. Keep their identities separate when reporting or repairing a failure.

### The diagnostics ZIP is not on the Desktop

Current Setup saves diagnostics by default inside the selected managed installation at:

`<MedOS installation>/.medos-install/diagnostics.zip`

It may use another explicit location if you chose one. The previous Mac command that assumed a matching `/Applications/*/.medos-install/install-state.json` could stop before diagnostics were created, and an older renderer could crash with `AttributeError: 'dict' object has no attribute 'total_bytes'`. Current Setup uses typed progress and the managed target directly.

Use **Save diagnostics** in the current Setup page, wait for the success message, and open the exact displayed path.

### macOS blocks MedOS.app or says it cannot verify the developer

Follow the trusted-app approval steps in Section 3, then open `MedOS.app` inside the complete extracted folder. Keep security enabled. If macOS reports damage or malware rather than an unidentified developer, preserve the exact message and verify the trusted artifact before proceeding.

### The shortcut opens nothing

1. Wait 30–60 seconds, then browse to `http://127.0.0.1:3000`.
2. Confirm the portable/extracted folder still exists at the same path.
3. If it was moved, run `START HERE - WINDOWS.cmd` again from the complete folder, or open `MedOS.app` there on Mac.
4. On Windows, rerun the entry point to recreate the shortcut. On Mac, use the bundled launcher/log troubleshooting steps.
5. Check the backend and frontend log paths listed in the technical appendix.

### The shortcut works but has the wrong icon

The icon does not change MedOS data or functionality. On Windows, rerun `START HERE - WINDOWS.cmd` to recreate the shortcut. On Mac, remove an obsolete alias only after confirming that `MedOS.app` inside the complete folder opens correctly. Keep just one user-facing MedOS shortcut/alias.

### MedOS opens, but a page says the backend is unavailable

1. Wait briefly; the frontend can appear before the backend completes its first start.
2. Refresh once after 30 seconds.
3. Avoid starting MedOS repeatedly; multiple launches can compete for the same local ports.
4. Rerun the current launcher from the complete folder and review its health/log output.
5. Save diagnostics if either local endpoint still fails.

If Setup says `no bounded repair is defined for issue: backend-unreachable`, the Setup UI itself cannot infer whether the problem is a stale port, wrong root, missing runtime, antivirus block, or backend exception. This is not a request to redownload all content. Check `app/backend.err` first, then apply only a trusted core/launcher hotfix if the log identifies a code/runtime problem.

### Mac installation completes but articles/questions or backend data do not load

This is separate from an installation that never completes.

1. Open `MedOS.app` or the Mac launcher **inside the complete release folder**. A copied app bundle by itself cannot find the databases.
2. Confirm the external SSD or extracted folder is still mounted and writable.
3. If the folder moved, open the launcher from its new location so managed root/locator values are refreshed.
4. For UpToDate only, apply the current content repair and check Content Manager; the recognized bundled content does not need manual `.env` configuration.
5. Test an AMBOSS article and a Qbank. If every source fails, inspect Mac/backend logs; if only one source fails, inspect that content room in Content Manager.
6. Do not install a random system Python/Node. The release contains arm64 and x64 Mac runtimes and selects the physical architecture, including Apple-silicon Macs running a translated process.

### Sign-in fails or returns to the login page

1. Confirm the username and password; usernames are normalized and passwords are case-sensitive. For an unmodified release, the fallback administrator credentials are `admin` / `NYC@727264`; a distributor may override them.
2. Make sure only one MedOS installation is running. A browser pointed at one frontend while another backend is using the local port can cause session confusion.
3. Close the MedOS browser tabs, stop the stuck instance through Setup/launcher recovery, then start the intended release once.
4. If another administrator can sign in, use **Admin / User Management** to reset the affected user's password.
5. Do not delete `users.sqlite` unless you explicitly intend to discard local account records and have backed it up.

If login works but progression appears empty, first check that the same username is being used. Qbank progress is separated by user.

### The portable folder was moved or renamed

On Windows, run `START HERE - WINDOWS.cmd` again from the moved complete folder and click **Start MedOS** so the shortcut points to the new location. On Mac, open `MedOS.app` from the moved complete folder. Never keep using an old shortcut that points to a disconnected drive.

### Not enough disk space

- Use the measured expanded size in `release.json`, with additional room for updates, backups, and optional cache preparation.
- When retaining the ZIP on the same disk, budget for both the measured archive and expanded sizes from `release.json`.
- To save internal space, run the complete folder from an external SSD and keep it connected.
- Do not use the 414 MB Full/Space-saving option to move the library; move the whole folder.

### Progress missing after an upgrade

1. Stop and keep the old installation unchanged.
2. Confirm that the same MedOS username is selected; progression can be user-specific.
3. In the new version, open **Admin → Progression Sync** and import the saved JSON with merge mode.
4. If no JSON was exported, start the old version and export it now.
5. For a managed in-place update, save diagnostics and preserve both old and new folders before manual recovery.

Technical recovery may copy recognized SQLite state only while both versions are stopped and only after backups are made. Very old browser-only releases may have progression in browser local storage; preserve the original browser profile and installation for specialist recovery.

### A Qbank is missing or shows no questions

1. Confirm the release was completely extracted.
2. Open Content Manager and inspect the affected content room.
3. Run Setup verification/repair.
4. Do not rename Qbank data folders or edit `packs-map.json` manually.
5. If the database exists but the app still reports zero questions, save diagnostics and identify the bank name.

### A Qbank question or AMBOSS article shows a broken image

1. Record the bank/article name and QID or article title.
2. Open the same media through its image/table control. If the full viewer works but the inline thumbnail does not, this is a resolver/thumbnail issue rather than absent data.
3. Confirm the database and its supplied media folder kept their original relative locations.
4. Apply the current app/core hotfix that includes the unified media resolver. Do not copy an image from another bank into the broken bank.
5. If the current build still fails, save diagnostics and report the exact local media URL shown by the viewer where possible.

AMBOSS article figures should display the stored clinical title/description and use the full local asset in print/PDF. Unexplained image grids, tiny thumbnails in PDFs, or non-clickable related-article terms indicate an older reader/core and can be corrected with an app-only update.

### Search or Concept Graph shows a missing UpToDate thumbnail

Open the item. If the full image loads, the underlying media exists and only the thumbnail mapping failed. Use the current app/core revision, which shares the Concept Graph media resolver with Search Results and retrieves the proper UpToDate thumbnail/full asset. If neither works, verify the UpToDate content key and content room.

### Anki reports about 113.5 MB instead of the expected collection size

Do not immediately recopy or re-hash tens of thousands of files. The old count could see only the database/archive while overlooking the already extracted `collection.media` directory. Current Content Manager uses the launcher's verified extraction identity and reports the bounded media completion without walking roughly 74,000 loose files. Reopen after applying the current core hotfix and use **Re-verify** only if cards or media actually fail.

### Wi-Fi/LAN access does not work

1. Confirm both devices are on the same trusted network and guest isolation is off.
2. Enable the current LAN/Wi-Fi control in MedOS Settings.
3. On Windows, allow MedOS on **Private** networks when prompted.
4. Temporarily disconnect a VPN to test; VPN/virtual adapters can change the selected LAN address.
5. Use the current address shown by MedOS rather than an address saved from a previous day.
6. Keep local-only use at `127.0.0.1:3000`; use the displayed `192.168...` or similar address only from another device.

### Torrent content is paused, incomplete, or not detected

1. Open Content Manager and review the selected rooms and current mode.
2. Select **Resume** or **Recheck**.
3. Keep the exact save path shown by MedOS; a wrong parent folder can create a nested duplicate that the app will not use.
4. If in-app libtorrent is unavailable, open the provided torrent in a compatible client and use the instructed save location.
5. After completion, run verification. A client's “100%” means its torrent pieces match, not necessarily that MedOS is configured to the correct folder.

### Android refuses to install the APK

- Permit the specific file app to install unknown apps when Android asks.
- Do not uninstall the existing MedOS as a troubleshooting shortcut.
- If Android reports an incompatible signature, stop: obtain the proper update from the same trusted distribution chain.
- Confirm Android 9 or newer and sufficient storage.

### Android data import fails

1. Keep the original data ZIP; do not extract it manually into app storage.
2. Confirm free space and keep the phone awake.
3. Reopen MedOS and select **Import data (.zip)** again.
4. Choose the exact supplied phone-data ZIP, not the universal desktop ZIP.
5. If an error names a damaged or unsafe archive entry, recopy the verified phone-data ZIP.

### What to send when asking for technical help

- Operating system and version
- Windows / Mac Apple silicon / Mac Intel / Android model
- Whether the complete folder is on an internal disk or external SSD
- The exact visible error text or a clear photo
- The Setup phase and last activity-log line
- Whether the source is a downloaded folder or external SSD
- The privacy-filtered diagnostics ZIP, if Setup successfully created it

Do not send `.env`, raw databases, passwords, API keys, or patient-identifiable information.

---

## 9. Privacy, backup, and important file locations

### Privacy model

MedOS is designed to work locally. Core search, reading, and installed content do not require uploading the medical library. Optional AI features can contact the configured AI provider, and torrent/content retrieval contacts network peers or configured sources. Review those features before enabling them.

- Do not enter identifiable patient information into optional AI chat.
- Use LAN features only on a trusted network.
- Treat API keys and `.env` files as secrets.
- A checksum proves file integrity, not by itself who published the file. Obtain the archive and checksum through a trusted channel.

### Offline core and optional online lookups

The installed library, Qbanks, local search, readers, calculators, and concept databases work offline. Some optional panels can enrich a page when internet access is present:

- drug pages may query the public FDA label API
- UMLS/disease views may query ClinicalTrials.gov for current studies
- glossary/reference Lay mode may query MedlinePlus

These lookups use the drug, disease, code, or concept being viewed and cache supported results locally. They are not required for the offline workspace and should not be used with patient-identifiable free text. Optional AI Chat/Tutor is a separate online function and remains unavailable until the user deliberately configures a supported provider and API key.

### Recommended backup routine

Before every upgrade or large content change:

1. Export progression from **Admin → Progression Sync**.
2. Save it outside the MedOS folder and, ideally, on a second device.
3. Close MedOS.
4. For important Anki/user configuration, back up the recognized mutable files or the managed mutable-data backup offered by Setup.
5. Keep the prior working release until the new version and progress are confirmed.

### Important desktop locations

Paths below are relative to the active MedOS installation unless stated otherwise.

| Purpose | Location |
|---|---|
| Qbank progression/session database | `data/qbank_state.sqlite3` |
| Anki progression | `anki_progress.sqlite` |
| User Anki data | `anki_userdecks.sqlite` |
| Local users, where present | `users.sqlite` |
| Optional private backend settings | `app/backend/.env` |
| Backend log | `app/backend.log` and `app/backend.err` |
| Frontend log | `app/frontend.log` and `app/frontend.err` |
| Setup/install metadata | `.medos-install/` |
| Default diagnostic bundle | `.medos-install/diagnostics.zip` |

Some state may be placed in a small per-user location by portable activation. Use Setup's displayed active target rather than assuming that every writable file remains beside the large read-only payload.

### Do not include these in a support upload

- `.env` files
- Full Qbank/account/progression databases
- API keys, tokens, passwords, or authorization headers
- Browser profiles
- Patient data

The Setup diagnostics bundle is designed to include bounded log tails and system/release classifications while excluding database contents and redacting common secrets and home-folder names. Review any file before sending it.

---

## 10. Technical and maintainer appendix

### Current desktop architecture

MedOS desktop uses a prebuilt Next.js frontend and a FastAPI backend. Normal local endpoints are:

- Frontend: `http://127.0.0.1:3000`
- Backend: local service used by the frontend (normally port 8002)

Windows and Mac use the bundled runtimes. Linux installs native core dependencies locally on first setup. Runtime selection is host-specific:

- Windows bundled runtime
- macOS arm64 bundled runtime for Apple silicon
- macOS x64 bundled runtime for Intel
- Linux native Python environment and npm dependencies, started by `START HERE - LINUX.sh`

Setup checks the physical architecture on macOS so Rosetta does not incorrectly force an Intel application runtime on an Apple-silicon computer.

### Release layout concepts

- `.medos-payload/desktop-external` — published desktop application/data payload
- `.medos-payload/mac-tools/{arm64,x64}` — published Mac runtime payloads
- `.medos-setup/manifests` — component inventories and hashes
- `.medos-setup/preparation-report.json` — preparation outcome and release metadata
- `setup-drive.json` plus checksum — release/drive identity
- `setup_center/` — verified Setup implementation
- `START HERE - WINDOWS.cmd` — Windows guided entry
- `MedOS.app` — Mac entry point that selects the bundled arm64 or x64 runtime
- `ANDROID - COPY TO PHONE/` — Android APK/data transfer kit

Portable activation depends on matching release identity and a complete verified payload. It is not equivalent to launching random source files from an arbitrary directory.

### Update preservation model

Files are classified as either manifest-owned immutable runtime/content or mutable user-owned state. A managed update stages immutable files, preserves recognized mutable paths, activates the new runtime, and performs health checks. Repair restores only bounded manifest-owned files and known executable permissions; it must not replace a mutable manifest path.

### Diagnostics contract

Diagnostics include release/install identity, health classifications, endpoint results, host runtime information, and bounded log tails. They exclude database and environment-file contents and redact passwords, tokens, API keys, authorization values, and user-home names.

The earlier Mac failure shown as:

`AttributeError: 'dict' object has no attribute 'total_bytes'`

was a CLI progress-rendering type error, not evidence that the user's medical database was damaged. Current diagnostics emit a typed progress event and have a regression test covering the terminal renderer.

### Advanced configuration: safely editing `app/backend/.env`

`.env` is the private, plain-text configuration file loaded when MedOS starts. The public torrent intentionally excludes it; the launcher creates a local file. Stop MedOS before editing it, save it as UTF-8/plain text, use one `NAME=value` assignment per line, and restart afterward. Do not add spaces around the first `=` unless the value truly begins or ends with a space.

Common values include:

| Key | Purpose |
|---|---|
| `UTD_PASSWORD` | Optional explicit custom-content override; unnecessary for the recognized shipped bundle |
| `MEDOS_ADMIN_PASSWORD` | Initial password used only when seeding an empty users database |
| `MEDOS_SESSION_SECRET` | Random signing secret for login sessions; should be unique per installation |
| `USERS_DB_PATH` | Optional explicit accounts-database location |
| `MEDOS_ROOT` | Active complete MedOS root when data/runtime location must be explicit |
| `QBANK_STATE_DB` | Optional Qbank progression database override; portable activation may point it into per-user state |
| `LIBRARY_PATH`, `UTD_DB_PATH`, `AMBOSS_DIR` | Optional content-path overrides |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY` | Optional external AI credentials supported by the installed build |
| `MEDOS_SYNC_TOKEN` | Optional shared token for trusted-LAN progression sync |

Never include `.env` in a public torrent, Git commit, diagnostics upload, screenshot, or support message. Before replacing it during an update, keep a private local backup. If the release folder moves, prefer rerunning the official launcher so it rewrites managed location values instead of manually changing every path.

### Maintainer-only UpToDate content-key rotation

The value `hs;d,hghdk[;ak` is coupled to the encrypted rows in the shipped UpToDate source database. It is not an authentication password. Editing `.env` to a new value does not “secure” existing data; it simply causes AES/PBKDF2 decryption and full-resolution graphics to fail.

A real rotation requires a new content build:

1. Confirm that redistribution and transformation of the source content are authorized.
2. Preserve an offline backup of the current encrypted source and record its release identity.
3. Decrypt every protected `topic_asset`, `graphic_asset`, and `other_asset` row with the old key, preserving the exact row ID used as the salt and the expected compression/encoding.
4. Re-encrypt every protected payload consistently with the new key. A partial rotation produces a database that appears healthy but fails unpredictably by topic or image.
5. Rebuild `utdasset_decrypted.sqlite` from the newly encrypted source; never ship a stale cache from the old generation as proof of a successful rotation.
6. Update the desktop configuration/bootstrap strategy and the Android content-key implementation together. The current Android source uses its own built-in matching value, so changing desktop alone breaks cross-platform parity.
7. Rebuild the signed APK, desktop core, content manifests, preparation report, checksum sidecars, and all affected verification fixtures.
8. Validate database integrity, decrypt every row or a release-approved exhaustive set, open representative topics/tables/graphics on Windows and both Mac architectures, and test Android import/reading.
9. Rebuild any torrent containing changed bytes. The new payload necessarily has a new infohash and magnet.

Relevant implementation locations for maintainers are `app/backend/utd_content.py`, `app/backend/utd_crypto.py`, `app/backend/utd_reader.py`, `app/backend/scripts/utd_decrypt_assets.py`, the launch/setup environment writers, and Android's `UtdCrypto.kt`. Do not publish a plaintext decrypted cache merely to avoid managing the key; it adds roughly 8.2 GB and changes the content-exposure model.

### Password rotation summary

- **Archive password:** repack the archive and publish a new checksum. Existing archives keep their old password.
- **MedOS user password:** change it in Admin/User Management; no data rebuild is required.
- **Initial admin password:** changing `MEDOS_ADMIN_PASSWORD` affects only a newly created empty users database, not an existing administrator row.
- **Session secret:** changing `MEDOS_SESSION_SECRET` signs everyone out but does not change account passwords or progression.
- **UpToDate content key:** requires a coordinated content rebuild as described above; ordinary users must not rotate it.
- **AI/API keys:** replace them with the provider, update `.env`, revoke the old key, and restart MedOS. Never store them in Git.

### Traceable post-July-7 change sources

The July baseline used for this guide is commit `9b30b8e` dated July 6, 2026. Important later milestones include:

| Commit | Change |
|---|---|
| `c0d659e`–`e6a2d30` | Safe manifests, destinations, resumable preparation, repair/diagnostics, guided Windows/Mac/Android setup, verified drive preparation |
| `0b4f2b4` | Keep verified Setup runtime immutable |
| `b8414ee` | Detect physical Mac architecture |
| `3e7ced6` | Bind Mac launch to a complete runtime |
| `73bffa5` | Show actionable Setup diagnostics |
| `8827f6a` | Resume launch and create one MedOS shortcut |
| `42434fa` | Activate MedOS in place |
| `5e1fe56` | Consolidate networking, torrent, and Qbank updates |
| `f6d2b8f` | Block incomplete exports |
| `7f119c8` | Consolidate latest desktop application |
| `7f51698` | Index completed Qbanks in global search |
| `ce9cb17` | Resume interrupted drive preparation |
| `d57c618` | Accept verified relocated drive data |
| `814e376`–`bbc997a` | Android 1.1.x clinical readers, search, calculators, ACLS hardening, and release verification |
| `315d118` and preceding release commits | Final in-place Windows/Mac launchers, universal archive hardening, Android media hotfix, and extracted-portable documentation |
| `8f18141`–`54c107f` | Latest clinical-workspace hardening: UpToDate previews, global autocomplete, book/chapter search, docked Command Center, and unified database media viewers |
| `40b3802` | Beginner Git/GitHub collaboration and recovery guide |
| `1126d7b` | Client-compatible public MedOS torrent publication |

Primary human-readable sources consolidated here include `README.md`, `MedOS_USER_GUIDE.md`, `UPGRADE.md`, `DISTRIBUTION.md`, `docs/SSD_SETUP_CENTER.md`, Android release/readme material, architecture notes, release plans/specifications, and Git history.

### Maintainer cautions

- Do not reintroduce top-level legacy-script instructions unless those files are actually published in the universal allowlist.
- Keep desktop version and Android version separate in release communication.
- Do not claim a physical-device pass based only on unit tests or archive inspection.
- Do not put archive passwords in the same public location as the encrypted archive.
- Preserve the exact release marker and manifest/checksum sidecars when relocating a portable payload.
- Optimize release preparation to avoid redundant whole-tree hashing of the 200,000+ file payload; repeated hashing can make a correct release appear stalled for hours.

---

## 11. Release verification record

### Candidate identity and limits

Desktop candidate **1.1.5** and Android candidate **1.1.3/code 5** are separate artifacts. Consult the delivered `release.json`, APK manifest, checksum sidecars, and final test report for measured sizes/hashes and acceptance status. No new full ZIP size, SHA-256, or torrent infohash is asserted in this guide before the artifact is built and measured.

### Evidence recorded during this repair

- Read-only validation of the exact shipped UpToDate source: **22,406 records**, including **22,376 valid article bodies** and **30 verified empty records**; no invalid nonempty record was found.
- Temporary real-content fixtures opened encrypted articles/graphics with blank `UTD_PASSWORD`, built a validated cache, and rendered the same article HTML from the prepared cache.
- Regression checks cover wrong keys, failed/partial preparation, preserved caches, typed sync failures, and core health during simulated optional ML import failures.

| Platform | Observed result | Scope and limits |
|---|---|---|
| Windows, bundled Python 3.12.7 and Node 22.11.0 | **PASS:** startup, health, frontend, login, encrypted-topic, and print requests returned HTTP 200 | Core local workflow with the bundled runtime; optional AI is separate. |
| Ubuntu 24.04 amd64 under WSL1, Python 3.12.3 and Node 22.11.0 | **PASS:** startup, health, frontend, login, and encrypted-topic requests returned HTTP 200 | Tested under WSL1. This does not establish a physical Linux-machine pass. New installations should use the recommended Node 22.13+ runtime. |
| Android 1.1.3, version code 5 | **PASS:** 563 JVM tests and 4 emulator tests | Physical-device Wi-Fi sync acceptance remains pending. |
| Apple Silicon and Intel Mac | Native hardware acceptance **pending** | Source, package, and launcher checks do not replace opening the candidate on Mac hardware. |

Consult the accompanying release record for any later acceptance results. Physical cross-device Wi-Fi sync and native Mac behavior are not claimed from unit or emulator tests.

### What the historical figures mean

The exact existing archive is `MedOS-universal-desktop-20260902-2254-40b3802d.zip`, identified as 1.1.4. Its inspected metadata describes **210,890 files** and **52,852,045,035 uncompressed bytes**. Older guide inventories described a different 1.1.4 artifact; old root/Setup copies also differ. None of those figures are a size or hash for 1.1.5. The extracted folder's later `packs-map.json` is not asserted to be byte-identical to the archive's original metadata.

---

## 12. Complete troubleshooting index

Use this as a symptom-first index. The detailed explanations earlier in the guide remain authoritative.

### Installation and startup

| Symptom | Most likely cause | First safe action |
|---|---|---|
| Archive will not open | Wrong password syntax or unsupported extractor | Use a supported extractor and the password supplied for that exact artifact. |
| Windows “Extract All” rejects the archive | Built-in extractor limitation | Use a current 7-Zip or WinRAR release. |
| Setup cannot find a file | Partial/selective extraction or running inside archive preview | Extract the entire release to a normal folder. |
| `[WinError 123]` | Invalid destination string, often a trailing `"` | Use a short real folder path and the current launcher/core hotfix; keep existing data. |
| Setup appears at 99% | Final permissions, shortcut, or health work | Read the changing activity/log; do not start a duplicate job. |
| “Verified copied work is preserved” | Copy succeeded but health/activation failed | Correct the reported issue and resume; do not erase the target. |
| `backend-unreachable` with no bounded repair | Startup/port/root/runtime exception needs a log | Check `app/backend.err`, ensure one instance, then apply only a core fix if required. |
| Browser opens but never redirects | Services still starting or a backend/frontend error | Wait 30 seconds, refresh once, and inspect both `.err` logs. |
| Port 3000/8002 is busy | Another MedOS instance is running | Stop the old instance or reboot, then start the intended folder once. |
| Shortcut opens old/disconnected drive | Folder moved or drive letter changed | Rerun the entry point from the current complete folder to recreate it. |
| Shortcut icon is wrong | OS icon/alias cache or obsolete shortcut | Recreate the one MedOS shortcut; functionality is unaffected. |
| Mac says unidentified developer | App is not notarized | Follow Section 3 and the System Settings approval flow for the trusted complete bundle. |
| Mac app opens but no data loads | App moved away from folder or stale root/locator | Put/open the launcher in the complete folder and refresh managed location state. |
| Mac launcher is not executable after torrent | Torrent/filesystem did not preserve Unix mode | Apply the trusted small Mac launcher overlay; do not redownload medical data. |

### Accounts, progress, and configuration

| Symptom | Most likely cause | First safe action |
|---|---|---|
| Login says incorrect password | Wrong/case-sensitive password, wrong running folder, or wrong users DB | Confirm one instance and use Admin to reset the user. |
| All known users disappeared | Backend opened a different/new `users.sqlite` after relocation | Stop MedOS, preserve both databases, inspect `USERS_DB_PATH`/root, and restore the correct path. |
| Every admin is locked out | No supported administrator can reset accounts | Preserve the active database; use an existing administrator or targeted backed-up recovery. |
| Progress looks empty after upgrade | Different username or new progression DB | Use the same username and import the saved progression JSON in merge mode. |
| Portable progress is missing | Portable drive identity/location changed or another state root is active | Inspect the locator and `%LOCALAPPDATA%`/Application Support portable state before copying anything. |
| AI Chat unavailable | No supported provider key | Add the user's own authorized API key to `.env`, restart, and avoid patient identifiers. |
| Changing `.env` had no effect | Backend was not restarted or file became `.env.txt` | Confirm the exact filename/plain-text line and restart MedOS. |

### UpToDate and clinical content

| Symptom | Most likely cause | First safe action |
|---|---|---|
| UpToDate asks for a password | Old code or custom-content override | Apply the cumulative update; the recognized bundle works automatically. |
| Content-key error | Wrong custom override or a different dataset | Verify the intended content key and folder; never use the ZIP password. |
| Prepare script missing | Older incomplete application payload | Apply the complete cumulative update. |
| Prepare was interrupted | Computer slept, app stopped, or drive disconnected | Keep source, reconnect, and retry; the encrypted DB is intact. |
| UpToDate text works but graphics fail | Wrong custom override or damaged/missing graphic source | Check the selected bundle and override; preserve the cache and source. |
| Qbank appears but no questions load | Incomplete database/media, wrong map, or old core | Verify the named bank and apply the current core; do not rename folders. |
| AMBOSS question image is broken | Old bank-specific media resolver | Use the unified-media core hotfix and report QID if still broken. |
| AMBOSS article shows contextless images | Older reader rendered linked assets as a gallery | Update the core; current reader keeps the image with its source text/caption. |
| Article PDF contains thumbnails | Older print view used embedded previews | Apply the current core and regenerate PDF from **Print / Save PDF**. |
| Related AMBOSS terms are plain text | Older link conversion | Update the core; current links are visible, clickable, and keyboard accessible. |
| Search has no related images | Old Search page did not call Concept Graph collector | Update the core and use full Search Results. |
| Search/Graph card has broken thumbnail but full image opens | Thumbnail resolver mismatch | Use the current core; do not recopy the full database. |
| Library filter leaves blank shelves | Old title-only filtering layout | Update the core; current title/chapter search hides empty sections. |
| PDF chapter opens wrong page | Stale index or old asynchronous navigation | Record expected/actual page, then update/reindex through supported tools. |
| Anki shows only ~113.5 MB | Old reporter ignored extracted media | Apply current core and use bounded re-verification only if media fails. |

### Networking and torrents

| Symptom | Most likely cause | First safe action |
|---|---|---|
| Phone/iPad cannot open desktop MedOS | LAN disabled, firewall, VPN, or guest isolation | Enable trusted LAN, use the current displayed IP, and test on private Wi-Fi. |
| LAN address changed | DHCP, sleep, VPN, or adapter change | Use the address currently shown by MedOS. |
| Torrent creates `MedOS\MedOS` | Save path was set to `...\MedOS` with subfolder enabled | Move/repoint safely so Save in is the parent of `MedOS`. |
| Torrent says files missing although data exists | Wrong parent or old torrent metadata | Use the current infohash and Force Re-check at the correct parent. |
| Torrent warns about disk space while seeding existing data | Client assumes a new allocation | Continue only after confirming the exact data already exists at the mapped path. |
| Two MedOS torrents appear | Old and new jobs were both added | Remove the obsolete job without deleting files; keep current infohash. |
| Torrent is 100% but MedOS fails | Torrent integrity is not application configuration | Run the current launcher and inspect content/health diagnostics; bundled UpToDate is automatic. |
| Old magnet does not contain a new fix | Magnets are immutable | Apply a small core hotfix or use a newly published torrent infohash. |

### Android

| Symptom | Most likely cause | First safe action |
|---|---|---|
| APK is blocked | Android install-unknown-apps permission | Permit the specific trusted Files/browser app, install, then turn permission off if desired. |
| “App not installed” during update | Signature/package mismatch or incompatible OS | Do not uninstall; obtain the correctly signed APK and confirm Android 9+. |
| Import says no `data` folder | Wrong ZIP selected | Choose the exact `medos-phone-data.zip` from the Android kit. |
| Import runs out of space | ZIP plus extracted data exceed free storage | Allow about 25 GB during import and retry with screen awake. |
| Android media is missing | Older APK path/decryption resolver or incomplete import | Install the current signed APK over the existing app; re-import only if data is reported missing. |
| Phone sync finds no desktop | Desktop not running/LAN-enabled or network isolates clients | Start desktop MedOS, enable LAN, use private Wi-Fi, then retry Sync. |
| Book result is unavailable | Book is intentionally not in phone kit | Use **Manage Storage → Find desktop** on the same Wi-Fi. |

### Escalating a problem

Preserve the working/partially working folder, the original archive or torrent identity, and progression backup. Send the operating system/version, hardware architecture, exact error, named content source/QID/article, last activity-log line, and the privacy-filtered diagnostics ZIP. Never send `.env`, passwords, API keys, account/progression databases, patient data, or an entire licensed content set as a routine support attachment.

---

## One-page quick reference

### New Windows user

Extract the complete folder to its permanent location → `START HERE - WINDOWS.cmd` → **Start MedOS** → use the one MedOS shortcut. Activation makes no second copy of medical data.

### New Mac user

Extract the complete folder → open `MedOS.app` inside it → use Section 3 for first-open approval if needed → keep the folder together.

### New Linux user

Install Python 3.11–3.14 and Node.js 20.9+ with npm (Python 3.12 and Node 22 LTS version 22.13+ recommended) → run `bash "START HERE - LINUX.sh"` in a dedicated complete Linux copy → allow first-setup network installs → later core use is offline → stop with Ctrl+C. Logs: `.medos-linux/logs`.

### Existing desktop user

Export progression → stop MedOS → extract the cumulative kit so `MedOS Update` is inside the existing 1.1.4/1.1.5 folder → apply the platform updater → start current launcher → verify progress and an article. Keep the updater backup.

### Android user

Install the matching signed 1.1.3/code 5 candidate APK over the app → import phone data only when its manifest says it changed → keep existing progress and storage.

### If something fails

Preserve data and private settings → read the exact failure → use the cumulative update or targeted repair → keep integrity checks enabled → share only sanitized diagnostics.

### Password reminder

The download password, MedOS account password, and UpToDate content key serve different purposes. Bundled UpToDate needs no manual password entry. Keep personal account credentials, sync tokens, and API keys private.

---

## 13. Optional help with ChatGPT or Codex

### A note from the maintainer

I maintain MedOS alongside residency shifts, so a personal reply or a new fix may take time. Please keep your working data and a progression backup. A clear error report helps me reproduce a problem when I am back at the project. If you are comfortable using an AI coding assistant, you can also investigate a local copy while waiting.

### Set up optional assistance

Install and sign in to the current desktop app, then choose a chat/project or open your MedOS source folder. Select ChatGPT or Codex for the task. See the [official desktop-app guide](https://learn.chatgpt.com/docs/app). Codex is included with ChatGPT Free and other listed plans, but available usage varies by plan, model, and work; check your own limits. There is no guaranteed “3–4 chats” repair allowance. See [current pricing and limits](https://learn.chatgpt.com/docs/pricing).

Work on a backup or separate code checkout. Keep `.env`, user/account/progression databases, patient files, and licensed content out of uploads. An assistant should inspect the code and bounded sanitized diagnostics, explain the cause, apply a reviewable fix, and run relevant tests. Optional AI help is not a requirement for installing or using MedOS.

### Copyable repair prompt

```text
Help diagnose this MedOS installation in a backup or separate code checkout.
Desktop version / Android version:
Operating system, version, and CPU architecture:
Exact error text and the step that triggers it:
Expected result and actual result:
Launcher used and whether this was a full release or cumulative update:
What still works:
Sanitized diagnostics / relevant log excerpt:

Preserve medical content, accounts, progression, private .env, and existing backups.
Inspect the actual release identity and code before editing. Reproduce the cause,
make a focused fix, and run relevant regression tests and startup/content checks.
Do not bypass hashes, manifests, BUILD_ID checks, authentication, or decryption.
Do not treat an error as an empty database or reset users/progression to fix it.
If the frontend is rebuilt, restore its complete matching build and metadata.
Report changed files, tests, remaining limits, and how to undo the code change.
Do not request or upload .env files, user databases, patient files, or full content.
```

---

## Appendix A. Historical 1.1.4 distributions

**Historical identification only. Nothing in this appendix identifies the 1.1.5 candidate, its update ZIP, or Android 1.1.3 APK.** These records are retained from the previous complete guide so old downloads and support screenshots can be identified. Some old 1.1.4 artifacts differ from the exact September 2 archive inspected for this repair. Follow current Sections 1–4 for installation and updates.

### Historical torrent identities

These magnets identify old distributions only. Do not use them as the 1.1.5 candidate or the 1.1.3 APK. To reuse an old desktop download, apply the current cumulative update to a supported stopped folder. A future complete torrent needs a new identity.

**Old desktop 1.1.4 torrent** — payload 54,868,073,964 bytes; save-path mapping was the parent of the `MedOS` folder.

```text
magnet:?xt=urn:btih:fd89e50dcd74643712f3eeb81c10f13b83861a77&dn=MedOS&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce
```

**Old Android 1.1.2 kit torrent** — six files totaling 11,986,374,413 bytes. Its old signed APK is not the new candidate APK.

```text
magnet:?xt=urn:btih:d3dfb91ba9179bd0731b969d99e1d1ad06620fd0&dn=ANDROID%20-%20COPY%20TO%20PHONE&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopentracker.i2p.rocks%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce
```

### Historical verification notes from the previous guide

### Universal desktop package

- Release identity: **medos-1.1.4**
- Published archive inventory: **210,727 files**, **52,825,586,908 uncompressed bytes**
- Export completeness gate: no missing features, packs, or incomplete packs
- Mac runtime inventory: **arm64 and x64**
- Portable activation: enabled
- Normal shortcut contract: **one MedOS shortcut**

### Additional Qbanks

Each published SQLite database passed `PRAGMA quick_check` and the expected question count:

- MKSAP 19 — 1,870
- BoardVitals 2025 — 1,890
- AMBOSS ABIM 2025 — 2,082
- UWorld ABIM March 2026 — 1,249

### Cross-platform installer verification

The focused release regression set completed with **153 tests passing** before publication. The published folder contains both Mac runtime architectures and retained Unix executable modes.

An Apple-silicon Mac installation was also reported working after the historical Mac fixes. The Intel bundle is present and covered by structure/runtime tests; that is not represented here as a newly observed physical Intel-Mac installation.

### Shareable archive

- Format: ZIP64 with password-protected ZipCrypto entries for broad 7-Zip/WinRAR compatibility
- Archive size: **39,477,136,807 bytes**
- Files: **210,727**
- Uncompressed size: **52,825,586,908 bytes**
- Archive password/CRC test: **passed — Everything is Ok**
- SHA-256: supplied in the matching `.sha256` sidecar generated after the final archive is built

Compare the archive's SHA-256 with the supplied `.sha256` sidecar after downloading. A matching hash detects transfer corruption or alteration; continue to obtain the file and password from a trusted distributor.

### Public desktop torrent

- Infohash: `fd89e50dcd74643712f3eeb81c10f13b83861a77`
- Payload: **54,868,073,964 bytes** in **104,944 files**
- Pieces: **3,271**
- Validation: metadata/file set checked; the local D-drive payload completed a 100% client recheck and was observed seeding in µTorrent; MedOS/libtorrent accepted the same distribution identity
- Save-path contract: choose the parent of the `MedOS` folder
- Privacy boundary: excludes `.env`, personal progression, Git metadata, agent/development files, and loose Anki media; includes the runtime-required app/backend files and `collection.media.7z`

### Android distribution torrent

- Infohash: `d3dfb91ba9179bd0731b969d99e1d1ad06620fd0`
- Payload: **11,986,374,413 bytes** in **6 files**
- Pieces: **1,429** at 8 MiB each
- Contents: signed APK, `medos-phone-data.zip`, start guide, manifest, and checksum files
- Validation: D- and F-drive torrent files had matching SHA-256 values; file set and magnet were parsed and matched the copied Android kit

The universal archive, desktop torrent, and Android torrent are different artifacts. Their sizes and file counts should not be compared as if they were three copies of one manifest.

---

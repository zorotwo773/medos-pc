# MedOS 1.1.5 distribution guide

## Current candidate products

| Product | Version and boundary |
|---|---|
| Complete desktop folder | 1.1.5 candidate; Windows and both Mac bundled runtimes, maintained Linux launcher, desktop medical content |
| Cumulative MedOS Update kit | Application/build/metadata update for an existing 1.1.4 or 1.1.5 desktop folder; no medical data or private `.env` |
| Android APK | 1.1.3 candidate, version code 5; correctly signed update installed over the app |
| Phone content kit | Separate data manifest and checksums; reuse existing installed data unless content actually changed |

**Use the delivered `release.json` and checksum sidecars for final filenames, sizes, hashes, source revision, and test evidence.** This document does not assign a new ZIP size, APK hash, or torrent magnet before the artifact is built and measured.

The canonical handbook is [docs/MEDOS_COMPLETE_RELEASE_GUIDE_1.1.5.md](docs/MEDOS_COMPLETE_RELEASE_GUIDE_1.1.5.md); `MedOS_USER_GUIDE.md` is its identical root mirror. HTML/PDF outputs should be regenerated from that canonical text.

## Recipient entry points

- **Windows:** fully extract the permanent folder, open `START HERE - WINDOWS.cmd`, and click **Start MedOS**. Activation creates one MedOS shortcut without a second medical-data copy.
- **Apple Silicon / Intel Mac:** open `MedOS.app` inside the complete folder. Use the current System Settings approval instructions in the guide if macOS blocks a trusted first open. Keep the folder together.
- **Linux:** install Python 3.11–3.14 (3.12 recommended) and Node.js 20.9+ with npm (Node 22 LTS version 22.13+ recommended), then run `bash "START HERE - LINUX.sh"` in a dedicated complete Linux copy. Keep a separate Windows/Mac copy because Linux setup replaces frontend dependencies. First setup needs network for core Python dependencies, verified `linux/requirements-lock.txt`, and `npm ci`; subsequent core use is offline. Prefer a native Linux filesystem. Logs are in `.medos-linux/logs`; Ctrl+C stops the launcher.
- **Android:** install the current signed APK over the app. Never uninstall or clear storage during an update. Import the phone-data ZIP only when required by its current manifest.

## Existing desktop installations

Recipients stop MedOS and extract the update ZIP **into their existing complete MedOS folder**, creating a child named **MedOS Update**. They run **APPLY UPDATE - WINDOWS.cmd**, **APPLY UPDATE - MAC.command**, or on Linux `python3 "MedOS Update/apply_update.py" --root . --kit "MedOS Update"` from the MedOS root.

The kit backs up old application files and restores the entire `.next` build with matching code and release metadata. It preserves `data/`, private environment configuration, and user progress. Accepted base versions are 1.1.4 and 1.1.5. Do not distribute a handful of new chunks or a changed `BUILD_ID` as a repair. Integrity failures require coherent files, not weaker checks.

## Content and platform claims

- Bundled UpToDate uses a verified dataset-specific default key. No user `.env` edit is needed; explicit custom overrides remain supported.
- The checked source contains 22,406 records: **22,376 readable articles and 30 verified empty records**. Empty rows are unavailable, not fabricated content.
- Core startup does not depend on PyTorch/transformers/FAISS or AI credentials. Keep optional ML installations out of Linux core setup and Windows/Mac core dependency gates.
- Desktop and Android have different content sets. Preserve the guide's feature comparison and inspect the actual content manifest before promising a database or book on the phone.
- Windows passed startup, health, frontend, login, encrypted-topic, and print HTTP checks with bundled Python 3.12.7/Node 22.11.0. Ubuntu 24.04 amd64 under WSL1 passed startup, health, frontend, login, and encrypted-topic HTTP checks with Python 3.12.3/Node 22.11.0. Android passed 563 JVM and 4 emulator tests. WSL and emulator results do not establish native Mac or physical-device Wi-Fi acceptance; those remain pending unless recorded by the final release report.

## Publisher checklist

1. Record the exact source revision and intentional working-tree changes. Build a complete frontend, then package that build and its matching backend/metadata together.
2. Verify the update kit against a supported stopped installation. Test preservation using isolated user-state fixtures; never use personal databases as disposable fixtures.
3. Include current platform entry points, the canonical guide and its generated outputs, release identity, manifests, and checksum sidecars.
4. Measure final artifacts and run the appropriate archive/integrity test. Publish the resulting identities in `release.json` and the matching sidecars.
5. Preserve correctly signed Android update identity. Do not reuse the old 1.1.2/code 4 APK hash for the new APK.
6. Exclude private `.env`, account/progression databases, tokens, API keys, patient files, logs, and signing secrets from public products. Redact diagnostics before sharing.
7. Distribute third-party reference material only with the necessary permission. MedOS packaging does not grant redistribution rights.
8. Publish a new torrent identity for changed payload bytes. An old magnet cannot silently acquire these fixes.

## Historical 1.1.4 artifacts

The exact older archive examined for this repair is **`MedOS-universal-desktop-20260902-2254-40b3802d.zip`**, with matching extracted folder **`MedOS-Universal-1.1.4`**. Its inspected metadata records **210,890 files** and **52,852,045,035 uncompressed bytes**. Older guide numbers, an older root folder, and an older Setup ZIP describe different states. The extracted folder also has later metadata edits; do not claim it is entirely byte-identical to the archived copy.

Old desktop/Android magnets and earlier inventory figures are retained only in **Appendix A** of the complete guide. `RELEASE_*README.txt` files and `docs/MEDOS_COMPLETE_RELEASE_GUIDE_1.1.4.md` are historical references. They do not identify the 1.1.5 candidate or its update kit.

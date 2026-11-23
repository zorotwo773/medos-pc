# MedOS developer change log

This file is the shared record for everyone working on this MedOS project with the AI
assistant. The assistant appends an entry after **every** edit, and moves entries from
**Pending changes** to **Shipped** only after a verified EXE build.

Per-session rules are in `installer\updater\DEVELOPER_START_PROMPT.md`.

---

## Environment

- MedOS root: `C:\MedOS`
- Developer toolkit: `C:\MedOS\installer\updater`
- Distribution folder: `D:\MedOS-installer-dist`
- Current release: `medos-1.1.5`
- Python: `C:\MedOS\tools\python\python.exe`

## Pending changes (not yet inside an EXE)

(none)

## Shipped

### 2026-11-23 20:18 — Shipped in MedOS-Setup.exe (medos-1.1.5, PC-only payload)

- EXE: `D:\MedOS-installer-dist\MedOS-Setup.exe`
- Size: **535,991,041 bytes**
- EXE SHA-256: `251a645bdc613c509caeffc8aa97239554a84cd480cd114490d049f3252d3cf9`
- Payload SHA-256: `4ddb8e92fdde68f833bee020bb38e11b52ed0d64f40fb2abe764e41203739fd4`
- Installer smoke suite (`test_installer.ps1`): **ALL CHECKS PASSED**
- Real-payload scratch install + `validate_install.ps1`: **ALL CHECKS PASSED**
  (including `BUILD_ID` / `.medos-shipped`, no shipped `.env` or personal
  content, bundled Python/Node imports and runtime checks). Registry and
  shortcuts were restored and the scratch install removed afterward.
- Payload spot checks: the archive contains bundled `tools/7z/*`, the compiled
  UI with the one-click RAR/ZIP/7z import action, and `app/backend/pdf_export.py`
  with SHA-256 `879383b416f15017451be4a2621ede75b0b06f5f62c0962b8822f5d31de256ab`
  (the page-boundary explanation truncation fix).
- First-party phone/Android-only helpers (`setup_center/android.py`,
  `setup_center/templates/android-guide.html`, and
  `tools/medroxi-sync/export_from_phone.py`) are excluded from the installer
  payload and from the private GitHub repository. No APK or signing material
  is included.
- All entries below were Pending before this build and are now included.

### 2026-11-22 23:58 — Fix Q-Bank PDF image omissions

- Request: the PDF exporter now says images are "omitted" and exports most figures missing.
- Files changed: `app/backend/routers/export.py` (also mirrored in the shared PC overlay).
- Root cause: `_MAX_EMBEDDED_IMAGES = 16` was a single session-wide budget, so a
  30-question block with more than 16 figures dropped every later image.
- Fix: per-question budget (40), generous session ceiling (512), total-byte ceiling
  (384 MB), and a data-URL cache so one figure repeated as an anchor/exhibit/declared
  media is only decoded and counted once.
- Tests: `ALL PDF EXPORT TESTS PASSED` (including the new per-question-budget
  regression). Live ped-cardio block after backend restart: HTTP 200,
  `media=82;exhibits=3;hydrated=30;failed=9`; 121 pages, 65 pages with images,
  0 `omitted` / `image cap` strings, 0 `<img src` or `data:image` text leaks. The
  9 remaining `failed` refs are `.mp4`/`.mp3` clips, which a PDF cannot embed.
- Notes: no PDF renderer/network change; this is confined to server-side visual resolution.

### 2026-11-23 00:02 — Make RAR content import work for fresh installs

- Request: the import option does not work; let users choose RAR files, extract
  them automatically and handle them correctly, especially for new users who
  only installed `MedOS-Setup.exe`.
- Files changed: `app/backend/content_transfer.py`, `app/backend/routers/content.py`,
  `app/components/content/TransferPanel.tsx`.
- Changes:
  - `.rar` extraction now uses bundled 7-Zip first, with WinRAR as fallback, so
    RAR5 archives open on a fresh install with no third-party program.
  - Added `/content/transfer/import-quick` plus a content-only background job that
    extracts the archive, reads the MedOS manifest, merges the content and wires
    it in. Personal data is deliberately left untouched.
  - The native archive picker now advertises RAR/7z/ZIP.
  - Added a prominent **Import content RAR / ZIP / 7z** action to Transfer & backup.
    It picks the file, extracts it and imports content in one step, with live
    progress; the advanced Import window is still available for personal data.
  - AMBOSS qbank bundle folders containing `ambossqb-*.db` now register
    `AMBOSS_QBANK_DIR` from their parent, so all Step 1/2/3 banks appear at once.
- Tests: Python compile OK; `tsc --noEmit` OK. Pending: backend import smoke test
  and real `amboss.rar` import.
- Notes: 7-Zip binaries must be added under `tools/7z/`; this is outside the
  patch-updater whitelist and requires a full installer build.

### 2026-11-23 — Fix AMBOSS import test findings (full re-test pending)

- First real `D:\MedOS-installer-dist\amboss.rar` scratch import extracted 1.56 GB
  and copied all four roots (library DB plus all three qbank bundle folders) with
  `error: None`, but exposed two defects:
  1. Windows globbing is case-insensitive, so `Amboss-*` matched the library file
     `amboss-2025.db`. The library folder was reported as an AMBOSS qbank root,
     `AMBOSS_QBANK_DIR` was set to `data\amboss`, and the registry showed only
     `uworld: 3` — zero AMBOSS banks.
  2. Applying several override keys started several background search-index
     rebuilds at once. One failed with `PermissionError` on
     `global_search.sqlite.tmp`; the import still finished, but the traceback is
     unacceptable in a fresh-install flow.
- Files changed: `app/backend/routers/content.py`,
  `app/backend/content_transfer.py` (also restaged and mirrored to the overlay).
- Fixes: qbank bundle detection now requires directories; `ImportFolderRequest`
  gained `refresh_index` so batch imports suppress per-key kicks;
  `_apply_content()` kicks one coalesced reindex at the end; `_kick_index_refresh()`
  is single-flight with a pending counter so unrelated callers cannot spawn
  competing rebuilds.
- Verification so far: Python compile OK. Read-only preview of the extracted
  scratch tree now reports only `AMBOSS library` for `data\amboss`, and reports
  `AMBOSS qbank bundle` with `AMBOSS_QBANK_DIR=data` for every Step 1/2/3 bundle
  folder. Full scratch re-import is running.

### 2026-11-23 — Mirror import/export overlay and bundled 7-Zip source

- Files changed in the shared PC overlay workspace: `publish.tsv`,
  `README-publish.md`, `overlay-hashes.sha256`, plus source copies of
  `backend/content_transfer.py`, `backend/routers/content.py`,
  `backend/routers/export.py`, `components/content/TransferPanel.tsx` and
  `tools/7z/*`.
- `publish.tsv` now installs 17 sources, including the bundled 7-Zip binaries.
  `overlay-hashes.sha256` was regenerated and verified: every overlay source
  hash matches its installed target.
- Documentation now records the per-question/global PDF image budgets, the
  one-click content-only RAR/ZIP/7z import flow, AMBOSS qbank bundle detection,
  and that `tools/7z/` requires a full `MedOS-Setup.exe` build.
- `tools/7z/*` was also staged under `.medos-dev\changes\` for the change record.
  Those paths are rejected by the patch updater's `safe_relative()` by design;
  this confirms a full installer build is required. Validation result: the four
  `app/` files are accepted, while all four `tools/7z/` files are rejected with
  "Path is outside the code update scope".
- No EXE was rebuilt by this mirror update; it remains Pending until the full
  installer smoke and real-payload checks pass.

### 2026-11-23 — Rebuild compiled Next.js bundle for the RAR import UI

- Files changed: regenerated `app\.next\*` and wrote `app\.next\.medos-shipped`.
- `C:\MedOS\tools\node\npm.cmd run build` completed successfully with Next.js
  16.2.3 (Turbopack): compiled in 11.7s, TypeScript in 26.6s, all 28 static
  pages generated, no errors.
- New `BUILD_ID`: `6NVGquVwiX81LR4sRXga4`. The rebuild removed
  `.medos-shipped`; it was restored with the exact `BUILD_ID` and verified to
  match. The marker is staged under `.medos-dev\changes\app\.next\`.
- This compiled UI must be inside the full EXE rebuild; the old EXE still ships
  the previous Transfer & backup screen without the one-click RAR action.

### 2026-11-23 — Fix randomized Q-Bank PDF explanation truncation

- Request: in PDF export some questions were incomplete; the first question's
  explanation stopped after `(Choice A)`, and the same happened randomly in
  other questions.
- File changed: `app/backend/pdf_export.py` (mirrored to the shared PC overlay
  and staged under `.medos-dev\changes\`).
- Root cause: a data-URL `<figure>` was left inline inside a paragraph. When
  PyMuPDF Story placed that figure as the first item on a new page (the answer
  subtitle could shift it across the boundary), it silently stopped laying out
  the rest of the section: only the trailing sentence appeared on the next page
  and `(Choice B)`, `(Choice C)`, `(Choice E)` and `Educational objective` were
  lost.
- Fix: `_defer_inline_images()` now moves `<figure>` blocks and bare `<img>`
  tags to the end of each rich-text field; captions travel with their figure.
  All prose is laid out before the images, so a page-boundary image can no
  longer truncate an explanation. Images are still embedded and drawn.
- Tests: added `test_inline_figure_at_page_boundary_keeps_full_explanation()`
  to the overlay PDF suite. It reproduces the Story bug with images left inline
  and verifies the fixed export keeps all trailing markers, the caption, and
  the embedded figures. Full suite: `ALL PDF EXPORT TESTS PASSED`.
- Live verification after restarting the 8002 backend: HTTP 200,
  `media=82;exhibits=3;hydrated=30;failed=9`; 120 pages, 54 pages with images,
  0 `<img src` / `data:image` text leaks, 0 `omitted` / `image cap` strings.
  Q1 answer contains `(Choice B)`, `(Choice C)`, `(Choice E)` and
  `Educational objective`; a tail-word check passed for all 30 questions.
- Overlay `README-publish.md` and `overlay-hashes.sha256` were updated; all 17
  overlay sources match their installed targets.

### 2026-11-22 20:22 — Shipped in MedOS-Setup.exe (medos-1.1.5)

- EXE: `D:\MedOS-installer-dist\MedOS-Setup.exe`
- Size: **535,382,105 bytes**
- EXE SHA-256: `4782eb888b2ed3f6a214540febab51b326f4c8f0b07186fe3cab515287aaca6e`
- Payload SHA-256: `2694c2dc292c56f109b347673d45fc7ad15fc95d20a51c604a5d1b6733ccd08d`
- Installer smoke suite (`test_installer.ps1`): **ALL CHECKS PASSED**
- Real-payload scratch install + `validate_install.ps1`: **ALL CHECKS PASSED**
  (including `BUILD_ID` / `.medos-shipped`, no shipped `.env` or personal
  content, bundled runtime checks). Registry and shortcuts restored, scratch
  install removed.
- Contains the base64-text export fix below plus everything from the 17:39
  build. The signed `MedOS-Offline.apk` remains a separate artifact.

### 2026-11-22 20:12 — Fix base64 letters printed in Q-Bank PDFs (PC only)

- User report: the "ped cardio 30-question block" session exported fine, but
  from about page 12 onward the PDF was filled with random letters.
- Reproduced exactly: 242 pages, with literal `<img src="data:image/png;base64,…`
  text on the pages. Root cause: `enrich_qbank_questions()` inlines each local
  figure as a base64 data URL, but `_prepare_questions()` then clipped the rich
  HTML with a plain 500,000-character slice (`MAX_HTML_CHARS // 4`). The cut
  landed inside an `<img src>` value, so HTMLParser reported the unterminated
  tag as text and PyMuPDF Story printed the whole data URL as page content.
- Fix in `app/backend/pdf_export.py`:
  - added `MAX_RICH_HTML_CHARS` (32 MB) so enriched HTML is no longer cut short;
  - added `_clip_html_safe()`, which drops a trailing unterminated tag instead
    of leaving a half-written attribute (used for all rich HTML fields and for
    the final sanitizer input);
  - added `_valid_data_url()`, which rejects incomplete or undecodable base64
    image payloads before they reach Story.
- Verification: the same session now exports to **92 pages**, no `<img` or
  `data:image` text on any page, 11 pages with real images. Live HTTP export
  through the restarted backend: `media=16;exhibits=3;hydrated=30;failed=0`.
  New regression tests added to `test_pdf_export.py`; `ALL PDF EXPORT TESTS PASSED`.

### 2026-11-22 17:39 — Shipped in MedOS-Setup.exe (medos-1.1.5)

- EXE: `D:\MedOS-installer-dist\MedOS-Setup.exe`
- Size: **535,481,910 bytes**
- EXE SHA-256: `dbca5b3ad286c59439d6bd86d9940d026b7c02c2fa9787f9d4dab2fdba2d4dc8`
- Payload SHA-256: `6a5dade08fe924d089533522cab091a4b31a0b55b5397d7fd68ce14b004fafb4`
- Installer smoke suite (`test_installer.ps1`): **ALL CHECKS PASSED**
- Real-payload scratch install + `validate_install.ps1`: **ALL CHECKS PASSED**
  (including `BUILD_ID` / `.medos-shipped` match, no shipped `.env` or personal
  content, bundled Python/Node imports and runtime check). Registry and
  shortcuts were restored and the scratch install removed afterward.
- All entries listed immediately below were pending before this build and are
  now included in the EXE. The signed `MedOS-Offline.apk` remains a separate
  distribution artifact, already published beside the setup EXE.

### 2026-11-22 17:32 — Fix `.medos-shipped` marker for full installer validation

- Request: include all pending updates in a rebuilt `MedOS-Setup.exe`.
- During real-payload installer validation, `BUILD_ID matches .medos-shipped`
  failed because the rebuilt `.next` had no marker file (the old generator wrote
  a literal `shipped` comment instead of the build id).
- Files changed: `app/backend/scripts/build_medos_torrent.py`,
  `app/.next/.medos-shipped`. The generator now writes the exact `BUILD_ID`, and
  the current build carries that marker.
- Tests: after rebuilding the EXE, the installer smoke suite and the real-payload
  scratch install validation both passed with
  `BUILD_ID matches .medos-shipped`.

### 2026-11-22 — Final Q-Bank PDF visual fix: payload mapping + authoritative hydration (PC only)

- Follow-up to the earlier table/image fix: real app exports were still plain
  text even though direct snake_case backend tests passed.
- Root cause 1: `lib/exportPdf.ts` POSTed camelCase fields (`stemHtml`,
  `choicesHtml`, `explanationHtml`, `explanationMedia`) while the FastAPI
  Pydantic model accepts only snake_case and has `extra="ignore"`, so all rich
  HTML was silently dropped before it reached the resolver.
- Fix 1: `downloadPdf()` now maps every Q-Bank field to snake_case before
  POSTing. Added a source-level regression assertion in
  `test_pdf_export.py` so this masking mismatch cannot return unnoticed.
- Root cause 2: exam/localStorage sessions strip `explanation_html` to save
  space, which is exactly where UWorld tables and figures usually live.
- Fix 2: `routers/export.py` now hydrates any numeric-id question from the
  authoritative local bank via `qbank_reader._fetch_full_question()` before
  visual enrichment. It restores rich stem/choices/explanation HTML and media
  refs while preserving the user's answers, chosen index and session metadata.
  Added a bounded cache and `hydrated=` to `X-Medos-Visual-Embeds`.
- Verification: `ALL PDF EXPORT TESTS PASSED` (including new frontend mapping
  and authoritative hydration tests), `tsc --noEmit` clean, `next build`
  successful. Live backend POST with stripped real questions (qids 2135/2134)
  returned `media=1;exhibits=0;hydrated=2;failed=0`, an embedded image and
  authoritative explanation text. Installed bundle serves the mapping chunk.
  `overlay-hashes.sha256` regenerated; installed hash check reports 0
  mismatches. Signed APK unchanged — PC-only fix.

### 2026-11-22 — Fix missing tables/images in Q-Bank PDFs (server-side exhibit/media embedding; PC only)

- Request: the interleaved page order was correct, but exported Q-Bank PDFs still
  had no tables, images or figures.
- Root cause: Q-Bank figures are not plain `<img>` tags. They are exhibit pages at
  `/qbank/exhibit/{id}` (rendered by the app in an iframe — where UWorld tables
  and figures live) and `<a href="/qbank/media/...">` links. The browser-side
  `preparePdfHtml()` only handled `<img src>`, and its fetch also had to pass
  CORS/origin/blob-type checks, so these visuals were silently dropped.
- Fix: visual resolution now happens **on the backend** in `routers/export.py`.
  `enrich_qbank_questions()` inlines exhibit HTML fragments and converts every
  media anchor/`<img>`/declared media ref to a base64 data URL using the same
  `qbank_reader` helpers the Q-Bank UI uses (`_exhibit_html`,
  `_resolve_qbank_media_path`, `_decrypt_media`). Added a `db` field to the
  `/export/pdf/qbank` request model so relative refs resolve against the correct
  bank. Added `X-Medos-Visual-Embeds` response header with media/exhibit/failed
  counts, image budget (16), dedupe and graceful failure (a missing exhibit
  becomes a readable caption instead of breaking the export).
- Frontend: `QuizEngine.tsx` and `lib/exportPdf.ts` now pass the original source
  HTML and relative media/exhibit refs plus the bank key; the fragile
  browser-side fetch/convert path is no longer used for Q-Bank exports.
- Verification: added `test_qbank_visual_resolution()` (stubs `qbank_reader`,
  asserts exhibit table text and two embedded images appear in the PDF with
  `exhibits=1`). `ALL PDF EXPORT TESTS PASSED`, `tsc --noEmit` clean,
  `next build` successful. The signed APK is unchanged.

### 2026-11-22 — PC PDF tables/images + interleaved Q-Bank pages, top-bar theme/font icons (PC only; APK unchanged)

- Request: keep tables and images in exported PDFs; order pages as Question 1 with
  choices, then Question 1 answer and explanation, then Question 2, and so on,
  with choices never sharing a page with the answer. Replace the top-right
  `Library` / `Drug Ref` text links with working Light, Dark, Yellow and font-size
  icons, and turn `Settings` into an icon, affecting Q-Bank, topics and all UI.
- PDF renderer (`backend/pdf_export.py`): Q-Bank sections are now generated per
  question and merged in interleaved order (question/choices page, then answer +
  explanation page). Sanitised source HTML is preserved, so tables render with
  borders and `<img src="data:image/...">` is drawn inline by PyMuPDF Story;
  restricted to embedded images only (no network fetch in the renderer).
  Added `stem_html`, `choices_html`, `explanation_html` and base64 media fields
  to the `/export/pdf/qbank` request model, capped at 800 questions and 8 images.
- Client (`lib/exportPdf.ts`, `components/qbank/QuizEngine.tsx`): new
  `preparePdfHtml()` fetches local Q-Bank media, converts it to data URLs and
  keeps the original HTML; both the top-bar provider and the direct Q-Bank
  buttons now send rich HTML instead of stripped plain text.
- Top bar: `TopBar.tsx` removes the Library/Drug Ref links and adds icon-only
  Light (`Sun`), Dark (`Moon`), Yellow (`SunDim`) and Settings (`Settings`)
  controls. The font icon (`Type`) opens a small popover with a draggable 4-step
  slider and S / M / L / XL buttons beneath it (closes on outside click or Escape).
  All emit `medos:appearance-change`; `SettingsPanel.tsx` owns persistence, writes
  `data-theme` / `data-text-size` and broadcasts `medos:settings-changed`, so
  Q-Bank and topic screens follow. TextSize now includes `small`.
- Theme/font plumbing: added a full Yellow token set in `app/globals.css`, made
  Text Size (small 0.92 / normal 1 / large 1.08 / XL 1.16) and Density scale the
  whole app via body zoom, and updated the pre-hydration script in `app/layout.tsx`
  to restore Yellow.
- Overlay: `publish.tsv` now also installs `SettingsPanel.tsx`, `app/globals.css`
  and `app/layout.tsx`; `README-publish.md` and `overlay-hashes.sha256` refreshed.
- Verification: `ALL PDF EXPORT TESTS PASSED` (40-question interleaving, table +
  image presence, HTTP route rich payloads), `tsc --noEmit` clean, `next build`
  successful. The signed APK is unchanged — this request was PC-only.

### 2026-11-22 — Shared top-right Export PDF, Android My Library / highlights and smooth-screen caching (APK delivered; PC overlay published)

- Request: make the native Android port smooth and add PC feature parity — highlight,
  question bank, library, My Library with marked articles and folders, and other missing
  PC features — plus the same top-right **Export PDF** on PC and Android that exports
  topics and Q-Bank sessions with questions/choices first and answers/explanations after.
- Android performance: `DataStore.java` now has a generation-aware file-listing cache;
  `MainActivity.java` keeps five built screens alive and defers font rebuilding;
  `QBankWorkstation.java` persists per-pool session state; new `QuestionStore.java`
  parses imported questions off the UI thread and caches them. `Screens.java` builds
  long lists in bounded chunks. Full Java 8 / API 21 compile passes.
- Android My Library: new `MyLibrary.java` is a self-contained offline store under
  `<external>/medos/mylibrary/library.json` with folders, saved items, notes, five
  highlight colours, selection action mode, desktop `custom-library.sqlite3` node import,
  and `.tmp`/`.bak` write safety. Added as a `Library` subtab in `NavigationCatalog`
  and dispatched from `Screens.build()`. Text detail dialogs can save articles and
  reapply highlights.
- Android Export PDF: new top-right `Export PDF` header button in `MainActivity`.
  `Screens.exportCurrent()` chooses the context (Q-Bank session, clinical topic text,
  library/content inventory or visible screen text); `PdfExporter.java` writes real PDFs
  with `android.graphics.pdf.PdfDocument`, no permission, no WebView and no runtime JAR.
  Q-Bank PDFs contain all questions and A–H choices first, then a new-page
  **Answers & Explanations** section with the correct letter/text, user answer status,
  explanation, subject, system and tags. Export runs on a worker thread, writes to
  `<app files>/medos/exports/`, and opens in the built-in PDF viewer.
- APK: rebuilt/signed with the existing `medos-reader.jks`; published to
  `C:\MedOS\android-offline\MedOS-Offline.apk`, `C:\MedOS\MedOS-Offline.apk` and
  `D:\MedOS-installer-dist\MedOS-Offline.apk`. Size **930,595 bytes**.
  SHA-256: `be3861731619f509b92cc6a36479889d5d6d000cd2f2cebaa6e7b28d7db9f63b`
  (supersedes `b53e185be6a309ec64b7b0218b6a5734e6dc59ea08ceb5b076e36b447f50013a`).
  Signer SHA-256 unchanged: `037e194d376378936465d706a55f1f38393fa2a3211c25f286acdee2a1f3e91e`.
- PC overlay: added `backend/pdf_export.py` (bundled PyMuPDF, offline),
  `backend/routers/export.py` (`/export/pdf/status|page|topic|qbank|rows`), minimal
  `backend/main.py` router include, `lib/exportPdf.ts` provider registry / page capture /
  Q-Bank localStorage reader, `components/layout/ExportPdfButton.tsx` and a patched
  `TopBar.tsx`. Follow-up: `QuizEngine.tsx` now also has a direct **Export PDF** button
  in the live question toolbar, the Test Complete results screen and beside the builder's
  Start button, so an unsaved session exports immediately; `lib/exportPdf.ts` exports
  `htmlToPlainText()` for shared HTML-to-text conversion. Overlay + `publish.tsv` +
  `README-publish.md` live in the harness workspace `pc/` and were copied into
  `C:\MedOS\app`.
- PC verification: `ALL PDF EXPORT TESTS PASSED` (direct renderers + FastAPI routes,
  including 40-question ordering), `tsc --noEmit` clean, and `next build` successful.
  Re-run after adding the direct Q-Bank buttons: all three checks still pass.
- Device note: no ADB executable/device was available in this session, so installation
  remains the only conditional check; APK badging, packaged manifest, signature, dex,
  hashes and the PC build were verified statically.

### 2026-11-21 — MedOS Offline header themes, four-tab Q-Bank and Clinical Marked library (supersedes the RAR5 APK hash)

- Request: add Dark mode / Yellow reading mode / Full screen next to the header `Aa`
  control; make QBank show the exact PC four-tab workstation; remove the duplicate
  Clinical source row, put UWorld next to AMBOSS, and add a first Clinical `Marked`
  tab that works like the PC Library.
- Header controls: `ThemeState.java` persists light / dark / sepia in
  `medos_reader:theme_mode`; `MainActivity.java` adds `Dark mode`, `Yellow reading
  mode` and `Full screen` buttons after `Aa`, swaps the whole palette via
  `Screens.applyTheme(mode)` and `recreate()`, restores the current tab/search across
  recreation, and implements full screen by hiding the rail, header and subtab bar
  with an `Exit full screen` restore button. `Screens.java` owns matching mutable
  palettes: light `#F6F7F3`, dark `#121A17`, sepia/yellow `#F7F0DF`.
- Q-Bank: new `QBankWorkstation.java` is a self-contained native port of
  `C:\MedOS\app\components\qbank\QuizEngine.tsx` and `SessionLibrary.tsx`. It renders
  the exact four top tabs `Build`, `Review`, `Custom`, `Partner` (default Build) with
  Step 1/2/3 focus, Local status, usage meter, Reset, and the researched options:
  source switch, Question Type tree, Test mode, Questions/Time sliders, all-matched
  toggle, question pool chips, subject/system filters, Search Tags, order and launch
  bar; Review statistics/progression/focused review/bank progress/Clean Bank Mode;
  Custom session library with folder and session actions; Partner share-code entry.
  `Screens.build()` routes both QBank and Clinical UWorld to it.
- Clinical: `NavigationCatalog.java` now orders the single top row as `Marked`,
  `UpToDate`, `AMBOSS`, `UWorld`, `UTD DDx`, `Diseases`, `Drugs`, `Sanford`,
  `First Aid`. The accidental embedded `sourceChips()` row in `Screens.java` was
  deleted. Rail clicks on Clinical land on `Marked` first.
- Marked: `Screens.marked()` is a native Clinical Archivist Library port with
  `Medical Library · N volumes`, title/chapter search, `Harrison's Internal
  Medicine` / `General Collection` shelves, Marked/All and type chips, priority
  stars, direct PDF/image/SQLite/text opening, and an `ADD BOOK` drawer with the
  exact desktop tabs `Upload PDF`, `Folder Rebuild`, `Browse Catalogue`, `Web / URL`.
- Verification: full javac compile of the whole tree passes with source/target 1.8;
  `build.ps1` completed aapt2/javac/jar/d8/zipalign/apksigner. Installed on Xiaomi
  `23073RPBFG` / Android 15 with `adb install -r`. `uiautomator` confirmed the four
  header controls, the corrected Clinical row with no duplicate, all four QBank tabs
  and their major controls, and the Marked ADD BOOK drawer tabs. Screenshot pixel
  samples verified `#121A17` dark, `#F7F0DF` sepia and `#F6F7F3` light; full screen
  hid rail/header/subtabs and `Exit full screen` restored them. No app fatal
  exception in logcat.
- APK: `C:\MedOS\MedOS-Offline.apk`, `C:\MedOS\android-offline\MedOS-Offline.apk`
  and `D:\MedOS-installer-dist\MedOS-Offline.apk`, **815,907 bytes**.
- SHA-256: `3b4f2fa3e3299f3753a19c6ae98ffc4af4d80fbfe10dd8e11fc413b19159b94c`
  (supersedes `a0faea4d1d1b7b4f79167ae7f36665ea2041d9f9b538604641878f3f7ee3b8bc`).
- Ships as an APK, not through the updater EXE, because `safe_relative()` rejects
  `android-*` paths.

### 2026-11-21 — MedOS Offline RAR5 support (superseded by the build above)

- Request: `it says rar5 is not supported`. The staged `first aid step1.rar` on the
  device has the RAR5 marker `52 61 72 21 1A 07 01 00`, but the vendored decoder was
  JunRAR 7.5.1 (RAR4 only) and `InternalExtractor` deliberately rejected RAR5.
- Upgraded the vendored JunRAR subset from 7.5.1 to 8.1.2 in
  `src/com/github/junrar/`: added RAR5 header readers, `Decode5`/`Unpack5`,
  `Rar5Crypt`, BLAKE2sp checksums, VInt/unsigned helpers and new exceptions;
  removed unused CLI/tool classes. Android API 21 compatibility patches added in
  `AndroidCompat.java` (unsigned compare, floorDiv/floorMod), replaced `java.time`
  timestamps with epoch millis, and removed streams/lambdas/`java.util.function`
  and other post-API-21 APIs. `THIRD_PARTY_LICENSES.md` records 8.1.2, BLAKE2 and
  the extraction-only UnRAR restriction; `ADDED_FILES.txt` regenerated.
- `InternalExtractor.java`: RAR5 now follows the same internal JunRAR path as RAR4
  with format-specific messages. `supportedFormats()` = `ZIP, 7z, RAR4, RAR5`.
- In-app wording updated in `Screens.java` and `MainActivity.java`: all Content,
  Home, Help and extractor dialog text now lists RAR5 as supported; RAR5 removed
  from the "reported clearly" limitation list.
- Verification: full javac compile passes with no `java.nio.file`, `java.time`,
  `java.util.stream`, `java.util.function`, lambdas or INVOKEDYNAMIC in the output;
  `build.ps1` completed aapt2/javac/jar/d8/zipalign/apksigner. PC harness passed
  ZIP, ZIP overwrite, 7z, RAR4, RAR5 nested+Unicode, solid RAR5, encrypted-RAR5
  rejection, unsupported format and RAR5/ZIP traversal rejection.
- On-device on Xiaomi `23073RPBFG` / Android 15: installed the new APK; ordinary
  and solid RAR5 test archives each extracted 3 files with the Unicode filename
  intact. The user's staged `first aid step1.rar` (60,107,892 bytes, RAR5)
  extracted **4 files / 77,802,496 bytes** from Content, removed the staged copy,
  and the process stayed alive with no fatal exception.
- APK: `C:\MedOS\MedOS-Offline.apk`, `C:\MedOS\android-offline\MedOS-Offline.apk`
  and `D:\MedOS-installer-dist\MedOS-Offline.apk`, **746,275 bytes**.
- SHA-256: `a0faea4d1d1b7b4f79167ae7f36665ea2041d9f9b538604641878f3f7ee3b8bc`
  (supersedes `752d451cd72d4c074b5392d3e0f8500cd918c70d6a94595d876ac836f5ec14d3`).
- Remaining limitations: encrypted RAR5 (header-encrypted archives may surface a
  `WrongPasswordException` during `Archive` construction), multi-volume/split RAR
  sets, SFX/prefixed ZIP and unvendored 7z filters such as PPMd. Ships as an APK,
  not through the updater EXE, because `safe_relative()` rejects `android-*` paths.

### 2026-11-21 — MedOS Offline reference UI, grouped navigation and internal extractor (superseded by the RAR5 build above)

- Request: `i meant learn from this` with
  `C:\Users\abdulwahhab\AppData\Local\Temp\MedOS-Android-1.2.0.apk` — use that app
  as the UI/IA reference for the offline reader.
- Reference studied: package `com.example.myapplication` 1.2.0, label `MedOS`,
  launchable `.MainActivity`. Its Home was captured with `uiautomator dump` and
  screenshot; sampled colours: background `#F6F7F3`, white rail/cards, ink
  `#16332B`, muted `#5A6D64`, primary `#2E7D64`/`#286D58`, active chip `#DFE9E6`.
  Its rail is Home / Search / QBank / Clinical / More with horizontal subtab chips;
  desktop `app/components/layout/navigationModel.ts` supplied the full group tree.
- UI rebuilt in `MainActivity.java` + `Screens.java`: left white rail, white header
  with group eyebrow/title/subtitle, Search action and top-right `Aa`, grouped
  subtab chips, and the reference hero "Your study, in one place." with
  YOUR PRACTICE / EXPLORE cards. `NavigationCatalog.java` added as the single
  source of truth for rail groups and leaves.
- Import flow consolidated: exactly one import button, in Content. All per-room
  and Home import buttons and the overflow "Import files / Import kit" entries
  were removed. Staged archive rows now extract in-process via
  `activity.extractStaged(file)`.
- Internal extractor added: `InternalExtractor.java` +
  `FileSeekableByteChannel.java`, with vendored Java source under
  `src/org/apache/commons/compress/`, `src/org/tukaani/xz/`,
  `src/com/github/junrar/` and `src/org/slf4j/`. No external extractor app, no
  runtime JARs, no Gradle. `supportedFormats()` = `ZIP, 7z, RAR4`. Licences and
  notices in `THIRD_PARTY_LICENSES.md`.
- `OfflineFileProvider.java` and its manifest provider removed; `DataStore.java`
  now extracts archives directly into `imported/`, extracts archives found while
  importing folders, adds `extractStaged(File)`, and clears `kits/` on clear-all.
- Verification: full javac compile of 213 sources + R.java passes; `build.ps1`
  completes aapt2/javac/jar/d8/zipalign/apksigner; `apksigner verify --verbose`
  is v1/v2/v3 true with one signer (certificate SHA-256
  `037e194d376378936465d706a55f1f38393fa2a3211c25f286acdee2a1f3e91e`);
  `aapt dump permissions` prints only the package name. `aapt dump badging` still
  reports `com.medos.reader`, versionCode 1 / versionName 1.0, minSdk 21,
  targetSdk 34.
- APK: `C:\MedOS\MedOS-Offline.apk`, `C:\MedOS\android-offline\MedOS-Offline.apk`
  and `D:\MedOS-installer-dist\MedOS-Offline.apk`, **684,835 bytes**.
- SHA-256: `752d451cd72d4c074b5392d3e0f8500cd918c70d6a94595d876ac836f5ec14d3`
  (supersedes `8097c7da3a3377a9f448eacad9f8f1f2cca6950bf7500c627beb3c4f0f2db161`).
- On-device verification on Xiaomi `23073RPBFG` / Android 15: installed with
  `adb install -r`; process stayed alive; UI dumps confirmed all ten rail groups,
  their subtab chips and the Content screen with the new single import button and
  internal-extractor wording. Extracted `test.7z` and `test.zip` (3 files each,
  Unicode filename preserved) and `test-rar4.rar` (1 file) from Content; each
  staged archive was removed after success and no fatal exception appeared.
  PC harness also covered overwrite, unsupported-format and path-traversal cases.
- Limitations: RAR5, encrypted archives, multi-volume RAR, SFX/prefixed ZIP and
  unvendored 7z filters such as PPMd are detected and reported clearly. PDF text
  extraction, backend live chat/RAG, torrent/swarm sync, server-hosted UpToDate/
  AMBOSS and remote AI/media routes cannot run offline. This ships as an APK, not
  through the updater EXE, because `safe_relative()` rejects `android-*` paths.

### 2026-11-21 — MedOS Offline native feature completion (final APK installed; superseded by the reference-UI build above)

- Request: `ive connected my android it has medos app add all the features from pc to it`.
  Direct Windows `.exe` -> APK conversion is impossible, so the real MedOS program
  code was ported natively into the permission-free `com.medos.reader` app.
- Native source mapping/porting completed from the actual desktop source:
  - `app/app/page.tsx` -> `MedOSCatalog.java` (Home modules, scope presets, pulse,
    quick actions, search routing).
  - `app/components/calculators/CalculatorHub.tsx` -> `CalculatorCatalog.java`
    (all 61 built-in calculators, exact unit factors, result bands, guides).
  - `app/components/acls/*`, `app/lib/acls/*` -> `AclsCatalog.java` (5 algorithm
    node graphs, code-session state machine, timers, counters, quick meds/events,
    reversible causes, references, transcript; sound cues are descriptors only).
  - `app/components/qbank/*`, `app/lib/nbmeScore.ts`, `qbankWorkspaceState.mjs`
    -> `QBankCatalog.java` (Tutor/Timed sessions, per-question/exam timers, mark,
    reveal, eliminate, NBME prediction, peer-adjusted performance, review stats).
  - `app/backend/routers/anki.py`, `app/app/anki/page.tsx` -> `AnkiCatalog.java`
    (exact SM-2 scheduling, due-day/ease rules, decks, tags, bury, study order).
  - `Screens.java` now wires those engines into real screens: imported CSV/JSON/
    JSONL Q-Bank blocks and SQLite browsing; imported CSV/TSV/JSON/JSONL Anki cards
    with persisted progress in `offline_anki_progress_v1`; ACLS walk/map/code views;
    all 61 calculators; source-specific reference screens.
- Build fix: `android-offline\build.ps1` now packages compiled classes into a
  temporary `classes.jar` before d8, avoiding the Windows command-line-too-long
  failure; docs and the mirrored source now record this.
- Verification: javac passes; full `build.ps1` completes aapt2/javac/jar/d8/
  zipalign/apksigner; `apksigner verify --verbose` passes v1+v2+v3 with certificate
  SHA-256 `037e194d376378936465d706a55f1f38393fa2a3211c25f286acdee2a1f3e91e`;
  `aapt dump permissions` prints only the package name (no permissions).
- APK: `C:\MedOS\MedOS-Offline.apk`, `C:\MedOS\android-offline\MedOS-Offline.apk`
  and `D:\MedOS-installer-dist\MedOS-Offline.apk`, 344,867 bytes.
- SHA-256: `8097c7da3a3377a9f448eacad9f8f1f2cca6950bf7500c627beb3c4f0f2db161`.
- On-device verification: USB install was enabled by the user; `adb install -r`
  succeeded on Xiaomi `23073RPBFG` / Android 15, `am start -n
  com.medos.reader/.MainActivity` launched the app, `pidof com.medos.reader`
  stayed alive, and `uiautomator dump` confirmed Home, Search, Content, Library,
  QBank, Calculators, Anki, Chat, Diseases, Differential, Drugs, ACLS, Help and
  Settings render. No app fatal exception in logcat (only Xiaomi/system noise).
- Docs mirrored to `.medos-dev\android-changes\android-offline\`; `README.md`
  and `D:\MedOS-installer-dist\MedOS-Offline-README.txt` updated with the final
  feature set, hash, size, build fix and device results.
- Limitations: RAR/7z kits are staged and opened externally; ZIP is native. PDF
  text extraction, backend live chat/RAG, torrent/swarm sync, server-hosted
  UpToDate/AMBOSS and remote AI/media routes cannot run offline. The desktop 3D
  anatomy renderer becomes a native image/text reader. QBank completed-block
  history is in-memory only; Anki progress persists. This ships as an APK, not
  through the updater EXE, because `safe_relative()` rejects `android-*` paths.

### 2026-11-21 — MedOS for Android 2.0 (APK, not an updater-EXE change)

- Request: build the best possible Android APK with every MedOS feature/tab, the
  same file imports, and a top-right text-size control.
- Approach: extend the existing WebView companion so the real MedOS web app is
  loaded — this guarantees all tabs, tools and import flows stay identical to
  desktop. The missing offline native source (`D:\MedOS\phone`) was not available.
- Files changed (staged in `.medos-dev\android-changes\`):
  - `android-companion\src\com\medos\companion\MainActivity.java` — new navy/teal
    toolbar, top-right `Aa` text-size popup (80–160% slider + five presets, live
    preview, persisted, long-press reset), multi-file Android document picker with
    persistent permissions, card-style offline screen, refreshed overflow menu.
  - `android-companion\AndroidManifest.xml` — `NoActionBar` theme, version 2 / 2.0.
  - `android-companion\build.ps1` — version 2 / 2.0, copies signed APK to
    `D:\MedOS-installer-dist`.
  - `android-companion\README.md`, `MedOS-Companion-README.txt` — updated docs.
  - `android-companion\MedOS-Companion.apk`, `MedOS-Companion.apk` — rebuilt output.
- Tests: `build.ps1` completed aapt2/javac/d8/zipalign/apksigner; `apksigner verify`
  passes v1+v2+v3 with the original signing certificate; `aapt dump badging`
  confirms package/version/minSdk/targetSdk. Emulator/device install was NOT
  possible: hardware virtualization is disabled on this PC and no ADB device is
  attached.
- APK: `C:\MedOS\MedOS-Companion.apk` and `D:\MedOS-installer-dist\MedOS-Companion.apk`,
  54,051 bytes.
- SHA-256: `0a80b96d8d03e5febe281ea5ef966875471b54bb3d457985e4d1d609b95a8025`.
- Final tweak: the document picker requests read-only persistent permission so
  restrictive storage providers do not reject the grant.
- Distribution note: these paths are outside the updater EXE's code whitelist
  (`safe_relative` rejects `android-companion/`). This change ships as an APK, not
  through "add it to the exe"; do not include `.medos-dev\android-changes\` in a
  desktop patch kit.

### 2026-11-21 — MedOS Offline (separate native Android reader, APK)

- Request: keep a fully offline standalone Android reader with all MedOS program
  code/tabs/tools, **zero bundled content**, and support for importing content
  later — the Android equivalent of the clean desktop installer.
- Decisions confirmed with the user: native offline reader (not bundled desktop
  stack), both individual files and archive kits, separate `MedOS Offline` app.
- Files changed (staged in `.medos-dev\android-changes\android-offline\`):
  - `android-offline\src\com\medos\reader\MainActivity.java` — new app shell with
    all 25 MedOS tabs, import dialogs (file / folder / kit), top-right `Aa`
    font-size popup, local progress, storage tools and overflow menu.
  - `android-offline\src\com\medos\reader\Screens.java` — every offline screen,
    12 medical calculators, notes, CSV flashcards, generic reference browsers.
  - `android-offline\src\com\medos\reader\DataStore.java` — file/folder/ZIP import,
    RAR/7z staging, schema-agnostic SQLite browsing, search and text preview.
  - `android-offline\src\com\medos\reader\PdfViewerActivity.java` — native
    `PdfRenderer` viewer with page navigation and zoom.
  - `android-offline\src\com\medos\reader\SQLiteRowDialog.java` — paginated row
    browser with review marks and copy-summary actions.
  - `android-offline\src\com\medos\reader\OfflineFileProvider.java` — read-only,
    path-checked provider for handing staged RAR/7z kits to an external extractor.
  - `android-offline\AndroidManifest.xml` — `com.medos.reader`, label
    `MedOS Offline`, **no `uses-permission` entries**, two activities, local provider.
  - `android-offline\res\values\ids.xml` — `font_base` tag id for text scaling.
  - `android-offline\build.ps1` — reuses companion toolchain, generates icons,
    builds/signs/verifies, copies APK to `C:\MedOS\` and `D:\MedOS-installer-dist\`.
  - `android-offline\medos-reader.jks` — dedicated v1/v2/v3 signing key.
  - `android-offline\README.md`, `MedOS-Offline-README.txt` — full docs.
- Tests: `build.ps1` completed aapt2/javac/d8/zipalign/apksigner. `apksigner verify
  --verbose` passes v1+v2+v3 with one signer (certificate SHA-256
  `037e194d376378936465d706a55f1f38393fa2a3211c25f286acdee2a1f3e91e`). `aapt dump
  badging` confirms package/version/minSdk/targetSdk/label; `aapt dump permissions`
  prints only the package name (no permissions); `aapt list` confirms only manifest,
  icons, resources, dex and signing files — no content bundled. Emulator/device
  install was NOT possible: virtualization disabled and no ADB device attached.
- APK: `C:\MedOS\MedOS-Offline.apk` and `D:\MedOS-installer-dist\MedOS-Offline.apk`,
  103,203 bytes.
- SHA-256: `24d93acdfd875600f4dbbed45ebd8793b6c2a1fea221c332d486867db3bc5d72`.
- Final tweak: import filename sanitizing now preserves Unicode letters/digits, so
  Arabic and other non-Latin filenames survive kit/folder imports unchanged.
- Limitations: RAR/7z cannot be unpacked with platform-only APIs, so those kits are
  staged and opened with an installed extractor; ZIP kits are extracted natively.
  This ships as a standalone APK, not through the desktop updater EXE, because
  `safe_relative()` rejects `android-*` paths.
- Superseded by the final native feature-completion entry above: calculator count,
  QBank/Anki/ACLS engines, APK hash/size and on-device verification were updated.

### 2026-11-18 — Standalone updater EXE (initial developer toolkit)

- Request: build an updater-only EXE that other developers can extend via the AI.
- Files changed:
  - `installer\updater\apply_update.py` — added patch mode, `--verify-only`,
    `--no-port-check`, and permission for Next.js junctions inside `app\.next` on full kits.
  - `installer\updater\Updater.cs` — new WinForms/silent launcher with embedded or external kits.
  - `installer\updater\build_updater.py` — builds full/patch kits and the single-file EXE;
    always injects the current engine.
  - `installer\updater\app.manifest`, `README.md`, `test_engine.py`, `debug_verify.py`.
  - `installer\updater\DEVELOPER_START_PROMPT.md`, `.medos-dev\CHANGELOG.md` — this workflow.
- Tests: engine checks passed; embedded and external full-kit verify exit 0; patch and
  embedded-patch EXE applied to an isolated fake install with data/`.env` preserved;
  GUI launches; footer and manifest hashes match.
- EXE: `D:\MedOS-installer-dist\MedOS-Updater.exe`, 257,794,356 bytes
- SHA-256: `de5176ee80446222b4db0d68e9098972293a2caf9084f6cd453d59e8e9075dbe`
- Payload SHA-256: `744de0b68e7221bd475c974ee6939361e18233de5e1e11ba6275f1aa737ce325`

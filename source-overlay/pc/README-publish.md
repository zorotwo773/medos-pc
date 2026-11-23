# MedOS PC overlay — Export PDF + one-click content import

This overlay adds the top-right **Export PDF** action, the offline PDF backend
used by both PC and Android, and the fresh-install RAR/ZIP/7z content import
path to MedOS PC.

## Files

| Overlay path | Installed path | Purpose |
|---|---|---|
| `backend/pdf_export.py` | `C:\MedOS\app\backend\pdf_export.py` | Offline PyMuPDF renderer for topics/pages, Q-Bank sessions, text and rows. Q-Bank PDFs are interleaved: stem + choices on one page, then answer + explanation on the following page, repeated per question. Tables and embedded base64 images are preserved. Enriched HTML is bounded with a tag-boundary-safe clip (`_clip_html_safe`) so a long inline base64 `src` is never cut in half and printed as page text; incomplete/undecodable data URLs are rejected (`_valid_data_url`). Inline `<figure>`/`<img>` blocks are deferred to the end of each rich-text field so a data-URL image landing at a page boundary cannot truncate the remaining explanation. |
| `backend/routers/export.py` | `C:\MedOS\app\backend\routers\export.py` | FastAPI routes: `GET /export/pdf/status`, `POST /export/pdf/page`, `POST /export/pdf/topic`, `POST /export/pdf/qbank`, `POST /export/pdf/rows`. Restores stripped Q-Bank HTML from the authoritative local bank when a numeric question id is present, then resolves `/qbank/exhibit/{id}` and `/qbank/media/...` refs server-side (using `qbank_reader`) into embedded tables and base64 images. Embed budgets are 40 distinct images per question, 512 per export and 384 MB total, with caching so a repeated figure is decoded once. `X-Medos-Visual-Embeds` reports `media=`, `exhibits=`, `hydrated=` and `failed=` counts. |
| `backend/main.py` | `C:\MedOS\app\backend\main.py` | Minimal diff: imports and includes the export router beside the other local routers. |
| `backend/content_transfer.py` | `C:\MedOS\app\backend\content_transfer.py` | Transfer engine. RAR extraction uses bundled 7-Zip first and WinRAR as fallback, so RAR5 works on a clean install. Adds `start_quick_import()` for one-click, content-only archive extraction, manifest parsing, content merge and wiring; personal data is deliberately untouched. Native archive picker filters RAR/7-Zip/ZIP. Includes path-traversal checks on extracted files and one coalesced global-search reindex per import. |
| `backend/routers/content.py` | `C:\MedOS\app\backend\routers\content.py` | Adds `POST /content/transfer/import-quick`. Detects AMBOSS qbank bundle folders containing `ambossqb-*.db` and registers their parent as `AMBOSS_QBANK_DIR`, so Step 1/2/3 banks are discovered together. Bundle detection requires directories, so `amboss-2025.db` cannot impersonate a qbank root. Background reindexes are single-flight to avoid `global_search.sqlite.tmp` collisions. |
| `components/layout/ExportPdfButton.tsx` | `C:\MedOS\app\components\layout\ExportPdfButton.tsx` | Shared top-right button/menu. Chooses the current topic, Q-Bank session or page, downloads real PDF bytes and notifies MedOS. |
| `components/layout/TopBar.tsx` | `C:\MedOS\app\components\layout\TopBar.tsx` | Top-right action cluster: Export PDF, icon-only Light / Dark / Yellow, Settings, and a font-size icon that opens a popover with a slider plus S / M / L / XL buttons. The old `Library` / `Drug Ref` text links are removed. |
| `components/layout/SettingsPanel.tsx` | `C:\MedOS\app\components\layout\SettingsPanel.tsx` | Owns presentation state; accepts `medos:appearance-change` from the top-bar icons, adds the Yellow theme option and keeps external theme changes in sync. |
| `app/globals.css` | `C:\MedOS\app\app\globals.css` | Adds the full Yellow token set and makes Text Size (S/M/L/XL) / Density scale the whole app (Q-Bank, topics, chrome and dialogs). |
| `app/layout.tsx` | `C:\MedOS\app\app\layout.tsx` | Pre-hydration theme script now restores Yellow as well as Light/Dark. |
| `components/qbank/QuizEngine.tsx` | `C:\MedOS\app\components\qbank\QuizEngine.tsx` | Direct **Export PDF** button on the live question toolbar, results screen and builder; sends rich Q-Bank HTML and embedded media instead of plain text. |
| `components/content/TransferPanel.tsx` | `C:\MedOS\app\components\content\TransferPanel.tsx` | Adds the prominent **Import content RAR / ZIP / 7z** action, calls `/content/transfer/import-quick`, shows live progress outside the modal, and keeps the advanced Import window for personal data. |
| `lib/exportPdf.ts` | `C:\MedOS\app\lib\exportPdf.ts` | Provider registry, page capture, Q-Bank localStorage reader, `htmlToPlainText()`, `preparePdfHtml()` (data-URL image embedding), camelCase-to-snake_case Q-Bank payload mapping and blob download. No new npm dependency. |
| `tools/7z/7z.exe`, `tools/7z/7z.dll`, `tools/7z/License.txt`, `tools/7z/readme.txt` | `C:\MedOS\tools\7z\` | Bundled 7-Zip 26.05 x64 binaries used to extract RAR5/7z on fresh installs. This directory is outside the patch-updater whitelist, so include it in a **full** `MedOS-Setup.exe` build. It is a tool, not medical content. |

## Install

Copy each source in `publish.tsv` to its target. No dependency changes,
schema migrations, network access or permissions are required. For a clean
installer, make sure the full installer payload includes `tools/7z/`; a patch
kit alone cannot add it.

## Verify

From this workspace:

```powershell
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONDONTWRITEBYTECODE='1'
& 'C:\MedOS\tools\python\python.exe' -B 'pc\test-output\test_pdf_export.py'
```

Expected final line:

```text
ALL PDF EXPORT TESTS PASSED
```

Then, from `C:\MedOS\app`:

```powershell
& 'C:\MedOS\app\node_modules\typescript\bin\tsc' --noEmit --project 'C:\MedOS\app\tsconfig.json'
$env:PATH = 'C:\MedOS\tools\node;' + $env:PATH
& 'C:\MedOS\tools\node\npm.cmd' run build
```

Backend/UI syntax checks for the import path:

```powershell
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONDONTWRITEBYTECODE='1'
& 'C:\MedOS\tools\python\python.exe' -B -m py_compile 'C:\MedOS\app\backend\content_transfer.py' 'C:\MedOS\app\backend\routers\content.py' 'C:\MedOS\app\backend\routers\export.py'
& 'C:\MedOS\app\node_modules\typescript\bin\tsc' --noEmit --project 'C:\MedOS\app\tsconfig.json'
```

## Notes

- Existing print-to-PDF helpers for individual articles remain untouched.
- Q-Bank PDF order is now per question: **Question N (stem + choices)** on one
  page, then **Question N — Answer** (correct answer, your result and explanation)
  on the next page. A choice is never on the same page as its answer.
- Source HTML is preserved, so tables render. **Exhibits and images are resolved
  on the backend**, using the same `qbank_reader` helpers the Q-Bank UI uses:
  `/qbank/exhibit/{id}` fragments (UWorld tables/figures shown in an iframe) are
  inlined, and `/qbank/media/{qid}/{name}` anchors/images are decrypted and
  embedded as base64 data URLs. This replaced the earlier browser-side fetch,
  which silently dropped exhibit iframes and `<a href>` media links. The renderer
  still performs no network requests. The response header
  `X-Medos-Visual-Embeds` reports `media=`, `exhibits=`, `hydrated=` and
  `failed=` counts.
- Image budgets are per question rather than a single session-wide cap. A
  normal 300-question session is fine; the limits only engage for pathological
  exports with more than 40 distinct figures on one question, more than 512
  distinct figures total, or more than 384 MB of embedded image data.
- Inline data-URL figures are moved to the end of each rich-text field. PyMuPDF
  Story could silently stop laying out the rest of a paragraph when such a
  figure became the first item on a new page, truncating explanations after
  `(Choice A)`; deferring figures preserves every word while still drawing the
  images, and captions travel with their figure.
- The browser builds Q-Bank payloads with camelCase names, but the backend
  Pydantic model only accepts snake_case and ignores unknown fields. A final
  mapping step in `lib/exportPdf.ts` converts `stemHtml`, `choicesHtml`,
  `explanationHtml`, `explanationMedia`, etc. before POSTing; without it every
  table/image silently disappeared in transit.
- Saved exam sessions intentionally strip `explanation_html` before
  localStorage. At export time the backend now hydrates the question by numeric
  id + bank key from the shipped Q-Bank database, restores the authoritative
  rich HTML/media refs, and then embeds the visuals. User answers/correctness
  are never overwritten.
- The Q-Bank page now has its own **Export PDF** action in the question toolbar,
  on the results screen and beside the builder’s Start button. It sends the live
  session directly, so the PDF is available before localStorage is updated.
- The top-right icons dispatch `medos:appearance-change`; SettingsPanel persists
  `medos.settings.v1` / `medos.theme`, writes `data-theme` + `data-text-size` on
  `<html>` and broadcasts `medos:settings-changed`, so every screen follows.
- Clicking the font icon opens a small popover: a 4-step slider and S / M / L / XL
  buttons below it. Both controls write the same text-size setting; the popover
  closes on outside click or Escape.
- The top-bar Q-Bank provider still reads `medos.qbank.sessions.v2` and
  `medos.qbank.examRun.v1`; stored `correct` values are 1-based and stored
  `answers` values are 0-based.
- The backend renderer clamps oversized inputs and sanitises captured HTML.
- Filenames use a UTF-8 `Content-Disposition` header; the client falls back to a
  safe local name when needed.
- One-click archive import is content-only: it extracts the archive, reads
  `medos-export.json`, wires the content paths and left personal databases
  alone. The advanced Import window is still the explicit place to restore
  My Library, Q-Bank progress or flashcards.
- AMBOSS qbank bundle detection only accepts real directories. Windows globbing
  is case-insensitive, and the first `amboss.rar` test showed `amboss-2025.db`
  being mistaken for an `Amboss-*` bundle folder; that stole `AMBOSS_QBANK_DIR`
  and registered zero AMBOSS banks. The directory check lets the Step 1/2/3
  bundle folders register their common parent correctly.
- A content import can apply several override keys. The confirm endpoint now
  accepts `refresh_index: false` so `_apply_content()` can kick exactly one
  coalesced background reindex after all keys are applied. Previously parallel
  rebuilds collided on `global_search.sqlite.tmp`.

# MedRoxi → MedOS sync

Imports the MedRoxi Q-bank from the Android phone into MedOS under one stable
bank key, `imported-medroxi` (`C:\MedOS\data\qbanks-imported\imported-medroxi`).

## What is installed now

- `101,300` questions with stable MedRoxi IDs
  - `200` full questions: stem, all choices, correct answer, explanation, 149 images
  - `101,100` partial rows: server-truncated 400-char stem + topic + section/chapter
- MedRoxi's 2 study blocks are imported as MedOS sessions `medroxi-test-*`
- 2 answered questions merged into `admin@medos` progress (union, never erased)
- `catalog.json` keeps the raw catalog for reference

MedRoxi only allows 1,000 new study-block questions per day, so full text for
the remaining questions could not be exported on the first run. Partial rows
are marked `[Partial]` / `catalog-only` in their tags and title.

## No duplicates

Question IDs are MedRoxi's own IDs and never renumbered. Re-running the importer
updates a row in place if its content changed and skips it if identical. The
last verification run reported `inserted=0 updated=0 unchanged=101300`.

## Re-run after the daily limit resets

1. Keep the phone connected and MedRoxi open in Chrome. Enable CDP once:

   ```
   adb -s 1530290b shell "echo --remote-debugging-port=9222 > /data/local/tmp/chrome-command-line"
   adb -s 1530290b forward tcp:9222 localabstract:chrome_devtools_remote
   ```

   The exporter expects `http://127.0.0.1:9222/json/list` on the PC.

2. Export fresh data:

   ```
   C:\MedOS\tools\python\python.exe C:\MedOS\tools\medroxi-sync\export_from_phone.py
   ```

3. Import/merge it:

   ```
   C:\MedOS\tools\python\python.exe C:\MedOS\tools\medroxi-sync\import_to_medos.py
   ```

4. If the bank does not appear immediately, restart the MedOS backend
   (`C:\MedOS\STOP.bat` then `C:\MedOS\START.bat`).

No access token or password is stored in any staged file or in these scripts.

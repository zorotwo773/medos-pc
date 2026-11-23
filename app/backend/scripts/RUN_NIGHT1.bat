@echo off
:: ============================================================
::  RUN_NIGHT1.bat — Phase 1 + Phase 2
::  Extract corpus from UTD SQLite + Chunk into 512-token pieces
::  Expected runtime: 1-2 hours total
::  SAFE TO PAUSE: run PAUSE_PIPELINE.bat anytime
::  SAFE TO RESUME: re-run this bat — it auto-resumes
:: ============================================================

echo.
echo  ====================================================
echo   MedOS UTD Pipeline - NIGHT 1
echo   Phase 1: Extract  (45-90 min)
echo   Phase 2: Chunk    (20-30 min)
echo  ====================================================
echo.

cd /d D:\ML

:: Clear any leftover pause signal
if exist "data\PIPELINE_PAUSE" (
    echo  [INFO] Clearing old pause signal...
    del "data\PIPELINE_PAUSE"
)

:: Disable sleep
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
echo  [OK] Sleep disabled

echo.
echo  Checking pipeline status...
python medos/backend/scripts/utd_status.py

echo.
echo  ====================================================
echo   PHASE 1: Extracting corpus
echo   (Will resume automatically if previously started)
echo  ====================================================
echo.

:: Check if Phase 1 already done
python -c "import json,sys; d=json.loads(open('data/utd_extract_v2_ckpt.json').read()) if __import__('os').path.exists('data/utd_extract_v2_ckpt.json') else {}; sys.exit(0 if d.get('done') else 1)" 2>nul
if %ERRORLEVEL% EQU 0 (
    echo  [SKIP] Phase 1 already complete. Skipping to Phase 2.
    goto PHASE2
)

:: Run extraction (auto-resumes if checkpoint exists)
python medos/backend/scripts/utd_extract_corpus_v2.py --resume
if %ERRORLEVEL% neq 0 (
    echo.
    echo  [ERROR] Phase 1 failed or was paused.
    echo  Check status: python medos/backend/scripts/utd_status.py
    goto CLEANUP
)

:PHASE2
echo.
echo  ====================================================
echo   PHASE 2: Chunking corpus
echo  ====================================================
echo.

python medos/backend/scripts/utd_chunk_corpus.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo  [ERROR] Phase 2 failed or was paused.
    goto CLEANUP
)

echo.
echo  ====================================================
echo   NIGHT 1 COMPLETE!
echo   Run RUN_NIGHT2.bat tomorrow for FAISS embedding.
echo   Check status: python medos/backend/scripts/utd_status.py
echo  ====================================================

:CLEANUP
powercfg /change standby-timeout-ac 30
powercfg /change monitor-timeout-ac 10
echo.
pause

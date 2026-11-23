@echo off
:: ============================================================
::  RUN_NIGHT3.bat — Phase 4 (BM25) + Final setup
::  Expected: ~30-45 minutes
::  After this: update .env and restart backend
:: ============================================================

echo.
echo  ====================================================
echo   MedOS UTD Pipeline - NIGHT 3
echo   Phase 4: BM25 Keyword Index (~30 min)
echo  ====================================================
echo.

cd /d D:\ML

if exist "data\PIPELINE_PAUSE" del "data\PIPELINE_PAUSE"

powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0

echo  Status before starting:
python medos/backend/scripts/utd_status.py

echo.
echo  Building BM25 index...
python medos/backend/scripts/utd_build_bm25.py
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] BM25 build failed.
    goto CLEANUP
)

echo.
echo  ====================================================
echo   ALL PHASES COMPLETE!
echo.
echo   Final step: Update backend/.env
echo   Set: VECTORSTORE_PATH=D:/ML/medos/backend/vectorstore/utd_faiss
echo.
echo   Then restart backend:
echo     python medos/backend/main.py
echo  ====================================================
echo.

:CLEANUP
powercfg /change standby-timeout-ac 30
powercfg /change monitor-timeout-ac 10
python medos/backend/scripts/utd_status.py
pause

@echo off
:: ============================================================
::  RESUME PIPELINE — Remove pause signal
::  Deletes the PIPELINE_PAUSE file so the pipeline can run.
::  Then shows status and reminds you which night bat to run.
:: ============================================================
if exist "D:\ML\data\PIPELINE_PAUSE" (
    del "D:\ML\data\PIPELINE_PAUSE"
    echo  [PAUSE CLEARED]
) else (
    echo  [INFO] Pipeline was not paused.
)
echo.
echo  Run the appropriate night script to continue:
echo.
echo    RUN_NIGHT1.bat   - Extract + Chunk  (Phase 1 and 2)
echo    RUN_NIGHT2.bat   - Embed FAISS      (Phase 3, the long one)
echo    RUN_NIGHT3.bat   - BM25 + Finalize  (Phase 4)
echo.
echo  Or check progress first:
echo    python medos\backend\scripts\utd_status.py
echo.
pause

@echo off
:: ============================================================
::  RUN_NIGHT2.bat — Phase 3 (FAISS Embedding)
::  The long one. Typically 6-10 hours on CPU.
::  SAFE TO PAUSE: run PAUSE_PIPELINE.bat anytime
::  SAFE TO RESUME: re-run this bat — continues from last chunk
::  Ctrl+C also saves checkpoint safely.
:: ============================================================

echo.
echo  ====================================================
echo   MedOS UTD Pipeline - NIGHT 2
echo   Phase 3: FAISS Embedding (6-10 hours)
echo   bge-large-en-v1.5 on CPU, batch=32
echo  ====================================================
echo.

cd /d D:\ML

:: Clear pause signal
if exist "data\PIPELINE_PAUSE" (
    echo  [INFO] Clearing old pause signal...
    del "data\PIPELINE_PAUSE"
)

:: Disable sleep
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
echo  [OK] Sleep disabled (set back to 30min on exit)

:: Verify chunks exist
if not exist "data\utd_chunks_v2.jsonl" (
    echo.
    echo  [ERROR] Chunks not found. Run RUN_NIGHT1.bat first.
    goto CLEANUP
)

:: Verify model is downloaded
python -c "import json,os; s=json.loads(open('data/pipeline_state.json').read()) if os.path.exists('data/pipeline_state.json') else {}; m=s.get('models',{}); p=m.get('embed_model_path',''); ok=os.path.exists(p+'/config.json') if p else False; print('[OK] Local model found.' if ok else '[WARN] Local model not found — will download from HuggingFace')"

echo.
echo  Status before starting:
python medos/backend/scripts/utd_status.py

echo.
echo  ====================================================
echo   Starting embedding... Ctrl+C or PAUSE_PIPELINE.bat
echo   to stop safely. Re-run to resume from checkpoint.
echo  ====================================================
echo.

python -u medos/backend/scripts/utd_embed_faiss_v2.py --batch 128
if %ERRORLEVEL% neq 0 (
    echo.
    echo  Embedding stopped - paused or interrupted.
    echo  Re-run RUN_NIGHT2.bat to resume from checkpoint.
    goto CLEANUP
)

echo.
echo  ====================================================
echo   NIGHT 2 COMPLETE! FAISS index built.
echo   Run RUN_NIGHT3.bat for BM25 index (30 min).
echo  ====================================================

:CLEANUP
powercfg /change standby-timeout-ac 30
powercfg /change monitor-timeout-ac 10
echo.
python medos/backend/scripts/utd_status.py
pause

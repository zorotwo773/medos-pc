@echo off
:: ============================================================
:: MedOS UTD Embedding Pipeline v2.0 — Overnight Runner
:: Ground-Truth Edition — Run before you sleep
:: Phases: Extract v2 -> Chunk -> Embed (HNSW) -> BM25 index
:: ============================================================

echo.
echo  ====================================================
echo   MedOS UTD v2.0 — Overnight Embedding Pipeline
echo  ====================================================
echo.

cd /d D:\ML

:: Disable sleep for the session
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
echo [OK] Sleep disabled

echo.
echo Phase 1: Extracting corpus (utd_index-driven, BS4 parsing)...
echo Expected: ~45-90 min for 21,812 topics
echo.
python medos/backend/scripts/utd_extract_corpus_v2.py
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Phase 1 failed.
    pause
    exit /b 1
)

echo.
echo Phase 2: Chunking (512 tokens / 64 overlap)...
echo Expected: ~20-30 min
echo.
python medos/backend/scripts/utd_chunk_corpus.py
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Phase 2 failed.
    pause
    exit /b 1
)

echo.
echo Phase 3: Embedding FAISS (CPU, overnight - 6-10 hrs)...
echo Ctrl+C is safe - resumes from checkpoint automatically.
echo.
python medos/backend/scripts/utd_embed_faiss.py
if %ERRORLEVEL% neq 0 (
    echo Phase 3 interrupted or failed. Re-run this script to resume.
    pause
    exit /b 1
)

echo.
echo  ====================================================
echo   DONE!
echo   Update medos/backend/.env:
echo   VECTORSTORE_PATH=D:/ML/medos/backend/vectorstore/utd_faiss
echo   Then restart: python medos/backend/main.py
echo  ====================================================
echo.

powercfg /change standby-timeout-ac 30
powercfg /change monitor-timeout-ac 10
pause

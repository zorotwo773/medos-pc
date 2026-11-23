@echo off
:: ============================================================
::  PAUSE PIPELINE — Create pause signal
::  The running script will stop at the next checkpoint.
::  Safe for any phase (Extract, Chunk, Embed, BM25).
:: ============================================================
echo. > "D:\ML\data\PIPELINE_PAUSE"
echo.
echo  [PAUSE SIGNAL SENT]
echo.
echo  The pipeline will stop at its next checkpoint (within 1-2 min).
echo  Progress is saved. Run RESUME_PIPELINE.bat to continue.
echo.
pause

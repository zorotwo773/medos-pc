@echo off
REM MedOS — restore your Q-Bank progression AFTER updating.
REM Drag a backup .json onto this file, or run: IMPORT_PROGRESS.bat backup.json [--user you@email]
setlocal
set "HERE=%~dp0"
set "PY=%HERE%tools\python\python.exe"
if not exist "%PY%" set "PY=python"
if "%~1"=="" (
  echo Usage: drag a backup .json onto this file, or
  echo        IMPORT_PROGRESS.bat  medos-progression-backup-YYYYMMDD.json  [--user you@email]
  echo.
  pause
  exit /b 1
)
"%PY%" "%HERE%IMPORT_PROGRESS.py" %*
echo.
pause

@echo off
REM MedOS — back up your Q-Bank progression BEFORE updating. Just double-click.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%tools\python\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%HERE%EXPORT_PROGRESS.py" %*
echo.
pause

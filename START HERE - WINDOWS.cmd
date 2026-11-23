@echo off
setlocal EnableExtensions DisableDelayedExpansion
title MedOS Setup Center
set "MEDOS_SETUP_ROOT=%~dp0"

if not exist "%MEDOS_SETUP_ROOT%tools\python\python.exe" goto :missing
pushd "%MEDOS_SETUP_ROOT%" >nul 2>&1
if errorlevel 1 goto :missing

"%~dp0tools\python\python.exe" -B -E -s -m setup_center serve --drive-root .
set "MEDOS_SETUP_EXIT=%ERRORLEVEL%"
popd

if not "%MEDOS_SETUP_EXIT%"=="0" (
  echo.
  echo MedOS Setup stopped safely with code %MEDOS_SETUP_EXIT%.
  echo Open "START HERE - README.html" for recovery steps.
  pause
)
exit /b %MEDOS_SETUP_EXIT%

:missing
echo.
echo MedOS Setup cannot find its offline Windows runtime.
echo No changes were made to this computer.
echo Open "START HERE - README.html" and choose "Repair this SSD".
pause
exit /b 2

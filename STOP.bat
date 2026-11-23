@echo off
title MedOS Stop
echo.
echo   Stopping MedOS...

REM -- Primary: robust PowerShell reaper (pid files + ports + zombie sweep). -----
REM    Catches a backend whose socket died but whose process kept running, which
REM    the pid/port-only kills below cannot see (empty pid file, refusing port).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0STOP.ps1"

REM -- Belt-and-suspenders fallback (still runs if PowerShell was blocked). ------
if exist "%~dp0app\backend.pid"  for /f "usebackq" %%p in ("%~dp0app\backend.pid")  do taskkill /F /T /PID %%p >nul 2>&1
if exist "%~dp0app\frontend.pid" for /f "usebackq" %%p in ("%~dp0app\frontend.pid") do taskkill /F /T /PID %%p >nul 2>&1
if exist "%~dp0app\status.pid"   for /f "usebackq" %%p in ("%~dp0app\status.pid")   do taskkill /F /T /PID %%p >nul 2>&1
del "%~dp0app\backend.pid"  >nul 2>&1
del "%~dp0app\frontend.pid" >nul 2>&1
del "%~dp0app\status.pid"   >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8002 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":4321 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1

echo   Done. Run START to restart.
timeout /t 2 /nobreak >nul 2>nul
exit /b 0

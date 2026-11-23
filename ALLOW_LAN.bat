@echo off
REM One-time setup: allow other devices on your Wi-Fi (phone, tablet, other PC)
REM to reach MedOS at http://<this-pc-ip>:3000.
REM Localhost works without this. Run only if you want LAN access.
REM Requires admin (UAC will prompt). Safe to re-run.
setlocal
title MedOS - Allow LAN Access
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ALLOW_LAN.ps1"
exit /b %ERRORLEVEL%

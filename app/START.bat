@echo off
setlocal
title MedOS Launcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0START.ps1" %*
exit /b %ERRORLEVEL%

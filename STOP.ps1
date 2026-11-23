#Requires -Version 5
<#
.SYNOPSIS
    Stop every MedOS process for this install — backend, frontend, status page,
    and any zombie left behind (e.g. a backend whose socket died but whose process
    kept running, which the old pid-file + port sweep could not catch).

    Normally run via STOP.bat (double-click). Safe to run repeatedly.
#>
$ROOT_DIR = $PSScriptRoot
Write-Host ""
Write-Host "  Stopping MedOS..." -ForegroundColor Cyan

$killScript = Join-Path $ROOT_DIR "app\medos_kill.ps1"
$count = 0
if (Test-Path $killScript) {
    . $killScript
    $count = Stop-MedosProcesses -RootDir $ROOT_DIR -ShowLog
} else {
    # Fallback if the shared reaper is missing: pid files + listening ports only.
    foreach ($name in @('backend.pid', 'frontend.pid', 'status.pid')) {
        $f = Join-Path $ROOT_DIR "app\$name"
        if (Test-Path $f) {
            $pidVal = ((Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int])
            if ($pidVal) { taskkill /F /T /PID $pidVal 2>$null | Out-Null }
            Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($port in @(8002, 3000, 4321)) {
        $lines = & netstat -ano 2>$null | Select-String ":${port}\s+\S+\s+LISTENING"
        foreach ($line in $lines) {
            if ($line -match '(\d+)\s*$') { taskkill /F /T /PID $Matches[1] 2>$null | Out-Null }
        }
    }
}

Write-Host "  MedOS stopped ($count process(es) cleared). Run START to restart." -ForegroundColor Green
Write-Host ""

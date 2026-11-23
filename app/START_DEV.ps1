#Requires -Version 5
<#
.SYNOPSIS
    MedOS DEV launcher – runs Next.js in dev mode (hot reload, no build needed).
    Use this during active development. Browser opens automatically.
    Logs: app\backend.log, app\frontend.log
    Stop: run STOP.bat from the MedOS root.
.EXAMPLE
    .\START_DEV.ps1
    .\START_DEV.ps1 -BackendOnly
    .\START_DEV.ps1 -FrontendOnly
    .\START_DEV.ps1 -NoBrowser
#>
param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$NoBrowser
)

$APP_DIR      = $PSScriptRoot
$BACKEND_DIR  = Join-Path $APP_DIR "backend"
$ROOT_DIR     = Split-Path $APP_DIR -Parent
$VENV_PYTHON  = Join-Path $ROOT_DIR ".venv\Scripts\python.exe"
$PYTHON_EXE   = if (Test-Path $VENV_PYTHON) { $VENV_PYTHON } else { "python" }
$BACKEND_LOG  = Join-Path $APP_DIR "backend.log"
$BACKEND_ERR  = Join-Path $APP_DIR "backend.err"
$BACKEND_PID  = Join-Path $APP_DIR "backend.pid"
$FRONTEND_LOG = Join-Path $APP_DIR "frontend.log"
$FRONTEND_ERR = Join-Path $APP_DIR "frontend.err"
$FRONTEND_PID = Join-Path $APP_DIR "frontend.pid"

# ── Detect LAN IP (Wi-Fi preferred, then Ethernet) ────────────────────────
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.InterfaceAlias -notmatch 'Loopback|WSL|vEthernet|Bluetooth' -and
        $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1'
    } |
    Sort-Object { switch -Wildcard ($_.InterfaceAlias) { 'Wi-Fi*' { 0 } 'Ethernet*' { 1 } default { 2 } } } |
    Select-Object -First 1).IPAddress
if (-not $lanIP) { $lanIP = "localhost" }
$env:MEDOS_LAN_IP = $lanIP

# ── Kill any previous instances ────────────────────────────────────────────
foreach ($pidFile in @($BACKEND_PID, $FRONTEND_PID)) {
    if (Test-Path $pidFile) {
        $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
        if ($oldPid) { taskkill /F /T /PID $oldPid 2>$null | Out-Null }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
}
foreach ($port in @(8002, 3000)) {
    $lines = & netstat -ano 2>$null | Select-String ":${port}\s+\S+\s+LISTENING"
    foreach ($line in $lines) {
        if ($line -match '(\d+)\s*$') {
            taskkill /F /T /PID $Matches[1] 2>$null | Out-Null
        }
    }
}
Start-Sleep -Milliseconds 500

# ── Start backend hidden ───────────────────────────────────────────────────
if (-not $FrontendOnly) {
    "" | Set-Content $BACKEND_LOG -Encoding UTF8
    "" | Set-Content $BACKEND_ERR -Encoding UTF8

    $bProc = Start-Process -FilePath $PYTHON_EXE `
        -ArgumentList "main.py" `
        -WorkingDirectory $BACKEND_DIR `
        -RedirectStandardOutput $BACKEND_LOG `
        -RedirectStandardError $BACKEND_ERR `
        -WindowStyle Hidden -PassThru

    $bProc.Id | Set-Content $BACKEND_PID
}

# ── Start frontend in dev mode ─────────────────────────────────────────────
# npm run dev = next dev (Turbopack, HMR, no build required).
# Slower first load but code changes reflect instantly without rebuilding.
if (-not $BackendOnly) {
    "" | Set-Content $FRONTEND_LOG -Encoding UTF8
    "" | Set-Content $FRONTEND_ERR -Encoding UTF8

    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    $fProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c npm run dev -- --hostname 0.0.0.0 > `"$FRONTEND_LOG`" 2> `"$FRONTEND_ERR`"" `
        -WorkingDirectory $APP_DIR `
        -WindowStyle Hidden -PassThru

    $fProc.Id | Set-Content $FRONTEND_PID

    # Poll HTTP – dev mode compiles on first request, so allow up to 90 s
    for ($i = 0; $i -lt 180; $i++) {
        Start-Sleep -Milliseconds 500
        if ($fProc.HasExited) { break }
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:3000" `
                -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -ge 100) { break }
        } catch { }
    }
}

# ── Open browser ───────────────────────────────────────────────────────────
if (-not $NoBrowser) {
    Start-Process "http://${lanIP}:3000"
}

#Requires -Version 5
<#
.SYNOPSIS
    MedOS portable launcher. Uses bundled runtimes in tools\ - no system
    Python or Node required. Double-click START.bat from any folder you
    unzipped this into. Logs land in app\backend.log and app\frontend.log.
    Stop with STOP.bat.
#>
param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ROOT_DIR   = $PSScriptRoot
$TOOLS_PY   = Join-Path $ROOT_DIR "tools\python\python.exe"
$TOOLS_NODE = Join-Path $ROOT_DIR "tools\node\node.exe"
$APP_DIR    = Join-Path $ROOT_DIR "app"
$APP_START  = Join-Path $APP_DIR "START.ps1"

# Sanity checks
$missing = @()
if (-not (Test-Path $TOOLS_PY))   { $missing += "tools\python\python.exe" }
if (-not (Test-Path $TOOLS_NODE)) { $missing += "tools\node\node.exe" }
if (-not (Test-Path $APP_START))  { $missing += "app\START.ps1" }
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "  MedOS cannot start. Missing:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "    - $m" -ForegroundColor Yellow }
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# Only one launcher may prepare data/restart services at a time. A second
# double-click opens the first launch's status/app page instead of starting a
# competing Anki extraction and later killing the processes that just started.
$launchMutex = New-Object System.Threading.Mutex($false, "Local\MedOS-Launcher")
$hasLaunchMutex = $false
try {
    $hasLaunchMutex = $launchMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $hasLaunchMutex = $true
}
if (-not $hasLaunchMutex) {
    if (-not $NoBrowser) {
        $openUri = $null
        for ($i = 0; $i -lt 50 -and -not $openUri; $i++) {
            foreach ($candidate in @(
                @{ Port = 4321; Uri = "http://127.0.0.1:4321" },
                @{ Port = 3000; Uri = "http://127.0.0.1:3000" }
            )) {
                $client = New-Object System.Net.Sockets.TcpClient
                try {
                    $pending = $client.BeginConnect("127.0.0.1", $candidate.Port, $null, $null)
                    if ($pending.AsyncWaitHandle.WaitOne(150) -and $client.Connected) {
                        $client.EndConnect($pending)
                        $openUri = $candidate.Uri
                        break
                    }
                } catch {
                } finally {
                    $client.Dispose()
                }
            }
            if (-not $openUri) { Start-Sleep -Milliseconds 200 }
        }
        if ($openUri) { Start-Process $openUri }
    }
    $launchMutex.Dispose()
    exit 0
}

# Clear stale per-machine state from previous runs so the status page never
# shows ghost errors from an earlier failed boot.
foreach ($f in @("backend.log","backend.err","frontend.log","frontend.err","status.pid","backend.pid","frontend.pid")) {
    $p = Join-Path $APP_DIR $f
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

function Get-MedosEnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return "" }
    $pattern = "^\s*$([regex]::Escape($Key))\s*=\s*(.*)\s*$"
    $line = Get-Content $Path -ErrorAction SilentlyContinue | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if ($line -match $pattern) { return $Matches[1].Trim().Trim('"').Trim("'") }
    return ""
}

function New-MedosSessionSecret {
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes) -replace '[+/=]',''
    return $secret.Substring(0, [Math]::Min(48, $secret.Length))
}

function Set-MedosEnvValue {
    param([string]$Path, [string]$Key, [string]$Value)
    $pattern = "^\s*$([regex]::Escape($Key))\s*="
    $lines = @()
    if (Test-Path $Path) { $lines = @(Get-Content $Path -ErrorAction SilentlyContinue) }
    $updated = $false
    $lines = @($lines | ForEach-Object {
        if ($_ -match $pattern) {
            $updated = $true
            "$Key=$Value"
        } else {
            $_
        }
    })
    if (-not $updated) { $lines += "$Key=$Value" }
    Set-Content -Path $Path -Value $lines -Encoding ASCII
}

function Ensure-MedosSessionEnv {
    $backendEnv = Join-Path $APP_DIR "backend\.env"
    $frontendEnv = Join-Path $APP_DIR ".env"
    $secret = Get-MedosEnvValue $backendEnv "MEDOS_SESSION_SECRET"
    if (-not $secret) { $secret = Get-MedosEnvValue $frontendEnv "MEDOS_SESSION_SECRET" }
    if (-not $secret) { $secret = New-MedosSessionSecret }

    # Set the process env FIRST so the auth gate stays enabled even if the .env writes
    # below fail. This launcher runs first (before app\START.ps1) under
    # -ErrorActionPreference Stop in a hidden window, so an unhandled write error on a
    # read-only / AV-locked install dir would silently kill startup. The writes only
    # persist the secret for next launch; failing them must not abort.
    $env:MEDOS_SESSION_SECRET = $secret
    try {
        if (-not (Test-Path $backendEnv)) {
            @"
BACKEND_PORT=8002
ALLOWED_ORIGINS=http://localhost:3000
UTD_DB_PATH=
AMBOSS_DIR=
UTD_PASSWORD=
MEDOS_SESSION_SECRET=$secret
MEDOS_SKIP_REFERENCE_WARMUP=0
"@ | Set-Content -Path $backendEnv -Encoding ASCII
        } elseif ((Get-MedosEnvValue $backendEnv "MEDOS_SESSION_SECRET") -ne $secret) {
            Set-MedosEnvValue $backendEnv "MEDOS_SESSION_SECRET" $secret
        }
        if ((Get-MedosEnvValue $frontendEnv "MEDOS_SESSION_SECRET") -ne $secret) {
            Set-MedosEnvValue $frontendEnv "MEDOS_SESSION_SECRET" $secret
        }
    } catch {
        Write-Host "  (could not persist .env, continuing: $($_.Exception.Message))" -ForegroundColor DarkYellow
    }
}

Ensure-MedosSessionEnv

# Ensure desktop shortcut exists (cheap, idempotent, no admin needed).
# Points at launch.vbs so the app opens hidden with the MedOS icon.
$desktop = [Environment]::GetFolderPath("Desktop")
if (Test-Path $desktop) {
    $shortcut = Join-Path $desktop "MedOS.lnk"
    if (-not (Test-Path $shortcut)) {
        try {
            $vbs = Join-Path $ROOT_DIR "launch.vbs"
            $ico = Join-Path $ROOT_DIR "medos.ico"
            $sh  = New-Object -ComObject WScript.Shell
            $lnk = $sh.CreateShortcut($shortcut)
            $lnk.TargetPath       = "$env:WINDIR\System32\wscript.exe"
            $lnk.Arguments        = "`"$vbs`""
            $lnk.WorkingDirectory = $ROOT_DIR
            if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
            $lnk.Description      = "MedOS - Clinical Intelligence Platform"
            $lnk.Save()
            Write-Host "  Created desktop shortcut: MedOS.lnk" -ForegroundColor Green
        } catch {
            Write-Host "  (could not create desktop shortcut: $($_.Exception.Message))" -ForegroundColor DarkYellow
        }
    }
}

# Delegate to app\START.ps1. It starts the visible status page first, then
# rebuilds the frontend only if the packaged .next output is missing or stale.
$fwd = @()
if ($BackendOnly)  { $fwd += "-BackendOnly" }
if ($FrontendOnly) { $fwd += "-FrontendOnly" }
if ($NoBrowser)    { $fwd += "-NoBrowser" }
& $APP_START @fwd
$launcherExit = if ($?) { 0 } else { 1 }
if ($hasLaunchMutex) { $launchMutex.ReleaseMutex() }
$launchMutex.Dispose()
exit $launcherExit

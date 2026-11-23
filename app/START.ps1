#Requires -Version 5
<#
.SYNOPSIS
    MedOS launcher - starts backend, frontend, and a live status page in the browser.
    All processes run hidden (no terminal windows).
    Logs: app\backend.log / backend.err, app\frontend.log / frontend.err
    Stop: run STOP.bat from the MedOS root.
.EXAMPLE
    .\START.ps1
    .\START.ps1 -BackendOnly
    .\START.ps1 -FrontendOnly
    .\START.ps1 -NoBrowser
#>
param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$NoBrowser
)

$APP_DIR      = $PSScriptRoot
$BACKEND_DIR  = Join-Path $APP_DIR "backend"
$ROOT_DIR     = Split-Path $APP_DIR -Parent

# Prefer bundled runtimes in tools/ (portable mode) over system Python/Node.
$BUNDLED_PY   = Join-Path $ROOT_DIR "tools\python\python.exe"
$BUNDLED_NODE = Join-Path $ROOT_DIR "tools\node"
$VENV_PYTHON  = Join-Path $ROOT_DIR ".venv\Scripts\python.exe"
if (Test-Path $BUNDLED_PY)         { $PYTHON_EXE = $BUNDLED_PY }
elseif (Test-Path $VENV_PYTHON)    { $PYTHON_EXE = $VENV_PYTHON }
else                               { $PYTHON_EXE = "python" }
if (Test-Path (Join-Path $BUNDLED_NODE "node.exe")) {
    $env:PATH = "$BUNDLED_NODE;$env:PATH"
}

# Force child Python (status server, backend, and the boot-time index subprocess) to
# write UTF-8 to the redirected logs. Set BEFORE any Start-Process so every child
# inherits it. Without it the embeddable Python defaults to cp1252 on a redirected
# stream, and a non-ASCII install path (e.g. a Cyrillic/CJK Windows username) makes a
# boot-time print() throw UnicodeEncodeError, which aborts the backend and leaves the
# status page stuck on "Backend starting...".
$env:PYTHONUTF8 = "1"

$BACKEND_LOG  = Join-Path $APP_DIR "backend.log"
$BACKEND_ERR  = Join-Path $APP_DIR "backend.err"
$BACKEND_PID  = Join-Path $APP_DIR "backend.pid"
$FRONTEND_LOG = Join-Path $APP_DIR "frontend.log"
$FRONTEND_ERR = Join-Path $APP_DIR "frontend.err"
$FRONTEND_PID = Join-Path $APP_DIR "frontend.pid"
$STATUS_PID   = Join-Path $APP_DIR "status.pid"
$STATUS_PORT  = 4321

# -- Detect LAN IP (Wi-Fi preferred, then Ethernet) ------------------------
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.InterfaceAlias -notmatch 'Loopback|WSL|vEthernet|Bluetooth' -and
        $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1'
    } |
    Sort-Object { switch -Wildcard ($_.InterfaceAlias) { 'Wi-Fi*' { 0 } 'Ethernet*' { 1 } default { 2 } } } |
    Select-Object -First 1).IPAddress
if (-not $lanIP) { $lanIP = "localhost" }
$env:MEDOS_LAN_IP = $lanIP

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

function New-MedosForwardToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $generator.Dispose()
    }
}

function Initialize-MedosNetworkEnvironment {
    # Resolve the user settings directory through the OS API after importing
    # .env, so a packaged or user-edited env file cannot redirect this control
    # file or reuse an internal forwarding credential.
    $localAppData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::LocalApplicationData,
        [Environment+SpecialFolderOption]::DoNotVerify
    )
    if (-not $localAppData -or -not [IO.Path]::IsPathRooted($localAppData)) {
        throw "Windows LocalAppData is unavailable"
    }
    $settingsDirectory = Join-Path $localAppData "MedOS"
    $env:MEDOS_NETWORK_ACCESS_SETTINGS = Join-Path $settingsDirectory "network-access.json"
    $env:MEDOS_INTERNAL_FORWARD_TOKEN = New-MedosForwardToken
    foreach ($internalName in @(
        "MEDOS_NETWORK_OPERATION_DIRECTORY",
        "MEDOS_NETWORK_OPERATION_TOKEN",
        "MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY",
        "MEDOS_NETWORK_TRANSACTION_WORKER"
    )) {
        [Environment]::SetEnvironmentVariable($internalName, $null, "Process")
    }

    # The fixed helper owns all firewall logic. Bootstrap the private rules once
    # and keep localhost startup available if elevation is cancelled or fails.
    $bootstrapMarker = Join-Path $settingsDirectory "private-firewall-bootstrap.complete"
    $helper = Join-Path $APP_DIR "Set-MedOSNetworkAccess.ps1"
    if (
        -not (Test-Path -LiteralPath $bootstrapMarker) -and
        -not (Test-Path -LiteralPath $env:MEDOS_NETWORK_ACCESS_SETTINGS) -and
        (Test-Path -LiteralPath $helper)
    ) {
        try {
            [IO.Directory]::CreateDirectory($settingsDirectory) | Out-Null
            $systemDirectory = [Environment]::GetFolderPath(
                [Environment+SpecialFolder]::System,
                [Environment+SpecialFolderOption]::DoNotVerify
            )
            $windowsDirectory = [IO.Directory]::GetParent($systemDirectory).FullName
            $powerShell = Join-Path $windowsDirectory "System32\WindowsPowerShell\v1.0\powershell.exe"
            $quotedHelper = '"' + $helper + '"'
            $process = Start-Process -FilePath $powerShell `
                -ArgumentList @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",$quotedHelper,"-Mode","private") `
                -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
            if ($process.ExitCode -ne 0) {
                Write-Host "  (private network access was not authorized; localhost still works)" -ForegroundColor DarkYellow
            }
        } catch {
            Write-Host "  (private network access was not authorized; localhost still works)" -ForegroundColor DarkYellow
        } finally {
            try {
                [IO.Directory]::CreateDirectory($settingsDirectory) | Out-Null
                [IO.File]::WriteAllText($bootstrapMarker, "attempted`n", [Text.Encoding]::ASCII)
            } catch {
                Write-Host "  (could not record network bootstrap; continuing locally)" -ForegroundColor DarkYellow
            }
        }
    }
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

function Get-MedosFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    # Get-FileHash is implemented as a module function in Windows PowerShell 5.1.
    # On some machines that module's command cache is missing or stale, so launcher
    # startup can fail before the status page appears. Use the .NET API directly.
    $stream = $null
    $sha256 = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        $bytes = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace("-", "")
    } finally {
        if ($sha256) { $sha256.Dispose() }
        if ($stream) { $stream.Dispose() }
    }
}

function Get-MedosFileIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    return "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
}

function Ensure-AnkiMediaExtracted {
    param(
        [string]$RootDir = $ROOT_DIR,
        [string]$ExtractorPath = ""
    )

    # Torrent ships Anki images/audio as one archive (74k loose files blow
    # BitTorrent metadata). Expand once into data\anki\collection.media.
    $ankiDir = Join-Path $RootDir "data\anki"
    $mediaDir = Join-Path $ankiDir "collection.media"
    $archive = Join-Path $ankiDir "collection.media.7z"
    $marker = Join-Path $ankiDir "collection.media.complete"
    $markerTemp = "$marker.tmp"
    $identityMarker = "$marker.identity"
    $identityTemp = "$identityMarker.tmp"
    Remove-Item -LiteralPath $markerTemp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $identityTemp -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $archive)) { return }
    $archiveIdentity = Get-MedosFileIdentity -Path $archive
    $mediaReady = Test-Path -LiteralPath $mediaDir -PathType Container
    $markerFingerprint = ""
    $markerIdentity = ""
    try {
        if (Test-Path -LiteralPath $marker -ErrorAction Stop) {
            $markerFingerprint = [string](Get-Content -LiteralPath $marker -Raw -ErrorAction Stop)
        }
        if (Test-Path -LiteralPath $identityMarker -ErrorAction Stop) {
            $markerIdentity = [string](Get-Content -LiteralPath $identityMarker -Raw -ErrorAction Stop)
        }
    } catch {
        $markerFingerprint = ""
        $markerIdentity = ""
    }
    if ($mediaReady -and $markerFingerprint -and $markerIdentity -and
        ($markerIdentity.Trim() -eq $archiveIdentity)) { return }

    # A missing/stale quick identity needs one full verification. Once the
    # SHA-256 marker is confirmed, normal launches only compare cheap metadata.
    $fingerprint = Get-MedosFileSha256 -Path $archive
    if ($mediaReady -and $markerFingerprint -and ($markerFingerprint.Trim() -eq $fingerprint)) {
        try {
            [System.IO.File]::WriteAllText($identityTemp, $archiveIdentity, [System.Text.Encoding]::ASCII)
            Move-Item -LiteralPath $identityTemp -Destination $identityMarker -Force -ErrorAction Stop
        } catch {
            Remove-Item -LiteralPath $identityTemp -Force -ErrorAction SilentlyContinue
            Write-Host "  WARNING: Anki media identity marker failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
        return
    }
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $identityMarker -Force -ErrorAction SilentlyContinue

    Write-Host "  Extracting Anki media (first launch)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
    $seven = if ($ExtractorPath) {
        $ExtractorPath | Where-Object { Test-Path -LiteralPath $_ }
    } else {
        @(
            (Join-Path $RootDir "tools\7z\7za.exe"),
            (Join-Path $RootDir "tools\7z\7z.exe"),
            "C:\Program Files\7-Zip\7z.exe",
            "C:\Program Files (x86)\7-Zip\7z.exe"
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    }
    if (-not $seven) {
        Write-Host "  WARNING: 7-Zip not found - extract data\anki\collection.media.7z manually." -ForegroundColor Yellow
        return
    }
    & $seven x $archive "-o$mediaDir" -aoa -y | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $markerTemp -Force -ErrorAction SilentlyContinue
        Write-Host "  WARNING: Anki media extract failed (exit $LASTEXITCODE)." -ForegroundColor Yellow
    } else {
        try {
            [System.IO.File]::WriteAllText(
                $markerTemp,
                $fingerprint,
                [System.Text.Encoding]::ASCII
            )
            Move-Item -LiteralPath $markerTemp -Destination $marker -Force -ErrorAction Stop
            [System.IO.File]::WriteAllText(
                $identityTemp,
                $archiveIdentity,
                [System.Text.Encoding]::ASCII
            )
            Move-Item -LiteralPath $identityTemp -Destination $identityMarker -Force -ErrorAction Stop
            Write-Host "  Anki media ready." -ForegroundColor Green
        } catch {
            Remove-Item -LiteralPath $markerTemp -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $identityTemp -Force -ErrorAction SilentlyContinue
            Write-Host "  WARNING: Anki media marker failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

function Ensure-MedosSessionEnv {
    $backendEnv = Join-Path $BACKEND_DIR ".env"
    $frontendEnv = Join-Path $APP_DIR ".env"
    $secret = Get-MedosEnvValue $backendEnv "MEDOS_SESSION_SECRET"
    if (-not $secret) { $secret = Get-MedosEnvValue $frontendEnv "MEDOS_SESSION_SECRET" }
    if (-not $secret) { $secret = New-MedosSessionSecret }

    # Set the process env FIRST. The backend (auth.py) and the frontend proxy (proxy.ts)
    # both read MEDOS_SESSION_SECRET from the environment, which the child processes
    # inherit - so the auth gate stays enabled even if the .env writes below fail. The
    # writes only persist it for next launch; on a read-only / AV-locked install dir they
    # must NOT abort startup (the whole script runs under -ErrorActionPreference Stop in a
    # hidden window, so an unhandled write error would silently kill the launch).
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

function Import-MedosEnvFile {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    Get-Content $Path -ErrorAction SilentlyContinue | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2].Trim()
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

function Repair-NextJsonManifests {
    # Some packaged .next JSON manifests can pick up trailing NUL bytes during
    # packaging/extraction. PowerShell's JSON reader ignores them, but Next.js
    # calls JSON.parse() and returns HTTP 500 before the app loads.
    $nextDir = Join-Path $APP_DIR ".next"
    if (-not (Test-Path $nextDir)) { return }
    Get-ChildItem -LiteralPath $nextDir -Recurse -Filter "*.json" -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            try {
                $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
                $end = $bytes.Length
                while ($end -gt 0 -and $bytes[$end - 1] -eq 0) { $end-- }
                if ($end -lt $bytes.Length) {
                    $item = Get-Item -LiteralPath $_.FullName -ErrorAction SilentlyContinue
                    if ($item -and $item.IsReadOnly) { $item.IsReadOnly = $false }
                    $clean = New-Object byte[] $end
                    if ($end -gt 0) {
                        [Array]::Copy($bytes, 0, $clean, 0, $end)
                    }
                    [System.IO.File]::WriteAllBytes($_.FullName, $clean)
                }
            } catch {
                Write-Host "  (could not repair Next manifest $($_.Name): $($_.Exception.Message))" -ForegroundColor DarkYellow
            }
        }
}

function Get-FrontendBuildReason {
    $buildId = Join-Path $APP_DIR ".next\BUILD_ID"
    if (-not (Test-Path $buildId)) {
        return "First launch"
    }

    # Shipped releases carry a prebuilt .next plus this marker. On a recipient's
    # machine we must NEVER rebuild: a full `npm run build` takes a minute, needs
    # the dev toolchain + ~4 GB RAM, and-running concurrently with the backend's
    # FAISS/RAG load-starves the backend until it falls over (the "backend goes
    # offline" symptom). mtime-based staleness is also meaningless after a
    # zip/unzip. Trust the shipped build and just `next start` it.
    $shipped = Join-Path $APP_DIR ".next\.medos-shipped"
    if (Test-Path $shipped) {
        Repair-NextJsonManifests
        return ""
    }

    $builtAt = (Get-Item $buildId).LastWriteTimeUtc
    $srcRoots = @("app", "components", "lib", "proxy.ts", "package.json",
                  "next.config.ts", "next.config.js", "next.config.mjs") |
        ForEach-Object { Join-Path $APP_DIR $_ } | Where-Object { Test-Path $_ }
    $newest = $srcRoots | ForEach-Object {
        if (Test-Path $_ -PathType Container) {
            Get-ChildItem -LiteralPath $_ -Recurse -File -ErrorAction SilentlyContinue
        } else {
            Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue
        }
    } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

    if ($newest -and $newest.LastWriteTimeUtc -gt $builtAt) {
        return "Source changed ($($newest.Name))"
    }
    return ""
}

function Invoke-FrontendBuildIfNeeded {
    $buildReason = Get-FrontendBuildReason
    if (-not $buildReason) { return }

    "Frontend build required: $buildReason. Building now..." | Set-Content $FRONTEND_LOG -Encoding UTF8
    "" | Set-Content $FRONTEND_ERR -Encoding UTF8

    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    Push-Location $APP_DIR
    try {
        & npm run build >> $FRONTEND_LOG 2>> $FRONTEND_ERR
        $buildExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($buildExit -ne 0) {
        "Frontend build failed (exit $buildExit). Fix the build error above, then run START.bat again." |
            Add-Content $FRONTEND_ERR -Encoding UTF8
        exit $buildExit
    }

    "Frontend build complete. Starting Next.js..." | Set-Content $FRONTEND_LOG -Encoding UTF8
    "" | Set-Content $FRONTEND_ERR -Encoding UTF8
}

# Share backend/.env with Next's server process too. The frontend proxy needs
# MEDOS_SESSION_SECRET to keep the login gate enabled in portable releases.
Ensure-MedosSessionEnv
Import-MedosEnvFile (Join-Path $BACKEND_DIR ".env")
$env:NODE_ENV = "production"
Initialize-MedosNetworkEnvironment
# Both the backend and the frontend require the same 64-hex forwarding token.
# Guard against a stale or overwritten process value before either starts.
if ($env:MEDOS_INTERNAL_FORWARD_TOKEN -notmatch '^[a-f0-9]{64}$') {
    $env:MEDOS_INTERNAL_FORWARD_TOKEN = New-MedosForwardToken
}
$env:MEDOS_LAN_IP = $lanIP

# -- Kill any previous instances (robust: pid files + ports + zombie sweep) --
# Uses the shared reaper so a backend whose listener died but whose process is
# still alive - the zombie the old pid/port sweep missed - is also cleared before
# we start fresh. Falls back to the original sweep if the reaper file is missing.
$killScript = Join-Path $APP_DIR "medos_kill.ps1"
if (Test-Path $killScript) {
    . $killScript
    [void](Stop-MedosProcesses -RootDir $ROOT_DIR -Ports @(8002, 3000, $STATUS_PORT))
} else {
    foreach ($pidFile in @($BACKEND_PID, $FRONTEND_PID, $STATUS_PID)) {
        if (Test-Path $pidFile) {
            $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
            if ($oldPid) { taskkill /F /T /PID $oldPid 2>$null | Out-Null }
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        }
    }
    foreach ($port in @(8002, 3000, $STATUS_PORT)) {
        $lines = & netstat -ano 2>$null | Select-String ":${port}\s+\S+\s+LISTENING"
        foreach ($line in $lines) {
            if ($line -match '(\d+)\s*$') {
                taskkill /F /T /PID $Matches[1] 2>$null | Out-Null
            }
        }
    }
}
Start-Sleep -Milliseconds 500

# -- Start status server ----------------------------------------------------
# Opens a live browser status page at http://127.0.0.1:4321 showing backend
# and frontend startup progress. Auto-redirects to the app once both are up.
# Embeddable Python's _pth disables auto-adding the script dir to sys.path,
# so we set PYTHONPATH explicitly. Harmless for regular CPython too.
$env:PYTHONPATH = $APP_DIR
$sProc = Start-Process -FilePath $PYTHON_EXE `
    -ArgumentList "status_server.py" `
    -WorkingDirectory $APP_DIR `
    -WindowStyle Hidden -PassThru
$sProc.Id | Set-Content $STATUS_PID

# Wait up to 3 s for the status server to bind, then open the browser to it
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 100
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:${STATUS_PORT}" `
            -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        break
    } catch { }
}
if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:${STATUS_PORT}"
}

# Anki's portable media archive can be large. Do this only after the status
# page is reachable so a desktop-shortcut launch never looks like a no-op.
Ensure-AnkiMediaExtracted

# -- Start backend hidden ---------------------------------------------------
if (-not $FrontendOnly) {
    "" | Set-Content $BACKEND_LOG -Encoding UTF8
    "" | Set-Content $BACKEND_ERR -Encoding UTF8

    $env:PYTHONPATH = $BACKEND_DIR
    $bProc = Start-Process -FilePath $PYTHON_EXE `
        -ArgumentList "main.py" `
        -WorkingDirectory $BACKEND_DIR `
        -RedirectStandardOutput $BACKEND_LOG `
        -RedirectStandardError $BACKEND_ERR `
        -WindowStyle Hidden -PassThru
    $bProc.Id | Set-Content $BACKEND_PID
}

# Build before `next start` if the shipped build is missing or stale. This runs
# after the status page opens, so first launch still gives immediate feedback.
if (-not $BackendOnly) {
    Invoke-FrontendBuildIfNeeded
}

# -- Start frontend hidden --------------------------------------------------
# Serves the pre-built .next output through the raw-socket MedOS boundary.
if (-not $BackendOnly) {
    "" | Set-Content $FRONTEND_LOG -Encoding UTF8
    "" | Set-Content $FRONTEND_ERR -Encoding UTF8

    function Test-MedosFrontendListening {
        $connection = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        return [bool]$connection
    }

    $env:NODE_OPTIONS = "--max-old-space-size=4096"
    $fProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c npm start > `"$FRONTEND_LOG`" 2> `"$FRONTEND_ERR`"" `
        -WorkingDirectory $APP_DIR `
        -WindowStyle Hidden -PassThru
    $fProc.Id | Set-Content $FRONTEND_PID

    # After the reaper kills the old frontend, port 3000 can briefly remain in
    # TIME_WAIT. If npm exits before binding it, retry exactly once with the
    # SAME environment, so the token stays in sync with the running backend.
    $frontendReady = $false
    $frontendExited = $false
    for ($tick = 0; $tick -lt 24; $tick++) {
        Start-Sleep -Milliseconds 500
        if (Test-MedosFrontendListening) { $frontendReady = $true; break }
        $fProc.Refresh()
        if ($fProc.HasExited) { $frontendExited = $true; break }
    }
    if (-not $frontendReady -and $frontendExited) {
        "MedOS frontend exited before listening on port 3000; retrying once." |
            Add-Content -LiteralPath $FRONTEND_ERR -Encoding UTF8
        Start-Sleep -Seconds 2
        $fProc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c npm start >> `"$FRONTEND_LOG`" 2>> `"$FRONTEND_ERR`"" `
            -WorkingDirectory $APP_DIR `
            -WindowStyle Hidden -PassThru
        $fProc.Id | Set-Content $FRONTEND_PID
        for ($tick = 0; $tick -lt 24; $tick++) {
            Start-Sleep -Milliseconds 500
            if (Test-MedosFrontendListening) { $frontendReady = $true; break }
            $fProc.Refresh()
            if ($fProc.HasExited) { break }
        }
    }
    if (-not $frontendReady) {
        $fProc.Refresh()
        if ($fProc.HasExited) {
            "MedOS frontend did not listen on port 3000. See frontend.err for the reason." |
                Add-Content -LiteralPath $FRONTEND_ERR -Encoding UTF8
        }
    }
}
# Status server watches ports 8002 + 3000 and handles browser redirect.
# No polling loop needed here.

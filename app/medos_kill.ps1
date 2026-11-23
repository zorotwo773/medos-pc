#Requires -Version 5
<#
.SYNOPSIS
    Robustly stop every MedOS process belonging to THIS install.

    Dot-source this file and call Stop-MedosProcesses. Used by both app\START.ps1
    (clean slate before launch) and STOP.ps1 (the STOP.bat target) so the two can
    never drift apart.

    Why this exists: the old pid-file + listening-port sweep missed a backend whose
    asyncio listener had died but whose process was still alive — a "zombie" holding
    ~1 GB and the socket, with a refusing port and an empty pid file. A fresh START
    then couldn't bind :8002 and the app looked dead. This reaper adds a third pass
    that matches processes by their executable / command line living under the
    install root, so such zombies are always caught. The match is scoped to $RootDir,
    so it never touches another program or a second MedOS copy elsewhere on the PC.
#>

function Stop-MedosProcesses {
    param(
        [Parameter(Mandatory = $true)] [string] $RootDir,
        [int[]] $Ports = @(8002, 3000, 4321),
        [switch] $ShowLog
    )

    # Normalised, lower-cased install root with a trailing separator so prefix /
    # substring tests can't half-match a sibling folder (e.g. D:\MedOS vs D:\MedOS2).
    $rootNorm = ((($RootDir -replace '/', '\').TrimEnd('\')) + '\').ToLowerInvariant()
    $killed = @{}

    # START.ps1 can be launched by the bundled Setup Center Python, whose executable
    # also lives below $RootDir. The zombie sweep must never reap that caller (or
    # taskkill /T would terminate Setup Center before it can finish the health
    # check). Protect this PowerShell process and its complete ancestor chain.
    $protected = @{}
    $cursor = [int]$PID
    for ($depth = 0; $depth -lt 64 -and $cursor -gt 0; $depth++) {
        if ($protected.ContainsKey($cursor)) { break }
        $protected[$cursor] = $true
        $ancestor = $null
        try {
            $ancestor = Get-CimInstance Win32_Process `
                -Filter "ProcessId=$cursor" -ErrorAction Stop
        } catch { }
        if (-not $ancestor) { break }
        $parent = [int]$ancestor.ParentProcessId
        if ($parent -le 0 -or $parent -eq $cursor) { break }
        $cursor = $parent
    }

    function _Kill([int]$ProcId) {
        if ($ProcId -le 0 -or $protected.ContainsKey($ProcId) -or $killed.ContainsKey($ProcId)) { return }
        & taskkill /F /T /PID $ProcId 2>$null | Out-Null
        $killed[$ProcId] = $true
        if ($ShowLog) { Write-Host "  stopped PID $ProcId" -ForegroundColor DarkGray }
    }

    function _MatchesInstall($proc) {
        if (-not $proc) { return $false }
        $exe = ([string]$proc.ExecutablePath).ToLowerInvariant()
        $cmd = ([string]$proc.CommandLine).ToLowerInvariant()
        if ($exe -and $exe.StartsWith($rootNorm)) { return $true }
        if ($cmd -and $cmd.Contains($rootNorm)) { return $true }
        return $false
    }

    # 1) PID files — kill the whole tree, but only if that pid is genuinely ours.
    #    A recycled pid could now belong to an unrelated program, so verify first.
    foreach ($name in @('backend.pid', 'frontend.pid', 'status.pid')) {
        $f = Join-Path $RootDir "app\$name"
        if (Test-Path $f) {
            $pidVal = ((Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int])
            if ($pidVal) {
                $p = $null
                try { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pidVal" -ErrorAction Stop } catch { }
                if ($p -and (_MatchesInstall $p)) { _Kill $pidVal }
            }
            Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
    }

    # 2) Anything LISTENING on our ports (a live server with a healthy socket).
    foreach ($port in $Ports) {
        $lines = & netstat -ano 2>$null | Select-String ":${port}\s+\S+\s+LISTENING"
        foreach ($line in $lines) {
            if ($line -match '(\d+)\s*$') { _Kill ([int]$Matches[1]) }
        }
    }

    # 3) ZOMBIE SWEEP — the case the old STOP/START missed. Any python / node
    #    (the bundled runtimes, or whatever launched our scripts) whose executable
    #    or command line lives under THIS install, whether or not its port is still
    #    bound or its pid file survived. This reaps a backend whose listener died,
    #    a leftover status server, or a stray thumbnail-pregen child. cmd.exe is
    #    intentionally NOT swept here so STOP.bat can never kill its own shell.
    try {
        $candidates = Get-CimInstance Win32_Process `
            -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='node.exe'" `
            -ErrorAction SilentlyContinue
        foreach ($p in $candidates) {
            if (_MatchesInstall $p) { _Kill ([int]$p.ProcessId) }
        }
    } catch { }

    return $killed.Count
}

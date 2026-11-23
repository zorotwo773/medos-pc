# End-to-end smoke test for MedOS-Setup.exe using a tiny fake payload.
# Creates a throwaway install under %TEMP%, checks new install, in-place
# update (content/settings preserved) and the generated uninstaller.
#
# The install goes to a temporary folder, but the bootstrapper always uses the
# real "MedOS" shortcut and registry names. A real MedOS installation on this
# machine would therefore lose its desktop shortcut and HKCU entries when the
# fake install is uninstalled. Any existing shortcut, Start Menu folder and
# registry key is snapshotted first and restored in a finally block.
$ErrorActionPreference = "Stop"
$python = 'C:\MedOS\tools\python\python.exe'
$helper = 'C:\MedOS\installer\build\make_test_bundle.py'
$work   = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp\medos-installer-test'
$install = Join-Path $work 'install'
$backup  = Join-Path $work 'user-state'
$failures = New-Object System.Collections.Generic.List[string]

$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MedOS.lnk'
$startMenu  = Join-Path ([Environment]::GetFolderPath('Programs')) 'MedOS'
$regApp     = 'HKCU:\Software\MedOS'
$regUninst  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS'
$hadDesktop = $false
$hadStartMenu = $false
$hadRegApp = $false
$hadRegUninst = $false

function Check([string]$name, [bool]$condition, [string]$detail = '') {
    if ($condition) { Write-Host ("  PASS  " + $name) -ForegroundColor Green }
    else { Write-Host ("  FAIL  " + $name + " " + $detail) -ForegroundColor Red; $failures.Add($name) }
}

function Clear-UserState {
    Remove-Item -Path $regApp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $regUninst -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $desktopLnk -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue
}

function Save-UserState {
    Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $script:hadDesktop = Test-Path -LiteralPath $desktopLnk
    if ($script:hadDesktop) {
        Copy-Item -LiteralPath $desktopLnk -Destination (Join-Path $backup 'MedOS.lnk') -Force
    }
    $script:hadStartMenu = Test-Path -LiteralPath $startMenu
    if ($script:hadStartMenu) {
        Copy-Item -LiteralPath $startMenu -Destination (Join-Path $backup 'MedOS') -Recurse -Force
    }
    $script:hadRegApp = Test-Path $regApp
    if ($script:hadRegApp) {
        & reg.exe export 'HKCU\Software\MedOS' (Join-Path $backup 'app.reg') /y | Out-Null
    }
    $script:hadRegUninst = Test-Path $regUninst
    if ($script:hadRegUninst) {
        & reg.exe export 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS' (Join-Path $backup 'uninstall.reg') /y | Out-Null
    }
    if ($script:hadDesktop -or $script:hadStartMenu -or $script:hadRegApp -or $script:hadRegUninst) {
        Write-Host "  (existing MedOS shortcut/registry found; it will be restored after the test)" -ForegroundColor DarkYellow
    }
}

function Restore-UserState {
    Clear-UserState
    if ($script:hadDesktop) {
        $saved = Join-Path $backup 'MedOS.lnk'
        if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $desktopLnk -Force }
    }
    if ($script:hadStartMenu) {
        $saved = Join-Path $backup 'MedOS'
        if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $startMenu -Recurse -Force }
    }
    if ($script:hadRegApp) { & reg.exe import (Join-Path $backup 'app.reg') | Out-Null }
    if ($script:hadRegUninst) { & reg.exe import (Join-Path $backup 'uninstall.reg') | Out-Null }
}

Save-UserState
try {
    & $python $helper $work version-one MedOS-Setup-v1.exe | Out-Null
    & $python $helper $work version-two MedOS-Setup-v2.exe | Out-Null
    Check "test bundles built" ((Test-Path "$work\MedOS-Setup-v1.exe") -and (Test-Path "$work\MedOS-Setup-v2.exe"))

    # clean slate for the fake install (the real user state is in $backup)
    Remove-Item -LiteralPath $install -Recurse -Force -ErrorAction SilentlyContinue
    Clear-UserState

    Write-Host "`n[NEW INSTALL]" -ForegroundColor Cyan
    $p1 = Start-Process -FilePath "$work\MedOS-Setup-v1.exe" -ArgumentList '/silent','/new',"/dir=$install" -Wait -PassThru
    Check "installer exit code 0" ($p1.ExitCode -eq 0) ("exit=" + $p1.ExitCode)
    Check "START.ps1 installed" (Test-Path "$install\START.ps1")
    Check "docs readme is v1" ((Get-Content "$install\docs\readme.txt" -Raw).Trim() -eq 'version-one')
    Check "data folder created" (Test-Path "$install\data")
    Check "install marker" (Test-Path "$install\.medos-install.json")
    Check "uninstaller written" (Test-Path "$install\Uninstall-MedOS.ps1")
    Check "desktop shortcut" (Test-Path $desktopLnk)
    Check "registry points at install" ((Get-ItemProperty 'HKCU:\Software\MedOS' -ErrorAction SilentlyContinue).InstallDir -eq $install)
    Check "uninstall registry entry" ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS' -ErrorAction SilentlyContinue).DisplayName -eq 'MedOS')
    Check "no staging leftovers" (-not (Get-ChildItem $work -Directory -Filter '.install.medos-*' -ErrorAction SilentlyContinue))

    Write-Host "`n[UPDATE]" -ForegroundColor Cyan
    Set-Content -LiteralPath "$install\data\keep.txt" -Value 'keep me' -Encoding ASCII
    Set-Content -LiteralPath "$install\app\.env" -Value 'MEDOS_SESSION_SECRET=abc123' -Encoding ASCII
    Set-Content -LiteralPath "$install\START.ps1" -Value '# tampered by test' -Encoding ASCII
    $p2 = Start-Process -FilePath "$work\MedOS-Setup-v2.exe" -ArgumentList '/silent','/update',"/dir=$install" -Wait -PassThru
    Check "update exit code 0" ($p2.ExitCode -eq 0) ("exit=" + $p2.ExitCode)
    Check "program files replaced (v2)" ((Get-Content "$install\docs\readme.txt" -Raw).Trim() -eq 'version-two')
    Check "tampered launcher restored" ((Get-Content "$install\START.ps1" -Raw).Trim() -eq '# MedOS test launcher')
    Check "data kept" ((Get-Content "$install\data\keep.txt" -Raw).Trim() -eq 'keep me')
    Check "app .env kept" ((Get-Content "$install\app\.env" -Raw).Trim() -eq 'MEDOS_SESSION_SECRET=abc123')
    Check "old program dir removed" (-not (Get-ChildItem $work -Directory -Filter '.install.medos-old-*' -ErrorAction SilentlyContinue))
    Check "uninstaller still present" (Test-Path "$install\Uninstall-MedOS.ps1")
    Check "marker reports update" ((Get-Content "$install\.medos-install.json" -Raw) -match '"mode":\s*"update"')

    Write-Host "`n[UNINSTALLER SCRIPT]" -ForegroundColor Cyan
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile("$install\Uninstall-MedOS.ps1", [ref]$tokens, [ref]$errors) | Out-Null
    Check "uninstaller parses" ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')

    Write-Host "`n[SETUP WITH NO PAYLOAD]" -ForegroundColor Cyan
    $bare = Join-Path $work 'MedOS-Setup-bare.exe'
    Copy-Item 'C:\MedOS\installer\build\MedOS-Setup.exe' $bare -Force
    $p3 = Start-Process -FilePath $bare -ArgumentList '/silent','/new',"/dir=$work\bare-install" -Wait -PassThru
    Check "bare installer fails cleanly" ($p3.ExitCode -ne 0)
    Check "bare install left no folder" (-not (Test-Path "$work\bare-install"))
}
finally {
    Write-Host "`n[CLEANUP]" -ForegroundColor Cyan
    Restore-UserState
    if ($hadDesktop) { Check "user desktop shortcut restored" (Test-Path -LiteralPath $desktopLnk) }
    if ($hadRegApp) { Check "user registry entry restored" ((Get-ItemProperty $regApp -ErrorAction SilentlyContinue).InstallDir -eq 'C:\MedOS') }
}

Write-Host ""
if ($failures.Count -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host ("FAILURES: " + ($failures -join ', ')) -ForegroundColor Red
exit 1

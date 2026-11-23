# Validate a real MedOS installation produced by MedOS-Setup.exe.
# Usage: powershell -File validate_install.ps1 -Dir D:\MedOS-install-check
param(
    [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = "Continue"
$failures = New-Object System.Collections.Generic.List[string]

function Check([string]$name, [bool]$condition, [string]$detail = '') {
    if ($condition) { Write-Host ("  PASS  " + $name) -ForegroundColor Green }
    else { Write-Host ("  FAIL  " + $name + " " + $detail) -ForegroundColor Red; $failures.Add($name) }
}

$python = Join-Path $Dir 'tools\python\python.exe'
$node   = Join-Path $Dir 'tools\node\node.exe'

Write-Host "[FILES]" -ForegroundColor Cyan
Check "install folder exists" (Test-Path -LiteralPath $Dir)
Check "START.ps1" (Test-Path -LiteralPath (Join-Path $Dir 'START.ps1'))
Check "launch.vbs" (Test-Path -LiteralPath (Join-Path $Dir 'launch.vbs'))
Check "app/START.ps1" (Test-Path -LiteralPath (Join-Path $Dir 'app\START.ps1'))
Check "app/medos_server.mjs" (Test-Path -LiteralPath (Join-Path $Dir 'app\medos_server.mjs'))
Check "backend main.py" (Test-Path -LiteralPath (Join-Path $Dir 'app\backend\main.py'))
Check "bundled python" (Test-Path -LiteralPath $python)
Check "bundled node" (Test-Path -LiteralPath $node)
Check "medos.ico" (Test-Path -LiteralPath (Join-Path $Dir 'medos.ico'))
Check "install marker" (Test-Path -LiteralPath (Join-Path $Dir '.medos-install.json'))
Check "uninstaller" (Test-Path -LiteralPath (Join-Path $Dir 'Uninstall-MedOS.ps1'))
Check "data folder" (Test-Path -LiteralPath (Join-Path $Dir 'data'))
Check "no .env shipped" (-not (Test-Path -LiteralPath (Join-Path $Dir 'app\.env')))
Check "no personal content shipped" (-not (Test-Path -LiteralPath (Join-Path $Dir 'data\books')))

Write-Host "`n[BUILD ID]" -ForegroundColor Cyan
$buildId = ''
$shipped = ''
if (Test-Path -LiteralPath (Join-Path $Dir 'app\.next\BUILD_ID')) {
    $buildId = (Get-Content -LiteralPath (Join-Path $Dir 'app\.next\BUILD_ID') -Raw).Trim()
}
if (Test-Path -LiteralPath (Join-Path $Dir 'app\.next\.medos-shipped')) {
    $shipped = (Get-Content -LiteralPath (Join-Path $Dir 'app\.next\.medos-shipped') -Raw).Trim()
}
Check "BUILD_ID present" ($buildId.Length -gt 0)
Check "BUILD_ID matches .medos-shipped" ($buildId -eq $shipped) ("build=$buildId shipped=$shipped")

Write-Host "`n[NEXT BUILD PATH]" -ForegroundColor Cyan
$rsf = Join-Path $Dir 'app\.next\required-server-files.json'
if (Test-Path -LiteralPath $rsf) {
    $raw = Get-Content -LiteralPath $rsf -Raw
    $expected = (Join-Path $Dir 'app')
    Check "outputFileTracingRoot points here" ($raw.Contains($expected.Replace('\', '\\'))) ("expected " + $expected)
    Check "outputFileTracingRoot has no C:\MedOS" (-not ($raw -match '"outputFileTracingRoot"\s*:\s*"C:\\\\MedOS'))
} else {
    Check "required-server-files.json" $false $rsf
}

Write-Host "`n[PDFJS]" -ForegroundColor Cyan
$pdfjs = Join-Path $Dir 'app\.next\node_modules\pdfjs-dist'
if (Test-Path -LiteralPath $pdfjs) {
    $item = Get-Item -LiteralPath $pdfjs -Force
    Check "pdfjs-dist is a real folder" (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) ("attrs=" + $item.Attributes)
    Check "pdfjs-dist has content" ((Get-ChildItem -LiteralPath $pdfjs -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
} else {
    Write-Host "  SKIP  no pdfjs-dist folder in this build" -ForegroundColor Yellow
}

Write-Host "`n[PYTHON]" -ForegroundColor Cyan
if (Test-Path -LiteralPath $python) {
    $out = & $python -c "import fastapi, faiss, fitz, numpy; print('ok')" 2>&1
    Check "python imports fastapi/faiss/fitz/numpy" (($out -join ' ').Trim() -eq 'ok') (($out | Select-Object -First 3) -join ' | ')
    $ver = & $python -c "import sys; print(sys.version.split()[0])" 2>&1
    Check "python version" ($ver -match '^3\.') ("version=$($ver -join ' ')")
} else {
    Check "python present" $false $python
}

Write-Host "`n[BACKEND]" -ForegroundColor Cyan
if (Test-Path -LiteralPath $python) {
    $backend = Join-Path $Dir 'app\backend'
    $out = & $python -c "import sys; sys.path.insert(0, r'$backend'); import config; print(config.ROOT)" 2>&1
    Check "backend config resolves ROOT" ($LASTEXITCODE -eq 0 -and (($out -join '') -match [regex]::Escape($Dir))) (($out | Select-Object -First 3) -join ' | ')
    $out2 = & $python -c "import sys; sys.path.insert(0, r'$backend'); import pack_paths; print(len(pack_paths.build_sync_tree(r'$Dir')))" 2>&1
    Check "pack_paths builds a sync tree from a string path" ($LASTEXITCODE -eq 0) (($out2 | Select-Object -First 4) -join ' | ')
} else {
    Check "python for backend checks" $false $python
}

Write-Host "`n[NODE]" -ForegroundColor Cyan
if (Test-Path -LiteralPath $node) {
    $ver = & $node -v 2>&1
    Check "node runs" ($ver -match '^v\d+\.') ("version=$($ver -join ' ')")
    $ok = & $node -e "require('fs').accessSync(process.argv[1]); console.log('ok')" (Join-Path $Dir 'app\medos_server.mjs') 2>&1
    Check "node sees the server entry point" (($ok -join ' ').Trim() -eq 'ok') (($ok | Select-Object -First 3) -join ' | ')
} else {
    Check "node present" $false $node
}

Write-Host "`n[REGISTRY + SHORTCUTS]" -ForegroundColor Cyan
$reg = Get-ItemProperty 'HKCU:\Software\MedOS' -ErrorAction SilentlyContinue
Check "registry InstallDir" ($reg.InstallDir -eq $Dir) ("found=" + $reg.InstallDir)
Check "desktop shortcut" (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MedOS.lnk'))
Check "start menu entry" (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'MedOS\MedOS.lnk'))

Write-Host "`n[LEFTOVERS]" -ForegroundColor Cyan
Check "no staging leftovers" (-not (Get-ChildItem (Split-Path -Parent $Dir) -Directory -Force -Filter '.MedOS-install-check.medos-*' -ErrorAction SilentlyContinue))

Write-Host ""
if ($failures.Count -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host ("FAILURES: " + ($failures -join ', ')) -ForegroundColor Red
exit 1

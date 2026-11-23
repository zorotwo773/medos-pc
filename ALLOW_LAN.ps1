#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Silent)

$ErrorActionPreference = "Stop"

function Get-MedOSTrustedWindowsDirectory {
    [CmdletBinding()]
    param()

    if (-not ("MedOS.NetworkAccess.NativeMethods" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace MedOS.NetworkAccess {
    public static class NativeMethods {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetWindowsDirectory(StringBuilder buffer, uint size);
    }
}
"@
    }
    $buffer = [System.Text.StringBuilder]::new(32768)
    $length = [MedOS.NetworkAccess.NativeMethods]::GetWindowsDirectory(
        $buffer, [uint32]$buffer.Capacity
    )
    if ($length -eq 0 -or $length -ge $buffer.Capacity) {
        throw "MedOS trusted Windows directory is unavailable."
    }
    $result = [System.IO.Path]::GetFullPath($buffer.ToString())
    if (-not [System.IO.Path]::IsPathRooted($result)) {
        throw "MedOS trusted Windows directory is unavailable."
    }
    return $result
}

$helper = Join-Path $PSScriptRoot "app\Set-MedOSNetworkAccess.ps1"
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    [Console]::Error.WriteLine("MedOS network access helper is missing.")
    exit 1
}

$windowsDirectory = Get-MedOSTrustedWindowsDirectory
$powershell = [System.IO.Path]::GetFullPath((Join-Path $windowsDirectory "System32\WindowsPowerShell\v1.0\powershell.exe"))
if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) {
    [Console]::Error.WriteLine("Canonical Windows PowerShell is missing.")
    exit 1
}

& $powershell `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -File $helper `
    -Mode private
$helperExit = $LASTEXITCODE
if ($helperExit -ne 0) { exit $helperExit }

if (-not $Silent) {
    Write-Host "MedOS network access is restricted to private networks." -ForegroundColor Green
    Read-Host "Press Enter to close"
}
exit 0

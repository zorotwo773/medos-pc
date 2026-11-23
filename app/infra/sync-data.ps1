<#
.SYNOPSIS
  Sync MedOS data tree (~20 GB) from this PC to the Oracle Cloud VM.

.DESCRIPTION
  Wraps rsync-over-ssh with sensible defaults for MedOS:
    * Incremental + resumable (rsync's whole point).
    * Excludes sqlite WAL/SHM/journal files so the VM sees committed snapshots.
    * Anki collection lives outside D:\MedOS\data — copied separately into
      <DataRoot>\anki\collection.anki2 on the VM.
    * Books, faiss vectorstore, encrypted reference stores, glossary all flow
      through the same rsync command since they're under D:\MedOS\data.

  Requires:
    * `rsync` on PATH. Git for Windows ships it at
      C:\Program Files\Git\usr\bin\rsync.exe — add that dir to PATH if needed.
    * `ssh` on PATH (Windows 10/11 includes OpenSSH client out of the box).
    * SSH key configured for the VM (the public key uploaded to OCI during VM
      provisioning; the private key on this PC).

.PARAMETER VmHost
  Tailscale MagicDNS name OR public IP of the VM. Examples:
    medos-vm.tail-scale.ts.net
    132.226.45.12

.PARAMETER VmUser
  SSH user on the VM. Oracle Ubuntu default is "ubuntu".

.PARAMETER SshKey
  Path to the private key file. Defaults to ~/.ssh/id_ed25519.

.PARAMETER DataRoot
  Local data root on this PC. Defaults to D:\MedOS\data.

.PARAMETER RemoteDataRoot
  Target path on the VM. Defaults to /data (matches docker-compose bind-mount).

.PARAMETER AnkiCollection
  Path to the Anki collection file on this PC. Defaults to the Windows
  default location for Anki desktop.

.PARAMETER DryRun
  Show what would be transferred without actually copying anything.

.PARAMETER AnkiOnly
  Skip the big data tree, only sync the Anki collection. Useful for a quick
  progress refresh between full syncs.

.EXAMPLE
  # First full sync (will take hours on residential upload)
  .\sync-data.ps1 -VmHost medos-vm.tail-scale.ts.net

.EXAMPLE
  # Quick anki-only refresh
  .\sync-data.ps1 -VmHost medos-vm.tail-scale.ts.net -AnkiOnly

.EXAMPLE
  # Dry-run to see what would change
  .\sync-data.ps1 -VmHost medos-vm.tail-scale.ts.net -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VmHost,

    [string]$VmUser = "ubuntu",

    [string]$SshKey = (Join-Path $HOME ".ssh/id_ed25519"),

    [string]$DataRoot = $(if ($env:MEDOS_DATA_ROOT) { $env:MEDOS_DATA_ROOT } else { Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "data" }),

    [string]$RemoteDataRoot = "/data",

    [string]$AnkiCollection = (Join-Path $env:APPDATA "Anki2\User 1\collection.anki2"),

    [switch]$DryRun,

    [switch]$AnkiOnly
)

$ErrorActionPreference = "Stop"

function Assert-Tool {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Required tool '$Name' is not on PATH. Install Git for Windows (ships rsync) or add OpenSSH to PATH."
    }
}

Assert-Tool rsync
Assert-Tool ssh

# Build a single ssh command with key + the usual non-interactive flags.
# rsync's -e flag takes a string, so any spaces in the key path need quoting.
$sshCmd = "ssh -i `"$SshKey`" -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# Convert Windows paths to the cygwin-style paths rsync expects on Windows.
function ConvertTo-CygPath {
    param([string]$Path)
    if ($Path -match "^([A-Za-z]):\\(.*)$") {
        $drive = $matches[1].ToLower()
        $rest  = $matches[2] -replace "\\", "/"
        return "/$drive/$rest"
    }
    return ($Path -replace "\\", "/")
}

$dataSrcCyg = ConvertTo-CygPath $DataRoot
# Trailing slash so rsync syncs *contents* of data/ into /data, not /data/data
$dataSrcCyg = ($dataSrcCyg.TrimEnd("/")) + "/"

$dryFlag = if ($DryRun) { "--dry-run" } else { "" }

Write-Host "─── MedOS data sync ───" -ForegroundColor Cyan
Write-Host "  Target : $VmUser@$VmHost`:$RemoteDataRoot/"
Write-Host "  Key    : $SshKey"
if ($DryRun) { Write-Host "  Mode   : DRY RUN (no files copied)" -ForegroundColor Yellow }

# ─── Anki collection (small, do first so a slow main sync doesn't block) ───
if (Test-Path $AnkiCollection) {
    Write-Host ""
    Write-Host "→ Anki collection.anki2"
    $ankiCyg = ConvertTo-CygPath $AnkiCollection
    # rsync to the target subdir; the parent /data/anki must exist (we create it
    # via ssh first because rsync won't create deep parents itself).
    & ssh -i $SshKey -o BatchMode=yes -o StrictHostKeyChecking=accept-new `
        "$VmUser@$VmHost" "mkdir -p $RemoteDataRoot/anki && sudo chown -R `${USER}:`${USER} $RemoteDataRoot/anki" | Out-Null
    & rsync -avh --partial --info=progress2 $dryFlag `
        -e $sshCmd `
        "$ankiCyg" "$VmUser@$VmHost`:$RemoteDataRoot/anki/collection.anki2"
    if ($LASTEXITCODE -ne 0) { throw "Anki rsync failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "  (skipping Anki — '$AnkiCollection' not found)" -ForegroundColor DarkGray
}

if ($AnkiOnly) {
    Write-Host ""
    Write-Host "✓ Anki sync complete (AnkiOnly mode)." -ForegroundColor Green
    return
}

# ─── Main data tree ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "→ D:\MedOS\data → ${VmHost}:${RemoteDataRoot}/  (~20 GB on first run, incremental after)"

# Exclusions:
#   *.wal / *.shm / *.tmp  → sqlite transients, don't ship mid-write
#   _thumbs/               → regenerable on the VM, drop the bandwidth
#   anki_progress.sqlite*  → per-user state, owned by the VM after deploy
#                            (uncomment if you want to seed it)
$rsyncArgs = @(
    "-avh",
    "--partial",
    "--info=progress2",
    "--human-readable",
    "--exclude=*.wal",
    "--exclude=*.shm",
    "--exclude=*.journal",
    "--exclude=*.tmp",
    "--exclude=_thumbs/",
    "--exclude=__pycache__/",
    "-e", $sshCmd
)
if ($DryRun) { $rsyncArgs += "--dry-run" }
$rsyncArgs += @($dataSrcCyg, "$VmUser@$VmHost`:$RemoteDataRoot/")

& rsync @rsyncArgs
if ($LASTEXITCODE -ne 0) { throw "Main data rsync failed (exit $LASTEXITCODE)" }

# ─── Fix ownership on the VM so the container user can read everything ───
if (-not $DryRun) {
    Write-Host ""
    Write-Host "→ chown -R 1000:1000 on the VM (so container user 'medos' can read)"
    & ssh -i $SshKey -o BatchMode=yes -o StrictHostKeyChecking=accept-new `
        "$VmUser@$VmHost" "sudo chown -R 1000:1000 $RemoteDataRoot"
}

Write-Host ""
Write-Host "✓ Sync complete." -ForegroundColor Green

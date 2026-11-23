#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = "Set")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Set")]
    [ValidateSet("private", "public")]
    [string]$Mode,

    [Parameter(Mandatory = $true, ParameterSetName = "Read")]
    [switch]$ReadEffective
)

$ErrorActionPreference = "Stop"

function Test-MedOSEarlyLocalControlPath {
    [CmdletBinding()]
    param(
        [string]$Path,
        [switch]$OperationDirectory
    )

    if (
        -not $Path -or
        $Path -notmatch '^[A-Za-z]:\\(?:[^\\/:*?"<>|\x00-\x1F]+\\)*[^\\/:*?"<>|\x00-\x1F]+$'
    ) { return $false }
    try { $canonical = [IO.Path]::GetFullPath($Path) }
    catch { return $false }
    if (
        $canonical -notmatch '^[A-Za-z]:\\(?:[^\\/:*?"<>|\x00-\x1F]+\\)*[^\\/:*?"<>|\x00-\x1F]+$' -or
        -not [StringComparer]::Ordinal.Equals($canonical, $Path)
    ) { return $false }
    foreach ($component in $canonical.Substring(3).Split('\')) {
        if (
            $component -match '[. ]$' -or
            $component -match '^(?i:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:\.|$)'
        ) { return $false }
    }
    if (
        $OperationDirectory -and
        [IO.Path]::GetFileName($canonical) -notmatch '^operation-[a-f0-9]{32}$'
    ) { return $false }
    return $true
}

$earlyWorkerDirectory = $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY
$earlyWorkerToken = $env:MEDOS_NETWORK_TRANSACTION_WORKER
$earlyWorkerControlsPresent = [bool]($earlyWorkerDirectory -or $earlyWorkerToken)
if (
    $earlyWorkerControlsPresent -and (
        -not $earlyWorkerDirectory -or
        $earlyWorkerToken -notmatch '^[a-f0-9]{32}$' -or
        -not (Test-MedOSEarlyLocalControlPath `
            -Path $earlyWorkerDirectory -OperationDirectory)
    )
) {
    [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:invalid_worker_environment")
    exit 12
}

$earlyOuterDirectory = $env:MEDOS_NETWORK_OPERATION_DIRECTORY
$earlyOuterToken = $env:MEDOS_NETWORK_OPERATION_TOKEN
$earlyOuterControlsPresent = [bool]($earlyOuterDirectory -or $earlyOuterToken)
if (
    $earlyOuterControlsPresent -and (
        -not $earlyOuterDirectory -or
        $earlyOuterToken -notmatch '^[a-f0-9]{64}$' -or
        -not (Test-MedOSEarlyLocalControlPath `
            -Path $earlyOuterDirectory -OperationDirectory)
    )
) {
    [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:invalid_operation_environment")
    exit 12
}

function Initialize-MedOSLocalTempEnvironment {
    [CmdletBinding()]
    param()

    $localAppData = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::LocalApplicationData,
        [Environment+SpecialFolderOption]::DoNotVerify
    )
    if (-not (Test-MedOSEarlyLocalControlPath -Path $localAppData)) {
        throw "MEDOS_NETWORK_ERROR:trusted_local_temp"
    }
    $localAppData = [IO.Path]::GetFullPath($localAppData)
    $chain = [Collections.Generic.List[IO.DirectoryInfo]]::new()
    $current = [IO.DirectoryInfo]::new($localAppData)
    while ($current) {
        $chain.Add($current)
        $current = $current.Parent
    }
    for ($index = $chain.Count - 1; $index -ge 0; $index--) {
        $directory = $chain[$index]
        $directory.Refresh()
        if (-not $directory.Exists -or (
            $directory.Attributes -band [IO.FileAttributes]::ReparsePoint
        )) { throw "MEDOS_NETWORK_ERROR:trusted_local_temp" }
    }

    $safeTemp = $localAppData
    foreach ($component in @("MedOS", "Temp")) {
        $safeTemp = Join-Path $safeTemp $component
        if (-not [IO.Directory]::Exists($safeTemp)) {
            [IO.Directory]::CreateDirectory($safeTemp) | Out-Null
        }
        $directory = [IO.DirectoryInfo]::new($safeTemp)
        $directory.Refresh()
        if (-not $directory.Exists -or (
            $directory.Attributes -band [IO.FileAttributes]::ReparsePoint
        )) { throw "MEDOS_NETWORK_ERROR:trusted_local_temp" }
    }
    $env:TEMP = $safeTemp
    $env:TMP = $safeTemp
    $env:TMPDIR = $safeTemp
}

try { Initialize-MedOSLocalTempEnvironment }
catch {
    [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:trusted_local_temp")
    exit 12
}

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
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHGetFolderPath(
            IntPtr owner, int folder, IntPtr token, uint flags, StringBuilder path);
    }
}
"@
    }
    $buffer = [System.Text.StringBuilder]::new(32768)
    $length = [MedOS.NetworkAccess.NativeMethods]::GetWindowsDirectory(
        $buffer, [uint32]$buffer.Capacity
    )
    if ($length -eq 0 -or $length -ge $buffer.Capacity) {
        throw "MEDOS_NETWORK_ERROR:trusted_windows_directory"
    }
    $result = [System.IO.Path]::GetFullPath($buffer.ToString())
    if (-not [System.IO.Path]::IsPathRooted($result)) {
        throw "MEDOS_NETWORK_ERROR:trusted_windows_directory"
    }
    return $result
}

function Get-MedOSTrustedProgramData {
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
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHGetFolderPath(
            IntPtr owner, int folder, IntPtr token, uint flags, StringBuilder path);
    }
}
"@
    }
    $buffer = [System.Text.StringBuilder]::new(32768)
    # CSIDL_COMMON_APPDATA is resolved by the shell API, not ProgramData or TEMP.
    $result = [MedOS.NetworkAccess.NativeMethods]::SHGetFolderPath(
        [IntPtr]::Zero, 0x23, [IntPtr]::Zero, 0, $buffer
    )
    if ($result -ne 0 -or $buffer.Length -eq 0) {
        throw "MEDOS_NETWORK_ERROR:trusted_program_data"
    }
    $path = [System.IO.Path]::GetFullPath($buffer.ToString()).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (-not [System.IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\')) {
        throw "MEDOS_NETWORK_ERROR:trusted_program_data"
    }
    return $path
}

function Get-MedOSTrustedLocalAppData {
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
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHGetFolderPath(
            IntPtr owner, int folder, IntPtr token, uint flags, StringBuilder path);
    }
}
"@
    }
    $buffer = [System.Text.StringBuilder]::new(32768)
    # CSIDL_LOCAL_APPDATA is resolved by the shell API, not LOCALAPPDATA/TEMP/TMP.
    $result = [MedOS.NetworkAccess.NativeMethods]::SHGetFolderPath(
        [IntPtr]::Zero, 0x1C, [IntPtr]::Zero, 0, $buffer
    )
    if ($result -ne 0 -or $buffer.Length -eq 0) {
        throw "MEDOS_NETWORK_ERROR:trusted_local_app_data"
    }
    $path = [System.IO.Path]::GetFullPath($buffer.ToString()).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (-not [System.IO.Path]::IsPathRooted($path) -or $path.StartsWith('\\')) {
        throw "MEDOS_NETWORK_ERROR:trusted_local_app_data"
    }
    return $path
}

$script:MedOSScriptPath = $PSCommandPath
$script:MedOSWindowsDirectory = Get-MedOSTrustedWindowsDirectory
$script:MedOSPowerShellPath = [System.IO.Path]::GetFullPath(
    (Join-Path $script:MedOSWindowsDirectory "System32\WindowsPowerShell\v1.0\powershell.exe")
)
if (
    -not [System.IO.Path]::IsPathRooted($script:MedOSPowerShellPath) -or
    -not (Test-Path -LiteralPath $script:MedOSPowerShellPath -PathType Leaf)
) {
    [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:canonical_powershell_missing")
    exit 1
}

function Invoke-MedOSFirewallMutex {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock
    )

    $mutex = [System.Threading.Mutex]::new($false, "Global\MedOS.NetworkAccess.v1")
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne(30000)
        }
        catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
            [Console]::Error.WriteLine("MEDOS_NETWORK_WARNING:abandoned_mutex")
        }
        if (-not $acquired) {
            throw "MEDOS_NETWORK_ERROR:mutex_timeout"
        }
        return & $ScriptBlock
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Get-MedOSRuleSpecifications {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("private", "public")]
        [string]$Mode
    )

    $profile = if ($Mode -eq "public") { "Any" } else { "Private,Domain" }
    foreach ($entry in @(
        @("MedOS Frontend (3000)", 3000, "TCP"),
        @("MedOS Backend (8002)", 8002, "TCP"),
        @("MedOS Status (4321)", 4321, "TCP"),
        @("MedOS LAN Sync (48653)", 48653, "UDP")
    )) {
        [pscustomobject][ordered]@{
            DisplayName = $entry[0]
            LocalPort = [int]$entry[1]
            Direction = "Inbound"
            Action = "Allow"
            Protocol = $entry[2]
            Enabled = "True"
            Profile = $profile
            RemotePort = "Any"
            LocalAddress = "Any"
            RemoteAddress = "LocalSubnet"
            Program = "Any"
            Service = "Any"
            InterfaceType = "Any"
            InterfaceAlias = "Any"
            EdgeTraversalPolicy = "Block"
            LooseSourceMapping = "False"
            LocalOnlyMapping = "False"
            Authentication = "NotRequired"
            Encryption = "NotRequired"
            LocalUser = "Any"
            RemoteUser = "Any"
            RemoteMachine = "Any"
            OverrideBlockRules = "False"
        }
    }
}

function Test-MedOSFirewallRule {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Rule,
        [Parameter(Mandatory = $true)]$Specification
    )

    try {
        $portFilters = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $addressFilters = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $applicationFilters = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $serviceFilters = @(Get-NetFirewallServiceFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $interfaceTypeFilters = @(Get-NetFirewallInterfaceTypeFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $interfaceFilters = @(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        $securityFilters = @(Get-NetFirewallSecurityFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop)
        if (
            $portFilters.Count -ne 1 -or
            $addressFilters.Count -ne 1 -or
            $applicationFilters.Count -ne 1 -or
            $serviceFilters.Count -ne 1 -or
            $interfaceTypeFilters.Count -ne 1 -or
            $interfaceFilters.Count -ne 1 -or
            $securityFilters.Count -ne 1
        ) { return $false }

        $actualProfiles = @([string]$Rule.Profile -split "," | ForEach-Object { $_.Trim() } | Sort-Object)
        $expectedProfiles = @([string]$Specification.Profile -split "," | ForEach-Object { $_.Trim() } | Sort-Object)
        $looseSourceMapping = if ($null -eq $Rule.LooseSourceMapping -or [string]$Rule.LooseSourceMapping -eq "") { "False" } else { [string]$Rule.LooseSourceMapping }
        $localOnlyMapping = if ($null -eq $Rule.LocalOnlyMapping -or [string]$Rule.LocalOnlyMapping -eq "") { "False" } else { [string]$Rule.LocalOnlyMapping }
        return (
            [string]$Rule.Direction -eq [string]$Specification.Direction -and
            [string]$Rule.Action -eq [string]$Specification.Action -and
            [string]$Rule.Enabled -eq [string]$Specification.Enabled -and
            ($actualProfiles -join ",") -eq ($expectedProfiles -join ",") -and
            [string]$interfaceTypeFilters[0].InterfaceType -eq [string]$Specification.InterfaceType -and
            [string]$interfaceFilters[0].InterfaceAlias -eq [string]$Specification.InterfaceAlias -and
            [string]$Rule.EdgeTraversalPolicy -eq [string]$Specification.EdgeTraversalPolicy -and
            $looseSourceMapping -eq [string]$Specification.LooseSourceMapping -and
            $localOnlyMapping -eq [string]$Specification.LocalOnlyMapping -and
            [string]$portFilters[0].Protocol -eq [string]$Specification.Protocol -and
            [string]$portFilters[0].LocalPort -eq [string]$Specification.LocalPort -and
            [string]$portFilters[0].RemotePort -eq [string]$Specification.RemotePort -and
            [string]$addressFilters[0].LocalAddress -eq [string]$Specification.LocalAddress -and
            [string]$addressFilters[0].RemoteAddress -eq [string]$Specification.RemoteAddress -and
            [string]$applicationFilters[0].Program -eq [string]$Specification.Program -and
            [string]$serviceFilters[0].Service -eq [string]$Specification.Service -and
            [string]$securityFilters[0].Authentication -eq [string]$Specification.Authentication -and
            [string]$securityFilters[0].Encryption -eq [string]$Specification.Encryption -and
            [string]$securityFilters[0].LocalUser -eq [string]$Specification.LocalUser -and
            [string]$securityFilters[0].RemoteUser -eq [string]$Specification.RemoteUser -and
            [string]$securityFilters[0].RemoteMachine -eq [string]$Specification.RemoteMachine -and
            [string]$securityFilters[0].OverrideBlockRules -eq [string]$Specification.OverrideBlockRules
        )
    }
    catch {
        return $false
    }
}

function Get-MedOSFirewallSnapshot {
    [CmdletBinding()]
    param()

    $snapshot = @()
    foreach ($displayName in @(
        "MedOS Frontend (3000)",
        "MedOS Backend (8002)",
        "MedOS Status (4321)",
        "MedOS LAN Sync (48653)"
    )) {
        foreach ($rule in @(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue)) {
            $port = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            $address = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            $application = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            $service = @(Get-NetFirewallServiceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            $interfaceType = @(Get-NetFirewallInterfaceTypeFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            $interface = @(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            $security = @(Get-NetFirewallSecurityFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop)
            if (
                $port.Count -ne 1 -or $address.Count -ne 1 -or
                $application.Count -ne 1 -or $service.Count -ne 1 -or
                $interfaceType.Count -ne 1 -or $interface.Count -ne 1 -or
                $security.Count -ne 1
            ) {
                throw "MEDOS_NETWORK_ERROR:snapshot_filter_count"
            }
            $snapshot += [pscustomobject][ordered]@{
                Name = [string]$rule.Name
                DisplayName = [string]$rule.DisplayName
                Description = [string]$rule.Description
                Group = [string]$rule.Group
                Direction = [string]$rule.Direction
                Action = [string]$rule.Action
                Enabled = [string]$rule.Enabled
                Profile = [string]$rule.Profile
                InterfaceType = [string]$interfaceType[0].InterfaceType
                InterfaceAlias = [string]$interface[0].InterfaceAlias
                EdgeTraversalPolicy = [string]$rule.EdgeTraversalPolicy
                LooseSourceMapping = if ($null -eq $rule.LooseSourceMapping -or [string]$rule.LooseSourceMapping -eq "") { "False" } else { [string]$rule.LooseSourceMapping }
                LocalOnlyMapping = if ($null -eq $rule.LocalOnlyMapping -or [string]$rule.LocalOnlyMapping -eq "") { "False" } else { [string]$rule.LocalOnlyMapping }
                Protocol = [string]$port[0].Protocol
                LocalPort = [string]$port[0].LocalPort
                RemotePort = [string]$port[0].RemotePort
                LocalAddress = [string]$address[0].LocalAddress
                RemoteAddress = [string]$address[0].RemoteAddress
                Program = [string]$application[0].Program
                Service = [string]$service[0].Service
                Authentication = [string]$security[0].Authentication
                Encryption = [string]$security[0].Encryption
                LocalUser = [string]$security[0].LocalUser
                RemoteUser = [string]$security[0].RemoteUser
                RemoteMachine = [string]$security[0].RemoteMachine
                OverrideBlockRules = [string]$security[0].OverrideBlockRules
            }
        }
    }
    return @($snapshot | Sort-Object Name)
}

function Repair-MedOSFirewallRules {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("private", "public")]
        [string]$Mode
    )

    foreach ($specification in @(Get-MedOSRuleSpecifications -Mode $Mode)) {
        if ($env:MEDOS_NETWORK_OPERATION_DIRECTORY -and (
            Test-MedOSOperationMarker -Name "cancel"
        )) { throw "MEDOS_NETWORK_ERROR:cancelled" }

        $existing = @(
            Get-NetFirewallRule -DisplayName $specification.DisplayName -ErrorAction SilentlyContinue
        )
        $isCorrect = $existing.Count -eq 1 -and (
            Test-MedOSFirewallRule -Rule $existing[0] -Specification $specification
        )
        if ($isCorrect) { continue }

        foreach ($rule in $existing) {
            Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop
        }
        if ($env:MEDOS_NETWORK_OPERATION_DIRECTORY -and (
            Test-MedOSOperationMarker -Name "cancel"
        )) { throw "MEDOS_NETWORK_ERROR:cancelled" }
        New-NetFirewallRule `
            -DisplayName $specification.DisplayName `
            -Direction $specification.Direction `
            -Action $specification.Action `
            -Protocol $specification.Protocol `
            -LocalPort $specification.LocalPort `
            -RemotePort $specification.RemotePort `
            -LocalAddress $specification.LocalAddress `
            -RemoteAddress $specification.RemoteAddress `
            -Program $specification.Program `
            -Service $specification.Service `
            -InterfaceType $specification.InterfaceType `
            -InterfaceAlias $specification.InterfaceAlias `
            -EdgeTraversalPolicy $specification.EdgeTraversalPolicy `
            -Authentication $specification.Authentication `
            -Encryption $specification.Encryption `
            -LocalUser $specification.LocalUser `
            -RemoteUser $specification.RemoteUser `
            -RemoteMachine $specification.RemoteMachine `
            -Profile $specification.Profile `
            -Enabled True `
            -ErrorAction Stop | Out-Null
    }
}

function Get-MedOSEffectivePolicy {
    [CmdletBinding()]
    param()

    try {
        $modes = @()
        $privateSpecs = @(Get-MedOSRuleSpecifications -Mode private)
        $publicSpecs = @(Get-MedOSRuleSpecifications -Mode public)
        for ($index = 0; $index -lt $privateSpecs.Count; $index++) {
            $existing = @(
                Get-NetFirewallRule -DisplayName $privateSpecs[$index].DisplayName -ErrorAction SilentlyContinue
            )
            if ($existing.Count -ne 1) {
                return [pscustomobject][ordered]@{ Status = "invalid"; AllowPublic = $false }
            }
            if (Test-MedOSFirewallRule -Rule $existing[0] -Specification $privateSpecs[$index]) {
                $modes += "private"
            }
            elseif (Test-MedOSFirewallRule -Rule $existing[0] -Specification $publicSpecs[$index]) {
                $modes += "public"
            }
            else {
                return [pscustomobject][ordered]@{ Status = "invalid"; AllowPublic = $false }
            }
        }
        if (@($modes | Where-Object { $_ -eq "private" }).Count -eq $privateSpecs.Count) {
            return [pscustomobject][ordered]@{ Status = "private"; AllowPublic = $false }
        }
        if (@($modes | Where-Object { $_ -eq "public" }).Count -eq $privateSpecs.Count) {
            return [pscustomobject][ordered]@{ Status = "public"; AllowPublic = $true }
        }
        return [pscustomobject][ordered]@{ Status = "mixed"; AllowPublic = $false }
    }
    catch {
        return [pscustomobject][ordered]@{ Status = "invalid"; AllowPublic = $false }
    }
}

function Restore-MedOSFirewallSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot)

    foreach ($displayName in @(
        "MedOS Frontend (3000)",
        "MedOS Backend (8002)",
        "MedOS Status (4321)",
        "MedOS LAN Sync (48653)"
    )) {
        foreach ($rule in @(Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue)) {
            Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop
        }
    }
    foreach ($rule in @($Snapshot)) {
        $parameters = @{
            Name = $rule.Name
            DisplayName = $rule.DisplayName
            Direction = $rule.Direction
            Action = $rule.Action
            Enabled = $rule.Enabled
            Profile = $rule.Profile
            InterfaceType = $rule.InterfaceType
            InterfaceAlias = $rule.InterfaceAlias
            EdgeTraversalPolicy = $rule.EdgeTraversalPolicy
            Protocol = $rule.Protocol
            LocalPort = $rule.LocalPort
            RemotePort = $rule.RemotePort
            LocalAddress = $rule.LocalAddress
            RemoteAddress = $rule.RemoteAddress
            Program = $rule.Program
            Service = $rule.Service
            Authentication = $rule.Authentication
            Encryption = $rule.Encryption
            LocalUser = $rule.LocalUser
            RemoteUser = $rule.RemoteUser
            RemoteMachine = $rule.RemoteMachine
            ErrorAction = "Stop"
        }
        if ([string]$rule.Description) { $parameters.Description = $rule.Description }
        if ([string]$rule.Group) { $parameters.Group = $rule.Group }
        if ([string]$rule.LooseSourceMapping -eq "True") { $parameters.LooseSourceMapping = $true }
        if ([string]$rule.LocalOnlyMapping -eq "True") { $parameters.LocalOnlyMapping = $true }
        if ([string]$rule.OverrideBlockRules -eq "True") { $parameters.OverrideBlockRules = $true }
        New-NetFirewallRule @parameters | Out-Null
    }
}

function Test-MedOSFirewallSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Snapshot)

    try {
        $expected = @($Snapshot | Sort-Object Name) | ConvertTo-Json -Depth 6 -Compress
        $actual = @(Get-MedOSFirewallSnapshot) | ConvertTo-Json -Depth 6 -Compress
        return $expected -ceq $actual
    }
    catch {
        return $false
    }
}

function Invoke-MedOSFirewallTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("private", "public")]
        [string]$Mode
    )

    $snapshot = @(Get-MedOSFirewallSnapshot)
    try {
        Repair-MedOSFirewallRules -Mode $Mode
        if ($env:MEDOS_NETWORK_OPERATION_DIRECTORY -and (
            Test-MedOSOperationMarker -Name "cancel"
        )) { throw "MEDOS_NETWORK_ERROR:cancelled" }
        $effective = Get-MedOSEffectivePolicy
        if ($effective.Status -ne $Mode) {
            throw "MEDOS_NETWORK_ERROR:verification_mismatch"
        }
        return $effective
    }
    catch {
        try {
            Restore-MedOSFirewallSnapshot -Snapshot $snapshot
            if (-not (Test-MedOSFirewallSnapshot -Snapshot $snapshot)) {
                throw "MEDOS_NETWORK_ERROR:restore_verification"
            }
        }
        catch {
            throw "MEDOS_NETWORK_ERROR:restore_failed"
        }
        throw "MEDOS_NETWORK_ERROR:apply_failed_restored"
    }
}

function Add-MedOSOperationFileType {
    [CmdletBinding()]
    param()

    if ("MedOS.NetworkAccess.OperationDirectory" -as [type]) { return }
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace MedOS.NetworkAccess {
    public sealed class OperationDirectory : IDisposable {
        [StructLayout(LayoutKind.Sequential)]
        private struct UNICODE_STRING {
            public ushort Length;
            public ushort MaximumLength;
            public IntPtr Buffer;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct OBJECT_ATTRIBUTES {
            public int Length;
            public IntPtr RootDirectory;
            public IntPtr ObjectName;
            public uint Attributes;
            public IntPtr SecurityDescriptor;
            public IntPtr SecurityQualityOfService;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IO_STATUS_BLOCK {
            public IntPtr Status;
            public UIntPtr Information;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct BY_HANDLE_FILE_INFORMATION {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFile(
            string name, uint access, uint share, IntPtr security, uint disposition,
            uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern uint GetFinalPathNameByHandle(
            SafeFileHandle handle, StringBuilder path, uint length, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION information);
        [DllImport("ntdll.dll")]
        private static extern int NtCreateFile(
            out SafeFileHandle handle, uint access, ref OBJECT_ATTRIBUTES attributes,
            out IO_STATUS_BLOCK status, IntPtr allocationSize, uint fileAttributes,
            uint shareAccess, uint createDisposition, uint createOptions, IntPtr eaBuffer,
            uint eaLength);
        [DllImport("ntdll.dll")]
        private static extern uint RtlNtStatusToDosError(int status);

        private readonly SafeFileHandle handle;
        private OperationDirectory(SafeFileHandle value) { handle = value; }

        private static string Normalize(string value) {
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                value = @"\\" + value.Substring(8);
            else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
                value = value.Substring(4);
            return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        }

        public static OperationDirectory Open(string path) {
            string expected = Normalize(path);
            SafeFileHandle result = CreateFile(
                expected, 0x00100081, 0x00000003, IntPtr.Zero, 3,
                0x02200000, IntPtr.Zero);
            if (result.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(result, out information))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if ((information.FileAttributes & 0x10) == 0 ||
                    (information.FileAttributes & 0x400) != 0)
                    throw new IOException("operation directory is unsafe");
                StringBuilder actual = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(result, actual, (uint)actual.Capacity, 0);
                if (length == 0 || length >= actual.Capacity)
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!String.Equals(expected, Normalize(actual.ToString()),
                                   StringComparison.OrdinalIgnoreCase))
                    throw new IOException("operation directory path changed");
                return new OperationDirectory(result);
            } catch { result.Dispose(); throw; }
        }

        private SafeFileHandle OpenRelative(string name, uint access, uint disposition) {
            if (String.IsNullOrEmpty(name) || name.IndexOfAny(new char[] {'\\', '/', ':'}) >= 0)
                throw new IOException("invalid operation marker name");
            IntPtr buffer = Marshal.StringToHGlobalUni(name);
            IntPtr unicode = IntPtr.Zero;
            try {
                UNICODE_STRING value = new UNICODE_STRING();
                value.Length = checked((ushort)(name.Length * 2));
                value.MaximumLength = value.Length;
                value.Buffer = buffer;
                unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(value, unicode, false);
                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES();
                attributes.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
                attributes.RootDirectory = handle.DangerousGetHandle();
                attributes.ObjectName = unicode;
                attributes.Attributes = 0x40;
                IO_STATUS_BLOCK status;
                SafeFileHandle file;
                int result = NtCreateFile(
                    out file, access | 0x00100080, ref attributes, out status,
                    IntPtr.Zero, 0x80, 0x00000007, disposition,
                    0x00200060, IntPtr.Zero, 0);
                if (result < 0)
                    throw new Win32Exception((int)RtlNtStatusToDosError(result));
                BY_HANDLE_FILE_INFORMATION information;
                if (!GetFileInformationByHandle(file, out information)) {
                    file.Dispose();
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                if ((information.FileAttributes & (0x10 | 0x400)) != 0) {
                    file.Dispose();
                    throw new IOException("operation marker is unsafe");
                }
                return file;
            } finally {
                if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void CreateMarker(string name, string content) {
            using (SafeFileHandle file = OpenRelative(name, 0x00000002, 2))
            using (FileStream stream = new FileStream(file, FileAccess.Write)) {
                byte[] bytes = Encoding.ASCII.GetBytes(content);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        public string ReadMarker(string name) {
            try {
                using (SafeFileHandle file = OpenRelative(name, 0x00000001, 1))
                using (FileStream stream = new FileStream(file, FileAccess.Read)) {
                    if (stream.Length > 256) throw new IOException("operation marker too large");
                    byte[] bytes = new byte[(int)stream.Length];
                    int offset = 0;
                    while (offset < bytes.Length) {
                        int read = stream.Read(bytes, offset, bytes.Length - offset);
                        if (read == 0) break;
                        offset += read;
                    }
                    return Encoding.ASCII.GetString(bytes, 0, offset).Trim();
                }
            } catch (Win32Exception error) {
                if (error.NativeErrorCode == 2 || error.NativeErrorCode == 3) return null;
                throw;
            }
        }

        public void Dispose() { handle.Dispose(); }
    }
}
"@
}

function Open-MedOSOperationDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    Add-MedOSOperationFileType
    return [MedOS.NetworkAccess.OperationDirectory]::Open($Path)
}

function New-MedOSProtectedDirectorySecurity {
    [CmdletBinding()]
    param()

    $administrators = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null
    )
    $system = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
    )
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($administrators)
    foreach ($identity in @($administrators, $system)) {
        $security.AddAccessRule(
            [Security.AccessControl.FileSystemAccessRule]::new(
                $identity,
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
                    [Security.AccessControl.InheritanceFlags]::ObjectInherit,
                [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow
            )
        )
    }
    return $security
}

function Get-MedOSDirectoryAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][IO.DirectoryInfo]$Directory,
        [Parameter(Mandatory = $true)]
        [Security.AccessControl.AccessControlSections]$Sections
    )

    $extensionType = "System.IO.FileSystemAclExtensions" -as [type]
    if ($extensionType) {
        return $extensionType::GetAccessControl($Directory, $Sections)
    }
    return $Directory.GetAccessControl($Sections)
}

function Assert-MedOSLocalDirectoryChainNoReparse {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Path]::IsPathRooted($fullPath) -or $fullPath.StartsWith('\\')) {
        throw "MEDOS_NETWORK_ERROR:privileged_directory_path"
    }
    $current = [IO.DirectoryInfo]::new($fullPath)
    $chain = [Collections.Generic.List[IO.DirectoryInfo]]::new()
    while ($current) {
        $chain.Add($current)
        $current = $current.Parent
    }
    for ($index = $chain.Count - 1; $index -ge 0; $index--) {
        $directory = $chain[$index]
        $directory.Refresh()
        if (-not $directory.Exists -or (
            $directory.Attributes -band [IO.FileAttributes]::ReparsePoint
        )) { throw "MEDOS_NETWORK_ERROR:privileged_directory_reparse" }
    }
}

function Assert-MedOSProtectedDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Path]::IsPathRooted($fullPath) -or $fullPath.StartsWith('\\')) {
        throw "MEDOS_NETWORK_ERROR:privileged_directory_path"
    }
    $directory = [IO.DirectoryInfo]::new($fullPath)
    $directory.Refresh()
    if (-not $directory.Exists -or (
        $directory.Attributes -band [IO.FileAttributes]::ReparsePoint
    )) { throw "MEDOS_NETWORK_ERROR:privileged_directory_reparse" }

    $sections = [Security.AccessControl.AccessControlSections]::Access -bor `
        [Security.AccessControl.AccessControlSections]::Owner
    $acl = Get-MedOSDirectoryAcl -Directory $directory -Sections $sections
    $administrators = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null
    )
    $system = [Security.Principal.SecurityIdentifier]::new(
        [Security.Principal.WellKnownSidType]::LocalSystemSid, $null
    )
    if (-not $acl.AreAccessRulesProtected -or (
        $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $administrators
    )) { throw "MEDOS_NETWORK_ERROR:privileged_directory_owner" }
    $rules = @($acl.GetAccessRules(
        $true, $false, [Security.Principal.SecurityIdentifier]
    ))
    if ($rules.Count -ne 2) {
        throw "MEDOS_NETWORK_ERROR:privileged_directory_acl"
    }
    $expected = @($administrators.Value, $system.Value)
    foreach ($rule in $rules) {
        if (
            $rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.InheritanceFlags -ne (
                [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
                    [Security.AccessControl.InheritanceFlags]::ObjectInherit
            ) -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
            $rule.IdentityReference.Value -notin $expected
        ) { throw "MEDOS_NETWORK_ERROR:privileged_directory_acl" }
    }
    if (@($rules.IdentityReference.Value | Sort-Object -Unique).Count -ne 2) {
        throw "MEDOS_NETWORK_ERROR:privileged_directory_acl"
    }
}

function New-MedOSProtectedDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $security = New-MedOSProtectedDirectorySecurity
    if (-not [IO.Directory]::Exists($Path)) {
        [IO.Directory]::CreateDirectory($Path, $security) | Out-Null
    }
    Assert-MedOSProtectedDirectory -Path $Path
}

function Get-MedOSPrivilegedOperationRoot {
    [CmdletBinding()]
    param()

    return [IO.Path]::GetFullPath((Join-Path (Get-MedOSTrustedProgramData) `
        "MedOS\NetworkOperations"))
}

function Test-MedOSPrivilegedOperationDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        if (-not $Path -or $Path.StartsWith('\\')) { return $false }
        $root = Get-MedOSPrivilegedOperationRoot
        $candidate = [IO.Path]::GetFullPath($Path).TrimEnd(
            [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar
        )
        $parent = [IO.Directory]::GetParent($candidate)
        if (-not $parent -or -not $parent.FullName.Equals(
            $root, [StringComparison]::OrdinalIgnoreCase
        )) { return $false }
        if ([IO.Path]::GetFileName($candidate) -notmatch '^operation-[a-f0-9]{32}$') {
            return $false
        }
        $programData = Get-MedOSTrustedProgramData
        Assert-MedOSLocalDirectoryChainNoReparse -Path $programData
        Assert-MedOSLocalDirectoryChainNoReparse -Path $candidate
        Assert-MedOSProtectedDirectory -Path (Join-Path $programData "MedOS")
        Assert-MedOSProtectedDirectory -Path $root
        Assert-MedOSProtectedDirectory -Path $candidate
        return $true
    }
    catch { return $false }
}

function Get-MedOSOuterOperationRoot {
    [CmdletBinding()]
    param()

    return [IO.Path]::GetFullPath((Join-Path (Get-MedOSTrustedLocalAppData) `
        "MedOS\NetworkOperations"))
}

function Test-MedOSOuterOperationDirectory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        if (-not $Path -or $Path.StartsWith('\\')) { return $false }
        $candidate = [IO.Path]::GetFullPath($Path).TrimEnd(
            [IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar
        )
        if ([IO.Path]::GetFileName($candidate) -notmatch '^operation-[a-f0-9]{32}$') {
            return $false
        }
        $localRoot = Get-MedOSOuterOperationRoot
        $parent = [IO.Directory]::GetParent($candidate)
        if ($parent -and $parent.FullName.Equals(
            $localRoot, [StringComparison]::OrdinalIgnoreCase
        )) {
            Assert-MedOSLocalDirectoryChainNoReparse `
                -Path (Get-MedOSTrustedLocalAppData)
            Assert-MedOSLocalDirectoryChainNoReparse -Path $candidate
            $handle = Open-MedOSOperationDirectory -Path $candidate
            $handle.Dispose()
            return $true
        }
        return Test-MedOSPrivilegedOperationDirectory -Path $candidate
    }
    catch { return $false }
}

function Test-MedOSWorkerInvocation {
    [CmdletBinding()]
    param()

    if (-not $env:MEDOS_NETWORK_TRANSACTION_WORKER) { return $false }
    if (-not $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY) { return $false }
    if (-not (Test-MedOSAdministrator)) { return $false }
    if (-not (Test-MedOSPrivilegedOperationDirectory `
        -Path $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY)) { return $false }
    $privateDirectory = $null
    try {
        $privateDirectory = Open-MedOSOperationDirectory `
            -Path $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY
        $expected = $privateDirectory.ReadMarker("worker-token")
        return $expected -and (
            $expected -ceq $env:MEDOS_NETWORK_TRANSACTION_WORKER
        )
    }
    catch { return $false }
    finally { if ($privateDirectory) { $privateDirectory.Dispose() } }
}

function Clear-MedOSInternalWorkerEnvironment {
    [CmdletBinding()]
    param()

    foreach ($name in @(
        "MEDOS_NETWORK_TRANSACTION_WORKER",
        "MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY"
    )) {
        Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue
    }
}

function New-MedOSPrivilegedOperationDirectory {
    [CmdletBinding()]
    param()

    $programData = Get-MedOSTrustedProgramData
    $medosRoot = Join-Path $programData "MedOS"
    $root = Get-MedOSPrivilegedOperationRoot
    Assert-MedOSLocalDirectoryChainNoReparse -Path $programData
    New-MedOSProtectedDirectory -Path $medosRoot
    New-MedOSProtectedDirectory -Path $root
    $path = Join-Path $root ("operation-" + [Guid]::NewGuid().ToString("N"))
    New-MedOSProtectedDirectory -Path $path
    Assert-MedOSLocalDirectoryChainNoReparse -Path $path
    if (-not (Test-MedOSPrivilegedOperationDirectory -Path $path)) {
        throw "MEDOS_NETWORK_ERROR:privileged_directory_verification"
    }
    return $path
}

function Invoke-MedOSTaskKill {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$ProcessId
    )

    $taskKill = Join-Path $script:MedOSWindowsDirectory "System32\taskkill.exe"
    if (-not (Test-Path -LiteralPath $taskKill -PathType Leaf)) {
        throw "MEDOS_NETWORK_ERROR:taskkill_missing"
    }
    & $taskKill /PID ([string]$ProcessId) /T /F 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "MEDOS_NETWORK_ERROR:worker_not_terminal"
    }
}

function Stop-MedOSWorkerTree {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Worker)

    if ($Worker.HasExited) { return }
    Invoke-MedOSTaskKill -ProcessId ([int]$Worker.Id)
    if (-not $Worker.WaitForExit(5000)) {
        throw "MEDOS_NETWORK_ERROR:worker_not_terminal"
    }
    $Worker.Refresh()
    if (-not $Worker.HasExited) {
        throw "MEDOS_NETWORK_ERROR:worker_not_terminal"
    }
}

function Invoke-MedOSFirewallSupervisor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("private", "public")]
        [string]$Mode
    )

    $script:MedOSFirewallRestorationProven = $false
    $snapshot = @(Get-MedOSFirewallSnapshot)
    $createdOperationDirectory = $false
    if (-not $env:MEDOS_NETWORK_OPERATION_DIRECTORY) {
        $env:MEDOS_NETWORK_OPERATION_DIRECTORY = New-MedOSPrivilegedOperationDirectory
        $env:MEDOS_NETWORK_OPERATION_TOKEN = (
            [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
        )
        $createdOperationDirectory = $true
    }
    $worker = $null
    $privatePath = $null
    $privateDirectory = $null
    try {
        if (Test-MedOSOperationMarker -Name "cancel") {
            throw "MEDOS_NETWORK_ERROR:cancelled"
        }
        $privatePath = New-MedOSPrivilegedOperationDirectory
        $privateDirectory = Open-MedOSOperationDirectory -Path $privatePath
        $token = [Guid]::NewGuid().ToString("N")
        $privateDirectory.CreateMarker("worker-token", "$token`n")
        $oldWorkerToken = $env:MEDOS_NETWORK_TRANSACTION_WORKER
        $oldPrivateDirectory = $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY
        $env:MEDOS_NETWORK_TRANSACTION_WORKER = $token
        $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY = $privatePath
        try {
            $worker = Start-Process `
                -FilePath $script:MedOSPowerShellPath `
                -ArgumentList @(
                    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                    "-File", ('"' + $script:MedOSScriptPath + '"'), "-Mode", $Mode
                ) `
                -PassThru `
                -WindowStyle Hidden
        }
        finally {
            $env:MEDOS_NETWORK_TRANSACTION_WORKER = $oldWorkerToken
            $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY = $oldPrivateDirectory
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(35)
        while (-not $worker.HasExited) {
            if (
                (Test-MedOSOperationMarker -Name "cancel") -or
                [DateTime]::UtcNow -ge $deadline
            ) { break }
            Start-Sleep -Milliseconds 50
            $worker.Refresh()
        }
        if (-not $worker.HasExited) {
            Stop-MedOSWorkerTree -Worker $worker
            throw "MEDOS_NETWORK_ERROR:worker_timeout"
        }
        if (
            $worker.ExitCode -ne 0 -or
            (Test-MedOSOperationMarker -Name "cancel")
        ) { throw "MEDOS_NETWORK_ERROR:worker_failed" }
        $effective = Get-MedOSEffectivePolicy
        if ($effective.Status -ne $Mode) {
            throw "MEDOS_NETWORK_ERROR:verification_mismatch"
        }
        if (Test-MedOSOperationMarker -Name "cancel") {
            throw "MEDOS_NETWORK_ERROR:cancelled_after_verification"
        }
        $script:MedOSFirewallRestorationProven = $true
        $script:MedOSFirewallOutcome = "committed"
        return $effective
    }
    catch {
        try {
            if ($worker -and -not $worker.HasExited) {
                Stop-MedOSWorkerTree -Worker $worker
            }
            Restore-MedOSFirewallSnapshot -Snapshot $snapshot
            if (-not (Test-MedOSFirewallSnapshot -Snapshot $snapshot)) {
                throw "MEDOS_NETWORK_ERROR:restore_verification"
            }
            $script:MedOSFirewallRestorationProven = $true
            $script:MedOSFirewallOutcome = "restored"
        }
        catch {
            throw "MEDOS_NETWORK_ERROR:supervisor_restore_failed"
        }
        throw "MEDOS_NETWORK_ERROR:supervisor_restored"
    }
    finally {
        if ($privateDirectory) { $privateDirectory.Dispose() }
        if ($privatePath) {
            [System.IO.Directory]::Delete($privatePath, $true)
        }
        if ($createdOperationDirectory) {
            if ($script:MedOSOperationDirectoryHandle) {
                $script:MedOSOperationDirectoryHandle.Dispose()
                $script:MedOSOperationDirectoryHandle = $null
            }
            [System.IO.Directory]::Delete($env:MEDOS_NETWORK_OPERATION_DIRECTORY, $true)
            $env:MEDOS_NETWORK_OPERATION_DIRECTORY = $null
            $env:MEDOS_NETWORK_OPERATION_TOKEN = $null
        }
    }
}

function Test-MedOSAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-MedOSOperationMarker {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][ValidateSet("elevation-pending", "elevated-started")][string]$Name)

    if (-not $env:MEDOS_NETWORK_OPERATION_DIRECTORY) { return }
    if ($env:MEDOS_NETWORK_OPERATION_TOKEN -notmatch '^[a-f0-9]{64}$') {
        throw "MEDOS_NETWORK_ERROR:operation_token"
    }
    if (-not (Test-MedOSOuterOperationDirectory `
        -Path $env:MEDOS_NETWORK_OPERATION_DIRECTORY)) {
        throw "MEDOS_NETWORK_ERROR:operation_directory"
    }
    if (-not $script:MedOSOperationDirectoryHandle) {
        $script:MedOSOperationDirectoryHandle = Open-MedOSOperationDirectory `
            -Path $env:MEDOS_NETWORK_OPERATION_DIRECTORY
    }
    $script:MedOSOperationDirectoryHandle.CreateMarker(
        $Name, "$($env:MEDOS_NETWORK_OPERATION_TOKEN)`n"
    )
}

function Test-MedOSOperationMarker {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][ValidateSet("cancel", "elevation-pending", "elevated-started")][string]$Name)

    if (-not $env:MEDOS_NETWORK_OPERATION_DIRECTORY) { return $false }
    if ($env:MEDOS_NETWORK_OPERATION_TOKEN -notmatch '^[a-f0-9]{64}$') { return $false }
    if (-not (Test-MedOSOuterOperationDirectory `
        -Path $env:MEDOS_NETWORK_OPERATION_DIRECTORY)) { return $false }
    if (-not $script:MedOSOperationDirectoryHandle) {
        $script:MedOSOperationDirectoryHandle = Open-MedOSOperationDirectory `
            -Path $env:MEDOS_NETWORK_OPERATION_DIRECTORY
    }
    $value = $script:MedOSOperationDirectoryHandle.ReadMarker($Name)
    return $value -ceq $env:MEDOS_NETWORK_OPERATION_TOKEN
}

function Invoke-MedOSElevatedSelf {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("private", "public")]
        [string]$Mode
    )

    $quotedScriptPath = '"' + $script:MedOSScriptPath + '"'
    $argumentList = @(
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $quotedScriptPath,
        "-Mode",
        $Mode
    )
    try {
        Set-MedOSOperationMarker -Name "elevation-pending"
        $child = Start-Process `
            -FilePath $script:MedOSPowerShellPath `
            -ArgumentList $argumentList `
            -Verb RunAs `
            -Wait `
            -PassThru `
            -WindowStyle Hidden
        return [int]$child.ExitCode
    }
    catch [System.ComponentModel.Win32Exception] {
        if ($_.Exception.NativeErrorCode -eq 1223) { return 1223 }
        return 1
    }
    catch {
        return 1
    }
}

function ConvertTo-MedOSNetworkAccessJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("private", "public", "mixed", "invalid")]
        [string]$Status
    )

    if ($Status -eq "public") {
        return '{"version":1,"status":"public","allow_public":true}'
    }
    return '{"version":1,"status":"' + $Status + '","allow_public":false}'
}

$workerControlsPresent = [bool](
    $env:MEDOS_NETWORK_TRANSACTION_WORKER -or
    $env:MEDOS_NETWORK_PRIVILEGED_OPERATION_DIRECTORY
)
$isTransactionWorker = Test-MedOSWorkerInvocation
if ($workerControlsPresent -and -not $isTransactionWorker) {
    [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:invalid_worker_environment")
    exit 12
}
$outerDirectoryPresent = [bool]$env:MEDOS_NETWORK_OPERATION_DIRECTORY
$outerTokenPresent = [bool]$env:MEDOS_NETWORK_OPERATION_TOKEN
if (
    $outerDirectoryPresent -ne $outerTokenPresent -or
    ($outerTokenPresent -and $env:MEDOS_NETWORK_OPERATION_TOKEN -notmatch '^[a-f0-9]{64}$') -or
    ($outerDirectoryPresent -and -not (Test-MedOSOuterOperationDirectory `
        -Path $env:MEDOS_NETWORK_OPERATION_DIRECTORY))
) {
    [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:invalid_operation_environment")
    exit 12
}

if ($ReadEffective) {
    $state = Invoke-MedOSFirewallMutex -ScriptBlock { Get-MedOSEffectivePolicy }
    ConvertTo-MedOSNetworkAccessJson -Status $state.Status
    exit 0
}

if ($isTransactionWorker) {
    try {
        Repair-MedOSFirewallRules -Mode $Mode
        $workerState = Get-MedOSEffectivePolicy
        if ($workerState.Status -ne $Mode) {
            throw "MEDOS_NETWORK_ERROR:worker_verification"
        }
        exit 0
    }
    catch {
        [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:worker_failed")
        exit 1
    }
}

Clear-MedOSInternalWorkerEnvironment

if (-not (Test-MedOSAdministrator)) {
    $childExit = Invoke-MedOSElevatedSelf -Mode $Mode
    if ($childExit -ne 0) { exit $childExit }
}
else {
    $script:MedOSFirewallRestorationProven = $false
    Set-MedOSOperationMarker -Name "elevated-started"
    try {
        $null = Invoke-MedOSFirewallMutex -ScriptBlock {
            Invoke-MedOSFirewallSupervisor -Mode $Mode
        }
    }
    catch {
        [Console]::Error.WriteLine("MEDOS_NETWORK_ERROR:transaction_failed")
        if (
            $script:MedOSFirewallRestorationProven -and
            $script:MedOSFirewallOutcome -eq "restored"
        ) { exit 10 }
        exit 11
    }
}

ConvertTo-MedOSNetworkAccessJson -Status $Mode
exit 0

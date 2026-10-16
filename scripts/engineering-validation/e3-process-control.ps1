param(
    [Parameter(Mandatory = $true)][ValidateSet('Observe', 'Terminate')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$RequestPath
)
$ErrorActionPreference = 'Stop'
$auditPath = $RequestPath + '.ledger.ndjson'
function Write-Audit($entry) {
    $entry | ConvertTo-Json -Depth 9 -Compress | Add-Content -LiteralPath $auditPath -Encoding utf8
}
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($RequestPath -notmatch '^E:[\\/]' -or $request.profile -notmatch '^E:[\\/].*[\\/]\.tmp[\\/]e3-runtime[\\/]') { throw 'Only isolated E3 E-drive request/profile paths are allowed' }
function Read-Identity([int]$targetId) {
    $item = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $targetId" -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    [pscustomobject]@{
        pid = [int]$item.ProcessId
        parentPid = [int]$item.ParentProcessId
        executable = [string]$item.ExecutablePath
        commandLine = [string]$item.CommandLine
        createdUtc = $item.CreationDate.ToUniversalTime().ToString('o')
        createdUtcTicks = $item.CreationDate.ToUniversalTime().Ticks.ToString()
    }
}
function Assert-Identity($expected, $current) {
    if ($null -eq $current) { throw "Process $($expected.pid) has already exited before identity verification" }
    if ($current.pid -ne $expected.pid -or $current.createdUtcTicks -ne $expected.createdUtcTicks -or $current.executable -ine $expected.executable -or $current.commandLine -cne $expected.commandLine) { throw "Process identity mismatch for $($expected.pid); refusing termination" }
}
if ($Mode -eq 'Observe') {
    $rootIdentity = Read-Identity ([int]$request.mainPid)
    if ($null -eq $rootIdentity) { throw 'Requested Main is absent' }
    if ($rootIdentity.executable -ine $request.executable) { throw 'Main executable mismatch' }
    if (-not $rootIdentity.commandLine.Contains($request.profile)) { throw 'Main command line lacks this exact isolated Profile' }
    $verified = @($rootIdentity)
    $rejected = @()
    $frontier = @($rootIdentity)
    for ($depth = 0; $depth -lt 8 -and $frontier.Count -gt 0; $depth++) {
        $nextFrontier = @()
        foreach ($parentIdentity in $frontier) {
            $children = Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($parentIdentity.pid)" -ErrorAction SilentlyContinue
            foreach ($childItem in $children) {
                $childIdentity = Read-Identity ([int]$childItem.ProcessId)
                if ($null -eq $childIdentity) { continue }
                if (@($verified | Where-Object { $_.pid -eq $childIdentity.pid }).Count -gt 0) { continue }
                $validTime = [long]$childIdentity.createdUtcTicks -ge [long]$parentIdentity.createdUtcTicks
                $appChild = $childIdentity.executable -ieq $request.executable
                $nodeChild = ($childIdentity.executable -ieq $request.nodeExecutable) -and ($childIdentity.commandLine.Contains($request.fixtureScript) -or $childIdentity.commandLine.Contains($request.verifierScript))
                if ($validTime -and ($appChild -or $nodeChild)) {
                    $verified += $childIdentity
                    $nextFrontier += $childIdentity
                } else {
                    $rejected += [pscustomobject]@{ identity = $childIdentity; validCreationTime = $validTime; recognizedOwnedExecutableAndCommand = ($appChild -or $nodeChild); action = 'Excluded; no termination permitted' }
                }
            }
        }
        $frontier = $nextFrontier
    }
    [pscustomobject]@{ observedAt = [DateTimeOffset]::UtcNow.ToString('o'); main = $rootIdentity; verified = $verified; excludedCandidates = $rejected } | ConvertTo-Json -Depth 9 -Compress
    exit 0
}
if ($request.authorization -cne 'USER_APPROVED_E3_ONE_PLANNED_KILL' -or $request.case -notin @('CR_A', 'CR_B')) { throw 'Missing exact scoped E3 termination authorization' }
if ($request.killOrdinal -ne 1 -or $request.profileVerifiedFromRuntime -ne $true -or $request.breakpointAndSnapshotVerified -ne $true) { throw 'Kill is only allowed once, at the verified barrier/profile' }
if ($request.identities.Count -lt 1) { throw 'Missing verified identities' }
$mainExpected = $request.identities[0]
if ($mainExpected.pid -ne $request.mainPid -or $mainExpected.executable -ine $request.executable -or -not $mainExpected.commandLine.Contains($request.profile)) { throw 'Main identity/profile manifest mismatch' }
# Validate the complete known set before the one planned Main termination.
foreach ($expected in $request.identities) {
    $current = Read-Identity ([int]$expected.pid)
    if ($null -ne $current) { Assert-Identity $expected $current }
}
Assert-Identity $mainExpected (Read-Identity ([int]$mainExpected.pid))
Write-Audit ([pscustomobject]@{ event = 'ALL_IDENTITIES_VERIFIED_BEFORE_MAIN_KILL'; at = [DateTimeOffset]::UtcNow.ToString('o'); identities = $request.identities })
$operations = @()
foreach ($expected in $request.identities) {
    $current = Read-Identity ([int]$expected.pid)
    if ($null -eq $current) {
        $operations += [pscustomobject]@{ pid = $expected.pid; action = 'Already exited'; revalidated = $false }
        continue
    }
    if ($expected.pid -ne $mainExpected.pid -and ([string]::IsNullOrWhiteSpace($current.executable) -or [string]::IsNullOrWhiteSpace($current.commandLine))) {
        # Windows may return a draining child with no readable executable/command after Main exits.
        # Never terminate this unverified identity; wait below for OS-confirmed disappearance.
        $operations += [pscustomobject]@{ pid = $expected.pid; action = 'Identity unavailable after Main exit; excluded from termination'; current = $current }
        Write-Audit $operations[-1]
        continue
    }
    Assert-Identity $expected $current
    $before = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Audit ([pscustomobject]@{ event = 'EXACT_STOP_REQUEST'; pid = $expected.pid; identity = $current; at = $before })
    Stop-Process -Id ([int]$expected.pid) -Force -ErrorAction Stop
    $operations += [pscustomobject]@{ pid = $expected.pid; action = 'Stop-Process -Id exactPID -Force'; revalidated = $true; executable = $current.executable; createdUtc = $current.createdUtc; requestedAt = $before }
    Write-Audit $operations[-1]
}
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
do {
    $remaining = @()
    foreach ($expected in $request.identities) {
        $current = Read-Identity ([int]$expected.pid)
        if ($null -ne $current -and $current.createdUtcTicks -eq $expected.createdUtcTicks) { $remaining += $current }
    }
    if ($remaining.Count -gt 0) { Start-Sleep -Milliseconds 100 }
} while ($remaining.Count -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline)
if ($remaining.Count -gt 0) { throw 'An original verified test process is still present; no retry kill was attempted' }
[pscustomobject]@{ status = 'TERMINATED'; case = $request.case; mainPid = $request.mainPid; mainKillOrdinal = 1; operations = $operations; allOriginalIdentitiesAbsent = $true; finishedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 9 -Compress

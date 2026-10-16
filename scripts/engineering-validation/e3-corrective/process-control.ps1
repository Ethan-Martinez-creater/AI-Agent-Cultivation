param(
    [Parameter(Mandatory = $true)][ValidateSet('Observe', 'Terminate')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$RequestPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-policy.ps1')
if ($RequestPath.Replace([char]92, [char]47) -notmatch '^E:/.*/\.tmp/e3-corrective-runtime/') { throw 'Only isolated E-drive corrective requests are allowed' }
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($request.profile.Replace([char]92, [char]47) -notmatch '^E:/.*/\.tmp/e3-corrective-runtime/[^/]+/profile$') { throw 'Old or nonisolated profiles are forbidden' }
$auditPath = $RequestPath + '.ledger.ndjson'
$receiptPath = $RequestPath + '.receipt.json'
$operations = [System.Collections.Generic.List[object]]::new()
$lastActual = $null
$lastExpected = $null
$mainStopRequested = $false
function Write-Audit($entry) {
    [pscustomobject]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); data = $entry } | ConvertTo-Json -Depth 20 -Compress | Add-Content -LiteralPath $auditPath -Encoding utf8
}
function Read-Identity([int]$TargetId) {
    try {
        $item = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $TargetId" -OperationTimeoutSec 3 -ErrorAction Stop
        if ($null -eq $item) { return $null }
        $createdUtc = $null
        $createdTicks = ''
        if ($null -ne $item.CreationDate) {
            $createdUtc = $item.CreationDate.ToUniversalTime().ToString('o')
            $createdTicks = $item.CreationDate.ToUniversalTime().Ticks.ToString()
        }
        return [pscustomobject]@{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId; executable = [string]$item.ExecutablePath; commandLine = [string]$item.CommandLine; createdUtc = $createdUtc; createdUtcTicks = $createdTicks }
    } catch {
        return [pscustomobject]@{ pid = $TargetId; parentPid = $null; executable = ''; commandLine = ''; createdUtc = $null; createdUtcTicks = ''; observationError = $_.Exception.Message }
    }
}
function Observe-Expected($Expected, [string]$Phase) {
    $script:lastExpected = $Expected
    $script:lastActual = Read-Identity ([int]$Expected.pid)
    $decision = Get-E3IdentityDisposition $Expected $script:lastActual
    Write-Audit ([pscustomobject]@{ event = 'IDENTITY_OBSERVED'; phase = $Phase; expected = $Expected; actual = $script:lastActual; disposition = $decision })
    return $decision
}
function Assert-MainContext($Identity) {
    if ($null -eq $Identity -or $Identity.executable -ine $request.executable -or [string]::IsNullOrWhiteSpace($Identity.createdUtcTicks) -or -not $Identity.commandLine.Contains($request.profile)) { throw 'Main executable, creation time or exact isolated profile is unavailable/mismatched' }
}
try {
    $main = Read-Identity ([int]$request.mainPid)
    $lastActual = $main
    $lastExpected = $request.startupIdentity
    Assert-MainContext $main
    if ($Mode -eq 'Observe') {
        $verified = [System.Collections.Generic.List[object]]::new()
        $excluded = [System.Collections.Generic.List[object]]::new()
        $verified.Add($main)
        $frontier = @($main)
        for ($depth = 0; $depth -lt 8 -and $frontier.Count -gt 0; $depth++) {
            $next = [System.Collections.Generic.List[object]]::new()
            foreach ($parent in $frontier) {
                $children = Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($parent.pid)" -OperationTimeoutSec 3 -ErrorAction Stop
                foreach ($child in $children) {
                    $identity = Read-Identity ([int]$child.ProcessId)
                    if ($null -eq $identity -or @($verified | Where-Object { $_.pid -eq $identity.pid }).Count -gt 0) { continue }
                    $knownTime = -not [string]::IsNullOrWhiteSpace($identity.createdUtcTicks)
                    $validTime = $knownTime -and [long]$identity.createdUtcTicks -ge [long]$parent.createdUtcTicks
                    $appChild = $identity.executable -ieq $request.executable -and $identity.commandLine.Contains($request.profile)
                    $nodeChild = $identity.executable -ieq $request.nodeExecutable -and ($identity.commandLine.Contains($request.fixtureScript) -or $identity.commandLine.Contains($request.verifierScript))
                    if ($validTime -and ($appChild -or $nodeChild)) { $verified.Add($identity); $next.Add($identity) }
                    else { $excluded.Add([pscustomobject]@{ identity = $identity; validTime = $validTime; recognizedOwnedCommand = ($appChild -or $nodeChild); action = 'EXCLUDED_NO_STOP' }) }
                }
            }
            $frontier = @($next.ToArray())
        }
        [pscustomobject]@{ observedAt = [DateTimeOffset]::UtcNow.ToString('o'); main = $main; verified = @($verified.ToArray()); excludedCandidates = @($excluded.ToArray()) } | ConvertTo-Json -Depth 20 -Compress
        exit 0
    }
    if ($request.authorization -cne 'USER_APPROVED_E3_CR_A_CORRECTIVE_ONE_MAIN_KILL' -or $request.case -cne 'CR_A_CORRECTIVE' -or $request.killOrdinal -ne 1) { throw 'Missing corrective-only one-Main-kill authorization' }
    if ($request.profileVerifiedFromRuntime -ne $true -or $request.breakpointAndSnapshotVerified -ne $true) { throw 'Runtime profile and exact barrier snapshot must be verified' }
    if ($request.identities.Count -lt 1) { throw 'No verified process identities supplied' }
    $expectedMain = $request.identities[0]
    if ($expectedMain.pid -ne $request.mainPid) { throw 'Main must be the first identity' }
    $launch = $request.controllerLaunch
    if ($null -eq $launch -or $launch.mainPid -ne $request.mainPid -or $launch.executable -ine $request.executable -or $launch.profile -cne $request.profile -or [string]::IsNullOrWhiteSpace($launch.launchToken) -or -not $request.profile.Contains($launch.launchToken) -or $null -eq $launch.spawnargs -or [string]::IsNullOrWhiteSpace($launch.startedAt)) { throw 'Controller launch record does not match this exact Main/profile' }
    $runtime = $request.runtimeIdentity
    if ($null -eq $runtime -or $runtime.pid -ne $request.mainPid -or $runtime.execPath -ine $request.executable -or $runtime.userData -cne (Join-Path $request.profile 'UserData') -or $runtime.electronUserData -cne (Join-Path $request.profile 'UserData')) { throw 'Runtime Main identity or actual Electron UserData differs from controller launch record' }
    foreach ($flag in @('--gate1-fake-model', '--r4-fake-routing', '--w22-fake-software')) {
        if ($runtime.argv -notcontains $flag -or $launch.spawnargs -notcontains $flag) { throw "Offline fixture flag is absent from runtime or launch: $flag" }
    }
    if ((Get-E3IdentityDisposition $request.startupIdentity $expectedMain).status -ne 'MATCHED') { throw 'Main identity no longer matches the original controller startup observation' }
    $runtimeRoot = Split-Path -Parent (Split-Path -Parent $request.profile)
    $lockPath = Join-Path $runtimeRoot 'formal-authorization-used.json'
    # CreateNew semantics: a second invocation cannot consume this user's one-case authorization.
    [pscustomobject]@{ case = $request.case; mainPid = $request.mainPid; profile = $request.profile; launch = $launch; reservedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 12 | Out-File -LiteralPath $lockPath -Encoding utf8 -NoClobber
    foreach ($expected in $request.identities) {
        $decision = Observe-Expected $expected 'BEFORE_MAIN_STOP'
        if ($decision.status -notin @('MATCHED', 'EXITED') -or ($expected.pid -eq $request.mainPid -and $decision.status -ne 'MATCHED')) { throw "Identity guard refused BEFORE_MAIN_STOP: $($expected.pid) $($decision.status)" }
    }
    $decision = Observe-Expected $expectedMain 'MAIN_IMMEDIATE_REVALIDATION'
    if ($decision.status -ne 'MATCHED') { throw "Main identity revalidation refused: $($decision.status)" }
    $mainStopRequested = $true
    Write-Audit ([pscustomobject]@{ event = 'EXACT_MAIN_STOP_REQUEST'; expected = $expectedMain; actual = $lastActual; controllerLaunch = $launch; runtimeIdentity = $runtime })
    Stop-Process -Id ([int]$expectedMain.pid) -Force -ErrorAction Stop
    $operations.Add([pscustomobject]@{ pid = $expectedMain.pid; action = 'STOP_EXACT_MAIN_PID'; status = 'STOP_REQUEST_RETURNED'; identity = $lastActual })
    Write-Audit $operations[-1]
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
    foreach ($expected in $request.identities | Select-Object -Skip 1) {
        do {
            $decision = Observe-Expected $expected 'AFTER_MAIN_STOP'
            if ($decision.status -eq 'UNKNOWN') {
                if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Child identity unreadable at bounded deadline: $($expected.pid)" }
                Start-Sleep -Milliseconds 150
            }
        } while ($decision.status -eq 'UNKNOWN')
        if ($decision.status -eq 'EXITED') { $operations.Add([pscustomobject]@{ pid = $expected.pid; action = 'NONE'; status = 'EXITED'; actual = $lastActual }); Write-Audit $operations[-1]; continue }
        if ($decision.status -ne 'MATCHED') { throw "Child refused after Main stop: $($expected.pid) $($decision.status)" }
        Write-Audit ([pscustomobject]@{ event = 'EXACT_CHILD_STOP_REQUEST'; expected = $expected; actual = $lastActual })
        try { Stop-Process -Id ([int]$expected.pid) -Force -ErrorAction Stop }
        catch {
            $stopError = $_.Exception.Message
            $afterStopError = Observe-Expected $expected 'CHILD_STOP_ERROR_RECHECK_NO_RETRY'
            if ($afterStopError.status -eq 'EXITED') {
                $operations.Add([pscustomobject]@{ pid = $expected.pid; action = 'NO_RETRY'; status = 'EXITED_DURING_STOP_REQUEST'; actual = $lastActual; stopError = $stopError })
                Write-Audit $operations[-1]
                continue
            }
            throw "Child stop failed without retry; $stopError; current disposition=$($afterStopError.status)"
        }
        $operations.Add([pscustomobject]@{ pid = $expected.pid; action = 'STOP_EXACT_VERIFIED_CHILD_PID'; status = 'STOP_REQUEST_RETURNED'; identity = $lastActual })
        Write-Audit $operations[-1]
    }
    do {
        $remaining = @()
        foreach ($expected in $request.identities) {
            $decision = Observe-Expected $expected 'VERIFY_ALL_ABSENT'
            if ($decision.status -eq 'MATCHED' -or $decision.status -eq 'UNKNOWN') { $remaining += $lastActual }
            elseif ($decision.status -ne 'EXITED') { throw "Identity changed while waiting for exit: $($expected.pid) $($decision.status)" }
        }
        if ($remaining.Count -gt 0) { Start-Sleep -Milliseconds 150 }
    } while ($remaining.Count -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline)
    if ($remaining.Count -gt 0) { throw 'Original process still present or unidentifiable at bounded deadline; no retry kill permitted' }
    $receipt = [pscustomobject]@{ status = 'TERMINATED'; case = $request.case; mainPid = $request.mainPid; mainKillOrdinal = 1; mainStopRequested = $mainStopRequested; allOriginalIdentitiesAbsent = $true; operations = @($operations.ToArray()); ledgerPath = $auditPath; finishedAt = [DateTimeOffset]::UtcNow.ToString('o') }
    $receipt | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    $receipt | ConvertTo-Json -Depth 20 -Compress
} catch {
    $failure = [pscustomobject]@{ status = 'BLOCKED'; mode = $Mode; mainPid = $request.mainPid; mainStopRequested = $mainStopRequested; operations = @($operations.ToArray()); expected = $lastExpected; actual = $lastActual; error = $_.Exception.Message; scriptStackTrace = $_.ScriptStackTrace; finishedAt = [DateTimeOffset]::UtcNow.ToString('o'); noRetryKill = $true }
    Write-Audit ([pscustomobject]@{ event = 'GUARD_BLOCKED'; failure = $failure })
    $failure | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    $failure | ConvertTo-Json -Depth 20 -Compress
    exit 2
}

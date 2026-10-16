param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-policy.ps1')
if (-not $OutputPath.StartsWith('E:', [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.Path]::IsPathRooted($OutputPath)) { throw 'Test output must stay on E:' }
$expected = [pscustomobject]@{ pid = 4242; parentPid = 4000; executable = 'E:\isolated\application.exe'; commandLine = 'E:\isolated\application.exe --profile=E:\isolated\profile'; createdUtcTicks = '639277168833700260' }
$matched = $expected.PSObject.Copy()
$unknown = $expected.PSObject.Copy(); $unknown.executable = ''; $unknown.commandLine = ''
$reused = $expected.PSObject.Copy(); $reused.createdUtcTicks = '639277168833700261'
$wrongCommand = $expected.PSObject.Copy(); $wrongCommand.commandLine = 'different profile'
$wrongExecutable = $expected.PSObject.Copy(); $wrongExecutable.executable = 'E:\other.exe'
$wrongPid = $expected.PSObject.Copy(); $wrongPid.pid = 4243
$results = [System.Collections.Generic.List[object]]::new()
foreach ($case in @(
    @{ name = 'Absent PID'; current = $null; status = 'EXITED'; action = 'NONE' },
    @{ name = 'Exact live identity'; current = $matched; status = 'MATCHED'; action = 'EXACT_PID_STOP_ELIGIBLE' },
    @{ name = 'Unreadable live identity'; current = $unknown; status = 'UNKNOWN'; action = 'WAIT_ONLY' },
    @{ name = 'Reused PID'; current = $reused; status = 'PID_REUSED'; action = 'REFUSE' },
    @{ name = 'Different full command/profile'; current = $wrongCommand; status = 'MISMATCHED'; action = 'REFUSE' },
    @{ name = 'Different executable'; current = $wrongExecutable; status = 'MISMATCHED'; action = 'REFUSE' },
    @{ name = 'Different PID'; current = $wrongPid; status = 'MISMATCHED'; action = 'REFUSE' }
)) {
    $actual = Get-E3IdentityDisposition $expected $case.current
    $pass = $actual.status -ceq $case.status -and $actual.action -ceq $case.action
    $results.Add([pscustomobject]@{ name = $case.name; pass = $pass; expected = $case.status; actual = $actual })
}
$natural = Resolve-E3ChildObservations $expected @($unknown, $null)
$persistent = Resolve-E3ChildObservations $expected @($unknown, $unknown)
$reuseAfter = Resolve-E3ChildObservations $expected @($unknown, $reused)
$results.Add([pscustomobject]@{ name = 'Main exit followed by unreadable child naturally disappearing'; pass = $natural.status -ceq 'EXITED' -and $natural.stopAllowed -eq $false; actual = $natural })
$results.Add([pscustomobject]@{ name = 'Persistent unreadable child blocks without stop'; pass = $persistent.status -ceq 'BLOCKED' -and $persistent.stopAllowed -eq $false; actual = $persistent })
$results.Add([pscustomobject]@{ name = 'PID reuse after unreadable child blocks without stop'; pass = $reuseAfter.status -ceq 'BLOCKED' -and $reuseAfter.stopAllowed -eq $false; actual = $reuseAfter })
$passCount = @($results | Where-Object pass).Count
$report = [pscustomobject]@{ status = $(if ($passCount -eq $results.Count) { 'PASS' } else { 'FAIL' }); passed = $passCount; total = $results.Count; cases = @($results.ToArray()); actualProcessStops = 0; policyTestsOnly = $true; observation = 'In-memory identity observations; no process termination, database edits, application launch or paid API'; checkedAt = [DateTimeOffset]::UtcNow.ToString('o') }
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$report | Select-Object status, passed, total, actualProcessStops | ConvertTo-Json -Compress
if ($passCount -ne $results.Count) { exit 1 }

function Get-E3IdentityDisposition($Expected, $Current) {
    if ($null -eq $Current) { return [pscustomobject]@{ status = 'EXITED'; action = 'NONE'; reason = 'OS query returned no process' } }
    if ($Current.pid -ne $Expected.pid) { return [pscustomobject]@{ status = 'MISMATCHED'; action = 'REFUSE'; reason = 'PID differs' } }
    if (-not [string]::IsNullOrWhiteSpace($Current.createdUtcTicks) -and $Current.createdUtcTicks -cne $Expected.createdUtcTicks) {
        return [pscustomobject]@{ status = 'PID_REUSED'; action = 'REFUSE'; reason = 'Same PID has a different OS creation time' }
    }
    if ([string]::IsNullOrWhiteSpace($Current.createdUtcTicks) -or [string]::IsNullOrWhiteSpace($Current.executable) -or [string]::IsNullOrWhiteSpace($Current.commandLine)) {
        return [pscustomobject]@{ status = 'UNKNOWN'; action = 'WAIT_ONLY'; reason = 'Live process identity fields are unreadable' }
    }
    if ($Current.executable -ine $Expected.executable -or $Current.commandLine -cne $Expected.commandLine) {
        return [pscustomobject]@{ status = 'MISMATCHED'; action = 'REFUSE'; reason = 'Executable or complete command line differs' }
    }
    return [pscustomobject]@{ status = 'MATCHED'; action = 'EXACT_PID_STOP_ELIGIBLE'; reason = 'PID, creation time, executable and complete command line match' }
}

function Resolve-E3ChildObservations($Expected, [object[]]$Observations) {
    # Pure bounded observation policy, also used by nondestructive controller tests.
    foreach ($current in $Observations) {
        $disposition = Get-E3IdentityDisposition $Expected $current
        if ($disposition.status -eq 'EXITED') { return [pscustomobject]@{ status = 'EXITED'; stopAllowed = $false } }
        if ($disposition.status -in @('MISMATCHED', 'PID_REUSED')) { return [pscustomobject]@{ status = 'BLOCKED'; stopAllowed = $false; reason = $disposition.reason; actual = $current } }
        if ($disposition.status -eq 'MATCHED') { return [pscustomobject]@{ status = 'MATCHED'; stopAllowed = $true; actual = $current } }
    }
    return [pscustomobject]@{ status = 'BLOCKED'; stopAllowed = $false; reason = 'Bounded observations exhausted with identity still unknown' }
}

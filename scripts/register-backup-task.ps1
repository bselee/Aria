# Register AriaDailyBackup scheduled task
$taskName = 'AriaDailyBackup'
$scriptPath = 'C:\Users\BuildASoil\Documents\Projects\aria\scripts\backup-aria-db.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -Daily -At 03:00

try {
    # Use local username without domain prefix
    $principal = New-ScheduledTaskPrincipal -UserId 'BuildASoil' -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force
    Write-Output "OK: Scheduled task '$taskName' registered (daily at 03:00)"
}
catch {
    Write-Output "First attempt failed: $_"
    # Fallback: try without explicit principal (runs as SYSTEM)
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force
        Write-Output "OK (fallback): Scheduled task '$taskName' registered as SYSTEM"
    }
    catch {
        Write-Output "FAIL: $_"
        exit 1
    }
}

# Verify
$t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($t) {
    Write-Output "Task state: $($t.State)"
    Write-Output "Task user: $($t.Principal.UserId)"
}

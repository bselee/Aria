# setup-task-scheduler.ps1
# Registers Windows Task Scheduler tasks for the Aria nightshift system.
# Run ONCE as Administrator.
#
# Prerequisites:
#   - node + tsx available in PATH
#
# Tasks created:
#   \Aria\NightshiftStart — Mon-Fri 6:05 PM → start-nightshift.ps1
#   \Aria\NightshiftStop  — Mon-Fri 7:00 AM → stop-nightshift.ps1

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$ScriptDir   = $PSScriptRoot
$StartScript = Join-Path $ScriptDir "start-nightshift.ps1"
$StopScript  = Join-Path $ScriptDir "stop-nightshift.ps1"

if (-not (Test-Path $StartScript)) {
    Write-Error "start-nightshift.ps1 not found at: $StartScript"
    exit 1
}
if (-not (Test-Path $StopScript)) {
    Write-Error "stop-nightshift.ps1 not found at: $StopScript"
    exit 1
}

# ── Create task folder ────────────────────────────────────────────────────────

$TaskPath = "\Aria\"
try {
    $Scheduler = New-Object -ComObject Schedule.Service
    $Scheduler.Connect()
    $RootFolder = $Scheduler.GetFolder("\")
    try { $RootFolder.GetFolder("Aria") | Out-Null }
    catch { $RootFolder.CreateFolder("Aria") | Out-Null; Write-Host "Created task folder: \Aria\" }
} catch {
    Write-Warning "Could not create \Aria\ folder via COM — tasks will be created in root."
    $TaskPath = "\"
}

# ── Helper: register task ─────────────────────────────────────────────────────

function Register-NightshiftTask {
    param(
        [string]$TaskName,
        [string]$ScriptPath,
        [string]$StartTime,
        [string]$DaysOfWeek
    )

    $FullName = "$TaskPath$TaskName"

    Unregister-ScheduledTask -TaskName $FullName -Confirm:$false -ErrorAction SilentlyContinue

    $Action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

    $Trigger = New-ScheduledTaskTrigger `
        -Weekly `
        -DaysOfWeek $DaysOfWeek `
        -At $StartTime

    $Settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable

    # Run as current logged-in user (inherits user environment)
    $Principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType Interactive `
        -RunLevel Highest

    Register-ScheduledTask `
        -TaskName $FullName `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -Principal $Principal `
        -Force | Out-Null

    Write-Host "Registered: $FullName @ $StartTime ($DaysOfWeek)"
}

# ── Register tasks ────────────────────────────────────────────────────────────

Register-NightshiftTask `
    -TaskName "NightshiftStart" `
    -ScriptPath $StartScript `
    -StartTime "18:05" `
    -DaysOfWeek "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday"

Register-NightshiftTask `
    -TaskName "NightshiftStop" `
    -ScriptPath $StopScript `
    -StartTime "07:00" `
    -DaysOfWeek "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday"

# ── Verify ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Registered tasks:"
Get-ScheduledTask -TaskPath $TaskPath | Select-Object TaskName, State | Format-Table -AutoSize

Write-Host ""
Write-Host "Setup complete. Nightshift will:"
Write-Host "  6:05 PM Mon-Fri — start nightshift-runner (hosted Haiku classifier)"
Write-Host "  7:00 AM Mon-Fri — stop nightshift-runner"

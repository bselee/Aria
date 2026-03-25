# setup-qwen3-test-task.ps1
# Registers \Aria\Qwen3PdfTest in Task Scheduler — Mon-Fri 7:05 AM.
# Runs AFTER NightshiftStop (7 AM) so Ollama is free; BEFORE 8 AM AP poll.
# Run ONCE as Administrator.

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$ScriptPath = Join-Path $PSScriptRoot "test-qwen3-nightly.ps1"
if (-not (Test-Path $ScriptPath)) {
    Write-Error "test-qwen3-nightly.ps1 not found at: $ScriptPath"
    exit 1
}

$TaskPath = "\Aria\"
$TaskName = "${TaskPath}Qwen3PdfTest"

# Ensure \Aria\ folder exists
try {
    $Scheduler = New-Object -ComObject Schedule.Service
    $Scheduler.Connect()
    $RootFolder = $Scheduler.GetFolder("\")
    try { $RootFolder.GetFolder("Aria") | Out-Null }
    catch { $RootFolder.CreateFolder("Aria") | Out-Null }
} catch {
    Write-Warning "Could not ensure \Aria\ folder — using root."
    $TaskName = "\Qwen3PdfTest"
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

$Trigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek "Monday,Tuesday,Wednesday,Thursday,Friday" `
    -At "07:05"

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Force | Out-Null

Write-Host "Registered: $TaskName @ 7:05 AM Mon-Fri"
Write-Host "Results sent to Telegram. Log: logs\qwen3-test.log"
Write-Host ""
Write-Host "To run manually now:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\test-qwen3-nightly.ps1"

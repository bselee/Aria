# stop-nightshift.ps1
# Stops the nightshift-runner using the saved PID file.

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot "logs\nightshift.pid"
$LauncherLog = Join-Path $ProjectRoot "logs\nightshift-launcher.log"

function Write-LauncherLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] $Message"
    Add-Content -Path $LauncherLog -Value $entry
    Write-Host $entry
}

Write-LauncherLog "[nightshift-stop] Launcher entered."

if (-not (Test-Path $PidFile)) {
    Write-LauncherLog "[nightshift-stop] No PID file found at $PidFile. Nothing to stop."
    exit 0
}

$Lines = Get-Content $PidFile
foreach ($Line in $Lines) {
    if (-not $Line.Trim()) { continue }
    $Parts = $Line -split ":"
    $Label = $Parts[0]
    $Pid = [int]$Parts[1]

    $Proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    if ($Proc) {
        Write-LauncherLog "[nightshift-stop] Stopping $Label (PID $Pid)."
        Stop-Process -Id $Pid -Force
        Write-LauncherLog "[nightshift-stop] $Label stopped."
    } else {
        Write-LauncherLog "[nightshift-stop] $Label (PID $Pid) not found. Already exited."
    }
}

Remove-Item $PidFile -Force
Write-LauncherLog "[nightshift-stop] PID file removed. Nightshift stopped."

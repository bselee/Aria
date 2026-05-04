# start-nightshift.ps1
# Starts the nightshift-runner for overnight email pre-classification.
# Uses hosted Haiku through the app runtime; no local LLM service is required.

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot "logs"
$PidFile = Join-Path $LogDir "nightshift.pid"
$RunnerLog = Join-Path $LogDir "nightshift-runner.log"
$LauncherLog = Join-Path $LogDir "nightshift-launcher.log"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Write-LauncherLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] $Message"
    Add-Content -Path $LauncherLog -Value $entry
    Write-Host $entry
}

Write-LauncherLog "[nightshift-start] Launcher entered."

Write-LauncherLog "[nightshift-start] Classifier: hosted Haiku"

$FreeRAM = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
$FreeGB = [math]::Round($FreeRAM / 1GB, 1)
if ($FreeRAM -lt 4GB) {
    Write-LauncherLog "[nightshift-start] WARN low RAM: ${FreeGB} GB free."
} else {
    Write-LauncherLog "[nightshift-start] Free RAM OK: ${FreeGB} GB"
}

if (Test-Path $PidFile) {
    $Lines = Get-Content $PidFile -ErrorAction SilentlyContinue
    foreach ($Line in $Lines) {
        if ($Line -match "^runner:(\d+)$") {
            $OldPid = [int]$Matches[1]
            $Proc = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
            if ($Proc) {
                Write-LauncherLog "[nightshift-start] Stale runner PID $OldPid found. Stopping before restart."
                Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 1
            }
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Write-LauncherLog "[nightshift-start] Starting nightshift-runner."
$RunnerArgs = "--import tsx src/cli/nightshift-runner.ts"

$RunnerProc = Start-Process -FilePath "node" `
    -ArgumentList $RunnerArgs `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $RunnerLog `
    -RedirectStandardError $RunnerLog `
    -PassThru `
    -WindowStyle Hidden

Write-LauncherLog "[nightshift-start] nightshift-runner PID: $($RunnerProc.Id)"

"runner:$($RunnerProc.Id)" | Set-Content $PidFile
Write-LauncherLog "[nightshift-start] PID saved to $PidFile"
Write-LauncherLog "[nightshift-start] Started successfully. Runner log: $RunnerLog"

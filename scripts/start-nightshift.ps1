# start-nightshift.ps1
# Starts the nightshift-runner for overnight email pre-classification.

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

$OllamaUrl = if ($env:LLAMA_SERVER_URL) { $env:LLAMA_SERVER_URL } else { "http://localhost:11434" }
$ModelName = if ($env:LLAMA_MODEL_NAME) { $env:LLAMA_MODEL_NAME } else { "qwen3:4b" }

Write-LauncherLog "[nightshift-start] Ollama: $OllamaUrl | Model: $ModelName"

$FreeRAM = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
$FreeGB = [math]::Round($FreeRAM / 1GB, 1)
if ($FreeRAM -lt 4GB) {
    Write-LauncherLog "[nightshift-start] WARN low RAM: ${FreeGB} GB free."
} else {
    Write-LauncherLog "[nightshift-start] Free RAM OK: ${FreeGB} GB"
}

Write-LauncherLog "[nightshift-start] Checking Ollama health."
try {
    Invoke-RestMethod -Uri "$OllamaUrl/" -Method Get -TimeoutSec 5 -ErrorAction Stop | Out-Null
    Write-LauncherLog "[nightshift-start] Ollama is running."
} catch {
    Write-LauncherLog "[nightshift-start] ERROR Ollama not reachable at $OllamaUrl. Aborting."
    exit 1
}

Write-LauncherLog "[nightshift-start] Checking model availability: $ModelName"
try {
    $TagResp = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -Method Get -TimeoutSec 10 -ErrorAction Stop
    $ModelAvailable = $TagResp.models | Where-Object { $_.name -eq $ModelName -or $_.model -eq $ModelName }
    if (-not $ModelAvailable) {
        Write-LauncherLog "[nightshift-start] Model '$ModelName' not found locally. Pulling now."
        & ollama pull $ModelName
        if ($LASTEXITCODE -ne 0) {
            Write-LauncherLog "[nightshift-start] ERROR Failed to pull $ModelName. Aborting."
            exit 1
        }
    } else {
        Write-LauncherLog "[nightshift-start] Model '$ModelName' available."
    }
} catch {
    Write-LauncherLog "[nightshift-start] WARN Could not verify model list: $($_.Exception.Message). Proceeding anyway."
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

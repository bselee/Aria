# start-nightshift.ps1
# Starts the nightshift-runner for overnight email pre-classification.
# Uses Ollama (always-on) — no llama-server binary needed.
# Called by Task Scheduler at 6:05 PM Mon-Fri (5 min after ops-manager enqueues emails).
#
# Env vars (optional overrides):
#   LLAMA_SERVER_URL         — Ollama URL (default: http://localhost:11434)
#   LLAMA_MODEL_NAME         — model to use  (default: qwen2.5:1.5b)
#   NIGHTSHIFT_POLL_MS       — poll interval  (default: 300000 = 5 min)
#   NIGHTSHIFT_BATCH_SIZE    — tasks per cycle (default: 30)
#   NIGHTSHIFT_MAX_ESCALATIONS — haiku cap    (default: 20)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir      = Join-Path $ProjectRoot "logs"
$PidFile     = Join-Path $LogDir "nightshift.pid"
$RunnerLog   = Join-Path $LogDir "nightshift-runner.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ── Resolve config ─────────────────────────────────────────────────────────────

$OllamaUrl  = if ($env:LLAMA_SERVER_URL) { $env:LLAMA_SERVER_URL } else { "http://localhost:11434" }
$ModelName  = if ($env:LLAMA_MODEL_NAME) { $env:LLAMA_MODEL_NAME } else { "qwen3:4b" }

Write-Host "[nightshift] Ollama: $OllamaUrl | Model: $ModelName"

# ── Check free RAM ─────────────────────────────────────────────────────────────

$FreeRAM = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
$FreeGB  = [math]::Round($FreeRAM / 1GB, 1)
if ($FreeRAM -lt 4GB) {
    Write-Warning "[nightshift] Low RAM: only ${FreeGB} GB free. Proceeding — monitor Task Manager."
} else {
    Write-Host "[nightshift] Free RAM: ${FreeGB} GB — OK"
}

# ── Verify Ollama is running ───────────────────────────────────────────────────

Write-Host "[nightshift] Checking Ollama health..."
try {
    $Resp = Invoke-RestMethod -Uri "$OllamaUrl/" -Method Get -TimeoutSec 5 -ErrorAction Stop
    Write-Host "[nightshift] Ollama is running."
} catch {
    Write-Error "[nightshift] Ollama not reachable at $OllamaUrl. Start Ollama first. Aborting."
    exit 1
}

# ── Verify model is available ──────────────────────────────────────────────────

Write-Host "[nightshift] Checking model availability: $ModelName"
try {
    $TagResp = Invoke-RestMethod -Uri "$OllamaUrl/api/tags" -Method Get -TimeoutSec 10 -ErrorAction Stop
    $ModelAvailable = $TagResp.models | Where-Object { $_.name -eq $ModelName -or $_.model -eq $ModelName }
    if (-not $ModelAvailable) {
        Write-Warning "[nightshift] Model '$ModelName' not found locally. Pulling now..."
        & ollama pull $ModelName
        if ($LASTEXITCODE -ne 0) {
            Write-Error "[nightshift] Failed to pull $ModelName. Aborting."
            exit 1
        }
    } else {
        Write-Host "[nightshift] Model '$ModelName' available."
    }
} catch {
    Write-Warning "[nightshift] Could not verify model list: $_. Proceeding anyway."
}

# ── Kill existing runner if still running ─────────────────────────────────────

if (Test-Path $PidFile) {
    $Lines = Get-Content $PidFile -ErrorAction SilentlyContinue
    foreach ($Line in $Lines) {
        if ($Line -match "^runner:(\d+)$") {
            $OldPid = [int]$Matches[1]
            $Proc = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
            if ($Proc) {
                Write-Warning "[nightshift] Stale runner (PID $OldPid) — stopping before restart"
                Stop-Process -Id $OldPid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 1
            }
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# ── Start nightshift-runner ────────────────────────────────────────────────────

Write-Host "[nightshift] Starting nightshift-runner..."

$RunnerArgs = "--import tsx src/cli/nightshift-runner.ts"

$RunnerProc = Start-Process -FilePath "node" `
    -ArgumentList $RunnerArgs `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $RunnerLog `
    -RedirectStandardError  $RunnerLog `
    -PassThru `
    -WindowStyle Hidden

Write-Host "[nightshift] nightshift-runner PID: $($RunnerProc.Id)"

# ── Save PID ───────────────────────────────────────────────────────────────────

"runner:$($RunnerProc.Id)" | Set-Content $PidFile
Write-Host "[nightshift] PID saved to $PidFile"
Write-Host "[nightshift] Started. Log: $RunnerLog"

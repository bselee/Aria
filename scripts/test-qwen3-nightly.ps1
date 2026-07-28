# test-qwen3-nightly.ps1
# Runs the qwen3:4b PDF extraction capability test and sends results to Telegram.
# Scheduled at 7:05 AM Mon-Fri — right after NightshiftStop (7 AM), before 8 AM AP poll.
# Only aria-bot is in memory at this point; Ollama is free of the nightshift runner.
#
# Safe to re-run manually at any time:
#   powershell -ExecutionPolicy Bypass -File scripts\test-qwen3-nightly.ps1

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir      = Join-Path $ProjectRoot "logs"
$LogFile     = Join-Path $LogDir "qwen3-test.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ── RAM guard ──────────────────────────────────────────────────────────────────
# qwen3:4b needs ~2.5 GB. Require at least 5 GB free to be safe.

$FreeRAM = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
$FreeGB  = [math]::Round($FreeRAM / 1GB, 1)

if ($FreeRAM -lt 5GB) {
    $msg = "[qwen3-test] Only ${FreeGB} GB free — skipping test (need >= 5 GB). Check Task Manager."
    Write-Warning $msg
    $msg | Add-Content $LogFile
    exit 0   # exit 0 so Task Scheduler doesn't flag as failure
}

Write-Host "[qwen3-test] Free RAM: ${FreeGB} GB — OK"

# ── Verify Ollama is running ───────────────────────────────────────────────────

try {
    Invoke-RestMethod -Uri "http://localhost:11434/" -Method Get -TimeoutSec 5 -ErrorAction Stop | Out-Null
    Write-Host "[qwen3-test] Ollama is running."
} catch {
    $msg = "[qwen3-test] Ollama not reachable — skipping test."
    Write-Warning $msg
    $msg | Add-Content $LogFile
    exit 0
}

# ── Run test ───────────────────────────────────────────────────────────────────

Write-Host "[qwen3-test] Starting qwen3:4b PDF extraction test..."
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting qwen3:4b test" | Add-Content $LogFile

$TestOutput = & node --import tsx "$ProjectRoot\src\cli\test-ollama-pdf.ts" qwen3:4b --telegram 2>&1

$TestOutput | Add-Content $LogFile
$TestOutput | ForEach-Object { Write-Host $_ }

Write-Host "[qwen3-test] Done. Log: $LogFile"

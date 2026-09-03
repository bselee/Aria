<#
.SYNOPSIS
    Aria Bot Watchdog - ensures aria-bot stays running under PM2.
    Designed to run every 5 minutes via Windows Task Scheduler.

.DESCRIPTION
    Checks if aria-bot is online in PM2. If not (stopped, errored, or
    missing from the process list entirely), restarts it from the
    ecosystem config and sends a Telegram alert so Will knows it happened.

    This solves the gap where PM2 startup does not work on Windows,
    so the bot can silently die over a weekend/holiday with zero alerting.

.NOTES
    Created: 2026-03-16
    Author:  Antigravity
    Schedule: Every 5 minutes via Task Scheduler
#>

$ErrorActionPreference = "Stop"

# -- Configuration --
$ProjectDir   = "C:\Users\BuildASoil\Documents\Projects\aria"
$EcosystemCfg = Join-Path $ProjectDir "ecosystem.config.json"
$LogFile      = Join-Path $ProjectDir "logs\watchdog.log"
$EnvFile      = Join-Path $ProjectDir ".env.local"

# -- Load Telegram credentials from .env.local --
$botToken = $null
$chatId   = $null

if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match "^TELEGRAM_BOT_TOKEN=(.+)$") { $botToken = $Matches[1].Trim() }
        if ($line -match "^TELEGRAM_CHAT_ID=(.+)$")   { $chatId   = $Matches[1].Trim() }
    }
}

# -- Helper: append to watchdog log --
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] $Message"
    $logDir = Split-Path $LogFile -Parent
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -Path $LogFile -Value $entry
    Write-Host $entry
}

# -- Helper: send Telegram alert --
function Send-TelegramAlert {
    param([string]$Text)
    # Telegram disabled per Bill (2026-08-19) -- log-only stub.
    $preview = ($Text -replace '
?\n', ' ')
    if ($preview.Length -gt 80) { $preview = $preview.Substring(0, 80) + "..." }
    Write-Log "INFO: Telegram alert skipped (disabled per Bill 2026-08-19): $preview"
}

# -- Helper: check if aria-bot is online via pm2 pid --
function Test-AriaBotOnline {
    # Use pm2 pid which returns the PID number if running, empty if not
    $pidOutput = & pm2 pid aria-bot 2>$null | Out-String
    $pidOutput = $pidOutput.Trim()
    # pm2 pid returns empty string or "0" when not running
    if (-not $pidOutput -or $pidOutput -eq "" -or $pidOutput -eq "0") {
        return $false
    }
    return $true
}

function Invoke-OpsControlLease {
    try {
        Set-Location $ProjectDir
        $json = & node --import tsx src/cli/ops-control.ts lease --consumer watchdog --targets watchdog,all 2>$null | Out-String
        $json = $json.Trim()
        if (-not $json -or $json -eq "null") {
            return $null
        }
        return $json | ConvertFrom-Json
    } catch {
        Write-Log "WARN: Failed to lease ops control request: $($_.Exception.Message)"
        return $null
    }
}

function Complete-OpsControlRequest {
    param(
        [string]$RequestId,
        [string]$Result
    )

    try {
        Set-Location $ProjectDir
        & node --import tsx src/cli/ops-control.ts complete --id $RequestId --consumer watchdog --result $Result 2>$null | Out-Null
    } catch {
        Write-Log "WARN: Failed to complete ops control request ${RequestId}: $($_.Exception.Message)"
    }
}

function Fail-OpsControlRequest {
    param(
        [string]$RequestId,
        [string]$ErrorMessage
    )

    try {
        Set-Location $ProjectDir
        & node --import tsx src/cli/ops-control.ts fail --id $RequestId --consumer watchdog --error $ErrorMessage 2>$null | Out-Null
    } catch {
        Write-Log "WARN: Failed to fail ops control request ${RequestId}: $($_.Exception.Message)"
    }
}

function Restart-AriaBot {
    param(
        [string]$Reason
    )

    Set-Location $ProjectDir

    if (Test-AriaBotOnline) {
        Write-Log "CRITICAL: Restarting aria-bot. Reason: $Reason"
        $restartOutput = & pm2 restart aria-bot 2>&1 | Out-String
        Write-Log "PM2 restart output: $restartOutput"
    }
    else {
        Write-Log "CRITICAL: aria-bot is NOT running. Starting... Reason: $Reason"
        $restartOutput = & pm2 start $EcosystemCfg --only aria-bot 2>&1 | Out-String
        Write-Log "PM2 start output: $restartOutput"
    }

    & pm2 save 2>&1 | Out-Null

    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $msg = [char]0xD83D + [char]0xDEA8 + " <b>Watchdog Action - Bot Restarted</b>" + [char]10 + [char]10
    $msg += "aria-bot was restarted by the watchdog." + [char]10
    $msg += "Time: $now" + [char]10
    $msg += "Reason: $Reason" + [char]10 + [char]10
    $msg += "Check logs: pm2 logs aria-bot --lines 20"
    Send-TelegramAlert $msg
}

# -- Helper: sweep orphaned aria-bot processes (duplicate cron schedulers) --
# PM2 on Windows cannot guarantee SIGTERM kills the child, so a restart can
# leave an invisible orphan still firing node-cron. Enumerate every
# `node --import tsx` fork-wrapper and kill any PID that is NOT the
# PM2-supervised one. See src/lib/persistence/pid-guard.ts (2026-09-02).
function Invoke-OrphanSweep {
    $supervisedRaw = (& pm2 pid aria-bot 2>$null | Out-String).Trim()
    $supervisedPid = 0
    if ($supervisedRaw -match '^\d+$') { $supervisedPid = [int]$supervisedRaw }
    # Only sweep when we positively know the supervised PID — never when the
    # bot is mid-boot/down, to avoid racing PM2's own restart.
    if ($supervisedPid -le 0) { return }

    try {
        # AGE GATE (2026-09-02): never kill a process younger than 60s — during
        # `pm2 restart` the old pid may still be listed while the NEW process is
        # mid-boot; a young process is a sibling, not an orphan. Mirrors
        # pid-guard.ts MIN_ORPHAN_AGE_MS = 60_000.
        $cutoff = (Get-Date).AddSeconds(-60)
        $zombies = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
            $_.CommandLine -match '--import tsx' -and `
            $_.CommandLine -match 'ProcessContainerFork' -and `
            $_.ProcessId -ne $supervisedPid -and `
            $_.CreationDate -and `
            $_.CreationDate -lt $cutoff
        }
        foreach ($z in $zombies) {
            Write-Log "CRITICAL: Killing orphaned aria-bot PID $($z.ProcessId) (duplicate cron scheduler)"
            Stop-Process -Id $z.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Log "WARN: Orphan sweep failed: $($_.Exception.Message)"
    }
}

# -- Main watchdog logic --
try {
    $controlRequest = Invoke-OpsControlLease
    if ($controlRequest) {
        if ($controlRequest.command -eq "restart_bot") {
            Restart-AriaBot "Control plane requested restart: $($controlRequest.reason)"
            Complete-OpsControlRequest -RequestId $controlRequest.id -Result "watchdog_restart_completed"
        }
        else {
            Fail-OpsControlRequest -RequestId $controlRequest.id -ErrorMessage "unsupported_watchdog_command:$($controlRequest.command)"
        }
    }

    $isOnline = Test-AriaBotOnline

    # Sweep any orphaned aria-bot processes every tick (safe no-op when none).
    Invoke-OrphanSweep

    if (-not $isOnline) {
        Restart-AriaBot "Process missing or stopped in PM2"
    }
    else {
        # Bot is online - only log hourly heartbeat (when minute 0-4)
        $minute = (Get-Date).Minute
        if ($minute -lt 5) {
            # Get memory from pm2 status output
            $statusLine = & pm2 status 2>$null | Out-String
            Write-Log "OK: aria-bot is online. Heartbeat check passed."
        }
    }

    # --- Local data plane: WSL + PostgREST Windows path ---
    try {
        $pgCode = 0
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:5434/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            $pgCode = [int]$resp.StatusCode
        } catch {
            if ($_.Exception.Response) {
                $pgCode = [int]$_.Exception.Response.StatusCode
            } else {
                $pgCode = 0
            }
        }

        # 200/401/503 are healthy (503 = schema cache reload -- never docker-restart)
        if ($pgCode -eq 200 -or $pgCode -eq 401 -or $pgCode -eq 503) {
            # ok
        } else {
            Write-Log "WARN: PostgREST Windows path down (HTTP $pgCode) -- waking WSL/Docker + proxy"
            & wsl.exe -d Ubuntu -u root -- bash -lc "service docker start >/dev/null 2>&1; docker start aria-db >/dev/null 2>&1; sleep 6; docker exec aria-db pg_isready -U postgres >/dev/null 2>&1; docker start aria-postgrest aria-minio >/dev/null 2>&1; true" 2>$null | Out-Null
            Start-Sleep -Seconds 8
            Set-Location $ProjectDir
            & pm2 restart aria-wsl-proxy 2>&1 | Out-Null
            Start-Sleep -Seconds 6
            $pgCode2 = 0
            try {
                $resp2 = Invoke-WebRequest -Uri "http://127.0.0.1:5434/" -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
                $pgCode2 = [int]$resp2.StatusCode
            } catch {
                if ($_.Exception.Response) { $pgCode2 = [int]$_.Exception.Response.StatusCode } else { $pgCode2 = 0 }
            }
            if ($pgCode2 -eq 200 -or $pgCode2 -eq 401 -or $pgCode2 -eq 503) {
                Write-Log "OK: PostgREST recovered (HTTP $pgCode2)"
            } else {
                Write-Log "ERROR: PostgREST still down after recovery (HTTP $pgCode2)"
            }
        }

        # Ensure local-stack + proxy processes exist in PM2
        foreach ($app in @("aria-postgrest", "aria-pg-health", "aria-dashboard", "aria-bot")) {
            $pidOut = & pm2 pid $app 2>$null | Out-String
            $pidOut = $pidOut.Trim()
            if (-not $pidOut -or $pidOut -eq "" -or $pidOut -eq "0") {
                Write-Log "WARN: $app missing -- starting from ecosystem.config.json"
                $ecoJson = Join-Path $ProjectDir "ecosystem.config.json"
                & pm2 start $ecoJson --only $app 2>&1 | Out-Null
            }
        }
    } catch {
        Write-Log "WARN: Data-plane check failed: $($_.Exception.Message)"
    }
} catch {
    Write-Log "ERROR: Watchdog failed: $($_.Exception.Message)"

    $errText = [char]0xD83D + [char]0xDEA8 + " Watchdog Script Error" + [char]10 + [char]10
    $errText += "The watchdog itself encountered an error:" + [char]10
    $errText += $_.Exception.Message + [char]10 + [char]10
    $errText += "Manual intervention may be required."
    Send-TelegramAlert $errText
}

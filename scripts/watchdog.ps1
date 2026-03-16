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
$EcosystemCfg = Join-Path $ProjectDir "ecosystem.config.cjs"
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
    if (-not $botToken -or -not $chatId) {
        Write-Log "WARN: Cannot send Telegram alert - missing credentials in .env.local"
        return
    }
    try {
        $uri = "https://api.telegram.org/bot$botToken/sendMessage"
        # Build body manually to avoid encoding issues
        $payload = @{
            chat_id    = $chatId
            text       = $Text
            parse_mode = "HTML"
        }
        $jsonBody = $payload | ConvertTo-Json -Depth 5
        Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($jsonBody)) | Out-Null
        Write-Log "Telegram alert sent."
    } catch {
        Write-Log "WARN: Telegram alert failed: $($_.Exception.Message)"
    }
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

# -- Main watchdog logic --
try {
    $isOnline = Test-AriaBotOnline

    if (-not $isOnline) {
        Write-Log "CRITICAL: aria-bot is NOT running. Restarting..."

        Set-Location $ProjectDir
        $restartOutput = & pm2 start $EcosystemCfg --only aria-bot 2>&1 | Out-String
        Write-Log "PM2 start output: $restartOutput"
        & pm2 save 2>&1 | Out-Null

        $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $msg = [char]0xD83D + [char]0xDEA8 + " <b>Watchdog Alert - Bot Restarted</b>" + [char]10 + [char]10
        $msg += "aria-bot was <b>not running</b> and has been restarted by the watchdog." + [char]10
        $msg += "Time: $now" + [char]10
        $msg += "Reason: Process missing or stopped in PM2" + [char]10 + [char]10
        $msg += "Check logs: pm2 logs aria-bot --lines 20"
        Send-TelegramAlert $msg
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
} catch {
    Write-Log "ERROR: Watchdog failed: $($_.Exception.Message)"

    $errText = [char]0xD83D + [char]0xDEA8 + " Watchdog Script Error" + [char]10 + [char]10
    $errText += "The watchdog itself encountered an error:" + [char]10
    $errText += $_.Exception.Message + [char]10 + [char]10
    $errText += "Manual intervention may be required."
    Send-TelegramAlert $errText
}

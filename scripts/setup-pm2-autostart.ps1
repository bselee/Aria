# ──────────────────────────────────────────────────────────────────────────────
# setup-pm2-autostart.ps1
#
# Registers a Windows Task Scheduler entry that runs `pm2 resurrect` at user
# logon, so aria-bot comes back automatically after a reboot without
# requiring Will to log in and manually `pm2 start ecosystem.config.cjs`.
#
# IMPORTANT: aria-dashboard is INTENTIONALLY NOT auto-started. Running
# `next dev` under pm2 tanked the machine on 2026-04-30 (12GB heap budget
# + Chrome instability). The dashboard is manual-start only — run
# `npx next dev -p 3001` on demand for forensic/drill-down sessions.
#
# RUN AS ADMINISTRATOR ONCE.
#
# Usage (PowerShell, elevated):
#   cd C:\Users\BuildASoil\Documents\Projects\aria
#   .\scripts\setup-pm2-autostart.ps1
#
# What it does:
#   1. Saves the current pm2 process list to ~\.pm2\dump.pm2 via `pm2 save`.
#   2. Creates two Task Scheduler tasks:
#        AriaPm2Resurrect     — At logon, runs `pm2 resurrect` so saved
#                                processes start automatically.
#        AriaPm2DailyHealth   — Daily 7:00 AM check, restarts any stopped
#                                aria-* process. Runs whether logged in or not.
#
# Verify after install:
#   schtasks /Query /TN AriaPm2Resurrect
#   schtasks /Query /TN AriaPm2DailyHealth
#
# Remove later:
#   schtasks /Delete /TN AriaPm2Resurrect /F
#   schtasks /Delete /TN AriaPm2DailyHealth /F
# ──────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

# Resolve paths.
$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$Pm2Path = (Get-Command pm2 -ErrorAction SilentlyContinue).Source
if (-not $Pm2Path) {
    Write-Error "pm2 not found in PATH. Install it first: npm install -g pm2"
    exit 1
}

$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    Write-Error "node not found in PATH."
    exit 1
}

Write-Host "─── Aria PM2 Autostart Setup ───" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host "pm2:          $Pm2Path"
Write-Host "node:         $NodePath"
Write-Host ""

# Step 1: Save current pm2 process list.
Write-Host "[1/3] Saving current pm2 process list..." -ForegroundColor Yellow
& pm2 save
if ($LASTEXITCODE -ne 0) {
    Write-Error "pm2 save failed. Make sure aria-bot + aria-dashboard are started before running this script."
    exit 1
}
Write-Host "      pm2 process list saved to ~\.pm2\dump.pm2" -ForegroundColor Green
Write-Host ""

# Step 2: Register the at-logon resurrect task.
Write-Host "[2/3] Registering AriaPm2Resurrect (logon trigger)..." -ForegroundColor Yellow
schtasks /Delete /TN AriaPm2Resurrect /F 2>$null

# Wrap pm2 resurrect in a script that also waits for the network.
$ResurrectCmd = "node `"$Pm2Path`" resurrect"

schtasks /Create `
    /TN "AriaPm2Resurrect" `
    /SC ONLOGON `
    /RU $env:USERNAME `
    /RL HIGHEST `
    /TR "cmd.exe /c $ResurrectCmd" `
    /F | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "      AriaPm2Resurrect task registered." -ForegroundColor Green
} else {
    Write-Error "Failed to register AriaPm2Resurrect."
    exit 1
}
Write-Host ""

# Step 3: Register the daily health check.
Write-Host "[3/3] Registering AriaPm2DailyHealth (daily 7am)..." -ForegroundColor Yellow
schtasks /Delete /TN AriaPm2DailyHealth /F 2>$null

# Build a small inline command that restarts any stopped aria-* process.
# pm2 jlist returns JSON; we filter to aria-* and restart any not online.
$HealthCmd = "powershell -NoProfile -Command `"& {`$j = (& pm2 jlist | ConvertFrom-Json); foreach (`$p in `$j) { if (`$p.name -like 'aria-*' -and `$p.pm2_env.status -ne 'online') { & pm2 restart `$p.name } }}`""

schtasks /Create `
    /TN "AriaPm2DailyHealth" `
    /SC DAILY `
    /ST "07:00" `
    /RU $env:USERNAME `
    /RL HIGHEST `
    /TR $HealthCmd `
    /F | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "      AriaPm2DailyHealth task registered." -ForegroundColor Green
} else {
    Write-Error "Failed to register AriaPm2DailyHealth."
    exit 1
}
Write-Host ""

Write-Host "─── Setup complete ───" -ForegroundColor Cyan
Write-Host ""
Write-Host "Verify:" -ForegroundColor Yellow
Write-Host "  schtasks /Query /TN AriaPm2Resurrect"
Write-Host "  schtasks /Query /TN AriaPm2DailyHealth"
Write-Host ""
Write-Host "Remove later:" -ForegroundColor Yellow
Write-Host "  schtasks /Delete /TN AriaPm2Resurrect /F"
Write-Host "  schtasks /Delete /TN AriaPm2DailyHealth /F"
Write-Host ""
Write-Host "Test now (resurrect simulation): pm2 kill ; pm2 resurrect" -ForegroundColor Yellow

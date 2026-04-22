# start-chrome-cdp.ps1 — Launch Chrome with CDP (DevTools Protocol) enabled
# This allows Aria to connect to your running Chrome for:
#   - Autonomous cookie extraction (grab-cookies.ts)
#   - Cart fill that appears in YOUR browser (surgical ninja mode)
#   - AI-powered browser interaction via Stagehand
#
# Usage: Run this once. Chrome opens normally — you won't notice a difference.
# All your tabs, extensions, and logins are preserved.

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $ChromePath)) {
    $ChromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $ChromePath)) {
    Write-Host "Chrome not found at standard paths. Please update the script." -ForegroundColor Red
    exit 1
}

# Check if Chrome is already running
$chrome = Get-Process chrome -ErrorAction SilentlyContinue
if ($chrome) {
    # Check if CDP is already enabled
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 -ErrorAction Stop
        Write-Host "Chrome is already running with CDP enabled on port 9222." -ForegroundColor Green
        Write-Host "You're good to go!"
        exit 0
    } catch {
        Write-Host "Chrome is running but CDP is NOT enabled." -ForegroundColor Yellow
        Write-Host "Chrome needs to be restarted with the --remote-debugging-port=9222 flag." -ForegroundColor Yellow
        Write-Host ""
        $response = Read-Host "Close Chrome and relaunch with CDP? (y/n)"
        if ($response -ne "y") {
            Write-Host "Aborted. Close Chrome manually and re-run this script." -ForegroundColor Red
            exit 1
        }
        Write-Host "Closing Chrome..." -ForegroundColor Yellow
        Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

# Chrome 147+ on Windows requires all three flags:
#   --remote-debugging-port    → the CDP port to listen on
#   --remote-debugging-address → explicit bind address (Chrome 147 won't bind without this)
#   --user-data-dir            → explicit profile path (otherwise CDP silently skips the listener)
$UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data"
Write-Host "Launching Chrome with CDP on port 9222..." -ForegroundColor Cyan
Start-Process $ChromePath -ArgumentList "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1", "--user-data-dir=`"$UserDataDir`""
Start-Sleep -Seconds 3

# Verify CDP is working
try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 5 -ErrorAction Stop
    Write-Host ""
    Write-Host "Chrome is running with CDP enabled!" -ForegroundColor Green
    Write-Host "Aria can now:" -ForegroundColor Green
    Write-Host "  - Grab cookies: node --import tsx src/cli/grab-cookies.ts uline.com" -ForegroundColor White
    Write-Host "  - Fill ULINE cart directly in your browser" -ForegroundColor White
    Write-Host "  - Use Stagehand AI for any website interaction" -ForegroundColor White
} catch {
    Write-Host "Chrome launched but CDP not responding. Try again." -ForegroundColor Red
}

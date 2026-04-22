# setup-chrome-cdp-shortcut.ps1 - Patch Chrome shortcuts to always enable CDP
# Run ONCE. After this, every Chrome launch has CDP enabled automatically.

$ErrorActionPreference = "Stop"

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $ChromePath)) {
    $ChromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $ChromePath)) {
    Write-Host "Chrome not found." -ForegroundColor Red
    exit 1
}

$UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$CDPArgs = '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="' + $UserDataDir + '"'

$WshShell = New-Object -ComObject WScript.Shell

# Find all Chrome shortcuts
$ShortcutPaths = @()

$desktop = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktop "Google Chrome.lnk"
if (Test-Path $desktopShortcut) { $ShortcutPaths += $desktopShortcut }

$startMenu = [Environment]::GetFolderPath("Programs")
$userStartShortcut = Join-Path $startMenu "Google Chrome.lnk"
if (Test-Path $userStartShortcut) { $ShortcutPaths += $userStartShortcut }

$allUsersStart = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk"
if (Test-Path $allUsersStart) { $ShortcutPaths += $allUsersStart }

$taskbar = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Google Chrome.lnk"
if (Test-Path $taskbar) { $ShortcutPaths += $taskbar }

if ($ShortcutPaths.Count -eq 0) {
    Write-Host "No Chrome shortcuts found. Creating one on Desktop..." -ForegroundColor Yellow
    $newShortcut = $WshShell.CreateShortcut((Join-Path $desktop "Google Chrome.lnk"))
    $newShortcut.TargetPath = $ChromePath
    $newShortcut.Arguments = $CDPArgs
    $newShortcut.Save()
    Write-Host "Created Desktop shortcut with CDP flags." -ForegroundColor Green
    exit 0
}

Write-Host ("Found " + $ShortcutPaths.Count + " Chrome shortcut(s):") -ForegroundColor Cyan
$ShortcutPaths | ForEach-Object { Write-Host ("  " + $_) }
Write-Host ""

foreach ($path in $ShortcutPaths) {
    try {
        $shortcut = $WshShell.CreateShortcut($path)
        $oldArgs = $shortcut.Arguments

        if ($oldArgs -like "*remote-debugging-port*") {
            Write-Host ("  SKIP (already has CDP): " + $path) -ForegroundColor Gray
            continue
        }

        $backupPath = $path + ".bak"
        if (-not (Test-Path $backupPath)) {
            Copy-Item $path $backupPath
        }

        if ($oldArgs) {
            $shortcut.Arguments = $oldArgs + " " + $CDPArgs
        } else {
            $shortcut.Arguments = $CDPArgs
        }
        $shortcut.Save()
        Write-Host ("  PATCHED: " + $path) -ForegroundColor Green
        Write-Host ("    Args: " + $shortcut.Arguments) -ForegroundColor DarkGray
    } catch {
        Write-Host ("  FAILED: " + $path + " - " + $_.Exception.Message) -ForegroundColor Red
        Write-Host "  (Taskbar shortcuts may need Admin)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Done! Every Chrome launch now has CDP on port 9222." -ForegroundColor Green
Write-Host "Extensions, tabs, logins, 1Password all work normally." -ForegroundColor Green
Write-Host ""
Write-Host "To undo: rename .lnk.bak files back to .lnk" -ForegroundColor DarkGray

# Remove the stale Program Files Hermes install WITHOUT running its NSIS uninstaller.
#
# WHY NOT THE UNINSTALLER:
#   "C:\Program Files\Hermes\Uninstall Hermes.exe" is an NSIS/electron-builder
#   uninstaller. Those close the running app by EXE NAME. On this machine three
#   separate binaries are all named Hermes.exe / hermes.exe:
#     1. C:\Program Files\Hermes\Hermes.exe                      <- the one we want gone
#     2. ...\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe  <- Bill's LIVE Desktop
#     3. ...\hermes-agent\venv\Scripts\hermes.exe                 <- the active Hermes CLI
#   A kill-by-name step would take down (2) and (3) — the live Desktop and the
#   agent session driving this change. It may also delete the shared Electron
#   userData dir %APPDATA%\Hermes, which the GOOD build uses for window state,
#   composer prefs, and the localStorage layer.
#
#   So: delete the install directory and its all-users Start Menu tile directly,
#   then drop the Add/Remove Programs entry. Nothing outside C:\Program Files\Hermes
#   depends on it — verified:
#     * HKLM App Paths          -> 0 matches
#     * hermes:// protocol      -> already points at the win-unpacked build
#     * agent home, state.db, config, skills, cron -> all under %LOCALAPPDATA%\hermes
#
# PRE-FLIGHT ALREADY DONE (2026-08-10):
#   %LOCALAPPDATA%\hermes\backups\20260810-preuninstall\
#     Roaming-Hermes\      full Electron userData copy (307 files; only caches +
#                          zero-byte LOCK files skipped)
#     uninstall-key.reg    exported Add/Remove Programs key
#     pinned-sessions.json 13 pinned session ids from state.db
#
# SAFETY: this script touches ONLY paths under C:\Program Files\Hermes and the
# all-users Start Menu tile. It kills NOTHING. Run it elevated.
$ErrorActionPreference = 'Stop'

$installDir = 'C:\Program Files\Hermes'
$machineTile = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Hermes.lnk'
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\48ae4bdc-0f8d-5252-af1e-bf7c0a8c3649'

Write-Output '=== PRE-CHECK: refuse to run while a Program Files Hermes process is alive ==='
$pf = Get-Process -Name 'Hermes' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($installDir, 'OrdinalIgnoreCase') }
if ($pf) {
  Write-Output "ABORT: $($pf.Count) Program Files Hermes process(es) still running:"
  $pf | ForEach-Object { Write-Output "   PID $($_.Id)  $($_.Path)" }
  Write-Output 'Run the reaper first: python %LOCALAPPDATA%\hermes\scripts\hermes-pf-desktop-reaper.py'
  exit 1
}
Write-Output 'OK: no Program Files Hermes processes.'

Write-Output ''
Write-Output '=== SANITY: the good build and the CLI must be untouched by this script ==='
$good = Get-Process -Name 'Hermes' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like '*win-unpacked*' }
Write-Output "win-unpacked Desktop processes (leave alone): $($good.Count)"

Write-Output ''
Write-Output '=== 1. Remove the all-users Start Menu tile (targets the stale exe) ==='
if (Test-Path $machineTile) {
  Remove-Item -LiteralPath $machineTile -Force
  Write-Output "removed: $machineTile"
} else {
  Write-Output "already gone: $machineTile"
}

Write-Output ''
Write-Output '=== 2. Remove the install directory ==='
if (Test-Path $installDir) {
  $sizeMB = [math]::Round((Get-ChildItem -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum / 1MB, 1)
  Write-Output "deleting $installDir ($sizeMB MB)"
  Remove-Item -LiteralPath $installDir -Recurse -Force
  Write-Output 'removed.'
} else {
  Write-Output "already gone: $installDir"
}

Write-Output ''
Write-Output '=== 3. Drop the Add/Remove Programs entry ==='
if (Test-Path $uninstallKey) {
  Remove-Item -LiteralPath $uninstallKey -Recurse -Force
  Write-Output 'registry entry removed.'
} else {
  Write-Output 'registry entry already gone.'
}

Write-Output ''
Write-Output '=== VERIFY ==='
Write-Output "install dir exists : $(Test-Path $installDir)"
Write-Output "machine tile exists: $(Test-Path $machineTile)"
Write-Output "ARP entry exists   : $(Test-Path $uninstallKey)"
$stillGood = Get-Process -Name 'Hermes' -ErrorAction SilentlyContinue |
             Where-Object { $_.Path -and $_.Path -like '*win-unpacked*' }
Write-Output "win-unpacked Desktop still running: $($stillGood.Count)"
Write-Output 'DONE'

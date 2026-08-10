# Repoint Start Menu Hermes tiles at the canonical launcher.
#
# WHY: the ProgramData tile pointed at C:\Program Files\Hermes\Hermes.exe --
# the Jun-4 packaged build. That build (a) pins its backend to fixed port 9120
# so it races any real instance -> Errno 10048 -> the "setting up" window that
# dies, and (b) predates the pin-sync commits (Jul 31), so it cannot read pins
# from state.db and renders an empty Pinned section.
#
# Both tiles now launch Desktop\Hermes-Desktop.vbs, which holds the
# single-instance lock and reaps any Program Files tree.
$ErrorActionPreference = 'Stop'
$launcher = 'C:\Users\BuildASoil\Desktop\Hermes-Desktop.vbs'
$targets = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Hermes.lnk",
  'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Hermes.lnk'
)
$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in $targets) {
  if (-not (Test-Path $lnk)) { Write-Output "SKIP (missing): $lnk"; continue }
  try {
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath       = 'C:\Windows\System32\wscript.exe'
    $s.Arguments        = "//nologo `"$launcher`""
    $s.WorkingDirectory = 'C:\Users\BuildASoil\AppData\Local\hermes'
    $s.IconLocation     = 'C:\Users\BuildASoil\AppData\Local\hermes\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe,0'
    $s.Description      = 'Hermes Desktop (canonical launcher - default profile)'
    $s.Save()
    Write-Output "OK: $lnk"
  } catch {
    Write-Output "FAILED (needs admin?): $lnk :: $($_.Exception.Message)"
  }
}
# Verify
foreach ($lnk in $targets) {
  if (Test-Path $lnk) {
    $s = $shell.CreateShortcut($lnk)
    Write-Output "VERIFY $lnk => $($s.TargetPath) $($s.Arguments)"
  }
}

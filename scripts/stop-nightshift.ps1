# stop-nightshift.ps1
# Kills llama-server and nightshift-runner using saved PIDs.
# Called by Task Scheduler at 7:00 AM Mon-Fri (1 hour before 8 AM AP poll).

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile     = Join-Path $ProjectRoot "logs\nightshift.pid"

if (-not (Test-Path $PidFile)) {
    Write-Host "[nightshift] No PID file found at $PidFile — nothing to stop."
    exit 0
}

$Lines = Get-Content $PidFile
foreach ($Line in $Lines) {
    if (-not $Line.Trim()) { continue }
    $Parts = $Line -split ":"
    $Label = $Parts[0]
    $Pid   = [int]$Parts[1]

    $Proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    if ($Proc) {
        Write-Host "[nightshift] Stopping $Label (PID $Pid)..."
        Stop-Process -Id $Pid -Force
        Write-Host "[nightshift] $Label stopped."
    } else {
        Write-Host "[nightshift] $Label (PID $Pid) not found — already exited."
    }
}

Remove-Item $PidFile -Force
Write-Host "[nightshift] PID file removed. Nightshift stopped."

# ──────────────────────────────────────────────────────────────────────────────
# aria-pm2-health.ps1
#
# Daily health check invoked by the AriaPm2DailyHealth scheduled task.
# Restarts any aria-* pm2 process that is not in the "online" state.
# ──────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Continue"

try {
    $json = & pm2 jlist | ConvertFrom-Json
    foreach ($proc in $json) {
        if ($proc.name -like 'aria-*' -and $proc.pm2_env.status -ne 'online') {
            Write-Host "Restarting $($proc.name) (status=$($proc.pm2_env.status))"
            & pm2 restart $proc.name
        }
    }
} catch {
    Write-Error "Health check failed: $_"
    exit 1
}

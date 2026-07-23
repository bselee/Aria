# --- aria-pm2-health.ps1 ---
# Parses pm2 list table output to check aria-* process status.
# Avoids pm2 jlist JSON entirely due to duplicate-key issues with ConvertFrom-Json.
# ---

$ErrorActionPreference = "Continue"

try {
    $pm2Output = pm2 list --no-color 2>$null
    if (-not $pm2Output) {
        Write-Warning "pm2 list returned no output - is PM2 running?"
        exit 1
    }

    $anyRestarted = $false
    foreach ($line in $pm2Output) {
        if ($line -match '\|\s+\d+\s+\|\s+(aria-[\w-]+)\s+\|') {
            $name = $Matches[1]
            $parts = $line -split '\|'
            $status = ($parts[6] -replace '\s','').Trim()
            if ($status -ne 'online') {
                Write-Host "Restarting $name (status=$status)"
                pm2 restart $name
                $anyRestarted = $true
            }
        }
    }

    if (-not $anyRestarted) {
        Write-Host "All aria-* processes are online."
    }
} catch {
    Write-Error "Health check failed: $_"
    exit 1
}

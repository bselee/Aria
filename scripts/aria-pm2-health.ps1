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
    $ariaFound = 0
    foreach ($line in $pm2Output) {
        if ($line -match '\|\s+\d+\s+\|\s+(aria-[\w-]+)\s+\|') {
            $name = $Matches[1]
            $ariaFound++
            $parts = $line -split '\|'
            $status = ($parts[6] -replace '\s','').Trim()
            if ($status -ne 'online') {
                Write-Host "Restarting $name (status=$status)"
                pm2 restart $name
                $anyRestarted = $true
            }
        }
    }

    if ($ariaFound -eq 0) {
        # Empty pm2 list used to print "All online" and exit 0 -- that is
        # how the stack stayed down all morning after a daemon wipe.
        $eco = "C:\Users\BuildASoil\Documents\Projects\aria\ecosystem.config.json"
        Write-Warning "No aria-* processes in pm2 list -- starting $eco"
        pm2 start $eco
        $anyRestarted = $true
    }

    if (-not $anyRestarted) {
        Write-Host "All aria-* processes are online."
    }

    # Backup freshness check — ensure daily backups are still happening
    $backupLog = "C:\Users\BuildASoil\Documents\Projects\aria\backup\daily\backup.log"
    if (Test-Path $backupLog) {
        $lines = Get-Content $backupLog | Select-String 'OK:'
        if ($lines) {
            $last = $lines[-1]
            if ($last -match '\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]') {
                $lastDate = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null)
                $age = (Get-Date) - $lastDate
                if ($age.TotalHours -gt 30) {
                    Write-Warning ("Backup STALE: last OK was " + [math]::Round($age.TotalHours) + "h ago")
                } else {
                    Write-Host ("Backup OK: last dump " + [math]::Round($age.TotalHours) + "h ago")
                }
            }
        } else {
            Write-Warning "Backup WARNING: no successful backup found in log"
        }
    } else {
        Write-Warning "Backup WARNING: backup.log not found at $backupLog"
    }
} catch {
    Write-Error "Health check failed: $_"
    exit 1
}

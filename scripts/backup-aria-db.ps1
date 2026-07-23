#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Daily backup of the Aria PostgreSQL database to a rolling 7-day archive.
.DESCRIPTION
    Uses pg_dump (PostgreSQL 16 Windows native) to create a compressed custom-format
    dump, then prunes backups older than 7 days. Logs to backup/daily/backup.log.
    Intended to run as a daily Windows scheduled task.
.PARAMETER BackupDir
    Directory to store backups. Defaults to project root's backup/daily/ folder.
.PARAMETER RetentionDays
    Number of days to retain backups. Default 7.
#>

param(
    [string]$BackupDir = "$PSScriptRoot\..\backup\daily",
    [int]$RetentionDays = 7
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dumpFile = Join-Path $BackupDir "aria-$timestamp.dump"
$logFile = Join-Path $BackupDir "backup.log"

# Ensure backup directory exists
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$pgDump = "${env:ProgramFiles}\PostgreSQL\16\bin\pg_dump.exe"

if (-not (Test-Path $pgDump)) {
    $msg = "[$now] ERROR: pg_dump not found at $pgDump"
    Add-Content -Path $logFile -Value $msg
    Write-Error $msg
    exit 1
}

try {
    $env:PGPASSWORD = 'arialocal'
    & $pgDump -U aria -h 127.0.0.1 -p 5432 -d aria -Fc -Z 6 -f $dumpFile 2>&1
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump exited with code $LASTEXITCODE"
    }

    $size = "{0:N2}" -f ((Get-Item $dumpFile).Length / 1MB)
    $msg = "[$now] OK: $dumpFile ($size MB)"
    Add-Content -Path $logFile -Value $msg
    Write-Host $msg

    # Prune old backups
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    $removed = 0
    Get-ChildItem -Path $BackupDir -Filter "aria-*.dump" | Where-Object {
        $_.LastWriteTime -lt $cutoff
    } | ForEach-Object {
        Remove-Item $_.FullName -Force
        $removed++
    }
    if ($removed -gt 0) {
        $msg = "[$now] Pruned $removed old backup(s)"
        Add-Content -Path $logFile -Value $msg
        Write-Host $msg
    }

    exit 0
}
catch {
    $msg = "[$now] FAILED: $_"
    Add-Content -Path $logFile -Value $msg
    Write-Error $msg
    exit 1
}

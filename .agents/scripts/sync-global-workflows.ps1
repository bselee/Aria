<#
.SYNOPSIS
    Copies global Antigravity workflows into the project .agents/workflows/ dir.
.DESCRIPTION
    Run this whenever you update global workflows and want the project to pick them up.
    Uses MD5 hash comparison to skip files that are already current.
.NOTES
    Author:  Will
    Created: 2026-03-10
    Updated: 2026-03-10
#>

# -- Config -------------------------------------------------------------------
$GlobalDir = "$env:USERPROFILE\.gemini\antigravity\global_workflows"
$ProjectDir = "$PSScriptRoot\..\workflows"

# Files to sync — add new global workflows here as needed
# migration.md is excluded because the project has a customized version
$WorkflowFiles = @(
    "github.md",
    "debug-fix.md",
    "plan-fix.md",
    "test-fix-loop.md",
    "test-loop.md"
)

# -- Preflight ----------------------------------------------------------------
if (-not (Test-Path $GlobalDir)) {
    Write-Error "Global workflows directory not found: $GlobalDir"
    exit 1
}

if (-not (Test-Path $ProjectDir)) {
    New-Item -ItemType Directory -Path $ProjectDir -Force | Out-Null
}

# -- Sync ---------------------------------------------------------------------
$synced = 0
$skipped = 0

foreach ($file in $WorkflowFiles) {
    $source = Join-Path $GlobalDir $file
    $target = Join-Path $ProjectDir $file

    if (-not (Test-Path $source)) {
        Write-Warning "Source not found, skipping: $file"
        $skipped++
        continue
    }

    # Only copy if source differs or target does not exist
    if (Test-Path $target) {
        $sourceHash = (Get-FileHash $source -Algorithm MD5).Hash
        $targetHash = (Get-FileHash $target -Algorithm MD5).Hash
        if ($sourceHash -eq $targetHash) {
            Write-Host "  Already current: $file" -ForegroundColor DarkGray
            $skipped++
            continue
        }
    }

    Copy-Item $source $target -Force
    Write-Host "  Synced: $file" -ForegroundColor Green
    $synced++
}

# -- Summary ------------------------------------------------------------------
Write-Host ""
Write-Host "-- Sync complete --" -ForegroundColor Cyan
Write-Host "  Synced:  $synced"
Write-Host "  Skipped: $skipped (already current or missing)"
Write-Host "  Target:  $ProjectDir"

if ($synced -gt 0) {
    Write-Host ""
    Write-Host "  Note: synced files may need frontmatter added if the global source lacks it." -ForegroundColor Yellow
}

# Hermes Cron Ownership

**Last cleanup:** 2026-07-13  
**Owner:** Hermia (default profile gateway)  
**Canonical snapshot:** `docs/operational-guides/hermes-cron-jobs.canonical.json`

## Rule

One live scheduler only: **default profile** (`~/AppData/Local/hermes/cron/jobs.json`).

Specialist profiles (`hermia`, `aria-ap`, `aria-research`, …) must keep **empty** cron stores. Profile clones previously duplicated the same job names 3–4× and made the desktop UI show ~77 jobs.

| Profile | Cron role |
|---------|-----------|
| **default** | Sole live schedule (gateway running) |
| **hermia** | Empty — Hermia agent manages default schedule |
| **aria-ap / aria-research / …** | Empty — no system-wide watchdogs |

## Live set (24 jobs)

| Name | Schedule | Mode |
|------|----------|------|
| ap-pipeline-watchdog | `3,33 * * * *` | script |
| aria-bot-alive | `*/15 * * * *` | script |
| aria-cron-health | `*/30 * * * *` | script |
| aria-daily-health-report | `0 9 * * *` | script |
| aria-dashboard-health | `*/15 * * * *` | script |
| aria-oversight | `8,38 * * * *` | agent |
| basauto-poll | `0 6 * * *` | agent |
| desktop-log-watchdog | every 240m | agent |
| email-files-watchdog | `3,33 * * * *` | script |
| gateway-health-watchdog | `*/5 * * * *` | script |
| hermes-startup-health-check | `0 6 * * *` | agent |
| hermes-statedb-watchdog | `0 */6 * * *` | script |
| hermia-auth-recovery | `0 2 * * *` | agent |
| honcho-health-watchdog | `*/30 * * * *` | agent |
| honcho-obsidian-sync | `0 6 * * *` | agent |
| honcho-pg-backup | `0 3 * * *` | agent |
| honcho-wsl-watchdog | `*/10 * * * *` | script |
| mcp-orphan-killer | every 120m | agent |
| precision-guardrails | `5,35 * * * *` | script |
| purchasing-watchdog | `3,33 * * * *` | script |
| session-orphan-recovery | every 360m | agent |
| Tracking Validation Autopilot | `*/30 * * * *` | agent |
| tracking-watchdog | `3,33 * * * *` | script |
| warm-purchasing-cache | `0 6 * * 1-5` | agent |

Scripts live under `~/AppData/Local/hermes/scripts/` (no-agent jobs resolve here under the default gateway).

## Restore

If jobs are lost or re-cloned across profiles:

```bash
# 1) Restore default from this snapshot
cp docs/operational-guides/hermes-cron-jobs.canonical.json \
  "$HOME/AppData/Local/hermes/cron/jobs.json"

# 2) Empty specialist profiles
for p in hermia aria-ap aria-research; do
  printf '%s\n' '{"jobs":[],"updated_at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' \
    > "$HOME/AppData/Local/hermes/profiles/$p/cron/jobs.json"
done

# 3) Verify
hermes cron list
hermes cron status
```

Backups from the 2026-07-13 cleanup:
`~/AppData/Local/hermes/cron/cleanup-backups-20260713_154144/`

## Anti-patterns

- Do **not** `hermes profile create --clone` and leave cron jobs on the clone.
- Do **not** re-create the same named job from multiple profiles.
- Do **not** start a second profile gateway that ticks the same Aria ops jobs.
- Drop stale one-shot jobs (`kind: once` in the past) instead of leaving them enabled.

## Verify

```bash
hermes cron status   # expect ~24 active on default
# Aggregate across profiles should equal default count:
python -c "
import json
from pathlib import Path
home = Path.home() / 'AppData/Local/hermes'
paths = [home/'cron/jobs.json'] + list((home/'profiles').glob('*/cron/jobs.json'))
n = 0
for p in paths:
    if p.exists():
        n += len(json.loads(p.read_text()).get('jobs', []))
print('aggregate jobs:', n)
"
```

Expected: **aggregate jobs: 24** (all on default).

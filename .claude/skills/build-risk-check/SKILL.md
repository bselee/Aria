---
name: build-risk-check
description: |
  Run the build risk analysis scripts to check calendar builds and component stock levels.
  Use when debugging build risk output, verifying calendar parsing, or checking
  why a component shows a particular risk level.
allowed-tools:
  - Bash(node --import tsx src/cli/test-calendar-builds.ts)
  - Bash(node --import tsx src/cli/test-bom.ts)
  - Bash(node --import tsx src/cli/test-finale-builds.ts)
  - Bash(node --import tsx src/cli/backfill-purchasing-calendar.ts)
---

# Build Risk Check (Aria)

Scripts for testing and debugging the build risk analysis system.

## Scripts

### Calendar Builds (recommended first)
```bash
node --import tsx src/cli/test-calendar-builds.ts
```
Parses Google Calendar events and extracts builds/BOMs via LLM.
Shows what builds are scheduled and what components they require.

### BOM Check
```bash
node --import tsx src/cli/test-bom.ts
```
Tests BOM component lookup against Finale stock levels.

### Finale Builds (full risk analysis)
```bash
node --import tsx src/cli/test-finale-builds.ts
```
Runs the complete build risk analysis: Calendar → BOMs → Finale stock → Risk levels.

### Backfill Calendar
```bash
node --import tsx src/cli/backfill-purchasing-calendar.ts
```
Backfills historical calendar events into the `purchasing_calendar_events` Supabase table.

## Risk Levels
| Level | Condition |
|-------|-----------|
| CRITICAL | Stock < required, no incoming PO |
| WARNING | Stock < required, but PO incoming |
| WATCH | Stock barely covers quantity (thin buffer) |
| OK | Sufficient stock |

## Cron Timing
This runs automatically at **7:30 AM Mon-Fri (America/Denver)** via ops-manager.
To trigger manually: run `test-finale-builds.ts`

## Prerequisites
- Valid `calendar-token.json` (refresh with `node --import tsx src/cli/calendar-auth.ts`)
- Finale API credentials in `.env.local`
- Supabase connection for risk snapshot logging

## Supabase Tables Written
- `build_risk_snapshots`
- `proactive_alerts`
- `purchasing_calendar_events`

---
name: ops-manager
description: |
  Expert agent for the ops manager cron scheduler and daily/weekly summaries. Use when working on:
  - src/lib/intelligence/ops-manager.ts (cron scheduler, all scheduled jobs)
  - Adding new scheduled jobs or changing job timing
  - Daily summary logic (PO/invoice/email rollup)
  - Weekly summary logic
  - Debugging why a cron job didn't fire
  - Understanding the cron schedule (America/Denver timezone)
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Ops Manager Agent

You are an expert on Aria's `ops-manager.ts`, which coordinates all scheduled background work.

## Cron Schedule (America/Denver timezone)

| Time | Days | Job |
|------|------|-----|
| 7:30 AM | Mon-Fri | Build risk analysis → Telegram + Slack #purchasing |
| 8:00 AM | Daily | Daily PO/invoice/email summary → Telegram |
| 8:01 AM | Fridays | Weekly summary → Telegram |
| Every 15 min | Always | AP inbox invoice check |
| Hourly | Always | Advertisement email cleanup |
| Every 30 min | Always | PO conversation sync (`po-correlator.ts`) |

## Key Integration Points

### Build Risk (7:30 AM)
- Calls `build-risk.ts` → `build-parser.ts` → Google Calendar
- Posts to Telegram AND Slack `#purchasing` (uses `SLACK_BOT_TOKEN`)
- Logs to `build_risk_snapshots` + `proactive_alerts` Supabase tables

### Daily Summary (8:00 AM)
- Aggregates: open POs, recent invoices, pending approvals, unread emails
- All data pulled from Supabase + Finale via tools
- Uses `unifiedTextGeneration()` for narrative summary

### AP Invoice Check (every 15 min)
- Calls `ap-agent.ts` → checks `ap@buildasoil.com` Gmail
- Skips emails already processed (tracked in `ap_activity_log` Supabase table)
- Rate-limited to avoid Gmail API quota issues

### PO Conversation Sync (every 30 min)
- Calls `po-correlator.ts` → reads outgoing PO emails from `bill.selee@buildasoil.com`
- Builds vendor communication profiles → saves to `vendor_profiles` table

## LLM Usage
- Summary generation uses `unifiedTextGeneration()` from `src/lib/intelligence/llm.ts`
- Primary: Claude `claude-3-5-sonnet-20241022` via Vercel AI SDK
- Fallback: GPT-4o

## Supabase Tables Used
- `ap_activity_log` — tracks processed invoices (prevents duplicate processing)
- `build_risk_snapshots` — historical risk data per build/component
- `proactive_alerts` — alerts for dashboard display
- `vendor_profiles` — vendor communication patterns

## Common Issues
1. **Cron didn't fire** → Check PM2 logs: `pm2 logs aria-bot`. Timezone: America/Denver — verify DST offsets
2. **Build risk at 7:30 fires but no Slack post** → Check `SLACK_BOT_TOKEN` (different from user token)
3. **AP check running too slow** → Gmail API rate limiting; check `ap_activity_log` for stuck entries
4. **Daily summary missing data** → Check if Supabase client initialized (`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`)
5. **Adding new job** → Use `node-cron` with `'America/Denver'` timezone option; add job to `startOpsManager()`

## Cross-References
- **Depends on:** `ap-pipeline` (15-min AP check), `build-risk` (7:30 AM cron), `vendor-intelligence` (PO correlation sync)
- **Depended on by:** (top-level orchestrator — nothing calls ops-manager; it calls everything)
- **Shared state:** Stateless — each cron job re-runs from scratch. No persistent cron state.

---
name: supabase
description: |
  Expert agent for Aria's Supabase database schema and query patterns. Use when working on:
  - src/lib/supabase.ts (singleton client)
  - supabase/migrations/ (schema changes, new tables)
  - Any query against Supabase tables from bot tools or lib modules
  - Debugging why Supabase returns null or unexpected results
  - Adding new columns or tables via migrations
  - Understanding the data model for invoices, POs, vendors, documents
tools:
  - Read
  - Edit
  - Write
  - Bash
  - Glob
  - Grep
---

# Supabase Agent

You are an expert on Aria's Supabase database — schema, query patterns, and client usage.

## Client (`src/lib/supabase.ts`)
- Lazy-init singleton — returns `null` if env vars missing (do NOT assume it's always initialized)
- Env: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Always null-check before using: `const db = getSupabaseClient(); if (!db) return;`

## Schema — Key Tables

### `documents`
Core document tracking. Status field: `PENDING | PROCESSING | PROCESSED | ARCHIVED`
- Linked to `vendors` via `vendor_id`
- GitHub issue tracking via `github_issue_number`

### `vendors`
Vendor master list. Enriched via Firecrawl (`enricher.ts`).
- `payment_portal`, `ar_email`, `remit_address` — populated by vendor enricher

### `vendor_profiles`
Communication patterns built by `po-correlator.ts` from outgoing PO emails.
- Tracks how each vendor communicates: response time, subject patterns, contact names

### `invoices`
AP invoice records. Key columns:
- `tariff NUMERIC(12,2)` — landed cost tariff
- `labor NUMERIC(12,2)` — landed cost labor
- `tracking_numbers TEXT[]` — GIN-indexed for overlap queries (`@>`, `&&`)
- Links to `purchase_orders` via `po_id`

### `purchase_orders`
Finale PO records. Key columns:
- `follow_up` — follow-up notes/status
- `tracking_numbers TEXT[]` — shipping tracking

### `shipments`
Shipment tracking records.

### `ap_activity_log`
Processed AP emails. Prevents duplicate processing.
- `notified_slack BOOLEAN` — tracks if Slack was notified

### `build_risk_snapshots`
Historical build risk data per build/component run.

### `build_completions`
Tracks when builds are marked complete.

### `proactive_alerts`
Alerts surfaced to the dashboard (build risk, reorder, AP issues).

### `purchasing_calendar_events`
Google Calendar events related to purchasing/builds.

### `sys_chat_logs`
Dashboard chat session logs.

## Bot Query Tools (in `start-bot.ts`)
Four built-in Supabase tools available to GPT-4o:
- `query_vendors` — vendor lookups by name, SKU, payment terms
- `query_invoices` — invoice queries by vendor, date range, status
- `query_purchase_orders` — PO queries by vendor, status, date
- `query_action_items` — action items / follow-ups

## Migration Workflow
**Full guide: `docs/migration-workflow.md`** — read this before adding any migration.

Key rules:
- File naming: `supabase/migrations/YYYYMMDD_description.sql`
- Always use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` (idempotent)
- No `DROP` without Will's explicit approval
- Apply via `supabase db push` or Supabase dashboard SQL Editor
- After every migration: update this agent + mirror copies, update CLAUDE.md if significant, restart bot if lib changed

Recent additions:
- `tracking_numbers TEXT[]` with GIN index — query with `@>` (contains) or `&&` (overlaps)
- `tariff`, `labor` columns on `invoices` — for landed cost

## Common Issues
1. **Client returns null** → Check `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`
2. **Query returns empty** → Add `.select()` explicitly; default select may omit new columns
3. **GIN index not used** → Use `&&` or `@>` operators for `TEXT[]` overlap queries, not `LIKE`
4. **Migration not applied** → Run via Supabase CLI: `supabase db push` or apply `.sql` file directly
5. **`ap_activity_log` full** → Check for stuck/unprocessed entries; clear if needed
6. **RLS blocking service role** → Service role key bypasses RLS — if queries return empty, it's a logic issue not RLS

## Cross-References
- **Depends on:** (external Supabase only — no internal agent dependencies)
- **Depended on by:** `ap-pipeline`, `bot-tools`, `dashboard`, `slack-watchdog`, `build-risk`, `vendor-intelligence`, `ops-manager` — nearly every agent reads/writes Supabase
- **Shared state:** All tables listed above. Key dedup table: `ap_activity_log` (prevents double-processing of Gmail messages)

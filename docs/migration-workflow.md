# Supabase Migration Workflow

> Full guide for creating, applying, and verifying Supabase schema migrations in the Aria project.

## Quick Reference: Current Schema

| Table | Purpose |
|-------|---------|
| `ap_activity_log` | AP Agent email processing audit trail — every action logged here |
| `build_completions` | Completed MFG builds tracked from Finale → Calendar sync |
| `build_risk_snapshots` | Daily BOM risk analysis snapshots per build |
| `invoices` | Parsed invoice data from AP inbox (PDF extraction results) |
| `outside_thread_alerts` | Slack thread alerts for @mentions outside monitored channels |
| `proactive_alerts` | Proactive Telegram/Slack alerts triggered by agent intelligence |
| `purchase_orders` | Synced PO data from Finale for dashboard/reconciliation |
| `purchasing_calendar_events` | PO → Google Calendar event mapping for sync dedup |
| `sys_chat_logs` | Dashboard chat conversation history |
| `vendor_profiles` | Vendor intelligence — reconciliation patterns, auto-approve thresholds |

---

## Naming Convention

```
supabase/migrations/YYYYMMDD_descriptive_snake_case.sql
```

**Examples:**
- `20260304_add_reconciliation_review_columns.sql`
- `20260304_vendor_profile_autonomy.sql`
- `20260302_create_build_risk_snapshots.sql`

**Rules:**
- Date prefix = the day the migration is written (Mountain Time)
- Name describes WHAT changes, not WHY
- One migration per logical change — don't bundle unrelated ALTER TABLEs

---

## SQL Structure Rules

Every migration file must follow this template:

```sql
-- Migration: <short description>
-- Created: YYYY-MM-DD
-- Purpose: <1-2 sentence explanation of why this change is needed>
-- Rollback: <exact SQL to undo this migration>
--
-- DECISION(YYYY-MM-DD): <context for non-obvious choices>

-- The actual DDL
ALTER TABLE <table>
ADD COLUMN IF NOT EXISTS <col> <type> DEFAULT <default>;

-- Comments for non-obvious columns
COMMENT ON COLUMN <table>.<col> IS '<description>';
```

**Non-negotiable:**
- Use `IF NOT EXISTS` / `IF EXISTS` guards — migrations MUST be idempotent (safe to re-run)
- Include rollback SQL in comments at the top
- Include a `DECISION()` comment for any non-trivial schema choice
- Never `DROP TABLE` or `DROP COLUMN` without explicit human approval in the same conversation
- Never modify column types or constraints on production data without a data migration plan

---

## How to Apply

### Step 1: Review the SQL

```bash
cat supabase/migrations/<filename>.sql
```

Read it. Understand it. Get human approval if it touches existing data.

### Step 2: Run the migration

From the **project root** (`c:\Users\BuildASoil\Documents\Projects\aria`):

```bash
node _run_migration.js supabase/migrations/<filename>.sql
```

Multiple files at once:

```bash
node _run_migration.js supabase/migrations/file1.sql supabase/migrations/file2.sql
```

**How `_run_migration.js` works** (in order):
1. **DATABASE_URL pooler** — uses the Supabase connection pooler at `aws-0-*.pooler.supabase.com:6543`. This is the primary method and works reliably.
2. **Direct pg** — tries `db.PROJECT_REF.supabase.co:5432` (currently DNS-blocked in this environment)
3. **Supabase Management API** — uses `SUPABASE_ACCESS_TOKEN` if set
4. **Fallback** — prints the SQL for manual paste into the [Supabase SQL Editor](https://supabase.com/dashboard/project/wvpgkyrbhvywdxnuxymn/sql/new)

### Step 3: Verify

After applying, verify the columns exist:

```bash
node _verify_schema.js
```

Or check specific columns in the Supabase dashboard → Table Editor.

---

## What to Update After a Migration

After applying a migration, update these (in the same commit):

1. **This file** — add the new table or columns to the Quick Reference table above
2. **TypeScript types** — update any `interface` or `type` definitions that reference the changed table
3. **Supabase queries** — verify `.select()` calls include new columns where needed
4. **Dashboard components** — if new columns power UI features, ensure the component expects them
5. **Migration file** — commit the `.sql` file itself to `supabase/migrations/`

---

## Common Mistakes to Avoid

| Mistake | Why It's Bad | Instead |
|---------|--------------|---------|
| Missing `IF NOT EXISTS` | Migration fails on second run | Always use `ADD COLUMN IF NOT EXISTS` |
| Running from `/tmp/` | Node can't find `dotenv` or `pg` in `node_modules` | Always run from project root |
| Using direct `db.*` hostname | DNS-blocked in this environment | Use `DATABASE_URL` (pooler) |
| Bundling unrelated changes | Hard to rollback, hard to bisect | One migration per logical change |
| Dropping columns without rollback plan | Data loss is permanent | Document rollback SQL, get approval |
| Forgetting to update TypeScript types | Runtime errors when querying new columns | Update types in same commit |
| Using `NOT NULL` without `DEFAULT` on existing tables | Fails if table has existing rows | Always include `DEFAULT` or allow NULL |
| Putting secrets in migration SQL | Exposed in git history forever | Use env vars, never hardcode |

---

## Environment Variables

| Var | Purpose | Required |
|-----|---------|----------|
| `DATABASE_URL` | Pooler connection string (primary) | ✅ |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL for ref extraction | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Fallback auth for direct pg | ✅ |
| `SUPABASE_DB_PASSWORD` | Direct pg password (if different) | Optional |
| `SUPABASE_ACCESS_TOKEN` | Management API personal token | Optional |

---

*Last updated: 2026-03-04. See also: [`.agents/workflows/migration.md`](../.agents/workflows/migration.md) for the agent-facing workflow steps.*

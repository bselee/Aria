---
description: SQL Migration Flow — how to create, apply, and verify Supabase migrations
---
// turbo-all

# SQL Migration Flow

> **Supabase CLI** is installed as a dev dependency (`npx supabase`). Always use it.
>
> **Non-destructive migrations** (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) → **apply automatically without asking for approval.**
>
> **Destructive migrations** (DROP, ALTER TYPE, DELETE data) → **always ask Will first.**


## 1. Create the Migration File

Create a new `.sql` file in `supabase/migrations/` following the naming convention:

```
supabase/migrations/YYYYMMDD_descriptive_name.sql
```

**Rules:**
- Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for additive changes (safe to re-run)
- Include a `DECISION()` comment explaining WHY
- Include rollback SQL in a comment block at the top
- Include `COMMENT ON COLUMN` for any non-obvious column purposes
- Never use `DROP TABLE` or `DROP COLUMN` without explicit human approval

**Example:**
```sql
-- Migration: Add review tracking to ap_activity_log
-- Created: 2026-03-04
-- Rollback: ALTER TABLE ap_activity_log DROP COLUMN IF EXISTS reviewed_at, ...
--
-- DECISION(2026-03-04): Dashboard needs to track approve/dismiss state
-- independently of the Telegram bot's in-memory approval Map.
ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_action TEXT;
```

## 2. Show the Schema Diff

Before applying, always show the user what will change:

```
cat supabase/migrations/<filename>.sql
```

Get explicit approval before proceeding.

## 3. Apply the Migration

// turbo-all

Run migrations using the project's `_run_migration.js` helper from the **project root** so `node_modules` resolves correctly:

```powershell
node _run_migration.js supabase/migrations/<filename>.sql
```

If `_run_migration.js` does not exist or fails, create/apply using this inline approach from the project root:

```powershell
node -e "const fs=require('fs');require('dotenv').config({path:'.env.local'});const{Client}=require('pg');const ref=process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)/)[1];const sql=fs.readFileSync(process.argv[1],'utf-8');(async()=>{const c=new Client({host:`db.${ref}.supabase.co`,port:5432,database:'postgres',user:'postgres',password:process.env.SUPABASE_DB_PASSWORD||process.env.SUPABASE_SERVICE_ROLE_KEY,ssl:{rejectUnauthorized:false}});await c.connect();await c.query(sql);console.log('✅ Applied: '+process.argv[1]);await c.end();})()" supabase/migrations/<filename>.sql
```

**Fallback:** If `pg` module is not installed, output the SQL for the user to paste into the [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql).

## 4. Verify the Migration

After applying, verify the columns/tables exist:

```powershell
node -e "require('dotenv').config({path:'.env.local'});const{Client}=require('pg');const ref=process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)/)[1];(async()=>{const c=new Client({host:`db.${ref}.supabase.co`,port:5432,database:'postgres',user:'postgres',password:process.env.SUPABASE_DB_PASSWORD||process.env.SUPABASE_SERVICE_ROLE_KEY,ssl:{rejectUnauthorized:false}});await c.connect();const r=await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='<TABLE_NAME>' ORDER BY ordinal_position`);console.table(r.rows);await c.end();})()"
```

Replace `<TABLE_NAME>` with the table that was altered.

## 5. Post-Migration Checklist

- [ ] Update `.agents/agents/supabase.md` if a new table or significant column was added
- [ ] Update `CLAUDE.md` → Database Schema section if significant
- [ ] If the new table involves vendor invoices → **MANDATORY:** wire `upsertVendorInvoice()` per `.agents/workflows/vendor-invoice-archive.md`
- [ ] `pm2 restart aria-bot` if the migration affects running lib code

## 6. Commit

Stage the migration file and commit:

```
git add supabase/migrations/<filename>.sql
git commit -m "chore(db): apply <descriptive_name> migration"
```

## Notes

- **All migrations are additive** — never destructive without explicit approval
- **IF NOT EXISTS** guards make migrations idempotent (safe to re-run)
- The `pg` npm package must be installed (`npm install pg` if missing)
- Database password: uses `SUPABASE_DB_PASSWORD` env var, falls back to `SUPABASE_SERVICE_ROLE_KEY`

## Known Limitations

- **`DATABASE_URL` pooler is the primary connection method** — uses `aws-0-us-west-2.pooler.supabase.com:6543`. This works reliably and is Strategy 0 in `_run_migration.js`.
- **Direct pg connection is DNS-blocked** in this environment (`db.*.supabase.co` does not resolve). `_run_migration.js` falls through to pooler automatically.
- **Supabase Management API** requires a `SUPABASE_ACCESS_TOKEN` env var (personal access token from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)). Optional — pooler handles most cases.
- **Last resort fallback:** Paste SQL into the [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql/new). The script outputs formatted SQL ready to copy-paste.
- **Full docs:** See [docs/migration-workflow.md](../docs/migration-workflow.md) for the complete guide, schema reference, and common mistakes.

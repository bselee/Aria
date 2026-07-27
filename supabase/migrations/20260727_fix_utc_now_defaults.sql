-- @file supabase/migrations/20260727_fix_utc_now_defaults.sql
-- @purpose Fix timestamptz columns whose DEFAULT was timezone('utc', now()).
--          On this server (TimeZone = America/Denver) that expression returns a
--          NAIVE timestamp holding UTC wall-clock, which Postgres then coerces
--          back into timestamptz by assuming LOCAL time — storing an instant
--          6 hours in the FUTURE (7 in MST). Result: rows dated ahead of now(),
--          which breaks "today" windows, ORDER BY created_at DESC recency,
--          gte(created_at, todayStart) dedupe lookups, and SLA/aging math.
-- @author Hermia
-- @created 2026-07-27
-- @deps none
-- @env none
--
-- now() already returns timestamptz in correct UTC-anchored form. The cast to
-- ::timestamptz is implicit for a timestamptz column, so plain now() is correct.
--
-- Rollback: re-apply timezone('utc'::text, now()) as the default (not advised).

BEGIN;

ALTER TABLE public.ap_activity_log      ALTER COLUMN created_at   SET DEFAULT now();
ALTER TABLE public.axiom_demand_queue   ALTER COLUMN created_at   SET DEFAULT now();
ALTER TABLE public.axiom_demand_queue   ALTER COLUMN updated_at   SET DEFAULT now();
ALTER TABLE public.build_completions    ALTER COLUMN created_at   SET DEFAULT now();
ALTER TABLE public.build_risk_snapshots ALTER COLUMN generated_at SET DEFAULT now();
ALTER TABLE public.proactive_alerts     ALTER COLUMN alerted_at   SET DEFAULT now();
ALTER TABLE public.purchasing_snapshots ALTER COLUMN generated_at SET DEFAULT now();
ALTER TABLE public.sys_chat_logs        ALTER COLUMN created_at   SET DEFAULT now();

-- Backfill: shift the already-corrupted future-dated rows back by the exact
-- local UTC offset that produced them.
--
-- SIGN NOTE (learned the hard way 2026-07-27): the offset must be computed as
--   timezone('utc', now())::timestamptz - now()   -> +6h (POSITIVE in MDT)
-- NOT the reverse, which is -6h and would push rows FURTHER into the future.
-- Only rows still in the future are touched, so this is idempotent and safe to
-- re-run: once corrected, the WHERE clause matches nothing.
UPDATE public.ap_activity_log
   SET created_at = created_at - o.utc_offset
  FROM (SELECT (timezone('utc', now())::timestamptz - now()) AS utc_offset) o
 WHERE created_at > now();

UPDATE public.build_completions
   SET created_at = created_at - o.utc_offset
  FROM (SELECT (timezone('utc', now())::timestamptz - now()) AS utc_offset) o
 WHERE created_at > now();

UPDATE public.build_risk_snapshots
   SET generated_at = generated_at - o.utc_offset
  FROM (SELECT (timezone('utc', now())::timestamptz - now()) AS utc_offset) o
 WHERE generated_at > now();

UPDATE public.sys_chat_logs
   SET created_at = created_at - o.utc_offset
  FROM (SELECT (timezone('utc', now())::timestamptz - now()) AS utc_offset) o
 WHERE created_at > now();

COMMIT;

NOTIFY pgrst, 'reload schema';

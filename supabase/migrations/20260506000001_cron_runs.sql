-- supabase/migrations/20260506000001_cron_runs.sql
--
-- Extends the existing cron_runs table (from 20260415_create_ops_control_plane.sql)
-- with three columns the new src/cron/ registry needs:
--
--   invoked_by      cron | manual | dependency
--   failure_reason  short machine-readable code (concurrency-locked, duration-exceeded, …)
--   metadata_jsonb  correlation id + any extra structured context
--
-- Existing columns we reuse as-is:
--   task_name       → JobDef.name
--   status          → 'running'|'succeeded'|'failed'|'cancelled'|'skipped'
--   started_at, finished_at, duration_ms
--   error_message   → human-readable failure detail
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-running is safe.

ALTER TABLE public.cron_runs
    ADD COLUMN IF NOT EXISTS invoked_by      TEXT NOT NULL DEFAULT 'cron'
        CHECK (invoked_by IN ('cron', 'manual', 'dependency')),
    ADD COLUMN IF NOT EXISTS failure_reason  TEXT,
    ADD COLUMN IF NOT EXISTS metadata_jsonb  JSONB;

-- Widen the status CHECK constraint to allow 'skipped' and 'cancelled' which
-- the new framework emits (existing constraint allowed any TEXT — confirm by inspection).
-- If a CHECK exists on status, we drop and re-add. Otherwise this is a no-op.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'cron_runs' AND att.attname = 'status' AND con.contype = 'c'
    LIMIT 1;
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.cron_runs DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

-- Constraint allows both legacy values ('success', 'error') and new framework
-- values ('succeeded', 'failed', 'cancelled', 'skipped'). Old rows stay readable;
-- new code writes the new vocabulary. Tighten later once legacy rows age out.
ALTER TABLE public.cron_runs
    ADD CONSTRAINT cron_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'skipped', 'success', 'error'));

-- Index for the /jobs lastRun lookup (latest row per task).
CREATE INDEX IF NOT EXISTS cron_runs_task_started_desc_idx
    ON public.cron_runs (task_name, started_at DESC);

COMMENT ON COLUMN public.cron_runs.invoked_by IS
    'How this run was triggered. cron=scheduled tick, manual=/run command, dependency=downstream of dependsOn.';
COMMENT ON COLUMN public.cron_runs.failure_reason IS
    'Machine-readable failure code (concurrency-locked, duration-exceeded, dependency-not-succeeded, handler-threw, disabled).';
COMMENT ON COLUMN public.cron_runs.metadata_jsonb IS
    'Free-form structured context. Always includes correlationId.';

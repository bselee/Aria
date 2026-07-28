--
-- @file    20260728_retention_email_and_cron.sql
-- @purpose Add retention to email_inbox_queue (auto-null bodies on terminal status)
--          and cron_runs (age-based cleanup). Both tables had bloat / unbounded growth.
--
--   email_inbox_queue:
--     1479 rows, 108 MB heap (only ~4.4 MB live data = 4% utilization).
--     body_text / body_snippet columns hold bulk of per-row payload.
--     All rows currently 'unprocessed'; once status turns 'completed' or 'failed'
--     the trigger below nulls the payload columns to keep heap lean.
--
--   cron_runs:
--     126 K rows, 44 MB heap + 26 MB indexes.
--     Only 1000 rows older than 30 days (116 KB data), but growing at ~66 K/week
--     with a 99.96 % failure rate. Retention window prevents unbounded accumulation.
--
-- @author  Hermia
-- @created 2026-07-28
-- @deps    email_inbox_queue, cron_runs
-- @env     local, any PostgREST-backed env
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_email_inbox_queue_retention ON email_inbox_queue;
--   DROP FUNCTION IF EXISTS fn_email_inbox_queue_retention();
--   DROP INDEX IF EXISTS idx_email_inbox_queue_status;
--   DROP INDEX IF EXISTS idx_cron_runs_started_at;
--   -- The DELETEs and NULLs are one-way by design; there is no rollback of data loss.
--   -- Restore from backups/retention-20260728/ if needed.
--

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1. EMAIL_INBOX_QUEUE — add status index for efficient lookups
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_email_inbox_queue_status
    ON public.email_inbox_queue (status);

-- ─────────────────────────────────────────────────────────────────────
-- 2. EMAIL_INBOX_QUEUE — retention trigger
--    When a row reaches terminal status (completed / failed), clear the
--    two payload columns (body_text, body_snippet) which hold the bulk
--    of per-row storage. The row + metadata survives for auditing.
--    Uses BEFORE UPDATE so the nulled values are stored in the new tuple
--    directly — no wasted extra UPDATE.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_email_inbox_queue_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IN ('completed', 'failed') AND
       (OLD.status IS DISTINCT FROM NEW.status OR OLD.status IS NULL) THEN
        NEW.body_text    := NULL;
        NEW.body_snippet := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_inbox_queue_retention ON public.email_inbox_queue;

CREATE TRIGGER trg_email_inbox_queue_retention
    BEFORE UPDATE ON public.email_inbox_queue
    FOR EACH ROW
    WHEN (NEW.status IN ('completed', 'failed'))
    EXECUTE FUNCTION public.fn_email_inbox_queue_retention();

-- ─────────────────────────────────────────────────────────────────────
-- 3. CRON_RUNS — add started_at index for efficient age-based pruning
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at
    ON public.cron_runs (started_at ASC);

-- ─────────────────────────────────────────────────────────────────────
-- 4. CRON_RUNS — one-time cleanup of rows older than 30 days
--    Idempotent: runs again delete the same rows (no-ops as they're gone).
--    Keeps the most recent 30 days of run history.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM public.cron_runs
WHERE started_at < NOW() - INTERVAL '30 days';

--
-- NOTE on VACUUM FULL:
--   VACUUM FULL cannot run inside a transaction block. We run it in the
--   prune script (scripts/prune-retention.js) after the migration commits.
--   The script calls VACUUM FULL on both tables, then VACUUM ANALYZE to
--   refresh planner stats. This is where the actual disk reclamation
--   happens (~100 MB expected for email_inbox_queue, ~minor for cron_runs).
--

COMMIT;

NOTIFY pgrst, 'reload schema';

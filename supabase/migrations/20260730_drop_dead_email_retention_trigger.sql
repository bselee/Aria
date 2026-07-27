--
-- @file    20260730_drop_dead_email_retention_trigger.sql
-- @purpose Drop the destructive retention trigger on email_inbox_queue.
--          The trigger nulls body_text and body_snippet when status turns
--          'completed' or 'failed' — but the application NEVER writes those
--          statuses.  All 1,479 rows are 'unprocessed'; progress is tracked
--          via processed_by_ack / processed_by_ap / processed_by_tracking.
--          The trigger is dead code that destroys data if anything (e.g.
--          a manual test or future migration) sets status to those values.
--          One production row was already damaged this way — see aria-ops log.
--          Keep the useful status index; drop only the trigger + function.
-- @author  Hermia
-- @created 2026-07-30
-- @deps    email_inbox_queue (unaltered), idx_email_inbox_queue_status (preserved)
-- @env     local, any PostgREST-backed env
--
-- ROLLBACK:
--   Re-create the trigger and function from 20260728_retention_email_and_cron.sql.
--   If body retention is wanted in the future it must key off the processed_by_*
--   flags (or an explicit archived_at column) and be reviewed as a deliberate
--   data-destruction policy, not a disk-space tweak.
--

BEGIN;

-- Drop the trigger first (must precede function drop)
DROP TRIGGER IF EXISTS trg_email_inbox_queue_retention
    ON public.email_inbox_queue;

-- Drop the function
DROP FUNCTION IF EXISTS public.fn_email_inbox_queue_retention();

COMMIT;

NOTIFY pgrst, 'reload schema';

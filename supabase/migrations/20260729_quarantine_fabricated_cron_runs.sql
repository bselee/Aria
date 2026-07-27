-- @file    20260729_quarantine_fabricated_cron_runs.sql
-- @purpose Quarantine cron_runs rows whose telemetry was FABRICATED by the unfiltered
--          -UPDATE bug in src/lib/db.ts (fixed 2026-07-27, commit 86188cb). Because
--          query filters were applied only to GET, every `.update().eq()` executed as
--          a whole-table PATCH. A unit test's recordEnd() call therefore stamped its
--          fixture payload onto EVERY historical row of the production table.
--
--          The fabricated fingerprint is unambiguous and self-identifying:
--              status         = 'failed'
--              failure_reason = 'duration-exceeded'
--              duration_ms    = 1234          <- test fixture value
--              error_message  = 'boom'        <- test fixture value
--          125,202 rows carried this ONE identical payload. The reported "99.96% cron
--          failure rate" was an artifact of the bug, not real operational history.
--
--          RECOVERABILITY: none. All five retained dumps in backup/daily/ were checked
--          (2026-07-23, -25, -27); each shows only 2 distinct duration_ms values across
--          a 20,000-row sample, so the corruption predates the entire retention window.
--          True per-run status/duration/error are permanently lost.
--
--          This migration does NOT delete the rows — started_at, task_name and
--          invoked_by were never touched by the bug and remain a valid record that a
--          run occurred. Only the fabricated outcome columns are cleared, and each row
--          is tagged in metadata_jsonb so the gap is self-documenting rather than
--          silently masquerading as real telemetry.
--
-- @author  Hermia
-- @created 2026-07-29
-- @deps    cron_runs; src/cron/history.ts (CronRunStatus union must include 'unknown')
-- @env     local, any PostgREST-backed env
--
-- ROLLBACK:
--   The fabricated values were never real, so restoring them has no business value.
--   To revert the labelling only:
--     UPDATE public.cron_runs
--        SET status = 'failed', duration_ms = 1234, error_message = 'boom',
--            failure_reason = 'duration-exceeded',
--            metadata_jsonb = metadata_jsonb - 'data_quality'
--      WHERE metadata_jsonb->>'data_quality' = 'fabricated_by_unfiltered_update_20260727';
--   A pre-change dump is stored at backups/cron-quarantine-20260729/cron_runs.sql.

BEGIN;

-- The status vocabulary is enforced by a CHECK constraint, which is the real source of
-- truth (the TS union in src/cron/history.ts is advisory only). 'unknown' must be added
-- there before it can be stored, otherwise this migration aborts with SQLSTATE 23514.
-- Existing legacy values ('success', 'error') are preserved so old rows stay valid.
ALTER TABLE public.cron_runs DROP CONSTRAINT IF EXISTS cron_runs_status_check;
ALTER TABLE public.cron_runs ADD CONSTRAINT cron_runs_status_check
    CHECK (status = ANY (ARRAY[
        'running', 'succeeded', 'failed', 'cancelled', 'skipped',
        'success', 'error',   -- legacy values present in historical rows
        'unknown'             -- outcome unrecoverable (fabricated telemetry)
    ]::text[]));

-- Idempotent + precise. All four fingerprint columns must match, so a future GENUINE
-- failure that happens to last 1234ms is NOT caught (it would need the same
-- error_message and failure_reason too). The metadata guard prevents re-processing.
UPDATE public.cron_runs
   SET status         = 'unknown',
       duration_ms    = NULL,
       error_message  = NULL,
       failure_reason = NULL,
       metadata_jsonb = jsonb_set(
           COALESCE(metadata_jsonb, '{}'::jsonb),
           '{data_quality}',
           '"fabricated_by_unfiltered_update_20260727"'::jsonb,
           true
       )
 WHERE status         = 'failed'
   AND duration_ms    = 1234
   AND error_message  = 'boom'
   AND failure_reason = 'duration-exceeded'
   AND COALESCE(metadata_jsonb->>'data_quality', '') <> 'fabricated_by_unfiltered_update_20260727';

COMMIT;

NOTIFY pgrst, 'reload schema';

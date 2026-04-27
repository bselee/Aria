-- Migration: Fix-up for 20260501 — add 'stuck_source' to agent_task.type CHECK
-- and prepare for input_hash recompute via TS.
-- Created: 2026-05-04
--
-- WHY THIS EXISTS
--
-- 20260501_hygiene_backfill.sql shipped two latent bugs that surfaced on first
-- real use:
--
-- (1) `incrementOrCreate` in src/lib/intelligence/agent-task.ts can emit a
--     `stuck_source` meta-task when dedup_count > 5 AND the original task is
--     >1h old. But agent_task.type's CHECK constraint (created in
--     20260428_create_agent_task.sql) does not include 'stuck_source' as an
--     allowed value. The next stuck_source emission would fail with
--     "new row violates check constraint" and the spoke writer's try/catch
--     would swallow the error — meaning the stuck_source surfacing path
--     would silently never fire.
--
-- (2) 20260501's input_hash backfill used a SQL canonical form
--       digest(string_agg(key||':'||value::text, ',' ORDER BY key), 'sha256')
--     that does NOT match the TypeScript canonicalize form in
--     src/lib/intelligence/agent-task-hash.ts. The TS form recursively sorts
--     object keys and produces compact JSON ({"a":1,"b":2}, no spaces); the
--     SQL form produced a flat key:value text concatenation. SHA-256 of those
--     two strings differ for any non-trivial JSONB. As a result, dedup-on-
--     insert against existing backfilled rows is broken — the same signal
--     creates a NEW row with a fresh TS-computed hash instead of incrementing
--     the existing row's dedup_count.
--
-- THIS MIGRATION FIXES (1) ONLY.
--
-- (1) is a one-line CHECK-constraint update — DROP + re-ADD with the
-- expanded value set.
--
-- (2) is NOT fixed in SQL. Postgres can't easily produce text matching TS's
-- canonicalize() because JSONB::text inserts spaces after `:` and `,`
-- (yielding `{"a": 1, "b": 2}` vs TS's `{"a":1,"b":2}`). Writing a PL/pgSQL
-- function that exactly replicates TS canonicalize is doable but error-prone
-- and a maintenance burden. Cleaner: recompute input_hash from TS for every
-- existing row via a one-shot script.
--
-- AFTER APPLYING THIS MIGRATION, run:
--
--   node --import tsx src/cli/recompute-input-hashes.ts
--
-- That script pages every row in agent_task, recomputes input_hash using the
-- exact same inputHash() function the spoke writers use, and UPDATEs in place.
-- Idempotent — safe to re-run.
--
-- Rollback:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN ('cron_failure','approval','dropship_forward','po_send_confirm',
--                     'agent_exception','control_command','manual','code_change'));
--   (No way to roll back input_hash recompute since old SQL form cannot be
--    reconstructed from current data; future signals would simply create new
--    rows that the old hashes wouldn't dedup against. Leaving rollback as
--    "drop the new constraint" is sufficient.)

-- (1) Drop the inline CHECK that came from CREATE TABLE in 20260428 and
--     re-add it with 'stuck_source' included. Postgres auto-names inline
--     CHECKs as <table>_<column>_check; verified that name is in use by
--     the table created in 20260428_create_agent_task.sql.

ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;

ALTER TABLE public.agent_task
    ADD CONSTRAINT agent_task_type_check
    CHECK (type IN (
        'cron_failure',
        'approval',
        'dropship_forward',
        'po_send_confirm',
        'agent_exception',
        'control_command',
        'manual',
        'code_change',
        'stuck_source'
    ));

COMMENT ON CONSTRAINT agent_task_type_check ON public.agent_task IS
    'Permitted hub task types. stuck_source added in 20260504_agent_task_constraints_fixup.';

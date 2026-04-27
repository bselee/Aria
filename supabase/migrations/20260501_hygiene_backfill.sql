-- Migration: Add hygiene columns to agent_task and collapse duplicate stale rows
-- Created: 2026-05-01
-- Source spec: .agents/plans/2026-04-27-task-learning-loop.md §3.1, §4
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN dedup_count, DROP COLUMN input_hash, DROP COLUMN closes_when;
--   (Cannot un-collapse deleted duplicate rows; rollback restores schema only.)

-- 1. Schema additions
ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS dedup_count INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS input_hash  TEXT,
    ADD COLUMN IF NOT EXISTS closes_when JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_task_input_hash
    ON public.agent_task (source_table, input_hash)
    WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED');

-- 2. Populate input_hash for every existing row using a SQL canonical form
--    (server-side sha256 over a sorted JSONB representation; the TS canonicalize
--    helper produces an identical hash for new rows)
UPDATE public.agent_task
SET input_hash = encode(
    digest(
        (SELECT string_agg(key || ':' || value::text, ',' ORDER BY key)
         FROM jsonb_each_text(inputs)),
        'sha256'
    ),
    'hex'
)
WHERE input_hash IS NULL;

-- 3. Populate closes_when from static map keyed on (type, inputs).
--    control_command/restart_bot → close when aria-bot heartbeat is fresh
UPDATE public.agent_task
SET closes_when = jsonb_build_object('kind','agent_boot_after','agent','aria-bot')
WHERE type = 'control_command'
  AND inputs->>'command' = 'restart_bot'
  AND closes_when IS NULL;

-- approval-type tasks → close when spoke row reaches 'approved' or 'rejected'
UPDATE public.agent_task
SET closes_when = jsonb_build_object(
    'kind','spoke_status',
    'table', source_table,
    'value_in', jsonb_build_array('approved','rejected','completed','sent','done')
)
WHERE type IN ('approval','po_send_confirm','dropship_forward')
  AND source_table IS NOT NULL
  AND closes_when IS NULL;

-- everything else → 24h deadline
UPDATE public.agent_task
SET closes_when = jsonb_build_object('kind','deadline','max_age_hours',24)
WHERE closes_when IS NULL;

-- 4. Dedup: collapse open rows with same (source_table, source_id, input_hash).
--    Keep the oldest row, increment its dedup_count to the group size, delete the rest.
WITH dup_groups AS (
    SELECT source_table, source_id, input_hash,
           array_agg(id ORDER BY created_at ASC) AS ids,
           count(*) AS n
    FROM public.agent_task
    WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED')
      AND source_table IS NOT NULL
      AND source_id IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(*) > 1
),
keep_ids AS (
    SELECT ids[1] AS keep_id, n FROM dup_groups
)
UPDATE public.agent_task t
SET dedup_count = k.n,
    updated_at = NOW()
FROM keep_ids k
WHERE t.id = k.keep_id;

DELETE FROM public.agent_task
WHERE id IN (
    SELECT unnest(ids[2:]) FROM (
        SELECT array_agg(id ORDER BY created_at ASC) AS ids
        FROM public.agent_task
        WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED')
          AND source_table IS NOT NULL
          AND source_id IS NOT NULL
        GROUP BY source_table, source_id, input_hash
        HAVING count(*) > 1
    ) sub
);

COMMENT ON COLUMN public.agent_task.dedup_count IS
    'Count of identical signals collapsed into this row by incrementOrCreate. 1 for unique tasks.';
COMMENT ON COLUMN public.agent_task.input_hash IS
    'sha256 of canonical inputs JSONB; dedup key for incrementOrCreate.';
COMMENT ON COLUMN public.agent_task.closes_when IS
    'Predicate the closeFinishedTasks cron evaluates against current DB state. See agent-task-closure.ts.';

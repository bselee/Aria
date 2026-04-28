-- Migration: agent_task.max_retries default 3
-- Created: 2026-05-08
-- Purpose: Layer C runner uses retry_count < max_retries as the stop
--          condition for autonomous attempts. Existing rows have
--          max_retries = 0 (set by the phase 1 schema), which would
--          escalate every queued playbook on the first failure with no
--          retry budget. Default to 3 going forward; backfill 3 for any
--          row that has a playbook_kind set.
--
-- Rollback:
--   ALTER TABLE agent_task ALTER COLUMN max_retries DROP DEFAULT;

ALTER TABLE public.agent_task
    ALTER COLUMN max_retries SET DEFAULT 3;

UPDATE public.agent_task
SET max_retries = 3
WHERE playbook_kind IS NOT NULL
  AND (max_retries IS NULL OR max_retries < 3);

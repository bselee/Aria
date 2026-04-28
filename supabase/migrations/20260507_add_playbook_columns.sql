-- Migration: Add playbook_kind + playbook_state to agent_task
-- Created: 2026-05-07
-- Purpose: Layer B of the self-healing system. Make "what is being done
--          about this task" a first-class field instead of inferring from
--          status. The Layer C runner will read these to know what to
--          dispatch; until then they are populated only by manual triage
--          (e.g. reconciler approval rows mark themselves manual_only).
--
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN playbook_state;
--   ALTER TABLE agent_task DROP COLUMN playbook_kind;
--   DROP INDEX IF EXISTS idx_agent_task_playbook_kind;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS playbook_kind TEXT;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS playbook_state TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_task_playbook_state_check'
    ) THEN
        ALTER TABLE public.agent_task
            ADD CONSTRAINT agent_task_playbook_state_check
            CHECK (
                playbook_state IS NULL
                OR playbook_state IN (
                    'queued',
                    'running',
                    'succeeded',
                    'failed',
                    'manual_only'
                )
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_task_playbook_kind
    ON public.agent_task (playbook_kind, playbook_state)
    WHERE playbook_kind IS NOT NULL;

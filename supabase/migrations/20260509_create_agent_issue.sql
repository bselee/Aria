-- Migration: Create agent_issue parent ledger + extend task_history for issues
-- Created: 2026-05-09
-- Purpose: Phase 1 of agentic issue lifecycle. Issues group related agent_task
--          rows under a parent ledger with explicit lifecycle / autonomy /
--          blocker / next_action fields. Phase 1 is additive — existing
--          agent_task writes proceed unchanged. A projection cron derives
--          issues from tasks via shared business-flow key.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_task_history_issue_event;
--   ALTER TABLE task_history DROP CONSTRAINT IF EXISTS task_history_task_or_issue_check;
--   ALTER TABLE task_history ALTER COLUMN task_id SET NOT NULL;
--   ALTER TABLE task_history DROP COLUMN IF EXISTS issue_id;
--   DROP INDEX IF EXISTS idx_agent_task_issue_id;
--   ALTER TABLE agent_task DROP COLUMN IF EXISTS issue_id;
--   DROP INDEX IF EXISTS idx_agent_issue_owner_priority;
--   DROP INDEX IF EXISTS idx_agent_issue_business_flow_key;
--   DROP INDEX IF EXISTS idx_agent_issue_lifecycle_state;
--   DROP INDEX IF EXISTS uq_agent_issue_business_flow_open;
--   DROP TABLE IF EXISTS agent_issue;

CREATE TABLE IF NOT EXISTS public.agent_issue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    source_table    TEXT,
    source_id       TEXT,
    business_flow_key TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'detected'
        CHECK (lifecycle_state IN ('detected','triaging','working','waiting_external','blocked','complete')),
    autonomy_state  TEXT
        CHECK (autonomy_state IS NULL OR autonomy_state IN ('working','waiting','retrying','resolved','needs_policy')),
    current_handler TEXT,
    blocker_reason  TEXT
        CHECK (blocker_reason IS NULL OR blocker_reason IN (
            'missing_receipt','po_not_found','vendor_mismatch','extraction_failed',
            'policy_required','external_pending','duplicate_or_conflict',
            'source_unavailable','auth_required','data_integrity_error',
            'retry_exhausted','human_approval_required','unknown'
        )),
    next_action     TEXT,
    priority        SMALLINT NOT NULL DEFAULT 2,
    owner           TEXT NOT NULL DEFAULT 'aria',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT agent_issue_priority_range CHECK (priority BETWEEN 0 AND 9)
);

-- Open business-flow keys must be unique. Closed/complete rows can repeat
-- (e.g. same flow re-fired after a complete).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_issue_business_flow_open
    ON public.agent_issue (business_flow_key)
    WHERE lifecycle_state IN ('detected','triaging','working','waiting_external','blocked');

CREATE INDEX IF NOT EXISTS idx_agent_issue_lifecycle_state
    ON public.agent_issue (lifecycle_state, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_issue_business_flow_key
    ON public.agent_issue (business_flow_key);

CREATE INDEX IF NOT EXISTS idx_agent_issue_owner_priority
    ON public.agent_issue (owner, priority, created_at DESC);

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS issue_id UUID REFERENCES public.agent_issue(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_issue_id
    ON public.agent_task (issue_id)
    WHERE issue_id IS NOT NULL;

-- Issue-scoped events live in the same task_history ledger as task events,
-- but task_history.task_id is FK'd to agent_task — passing an agent_issue.id
-- would silently fail FK validation. Add a parallel issue_id column so
-- issue events have a real home.
ALTER TABLE public.task_history
    ADD COLUMN IF NOT EXISTS issue_id UUID REFERENCES public.agent_issue(id) ON DELETE SET NULL;

ALTER TABLE public.task_history
    ALTER COLUMN task_id DROP NOT NULL;

-- Use NOT VALID so the constraint applies to new rows only.
-- The DB already has ~2k task_history rows with task_id IS NULL — those
-- predate this design and we don't want to backfill placeholders.
-- Run a manual `ALTER ... VALIDATE CONSTRAINT` later if Will wants to
-- enforce retroactively after cleanup.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'task_history_task_or_issue_check'
    ) THEN
        ALTER TABLE public.task_history
            ADD CONSTRAINT task_history_task_or_issue_check
            CHECK (task_id IS NOT NULL OR issue_id IS NOT NULL)
            NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_history_issue_event
    ON public.task_history (issue_id, created_at DESC)
    WHERE issue_id IS NOT NULL;

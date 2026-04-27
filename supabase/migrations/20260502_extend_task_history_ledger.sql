-- Migration: Phase 3 — Extend task_history as the unified event ledger.
-- Created: 2026-05-02
--
-- Purpose: Phase 3 of the control-plane plan repurposes `task_history` as the
-- append-only event ledger for `agent_task`. Adds:
--   - task_id UUID FK → agent_task.id (nullable; legacy rows have no task_id)
--   - event_type TEXT (status transitions: 'created', 'claimed', 'running',
--     'needs_approval', 'approved', 'rejected', 'succeeded', 'failed',
--     'cancelled', 'expired', 'dedup_increment', plus skill events)
--
-- Why no new table: `task_history` already has agent_name, task_type, status,
-- input_summary, output_summary, skill_id, execution_trace, created_at — every
-- field a ledger needs. Adding two columns and an index gives us the ledger
-- without a fourth audit table on top of cron_runs + task_history + ops_alert_events.
--
-- agent-task.ts `appendEvent()` now writes ledger rows here. Phase 4 (skill
-- registry) and phase A1 (pattern miner) read from this table.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_task_history_task_event;
--   DROP INDEX IF EXISTS idx_task_history_event_type;
--   ALTER TABLE public.task_history DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.task_history DROP COLUMN IF EXISTS event_type;

ALTER TABLE public.task_history
    ADD COLUMN IF NOT EXISTS task_id    UUID REFERENCES public.agent_task(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS event_type TEXT;

CREATE INDEX IF NOT EXISTS idx_task_history_task_event
    ON public.task_history (task_id, created_at DESC)
    WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_history_event_type
    ON public.task_history (event_type, created_at DESC)
    WHERE event_type IS NOT NULL;

COMMENT ON COLUMN public.task_history.task_id IS
    'FK to agent_task hub row. Set by agent-task.ts appendEvent. NULL on legacy rows pre-phase-3.';
COMMENT ON COLUMN public.task_history.event_type IS
    'Discriminator for ledger entries: created | claimed | running | needs_approval | approved | rejected | succeeded | failed | cancelled | expired | dedup_increment | skill_invoked | skill_succeeded | skill_failed.';

-- Migration: Add auto_handled_by column to agent_task
-- Created: 2026-05-05
-- Purpose: Track which autonomous source resolved a task (vs human action).
--          Powers the "auto-handled by X" badge on dashboard command-board
--          lane cards in the Recently Closed lane. Manual actions
--          (will-telegram, will-dashboard) leave this NULL — only autonomous
--          paths (closure cron, reconciler auto-apply, etc.) populate it.
--
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN auto_handled_by;
--   DROP INDEX IF EXISTS idx_agent_task_auto_handled_by;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS auto_handled_by TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_task_auto_handled_by
    ON public.agent_task (auto_handled_by)
    WHERE auto_handled_by IS NOT NULL;

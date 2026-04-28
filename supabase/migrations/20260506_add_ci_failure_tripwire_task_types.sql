-- Migration: Add ci_failure + tripwire_violation to agent_task type CHECK
-- Created: 2026-05-06
-- Purpose: Self-Heal Layer A introduces two new task types so that CI
--          failures and tripwire violations land on the command-board
--          work queue. The type column has a CHECK constraint that must
--          permit the new literals or all inserts fail.
--
--          The TypeScript AgentTaskType union has already been extended
--          (src/lib/intelligence/agent-task.ts) — this migration brings
--          the DB into alignment.
--
-- Rollback:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task
--     ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN ('cron_failure','approval','dropship_forward','po_send_confirm',
--                     'agent_exception','control_command','manual','code_change',
--                     'stuck_source'));

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
        'stuck_source',
        'ci_failure',
        'tripwire_violation'
    ));

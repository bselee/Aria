-- Migration: Add jit_order_trigger + cron_summary + cognitive_critical to agent_task type CHECK
-- Created: 2026-06-11
-- Purpose: JIT forward projection routes cron alerts through the agent_task hub.
--          Three new task types: jit_order_trigger (SKU order triggers, 72h auto-close),
--          cron_summary (daily AP reports, 24h auto-close), and cognitive_critical
--          (critical cognitive round decisions, no auto-close).
--          The type column has a CHECK constraint that must permit these literals
--          or all inserts fail silently — breaking the entire task-first notification path.
--
-- Rollback:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task
--     ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN ('cron_failure','approval','dropship_forward','po_send_confirm',
--                     'agent_exception','control_command','manual','code_change',
--                     'stuck_source','ci_failure','tripwire_violation'));

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
        'tripwire_violation',
        'jit_order_trigger',
        'cron_summary',
        'cognitive_critical'
    ));

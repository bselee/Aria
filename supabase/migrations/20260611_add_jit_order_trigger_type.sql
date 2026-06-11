-- Migration: extend agent_task.type CHECK to the full current enum and add
--            'jit_order_trigger' (JIT order-trigger alerts routed through the hub).
--
-- Why: src/lib/intelligence/agent-task.ts (AgentTaskType) had already grown
--      'ci_failure' and 'tripwire_violation' past what the 20260504 fix-up
--      allowed, so those inserts would have failed the CHECK. This re-syncs the
--      DB constraint to the code and adds the new 'jit_order_trigger' type used
--      by the jit-forward-projection cron (notification-first → task-first).
--
-- Safety: non-destructive. Drops and re-adds a CHECK constraint only — no data
--         is touched. Same DROP/ADD pattern as 20260504_agent_task_constraints_fixup.
--         Existing rows all use types that remain in the new list.

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
        'jit_order_trigger'
    ));

COMMENT ON CONSTRAINT agent_task_type_check ON public.agent_task IS
    'Permitted hub task types. Re-synced to AgentTaskType + jit_order_trigger added in 20260611.';

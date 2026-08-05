--
-- @file    20260805_add_email_needs_response_task_type.sql
-- @purpose Permit email_needs_response (+ drop/pattern types already in TS union)
--          on agent_task.type CHECK. Required for vendor-opportunity response
--          monitor (BioChar-class emails).
-- @author  Hermia
-- @created 2026-08-05
--
-- ROLLBACK:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN (
--       'cron_failure','approval','dropship_forward','po_send_confirm',
--       'agent_exception','control_command','manual','code_change',
--       'stuck_source','ci_failure','tripwire_violation',
--       'jit_order_trigger','cron_summary','cognitive_critical'
--     ));
--

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
        'cognitive_critical',
        'drop_detect_report',
        'pattern_miner_insight',
        'email_needs_response'
    ));

COMMENT ON CONSTRAINT agent_task_type_check ON public.agent_task IS
    'Allowed agent_task.type values — includes email_needs_response for vendor opportunity response monitor (2026-08-05).';

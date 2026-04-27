-- Migration: Create agent_task hub for the Aria control plane
-- Created: 2026-04-28
-- Purpose: Single physical "ticket" table that every spoke (approvals, dropships,
--          PO sends, exceptions, control requests, failed cron runs) can link to
--          via (source_table, source_id). Powers the /dashboard/tasks page.
--
-- Phase 1 of the control plane plan (see .agents/plans/control-plane.md).
-- This migration is fully additive. No spoke writers are wired in this phase —
-- the hub is seeded once from the existing pending rows in 6 spoke tables, and
-- subsequent population happens in phase 2.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.agent_task;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Hub table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_task (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type                TEXT NOT NULL
                            CHECK (type IN (
                                'cron_failure',
                                'approval',
                                'dropship_forward',
                                'po_send_confirm',
                                'agent_exception',
                                'control_command',
                                'manual',
                                'code_change'
                            )),
    source_table        TEXT,
    source_id           TEXT,
    goal                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN (
                                'PENDING',
                                'CLAIMED',
                                'RUNNING',
                                'NEEDS_APPROVAL',
                                'APPROVED',
                                'REJECTED',
                                'SUCCEEDED',
                                'FAILED',
                                'EXPIRED',
                                'CANCELLED'
                            )),
    owner               TEXT NOT NULL DEFAULT 'aria',
    priority            SMALLINT NOT NULL DEFAULT 2
                            CHECK (priority BETWEEN 0 AND 4),
    parent_task_id      UUID REFERENCES public.agent_task(id) ON DELETE SET NULL,
    requires_approval   BOOLEAN NOT NULL DEFAULT FALSE,
    approval_decision   TEXT
                            CHECK (approval_decision IS NULL OR approval_decision IN ('approve', 'reject')),
    approval_decided_by TEXT,
    approval_decided_at TIMESTAMPTZ,
    inputs              JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs             JSONB NOT NULL DEFAULT '{}'::jsonb,
    cost_cents          INTEGER NOT NULL DEFAULT 0,
    retry_count         SMALLINT NOT NULL DEFAULT 0,
    max_retries         SMALLINT NOT NULL DEFAULT 0,
    deadline_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at          TIMESTAMPTZ,
    claimed_by          TEXT,
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_task_open
    ON public.agent_task (status, priority, created_at DESC)
    WHERE status IN ('PENDING', 'CLAIMED', 'RUNNING', 'NEEDS_APPROVAL');

CREATE INDEX IF NOT EXISTS idx_agent_task_owner_status
    ON public.agent_task (owner, status);

CREATE INDEX IF NOT EXISTS idx_agent_task_source
    ON public.agent_task (source_table, source_id)
    WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_parent
    ON public.agent_task (parent_task_id)
    WHERE parent_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_type_created
    ON public.agent_task (type, created_at DESC);

-- Idempotency: a (source_table, source_id) pair can only spawn one hub row.
-- Spoke writers call upsert via (source_table, source_id); the partial unique
-- index makes that safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_source
    ON public.agent_task (source_table, source_id)
    WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_agent_task_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_task_set_updated_at ON public.agent_task;
CREATE TRIGGER trg_agent_task_set_updated_at
    BEFORE UPDATE ON public.agent_task
    FOR EACH ROW EXECUTE FUNCTION public.set_agent_task_updated_at();

-- ── One-time backfill ─────────────────────────────────────────────────────────
-- Each INSERT uses NOT EXISTS so re-running the migration is safe (the partial
-- unique index would refuse duplicates anyway, but NOT EXISTS skips the work).

-- 1. Pending reconciliation approvals
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, requires_approval, owner, priority, inputs)
SELECT
    'approval',
    'ap_pending_approvals',
    a.id::TEXT,
    'Reconcile invoice ' || COALESCE(a.invoice_number, '?') || ' from ' || COALESCE(a.vendor_name, '?'),
    'NEEDS_APPROVAL',
    TRUE,
    'will',
    1,
    jsonb_build_object(
        'invoice_number', a.invoice_number,
        'vendor_name',    a.vendor_name,
        'order_id',       a.order_id,
        'verdict_type',   a.verdict_type
    )
FROM public.ap_pending_approvals a
WHERE a.status = 'pending'
  AND (a.expires_at IS NULL OR a.expires_at > NOW())
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'ap_pending_approvals' AND t.source_id = a.id::TEXT
  );

-- 2. Pending copilot action sessions (PO sends, PO reviews, reconciliation approvals).
--    Dropships do NOT land here today — ap-agent.ts:409-489 forwards them to Bill.com
--    inline without writing pending_dropships rows. The pending_dropships table is
--    historical / unused in production; we deliberately omit it from the backfill so
--    the hub doesn't get seeded with stale rows. The 'dropship_forward' type stays in
--    the agent_task CHECK list so a future "needs human review" dropship path can use it.
--    Action_type → hub type mapping:
--       po_send / po_review     → po_send_confirm
--       reconcile_approve       → approval (reconciler approval)
--       <anything else>         → po_send_confirm (default; safe — phase 2 will refine)
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, requires_approval, owner, priority, inputs, deadline_at)
SELECT
    CASE
        WHEN s.action_type = 'reconcile_approve' THEN 'approval'
        ELSE 'po_send_confirm'
    END,
    'copilot_action_sessions',
    s.session_id,
    'Confirm ' || s.action_type || ' (channel: ' || s.channel || ')',
    'NEEDS_APPROVAL',
    TRUE,
    'will',
    2,
    jsonb_build_object(
        'action_type', s.action_type,
        'channel',     s.channel
    ),
    s.expires_at
FROM public.copilot_action_sessions s
WHERE s.status = 'pending'
  AND s.expires_at > NOW()
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'copilot_action_sessions' AND t.source_id = s.session_id
  );

-- 3. Pending agent exceptions (Supervisor will classify; surface them in the meantime)
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, owner, priority, inputs)
SELECT
    'agent_exception',
    'ops_agent_exceptions',
    e.id::TEXT,
    'Agent ' || e.agent_name || ' raised an exception: ' || LEFT(COALESCE(e.error_message, '(no message)'), 120),
    'PENDING',
    'aria',
    1,
    jsonb_build_object(
        'agent_name',    e.agent_name,
        'error_message', e.error_message,
        'context_data',  e.context_data
    )
FROM public.ops_agent_exceptions e
WHERE e.status = 'pending'
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'ops_agent_exceptions' AND t.source_id = e.id::TEXT
  );

-- 4. Pending control requests (runbook commands)
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, owner, priority, inputs)
SELECT
    'control_command',
    'ops_control_requests',
    c.id::TEXT,
    'Control: ' || c.command || ' on ' || c.target,
    'PENDING',
    'aria',
    0,
    jsonb_build_object(
        'command',      c.command,
        'target',       c.target,
        'requested_by', c.requested_by,
        'reason',       c.reason
    )
FROM public.ops_control_requests c
WHERE c.status = 'pending'
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'ops_control_requests' AND t.source_id = c.id::TEXT
  );

-- 5. Recent cron failures (last 24h, status='error')
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, owner, priority, inputs, completed_at)
SELECT
    'cron_failure',
    'cron_runs',
    cr.id::TEXT,
    'Cron ' || cr.task_name || ' failed: ' || LEFT(COALESCE(cr.error_message, '(no message)'), 120),
    'FAILED',
    'aria',
    1,
    jsonb_build_object(
        'task_name',     cr.task_name,
        'error_message', cr.error_message,
        'duration_ms',   cr.duration_ms,
        'started_at',    cr.started_at
    ),
    cr.finished_at
FROM public.cron_runs cr
WHERE cr.status = 'error'
  AND cr.started_at >= NOW() - INTERVAL '24 hours'
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'cron_runs' AND t.source_id = cr.id::TEXT
  );

COMMENT ON TABLE public.agent_task IS
    'Aria control-plane hub. One row per unit of work that a human might care about — '
    'approvals, dropships, PO confirmations, agent exceptions, control commands, cron '
    'failures, and (phase 6) code-change tasks. Spokes link via (source_table, source_id) '
    'with a partial unique index for idempotent upserts. See .agents/plans/control-plane.md.';

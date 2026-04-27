-- Migration: Add nullable task_id FK to spoke tables for control-plane phase 2.
-- Created: 2026-04-29
--
-- Purpose: Phase 2 wires the 5 spoke writers to also create/update an `agent_task`
-- hub row alongside their existing spoke insert. To make the link queryable from
-- both directions (and to let the dashboard "open the spoke" from a hub row), each
-- spoke gains a nullable `task_id UUID REFERENCES agent_task(id) ON DELETE SET NULL`.
--
-- Skipped: `copilot_action_sessions` — no production writers exist for that table
-- yet (see `.agents/plans/control-plane.md` §3.3). Adding the column anyway for
-- forward compat when the writers materialize.
--
-- All changes additive (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
-- One-time backfill UPDATE uses NOT EXISTS / IS NULL guards so re-running is safe.
--
-- Rollback:
--   ALTER TABLE public.ap_pending_approvals    DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.copilot_action_sessions DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.ops_agent_exceptions    DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.ops_control_requests    DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.cron_runs               DROP COLUMN IF EXISTS task_id;
--   (Indexes drop with the columns.)

-- ── Add task_id to each spoke ────────────────────────────────────────────────

ALTER TABLE public.ap_pending_approvals
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.copilot_action_sessions
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.ops_agent_exceptions
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.ops_control_requests
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.cron_runs
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

-- ── Indexes (partial: only non-null task_id) ─────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ap_pending_approvals_task_id
    ON public.ap_pending_approvals (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_copilot_action_sessions_task_id
    ON public.copilot_action_sessions (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_agent_exceptions_task_id
    ON public.ops_agent_exceptions (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_control_requests_task_id
    ON public.ops_control_requests (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cron_runs_task_id
    ON public.cron_runs (task_id) WHERE task_id IS NOT NULL;

-- ── Backfill from existing hub rows ──────────────────────────────────────────
-- Phase 1 already seeded `agent_task` from existing pending spokes via
-- (source_table, source_id). Now hydrate the reverse FK on each spoke. Idempotent:
-- only sets where task_id IS NULL, which is the only state a row can be in
-- right after this migration adds the column.

UPDATE public.ap_pending_approvals AS a
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'ap_pending_approvals'
   AND t.source_id = a.id::TEXT
   AND a.task_id IS NULL;

UPDATE public.copilot_action_sessions AS s
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'copilot_action_sessions'
   AND t.source_id = s.session_id
   AND s.task_id IS NULL;

UPDATE public.ops_agent_exceptions AS e
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'ops_agent_exceptions'
   AND t.source_id = e.id::TEXT
   AND e.task_id IS NULL;

UPDATE public.ops_control_requests AS c
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'ops_control_requests'
   AND t.source_id = c.id::TEXT
   AND c.task_id IS NULL;

UPDATE public.cron_runs AS cr
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'cron_runs'
   AND t.source_id = cr.id::TEXT
   AND cr.task_id IS NULL;

COMMENT ON COLUMN public.ap_pending_approvals.task_id IS
    'FK to agent_task hub row. Set by reconciler.storePendingApproval after the hub upsert. NULL until phase 2 wiring runs (HUB_TASKS_ENABLED).';
COMMENT ON COLUMN public.ops_agent_exceptions.task_id IS
    'FK to agent_task hub row. Set by ops-manager.safeRun failure path via SupervisorAgent. NULL on legacy rows pre-phase-2.';
COMMENT ON COLUMN public.ops_control_requests.task_id IS
    'FK to agent_task hub row. Set by oversight-agent.escalate after createOpsControlRequest.';
COMMENT ON COLUMN public.cron_runs.task_id IS
    'FK to agent_task hub row. Set ONLY for failures (status=error). Successful runs do not generate hub rows.';
COMMENT ON COLUMN public.copilot_action_sessions.task_id IS
    'FK to agent_task hub row. No production writers exist yet (see .agents/plans/control-plane.md §3.3). Column added for forward compat.';

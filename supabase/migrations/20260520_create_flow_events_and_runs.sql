-- 20260520_create_flow_events_and_runs.sql
-- Substrate for the backend agentic flow path. Domain writes emit events to
-- `flow_events`; a registry of flows subscribes to event types; the flow
-- runner spawns `flow_runs` and advances them step-by-step. The Activity
-- board reads `flow_runs` as the source of truth for in-flight work.
--
-- Escalation is explicit: a step returning kind='escalate' (or exhausting
-- retries) flips the run to BREACHED and surfaces via agent_task. Silent
-- stalls are not possible — every run is RUNNING, SUCCEEDED, FAILED, or
-- BREACHED.
--
-- Phase 1 canary: dropship_forward (one step). Future flows:
-- po_lifecycle, invoice_reconcile, vendor_ack_watcher.

CREATE TABLE IF NOT EXISTS flow_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id text,
    emitted_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_flow_events_unprocessed
    ON flow_events (emitted_at)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flow_events_type ON flow_events (type);

CREATE TABLE IF NOT EXISTS flow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_name text NOT NULL,
    status text NOT NULL DEFAULT 'RUNNING',  -- RUNNING | SUCCEEDED | FAILED | BREACHED
    current_step text,
    triggered_by_event uuid REFERENCES flow_events(id),
    correlation_id text,
    inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
    state jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempts integer NOT NULL DEFAULT 0,
    deadline_at timestamptz,
    failure_reason text,
    escalated_task_id uuid,  -- agent_task.id when BREACHED
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_status   ON flow_runs (status);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow     ON flow_runs (flow_name);
CREATE INDEX IF NOT EXISTS idx_flow_runs_active   ON flow_runs (flow_name, correlation_id)
    WHERE status = 'RUNNING';

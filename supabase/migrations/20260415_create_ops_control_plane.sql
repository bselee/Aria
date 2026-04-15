-- Migration: Create Supabase ops control plane for AP reliability
-- Created: 2026-04-15
-- Purpose: Add durable bot heartbeats, restart/control requests, alert dedupe,
--          and a health summary view so Supabase can act as the operational
--          control plane for AP/nightshift reliability.
-- Rollback:
--   DROP VIEW IF EXISTS public.ops_health_summary;
--   DROP TRIGGER IF EXISTS trg_ops_exception_signal ON public.ops_agent_exceptions;
--   DROP FUNCTION IF EXISTS public.signal_ops_exception();
--   DROP TABLE IF EXISTS public.ops_alert_events;
--   DROP TABLE IF EXISTS public.ops_control_requests;
--   DROP TABLE IF EXISTS public.agent_heartbeats;
--   DROP TABLE IF EXISTS public.cron_runs;
--
-- DECISION(2026-04-15): Use additive, table-backed control requests first rather
-- than replacing existing AP queue tables. This keeps rollback simple while still
-- giving Supabase a durable restart/control surface.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.cron_runs (
    id            BIGSERIAL PRIMARY KEY,
    task_name     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INTEGER,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_task_started
    ON public.cron_runs (task_name, started_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_heartbeats (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name   TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'healthy'
                     CHECK (status IN ('healthy', 'degraded', 'starting', 'stopped')),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_heartbeat
    ON public.agent_heartbeats (heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS public.ops_control_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    command      TEXT NOT NULL
                     CHECK (command IN ('restart_bot', 'run_ap_poll_now', 'run_nightshift_now', 'clear_stuck_processing')),
    target       TEXT NOT NULL DEFAULT 'all'
                     CHECK (target IN ('aria-bot', 'watchdog', 'all')),
    status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled')),
    requested_by TEXT NOT NULL,
    reason       TEXT,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    claimed_at   TIMESTAMPTZ,
    claimed_by   TEXT,
    completed_at TIMESTAMPTZ,
    result       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_control_requests_status_target
    ON public.ops_control_requests (status, target, created_at);

CREATE TABLE IF NOT EXISTS public.ops_alert_events (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_key  TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'sent'
                   CHECK (status IN ('sent', 'suppressed', 'failed')),
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_alert_events_key_created
    ON public.ops_alert_events (alert_key, created_at DESC);

CREATE OR REPLACE FUNCTION public.signal_ops_exception()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    alert_key TEXT;
BEGIN
    IF NEW.status = 'pending' THEN
        alert_key := 'ops_exception:' || COALESCE(NEW.agent_name, 'unknown') || ':' || TO_CHAR(DATE_TRUNC('hour', NOW()), 'YYYYMMDDHH24');
        INSERT INTO public.ops_alert_events (alert_key, alert_type, status, payload)
        VALUES (
            alert_key,
            'ops_exception',
            'suppressed',
            jsonb_build_object(
                'agent_name', NEW.agent_name,
                'error_message', NEW.error_message,
                'context_data', COALESCE(NEW.context_data, '{}'::jsonb)
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_exception_signal ON public.ops_agent_exceptions;
CREATE TRIGGER trg_ops_exception_signal
AFTER INSERT ON public.ops_agent_exceptions
FOR EACH ROW
EXECUTE FUNCTION public.signal_ops_exception();

CREATE OR REPLACE VIEW public.ops_health_summary AS
WITH now_ref AS (
    SELECT NOW() AS now_utc
),
latest_bot AS (
    SELECT heartbeat_at, status, metadata
    FROM public.agent_heartbeats
    WHERE agent_name = 'aria-bot'
    LIMIT 1
),
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('APPolling'::TEXT, INTERVAL '20 minutes')
    ) AS thresholds(task_name, stale_after)
),
latest_crons AS (
    SELECT task_name, MAX(started_at) AS last_started_at
    FROM public.cron_runs
    GROUP BY task_name
),
stale_crons AS (
    SELECT COALESCE(jsonb_agg(t.task_name ORDER BY t.task_name), '[]'::jsonb) AS names
    FROM cron_thresholds t
    LEFT JOIN latest_crons c
        ON c.task_name = t.task_name
    CROSS JOIN now_ref n
    WHERE c.last_started_at IS NULL
       OR c.last_started_at < (n.now_utc - t.stale_after)
),
ap_email_queue AS (
    SELECT MIN(created_at) AS oldest_pending_at
    FROM public.email_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status IN ('unprocessed', 'processing')
),
ap_forward_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status NOT IN ('FORWARDED', 'ERROR_FORWARDING', 'ERROR_PROCESSING')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'PROCESSING_FORWARD'
              AND updated_at < NOW() - INTERVAL '20 minutes'
        ) AS stuck_processing_count
    FROM public.ap_inbox_queue
),
nightshift_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'processing'
              AND updated_at < NOW() - INTERVAL '10 minutes'
        ) AS stuck_processing_count,
        MAX(processed_at) FILTER (
            WHERE status = 'completed'
              AND task_type IN ('email_classification', 'default_inbox_invoice')
        ) AS last_completed_at
    FROM public.nightshift_queue
),
pending_exceptions AS (
    SELECT COUNT(*) AS pending_count
    FROM public.ops_agent_exceptions
    WHERE status = 'pending'
),
last_ap_forward AS (
    SELECT MAX(updated_at) AS last_forwarded_at
    FROM public.ap_inbox_queue
    WHERE status = 'FORWARDED'
),
merged_backlog AS (
    SELECT
        CASE
            WHEN e.oldest_pending_at IS NULL THEN f.oldest_pending_at
            WHEN f.oldest_pending_at IS NULL THEN e.oldest_pending_at
            ELSE LEAST(e.oldest_pending_at, f.oldest_pending_at)
        END AS oldest_ap_backlog_at
    FROM ap_email_queue e
    CROSS JOIN ap_forward_queue f
)
SELECT
    NOW() AS generated_at,
    lb.heartbeat_at AS bot_heartbeat_at,
    CASE
        WHEN lb.heartbeat_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - lb.heartbeat_at)) / 60.0)::numeric, 1)
    END AS bot_heartbeat_age_minutes,
    COALESCE(sc.names, '[]'::jsonb) AS stale_crons,
    jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) AS stale_cron_count,
    mb.oldest_ap_backlog_at AS ap_queue_backlog_at,
    CASE
        WHEN mb.oldest_ap_backlog_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - mb.oldest_ap_backlog_at)) / 60.0)::numeric, 1)
    END AS ap_queue_backlog_age_minutes,
    COALESCE(afq.stuck_processing_count, 0) AS ap_processing_stuck_count,
    nq.oldest_pending_at AS nightshift_queue_backlog_at,
    CASE
        WHEN nq.oldest_pending_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.oldest_pending_at)) / 60.0)::numeric, 1)
    END AS nightshift_queue_backlog_age_minutes,
    COALESCE(nq.stuck_processing_count, 0) AS nightshift_processing_stuck_count,
    COALESCE(pe.pending_count, 0) AS pending_exception_count,
    laf.last_forwarded_at AS last_ap_forward_at,
    CASE
        WHEN laf.last_forwarded_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - laf.last_forwarded_at)) / 60.0)::numeric, 1)
    END AS last_ap_forward_age_minutes,
    nq.last_completed_at AS last_nightshift_completion_at,
    CASE
        WHEN nq.last_completed_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.last_completed_at)) / 60.0)::numeric, 1)
    END AS last_nightshift_completion_age_minutes,
    CASE
        WHEN jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) > 0
          OR COALESCE(afq.stuck_processing_count, 0) > 0
          OR COALESCE(nq.stuck_processing_count, 0) > 0
          OR COALESCE(pe.pending_count, 0) > 0
          OR (
              lb.heartbeat_at IS NOT NULL
              AND lb.heartbeat_at < NOW() - INTERVAL '10 minutes'
          )
          OR (
              mb.oldest_ap_backlog_at IS NOT NULL
              AND mb.oldest_ap_backlog_at < NOW() - INTERVAL '30 minutes'
          )
          OR (
              nq.oldest_pending_at IS NOT NULL
              AND nq.oldest_pending_at < NOW() - INTERVAL '60 minutes'
          )
        THEN 'degraded'
        ELSE 'healthy'
    END AS health_status
FROM latest_bot lb
FULL OUTER JOIN stale_crons sc ON TRUE
CROSS JOIN ap_forward_queue afq
CROSS JOIN nightshift_queue nq
CROSS JOIN pending_exceptions pe
CROSS JOIN last_ap_forward laf
CROSS JOIN merged_backlog mb;

COMMENT ON VIEW public.ops_health_summary IS
'Single-row ops control-plane health summary for AP/nightshift reliability, used by Supabase alerting and the local watchdog.';

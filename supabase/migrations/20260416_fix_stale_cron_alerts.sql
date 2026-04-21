-- Migration: Fix false-positive stale cron alerts
-- Created: 2026-04-16
-- Purpose:
--   1. Remove phantom crons (SlackETASync, UlineConfirmationSync) that no longer
--      exist in ops-manager.ts but were still monitored.
--   2. Only monitor high-frequency "always running" crons (APPolling, POSync,
--      BuildCompletionWatcher, POReceivingWatcher, StatIndexing).
--      Once-daily/weekly crons (DailySummary, BuildRisk, etc.) should NOT trigger
--      staleness alerts — they only run during narrow time windows and will always
--      appear stale outside those windows.

CREATE OR REPLACE VIEW public.ops_health_summary AS
WITH now_ref AS (
    SELECT NOW() AS now_utc
),
latest_bot AS (
    SELECT heartbeat_at
    FROM public.agent_heartbeats
    WHERE agent_name = 'aria-bot'
    ORDER BY heartbeat_at DESC
    LIMIT 1
),
-- Only monitor crons that run frequently enough that staleness = something broke.
-- Once-daily/weekly crons are NOT included — they legitimately go 20+ hours between runs.
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('APPolling',              INTERVAL '25 minutes'),
            ('POSync',                 INTERVAL '45 minutes'),
            ('BuildCompletionWatcher', INTERVAL '45 minutes'),
            ('POReceivingWatcher',     INTERVAL '45 minutes'),
            ('StatIndexing',           INTERVAL '90 minutes'),
            ('POSweep',                INTERVAL '6 hours'),
            ('PurchasingCalendarSync', INTERVAL '6 hours')
    ) AS t(task_name, stale_after)
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
      AND COALESCE(processed_by_ap, FALSE) = FALSE
),
ap_forward_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status IN ('PENDING_FORWARD', 'PROCESSING_FORWARD')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status = 'PROCESSING_FORWARD'
              AND updated_at < NOW() - INTERVAL '20 minutes'
        ) AS stuck_processing_count
    FROM public.ap_inbox_queue
),
nightshift_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
              AND (expires_at IS NULL OR expires_at >= NOW())
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'processing'
              AND (expires_at IS NULL OR expires_at >= NOW())
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
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status = 'FORWARDED'
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

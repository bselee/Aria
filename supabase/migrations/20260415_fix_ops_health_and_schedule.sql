-- Migration: Fix ops health backlog detection and schedule ops-health-check
-- Created: 2026-04-15
-- Purpose:
--   1. Only count truly active AP/nightshift backlog in ops_health_summary.
--   2. Add a Vault-backed pg_cron job that invokes the deployed ops-health-check
--      Edge Function every 5 minutes when the required secrets are present.
-- Notes:
--   - This migration expects Vault secrets named:
--       * ops_health_check_url
--       * ops_health_check_bearer
--   - If those secrets are absent, the invoke function is still created but the
--     cron job is skipped until the secrets are added and the migration logic
--     is re-run (or the schedule block is applied manually).

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_ops_health_check()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    function_url TEXT;
    auth_token   TEXT;
    request_id   BIGINT;
BEGIN
    SELECT decrypted_secret
      INTO function_url
      FROM vault.decrypted_secrets
     WHERE name = 'ops_health_check_url'
     ORDER BY updated_at DESC
     LIMIT 1;

    SELECT decrypted_secret
      INTO auth_token
      FROM vault.decrypted_secrets
     WHERE name = 'ops_health_check_bearer'
     ORDER BY updated_at DESC
     LIMIT 1;

    IF function_url IS NULL OR function_url = '' THEN
        RAISE EXCEPTION 'Missing Vault secret: ops_health_check_url';
    END IF;

    IF auth_token IS NULL OR auth_token = '' THEN
        RAISE EXCEPTION 'Missing Vault secret: ops_health_check_bearer';
    END IF;

    SELECT net.http_post(
        url := function_url,
        body := jsonb_build_object('triggered_at', NOW()::text),
        params := '{}'::jsonb,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || auth_token
        ),
        timeout_milliseconds := 5000
    )
    INTO request_id;

    RETURN request_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_ops_health_check() IS
'Vault-backed pg_net wrapper used by pg_cron to invoke the ops-health-check Edge Function.';

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
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('APPolling',           INTERVAL '25 minutes'),
            ('SlackETASync',        INTERVAL '3 hours'),
            ('POSync',              INTERVAL '45 minutes'),
            ('POSweep',             INTERVAL '6 hours'),
            ('UlineConfirmationSync', INTERVAL '25 minutes'),
            ('POReceivingWatcher',  INTERVAL '45 minutes'),
            ('PurchasingCalendarSync', INTERVAL '6 hours'),
            ('DailySummary',        INTERVAL '36 hours'),
            ('WeeklySummary',       INTERVAL '8 days'),
            ('ReconcileAxiom',      INTERVAL '36 hours'),
            ('ReconcileFedEx',      INTERVAL '36 hours'),
            ('ReconcileTeraGanix',  INTERVAL '36 hours'),
            ('ReconcileULINE',      INTERVAL '36 hours'),
            ('BuildCompletionWatcher', INTERVAL '45 minutes'),
            ('BuildRisk',           INTERVAL '36 hours'),
            ('NightshiftEnqueue',   INTERVAL '36 hours'),
            ('Housekeeping',        INTERVAL '36 hours'),
            ('StatIndexing',        INTERVAL '90 minutes')
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

DO $$
DECLARE
    existing_job_id BIGINT;
    has_url_secret BOOLEAN;
    has_bearer_secret BOOLEAN;
BEGIN
    SELECT jobid
      INTO existing_job_id
      FROM cron.job
     WHERE jobname = 'ops-health-check-every-5-minutes'
     LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(existing_job_id);
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ops_health_check_url'
    ) INTO has_url_secret;

    SELECT EXISTS(
        SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ops_health_check_bearer'
    ) INTO has_bearer_secret;

    IF has_url_secret AND has_bearer_secret THEN
        PERFORM cron.schedule(
            'ops-health-check-every-5-minutes',
            '*/5 * * * *',
            'SELECT public.invoke_ops_health_check();'
        );
    ELSE
        RAISE NOTICE 'Skipping ops-health-check schedule; missing Vault secrets ops_health_check_url and/or ops_health_check_bearer';
    END IF;
END
$$;

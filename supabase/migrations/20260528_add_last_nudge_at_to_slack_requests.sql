-- Add last_nudge_at to slack_requests for follow-up SOP cooldown tracking.
-- Used by: followup-sop cron job, /followup Telegram command.
-- Part of: core-04 (Slack/Email responder — auto-ack + follow-up SOP)

ALTER TABLE slack_requests ADD COLUMN IF NOT EXISTS last_nudge_at timestamptz;

-- Index for the query that finds requests needing a nudge
CREATE INDEX IF NOT EXISTS idx_slack_requests_nudge
    ON slack_requests (status, created_at, last_nudge_at)
    WHERE status = 'pending';

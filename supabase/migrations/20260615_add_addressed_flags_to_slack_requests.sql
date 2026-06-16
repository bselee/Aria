-- Add addressed_to_bill and is_dm flags to slack_requests for daily accountability review.
-- Captures DMs to Bill and @Bill mentions in channels (beyond just #purchase-orders SKU requests).
-- Used by: addressed-message-watcher / daily-slack-review cron, extends existing slack_requests ledger.
-- Part of: 2026-06-15 daily Slack review feature (closes DM/@mention gap).

ALTER TABLE slack_requests ADD COLUMN IF NOT EXISTS addressed_to_bill boolean DEFAULT false;
ALTER TABLE slack_requests ADD COLUMN IF NOT EXISTS is_dm boolean DEFAULT false;

-- Index for the daily review query (filter recent addressed messages)
CREATE INDEX IF NOT EXISTS idx_slack_requests_addressed
    ON slack_requests (addressed_to_bill, created_at, status)
    WHERE addressed_to_bill = true;

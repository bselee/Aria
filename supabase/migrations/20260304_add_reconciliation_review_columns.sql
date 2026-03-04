-- Add review tracking columns to ap_activity_log
-- These track dashboard/Telegram approval state and dismiss reasons
--
-- DECISION(2026-03-04): Adding review workflow columns so the dashboard
-- can track approve/pause/dismiss state independently of the Telegram
-- bot's in-memory approval Map. This enables dashboard-driven approval
-- flow and provides audit trail for all reconciliation outcomes.
--
-- reviewed_action values: "approved" | "paused" | "dismissed" | "re-matched" | "acknowledged"
-- dismiss_reason values: "dropship" | "already_handled" | "duplicate" | "credit_memo" | "statement" | "not_ours"
ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_action TEXT,
    ADD COLUMN IF NOT EXISTS dismiss_reason TEXT;
-- Index for querying unreviewed reconciliation entries efficiently.
-- The dashboard needs to quickly find RECONCILIATION rows that haven't been
-- reviewed yet to show action buttons.
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_unreviewed ON ap_activity_log (intent, reviewed_at)
WHERE intent = 'RECONCILIATION'
    AND reviewed_at IS NULL;
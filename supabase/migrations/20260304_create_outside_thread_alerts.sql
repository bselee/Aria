-- Migration: Create outside_thread_alerts table
-- Purpose: Dedup table for vendor emails found outside PO threads.
--          Prevents the same Gmail message from triggering duplicate Telegram
--          notifications on every 30-minute sync cycle.
-- Rollback: DROP TABLE IF EXISTS outside_thread_alerts;
CREATE TABLE IF NOT EXISTS outside_thread_alerts (
    gmail_message_id TEXT PRIMARY KEY,
    po_number TEXT NOT NULL,
    vendor_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Index for startup hydration query (last 14 days)
CREATE INDEX IF NOT EXISTS idx_outside_thread_alerts_created_at ON outside_thread_alerts (created_at);
-- Comment for clarity
COMMENT ON TABLE outside_thread_alerts IS 'Tracks Gmail message IDs already alerted on via the outside-PO-thread scan in syncPOConversations. Prevents duplicate Telegram notifications.';
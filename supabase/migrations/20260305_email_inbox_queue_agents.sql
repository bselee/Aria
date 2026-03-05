-- Migration: Add agent tracking columns to email_inbox_queue
-- Created: 2026-03-05
-- Rollback: ALTER TABLE email_inbox_queue DROP COLUMN IF EXISTS processed_by_ack, DROP COLUMN IF EXISTS processed_by_ap, DROP COLUMN IF EXISTS processed_by_tracking;
--
-- DECISION(2026-03-05): An email might contain both an invoice (AP Agent)
-- and a tracking number (Tracking Agent), and still need an Acknowledgement.
-- A single status string ('completed') would cause the first agent to hide the
-- row from the others. These separate boolean flags allow decoupled processing.
ALTER TABLE email_inbox_queue
ADD COLUMN IF NOT EXISTS processed_by_ack BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS processed_by_ap BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS processed_by_tracking BOOLEAN DEFAULT false;
-- Migration: Add source_inbox column to ap_inbox_queue
-- Created: 2026-03-05
-- Rollback: ALTER TABLE ap_inbox_queue DROP COLUMN IF EXISTS source_inbox;
--
-- REASON: APIdentifierAgent processes emails from multiple Gmail accounts
-- ("ap" and "default"). Downstream agents (ap-forwarder, reconciler) need
-- to know which Gmail token to use for label operations and message fetching.
ALTER TABLE ap_inbox_queue
    ADD COLUMN IF NOT EXISTS source_inbox TEXT DEFAULT 'ap';

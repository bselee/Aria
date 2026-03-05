-- Migration: Add threaded email columns
-- Created: 2026-03-05
ALTER TABLE email_inbox_queue
ADD COLUMN IF NOT EXISTS rfc_message_id TEXT,
    ADD COLUMN IF NOT EXISTS thread_id TEXT;
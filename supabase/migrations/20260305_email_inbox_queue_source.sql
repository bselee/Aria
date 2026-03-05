-- Migration: Add source_inbox to email_inbox_queue
-- Created: 2026-03-05
ALTER TABLE email_inbox_queue
ADD COLUMN IF NOT EXISTS source_inbox TEXT DEFAULT 'default';
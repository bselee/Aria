-- Migration: Add body_text and pdf_filenames to email_inbox_queue
-- Created: 2026-03-13
-- Rollback: ALTER TABLE email_inbox_queue DROP COLUMN IF EXISTS body_text;
--           ALTER TABLE email_inbox_queue DROP COLUMN IF EXISTS pdf_filenames;
--
-- DECISION(2026-03-13): PO #124462 revealed that storing only the Gmail snippet
-- (~200 chars) caused downstream agents to fail on inline invoice detection.
-- body_text stores the full decoded plain-text email body.
-- pdf_filenames stores an array of PDF attachment names for pre-classification
-- override logic (e.g., "BASPO-124462.pdf" → force INVOICE classification).

ALTER TABLE email_inbox_queue
    ADD COLUMN IF NOT EXISTS body_text TEXT,
    ADD COLUMN IF NOT EXISTS pdf_filenames TEXT[];

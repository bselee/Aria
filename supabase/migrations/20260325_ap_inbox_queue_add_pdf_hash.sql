-- Migration: Add pdf_content_hash to ap_inbox_queue for content-based dedup
-- Created: 2026-03-25
-- Purpose: Some vendors (e.g. Abel's ACE) send identical PDFs in separate emails
--          with different subjects or invoice numbers. Filename+subject dedup is
--          insufficient — hash the actual PDF bytes to catch true duplicates.
ALTER TABLE ap_inbox_queue
    ADD COLUMN IF NOT EXISTS pdf_content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_ap_inbox_queue_hash
    ON ap_inbox_queue (email_from, pdf_content_hash)
    WHERE pdf_content_hash IS NOT NULL;

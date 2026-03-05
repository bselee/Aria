-- Migration: Create ap_inbox_queue table
-- Created: 2026-03-05
-- Rollback: DROP TABLE IF EXISTS ap_inbox_queue;
--
-- DECISION(2026-03-05): Decoupling the AP agent into a queue-based system.
-- ap_inbox_queue acts as the central state machine for incoming invoices,
-- allowing identifier, extractor, matcher, and forwarder agents to run asynchronously.
CREATE TABLE IF NOT EXISTS ap_inbox_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id TEXT UNIQUE NOT NULL,
    email_from TEXT,
    email_subject TEXT,
    intent TEXT,
    pdf_path TEXT,
    pdf_filename TEXT,
    extracted_json JSONB,
    status TEXT NOT NULL DEFAULT 'PENDING_EXTRACTION',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Create a storage bucket for the PDFs if it doesn't exist
INSERT INTO storage.buckets (
        id,
        name,
        public,
        file_size_limit,
        allowed_mime_types
    )
VALUES (
        'ap_invoices',
        'ap_invoices',
        false,
        10485760,
        ARRAY ['application/pdf']
    ) ON CONFLICT (id) DO
UPDATE
SET allowed_mime_types = ARRAY ['application/pdf'];
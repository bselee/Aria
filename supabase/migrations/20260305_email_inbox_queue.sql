-- Migration: Create email_inbox_queue table
-- Created: 2026-03-05
-- Rollback: DROP TABLE IF EXISTS email_inbox_queue;
--
-- DECISION(2026-03-05): Decoupling email ingestion from agent processing.
-- A single ingestion worker will populate this table from Gmail, and agents 
-- (Tracking, Acknowledgement, AP Identifier) will process rows from here
-- to prevent API exhaustion and race conditions.
CREATE TABLE IF NOT EXISTS email_inbox_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The unique Gmail message ID to prevent duplicate ingestion
    gmail_message_id TEXT UNIQUE NOT NULL,
    -- Metadata about the email
    from_email TEXT,
    subject TEXT,
    body_snippet TEXT,
    -- Fast-path indicator so AP agents don't have to download the raw body if false
    has_pdf BOOLEAN DEFAULT false,
    -- Workflow Management
    -- unprocessed: Freshly ingested, untouched
    -- processing: Checked out by a worker
    -- completed: Processed successfully
    -- failed: Encounered an error during processing
    status TEXT NOT NULL DEFAULT 'unprocessed',
    -- Audit trail
    processed_by TEXT,
    -- the name of the agent that locked/completed it
    error_message TEXT,
    -- details if status = 'failed'
    -- Basic timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Note: We omit a trigger to update updated_at here for simplicity, 
-- but we should manually update it in our client code if needed.
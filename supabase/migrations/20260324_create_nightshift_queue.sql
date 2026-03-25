-- Migration: Create nightshift_queue table for local LLM email pre-classification
-- Created: 2026-03-24
-- Rollback: DROP TABLE IF EXISTS nightshift_queue;
--
-- DECISION(2026-03-24): Nightshift agent uses a local Qwen model (via llama-server)
-- to pre-classify AP emails overnight. Results are stored here so the 8 AM AP
-- identifier poll can skip the paid Sonnet call when confidence >= 0.7.
-- Safety: getPreClassification() returns null on any failure — daytime AP flow is
-- completely unaffected if the nightshift system never ran.

CREATE TABLE IF NOT EXISTS nightshift_queue (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type        TEXT NOT NULL DEFAULT 'email_classification',
    gmail_message_id TEXT NOT NULL,
    payload          JSONB NOT NULL DEFAULT '{}',
    -- { from_email, subject, body_snippet, source_inbox }
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','processing','completed','failed')),
    result           JSONB,
    -- { classification, confidence, handler, reasoning }
    handler          TEXT,  -- 'local' | 'claude-haiku'
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nightshift_queue_msg_type
    ON nightshift_queue (gmail_message_id, task_type);
CREATE INDEX IF NOT EXISTS idx_nq_status ON nightshift_queue (status)
    WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_nq_gmail_id ON nightshift_queue (gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_nq_expires  ON nightshift_queue (expires_at);

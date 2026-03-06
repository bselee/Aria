-- Migration: feedback_events table — Aria's Kaizen feedback loop
-- Created: 2026-03-06
-- Rollback: DROP TABLE IF EXISTS feedback_events;
--
-- DECISION(2026-03-06): Single table for ALL feedback signals.
-- Categories: correction, outcome, error_pattern, engagement, prediction, vendor_reliability
-- This table is the source of truth for Aria's self-improvement metrics.
CREATE TABLE IF NOT EXISTS feedback_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    -- What kind of feedback signal
    category TEXT NOT NULL CHECK (
        category IN (
            'correction',
            'outcome',
            'error_pattern',
            'engagement',
            'prediction',
            'vendor_reliability'
        )
    ),
    -- Specific event type (e.g. 'reconciliation_rejected', 'po_created_after_suggestion')
    event_type TEXT NOT NULL,
    -- Which agent generated this signal
    agent_source TEXT NOT NULL,
    -- What entity this feedback is about
    subject_type TEXT CHECK (
        subject_type IN (
            'vendor',
            'sku',
            'po',
            'invoice',
            'alert',
            'message',
            'build',
            NULL
        )
    ),
    subject_id TEXT,
    -- What Aria predicted/recommended
    prediction JSONB DEFAULT '{}'::jsonb,
    -- What actually happened
    actual_outcome JSONB DEFAULT '{}'::jsonb,
    -- Accuracy score (0.00 to 1.00) — null if not yet scoreable
    accuracy_score NUMERIC(3, 2) CHECK (
        accuracy_score IS NULL
        OR (
            accuracy_score >= 0
            AND accuracy_score <= 1
        )
    ),
    -- What the user did in response
    user_action TEXT CHECK (
        user_action IN (
            'approved',
            'rejected',
            'ignored',
            'corrected',
            'engaged',
            'snoozed',
            NULL
        )
    ),
    -- Extra context
    context_data JSONB DEFAULT '{}'::jsonb,
    -- Has this learning been synced to Pinecone memory?
    synced_to_memory BOOLEAN DEFAULT false
);
-- Indexes for common query patterns
CREATE INDEX idx_feedback_events_category_created ON feedback_events (category, created_at DESC);
CREATE INDEX idx_feedback_events_agent_created ON feedback_events (agent_source, created_at DESC);
CREATE INDEX idx_feedback_events_subject ON feedback_events (subject_type, subject_id)
WHERE subject_type IS NOT NULL;
CREATE INDEX idx_feedback_events_unsynced ON feedback_events (synced_to_memory)
WHERE synced_to_memory = false;
CREATE INDEX idx_feedback_events_accuracy ON feedback_events (category, accuracy_score)
WHERE accuracy_score IS NOT NULL;
ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON feedback_events USING (true) WITH CHECK (true);
COMMENT ON TABLE feedback_events IS 'Aria Kaizen feedback loop — every signal of "was Aria right?" flows through this table for accuracy tracking, self-review, and continuous improvement.';
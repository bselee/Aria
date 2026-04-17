-- Email Overwatch state for bill.selee inbox
-- Created: 2026-04-17

ALTER TABLE email_inbox_queue
    ADD COLUMN IF NOT EXISTS processed_by_overwatch BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS email_overwatch_threads (
    thread_id TEXT PRIMARY KEY,
    gmail_message_id TEXT,
    source_inbox TEXT DEFAULT 'default',
    intent TEXT,
    po_number TEXT,
    vendor_email TEXT,
    vendor_name TEXT,
    state TEXT NOT NULL DEFAULT 'human_review_required',
    confidence NUMERIC,
    uncertain_reason TEXT,
    last_vendor_reply_at TIMESTAMPTZ,
    last_bill_reply_at TIMESTAMPTZ,
    eta_text TEXT,
    eta_resolved_at TIMESTAMPTZ,
    tracking_numbers TEXT[] DEFAULT ARRAY[]::TEXT[],
    bol_or_pro_numbers TEXT[] DEFAULT ARRAY[]::TEXT[],
    next_follow_up_at TIMESTAMPTZ,
    follow_up_count INTEGER DEFAULT 0,
    last_draft_id TEXT,
    downstream_status TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_overwatch_threads_state
    ON email_overwatch_threads(state);

CREATE INDEX IF NOT EXISTS idx_email_overwatch_threads_next_follow_up
    ON email_overwatch_threads(next_follow_up_at)
    WHERE next_follow_up_at IS NOT NULL;

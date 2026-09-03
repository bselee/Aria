-- Migration: email_reply_rules — learned vendor reply corrections
-- Created: 2026-08-11
-- Rollback: DROP TABLE IF EXISTS email_reply_rules;
--
-- Background:
--   Aria drafts vendor replies for Bill to review. When Bill edits a draft
--   before sending (or deletes it unsent), that delta is ground truth for how
--   he actually writes. This table stores the extracted rules so future drafts
--   for the same vendor + context reuse Bill's own phrasing instead of
--   regenerating the boilerplate he keeps correcting.
--
-- Rule semantics:
--   rule_type = 'template'  → template is Bill's sent body with {name}
--                             substituted for the recipient first name.
--                             Applied when drafting the same vendor+context.
--   rule_type = 'no_reply'  → Bill deleted the draft unsent. Do not draft
--                             for this vendor+context again.
--
-- Keyed on (vendor_key, context) — a vendor can have a "no_reply" rule for
-- PO acknowledgements while still wanting drafts for price questions.
CREATE TABLE IF NOT EXISTS email_reply_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_key TEXT NOT NULL,
    context TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('template', 'no_reply')),
    template TEXT,
    source_draft_body TEXT,
    source_sent_body TEXT,
    source_event_id TEXT,
    times_learned INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE (vendor_key, context)
);

CREATE INDEX IF NOT EXISTS idx_email_reply_rules_vendor
    ON email_reply_rules (vendor_key);

ALTER TABLE email_reply_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON email_reply_rules
    USING (true) WITH CHECK (true);

COMMENT ON TABLE email_reply_rules IS
    'Learned vendor reply corrections from Bill editing/deleting Aria drafts.';

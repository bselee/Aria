-- Migration: create po_sends table
-- Tracks every PO that Aria commits in Finale and emails to vendors.
-- gmail_message_id + vendor_replied_at are hooks for future nudge automation via po-correlator.

CREATE TABLE IF NOT EXISTS po_sends (
    id                  BIGSERIAL PRIMARY KEY,
    po_number           TEXT NOT NULL,
    vendor_name         TEXT,
    vendor_party_id     TEXT,
    sent_to_email       TEXT NOT NULL,
    total_amount        NUMERIC(12,2),
    item_count          INTEGER,
    committed_at        TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    triggered_by        TEXT DEFAULT 'telegram',   -- 'telegram' | 'dashboard'
    gmail_message_id    TEXT,                      -- for reply tracking (future nudge feature)
    vendor_replied_at   TIMESTAMPTZ,               -- populated by po-correlator when reply detected
    metadata            JSONB,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_sends_po_number ON po_sends (po_number);
CREATE INDEX IF NOT EXISTS idx_po_sends_no_reply  ON po_sends (sent_at) WHERE vendor_replied_at IS NULL;

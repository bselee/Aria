-- Migration: pending_reconciliations
-- Purpose: Persist pending Telegram approval requests across pm2 restarts.
--          Previously these lived only in an in-memory Map (lost on restart).
--          Now storePendingApproval() writes here; approve/reject deletes the row.
-- Created: 2026-03-10

CREATE TABLE IF NOT EXISTS pending_reconciliations (
    approval_id         TEXT        PRIMARY KEY,
    invoice_number      TEXT,
    vendor_name         TEXT,
    po_number           TEXT,
    order_id            TEXT,
    result              JSONB       NOT NULL,           -- Full ReconciliationResult (serialized)
    telegram_message_id INTEGER,                        -- Telegram message ID for the approval prompt
    telegram_chat_id    TEXT,                           -- Chat ID to send follow-up to
    status              TEXT        NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL            -- created_at + 24h
);

-- Add status column to existing table if it was created without it
ALTER TABLE pending_reconciliations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_reconciliations_expires
    ON pending_reconciliations (expires_at);

CREATE INDEX IF NOT EXISTS idx_pending_reconciliations_order
    ON pending_reconciliations (order_id);

-- Migration: Create pending_dropships table
-- Purpose: Persist dropship PDF references across pm2 restarts.
--          Previously stored in an in-memory Map with setTimeout expiry,
--          which was lost on restart — PDFs gone, Telegram buttons dead.
--
-- Rollback: DROP TABLE IF EXISTS pending_dropships;
CREATE TABLE IF NOT EXISTS pending_dropships (
    id TEXT PRIMARY KEY,
    invoice_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0,
    subject TEXT,
    email_from TEXT,
    filename TEXT,
    document_id UUID,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'forwarded', 'expired', 'skipped')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);
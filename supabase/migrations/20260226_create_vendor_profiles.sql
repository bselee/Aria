-- Migration: Create vendor_profiles table for vendor intelligence
-- Created: 2026-02-26
-- Purpose: Store vendor communication patterns discovered from cross-inbox PO correlation.
--          Tracks how vendors respond to POs, enabling proactive follow-up and risk detection.
-- Rollback: DROP TABLE IF EXISTS vendor_profiles;
CREATE TABLE IF NOT EXISTS vendor_profiles (
    id BIGSERIAL PRIMARY KEY,
    vendor_name TEXT NOT NULL UNIQUE,
    vendor_emails TEXT [] DEFAULT '{}',
    total_pos INTEGER DEFAULT 0,
    responded_count INTEGER DEFAULT 0,
    communication_pattern TEXT DEFAULT 'no_response' CHECK (
        communication_pattern IN (
            'thread_reply',
            'separate_email',
            'no_response',
            'mixed'
        )
    ),
    last_po_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Index for vendor name lookups
CREATE INDEX IF NOT EXISTS idx_vendor_profiles_name ON vendor_profiles (vendor_name);
COMMENT ON TABLE vendor_profiles IS 'Vendor intelligence database built from cross-inbox PO email correlation.';
COMMENT ON COLUMN vendor_profiles.communication_pattern IS 'How the vendor typically responds to POs: thread_reply, separate_email, no_response, or mixed.';
COMMENT ON COLUMN vendor_profiles.responded_count IS 'Number of POs where the vendor replied to the PO email thread.';
-- Vendor PO Pattern Learning
-- Tracks per-vendor PO match success/failure to improve OCR extraction
-- Part of the cohesive AP pipeline (kaizen 2026-06-01)

CREATE TABLE IF NOT EXISTS vendor_po_patterns (
    id SERIAL PRIMARY KEY,
    vendor_name TEXT NOT NULL UNIQUE,
    po_format_hint TEXT,          -- LLM prompt hint for PO extraction
    examples JSONB DEFAULT '[]',  -- Array of {poNumber, invoiceDate, total, success: bool}
    confidence FLOAT DEFAULT 0.5, -- How confident we are in the pattern (0.0-1.0)
    fail_count INT DEFAULT 0,     -- Total PO match failures
    success_count INT DEFAULT 0,  -- Total PO match successes
    last_failed_at TIMESTAMPTZ,
    last_matched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_po_patterns_vendor
    ON vendor_po_patterns(vendor_name);

CREATE INDEX IF NOT EXISTS idx_vendor_po_patterns_confidence
    ON vendor_po_patterns(confidence DESC);
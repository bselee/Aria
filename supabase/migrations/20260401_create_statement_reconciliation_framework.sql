-- Migration: Create statement reconciliation framework tables
-- Created: 2026-04-01
-- Purpose: Durable intake queue + run history for on-demand vendor statement reconciliation.

CREATE TABLE IF NOT EXISTS statement_intake_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('email_statement', 'download_statement')),
    source_ref TEXT NOT NULL,
    artifact_path TEXT,
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('pdf', 'csv', 'none')),
    statement_date DATE,
    period_start DATE,
    period_end DATE,
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'processing', 'reconciled', 'needs_review', 'error', 'ignored')),
    adapter_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    queued_by TEXT NOT NULL,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_intake_queue_fingerprint
    ON statement_intake_queue (fingerprint);

CREATE INDEX IF NOT EXISTS idx_statement_intake_queue_status
    ON statement_intake_queue (status, discovered_at DESC);

CREATE INDEX IF NOT EXISTS idx_statement_intake_queue_vendor
    ON statement_intake_queue (vendor_name, discovered_at DESC);

CREATE TABLE IF NOT EXISTS statement_reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intake_id UUID NOT NULL REFERENCES statement_intake_queue(id) ON DELETE CASCADE,
    vendor_name TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    run_status TEXT NOT NULL DEFAULT 'queued'
        CHECK (run_status IN ('queued', 'processing', 'completed', 'needs_review', 'error')),
    trigger_source TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    normalized_statement_json JSONB,
    results_json JSONB,
    matched_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    mismatch_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    needs_review_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statement_reconciliation_runs_status
    ON statement_reconciliation_runs (run_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_statement_reconciliation_runs_intake
    ON statement_reconciliation_runs (intake_id, created_at DESC);

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'statement_artifacts',
    'statement_artifacts',
    false,
    20971520,
    ARRAY ['application/pdf', 'text/csv', 'application/csv']
) ON CONFLICT (id) DO UPDATE
SET allowed_mime_types = ARRAY ['application/pdf', 'text/csv', 'application/csv'];

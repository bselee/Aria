CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    invoices_found INT DEFAULT 0,
    invoices_processed INT DEFAULT 0,
    pos_updated INT DEFAULT 0,
    price_changes INT DEFAULT 0,
    freight_added_cents BIGINT DEFAULT 0,
    errors JSONB DEFAULT '[]'::jsonb,
    warnings JSONB DEFAULT '[]'::jsonb,
    summary TEXT,
    invoked_by TEXT DEFAULT 'manual' CHECK (invoked_by IN ('manual', 'cron', 'telegram')),
    run_args JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_recon_runs_vendor_started ON reconciliation_runs(vendor, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_runs_status ON reconciliation_runs(status) WHERE status IN ('running', 'failed', 'partial');

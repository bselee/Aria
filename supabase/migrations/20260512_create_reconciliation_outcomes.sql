-- Phase 1a observability: structured reconciliation outcome tracking.
-- Replaces freeform ap_activity_log entries with typed rows for dashboards and digests.

CREATE TABLE IF NOT EXISTS reconciliation_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL,
  invoice_id TEXT,
  po_id TEXT,
  vendor_name TEXT,
  outcome TEXT NOT NULL,
  outcome_meta JSONB,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

COMMENT ON COLUMN reconciliation_outcomes.outcome IS
  'Enum-by-convention. Allowed values:
    auto_applied        — reconciler updated the PO automatically (within thresholds)
    pending_approval    — queued to ap_pending_approvals, awaiting Will
    approved_by_user    — Will approved a pending proposal
    rejected_by_user    — Will rejected a pending proposal
    expired             — pending approval hit 24h TTL with no decision
    match_failed        — invoice arrived but no PO match found
    rejected_10x        — guardrail blocked: >=10x price magnitude shift
    rejected_invariant  — guardrail blocked: subtotal mismatch or price reasonableness check failed
    received_only       — receiving event without reconciliation context (future use; reserve)
  ';

CREATE INDEX IF NOT EXISTS idx_recon_outcomes_outcome_date ON reconciliation_outcomes (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_vendor ON reconciliation_outcomes (vendor_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_invoice ON reconciliation_outcomes (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_po ON reconciliation_outcomes (po_id) WHERE po_id IS NOT NULL;

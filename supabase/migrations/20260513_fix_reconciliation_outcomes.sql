-- Fix 3 reviewer-flagged issues from 20260512_create_reconciliation_outcomes.sql.
-- Table has zero rows, making all changes safe.

-- Issue 1: run_id should be UUID to match reconciliation_runs.id primary key type.
-- Avoids explicit casts on joins and ensures index compatibility.
ALTER TABLE reconciliation_outcomes
  ALTER COLUMN run_id TYPE UUID USING run_id::uuid;

-- Issue 2: Remove received_only from the outcome column comment (scope creep; no writer exists).
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
  ';

-- Issue 3: Make idx_recon_outcomes_vendor a partial index (WHERE vendor_name IS NOT NULL),
-- consistent with idx_recon_outcomes_invoice and idx_recon_outcomes_po patterns.
DROP INDEX IF EXISTS idx_recon_outcomes_vendor;
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_vendor
  ON reconciliation_outcomes (vendor_name, created_at DESC)
  WHERE vendor_name IS NOT NULL;

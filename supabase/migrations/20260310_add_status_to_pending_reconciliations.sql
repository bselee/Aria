-- Migration: Add status column to pending_reconciliations
-- Purpose: Enable marking entries as approved/rejected/expired instead of deleting.
--          Previously, rows were deleted on approve/reject/expire, losing the audit trail.
--          Now we keep the row and update the status.
--
-- Rollback: ALTER TABLE pending_reconciliations DROP COLUMN IF EXISTS status;
ALTER TABLE pending_reconciliations
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'rejected', 'expired')
    );
CREATE INDEX IF NOT EXISTS idx_pending_recon_status ON pending_reconciliations(status)
WHERE status = 'pending';
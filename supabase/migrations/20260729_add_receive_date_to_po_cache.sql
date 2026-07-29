-- Migration: Add receive_date to purchase_orders cache
-- Created: 2026-07-29
-- Purpose: Cache Finale's receiveDate so readCachedPos() can reconstruct
--          FullPO objects with accurate receipt status. Without this, the
--          hasPurchaseOrderReceipt() check falls back to status string only.
--          Combined with the po-receipt-state.ts fix (recognizing "Completed"
--          status), this eliminates false OVERDUE badges.

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS receive_date TIMESTAMPTZ;

COMMENT ON COLUMN purchase_orders.receive_date IS
    'Finale receiveDate — when the PO was fully or partially received. Cached for offline receipt detection.';

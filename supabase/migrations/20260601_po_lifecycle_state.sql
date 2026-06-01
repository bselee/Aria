-- PO Lifecycle State Machine
-- Tracks every PO through: ORDERED → INVOICED → RECONCILED → RECEIVED → COMPLETED
-- Part of the cohesive AP pipeline (kaizen 2026-06-01)

-- Add lifecycle state to purchase_orders
ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'ORDERED';

CREATE INDEX IF NOT EXISTS idx_purchase_orders_lifecycle
    ON purchase_orders(lifecycle_state, updated_at DESC);

-- State transition audit log
CREATE TABLE IF NOT EXISTS po_lifecycle_transitions (
    id SERIAL PRIMARY KEY,
    po_number VARCHAR(50) NOT NULL,
    from_state VARCHAR(20) NOT NULL,
    to_state VARCHAR(20) NOT NULL,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triggered_by VARCHAR(50) NOT NULL,
    metadata JSONB,
    invoice_id VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_po_lifecycle_po
    ON po_lifecycle_transitions(po_number, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_po_lifecycle_state
    ON po_lifecycle_transitions(to_state, transitioned_at DESC);
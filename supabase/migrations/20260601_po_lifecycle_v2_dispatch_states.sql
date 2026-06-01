-- PO Lifecycle State Migration V2
-- Adds dispatch stages: REVIEW, SENT, ACKNOWLEDGED, CANCELLED
-- Part of the trust-building pipeline (kaizen 2026-06-01)
--
-- Backward compatible: existing POs with state 'ORDERED' keep their state.
-- New POs default to 'REVIEW' instead of 'ORDERED'.

-- Widen column to fit longer state names (ACKNOWLEDGED = 12 chars)
ALTER TABLE purchase_orders
ALTER COLUMN lifecycle_state TYPE VARCHAR(30);

-- Change default from ORDERED to REVIEW for new POs
ALTER TABLE purchase_orders
ALTER COLUMN lifecycle_state SET DEFAULT 'REVIEW';

-- Add CANCELLED to po_lifecycle_transitions to_state (widen there too)
ALTER TABLE po_lifecycle_transitions
ALTER COLUMN from_state TYPE VARCHAR(30);

ALTER TABLE po_lifecycle_transitions
ALTER COLUMN to_state TYPE VARCHAR(30);

-- Update existing null/empty states to REVIEW
UPDATE purchase_orders
SET lifecycle_state = 'REVIEW'
WHERE lifecycle_state IS NULL OR lifecycle_state = '';

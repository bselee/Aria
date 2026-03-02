-- Migration: Add tracking_numbers to purchase_orders
-- Created: 2026-02-27
-- Purpose: Persist seen tracking numbers so syncPOConversations() can deduplicate
--          across runs. Without this column the upsert silently fails and the
--          same tracking alert fires every 30 minutes.
ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS tracking_numbers TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_po_tracking_numbers ON purchase_orders USING GIN (tracking_numbers);

COMMENT ON COLUMN purchase_orders.tracking_numbers IS 'Tracking numbers seen for this PO — used to prevent duplicate Telegram alerts.';

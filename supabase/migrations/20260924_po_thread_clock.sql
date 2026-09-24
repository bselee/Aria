-- Migration: PO thread clock. A sold-out hold is not lead time.
-- Created: 2026-09-24
-- Rollback:
--   ALTER TABLE purchase_orders
--     DROP COLUMN IF EXISTS thread_hold,
--     DROP COLUMN IF EXISTS thread_hold_started_at,
--     DROP COLUMN IF EXISTS thread_available_at,
--     DROP COLUMN IF EXISTS thread_shipped_at,
--     DROP COLUMN IF EXISTS thread_fulfill_lead_days,
--     DROP COLUMN IF EXISTS thread_hold_snippet,
--     DROP COLUMN IF EXISTS thread_clock_at;

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS thread_hold boolean,
    ADD COLUMN IF NOT EXISTS thread_hold_started_at date,
    ADD COLUMN IF NOT EXISTS thread_available_at date,
    ADD COLUMN IF NOT EXISTS thread_shipped_at date,
    ADD COLUMN IF NOT EXISTS thread_fulfill_lead_days integer,
    ADD COLUMN IF NOT EXISTS thread_hold_snippet text,
    ADD COLUMN IF NOT EXISTS thread_clock_at timestamptz;

COMMENT ON COLUMN purchase_orders.thread_hold IS
    'Vendor said sold out or backorder on this PO thread. Send-to-receive days are not lead time.';
COMMENT ON COLUMN purchase_orders.thread_fulfill_lead_days IS
    'Days from the restock message to the ship message. This is the fulfill lead.';

NOTIFY pgrst, 'reload schema';

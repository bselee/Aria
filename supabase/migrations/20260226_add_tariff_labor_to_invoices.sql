-- Migration: Add tariff and labor columns to invoices table
-- Created: 2026-02-26
-- Purpose: Support extraction of duties/tariffs and labor/handling fees from invoices
--          These feed into Finale's orderAdjustmentList for landed cost calculation
-- Rollback: ALTER TABLE invoices DROP COLUMN IF EXISTS tariff, DROP COLUMN IF EXISTS labor;
ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS tariff NUMERIC(12, 2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS labor NUMERIC(12, 2) DEFAULT 0;
-- Also ensure tracking_numbers array column exists for dedup tracking
ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS tracking_numbers TEXT [] DEFAULT '{}';
-- Index for tracking number deduplication lookups
CREATE INDEX IF NOT EXISTS idx_invoices_tracking_numbers ON invoices USING GIN (tracking_numbers);
COMMENT ON COLUMN invoices.tariff IS 'Duties, tariffs, import fees extracted from invoice. Maps to Finale productpromo 10014.';
COMMENT ON COLUMN invoices.labor IS 'Labor, handling, processing fees extracted from invoice. Maps to Finale productpromo 10016.';
COMMENT ON COLUMN invoices.tracking_numbers IS 'Tracking numbers from invoice, used for deduplication before writing to Finale.';
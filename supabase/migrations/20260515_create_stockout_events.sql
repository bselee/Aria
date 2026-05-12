-- ============================================================================
-- Stockout events — per-SKU log of when adjusted runway fell below lead time.
--
-- Detected at scan time in getBOMDemand. Reading the historical count lets
-- the urgency classifier pad lead time for SKUs that have stocked out before
-- — capturing the "burned by being late" signal lead-time medians can't.
-- ============================================================================

CREATE TABLE IF NOT EXISTS stockout_events (
    id BIGSERIAL PRIMARY KEY,
    product_id TEXT NOT NULL,
    vendor_party_id TEXT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detected_on DATE NOT NULL DEFAULT CURRENT_DATE,
    stock_on_hand NUMERIC,
    stock_on_order NUMERIC,
    daily_burn NUMERIC,
    runway_days NUMERIC,
    lead_time_days NUMERIC
);

-- One event row per SKU per day. Repeated scans on the same day upsert into
-- the same row rather than spamming the table.
CREATE UNIQUE INDEX IF NOT EXISTS stockout_events_product_day
    ON stockout_events (product_id, detected_on);

CREATE INDEX IF NOT EXISTS stockout_events_product
    ON stockout_events (product_id);

CREATE INDEX IF NOT EXISTS stockout_events_recent
    ON stockout_events (detected_at DESC);

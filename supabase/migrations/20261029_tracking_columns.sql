-- Tracking columns the Active Purchases select already reads.
-- `loadActivePurchases()` selects `tracking_paused` and `tracking_source`;
-- when they were absent PostgREST returned 42703, the error was never read,
-- and every enrichment field (tracking, ack, sent-verification, lifecycle,
-- vendor ETA) came back null on all open POs.

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tracking_paused boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tracking_source text;

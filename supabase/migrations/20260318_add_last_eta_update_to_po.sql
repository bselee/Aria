ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS last_eta_update JSONB DEFAULT '{}'::jsonb;
COMMENT ON COLUMN purchase_orders.last_eta_update IS 'Tracks the last known status of each tracking number to prevent redundant Slack updates.';

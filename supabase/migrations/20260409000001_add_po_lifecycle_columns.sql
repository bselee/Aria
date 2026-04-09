-- Add purchase_orders lifecycle and evidence columns
ALTER TABLE purchase_orders 
ADD COLUMN IF NOT EXISTS lifecycle_state TEXT,
ADD COLUMN IF NOT EXISTS evidence JSONB;

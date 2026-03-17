-- Add receiving status tracking to ap_activity_log
ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS receiving_status JSONB,
ADD COLUMN IF NOT EXISTS short_shipment_detected BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS short_shipment_lines TEXT[], -- SKU list of short-shipped lines
ADD COLUMN IF NOT EXISTS receiving_gap_total NUMERIC DEFAULT 0; -- Total units short across all lines

-- Create table for pending approvals queue
CREATE TABLE IF NOT EXISTS ap_pending_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  order_id TEXT,
  reconciliation_result JSONB NOT NULL,
  verdict_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'holding_credit_memo', 'rejected'
  telegram_message_id TEXT,
  telegram_chat_id TEXT,
  hold_reason TEXT,
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Index for quick lookup of short shipments
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_short_shipment
  ON ap_activity_log(short_shipment_detected, created_at DESC)
  WHERE short_shipment_detected = TRUE;

-- Index for pending approvals
CREATE INDEX IF NOT EXISTS idx_ap_pending_approvals_status
  ON ap_pending_approvals(status, expires_at);

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT,
    ADD COLUMN IF NOT EXISTS draft_created_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS po_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS po_email_message_id TEXT,
    ADD COLUMN IF NOT EXISTS vendor_acknowledged_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vendor_ack_source TEXT,
    ADD COLUMN IF NOT EXISTS shipping_evidence JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS tracking_status_summary TEXT,
    ADD COLUMN IF NOT EXISTS tracking_unavailable_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tracking_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tracking_request_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_tracking_evidence_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_movement_update_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_movement_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_lifecycle_stage
    ON purchase_orders (lifecycle_stage);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_tracking_requested_at
    ON purchase_orders (tracking_requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor_acknowledged_at
    ON purchase_orders (vendor_acknowledged_at DESC);

COMMENT ON COLUMN purchase_orders.lifecycle_stage IS
    'Derived operational PO lifecycle stage driven by send, acknowledgement, shipping, receipt, and AP evidence.';

COMMENT ON COLUMN purchase_orders.shipping_evidence IS
    'Normalized evidence trail describing shipping signals such as vendor ETA, invoice shipment context, BOL, or tracking.';

COMMENT ON COLUMN purchase_orders.tracking_status_summary IS
    'Latest trusted carrier or ETA summary suitable for purchasing dashboard and calendar displays.';

COMMENT ON COLUMN purchase_orders.tracking_unavailable_at IS
    'Timestamp when automation concluded tracking was still unavailable and a clear vendor ask was warranted.';

COMMENT ON COLUMN purchase_orders.tracking_requested_at IS
    'Most recent timestamp when automation asked the vendor for tracking or ETA details.';

COMMENT ON COLUMN purchase_orders.last_tracking_evidence_at IS
    'Most recent timestamp when trustworthy tracking or ETA evidence was captured for this PO.';

COMMENT ON COLUMN purchase_orders.last_movement_update_at IS
    'Most recent timestamp when a material movement update was recorded from trusted tracking evidence.';

COMMENT ON COLUMN purchase_orders.last_movement_summary IS
    'Latest concise movement summary for this PO, used to avoid duplicate daily movement updates.';

-- GIN index for JSONB metadata lookups in po-receipt-recheck and other queries
-- Speeds up filter("metadata->poNumber", "eq", ...) queries on ap_activity_log
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_metadata_poNumber
    ON ap_activity_log USING GIN (metadata jsonb_path_ops)
    WHERE metadata ? 'poNumber';
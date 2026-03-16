-- Migration: Create price_change_audit table for queryable cost tracking
-- Created: 2026-03-13
-- Rollback: DROP TABLE IF EXISTS price_change_audit;
--
-- DECISION(2026-03-13): PO #124462 exposed that price/fee data was only in JSONB
-- (ap_activity_log.reconciliation_report), making it impossible to answer
-- "What did we pay vendor X for freight?" or "Show all price changes for SKU Y".
-- This flat table enables simple SQL queries for any cost audit question.

CREATE TABLE IF NOT EXISTS price_change_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number TEXT NOT NULL,
    vendor_name TEXT,
    invoice_number TEXT,
    -- 'item_price' | 'freight' | 'tax' | 'tariff' | 'labor' | 'discount' | 'fuel_surcharge'
    change_type TEXT NOT NULL,
    sku TEXT,                      -- NULL for fee changes
    description TEXT,
    old_value NUMERIC(12,4),       -- prior PO value (0 if new fee)
    new_value NUMERIC(12,4),       -- invoice value being applied
    quantity NUMERIC(12,4),        -- for item prices: used in dollar_impact calc
    dollar_impact NUMERIC(12,4),   -- (new - old) * qty for items; (new - old) for fees
    percent_change NUMERIC(8,4),
    verdict TEXT,                  -- auto_approve | needs_approval | rejected | no_change
    approved_by TEXT,              -- 'system' | 'Will'
    carrier_name TEXT,             -- for freight/shipping context
    tracking_numbers TEXT[],       -- associated tracking
    source TEXT DEFAULT 'pdf_invoice',  -- 'pdf_invoice' | 'inline_invoice' | 'manual'
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common audit queries
CREATE INDEX IF NOT EXISTS idx_price_audit_po ON price_change_audit(po_number);
CREATE INDEX IF NOT EXISTS idx_price_audit_vendor ON price_change_audit(vendor_name);
CREATE INDEX IF NOT EXISTS idx_price_audit_sku ON price_change_audit(sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_audit_type ON price_change_audit(change_type);
CREATE INDEX IF NOT EXISTS idx_price_audit_date ON price_change_audit(created_at);

-- Example audit queries this table enables:
-- "What freight have we paid to Organic AG Products?"
--   SELECT * FROM price_change_audit WHERE vendor_name ILIKE '%organic ag%' AND change_type = 'freight';
--
-- "Show all price changes for SKU BLM209"
--   SELECT * FROM price_change_audit WHERE sku = 'BLM209' AND change_type = 'item_price' ORDER BY created_at;
--
-- "Total tariffs this month"
--   SELECT SUM(new_value) FROM price_change_audit WHERE change_type = 'tariff' AND created_at >= date_trunc('month', now());

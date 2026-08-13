-- supabase/migrations/20260812_create_po_receipt_data.sql
--
-- Receiving leg for three-way match + variance views.
--
-- PROBLEM (audit 2026-08-11 A-11 / U04): ap_receiving_variance_analysis had
-- 19 vendor rows but ALL NULL ordered/received/short because the receipt leg
-- was never populated. The view read metadata->'receivingStatus' from
-- ap_activity_log, and nothing ever wrote receivingStatus. Three-way match and
-- short-ship detection were blind.
--
-- FIX: a dedicated po_receipt_data table (per-PO receipt facts from Finale),
-- populated by src/lib/purchasing/finale-receipt-sync.ts. The variance and
-- short-ship views are rewritten to source from it instead of the empty
-- metadata path.
--
-- DECISION(2026-08-12): receipt quantities come from Finale shipment detail
-- receipt items (getShipmentReceiptItems), NOT from PO status. Finale
-- auto-completes POs on quantity match, so status="Completed" is not proof of
-- physical receipt. Only actual shipment receiveDate + per-line receipt items
-- are used.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.po_receipt_data;
--   (views are CREATE OR REPLACE; re-apply the original 20260317 definitions
--    to restore the old metadata-based views)

CREATE TABLE IF NOT EXISTS public.po_receipt_data (
    po_number        TEXT        PRIMARY KEY,
    vendor_name      TEXT,
    total_ordered    NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_received   NUMERIC(12, 2) NOT NULL DEFAULT 0,
    units_short      NUMERIC(12, 2) NOT NULL DEFAULT 0,
    fully_received   BOOLEAN     NOT NULL DEFAULT FALSE,
    last_receipt_date DATE,
    line_items       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.po_receipt_data IS
    'Per-PO receipt facts synced from Finale shipment details. '
    'Receipt leg for three-way match + variance views. '
    'Populated by finale-receipt-sync (po-receipt-recheck cron).';

COMMENT ON COLUMN public.po_receipt_data.total_ordered  IS 'Units ordered on the PO (base units).';
COMMENT ON COLUMN public.po_receipt_data.total_received IS 'Units physically received (from Finale shipment receipt items).';
COMMENT ON COLUMN public.po_receipt_data.units_short    IS 'total_ordered - total_received, floor 0.';
COMMENT ON COLUMN public.po_receipt_data.line_items     IS '[{sku, ordered, received}] per line, for drill-down + UOM validation.';
COMMENT ON COLUMN public.po_receipt_data.fetched_at     IS 'Last successful sync time; freshness gate for the cron.';

CREATE INDEX IF NOT EXISTS po_receipt_data_vendor_idx
    ON public.po_receipt_data (vendor_name);

-- ─────────────────────────────────────────────────────────────────────────────
-- Variance view: vendors WITH receipts (receipt reality) + optional invoice
-- counts from RECONCILIATION activity, so ordered/received/short are non-null
-- for every vendor that has receipt data.
-- DROP + CREATE (not OR REPLACE) because the old views' column types differ
-- (e.g. first_occurrence was timestamptz; now date). Views carry no data.
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS ap_receiving_variance_analysis;
CREATE VIEW ap_receiving_variance_analysis AS
SELECT
    r.vendor_name AS vendor,
    COUNT(DISTINCT a.id) AS invoices_processed,
    ROUND(SUM(r.total_ordered), 0) AS total_units_ordered,
    ROUND(SUM(r.total_received), 0) AS total_units_received,
    ROUND(SUM(r.units_short), 0) AS units_short,
    ROUND(
        (SUM(r.total_received) / NULLIF(SUM(r.total_ordered), 0)) * 100,
        2
    ) AS receipt_percentage
FROM po_receipt_data r
LEFT JOIN ap_activity_log a
    ON a.intent = 'RECONCILIATION'
    AND COALESCE(a.metadata->>'orderId', a.metadata->>'poNumber') = r.po_number
GROUP BY r.vendor_name
ORDER BY units_short DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- Short-ship view: derived from the receipt leg — vendors whose POs arrived
-- short (received < ordered). Replaces the old metadata->short_shipment_detected
-- path, which was never populated.
-- ─────────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS ap_short_shipments_by_vendor;
CREATE VIEW ap_short_shipments_by_vendor AS
SELECT
    r.vendor_name AS vendor,
    COUNT(*) AS shipment_count,
    COUNT(DISTINCT r.po_number) AS affected_invoices,
    ROUND(SUM(r.units_short), 2) AS total_gap_amount,
    MIN(r.last_receipt_date) AS first_occurrence,
    MAX(r.last_receipt_date) AS latest_occurrence
FROM po_receipt_data r
WHERE r.units_short > 0
GROUP BY r.vendor_name
ORDER BY shipment_count DESC;

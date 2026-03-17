CREATE OR REPLACE VIEW ap_reconciliation_daily_summary AS
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS total_invoices,
  COUNT(CASE WHEN metadata->>'verdict' = 'auto_approve' THEN 1 END) AS auto_approved,
  COUNT(CASE WHEN metadata->>'verdict' = 'needs_approval' THEN 1 END) AS needs_approval,
  COUNT(CASE WHEN metadata->>'verdict' = 'short_shipment_hold' THEN 1 END) AS short_shipment_holds,
  COUNT(CASE WHEN metadata->>'verdict' = 'rejected' THEN 1 END) AS rejected,
  ROUND(SUM(CAST(metadata->>'invoiceTotal' AS NUMERIC)), 2) AS total_amount,
  COUNT(CASE WHEN short_shipment_detected = TRUE THEN 1 END) AS short_shipments_detected,
  ROUND(SUM(receiving_gap_total), 2) AS total_receiving_gaps
FROM ap_activity_log
WHERE intent = 'RECONCILIATION'
GROUP BY DATE(created_at)
ORDER BY DATE DESC;

CREATE OR REPLACE VIEW ap_short_shipments_by_vendor AS
SELECT
  metadata->>'vendorName' AS vendor,
  COUNT(*) AS shipment_count,
  COUNT(DISTINCT metadata->>'invoiceNumber') AS affected_invoices,
  ROUND(SUM(receiving_gap_total), 2) AS total_gap_amount,
  MIN(created_at) AS first_occurrence,
  MAX(created_at) AS latest_occurrence
FROM ap_activity_log
WHERE intent = 'RECONCILIATION' AND short_shipment_detected = TRUE
GROUP BY metadata->>'vendorName'
ORDER BY shipment_count DESC;

CREATE OR REPLACE VIEW ap_pending_approvals_active AS
SELECT
  id,
  invoice_number,
  vendor_name,
  order_id,
  verdict_type,
  status,
  AGE(expires_at, created_at) AS ttl_remaining,
  created_at
FROM ap_pending_approvals
WHERE status = 'pending' AND expires_at > NOW()
ORDER BY created_at DESC;

CREATE OR REPLACE VIEW ap_receiving_variance_analysis AS
SELECT
  metadata->>'vendorName' AS vendor,
  COUNT(*) AS invoices_processed,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC)),
    0
  ) AS total_units_ordered,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)),
    0
  ) AS total_units_received,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC))
    - SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)),
    0
  ) AS units_short,
  ROUND(
    (SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)) /
      NULLIF(SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC)), 0)
    ) * 100,
    2
  ) AS receipt_percentage
FROM ap_activity_log
WHERE intent = 'RECONCILIATION'
GROUP BY metadata->>'vendorName'
ORDER BY units_short DESC;

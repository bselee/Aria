-- supabase/migrations/20260812_backfill_po_shipment_legs.sql
--
-- One-time backfill: link the canonical shipments tracking store to purchase
-- orders via po_shipment_legs (the join table). For every shipment that
-- carries PO references in shipments.po_numbers, insert one tracking-link
-- leg row per (shipment, po) pair.
--
-- Why expected_qty = 1: the shipment evidence does not carry per-leg
-- quantities, and po_shipment_legs requires expected_qty > 0. The
-- recommender only reads legs for vendors flagged is_bulk_vendor=true;
-- this backfill SKIPS bulk-vendor POs so no delivery-schedule math is
-- ever touched by tracking-link rows. For non-bulk POs the legs are a
-- join/evidence record (tracking_number + carrier_name + dates).
--
-- Idempotent: skips pairs already linked by the same tracking number, and
-- continues leg_number past any legs the PO already has (fixes the
-- po_shipment_legs_po_number_leg_number_key collision on re-run after the
-- cache→PG sync added new shipments).
-- Rollback: DELETE FROM po_shipment_legs WHERE notes LIKE
--   'tracking-link backfill from shipments%';

BEGIN;

INSERT INTO po_shipment_legs (
    po_number,
    vendor_party_id,
    vendor_name,
    leg_number,
    expected_qty,
    expected_date,
    actual_date,
    tracking_number,
    carrier_name,
    notes,
    updated_at
)
SELECT
    s.po AS po_number,
    p.vendor_party_id,
    p.vendor_name,
    COALESCE(existing.max_leg, 0) + ROW_NUMBER() OVER (
        PARTITION BY s.po ORDER BY sh.created_at, sh.tracking_key
    ) AS leg_number,
    1 AS expected_qty,
    COALESCE(sh.estimated_delivery_at, sh.delivered_at, sh.created_at)::date AS expected_date,
    CASE WHEN sh.status_category = 'delivered'
         THEN sh.delivered_at::date ELSE NULL END AS actual_date,
    sh.tracking_number,
    sh.carrier_name,
    'tracking-link backfill from shipments (t_1cb3c67c); qty placeholder, not a delivery schedule',
    NOW()
FROM (
    SELECT sh.id AS shipment_id, unnest(sh.po_numbers) AS po
    FROM shipments sh
    WHERE coalesce(array_length(sh.po_numbers, 1), 0) > 0
) s
JOIN shipments sh ON sh.id = s.shipment_id
LEFT JOIN purchase_orders p ON p.po_number = s.po
LEFT JOIN (
    SELECT po_number, MAX(leg_number) AS max_leg
    FROM po_shipment_legs
    GROUP BY po_number
) existing ON existing.po_number = s.po
WHERE NOT EXISTS (
    -- Skip pairs already linked by the same tracking number (idempotent re-run).
    SELECT 1 FROM po_shipment_legs l
    WHERE l.po_number = s.po AND l.tracking_number = sh.tracking_number
)
AND NOT EXISTS (
    -- Skip bulk-vendor POs: their legs are real delivery schedules and must
    -- stay under /legs control, not be polluted by tracking-link placeholders.
    SELECT 1 FROM vendor_reorder_policies vrp
    WHERE vrp.vendor_party_id = p.vendor_party_id
      AND vrp.is_bulk_vendor = true
);

-- Verification report
SELECT
    (SELECT COUNT(*) FROM po_shipment_legs) AS total_legs,
    (SELECT COUNT(DISTINCT po_number) FROM po_shipment_legs) AS distinct_pos,
    (SELECT COUNT(DISTINCT tracking_number) FROM po_shipment_legs WHERE tracking_number IS NOT NULL) AS linked_tracking_numbers,
    (SELECT COUNT(*) FROM shipments WHERE coalesce(array_length(po_numbers, 1), 0) > 0) AS shipments_with_po_refs;

COMMIT;

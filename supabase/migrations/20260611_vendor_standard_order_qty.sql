/**
 * v2.6 — Add standard_order_qty to vendor_reorder_policies.
 *
 * Per-vendor explicit ordering floor. "Faust always gets 20."
 * When set, the qty-recommender enforces this as a HARD floor
 * on suggestedQty, preventing POs from going out under the
 * vendor's typical order amount.
 *
 * NULL = use historical auto-detect (skuPurchaseHistory pattern).
 */

ALTER TABLE vendor_reorder_policies
ADD COLUMN IF NOT EXISTS standard_order_qty integer;

COMMENT ON COLUMN vendor_reorder_policies.standard_order_qty
IS 'Per-vendor standard order quantity. When set, recommender enforces this as a floor on suggestedQty. NULL = use historical auto-detect.';

-- Backfill Faust Bio Agriculture with standard order qty of 20
-- (consistent historical pattern — every PO has been 20 units)
UPDATE vendor_reorder_policies
SET standard_order_qty = 20
WHERE vendor_party_id IN (
    SELECT DISTINCT vendor_party_id
    FROM vendor_reorder_policies
    WHERE vendor_name ILIKE '%faust%'
);

-- Colorful Packaging: tighten target_cover_days from 180 → 90
-- 180d = "order 6 months" was too aggressive with 3 active POs.
-- 90d + 60d lead time = 150d threshold: items below 150d trigger order.
UPDATE vendor_reorder_policies
SET target_cover_days = 90,
    notes = 'Custom bagging: 60d build/ship. Order ~90d supply (tightened 2026-06-23 — 3 active POs)',
    updated_at = NOW()
WHERE vendor_party_id = '10918';

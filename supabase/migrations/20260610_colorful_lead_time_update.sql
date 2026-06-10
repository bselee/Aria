-- supabase/migrations/20260610_colorful_lead_time_update.sql
--
-- Update Colorful Packaging's vendor_reorder_policies to reflect the actual
-- build/ship time from payment (60 days, not the original 45d estimate).
--
-- Bill confirmed 2026-06-10:
--   - Lead time: 60 days from payment (was 45d)
--   - Cover target: 180 days (6 months of bagging supply) — already correct
--   - MOQ mode: 'warn' (keep — CC vendor, no hard MOQ enforcement needed on drafts)
--
-- The target_cover_days stays at 180 — orders roughly 6 months of supply.
-- With the 60d lead time now correct, the BOM pipeline will:
--   - Classify urgency correctly (critical when adjustedRunway < 60d)
--   - Suggest qty = dailyBurn × 180d - stockOnHand
--   - Project next-order-date correctly

UPDATE public.vendor_reorder_policies
SET
    lead_time_override_days = 60,
    notes = 'Custom bagging: 60 day build/ship from payment. Order 4-6 months supply at a time.',
    updated_at = now()
WHERE vendor_party_id = '10918';

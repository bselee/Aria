-- supabase/migrations/20260521_add_bulk_order_cols_to_vendor_reorder_policies.sql
--
-- Adds bulk-order metadata to vendor_reorder_policies.
-- is_bulk_vendor = true enables the leg-aware credit path in the recommender.
-- typical_leg_count / typical_leg_interval_days pre-populate the leg entry UI
-- and are used by the Telegram /legs command to suggest a default schedule.
--
-- Default-unchanged invariant: all existing vendors default to is_bulk_vendor = false
-- and keep exactly current behavior.
--
-- Rollback:
--   ALTER TABLE public.vendor_reorder_policies
--       DROP COLUMN IF EXISTS is_bulk_vendor,
--       DROP COLUMN IF EXISTS typical_leg_count,
--       DROP COLUMN IF EXISTS typical_leg_interval_days;

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS is_bulk_vendor              BOOLEAN  NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS typical_leg_count           INTEGER,    -- e.g. 3 = "usually 3 trucks"
    ADD COLUMN IF NOT EXISTS typical_leg_interval_days   INTEGER;    -- e.g. 30 = "one truck per month"

COMMENT ON COLUMN public.vendor_reorder_policies.is_bulk_vendor IS
    'When true, the recommender uses po_shipment_legs to credit incoming supply per-leg '
    'instead of crediting the full PO quantity at once.';
COMMENT ON COLUMN public.vendor_reorder_policies.typical_leg_count IS
    'Typical number of delivery legs for a bulk order from this vendor. '
    'Used to pre-populate the /legs command default schedule.';
COMMENT ON COLUMN public.vendor_reorder_policies.typical_leg_interval_days IS
    'Typical days between consecutive delivery legs from this vendor. '
    'Combined with typical_leg_count to auto-suggest leg dates.';

-- ── Seed Covico and Plantae ────────────────────────────────────────────────
-- TODO(will)[2026-05-21]: Replace '?????' with actual Finale party IDs.
--   Find them at: Finale → Contacts → [vendor name] → URL ends with /partygroup/{id}
--
-- INSERT INTO public.vendor_reorder_policies
--     (vendor_party_id, vendor_name, is_bulk_vendor, typical_leg_count, typical_leg_interval_days, notes)
-- VALUES
--     ('?????', 'Covico',  true, 3, 30, 'CWP101 worm castings — typically 3 truck shipments ~30d apart'),
--     ('?????', 'Plantae', true, 2, 45, 'Quillaja extract — typically 2 legs ~45d apart')
-- ON CONFLICT (vendor_party_id) DO UPDATE SET
--     is_bulk_vendor              = EXCLUDED.is_bulk_vendor,
--     typical_leg_count           = EXCLUDED.typical_leg_count,
--     typical_leg_interval_days   = EXCLUDED.typical_leg_interval_days,
--     notes                       = EXCLUDED.notes,
--     updated_at                  = now();

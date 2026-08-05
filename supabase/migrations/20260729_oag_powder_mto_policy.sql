-- supabase/migrations/20260729_oag_powder_mto_policy.sql
--
-- Organics Alive powder MTO policy (Bill / Martin 2026-07-28):
--   - Powders make-to-order, not stocked Edmonton, 100–120d lead, pay upfront
--   - Lot sizes locked to PO 124788 (2760 / 5520)
--   - auto_update_override FALSE — never let observed liquid/FPF POs dilute 120d
--   - FPF finished is CYC fill (handled in code); this row is vendor planning defaults
--
-- SKU-level 120d for OAG222–225 is enforced in oag-powder-policy.ts regardless
-- of which Finale party (OA vs ASLE) the powder is tagged under.

INSERT INTO public.vendor_reorder_policies (
    vendor_party_id,
    vendor_name,
    lead_time_override_days,
    target_cover_days,
    moq_mode,
    overbuy_review_pct,
    overbuy_review_dollars,
    notes,
    favorite_batches,
    is_bulk_vendor,
    auto_update_override,
    updated_at
)
VALUES (
    '10566',
    'Organics Alive',
    120,
    90,
    'warn',
    50,
    5000,
    'POWDER MTO 100-120d (Martin 2026-07-28). Pay upfront Canada. Lots 2760/5520 per PO 124788. FPF OAG218/219 = CYC finished fill — do not cycle-lock powders on FPF-only POs. Never order OAG228 RAW FPF. auto_update OFF.',
    ARRAY[2760, 5520]::numeric[],
    false,
    false,
    now()
)
ON CONFLICT (vendor_party_id) DO UPDATE SET
    vendor_name = EXCLUDED.vendor_name,
    lead_time_override_days = EXCLUDED.lead_time_override_days,
    target_cover_days = EXCLUDED.target_cover_days,
    moq_mode = EXCLUDED.moq_mode,
    overbuy_review_pct = EXCLUDED.overbuy_review_pct,
    overbuy_review_dollars = EXCLUDED.overbuy_review_dollars,
    notes = EXCLUDED.notes,
    favorite_batches = EXCLUDED.favorite_batches,
    is_bulk_vendor = EXCLUDED.is_bulk_vendor,
    auto_update_override = EXCLUDED.auto_update_override,
    updated_at = now();

-- supabase/migrations/20260506000002_vendor_reorder_policies.sql
--
-- Vendor-level reorder planning policy. Separate from vendor_minimum_orders
-- on purpose: MOQ rows are *facts* (vendor stated this); policy rows are
-- *preferences* (we chose to handle MOQ this way / use 180d cover here).
--
-- Default-unchanged invariant: every vendor without a row keeps current
-- behavior. Default moq_mode is 'enforce' to match existing pipeline
-- semantics.

CREATE TABLE IF NOT EXISTS public.vendor_reorder_policies (
    vendor_party_id            TEXT PRIMARY KEY,
    vendor_name                TEXT,
    lead_time_override_days    INTEGER,
    target_cover_days          INTEGER,
    moq_mode                   TEXT NOT NULL DEFAULT 'enforce',
    overbuy_review_pct         NUMERIC(8,2) NOT NULL DEFAULT 50,
    overbuy_review_dollars     NUMERIC(12,2) NOT NULL DEFAULT 1000,
    notes                      TEXT,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vendor_reorder_policies_moq_mode_chk
        CHECK (moq_mode IN ('enforce', 'warn', 'ignore')),
    CONSTRAINT vendor_reorder_policies_lead_chk
        CHECK (lead_time_override_days IS NULL OR lead_time_override_days > 0),
    CONSTRAINT vendor_reorder_policies_cover_chk
        CHECK (target_cover_days IS NULL OR target_cover_days > 0)
);

COMMENT ON TABLE public.vendor_reorder_policies IS
    'Vendor-level reorder planning policy. Finale remains SKU-level source for order increments; this table controls vendor lead-time override, cover window, MOQ behavior, and review thresholds.';

INSERT INTO public.vendor_reorder_policies (
    vendor_party_id,
    vendor_name,
    lead_time_override_days,
    target_cover_days,
    moq_mode,
    overbuy_review_pct,
    overbuy_review_dollars,
    notes
)
VALUES (
    '10918',
    'Colorful Packaging Ltd',
    45,
    180,
    'warn',
    50,
    1000,
    'Custom packaging: 30-45 day lead time, order roughly 6 months at a time.'
)
ON CONFLICT (vendor_party_id) DO UPDATE SET
    vendor_name             = EXCLUDED.vendor_name,
    lead_time_override_days = EXCLUDED.lead_time_override_days,
    target_cover_days       = EXCLUDED.target_cover_days,
    moq_mode                = EXCLUDED.moq_mode,
    overbuy_review_pct      = EXCLUDED.overbuy_review_pct,
    overbuy_review_dollars  = EXCLUDED.overbuy_review_dollars,
    notes                   = EXCLUDED.notes,
    updated_at              = now();

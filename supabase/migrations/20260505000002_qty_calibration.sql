-- Phase 2-3 of canonical-formula rollout: calibration loop, draft reservation,
-- vendor MOQ, and the data needed to compute "Aria vs Finale" divergence stats.

-- ──────────────────────────────────────────────────
-- qty_recommendations — every recommendation snapshot
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qty_recommendations (
    id              BIGSERIAL PRIMARY KEY,
    product_id      TEXT NOT NULL,
    vendor_party_id TEXT,
    vendor_name     TEXT,
    formula_version TEXT NOT NULL,
    recommended_qty NUMERIC(14,2) NOT NULL,
    finale_reorder_qty NUMERIC(14,2),
    inputs_jsonb    JSONB NOT NULL,
    provenance_jsonb JSONB,
    recommended_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Filled in by the receive hook after the PO that consumed this recommendation closes:
    po_number       TEXT,
    actual_consumed_eaches NUMERIC(14,2),
    consumption_window_days INTEGER,
    error_pct       NUMERIC(8,2),
    calibrated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS qty_recs_product_idx
    ON public.qty_recommendations (product_id, recommended_at DESC);
CREATE INDEX IF NOT EXISTS qty_recs_vendor_idx
    ON public.qty_recommendations (vendor_party_id, recommended_at DESC);
CREATE INDEX IF NOT EXISTS qty_recs_uncalibrated_idx
    ON public.qty_recommendations (po_number)
    WHERE calibrated_at IS NULL AND po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS qty_recs_formula_idx
    ON public.qty_recommendations (formula_version, recommended_at DESC);

COMMENT ON TABLE public.qty_recommendations IS
    'Phase 2 calibration snapshot. One row per (product_id, recommended_at) capturing the inputs and formula version used so we can later compute error_pct against actual consumption.';

-- ──────────────────────────────────────────────────
-- qty_reservations — draft PO reservation, 72h TTL
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qty_reservations (
    id              BIGSERIAL PRIMARY KEY,
    product_id      TEXT NOT NULL,
    vendor_party_id TEXT,
    qty             NUMERIC(14,2) NOT NULL,
    draft_po_number TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '72 hours',
    released_at     TIMESTAMPTZ,
    release_reason  TEXT
);

CREATE INDEX IF NOT EXISTS qty_reservations_active_idx
    ON public.qty_reservations (product_id)
    WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS qty_reservations_draft_idx
    ON public.qty_reservations (draft_po_number);

COMMENT ON TABLE public.qty_reservations IS
    'Phase 3a — when a draft PO is created, qty for each line is reserved here so the next recommendation cycle does not double-order. Auto-releases on commit, cancel, or 72h TTL.';

-- ──────────────────────────────────────────────────
-- vendor_minimum_orders — MOQ enforcement at recommend time
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_minimum_orders (
    vendor_party_id TEXT PRIMARY KEY,
    vendor_name     TEXT,
    minimum_order_dollars NUMERIC(12,2),
    minimum_order_eaches  NUMERIC(14,2),
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_minimum_orders IS
    'Vendor minimum-order constraints applied at recommend time so the panel never suggests an order that would be rejected by the vendor. Either dollar or each-count threshold.';

-- ──────────────────────────────────────────────────
-- vendor_calibration_stats — rolling per-vendor error stats
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_calibration_stats (
    vendor_party_id TEXT PRIMARY KEY,
    vendor_name     TEXT,
    sample_count    INTEGER NOT NULL DEFAULT 0,
    median_error_pct NUMERIC(8,2),
    mean_error_pct  NUMERIC(8,2),
    bias_pct        NUMERIC(8,2),
    safety_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.0,
    last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_calibration_stats IS
    'Rolling calibration metrics per vendor. safety_multiplier is fed back into the recommender when |median_error_pct| exceeds 25% so future recommendations adjust. bias_pct distinguishes consistent over-ordering from under-ordering.';

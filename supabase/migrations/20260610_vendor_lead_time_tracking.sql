-- supabase/migrations/20260610_vendor_lead_time_tracking.sql
--
-- Adds observed lead-time statistics + auto-update opt-in for vendor policies.
--
-- Layer 1: vendor_lead_time_stats — persist observed P50/P90/on-time-rate
-- Layer 3: auto_update_override on vendor_reorder_policies — opt-in auto-update
--          with drift-detection guardrails

-- ── Layer 1: Observed lead time stats ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_lead_time_stats (
    vendor_party_id            TEXT PRIMARY KEY,
    vendor_name                TEXT,
    sample_count               INTEGER NOT NULL DEFAULT 0,
    p50_days                   INTEGER,
    p90_days                   INTEGER,
    avg_days_recent_30         INTEGER,
    on_time_rate               NUMERIC(4,3),
    spread_days                INTEGER,
    first_po_date              DATE,
    last_po_date               DATE,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_lead_time_stats IS
    'Nightly-observed lead time aggregates from Finale PO history. Source of truth for drift detection.';

COMMENT ON COLUMN public.vendor_lead_time_stats.spread_days IS
    'Days between first and last PO in sample. Used as stability signal for auto-update guardrails.';

COMMENT ON COLUMN public.vendor_lead_time_stats.avg_days_recent_30 IS
    'Average lead time for POs received in the last 30 days. Catches trend shifts (vendor slowing down).';

-- ── Layer 3: Auto-update opt-in + rate-limiting ────────────────────
ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS auto_update_override BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS override_last_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.vendor_reorder_policies.auto_update_override IS
    'When TRUE, nightly cron may auto-update lead_time_override_days when drift is detected and guardrails pass.';

COMMENT ON COLUMN public.vendor_reorder_policies.override_last_updated_at IS
    'Last time lead_time_override_days was auto-updated. Rate-limits to one update per 30 days.';

-- ── Seed Colorful with auto-update OFF (conservative default) ──────
UPDATE public.vendor_reorder_policies
SET auto_update_override = FALSE
WHERE vendor_party_id = '10918';

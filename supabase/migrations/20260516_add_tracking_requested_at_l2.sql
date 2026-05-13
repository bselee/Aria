-- ============================================================================
-- Track second-level vendor follow-up timestamp so po-followup-watcher can
-- escalate L1 → L2 → NONCOMM without losing state between cron ticks.
-- ============================================================================

ALTER TABLE "purchase_orders"
ADD COLUMN IF NOT EXISTS "tracking_requested_at_l2" TIMESTAMPTZ;

COMMENT ON COLUMN "purchase_orders"."tracking_requested_at_l2" IS
    'Second-level vendor follow-up timestamp. Set after L1 went 7+ days unanswered.';

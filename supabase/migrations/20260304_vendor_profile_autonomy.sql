-- Migration: Add reconciliation intelligence columns to vendor_profiles
-- Created: 2026-03-04
-- Purpose: Track per-vendor reconciliation patterns for autonomous approval decisions.
--          Enables Phase 3 auto-approve: vendor-specific thresholds that auto-adjust.
-- Rollback: ALTER TABLE vendor_profiles
--   DROP COLUMN IF EXISTS auto_approve_threshold,
--   DROP COLUMN IF EXISTS default_dismiss_action,
--   DROP COLUMN IF EXISTS reconciliation_count,
--   DROP COLUMN IF EXISTS approval_count,
--   DROP COLUMN IF EXISTS dismiss_count,
--   DROP COLUMN IF EXISTS avg_dollar_impact,
--   DROP COLUMN IF EXISTS last_reconciliation_at;
ALTER TABLE vendor_profiles
ADD COLUMN IF NOT EXISTS auto_approve_threshold NUMERIC(5, 2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS default_dismiss_action TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS reconciliation_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS approval_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dismiss_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_dollar_impact NUMERIC(10, 2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ;
-- auto_approve_threshold: NULL = no auto-approve (human reviews all).
--   When set (e.g. 5.00), reconciliations under this % variance are auto-approved.
--   Updated by the system as approval history grows.
COMMENT ON COLUMN vendor_profiles.auto_approve_threshold IS 'Max % variance for auto-approve. NULL = no auto-approve. Updated automatically from approval patterns.';
COMMENT ON COLUMN vendor_profiles.default_dismiss_action IS 'Most common dismiss reason for this vendor (e.g. dropship). Enables future auto-routing.';
COMMENT ON COLUMN vendor_profiles.reconciliation_count IS 'Total reconciliations processed for this vendor.';
COMMENT ON COLUMN vendor_profiles.approval_count IS 'Number of reconciliations approved (auto or manual).';
COMMENT ON COLUMN vendor_profiles.dismiss_count IS 'Number of reconciliations dismissed.';
COMMENT ON COLUMN vendor_profiles.avg_dollar_impact IS 'Average dollar impact of approved reconciliations.';
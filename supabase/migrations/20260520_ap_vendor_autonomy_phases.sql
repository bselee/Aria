-- Migration: Add autonomy phase tracking to vendor_profiles
-- Created: 2026-05-20
-- Purpose: Track per-vendor "Noted" tap history to graduate vendors through
--          autonomy phases: 1=Surface (buttons), 2=Routine (daily digest), 3=Silent.
--          Will taps "Noted" on Telegram → counter increments → vendor graduates.
--          Will taps "Flag" → counter resets, vendor reverts to Phase 1.
--
-- Rollback:
--   ALTER TABLE vendor_profiles
--     DROP COLUMN IF EXISTS noted_count,
--     DROP COLUMN IF EXISTS flag_count,
--     DROP COLUMN IF EXISTS autonomy_phase,
--     DROP COLUMN IF EXISTS phase_upgraded_at,
--     DROP COLUMN IF EXISTS last_noted_at;

ALTER TABLE vendor_profiles
  ADD COLUMN IF NOT EXISTS noted_count       INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flag_count        INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autonomy_phase    INTEGER     DEFAULT 1,
  ADD COLUMN IF NOT EXISTS phase_upgraded_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_noted_at     TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN vendor_profiles.noted_count IS
  'Number of consecutive "Noted" taps on invoice diffs for this vendor. Resets to 0 on any Flag tap.';

COMMENT ON COLUMN vendor_profiles.flag_count IS
  'Total number of "Flag" taps for this vendor. Never resets — audit trail.';

COMMENT ON COLUMN vendor_profiles.autonomy_phase IS
  'Current autonomy phase: 1=Surface (real-time Telegram + buttons), 2=Routine (daily digest only), 3=Silent (log only). Starts at 1.';

COMMENT ON COLUMN vendor_profiles.phase_upgraded_at IS
  'Timestamp when the vendor last graduated to a higher autonomy phase.';

COMMENT ON COLUMN vendor_profiles.last_noted_at IS
  'Timestamp of most recent "Noted" tap. Used for phase decay (30 days inactive → reconsider phase).';

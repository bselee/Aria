-- Migration: Add tiered autonomy levels to vendor_profiles
-- Created: 2026-05-27
-- Purpose: Track per-vendor autonomy settings: 0=Manual, 1=Auto-Draft, 2=Auto-Commit & Send
--
-- Rollback:
--   ALTER TABLE vendor_profiles DROP COLUMN IF EXISTS autonomy_level;

ALTER TABLE vendor_profiles
  ADD COLUMN IF NOT EXISTS autonomy_level INTEGER DEFAULT 0;

COMMENT ON COLUMN vendor_profiles.autonomy_level IS
  'Tiered autonomy setting: 0=Manual (recs only), 1=Auto-Draft (create drafts automatically), 2=Auto-Commit & Send (full autonomous PO flow). Default is 0.';

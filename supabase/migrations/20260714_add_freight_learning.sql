-- Migration: Add freight pattern learning to vendor_profiles
-- Created: 2026-07-14
-- Purpose: Track per-vendor freight handling so the system can learn which
--          vendors are no_freight / bas_freight / vendor_freight instead of
--          relying solely on hardcoded overrides. Tracks every completed PO
--          to build confidence over time.
--
-- Rollback:
--   ALTER TABLE vendor_profiles
--     DROP COLUMN IF EXISTS freight_pattern,
--     DROP COLUMN IF EXISTS freight_pattern_confidence,
--     DROP COLUMN IF EXISTS freight_pattern_source,
--     DROP COLUMN IF EXISTS freight_sample_count,
--     DROP COLUMN IF EXISTS freight_learned_at;
--   DROP TABLE IF EXISTS po_freight_evidence;

ALTER TABLE vendor_profiles
  ADD COLUMN IF NOT EXISTS freight_pattern          TEXT DEFAULT NULL
    CHECK (freight_pattern IS NULL OR freight_pattern IN ('no_freight', 'bas_freight', 'vendor_freight', 'mixed', 'insufficient_data')),
  ADD COLUMN IF NOT EXISTS freight_pattern_confidence TEXT DEFAULT NULL
    CHECK (freight_pattern_confidence IS NULL OR freight_pattern_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS freight_pattern_source   TEXT DEFAULT NULL
    CHECK (freight_pattern_source IS NULL OR freight_pattern_source IN ('override', 'learned', 'manual')),
  ADD COLUMN IF NOT EXISTS freight_sample_count     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS freight_learned_at       TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN vendor_profiles.freight_pattern IS
  'Learned freight pattern: no_freight (never has freight), bas_freight (we add it), vendor_freight (they bill it), mixed, insufficient_data. NULL = not yet classified.';

COMMENT ON COLUMN vendor_profiles.freight_pattern_confidence IS
  'Confidence in the learned pattern: high (>15 samples dominant), medium (8-14), low (<8).';

COMMENT ON COLUMN vendor_profiles.freight_pattern_source IS
  'How the pattern was determined: override (hardcoded), learned (auto-detected from history), manual (dashboard-marked).';

COMMENT ON COLUMN vendor_profiles.freight_sample_count IS
  'Number of completed POs used to determine this pattern.';

COMMENT ON COLUMN vendor_profiles.freight_learned_at IS
  'Timestamp when the pattern was last auto-classified.';

-- Evidence table: every completed PO writes a row so the classifier can
-- re-evaluate patterns as data accumulates. Lightweight — just orderId +
-- what happened with freight.
CREATE TABLE IF NOT EXISTS po_freight_evidence (
    id            BIGSERIAL PRIMARY KEY,
    order_id      TEXT NOT NULL,
    vendor_name   TEXT NOT NULL,
    had_freight_on_po   BOOLEAN NOT NULL DEFAULT false,
    invoice_freight     NUMERIC(12,2) DEFAULT 0,
    freight_matched     BOOLEAN DEFAULT false,
    completed_by        TEXT DEFAULT 'manual'
      CHECK (completed_by IN ('manual', 'auto', 'dashboard')),
    completed_at        TIMESTAMPTZ DEFAULT now(),
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_freight_evidence_vendor
  ON po_freight_evidence (vendor_name, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_po_freight_evidence_order
  ON po_freight_evidence (order_id);

COMMENT ON TABLE po_freight_evidence IS
  'Per-PO freight evidence for vendor pattern learning. Each row records whether freight was involved when a PO was completed, enabling the classifier to detect patterns over time.';

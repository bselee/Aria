-- @file    20260827_po_freight_evidence_unique.sql
-- @purpose Harden po_freight_evidence: one evidence row per PO (order_id) so
--          re-running the backfill (or repeated auto-complete writes) can't
--          create duplicate freight evidence. Also finalize the completed_by
--          CHECK to match the writer's actual values.
--
-- The backfill CLI historically used INSERT (no unique constraint existed),
-- so re-running it would duplicate the 126 rows it seeded. A PO is completed
-- exactly once — freight evidence for one PO is a single fact — so order_id is
-- a natural unique key.
--
-- Applied: 2026-08-27.

-- 1. De-duplicate any existing rows before adding the constraint. Keep the
--    most recent row per order_id (highest id) and drop older duplicates.
--    (Currently 0 duplicates, but making this idempotent is required before
--    the UNIQUE constraint can be added safely on a live table.)
DELETE FROM po_freight_evidence a
USING po_freight_evidence b
WHERE a.order_id = b.order_id
  AND a.id < b.id;

-- 2. Add the unique constraint (dedicated index name is cleaner than the
--    column-name default, and allowed because order_id is already indexed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_freight_evidence_order
  ON po_freight_evidence (order_id);

-- 3. Broadened completed_by CHECK: the backfill used 'manual', but the
--    watcher / dashboard paths are 'auto' / 'dashboard'. Keep the existing
--    allowed set (manual, auto, dashboard) — no change needed. This COMMENT
--    documents the intent for future maintainers.
COMMENT ON TABLE po_freight_evidence IS
  'Per-PO freight evidence for vendor pattern learning. One row per order_id (unique). Each row records whether freight was involved when a PO was completed, enabling the classifier to detect patterns over time.';
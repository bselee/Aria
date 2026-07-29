-- Migration: Backfill lifecycle_stage with canonical values from evidence
-- Date:      2026-07-29
-- Author:    Hermia
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║   REVIEW BEFORE RUNNING — NOT AUTO-APPLIED                             ║
-- ║   This migration sets lifecycle_stage for ALL rows that currently have  ║
-- ║   NULL or non-canonical values. Run ONLY after reviewing the analyzer   ║
-- ║   output: node --import tsx src/cli/analyze-po-state-backfill.ts        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Purpose:
--   purchase_orders.lifecycle_stage has 833 NULL + 311 'l3_escalated' rows.
--   This is the target column for the unified lifecycle state machine.
--   A parallel column lifecycle_state (NOT NULL) is already populated by
--   the production state machine (src/lib/purchasing/po-lifecycle.ts).
--   This migration copies lifecycle_state → lifecycle_stage, with ONE override:
--   Finale status 'Canceled' or 'closed' forces stage = 'CANCELLED'.
--
-- Design:
--   1. Adds lifecycle_stage_legacy TEXT column to preserve the old value.
--   2. Copies existing lifecycle_stage → lifecycle_stage_legacy.
--   3. Sets lifecycle_stage using this precedence:
--      a. Finale status IN ('Canceled', 'closed') → CANCELLED
--         JUDGMENT CALL: 'closed' treated as CANCELLED per "closed-stale" spec.
--         If wrong, ~159 POs would be COMPLETED instead.
--      b. lifecycle_state value (canonical) → use it directly
--         (lifecycle_state is written by the production state machine)
--      c. receive_date < NOW() + invoice completed → COMPLETED
--         (currently 0 rows — receive_date is NULL everywhere)
--      d. Invoice reconciled + outcome resolved → RECONCILED
--      e. Invoice exists → INVOICED
--      f. vendor_acknowledged_at IS NOT NULL → ACKNOWLEDGED
--      g. po_sent_at / tracking_numbers → SENT
--      h. Otherwise → REVIEW
--   4. Only touches rows WHERE lifecycle_stage IS NULL OR lifecycle_stage
--      NOT IN (the 9 canonical values) — never clobbers a good value.
--
-- Idempotent: safe to run multiple times. Uses IF NOT EXISTS and only
-- targets rows that still need fixing.
--
-- Reversible: old values are preserved in lifecycle_stage_legacy.
--
-- Dependencies: pg  (pure SQL, no PL/pgSQL required)
--
-- Verification (run after migration, commented out for safety):
--   SELECT lifecycle_stage, COUNT(*) FROM purchase_orders GROUP BY lifecycle_stage ORDER BY lifecycle_stage;
--
-- Expected distribution after run:
--   CANCELLED:    ~173  (14 Canceled + 159 closed)
--   RECEIVED:     ~772  (from lifecycle_state = 'RECEIVED')
--   ACKNOWLEDGED: ~144  (from lifecycle_state = 'ACKNOWLEDGED')
--   REVIEW:       ~23   (from lifecycle_state = 'REVIEW')
--   INVOICED:     ~19   (from lifecycle_state = 'INVOICED')
--   RECONCILED:   ~12   (from lifecycle_state or invoice+reconciliation)
--   SENT:         ~1    (from lifecycle_state = 'SENT')
--   NULL:         ~0    (canonical values for all rows)
--   ORDERED:      ~0    (legacy — no POs use this)
--   COMPLETED:    ~0    (no receive_date data)

BEGIN;

-- ── Step 1: Add legacy preservation column ────────────────────────────────

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS lifecycle_stage_legacy TEXT;

COMMENT ON COLUMN purchase_orders.lifecycle_stage_legacy IS
    'Previous lifecycle_stage value before Hermia backfill migration 20260729. Preserved for rollback.';

-- ── Step 2: Preserve old values ───────────────────────────────────────────

UPDATE purchase_orders
SET lifecycle_stage_legacy = lifecycle_stage
WHERE lifecycle_stage IS NOT NULL
  AND lifecycle_stage_legacy IS NULL;

-- ── Step 3: Backfill canonical lifecycle_stage ───────────────────────────
--
-- Only touch rows where lifecycle_stage is NULL or a non-canonical value.
-- Uses lifecycle_state as the PRIMARY signal, with CANCELLED override for
-- Finale Canceled/closed status.

UPDATE purchase_orders po
SET lifecycle_stage = derived.new_stage
FROM (
    SELECT
        po2.po_number,
        CASE
            -- ── 1. CANCELLED (strongest evidence) ────────────────────────
            WHEN po2.status IN ('Canceled', 'closed') THEN 'CANCELLED'

            -- ── 2. lifecycle_state (state machine signal) ────────────────
            WHEN po2.lifecycle_state IN (
                'ORDERED', 'REVIEW', 'SENT', 'ACKNOWLEDGED',
                'INVOICED', 'RECONCILED', 'RECEIVED', 'COMPLETED', 'CANCELLED'
            ) THEN po2.lifecycle_state

            -- ── 3. COMPLETED (receive_date + invoice reconciled) ─────────
            WHEN po2.receive_date IS NOT NULL
              AND po2.receive_date < NOW()
              AND EXISTS (
                  SELECT 1 FROM invoices i
                  WHERE i.po_number = po2.po_number
                    AND i.status IN ('completed', 'reconciled')
              ) THEN 'COMPLETED'

            -- ── 4. RECONCILED (invoice reconciled + outcome resolved) ────
            WHEN EXISTS (
                SELECT 1 FROM invoices i
                WHERE i.po_number = po2.po_number
                  AND i.status IN ('reconciled', 'completed')
            ) AND EXISTS (
                SELECT 1 FROM reconciliation_outcomes ro
                WHERE ro.po_id = po2.po_number
                  AND ro.resolved_at IS NOT NULL
            ) THEN 'RECONCILED'

            -- ── 5. RECEIVED (past receive_date) ──────────────────────────
            WHEN po2.receive_date IS NOT NULL
              AND po2.receive_date < NOW() THEN 'RECEIVED'

            -- ── 6. INVOICED (invoice exists) ─────────────────────────────
            WHEN EXISTS (
                SELECT 1 FROM invoices i WHERE i.po_number = po2.po_number
            ) OR EXISTS (
                SELECT 1 FROM vendor_invoices vi WHERE vi.po_number = po2.po_number
            ) THEN 'INVOICED'

            -- ── 7. ACKNOWLEDGED (vendor acknowledged) ────────────────────
            WHEN po2.vendor_acknowledged_at IS NOT NULL THEN 'ACKNOWLEDGED'

            -- ── 8. SENT (po_sent_at / tracking) ──────────────────────────
            WHEN po2.po_sent_at IS NOT NULL
              OR po2.po_email_message_id IS NOT NULL
              OR (po2.tracking_numbers IS NOT NULL
                  AND array_length(po2.tracking_numbers, 1) > 0)
                THEN 'SENT'

            -- ── 9. REVIEW (default) ──────────────────────────────────────
            ELSE 'REVIEW'
        END AS new_stage
    FROM purchase_orders po2
    WHERE po2.lifecycle_stage IS NULL
       OR po2.lifecycle_stage NOT IN (
            'ORDERED', 'REVIEW', 'SENT', 'ACKNOWLEDGED',
            'INVOICED', 'RECONCILED', 'RECEIVED', 'COMPLETED', 'CANCELLED'
        )
) derived
WHERE po.po_number = derived.po_number;

COMMIT;

-- ── Step 4: Verification (commented out — uncomment to run) ──────────────
--
-- SELECT
--     COALESCE(lifecycle_stage, 'NULL') AS stage,
--     COUNT(*) AS cnt
-- FROM purchase_orders
-- GROUP BY lifecycle_stage
-- ORDER BY stage;
--
-- SELECT 'Verification: lifecycle_stage now covers all rows with canonical values' AS status;
-- SELECT COUNT(*) AS rows_with_legacy FROM purchase_orders WHERE lifecycle_stage_legacy IS NOT NULL;

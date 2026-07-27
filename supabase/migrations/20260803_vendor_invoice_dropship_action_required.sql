/**
 * @file    20260803_vendor_invoice_dropship_action_required.sql
 * @purpose Add action_required column to distinguish DELIBERATE human disregards
 *          from SYSTEMIC dropship/service invoices.
 *
 *          PROBLEM: The no_po_required flag conflates two fundamentally different
 *          states:
 *            (1) "Not our pervue" — a dropship or service invoice that was
 *                SYSTEMATICALLY classified as needing no PO. No human was involved.
 *                Examples: Dropship PO invoices, credit card purchases.
 *            (2) "Deliberate disregard" — a human reviewed the invoice and
 *                explicitly decided it doesn't match a PO. The human SHOULD
 *                double-check this decision.
 *
 *          The action_required column resolves this:
 *            action_required = false → systemic (dropship PO, service vendor).
 *                                      Automated classification. No human action
 *                                      needed.
 *            action_required = true  → human chose "disregard" via the dashboard.
 *                                      The owning team should periodically review
 *                                      these to catch mis-classifications.
 *
 *          DROPSHIP invoices (detected by PO-number pattern or vendor keyword)
 *          MUST be action_required = false — they are systemic.
 *
 * @author  Hermia
 * @created 2026-08-03
 * @deps    vendor_invoices, invoices tables exist
 * @env     any
 *
 * ROLLBACK:
 *   ALTER TABLE public.vendor_invoices DROP COLUMN IF EXISTS action_required;
 *   ALTER TABLE public.invoices       DROP COLUMN IF EXISTS action_required;
 */

BEGIN;

-- ── vendor_invoices ───────────────────────────────────────────────────────────

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS action_required BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.vendor_invoices.action_required
  IS 'false = systemic (dropship PO, service vendor) — auto-classified, no human action needed. '
     'true = human deliberately disregarded via the dashboard — owning team should review periodically. '
     'Dropship invoices are always action_required=false (not our pervue, never a concern).';

-- ── invoices ──────────────────────────────────────────────────────────────────

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS action_required BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.invoices.action_required
  IS 'false = systemic (dropship PO, service vendor) — auto-classified, no human action needed. '
     'true = human deliberately disregarded via the dashboard — owning team should review periodically. '
     'Dropship invoices are always action_required=false (not our pervue, never a concern).';

-- ── Backfill ──────────────────────────────────────────────────────────────────
-- Existing manual disregards (no_po_required=true + marked_by IS NOT NULL)
-- represent DELIBERATE human decisions and should be action_required=true.
-- Rows where no_po_required=true but marked_by IS NULL were set systemically
-- (no such rows exist yet, but be safe) and stay action_required=false.

UPDATE public.vendor_invoices
  SET action_required = true
  WHERE no_po_required = true
    AND no_po_marked_by IS NOT NULL;

UPDATE public.invoices
  SET action_required = true
  WHERE no_po_required = true
    AND no_po_marked_by IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';

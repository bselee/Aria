/**
 * @file    20260802_vendor_invoice_disregard.sql
 * @purpose Add persistent "disregard / not a PO purchase" columns to vendor_invoices.
 *          Unmatched invoices (no PO matched) cannot be dismissed via the existing
 *          activity-log-based flow because they have no ap_activity_log row. This
 *          migration gives unmatched rows their own lifecycle: a human can mark an
 *          invoice as "not a PO purchase" (credit card, service, etc.) and it will
 *          be filtered out of the dashboard queue permanently.
 *
 *          DESIGN DECISION: Columns live on vendor_invoices (not a parallel table)
 *          because:
 *            (1) The existing review/approve path records state ON the source row
 *                (ap_activity_log.reviewed_action) — keeping disregard on the
 *                invoice keeps the model simple.
 *            (2) No FK exists between vendor_invoices and ap_activity_log, so a
 *                parallel table would require yet another join or a separate RPC.
 *            (3) The queue query already selects from vendor_invoices — adding
 *                a WHERE no_po_required IS DISTINCT FROM true is trivially cheap.
 *
 *          CRITICAL RULE: These columns MUST never be set automatically. They
 *          represent a DELIBERATE HUMAN decision. Aria's reconciler must never
 *          write to no_po_required.
 *
 * @author  Hermia
 * @created 2026-08-02
 * @deps    vendor_invoices table exists
 * @env     any
 *
 * ROLLBACK:
 *   ALTER TABLE public.vendor_invoices
 *     DROP COLUMN IF EXISTS no_po_required,
 *     DROP COLUMN IF EXISTS no_po_reason,
 *     DROP COLUMN IF EXISTS no_po_marked_by,
 *     DROP COLUMN IF EXISTS no_po_marked_at;
 *   DROP INDEX IF EXISTS idx_vendor_invoices_no_po_required;
 */

BEGIN;

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS no_po_required BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS no_po_reason TEXT;

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS no_po_marked_by TEXT;

ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS no_po_marked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.vendor_invoices.no_po_required
  IS 'DELIBERATE HUMAN DECISION: true = a person confirmed this invoice has no matching PO and is not a PO purchase (e.g. credit card, service charge). When true, the invoice is excluded from the dashboard unmatched queue. Must never be set automatically.';

COMMENT ON COLUMN public.vendor_invoices.no_po_reason
  IS 'Human-supplied reason for marking no_po_required=true. Suggested values: credit_card, service_no_po, not_ours, other. Free-text is also accepted.';

COMMENT ON COLUMN public.vendor_invoices.no_po_marked_by
  IS 'Who marked no_po_required=true. Usually the dashboard user name or email.';

COMMENT ON COLUMN public.vendor_invoices.no_po_marked_at
  IS 'When no_po_required was set to true. NULL if never marked.';

-- Partial index: only index rows where no_po_required is false or NULL (the
-- common query path for the dashboard queue). Rows with no_po_required=true
-- are filtered out and don't need index entries.
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_no_po_required
  ON public.vendor_invoices (no_po_required)
  WHERE no_po_required IS DISTINCT FROM true;

COMMIT;

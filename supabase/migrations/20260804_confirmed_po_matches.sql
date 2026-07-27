/**
 * @file    20260804_confirmed_po_matches.sql
 * @purpose Standalone table for human-confirmed vendor→PO mappings. When a user
 *          approves a matched_unreconciled invoice via the dashboard, the
 *          vendor_name + po_number pair is stored here. The invoice-po-matcher
 *          then imports this table and boosts the score for any PO appearing in
 *          it, so future invoices from the same vendor are more likely to match
 *          the same PO automatically.
 *
 *          Stored as a standalone table rather than a column on vendor_profiles
 *          because:
 *            1. A vendor may have many confirmed PO mappings — a JSONB array on
 *               vendor_profiles would be awkward to query.
 *            2. Standalone table is simpler, faster to query, and doesn't
 *               conflict with concurrent sessions editing vendor_profiles.
 *            3. The matcher can join directly via a simple SELECT rather than
 *               navigating nested JSONB.
 *
 * @author  Hermia
 * @created 2026-08-04
 * @deps    vendor_invoices (foridempotent key), vendor_profiles (for learning)
 * @env     any
 *
 * ROLLBACK:
 *   DROP TABLE IF EXISTS public.confirmed_po_matches;
 *   DROP INDEX IF EXISTS idx_confirmed_po_matches_vendor_po;
 */

BEGIN;

-- ── Standalone confirmed POs table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.confirmed_po_matches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name     TEXT NOT NULL,
    po_number       TEXT NOT NULL,
    invoice_id      UUID,                        -- vendor_invoices.id that triggered this match
    invoice_number  TEXT,                         -- human-readable invoice number
    confirmed_by    TEXT DEFAULT 'dashboard',     -- 'dashboard', 'telegram', etc.
    confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Same vendor_name + po_number should not be duplicated
    CONSTRAINT uq_confirmed_po_match UNIQUE (vendor_name, po_number)
);

COMMENT ON TABLE public.confirmed_po_matches
  IS 'Human-confirmed vendor-to-PO mappings. The invoice-po-matcher reads this table '
     'and gives any confirmed pair a high match score (95) on future invoice matches, '
     'preventing the same vendor+PO combination from needing repeated human approval.';

COMMENT ON COLUMN public.confirmed_po_matches.vendor_name
  IS 'Normalized vendor name from the invoice (as shown in the dashboard queue).';
COMMENT ON COLUMN public.confirmed_po_matches.po_number
  IS 'The PO number the human confirmed matches this vendor.';
COMMENT ON COLUMN public.confirmed_po_matches.invoice_id
  IS 'FK reference to vendor_invoices.id — the specific invoice that prompted this confirmation.';
COMMENT ON COLUMN public.confirmed_po_matches.invoice_number
  IS 'Readable invoice number for audit trail.';

-- Index for the matcher's lookup: fast check "is this vendor_name + po_number confirmed?"
CREATE INDEX IF NOT EXISTS idx_confirmed_po_matches_vendor_po
  ON public.confirmed_po_matches (vendor_name, po_number);

-- ── Also add dismiss_count + dismiss suggestion to vendor_profiles ─────────

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS disregard_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vendor_profiles.disregard_count
  IS 'Number of times invoices from this vendor were disregarded (matched_unreconciled action). '
     'When count reaches 3, the system suggests requires_po=false for future invoices.';

ALTER TABLE public.vendor_profiles
  ADD COLUMN IF NOT EXISTS auto_suggest_no_po BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.vendor_profiles.auto_suggest_no_po
  IS 'Set to true when disregard_count >= 3 in a row. Suggests future invoices from this '
     'vendor should auto-dismiss rather than requiring manual disregard. Human must confirm.';

COMMIT;

NOTIFY pgrst, 'reload schema';

BEGIN;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS no_po_required BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS no_po_reason TEXT;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS no_po_marked_by TEXT;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS no_po_marked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.invoices.no_po_required IS 'DELIBERATE human decision: this invoice needs no purchase order. Permanently removes it from the unmatched-exception queue. Must never be set automatically.';
COMMENT ON COLUMN public.invoices.no_po_reason IS 'Why the invoice was marked as no-PO-required (credit_card, service_no_po, not_ours, other).';
COMMENT ON COLUMN public.invoices.no_po_marked_by IS 'Who clicked the disregard button.';
COMMENT ON COLUMN public.invoices.no_po_marked_at IS 'When the disregard was applied.';

COMMIT;

NOTIFY pgrst, 'reload schema';

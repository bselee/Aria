-- Migration: bill_po_links — one vendor bill can cover several Finale POs
-- Created: 2026-10-29
--
-- WHY: `vendor_invoices.po_number` is single-valued. A Bill.com bill that pays
-- for several Finale POs (Miles 10/27, Novelty, Intl Molasses shapes) could only
-- name ONE of them, so every sibling PO kept reading "awaiting vendor invoice"
-- forever even though the bill was in hand. Bill's rule: a bill that covers
-- several POs must be nameable on EACH covered PO.
--
-- SHAPE: a link table, not a text[] column — one row per (bill, PO) keeps the
-- unique constraint honest, lets PostgREST filter by po_number, and needs no
-- array operators in the route.
--
-- `vendor_invoices.po_number` stays authoritative for the primary PO and is
-- backfilled into the link table below, so readers can union the two without
-- special-casing legacy rows.
--
-- Rollback:
--   DROP TABLE IF EXISTS bill_po_links;

CREATE TABLE IF NOT EXISTS bill_po_links (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_invoice_id uuid NOT NULL REFERENCES vendor_invoices(id),
    po_number         text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per (bill, PO). Added via DO block so re-running the migration on a
-- DB that already has the constraint is a no-op instead of an error.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'bill_po_links_vendor_invoice_id_po_number_key'
          AND conrelid = 'bill_po_links'::regclass
    ) THEN
        ALTER TABLE bill_po_links
            ADD CONSTRAINT bill_po_links_vendor_invoice_id_po_number_key
            UNIQUE (vendor_invoice_id, po_number);
    END IF;
END $$;

-- The receivings route reads links by the POs on the page ("which bill covers
-- this PO?"), so po_number needs its own index. The unique constraint already
-- covers lookups by vendor_invoice_id.
CREATE INDEX IF NOT EXISTS idx_bpl_po_number ON bill_po_links (po_number);

COMMENT ON TABLE bill_po_links IS
    'Many-to-many bill→PO links. A vendor bill covering several Finale POs is named on each one; vendor_invoices.po_number remains the primary/legacy link.';

-- Backfill: seed one link row per existing single-valued link so every reader
-- can go through the link table alone. Idempotent via ON CONFLICT.
INSERT INTO bill_po_links (vendor_invoice_id, po_number)
SELECT vi.id, btrim(vi.po_number)
FROM vendor_invoices vi
WHERE vi.po_number IS NOT NULL
  AND btrim(vi.po_number) <> ''
ON CONFLICT (vendor_invoice_id, po_number) DO NOTHING;

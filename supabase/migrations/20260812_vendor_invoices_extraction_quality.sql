-- Migration: Add extraction_quality to vendor_invoices + backfill + reconciled gate
-- @file 20260812_vendor_invoices_extraction_quality.sql
-- @purpose Phase 1.1: track extraction quality on vendor_invoices so the
--          three-way match engine can gate on it. Rows with total=0 AND a
--          non-invoice-like invoice_number are extraction_quality='failed'
--          and must NEVER be marked reconciled (they are OCR/parse garbage
--          or payment reminders, not real invoices).
-- @author aria-ap
-- @created 2026-08-12
-- @deps vendor_invoices
-- Rollback:
--   ALTER TABLE vendor_invoices DROP CONSTRAINT IF EXISTS chk_vi_no_reconcile_failed;
--   ALTER TABLE vendor_invoices DROP COLUMN IF EXISTS extraction_quality;
--   DROP INDEX IF EXISTS idx_vi_extraction_quality;

BEGIN;

-- ── 1. Add column ──────────────────────────────────────────────────────────
ALTER TABLE public.vendor_invoices
    ADD COLUMN IF NOT EXISTS extraction_quality TEXT;

COMMENT ON COLUMN public.vendor_invoices.extraction_quality IS
    'How complete the parse was. ''complete'' = usable total + invoice-like number. '
    '''partial'' = some fields parsed but not a full clean invoice. '
    '''failed'' = total=0 AND invoice_number missing/not invoice-like (OCR garbage, '
    'reminders, statements mis-classified as invoices). Failed rows must never be '
    'reconciled (enforced by chk_vi_no_reconcile_failed).';

-- ── 2. Backfill from existing rows ─────────────────────────────────────────
-- failed: total=0 AND (invoice_number missing OR pure-alpha junk that is not
--         invoice-like: e.g. "oice", "Reminder", "From", "Invoice", "INVOICE",
--         "Statement", "Unknown", "N/A", "None")
-- complete: total > 0 AND invoice_number invoice-like (contains digits or a
--           plausible vendor invoice pattern)
-- partial: everything else (has some usable fields but incomplete)
UPDATE public.vendor_invoices
SET extraction_quality = CASE
    WHEN total = 0
      AND (
        invoice_number IS NULL
        OR invoice_number = ''
        OR lower(invoice_number) IN (
          'unknown','n/a','na','none','null','undefined','-','—',
          'reminder','from','oice','invoice','statement','payment',
          'notice','balance','remittance','credit','memo','total','due'
        )
        OR (invoice_number !~ '[0-9]' AND invoice_number ~ '^[a-zA-Z -]+$')
      )
    THEN 'failed'
    WHEN total > 0
      AND invoice_number IS NOT NULL
      AND invoice_number <> ''
      AND invoice_number ~ '[0-9]'
    THEN 'complete'
    ELSE 'partial'
END
WHERE extraction_quality IS NULL;

-- ── 3. Reconcile gate: failed rows can never be reconciled ─────────────────
-- A $0/garbage invoice must stay in 'received' (or be flagged for human
-- review) — never silently marked reconciled by the receivings approval path.
DO $$
DECLARE
    bad_count INT;
BEGIN
    SELECT COUNT(*) INTO bad_count FROM public.vendor_invoices
    WHERE status = 'reconciled' AND extraction_quality = 'failed';

    IF bad_count > 0 THEN
        -- Demote existing wrongly-reconciled rows back to received; they are
        -- OCR/reminder garbage that slipped through before the gate existed.
        UPDATE public.vendor_invoices
        SET status = 'received',
            reconciled_at = NULL,
            updated_at = NOW()
        WHERE status = 'reconciled' AND extraction_quality = 'failed';
        RAISE NOTICE 'Demoted % previously-reconciled failed-quality invoice(s) to received', bad_count;
    END IF;
END $$;

ALTER TABLE public.vendor_invoices
    DROP CONSTRAINT IF EXISTS chk_vi_no_reconcile_failed;
ALTER TABLE public.vendor_invoices
    ADD CONSTRAINT chk_vi_no_reconcile_failed
    CHECK (extraction_quality IS DISTINCT FROM 'failed' OR status IS DISTINCT FROM 'reconciled');

-- ── 4. Index for quality-gated queries ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vi_extraction_quality
    ON public.vendor_invoices (extraction_quality)
    WHERE extraction_quality IS NOT NULL;

COMMIT;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

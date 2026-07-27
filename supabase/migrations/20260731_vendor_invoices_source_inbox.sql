-- Migration: Add source_inbox to vendor_invoices
-- @file 20260731_vendor_invoices_source_inbox.sql
-- @purpose  Track which OAuth slot/inbox an invoice email arrived in.
--           'default' = bill.selee@ (credit-card purchases common; PO often
--           legitimately absent). 'ap' = ap@ (a missing PO is a real exception
--           to investigate). NULL = not derivable from current data (orphan
--           source_ref, CLI import, manual entry, etc.).
-- @author Hermia
-- @created 2026-07-31
-- @deps vendor_invoices, email_inbox_queue, ap_inbox_queue
-- @env any
-- Rollback:
--   ALTER TABLE vendor_invoices DROP COLUMN IF EXISTS source_inbox;
--   DROP INDEX IF EXISTS idx_vi_source_inbox;

BEGIN;

-- ── 1. Add column ──────────────────────────────────────────────────────────
ALTER TABLE public.vendor_invoices
    ADD COLUMN IF NOT EXISTS source_inbox TEXT;

COMMENT ON COLUMN public.vendor_invoices.source_inbox IS
    'Which Gmail OAuth slot received the email that produced this invoice. '
    '''default'' = bill.selee@buildasoil.com (credit-card purchases common, '
    'PO often legitimately absent). ''ap'' = ap@buildasoil.com (a missing PO '
    'is a genuine exception to investigate). NULL when not derivable from '
    'the available queue tables (orphan source_ref, CLI import, manual entry).';

CREATE INDEX IF NOT EXISTS idx_vi_source_inbox
    ON public.vendor_invoices (source_inbox)
    WHERE source_inbox IS NOT NULL;

-- ── 2. Backfill from queue tables ──────────────────────────────────────────

-- 2a. Exact join to ap_inbox_queue.message_id (most common path — AP forwarder
--     produces these source_refs that also exist in the queue).
UPDATE public.vendor_invoices vi
SET source_inbox = aq.source_inbox
FROM public.ap_inbox_queue aq
WHERE vi.source_inbox IS NULL
  AND aq.message_id = vi.source_ref;

-- 2b. Suffix join — ap-identifier.ts appends _0, _1, etc. for multi-attachment
--     emails (src/lib/intelligence/workers/ap-identifier.ts line 904).
UPDATE public.vendor_invoices vi
SET source_inbox = aq.source_inbox
FROM public.ap_inbox_queue aq
WHERE vi.source_inbox IS NULL
  AND aq.message_id LIKE vi.source_ref || '_%';

-- 2c. Exact join to email_inbox_queue.gmail_message_id (bill.selee@ inbox /
--     'default' OAuth slot; includes inbound-order-acknowledgement messages).
UPDATE public.vendor_invoices vi
SET source_inbox = eq.source_inbox
FROM public.email_inbox_queue eq
WHERE vi.source_inbox IS NULL
  AND eq.gmail_message_id = vi.source_ref;

-- ── 3. Report results ──────────────────────────────────────────────────────
DO $$
DECLARE
    total  INT;
    ap_cnt INT;
    def_cnt INT;
    null_cnt INT;
BEGIN
    SELECT COUNT(*) INTO total FROM public.vendor_invoices WHERE created_at >= '2026-04-01';
    SELECT COUNT(*) INTO ap_cnt FROM public.vendor_invoices WHERE created_at >= '2026-04-01' AND source_inbox = 'ap';
    SELECT COUNT(*) INTO def_cnt FROM public.vendor_invoices WHERE created_at >= '2026-04-01' AND source_inbox = 'default';
    SELECT COUNT(*) INTO null_cnt FROM public.vendor_invoices WHERE created_at >= '2026-04-01' AND source_inbox IS NULL;

    RAISE NOTICE 'Backfill report (invoices since 2026-04-01):';
    RAISE NOTICE '  Total:                %', total;
    RAISE NOTICE '  source_inbox = ''ap'':     %', ap_cnt;
    RAISE NOTICE '  source_inbox = ''default'': %', def_cnt;
    RAISE NOTICE '  source_inbox IS NULL:      %', null_cnt;

    IF null_cnt > 0 THEN
        RAISE NOTICE '  % of post-April invoices have unknown inbox (%.1f%%)',
            null_cnt, (null_cnt::NUMERIC / total * 100);
    END IF;
END
$$;

COMMIT;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';

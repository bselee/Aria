-- @file supabase/migrations/20260727_rebuild_po_lifecycle_state.sql
-- @purpose Rebuild purchase_orders.lifecycle_state, which was flattened to 'RECEIVED'
--          on 1122 of 1123 rows by the unfiltered-PATCH bug in src/lib/db.ts
--          (filters were applied only to GET, so every .update().eq() rewrote the
--          whole table). Re-derives state from sources the bug could NOT corrupt:
--          the Finale-synced `status` column plus per-PO evidence timestamps.
-- @author Hermia
-- @created 2026-07-27
-- @deps supabase/migrations/20260601_po_lifecycle_state.sql (column definition)
-- @env none
--
-- Precedence (most authoritative first):
--   1. status Canceled/Cancelled           -> CANCELLED   (terminal, from Finale)
--   2. status received/closed/Completed    -> RECEIVED    (goods physically in)
--   3. reconciled evidence                 -> RECONCILED
--   4. invoice exists for the PO           -> INVOICED
--   5. vendor_acknowledged_at present      -> ACKNOWLEDGED
--   6. po_sent_at / po_sent_verified_at    -> SENT
--   7. status Draft, or no evidence        -> REVIEW      (column default)
--
-- Only 'RECEIVED' rows are rewritten, so genuinely-received POs keep their state and
-- the migration is safe to re-run. Rows are matched to invoices via vendor_invoices /
-- invoices po_number (TEXT, no FK — implicit relationship).

BEGIN;

WITH invoiced AS (
    SELECT DISTINCT po_number FROM public.invoices
     WHERE po_number IS NOT NULL AND po_number <> ''
    UNION
    SELECT DISTINCT po_number FROM public.vendor_invoices
     WHERE po_number IS NOT NULL AND po_number <> ''
),
reconciled AS (
    SELECT DISTINCT po_number FROM public.vendor_invoices
     WHERE po_number IS NOT NULL AND po_number <> '' AND status = 'reconciled'
    UNION
    SELECT DISTINCT po_number FROM public.invoices
     WHERE po_number IS NOT NULL AND po_number <> '' AND status = 'reconciled'
)
UPDATE public.purchase_orders p
   SET lifecycle_state = CASE
        WHEN lower(p.status) IN ('canceled', 'cancelled')          THEN 'CANCELLED'
        WHEN lower(p.status) IN ('received', 'closed', 'completed') THEN 'RECEIVED'
        WHEN EXISTS (SELECT 1 FROM reconciled r WHERE r.po_number = p.po_number)
                                                                   THEN 'RECONCILED'
        WHEN EXISTS (SELECT 1 FROM invoiced i WHERE i.po_number = p.po_number)
                                                                   THEN 'INVOICED'
        WHEN p.vendor_acknowledged_at IS NOT NULL                  THEN 'ACKNOWLEDGED'
        WHEN p.po_sent_at IS NOT NULL
          OR p.po_sent_verified_at IS NOT NULL                     THEN 'SENT'
        ELSE 'REVIEW'
       END
 WHERE p.lifecycle_state = 'RECEIVED';

COMMIT;

NOTIFY pgrst, 'reload schema';

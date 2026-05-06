-- Phase C: link a qty_recommendations row to the draft PO it produced.
--
-- Today, qty_recommendations.po_number is filled in *fuzzily* at receive time by
-- attachReceivedPOsToRecommendations (most-recent-rec-within-60d-before-receive).
-- That works for calibration math but is wrong for "which PO did this rec
-- actually become?" — the latter is deterministic and known at draft time.
--
-- resulting_po_number captures the deterministic link the moment a draft PO
-- is created from a recommendation, so the dashboard can show
-- "Aria recommended 50 → drafted as PO 124501 (qty 100)" before the PO is
-- ever received. Calibration matching itself is unchanged for now.

ALTER TABLE public.qty_recommendations
    ADD COLUMN IF NOT EXISTS resulting_po_number      TEXT,
    ADD COLUMN IF NOT EXISTS resulting_po_drafted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resulting_po_drafted_qty NUMERIC(14,2);

CREATE INDEX IF NOT EXISTS qty_recs_resulting_po_idx
    ON public.qty_recommendations (resulting_po_number)
    WHERE resulting_po_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS qty_recs_unstamped_lookup_idx
    ON public.qty_recommendations (vendor_party_id, product_id, recommended_at DESC)
    WHERE resulting_po_number IS NULL;

COMMENT ON COLUMN public.qty_recommendations.resulting_po_number IS
    'Deterministic link to the draft PO created from this recommendation, stamped at draft time by createDraftPurchaseOrder. Distinct from po_number (fuzzy, set at receive time by calibration cron).';

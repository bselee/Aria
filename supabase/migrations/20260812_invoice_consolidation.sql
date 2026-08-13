-- @file supabase/migrations/20260812_invoice_consolidation.sql
-- @purpose P1 (t_54740019): Consolidate invoice tables to vendor_invoices (single source of truth)
--          - Add payment_status (+ tariff/labor/tracking_numbers/discrepancies) to vendor_invoices
--          - Extend vendor_invoices.status CHECK to legacy reconciliation vocabulary
--          - Migrate orphan `invoices` + `paid_invoices` rows into vendor_invoices
--          - Reconcile overlapping (vendor_name, invoice_number) pairs — keep richer row, log conflicts
--          - Archive legacy tables (invoices_legacy, paid_invoices_legacy) and create read-only
--            views named `invoices` / `paid_invoices` over vendor_invoices (no reader regression)
--          - Rebuild po_document_ledger to read vendor_invoices only
-- @author aria-implementer
-- @created 2026-08-12
-- @deps 20260226_create_invoices.sql, 20260316_create_paid_invoices.sql, 20260317_create_vendor_invoices.sql,
--       20260724_po_document_ledger.sql, 20260802*_no_po_*.sql, 20260812_vendor_invoices_extraction_quality.sql
-- @env  none (applied via scripts/run-migration.mjs)

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. vendor_invoices: new columns (mirror legacy `invoices` shape where writers need them)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.vendor_invoices
    ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'paid', 'partial', 'void')),
    ADD COLUMN IF NOT EXISTS discrepancies JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS tariff NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS labor NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS tracking_numbers TEXT[] NOT NULL DEFAULT '{}';

-- Extend status vocabulary to include the legacy reconciliation statuses that
-- writers (auto-match, reconciler, ap-agent, dashboard) still produce.
ALTER TABLE public.vendor_invoices DROP CONSTRAINT IF EXISTS vendor_invoices_status_check;
ALTER TABLE public.vendor_invoices
    ADD CONSTRAINT vendor_invoices_status_check CHECK (
        status IN ('received', 'reconciled', 'paid', 'disputed', 'void',
                   'unmatched', 'matched_review', 'matched_unreconciled',
                   'matched_approved', 'auto_approved', 'completed')
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Conflict log (durable audit of consolidation decisions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invoice_consolidation_log (
    id            BIGSERIAL PRIMARY KEY,
    source_table  TEXT NOT NULL,
    vendor_name   TEXT,
    invoice_number TEXT,
    field         TEXT,
    legacy_value  TEXT,
    kept_value    TEXT,
    resolution    TEXT NOT NULL DEFAULT 'kept_vendor_invoices',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.invoice_consolidation_log IS
    'Audit trail for 2026-08-12 invoice consolidation. Rows where legacy value was dropped in favor of vendor_invoices.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Migrate orphan `invoices` rows → vendor_invoices
--    (legacy rows with no matching (vendor_name, invoice_number) in vendor_invoices)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.vendor_invoices (
    vendor_name, invoice_number, po_number, invoice_date, due_date,
    subtotal, freight, tax, total, status,
    source, source_ref, raw_data, line_items,
    discrepancies, tariff, labor, tracking_numbers,
    no_po_required, no_po_reason, no_po_marked_by, no_po_marked_at, action_required,
    reconciled_at, created_at, updated_at, payment_status, extraction_quality
)
SELECT
    i.vendor_name,
    i.invoice_number,
    i.po_number,
    CASE WHEN i.invoice_date ~ '^\d{4}-\d{2}-\d{2}' THEN i.invoice_date::date ELSE NULL END,
    CASE WHEN i.due_date     ~ '^\d{4}-\d{2}-\d{2}' THEN i.due_date::date     ELSE NULL END,
    i.subtotal, i.freight, i.tax, i.total,
    i.status,
    'email_attachment',
    i.document_id::text,
    COALESCE(i.raw_data, '{}'::jsonb),
    COALESCE(i.raw_data->'lineItems', '[]'::jsonb),
    COALESCE(i.discrepancies, '[]'::jsonb),
    i.tariff, i.labor, i.tracking_numbers,
    COALESCE(i.no_po_required, false),
    i.no_po_reason, i.no_po_marked_by, i.no_po_marked_at, COALESCE(i.action_required, false),
    CASE WHEN i.status IN ('reconciled', 'completed', 'matched_approved', 'auto_approved')
         THEN i.updated_at ELSE NULL END,
    i.created_at, i.updated_at,
    CASE WHEN i.status = 'paid' THEN 'paid' ELSE 'unpaid' END,
    -- extraction_quality gate (2026-08-12, t_3d2c50e0): orphan invoices rows
    -- must carry a quality flag too, or a fresh-DB run leaves them NULL (bypass
    -- chk_vi_no_reconcile_failed). Same CASE as the extraction-quality migration.
    CASE
        WHEN i.total = 0
          AND (
            i.invoice_number IS NULL
            OR i.invoice_number = ''
            OR lower(i.invoice_number) IN (
              'unknown','n/a','na','none','null','undefined','-','—',
              'reminder','from','oice','invoice','statement','payment',
              'notice','balance','remittance','credit','memo','total','due'
            )
            OR (i.invoice_number !~ '[0-9]' AND i.invoice_number ~ '^[a-zA-Z -]+$')
          )
        THEN 'failed'
        WHEN i.total > 0
          AND i.invoice_number IS NOT NULL
          AND i.invoice_number <> ''
          AND i.invoice_number ~ '[0-9]'
        THEN 'complete'
        ELSE 'partial'
    END
FROM public.invoices i
WHERE NOT EXISTS (
    SELECT 1 FROM public.vendor_invoices v
    WHERE v.vendor_name = i.vendor_name AND v.invoice_number = i.invoice_number
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Migrate orphan `paid_invoices` rows → vendor_invoices
--    (payment confirmations with no matching vendor_invoices row)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.vendor_invoices (
    vendor_name, invoice_number, po_number, total, status, payment_status,
    paid_at, source, source_ref, notes, raw_data, source_inbox, created_at, updated_at,
    extraction_quality
)
SELECT
    dedup.vendor_name,
    dedup.norm_inv AS invoice_number,
    dedup.po_number,
    dedup.amount_paid,
    'paid', 'paid',
    dedup.date_paid,
    'payment_confirm',
    dedup.gmail_message_id,
    dedup.product_description,
    to_jsonb(dedup) - 'norm_inv',
    dedup.source_inbox,
    dedup.created_at, dedup.created_at,
    -- extraction_quality gate (2026-08-12, t_3d2c50e0): same CASE as
    -- 20260812_vendor_invoices_extraction_quality.sql so paid_invoices rows
    -- migrated here never land as NULL quality (which would bypass the
    -- reconcile gate chk_vi_no_reconcile_failed on fresh DBs).
    CASE
        WHEN dedup.amount_paid = 0
          AND (
            dedup.norm_inv IS NULL
            OR dedup.norm_inv = ''
            OR lower(dedup.norm_inv) IN (
              'unknown','n/a','na','none','null','undefined','-','—',
              'reminder','from','oice','invoice','statement','payment',
              'notice','balance','remittance','credit','memo','total','due'
            )
            OR (dedup.norm_inv !~ '[0-9]' AND dedup.norm_inv ~ '^[a-zA-Z -]+$')
          )
        THEN 'failed'
        WHEN dedup.amount_paid > 0
          AND dedup.norm_inv IS NOT NULL
          AND dedup.norm_inv <> ''
          AND dedup.norm_inv ~ '[0-9]'
        THEN 'complete'
        ELSE 'partial'
    END
FROM (
    -- paid_invoices contains duplicate (vendor_name, invoice_number) pairs (repeated
    -- payment-confirm scans). Keep the latest row per pair; the UNIQUE constraint
    -- uq_vendor_name_invoice on vendor_invoices would otherwise reject the second row
    -- of each pair and abort the migration. Rows with a NULL/placeholder invoice
    -- number are kept individually (they do not collide on the unique index, and
    -- collapsing them could silently drop a distinct payment, e.g. two 'do not reply'
    -- confirmations with different amounts).
    SELECT DISTINCT ON (sub.vendor_name, COALESCE(sub.norm_inv, 'NULL#' || sub.id::text))
        sub.*
    FROM (
        SELECT pi.*,
               CASE WHEN pi.invoice_number IS NULL
                         OR lower(trim(pi.invoice_number)) IN ('unknown', 'n/a', 'na', 'none', 'null', '-', '')
                    THEN NULL ELSE trim(pi.invoice_number) END AS norm_inv
        FROM public.paid_invoices pi
    ) sub
    ORDER BY sub.vendor_name,
             COALESCE(sub.norm_inv, 'NULL#' || sub.id::text),
             sub.created_at DESC, sub.id DESC
) dedup
WHERE NOT EXISTS (
    SELECT 1 FROM public.vendor_invoices v
    WHERE v.vendor_name = dedup.vendor_name
      AND v.invoice_number IS NOT DISTINCT FROM dedup.norm_inv
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Reconcile overlapping (vendor_name, invoice_number) pairs
--    vendor_invoices wins (SoR). Fill gaps from legacy; log conflicts.
-- ─────────────────────────────────────────────────────────────────────────────
-- 5a. Overlaps with legacy `invoices`: fill missing fields on vendor_invoices.
UPDATE public.vendor_invoices v
SET
    po_number        = COALESCE(NULLIF(v.po_number, ''), NULLIF(i.po_number, '')),
    due_date         = COALESCE(v.due_date,
        CASE WHEN i.due_date ~ '^\d{4}-\d{2}-\d{2}' THEN i.due_date::date ELSE NULL END),
    discrepancies    = CASE WHEN jsonb_array_length(COALESCE(v.discrepancies, '[]'::jsonb)) = 0
                            THEN COALESCE(i.discrepancies, '[]'::jsonb) ELSE v.discrepancies END,
    tariff           = CASE WHEN v.tariff = 0 THEN COALESCE(i.tariff, 0) ELSE v.tariff END,
    labor            = CASE WHEN v.labor  = 0 THEN COALESCE(i.labor, 0)  ELSE v.labor  END,
    tracking_numbers = CASE WHEN array_length(v.tracking_numbers, 1) IS NULL
                            THEN COALESCE(i.tracking_numbers, '{}') ELSE v.tracking_numbers END,
    no_po_required   = COALESCE(v.no_po_required, i.no_po_required),
    no_po_reason     = COALESCE(v.no_po_reason, i.no_po_reason),
    no_po_marked_by  = COALESCE(v.no_po_marked_by, i.no_po_marked_by),
    no_po_marked_at  = COALESCE(v.no_po_marked_at, i.no_po_marked_at),
    action_required  = COALESCE(v.action_required, i.action_required),
    -- Adopt a more specific legacy reconciliation status only when vendor row is the generic default
    -- AND the vendor row is not a failed extraction (chk_vi_no_reconcile_failed forbids
    -- 'reconciled' on failed-quality rows).
    status           = CASE
                            WHEN v.status = 'received'
                                 AND v.extraction_quality IS DISTINCT FROM 'failed'
                                 AND i.status IN ('matched_review', 'matched_unreconciled', 'matched_approved',
                                                  'auto_approved', 'reconciled', 'completed')
                            THEN i.status
                            ELSE v.status END,
    reconciled_at    = COALESCE(v.reconciled_at,
        CASE WHEN i.status IN ('reconciled', 'completed', 'matched_approved', 'auto_approved')
             THEN i.updated_at ELSE NULL END),
    updated_at       = now()
FROM public.invoices i
WHERE v.vendor_name = i.vendor_name AND v.invoice_number = i.invoice_number;

-- Log total mismatches (both non-null, differ by > $0.01) for manual review.
INSERT INTO public.invoice_consolidation_log (source_table, vendor_name, invoice_number, field, legacy_value, kept_value, resolution)
SELECT 'invoices', i.vendor_name, i.invoice_number, 'total',
       i.total::text, v.total::text, 'kept_vendor_invoices'
FROM public.invoices i
JOIN public.vendor_invoices v
  ON v.vendor_name = i.vendor_name AND v.invoice_number = i.invoice_number
WHERE i.total IS NOT NULL AND v.total IS NOT NULL AND i.total <> v.total;

-- 5b. Overlaps with legacy `paid_invoices`: mark the vendor_invoices row paid.
UPDATE public.vendor_invoices v
SET
    payment_status = 'paid',
    status         = CASE WHEN v.status IN ('received', 'unmatched', 'matched_review', 'matched_unreconciled')
                          THEN 'paid' ELSE v.status END,
    paid_at        = COALESCE(v.paid_at, pi.date_paid),
    po_number      = COALESCE(NULLIF(v.po_number, ''), NULLIF(pi.po_number, '')),
    notes          = COALESCE(v.notes, pi.product_description),
    updated_at     = now()
FROM public.paid_invoices pi
WHERE v.vendor_name = pi.vendor_name AND v.invoice_number = pi.invoice_number;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Archive legacy tables, then expose read-only views with the legacy names.
--    PostgREST serves views as read-only (no INSTEAD OF triggers) — any writer
--    still targeting `invoices` / `paid_invoices` now fails at the DB layer,
--    enforcing the single write path (vendor_invoices).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoices       RENAME TO invoices_legacy;
ALTER TABLE public.paid_invoices  RENAME TO paid_invoices_legacy;

COMMENT ON TABLE public.invoices_legacy IS
    'Archived legacy invoice table (pre-consolidation). Data migrated to vendor_invoices 2026-08-12.';
COMMENT ON TABLE public.paid_invoices_legacy IS
    'Archived legacy paid-invoice confirmation table (pre-consolidation). Data migrated to vendor_invoices 2026-08-12.';

-- ── View `invoices`: legacy column superset over vendor_invoices ────────────
CREATE OR REPLACE VIEW public.invoices AS
SELECT
    v.id::text AS id,
    v.invoice_number,
    v.vendor_name,
    v.po_number,
    v.invoice_date::text AS invoice_date,
    v.due_date::text AS due_date,
    COALESCE(v.raw_data->>'paymentTerms', '') AS payment_terms,
    v.subtotal, v.freight, v.tax,
    COALESCE(v.tariff, NULLIF(v.raw_data->>'tariff', '')::numeric, 0) AS tariff,
    COALESCE(v.labor, NULLIF(v.raw_data->>'labor', '')::numeric, 0) AS labor,
    COALESCE(v.tracking_numbers,
             ARRAY(SELECT jsonb_array_elements_text(v.raw_data->'trackingNumbers'))) AS tracking_numbers,
    v.total,
    COALESCE(NULLIF(v.raw_data->>'amountDue', ''), v.total::text)::numeric AS amount_due,
    v.status,
    v.discrepancies,
    NULL::bigint AS document_id,
    v.raw_data,
    v.created_at, v.updated_at,
    v.no_po_required, v.no_po_reason, v.no_po_marked_by, v.no_po_marked_at, v.action_required,
    -- vendor_invoices extras (fix previously-broken legacy readers)
    v.line_items, v.reconciled_at, v.paid_at, v.payment_status,
    v.source, v.source_ref, v.source_inbox, v.notes, v.pdf_storage_path,
    v.total AS total_amount,
    NULL::uuid AS vendor_id,
    v.raw_data->>'trackingNotes' AS tracking_notes,
    v.raw_data->>'carrier' AS carrier
FROM public.vendor_invoices v;

-- ── View `paid_invoices`: legacy column shape over paid vendor_invoices rows ─
CREATE OR REPLACE VIEW public.paid_invoices AS
SELECT
    v.id::text AS id,
    v.vendor_name,
    v.invoice_number,
    v.total AS amount_paid,
    v.paid_at::date AS date_paid,
    v.po_number,
    (v.po_number IS NOT NULL AND v.po_number <> '') AS po_matched,
    COALESCE(v.notes, v.raw_data->>'productDescription', '') AS product_description,
    COALESCE(v.raw_data->>'vendorAddress', '') AS vendor_address,
    COALESCE(v.raw_data->>'emailFrom', '') AS email_from,
    COALESCE(v.raw_data->>'emailSubject', '') AS email_subject,
    v.source_ref AS gmail_message_id,
    COALESCE(v.raw_data->>'confidence', '') AS confidence,
    v.source_inbox,
    COALESCE(v.raw_data->>'draftPoId', '') AS draft_po_id,
    v.created_at
FROM public.vendor_invoices v
WHERE v.payment_status = 'paid' OR v.status = 'paid' OR v.source = 'payment_confirm';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Rebuild po_document_ledger to read vendor_invoices only (branches 1-3 of the
--    original 20260724 view — invoices / paid_invoices / vendor_invoices — collapse
--    into a single vendor_invoices source; all other branches preserved verbatim).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.po_document_ledger AS

-- 1. vendor_invoices (unified invoice source; replaces legacy invoices/paid_invoices/vendor_invoices branches)
SELECT
    public._normalize_po(COALESCE(vi.po_number, '')) AS po_number,
    vi.vendor_name,
    CASE WHEN vi.payment_status = 'paid' OR vi.status = 'paid' OR vi.source = 'payment_confirm'
         THEN 'paid_invoice' ELSE 'invoice' END AS doc_type,
    COALESCE(vi.invoice_number, '') AS doc_ref,
    COALESCE(vi.total, 0) AS amount,
    COALESCE(vi.status, 'received') AS status,
    vi.created_at AS occurred_at,
    'vendor_invoices'::text AS source_table,
    vi.id::text AS source_id,
    jsonb_build_object(
        'invoice_number', vi.invoice_number,
        'subtotal', vi.subtotal,
        'freight', vi.freight,
        'tax', vi.tax,
        'tariff', vi.tariff,
        'labor', vi.labor,
        'due_date', vi.due_date,
        'discrepancies', vi.discrepancies,
        'line_items', vi.line_items,
        'source', vi.source,
        'source_ref', vi.source_ref,
        'reconciled_at', vi.reconciled_at,
        'paid_at', vi.paid_at,
        'payment_status', vi.payment_status,
        'notes', vi.notes
    ) AS detail
FROM vendor_invoices vi
WHERE vi.po_number IS NOT NULL AND vi.po_number != ''

UNION ALL

-- 2. ap_pending_approvals (uses order_id as PO reference)
SELECT
    public._normalize_po(COALESCE(apa.order_id, '')) AS po_number,
    apa.vendor_name,
    'approval'::text AS doc_type,
    COALESCE(apa.invoice_number, '') AS doc_ref,
    COALESCE((apa.reconciliation_result->>'total_dollar_impact')::numeric, 0) AS amount,
    COALESCE(apa.status, 'pending') AS status,
    apa.created_at AS occurred_at,
    'ap_pending_approvals'::text AS source_table,
    apa.id::text AS source_id,
    jsonb_build_object(
        'invoice_number', apa.invoice_number,
        'order_id', apa.order_id,
        'verdict_type', apa.verdict_type,
        'hold_reason', apa.hold_reason,
        'reject_reason', apa.reject_reason,
        'expires_at', apa.expires_at
    ) AS detail
FROM ap_pending_approvals apa
WHERE apa.order_id IS NOT NULL AND apa.order_id != ''

UNION ALL

-- 3. pending_reconciliations (has both po_number and order_id; 0 rows but include for future)
SELECT
    public._normalize_po(COALESCE(pr.po_number, pr.order_id, '')) AS po_number,
    pr.vendor_name,
    'pending_reconciliation'::text AS doc_type,
    COALESCE(pr.invoice_number, '') AS doc_ref,
    0 AS amount,
    COALESCE(pr.status, 'pending') AS status,
    pr.created_at AS occurred_at,
    'pending_reconciliations'::text AS source_table,
    pr.approval_id AS source_id,
    jsonb_build_object(
        'invoice_number', pr.invoice_number,
        'order_id', pr.order_id,
        'expires_at', pr.expires_at
    ) AS detail
FROM pending_reconciliations pr
WHERE (pr.po_number IS NOT NULL AND pr.po_number != '')
   OR (pr.order_id IS NOT NULL AND pr.order_id != '')

UNION ALL

-- 4. reconciliation_outcomes (uses po_id)
SELECT
    public._normalize_po(COALESCE(ro.po_id, '')) AS po_number,
    ro.vendor_name,
    'reconciliation_outcome'::text AS doc_type,
    COALESCE(ro.invoice_id, '') AS doc_ref,
    0 AS amount,
    COALESCE(ro.outcome, 'unknown') AS status,
    COALESCE(ro.resolved_at, ro.created_at) AS occurred_at,
    'reconciliation_outcomes'::text AS source_table,
    ro.id::text AS source_id,
    jsonb_build_object(
        'invoice_id', ro.invoice_id,
        'outcome', ro.outcome,
        'run_id', ro.run_id,
        'duration_ms', ro.duration_ms,
        'outcome_meta', ro.outcome_meta
    ) AS detail
FROM reconciliation_outcomes ro
WHERE ro.po_id IS NOT NULL AND ro.po_id != ''

UNION ALL

-- 5. ap_activity_log (PO is in metadata->>'poId')
SELECT
    public._normalize_po(COALESCE(alog.metadata->>'poId', '')) AS po_number,
    alog.metadata->>'vendorName' AS vendor_name,
    CASE
        WHEN alog.intent = 'INVOICE' THEN 'activity_invoice'
        WHEN alog.intent = 'RECONCILIATION' THEN 'activity_reconciliation'
        WHEN alog.intent = 'PO_ARRIVAL_AT_RISK' THEN 'activity_po_risk'
        WHEN alog.intent = 'HUMAN_INTERACTION' OR alog.intent = 'HUMAN_INTERACT' THEN 'activity_human_interaction'
        WHEN alog.intent = 'EYES_NEEDED' THEN 'activity_eyes_needed'
        ELSE 'activity_' || lower(alog.intent)
    END AS doc_type,
    COALESCE(alog.email_subject, '') AS doc_ref,
    0 AS amount,
    COALESCE(alog.action_taken, '') AS status,
    alog.created_at AS occurred_at,
    'ap_activity_log'::text AS source_table,
    alog.id::text AS source_id,
    jsonb_build_object(
        'email_from', alog.email_from,
        'email_subject', alog.email_subject,
        'intent', alog.intent,
        'action_taken', alog.action_taken,
        'resolution', alog.resolution,
        'notified_slack', alog.notified_slack,
        'reviewed_action', alog.reviewed_action,
        'short_shipment_detected', alog.short_shipment_detected
    ) AS detail
FROM ap_activity_log alog
WHERE alog.metadata->>'poId' IS NOT NULL AND alog.metadata->>'poId' != ''

UNION ALL

-- 6. po_sends
SELECT
    public._normalize_po(COALESCE(ps.po_number, '')) AS po_number,
    ps.vendor_name,
    'po_send'::text AS doc_type,
    COALESCE(ps.po_number, '') AS doc_ref,
    COALESCE(ps.total_amount, 0) AS amount,
    COALESCE(ps.triggered_by, 'system') AS status,
    ps.created_at AS occurred_at,
    'po_sends'::text AS source_table,
    ps.id::text AS source_id,
    jsonb_build_object(
        'po_number', ps.po_number,
        'vendor_party_id', ps.vendor_party_id,
        'sent_to_email', ps.sent_to_email,
        'item_count', ps.item_count,
        'committed_at', ps.committed_at,
        'sent_at', ps.sent_at,
        'vendor_replied_at', ps.vendor_replied_at
    ) AS detail
FROM po_sends ps
WHERE ps.po_number IS NOT NULL AND ps.po_number != ''

UNION ALL

-- 7. po_shipment_legs (0 rows currently, but schema-ready)
SELECT
    public._normalize_po(COALESCE(psl.po_number, '')) AS po_number,
    psl.vendor_name,
    'shipment_leg'::text AS doc_type,
    COALESCE(psl.tracking_number, '') AS doc_ref,
    0 AS amount,
    CASE
        WHEN psl.actual_date IS NOT NULL THEN 'delivered'
        WHEN psl.expected_date < CURRENT_DATE THEN 'overdue'
        ELSE 'in_transit'
    END AS status,
    psl.created_at AS occurred_at,
    'po_shipment_legs'::text AS source_table,
    psl.id::text AS source_id,
    jsonb_build_object(
        'po_number', psl.po_number,
        'leg_number', psl.leg_number,
        'expected_qty', psl.expected_qty,
        'received_qty', psl.received_qty,
        'expected_date', psl.expected_date,
        'actual_date', psl.actual_date,
        'tracking_number', psl.tracking_number,
        'carrier_name', psl.carrier_name
    ) AS detail
FROM po_shipment_legs psl
WHERE psl.po_number IS NOT NULL AND psl.po_number != ''

UNION ALL

-- 8. po_lifecycle_transitions
SELECT
    public._normalize_po(COALESCE(plt.po_number, '')) AS po_number,
    plt.metadata->>'vendorName' AS vendor_name,
    'lifecycle_transition'::text AS doc_type,
    COALESCE(plt.invoice_id, '') AS doc_ref,
    0 AS amount,
    plt.to_state AS status,
    plt.transitioned_at AS occurred_at,
    'po_lifecycle_transitions'::text AS source_table,
    plt.id::text AS source_id,
    jsonb_build_object(
        'po_number', plt.po_number,
        'from_state', plt.from_state,
        'to_state', plt.to_state,
        'triggered_by', plt.triggered_by,
        'invoice_id', plt.invoice_id
    ) AS detail
FROM po_lifecycle_transitions plt
WHERE plt.po_number IS NOT NULL AND plt.po_number != ''

UNION ALL

-- 9. po_freight_evidence (0 rows, uses order_id; schema-ready)
SELECT
    public._normalize_po(COALESCE(pfe.order_id, '')) AS po_number,
    pfe.vendor_name,
    'freight_evidence'::text AS doc_type,
    '' AS doc_ref,
    COALESCE(pfe.invoice_freight, 0) AS amount,
    CASE WHEN pfe.freight_matched THEN 'matched' ELSE 'unmatched' END AS status,
    pfe.created_at AS occurred_at,
    'po_freight_evidence'::text AS source_table,
    pfe.id::text AS source_id,
    jsonb_build_object(
        'order_id', pfe.order_id,
        'had_freight_on_po', pfe.had_freight_on_po,
        'invoice_freight', pfe.invoice_freight,
        'freight_matched', pfe.freight_matched,
        'completed_by', pfe.completed_by
    ) AS detail
FROM po_freight_evidence pfe
WHERE pfe.order_id IS NOT NULL AND pfe.order_id != '';

COMMENT ON VIEW public.po_document_ledger IS
  'Unified read-only document trail for all AP/purchasing data. Invoice rows come from vendor_invoices (single source of truth since 2026-08-12 consolidation); remaining branches from 20260724 view preserved. po_number normalized via _normalize_po().';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Backfill payment_status on existing vendor_invoices rows (status='paid' → paid)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.vendor_invoices SET payment_status = 'paid'
WHERE status = 'paid' AND payment_status = 'unpaid';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Reload PostgREST schema cache
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

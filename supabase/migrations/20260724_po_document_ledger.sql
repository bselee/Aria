/**
 * Migration: po_document_ledger — READ-ONLY unified VIEW for AP document trail
 * 
 * Creates a non-destructive SQL VIEW that UNIONs across all AP/purchasing tables
 * to present a canonical document-level ledger keyed on po_number.
 * 
 * No data is moved, no tables altered, no writers affected. Trivially rollback-able
 * with DROP VIEW IF EXISTS po_document_ledger;
 * 
 * After applying, reload PostgREST schema cache via:
 *   NOTIFY pgrst, 'reload schema';
 *   -- or --
 *   pm2 restart aria-postgrest
 */

-- Helper function: normalize PO number to canonical form
-- Matches normalizePoString() in src/lib/tracking/shipment-intelligence.ts line 533
CREATE OR REPLACE FUNCTION public._normalize_po(po text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT upper(trim(regexp_replace(trim(po), '^(PO[\s-]?|ORDER[\s-]?|#)', '', 'gi')));
$$;

COMMENT ON FUNCTION public._normalize_po(text) IS
  'Canonical PO normalization: uppercase, trim whitespace, strip PO-/ORDER-/# prefixes. Mirrors normalizePoString() in shipment-intelligence.ts.';

-- Main ledger VIEW
CREATE OR REPLACE VIEW public.po_document_ledger AS

-- 1. invoices table
SELECT
    public._normalize_po(COALESCE(i.po_number, '')) AS po_number,
    i.vendor_name,
    'invoice'::text AS doc_type,
    COALESCE(i.invoice_number, '') AS doc_ref,
    COALESCE(i.total, 0) AS amount,
    COALESCE(i.status, 'unknown') AS status,
    i.created_at AS occurred_at,
    'invoices'::text AS source_table,
    i.id::text AS source_id,
    jsonb_build_object(
        'invoice_number', i.invoice_number,
        'subtotal', i.subtotal,
        'freight', i.freight,
        'tax', i.tax,
        'tariff', i.tariff,
        'labor', i.labor,
        'due_date', i.due_date,
        'payment_terms', i.payment_terms,
        'discrepancies', i.discrepancies
    ) AS detail
FROM invoices i
WHERE i.po_number IS NOT NULL AND i.po_number != ''

UNION ALL

-- 2. paid_invoices table
SELECT
    public._normalize_po(COALESCE(pi.po_number, '')) AS po_number,
    pi.vendor_name,
    'paid_invoice'::text AS doc_type,
    COALESCE(pi.invoice_number, '') AS doc_ref,
    COALESCE(pi.amount_paid, 0) AS amount,
    CASE WHEN pi.po_matched THEN 'po_matched' ELSE 'unmatched' END AS status,
    pi.created_at AS occurred_at,
    'paid_invoices'::text AS source_table,
    pi.id::text AS source_id,
    jsonb_build_object(
        'invoice_number', pi.invoice_number,
        'amount_paid', pi.amount_paid,
        'date_paid', pi.date_paid,
        'po_matched', pi.po_matched,
        'confidence', pi.confidence,
        'email_from', pi.email_from,
        'product_description', pi.product_description
    ) AS detail
FROM paid_invoices pi
WHERE pi.po_number IS NOT NULL AND pi.po_number != ''

UNION ALL

-- 3. vendor_invoices table (largest invoice table — 994 rows)
SELECT
    public._normalize_po(COALESCE(vi.po_number, '')) AS po_number,
    vi.vendor_name,
    'vendor_invoice'::text AS doc_type,
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
        'line_items', vi.line_items,
        'source', vi.source,
        'source_ref', vi.source_ref,
        'reconciled_at', vi.reconciled_at,
        'paid_at', vi.paid_at,
        'notes', vi.notes
    ) AS detail
FROM vendor_invoices vi
WHERE vi.po_number IS NOT NULL AND vi.po_number != ''

UNION ALL

-- 4. ap_pending_approvals (uses order_id as PO reference)
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

-- 5. pending_reconciliations (has both po_number and order_id; 0 rows but include for future)
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

-- 6. reconciliation_outcomes (uses po_id)
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

-- 7. ap_activity_log (PO is in metadata->>'poId')
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

-- 8. po_sends
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

-- 9. po_shipment_legs (0 rows currently, but schema-ready)
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

-- 10. po_lifecycle_transitions
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

-- 11. po_freight_evidence (0 rows, uses order_id; schema-ready)
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
WHERE pfe.order_id IS NOT NULL AND pfe.order_id != ''

;

COMMENT ON VIEW public.po_document_ledger IS
  'Unified read-only document trail for all AP/purchasing data. One row per (po_number, document) pairing across 11 source tables. Non-destructive — zero writes, zero locks, trivially rollback-able (DROP VIEW). po_number is normalized via _normalize_po() (uppercase, trimmed, stripped of PO-/ORDER-/# prefixes) for cross-table joins.';

COMMENT ON COLUMN public.po_document_ledger.po_number IS 'Canonical normalized PO number — use this for cross-table joins.';
COMMENT ON COLUMN public.po_document_ledger.doc_type IS 'Document type discriminator: invoice, paid_invoice, vendor_invoice, approval, pending_reconciliation, reconciliation_outcome, activity_*, po_send, shipment_leg, lifecycle_transition, freight_evidence.';
COMMENT ON COLUMN public.po_document_ledger.doc_ref IS 'Primary reference for the document (invoice_number, order_id, tracking_number, email_subject).';
COMMENT ON COLUMN public.po_document_ledger.amount IS 'Monetary amount associated with the document (total, amount_paid, or 0 for non-financial entries).';
COMMENT ON COLUMN public.po_document_ledger.status IS 'Canonical status for the document type.';
COMMENT ON COLUMN public.po_document_ledger.occurred_at IS 'Timestamp when the document event occurred.';
COMMENT ON COLUMN public.po_document_ledger.source_table IS 'Source table name for provenance tracking.';
COMMENT ON COLUMN public.po_document_ledger.source_id IS 'Primary key value in the source table.';
COMMENT ON COLUMN public.po_document_ledger.detail IS 'Document-type-specific fields as JSONB — forward-compatible with future columns.';

-- ============================================================================
-- Data Steward Model — Phase 1
-- Creates the unified view + decision/action tables that let Hermia manage
-- outstanding items across all Aria systems from a single database.
-- ============================================================================

-- 1. DECISIONS TABLE — records human judgments so the system learns
CREATE TABLE IF NOT EXISTS decisions (
    id          SERIAL PRIMARY KEY,
    record_type TEXT NOT NULL,          -- 'purchase_order', 'invoice', 'vendor_invoice', 'exception'
    record_id   TEXT NOT NULL,          -- po_number, invoice_number, etc.
    decision    TEXT NOT NULL,          -- 'ignore', 'escalate', 'approved', 'rejected', 'duplicate', 'follow_up'
    reason      TEXT,                   -- Human-readable explanation
    decided_by  TEXT NOT NULL DEFAULT 'Bill',
    decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at  TIMESTAMPTZ,            -- When the decision was applied (e.g., email sent, status updated)
    UNIQUE (record_type, record_id, decision)  -- Don't duplicate the same decision
);

-- 2. HERMIA ACTIONS TABLE — what Hermia reviewed, flagged, and acted on
CREATE TABLE IF NOT EXISTS hermia_actions (
    id              SERIAL PRIMARY KEY,
    action_type     TEXT NOT NULL,      -- 'reviewed', 'flagged_for_bill', 'escalated', 'resolved', 'follow_up_sent'
    record_type     TEXT,               -- 'purchase_order', 'invoice', 'vendor_invoice', 'exception'
    record_id       TEXT,               -- po_number, invoice_number, etc.
    summary         TEXT NOT NULL,      -- What Hermia found or did
    decision_id     INTEGER REFERENCES decisions(id),  -- Link to Bill's decision if one was made
    was_noisy       BOOLEAN DEFAULT false,  -- Hermia flagged this as worth Bill's attention
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. HONCHO LINKS TABLE — connects conversations to operational records
CREATE TABLE IF NOT EXISTS honcho_links (
    id              SERIAL PRIMARY KEY,
    conversation_id TEXT NOT NULL,      -- Honcho session/conversation ID
    record_type     TEXT NOT NULL,      -- 'purchase_order', 'invoice', 'vendor_invoice', 'vendor'
    record_id       TEXT NOT NULL,      -- po_number, invoice_number, vendor_name, etc.
    context_snippet TEXT,               -- Brief summary of what was discussed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_honcho_links_record ON honcho_links(record_type, record_id);

-- 4. STANDING ITEMS VIEW — unified queue of everything needing attention
CREATE OR REPLACE VIEW standing_items AS
SELECT 
    'po_no_reply' as category,
    po_number as record_id,
    vendor_name,
    (now()::date - po_sent_at::date) as days_outstanding,
    po_sent_at::date as since,
    'PO sent ' || (now()::date - po_sent_at::date)::text || 'd ago, no vendor reply' as summary,
    'purchase_order' as record_type,
    lifecycle_stage as status,
    CASE 
        WHEN (now()::date - po_sent_at::date) > 30 THEN 'critical'
        WHEN (now()::date - po_sent_at::date) > 14 THEN 'warning'
        ELSE 'watch'
    END as urgency
FROM purchase_orders 
WHERE vendor_response_at IS NULL 
  AND lifecycle_stage IN ('sent', 'l3_escalated')
  AND po_sent_at IS NOT NULL
  AND po_sent_at < now() - interval '3 days'
  AND vendor_name IS NOT NULL
  AND vendor_name != 'BuildASoil'  -- Internal POs don't need vendor reply

UNION ALL

SELECT 
    'invoice_unmatched',
    invoice_number,
    vendor_name,
    (now()::date - created_at::date),
    created_at::date,
    'Invoice $' || COALESCE(total::text, '?') || ' from ' || vendor_name || ' unmatched for ' || (now()::date - created_at::date)::text || 'd',
    'invoice',
    status,
    CASE 
        WHEN (now()::date - created_at::date) > 60 THEN 'critical'
        WHEN (now()::date - created_at::date) > 30 THEN 'warning'
        ELSE 'watch'
    END
FROM invoices 
WHERE status = 'unmatched' 
  AND created_at < now() - interval '1 day'
  AND vendor_name IS NOT NULL

UNION ALL

SELECT 
    'vendor_invoice_unmatched',
    source_ref,
    vendor_name,
    (now()::date - created_at::date),
    created_at::date,
    'Vendor invoice from ' || vendor_name || ' unmatched for ' || (now()::date - created_at::date)::text || 'd',
    'vendor_invoice',
    status,
    CASE 
        WHEN (now()::date - created_at::date) > 60 THEN 'critical'
        WHEN (now()::date - created_at::date) > 30 THEN 'warning'
        ELSE 'watch'
    END
FROM vendor_invoices 
WHERE (status IS NULL OR status NOT IN ('reconciled', 'paid', 'void'))
  AND created_at < now() - interval '1 day'
  AND vendor_name IS NOT NULL

UNION ALL

SELECT 
    'exception_open',
    agent_name,
    error_message,
    (now()::date - created_at::date),
    created_at::date,
    agent_name || ': ' || error_message,
    'exception',
    status,
    CASE 
        WHEN (now()::date - created_at::date) > 7 THEN 'critical'
        WHEN (now()::date - created_at::date) > 3 THEN 'warning'
        ELSE 'watch'
    END
FROM ops_agent_exceptions 
WHERE status = 'open'

UNION ALL

SELECT 
    'pending_approval',
    invoice_number,
    vendor_name,
    (now()::date - created_at::date),
    created_at::date,
    'Approval pending: ' || vendor_name || ' invoice ' || invoice_number,
    'pending_approval',
    status,
    CASE 
        WHEN (now()::date - created_at::date) > 3 THEN 'critical'
        WHEN (now()::date - created_at::date) > 1 THEN 'warning'
        ELSE 'watch'
    END
FROM ap_pending_approvals 
WHERE status = 'pending'
  AND vendor_name IS NOT NULL

ORDER BY urgency DESC, days_outstanding DESC;

-- Grant Hermia read/write access to the new tables
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO anon;

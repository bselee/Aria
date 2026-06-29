-- ════════════════════════════════════════════════════════════════
-- 03-fixup-missing-tables.sql
-- Fixup: Creates 16 tables/buckets/views referenced in the Aria
-- codebase that are missing from 01-roles-and-extensions.sql
-- and 02-all-migrations.sql.
--
-- NOTE: We set ON_ERROR_STOP=off so individual failures don't
-- kill the entire init. Uses IF NOT EXISTS everywhere.
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- 1. ap_invoices — Storage bucket for AP invoice PDFs
--    Used as: supabase.storage.from("ap_invoices")
--    References in: ap-identifier.ts, ap-forwarder.ts
--    NOTE: This is a storage bucket, not a DB table. The INSERT
--    below is idempotent (ON CONFLICT DO NOTHING).
-- ════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'ap_invoices',
    'ap_invoices',
    false,
    10485760,
    ARRAY ['application/pdf']
) ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- 2. documents — Core document ledger
--    Used by: attachment-handler.ts, ap-agent.ts, github/client.ts,
--             run-ap-pipeline.ts, github route
--    Columns inferred from .insert() / .update() / .select() calls
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS documents (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    type              text NOT NULL,                              -- 'invoice', 'statement', 'receipt', etc.
    status            text DEFAULT 'UNPROCESSED',                  -- 'EXTRACTED', 'MATCHED', 'PROCESSED', 'ARCHIVED', 'ocr_failed'
    source            text NOT NULL,                              -- 'email', 'upload', 'github'
    source_ref        text,                                       -- email message ID, file path, etc.
    vendor_id         uuid,                                       -- FK to vendors (if resolved)
    vendor_name       text,                                       -- Denormalized vendor name
    extracted_data    jsonb,                                      -- Full parsed extraction result
    raw_text          text,                                       -- Raw OCR/extraction text
    pdf_path          text,                                       -- Supabase Storage path to PDF
    confidence        text,                                       -- 'high', 'medium', 'low'
    action_required   boolean DEFAULT true,
    action_summary    text,
    linked_documents  text[],                                     -- Array of related document refs (e.g. PO numbers)
    email_from        text,
    email_subject     text,
    email_date        text,
    gmail_message_id  text,                                       -- Gmail message ID for idempotency
    ocr_strategy      text,                                       -- Which OCR strategy was used
    ocr_duration_ms   text,                                       -- OCR processing duration
    github_issue_number integer,
    github_issue_url  text,
    github_issue_state text,                                      -- 'open', 'closed'
    github_last_synced timestamptz,
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents (type);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_vendor_id ON documents (vendor_id);
CREATE INDEX IF NOT EXISTS idx_documents_action_required ON documents (action_required) WHERE action_required = true;
CREATE INDEX IF NOT EXISTS idx_documents_gmail_message_id ON documents (gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents (created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 3. draft_pos — Draft purchase order records
--    Used by: stockout-driver.ts
--    Query: .from("draft_pos").select("draft_po_id").eq("supplier_party_id", ...).eq("status", "draft")
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS draft_pos (
    id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    draft_po_id        text,                                      -- Finale draft PO ID
    supplier_party_id  text,                                      -- Finale supplier party ID
    supplier_name      text,
    status             text DEFAULT 'draft',                      -- 'draft', 'submitted', 'cancelled'
    candidates         jsonb,                                     -- Stockout candidate snapshots
    created_at         timestamptz DEFAULT now(),
    updated_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_draft_pos_supplier ON draft_pos (supplier_party_id);
CREATE INDEX IF NOT EXISTS idx_draft_pos_status ON draft_pos (status);

-- ════════════════════════════════════════════════════════════════
-- 4. inventory_adjustments — Stock movement ledger
--    Used by: proactive-brief.ts (consumption spike detection)
--    Query: .select("sku, quantity, created_at").eq("adjustment_type", "SALE")
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sku              text NOT NULL,
    quantity         numeric(12, 4) DEFAULT 0,                   -- Negative = outbound/sale, Positive = inbound/adjustment
    adjustment_type  text,                                       -- 'SALE', 'RECEIPT', 'RETURN', 'COUNT', 'WRITE_OFF'
    reason           text,
    reference        text,                                       -- PO number, invoice number, etc.
    created_at       timestamptz DEFAULT now(),
    updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_adj_sku ON inventory_adjustments (sku);
CREATE INDEX IF NOT EXISTS idx_inv_adj_type ON inventory_adjustments (adjustment_type);
CREATE INDEX IF NOT EXISTS idx_inv_adj_created ON inventory_adjustments (created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 5. memory_backups — Vector memory snapshot backups
--    Used by: memory-sync.ts
--    Columns inferred from .upsert() and .select() calls
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memory_backups (
    id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    namespace       text NOT NULL UNIQUE,                        -- Pinecone namespace
    vector_count    integer DEFAULT 0,
    dimensions      integer DEFAULT 0,
    snapshot        jsonb NOT NULL,                              -- Full vector snapshot (id, embedding, metadata)
    synced_at       timestamptz DEFAULT now(),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_backups_namespace ON memory_backups (namespace);
CREATE INDEX IF NOT EXISTS idx_memory_backups_synced_at ON memory_backups (synced_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 6. payments — Payment records for statement reconciliation
--    Used by: statement-parser.ts
--    Query: .from("payments").select("*").eq("reference_number", ...)
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payments (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    reference_number text,                                       -- Check number, wire reference, etc.
    vendor_name      text,
    vendor_id        uuid,
    amount           numeric(12, 2) DEFAULT 0,
    payment_date     date,
    payment_method   text,                                       -- 'CHECK', 'WIRE', 'ACH', 'CC', etc.
    status           text DEFAULT 'pending',                      -- 'pending', 'cleared', 'returned'
    memo             text,
    created_at       timestamptz DEFAULT now(),
    updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments (reference_number);
CREATE INDEX IF NOT EXISTS idx_payments_vendor ON payments (vendor_name);

-- ════════════════════════════════════════════════════════════════
-- 7. purchase_assessment_runs — Purchase assessment run log
--    Used by: run-purchase-assessment.ts
--    Columns inferred from .insert() (scrape_success, auth_redirected)
--    and .select("id", "run_at") queries
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_assessment_runs (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    scrape_success   boolean DEFAULT false,
    auth_redirected  boolean DEFAULT false,
    error_message    text,
    run_at           timestamptz DEFAULT now(),
    created_at       timestamptz DEFAULT now(),
    updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_assessment_runs_run_at ON purchase_assessment_runs (run_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 8. purchase_assessments — Per-SKU purchase assessment items
--    Used by: run-purchase-assessment.ts
--    Columns inferred from the itemsToInsert payload
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_assessments (
    id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    run_id             uuid REFERENCES purchase_assessment_runs(id) ON DELETE CASCADE,
    source             text,                                     -- 'FULL_PULL', 'TEAM_REQUEST', etc.
    vendor             text,
    sku                text NOT NULL,
    description        text,
    raw_details        text,
    raw_request_json   jsonb,                                    -- Original scraper request payload
    fuzzy_match_score  numeric(5, 2),                            -- 0.00 - 1.00
    scraped_urgency    text,
    necessity          text,                                     -- 'HIGH_NEED', 'MEDIUM_NEED', 'LOW_NEED'
    stock_on_hand      numeric(12, 4) DEFAULT 0,
    stock_on_order     numeric(12, 4) DEFAULT 0,
    sales_velocity     numeric(12, 4) DEFAULT 0,
    purchase_velocity  numeric(12, 4) DEFAULT 0,
    daily_rate         numeric(12, 4) DEFAULT 0,
    runway_days        numeric(8, 2) DEFAULT 0,
    adjusted_runway_days numeric(8, 2) DEFAULT 0,
    lead_time_days     numeric(8, 2) DEFAULT 0,
    open_pos_json      jsonb,
    explanation        text,
    finale_found       boolean DEFAULT false,
    do_not_reorder     boolean DEFAULT false,
    created_at         timestamptz DEFAULT now(),
    updated_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_assessments_run_id ON purchase_assessments (run_id);
CREATE INDEX IF NOT EXISTS idx_purchase_assessments_sku ON purchase_assessments (sku);
CREATE INDEX IF NOT EXISTS idx_purchase_assessments_necessity ON purchase_assessments (necessity);

-- ════════════════════════════════════════════════════════════════
-- 9. purchasing_automation_state — Vendor-level automation state
--    Used by: purchasing-automation-state.ts
--    Columns inferred from the payload builder and mapper
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchasing_automation_state (
    id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_key              text NOT NULL UNIQUE,                -- Normalized vendor key (lowercase, hyphenated)
    vendor_name             text NOT NULL,
    last_processed_order_ref text,                                -- Finale PO or order reference
    last_processed_at       timestamptz,
    last_mapping_sync_at    timestamptz,
    cooldown_until          timestamptz,                          -- Suppress automation until this timestamp
    constraints             jsonb DEFAULT '{}'::jsonb,            -- Vendor-specific constraints
    override_memory         jsonb DEFAULT '{}'::jsonb,            -- Manual override flags
    feedback_memory         jsonb DEFAULT '{}'::jsonb,            -- PO history + SKU feedback
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchasing_automation_state_vendor_key ON purchasing_automation_state (vendor_key);

-- ════════════════════════════════════════════════════════════════
-- 10. shipment_intelligence — Shipment tracking intelligence
--     Used by: delivery-receipt-prompt.ts, delivery-exception-escalator.ts
--     Columns inferred from .select() calls
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shipment_intelligence (
    id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tracking_number  text,
    po_numbers       jsonb,                                      -- Array of PO numbers (text[])
    vendor_names     jsonb,                                      -- Array of vendor names (text[])
    carrier_name     text,
    carrier_slug     text,
    status_category  text,                                       -- 'delivered', 'exception', 'in_transit', 'pending'
    status_display   text,                                       -- Human-readable status
    status_detail    text,
    delivered_at     timestamptz,
    last_checked_at  timestamptz,
    active           boolean DEFAULT true,
    raw_data         jsonb,                                      -- Full tracking API response
    created_at       timestamptz DEFAULT now(),
    updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_intelligence_tracking ON shipment_intelligence (tracking_number);
CREATE INDEX IF NOT EXISTS idx_shipment_intelligence_status ON shipment_intelligence (status_category);
CREATE INDEX IF NOT EXISTS idx_shipment_intelligence_active ON shipment_intelligence (active);
CREATE INDEX IF NOT EXISTS idx_shipment_intelligence_delivered ON shipment_intelligence (delivered_at)
    WHERE status_category = 'delivered';

-- ════════════════════════════════════════════════════════════════
-- 11. slack_requests — Durable Slack request tracking ledger
--     Used by: request-detector.ts, stale-request-watcher.ts,
--              addressed-message-watcher.ts, monday-briefing.ts,
--              cron jobs
--     NOTE: CREATE TABLE was missing from 02-all-migrations.sql
--     despite ALTER TABLE statements existing. Creating here.
--     Columns inferred from .insert() and .select() calls.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS slack_requests (
    id                bigserial PRIMARY KEY,
    channel_id        text,
    channel_name      text,
    message_ts        text,                                      -- Slack message timestamp (unique within channel)
    thread_ts         text,                                      -- Thread parent timestamp
    requester_user_id text,
    requester_name    text,
    original_text     text,                                      -- Full request text
    items_requested   jsonb,                                     -- Array of SKUs or item descriptions
    status            text DEFAULT 'pending',                     -- 'pending', 'completed', 'cancelled', 'escalated'
    addressed_to_bill boolean DEFAULT false,
    is_dm             boolean DEFAULT false,
    eyes_reacted_at   timestamptz,                               -- When 👀 reaction was added
    last_nudge_at     timestamptz,                               -- Last follow-up nudge timestamp
    completion_po_ref text,                                      -- PO number that satisfied this request
    completed_at      timestamptz,
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slack_requests_status ON slack_requests (status);
CREATE INDEX IF NOT EXISTS idx_slack_requests_created ON slack_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_requests_nudge
    ON slack_requests (status, created_at, last_nudge_at);
CREATE INDEX IF NOT EXISTS idx_slack_requests_addressed
    ON slack_requests (addressed_to_bill, created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 12. statement_artifacts — Storage bucket for statement PDFs/CSVs
--     Used as: supabase.storage.from("statement_artifacts")
--     References in: email-intake.ts, service.ts
--     NOTE: Storage bucket, not a DB table.
-- ════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'statement_artifacts',
    'statement_artifacts',
    false,
    26214400,
    ARRAY ['application/pdf', 'text/csv', 'text/plain']
) ON CONFLICT (id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- 13. statement_reconciliations — Statement reconciliation results
--     Used by: statement-parser.ts
--     Query: .insert({ vendor_name, statement_date, vendor_balance,
--                      our_balance, discrepancy_count, lines, status })
--     Note: Also defined in migrations/001_documents.sql but that
--     file is not included in the automated init pipeline.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS statement_reconciliations (
    id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id         uuid,
    vendor_name       text NOT NULL,
    statement_date    date,
    vendor_balance    numeric(12, 2) DEFAULT 0,
    our_balance       numeric(12, 2) DEFAULT 0,
    discrepancy_amount numeric(12, 2) DEFAULT 0,
    discrepancy_count integer DEFAULT 0,
    lines             jsonb,                                     -- Array of reconciliation line items
    status            text DEFAULT 'PENDING',                     -- 'RECONCILED', 'DISCREPANCIES', 'PENDING'
    document_id       uuid,
    created_at        timestamptz DEFAULT now(),
    updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stmt_recon_vendor ON statement_reconciliations (vendor_name);
CREATE INDEX IF NOT EXISTS idx_stmt_recon_status ON statement_reconciliations (status);
CREATE INDEX IF NOT EXISTS idx_stmt_recon_statement_date ON statement_reconciliations (statement_date DESC);

-- ════════════════════════════════════════════════════════════════
-- 14. vendors — Master vendor registry
--     Used by: attachment-handler.ts, copilot/tools.ts, enricher.ts
--     Query: .select("id, name"), .insert({ name, status }),
--            .update({ ... }), .ilike("name", ...)
--     Note: Also defined in migrations/001_documents.sql but that
--     file is not included in the automated init pipeline.
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendors (
    id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name                   text NOT NULL,
    normalized_name        text,                                  -- Lowercase, stripped version for matching
    aliases                text[],                                -- Alternate names
    website                text,
    payment_portal_url     text,
    remit_to_address       text,
    account_number         text,
    payment_terms          text,
    preferred_payment_method text,
    contact_name           text,
    contact_email          text,
    contact_phone          text,
    ar_email               text,                                  -- Accounts receivable email
    tax_id                 text,
    category               text,
    notes                  text,
    total_spend            numeric(12, 2) DEFAULT 0,
    document_count         integer DEFAULT 0,
    average_payment_days   integer,
    last_order_date        date,
    last_enriched_at       timestamptz,
    status                 text DEFAULT 'active',                  -- 'active', 'inactive', 'on_hold'
    created_at             timestamptz DEFAULT now(),
    updated_at             timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_name ON vendors (name);
CREATE INDEX IF NOT EXISTS idx_vendors_normalized ON vendors (normalized_name);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors (status);
CREATE INDEX IF NOT EXISTS idx_vendors_fts ON vendors USING gin (
    to_tsvector('english', name || ' ' || coalesce(array_to_string(aliases, ' '), ''))
);

-- ════════════════════════════════════════════════════════════════
-- 15. build_risk_snapshot (singular) — Per-component build risk data
--     Used by: proactive-brief.ts
--     Query: .from("build_risk_snapshot")
--            .select("sku, component_name, vendor_name, order_trigger_date, risk_level")
--     NOTE: This is DIFFERENT from "build_risk_snapshots" (plural)
--     which stores run-level summaries. This table stores one row
--     per SKU/component per risk analysis pass.
-- ════════════════════════════════════════════════════════════════
-- NOTE: "build_risk_snapshot" (singular, per-component data) is distinct from
--       "build_risk_snapshots" (plural, run-level summaries in 02-all-migrations.sql).
--       Both should coexist.
CREATE TABLE IF NOT EXISTS build_risk_snapshot (
    id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sku                text NOT NULL,
    component_name     text,
    vendor_name        text,
    order_trigger_date date,                                     -- Date by which this component must be ordered
    risk_level         text,                                     -- 'HIGH', 'MEDIUM', 'LOW', 'OK'
    days_until_trigger integer,
    recommended_qty    numeric(12, 4),
    snapshot_run_id    uuid,                                     -- FK to build_risk_snapshots(id) if available
    created_at         timestamptz DEFAULT now(),
    updated_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_build_risk_snapshot_sku ON build_risk_snapshot (sku);
CREATE INDEX IF NOT EXISTS idx_build_risk_snapshot_trigger_date ON build_risk_snapshot (order_trigger_date);
CREATE INDEX IF NOT EXISTS idx_build_risk_snapshot_risk_level ON build_risk_snapshot (risk_level);

-- ════════════════════════════════════════════════════════════════
-- 16. ops_health_summary — Operational health dashboard view
--     NOTE: This is a VIEW, not a table. It is already created
--     via CREATE OR REPLACE VIEW in the Supabase migrations
--     (02-all-migrations.sql and several supabase/migrations/
--      files). If the view exists, we skip; if not, we create
--     a minimal placeholder so dependent queries don't fail.
--     The full view definition lives in the Supabase migrations.
-- ════════════════════════════════════════════════════════════════
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'ops_health_summary') THEN
        CREATE VIEW public.ops_health_summary AS
        SELECT
            'placeholder'::text AS dimension,
            '0.0'::text AS status,
            now()::timestamptz AS checked_at,
            'View definition must be replaced by Supabase migration CREATE OR REPLACE VIEW'::text AS note;
    END IF;
END $$;

COMMENT ON VIEW public.ops_health_summary IS 'Operational health summary. Full definition should be replaced by the Supabase migration CREATE OR REPLACE VIEW statements in 02-all-migrations.sql.';

-- ════════════════════════════════════════════════════════════════
-- Summary: verify all 13 tables now exist
-- ════════════════════════════════════════════════════════════════
DO $$
DECLARE
    present_count integer := 0;
    missing_count integer := 0;
    table_names text[] := ARRAY[
        'documents', 'vendors', 'draft_pos', 'inventory_adjustments',
        'memory_backups', 'payments', 'purchase_assessment_runs',
        'purchase_assessments', 'purchasing_automation_state',
        'shipment_intelligence', 'slack_requests',
        'statement_reconciliations', 'build_risk_snapshot'
    ];
    t text;
BEGIN
    FOREACH t IN ARRAY table_names
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
            present_count := present_count + 1;
            RAISE NOTICE '   ✅ table %', t;
        ELSE
            missing_count := missing_count + 1;
            RAISE WARNING '   ❌ table % is STILL MISSING after CREATE TABLE IF NOT EXISTS', t;
        END IF;
    END LOOP;
    RAISE NOTICE '03-fixup-missing-tables complete: %/% tables present. Storage buckets: ap_invoices, statement_artifacts. View placeholder: ops_health_summary.', present_count, present_count + missing_count;
END $$;

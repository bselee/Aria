-- Auto-generated: concatenation of all Supabase migrations
-- Applied in chronological order on first DB init
-- NOTE: We set ON_ERROR_STOP=off so individual migration failures
-- (e.g., ALTER TABLE on a table created by a later migration) don't
-- kill the entire init. Supabase applied these in a specific sequence
-- using its migration tracker; we approximate that order here.
-- Any table that fails to ALTER here will be re-checked by the
-- 03-verify-tables.sql script which logs missing tables.


-- ════════════════════════════════════════════════════════════════
-- Migration: 20260226_create_invoices.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create invoices table
-- Created: 2026-02-26
-- Purpose: Base table for storing parsed invoice data from AP Agent processing.
--          Supports invoice → PO reconciliation, vendor intelligence, and audit trail.
-- Rollback: DROP TABLE IF EXISTS invoices;
CREATE TABLE IF NOT EXISTS invoices (
    id BIGSERIAL PRIMARY KEY,
    invoice_number TEXT UNIQUE,
    vendor_name TEXT,
    po_number TEXT,
    invoice_date TEXT,
    due_date TEXT,
    payment_terms TEXT,
    subtotal NUMERIC(12, 2) DEFAULT 0,
    freight NUMERIC(12, 2) DEFAULT 0,
    tax NUMERIC(12, 2) DEFAULT 0,
    total NUMERIC(12, 2) DEFAULT 0,
    amount_due NUMERIC(12, 2) DEFAULT 0,
    status TEXT DEFAULT 'unmatched',
    discrepancies JSONB DEFAULT '[]',
    document_id BIGINT,
    raw_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices (vendor_name);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_po ON invoices (po_number);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices (created_at DESC);
COMMENT ON TABLE invoices IS 'Parsed invoice data from AP Agent email processing. Powers reconciliation and vendor intelligence.';
COMMENT ON COLUMN invoices.status IS 'Processing status: unmatched | matched_approved | matched_review | reconciled';
COMMENT ON COLUMN invoices.discrepancies IS 'Array of price/quantity discrepancies found during PO matching';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260226_create_vendor_profiles.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create vendor_profiles table for vendor intelligence
-- Created: 2026-02-26
-- Purpose: Store vendor communication patterns discovered from cross-inbox PO correlation.
--          Tracks how vendors respond to POs, enabling proactive follow-up and risk detection.
-- Rollback: DROP TABLE IF EXISTS vendor_profiles;
CREATE TABLE IF NOT EXISTS vendor_profiles (
    id BIGSERIAL PRIMARY KEY,
    vendor_name TEXT NOT NULL UNIQUE,
    vendor_emails TEXT [] DEFAULT '{}',
    total_pos INTEGER DEFAULT 0,
    responded_count INTEGER DEFAULT 0,
    communication_pattern TEXT DEFAULT 'no_response' CHECK (
        communication_pattern IN (
            'thread_reply',
            'separate_email',
            'no_response',
            'mixed'
        )
    ),
    last_po_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Index for vendor name lookups
CREATE INDEX IF NOT EXISTS idx_vendor_profiles_name ON vendor_profiles (vendor_name);
COMMENT ON TABLE vendor_profiles IS 'Vendor intelligence database built from cross-inbox PO email correlation.';
COMMENT ON COLUMN vendor_profiles.communication_pattern IS 'How the vendor typically responds to POs: thread_reply, separate_email, no_response, or mixed.';
COMMENT ON COLUMN vendor_profiles.responded_count IS 'Number of POs where the vendor replied to the PO email thread.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260226_add_tariff_labor_to_invoices.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add tariff and labor columns to invoices table
-- Created: 2026-02-26
-- Purpose: Support extraction of duties/tariffs and labor/handling fees from invoices
--          These feed into Finale's orderAdjustmentList for landed cost calculation
-- Rollback: ALTER TABLE invoices DROP COLUMN IF EXISTS tariff, DROP COLUMN IF EXISTS labor;
ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS tariff NUMERIC(12, 2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS labor NUMERIC(12, 2) DEFAULT 0;
-- Also ensure tracking_numbers array column exists for dedup tracking
ALTER TABLE invoices
ADD COLUMN IF NOT EXISTS tracking_numbers TEXT [] DEFAULT '{}';
-- Index for tracking number deduplication lookups
CREATE INDEX IF NOT EXISTS idx_invoices_tracking_numbers ON invoices USING GIN (tracking_numbers);
COMMENT ON COLUMN invoices.tariff IS 'Duties, tariffs, import fees extracted from invoice. Maps to Finale productpromo 10014.';
COMMENT ON COLUMN invoices.labor IS 'Labor, handling, processing fees extracted from invoice. Maps to Finale productpromo 10016.';
COMMENT ON COLUMN invoices.tracking_numbers IS 'Tracking numbers from invoice, used for deduplication before writing to Finale.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260226171208_create_ap_activity_log.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: create_ap_activity_log
-- Purpose: Track decisions and actions taken by the AP Agent on all emails.
CREATE TABLE IF NOT EXISTS public.ap_activity_log (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    email_from text NOT NULL,
    email_subject text NOT NULL,
    intent text NOT NULL,
    -- INVOICE, STATEMENT, ADVERTISEMENT, HUMAN_INTERACTION
    action_taken text NOT NULL,
    -- "Forwarded to Bill.com", "Archived", "Labeled as Statement", "Ignored"
    notified_slack boolean DEFAULT false,
    metadata jsonb -- Any extra data, e.g., the PDF filename or anomalies
);
-- Enable RLS
ALTER TABLE public.ap_activity_log ENABLE ROW LEVEL SECURITY;
-- Allow all operations for authenticated/service role (we only ever access this from the server)
CREATE POLICY "Enable all operations for service role" ON public.ap_activity_log USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260227_create_purchase_orders.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create purchase_orders table
-- Created: 2026-02-27
-- Purpose: Track PO records, vendor response times, and tracking numbers for
--          deduplication of Telegram tracking alerts.

CREATE TABLE IF NOT EXISTS purchase_orders (
    id              BIGSERIAL PRIMARY KEY,
    po_number       TEXT UNIQUE NOT NULL,
    vendor_name     TEXT,
    status          TEXT DEFAULT 'open',
    issue_date      TIMESTAMPTZ,
    required_date   TIMESTAMPTZ,
    total_amount    NUMERIC(12, 2) DEFAULT 0,
    total           NUMERIC(12, 2) DEFAULT 0,
    line_items      JSONB DEFAULT '[]',
    vendor_response_at          TIMESTAMPTZ,
    vendor_response_time_minutes INTEGER,
    tracking_numbers TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_status       ON purchase_orders (status);
CREATE INDEX IF NOT EXISTS idx_po_vendor       ON purchase_orders (vendor_name);
CREATE INDEX IF NOT EXISTS idx_po_created      ON purchase_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_tracking     ON purchase_orders USING GIN (tracking_numbers);

COMMENT ON TABLE purchase_orders IS 'PO records synced from Gmail PO threads. Tracks vendor response times and tracking numbers for dedup.';
COMMENT ON COLUMN purchase_orders.tracking_numbers IS 'Tracking numbers seen for this PO — prevents duplicate Telegram alerts.';
COMMENT ON COLUMN purchase_orders.status IS 'open | partial | received | closed';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260227_add_notified_slack_to_ap_activity_log.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.ap_activity_log
ADD COLUMN IF NOT EXISTS notified_slack boolean DEFAULT false;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260227_add_tracking_numbers_to_purchase_orders.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add tracking_numbers to purchase_orders
-- Created: 2026-02-27
-- Purpose: Persist seen tracking numbers so syncPOConversations() can deduplicate
--          across runs. Without this column the upsert silently fails and the
--          same tracking alert fires every 30 minutes.
ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS tracking_numbers TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_po_tracking_numbers ON purchase_orders USING GIN (tracking_numbers);

COMMENT ON COLUMN purchase_orders.tracking_numbers IS 'Tracking numbers seen for this PO — used to prevent duplicate Telegram alerts.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260302_create_build_risk_snapshots.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE build_risk_snapshots (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at     timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  days_out         integer NOT NULL DEFAULT 30,
  critical_count   integer NOT NULL DEFAULT 0,
  warning_count    integer NOT NULL DEFAULT 0,
  watch_count      integer NOT NULL DEFAULT 0,
  ok_count         integer NOT NULL DEFAULT 0,
  total_components integer NOT NULL DEFAULT 0,
  builds           jsonb,
  components       jsonb,
  unrecognized_skus jsonb
);

CREATE INDEX idx_build_risk_snapshots_generated_at ON build_risk_snapshots (generated_at DESC);

ALTER TABLE build_risk_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON build_risk_snapshots
  USING (true) WITH CHECK (true);

COMMENT ON TABLE build_risk_snapshots IS 'Persisted snapshots of build risk analysis runs. One row per run (cron or manual /buildrisk).';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260302_create_sys_chat_logs.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE sys_chat_logs (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  source      text NOT NULL CHECK (source IN ('telegram', 'slack')),
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL,
  metadata    jsonb
);

CREATE INDEX idx_sys_chat_logs_created_at ON sys_chat_logs (created_at DESC);

ALTER TABLE sys_chat_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON sys_chat_logs
  USING (true) WITH CHECK (true);

COMMENT ON TABLE sys_chat_logs IS 'Live mirror of Telegram bot conversations and Slack watchdog detections for the dashboard.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260303_create_build_completions.sql
-- ════════════════════════════════════════════════════════════════

-- Tracks manufacturing build completions detected by the Aria build watcher cron.
-- One row per completed build order. Used by the dashboard BuildSchedulePanel
-- to show emerald "completed" indicators alongside upcoming scheduled builds.

CREATE TABLE build_completions (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  build_id          text NOT NULL UNIQUE,          -- Finale buildId (e.g. "59127")
  sku               text NOT NULL,                  -- Finale productId (e.g. "CRAFT4")
  quantity          integer NOT NULL DEFAULT 0,
  completed_at      text NOT NULL,                  -- Raw Finale timestamp (e.g. "Mar 3 2026 11:12:41 am")
  calendar_event_id text,                           -- Google Calendar event ID (null if no match found)
  calendar_id       text,                           -- e.g. 'manufacturing@buildasoil.com'
  created_at        timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

CREATE INDEX idx_build_completions_sku ON build_completions (sku);
CREATE INDEX idx_build_completions_created_at ON build_completions (created_at DESC);

ALTER TABLE build_completions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON build_completions
  USING (true) WITH CHECK (true);

COMMENT ON TABLE build_completions IS
  'Finale build completions detected by Aria build watcher. Drives dashboard emerald completion indicators.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260303_create_proactive_alerts.sql
-- ════════════════════════════════════════════════════════════════

-- Tracks prescriptive reorder/build alerts generated by the smart alert engine.
-- One row per (sku, alert_type) — upserted on each run so alerted_at stays fresh.
-- Dedup logic: only re-alert if risk_level worsened OR alerted_at > 20h ago.

CREATE TABLE IF NOT EXISTS proactive_alerts (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sku               text NOT NULL,
  alert_type        text NOT NULL DEFAULT 'reorder',   -- 'reorder' | 'build'
  risk_level        text NOT NULL,                     -- 'CRITICAL' | 'WARNING'
  stockout_days     integer,
  suggested_order_qty integer,
  days_after_order  integer,
  alerted_at        timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL,
  CONSTRAINT proactive_alerts_sku_type_unique UNIQUE (sku, alert_type)
);

CREATE INDEX IF NOT EXISTS idx_proactive_alerts_alerted_at ON proactive_alerts (alerted_at DESC);

ALTER TABLE proactive_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON proactive_alerts
  USING (true) WITH CHECK (true);

COMMENT ON TABLE proactive_alerts IS
  'Smart reorder/build prescriptions generated by the Aria reorder engine. Drives dedup for Telegram alerts.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260304_create_outside_thread_alerts.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create outside_thread_alerts table
-- Purpose: Dedup table for vendor emails found outside PO threads.
--          Prevents the same Gmail message from triggering duplicate Telegram
--          notifications on every 30-minute sync cycle.
-- Rollback: DROP TABLE IF EXISTS outside_thread_alerts;
CREATE TABLE IF NOT EXISTS outside_thread_alerts (
    gmail_message_id TEXT PRIMARY KEY,
    po_number TEXT NOT NULL,
    vendor_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Index for startup hydration query (last 14 days)
CREATE INDEX IF NOT EXISTS idx_outside_thread_alerts_created_at ON outside_thread_alerts (created_at);
-- Comment for clarity
COMMENT ON TABLE outside_thread_alerts IS 'Tracks Gmail message IDs already alerted on via the outside-PO-thread scan in syncPOConversations. Prevents duplicate Telegram notifications.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260304_create_po_sends.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: create po_sends table
-- Tracks every PO that Aria commits in Finale and emails to vendors.
-- gmail_message_id + vendor_replied_at are hooks for future nudge automation via po-correlator.

CREATE TABLE IF NOT EXISTS po_sends (
    id                  BIGSERIAL PRIMARY KEY,
    po_number           TEXT NOT NULL,
    vendor_name         TEXT,
    vendor_party_id     TEXT,
    sent_to_email       TEXT NOT NULL,
    total_amount        NUMERIC(12,2),
    item_count          INTEGER,
    committed_at        TIMESTAMPTZ,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    triggered_by        TEXT DEFAULT 'telegram',   -- 'telegram' | 'dashboard'
    gmail_message_id    TEXT,                      -- for reply tracking (future nudge feature)
    vendor_replied_at   TIMESTAMPTZ,               -- populated by po-correlator when reply detected
    metadata            JSONB,
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_sends_po_number ON po_sends (po_number);
CREATE INDEX IF NOT EXISTS idx_po_sends_no_reply  ON po_sends (sent_at) WHERE vendor_replied_at IS NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260304_create_purchasing_calendar_events.sql
-- ════════════════════════════════════════════════════════════════

-- Tracks the Google Calendar event ID for each Finale purchase order.
-- One row per PO — upserted when status changes so the calendar event stays current.
-- Used by syncPurchasingCalendar() (4h cron) and pollPOReceivings() (30min cron).

CREATE TABLE IF NOT EXISTS purchasing_calendar_events (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number    text NOT NULL UNIQUE,
  event_id     text NOT NULL,
  calendar_id  text NOT NULL,
  status       text NOT NULL DEFAULT 'open',  -- 'open' | 'received' | 'cancelled'
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pce_po_number ON purchasing_calendar_events (po_number);

ALTER TABLE purchasing_calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON purchasing_calendar_events
  USING (true) WITH CHECK (true);

COMMENT ON TABLE purchasing_calendar_events IS
  'Maps Finale PO numbers to Google Calendar event IDs in the purchasing calendar. Enables in-place event updates when PO status changes.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260304_add_follow_up_to_purchase_orders.sql
-- ════════════════════════════════════════════════════════════════

-- Tracks when Aria sent a follow-up ETA request to a vendor.
-- NULL = follow-up not yet sent. Set to now() when email is dispatched.
-- Prevents duplicate pestering across syncPOConversations() runs (every 30 min).

ALTER TABLE purchase_orders
    ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz NULL;

COMMENT ON COLUMN purchase_orders.follow_up_sent_at IS
    'When Aria sent a follow-up email requesting ETA. NULL = not yet sent.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260304_add_reconciliation_review_columns.sql
-- ════════════════════════════════════════════════════════════════

-- Add review tracking columns to ap_activity_log
-- These track dashboard/Telegram approval state and dismiss reasons
--
-- DECISION(2026-03-04): Adding review workflow columns so the dashboard
-- can track approve/pause/dismiss state independently of the Telegram
-- bot's in-memory approval Map. This enables dashboard-driven approval
-- flow and provides audit trail for all reconciliation outcomes.
--
-- reviewed_action values: "approved" | "paused" | "dismissed" | "re-matched" | "acknowledged"
-- dismiss_reason values: "dropship" | "already_handled" | "duplicate" | "credit_memo" | "statement" | "not_ours"
ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_action TEXT,
    ADD COLUMN IF NOT EXISTS dismiss_reason TEXT;
-- Index for querying unreviewed reconciliation entries efficiently.
-- The dashboard needs to quickly find RECONCILIATION rows that haven't been
-- reviewed yet to show action buttons.
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_unreviewed ON ap_activity_log (intent, reviewed_at)
WHERE intent = 'RECONCILIATION'
    AND reviewed_at IS NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260304_vendor_profile_autonomy.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add reconciliation intelligence columns to vendor_profiles
-- Created: 2026-03-04
-- Purpose: Track per-vendor reconciliation patterns for autonomous approval decisions.
--          Enables Phase 3 auto-approve: vendor-specific thresholds that auto-adjust.
-- Rollback: ALTER TABLE vendor_profiles
--   DROP COLUMN IF EXISTS auto_approve_threshold,
--   DROP COLUMN IF EXISTS default_dismiss_action,
--   DROP COLUMN IF EXISTS reconciliation_count,
--   DROP COLUMN IF EXISTS approval_count,
--   DROP COLUMN IF EXISTS dismiss_count,
--   DROP COLUMN IF EXISTS avg_dollar_impact,
--   DROP COLUMN IF EXISTS last_reconciliation_at;
ALTER TABLE vendor_profiles
ADD COLUMN IF NOT EXISTS auto_approve_threshold NUMERIC(5, 2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS default_dismiss_action TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS reconciliation_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS approval_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS dismiss_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_dollar_impact NUMERIC(10, 2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ;
-- auto_approve_threshold: NULL = no auto-approve (human reviews all).
--   When set (e.g. 5.00), reconciliations under this % variance are auto-approved.
--   Updated by the system as approval history grows.
COMMENT ON COLUMN vendor_profiles.auto_approve_threshold IS 'Max % variance for auto-approve. NULL = no auto-approve. Updated automatically from approval patterns.';
COMMENT ON COLUMN vendor_profiles.default_dismiss_action IS 'Most common dismiss reason for this vendor (e.g. dropship). Enables future auto-routing.';
COMMENT ON COLUMN vendor_profiles.reconciliation_count IS 'Total reconciliations processed for this vendor.';
COMMENT ON COLUMN vendor_profiles.approval_count IS 'Number of reconciliations approved (auto or manual).';
COMMENT ON COLUMN vendor_profiles.dismiss_count IS 'Number of reconciliations dismissed.';
COMMENT ON COLUMN vendor_profiles.avg_dollar_impact IS 'Average dollar impact of approved reconciliations.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_create_ap_inbox_queue.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create ap_inbox_queue table
-- Created: 2026-03-05
-- Rollback: DROP TABLE IF EXISTS ap_inbox_queue;
--
-- DECISION(2026-03-05): Decoupling the AP agent into a queue-based system.
-- ap_inbox_queue acts as the central state machine for incoming invoices,
-- allowing identifier, extractor, matcher, and forwarder agents to run asynchronously.
CREATE TABLE IF NOT EXISTS ap_inbox_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id TEXT UNIQUE NOT NULL,
    email_from TEXT,
    email_subject TEXT,
    intent TEXT,
    pdf_path TEXT,
    pdf_filename TEXT,
    extracted_json JSONB,
    status TEXT NOT NULL DEFAULT 'PENDING_EXTRACTION',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Create a storage bucket for the PDFs if it doesn't exist
INSERT INTO storage.buckets (
        id,
        name,
        public,
        file_size_limit,
        allowed_mime_types
    )
VALUES (
        'ap_invoices',
        'ap_invoices',
        false,
        10485760,
        ARRAY ['application/pdf']
    ) ON CONFLICT (id) DO
UPDATE
SET allowed_mime_types = ARRAY ['application/pdf'];

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_ap_inbox_queue_add_source_inbox.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add source_inbox column to ap_inbox_queue
-- Created: 2026-03-05
-- Rollback: ALTER TABLE ap_inbox_queue DROP COLUMN IF EXISTS source_inbox;
--
-- REASON: APIdentifierAgent processes emails from multiple Gmail accounts
-- ("ap" and "default"). Downstream agents (ap-forwarder, reconciler) need
-- to know which Gmail token to use for label operations and message fetching.
ALTER TABLE ap_inbox_queue
    ADD COLUMN IF NOT EXISTS source_inbox TEXT DEFAULT 'ap';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_email_inbox_queue.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create email_inbox_queue table
-- Created: 2026-03-05
-- Rollback: DROP TABLE IF EXISTS email_inbox_queue;
--
-- DECISION(2026-03-05): Decoupling email ingestion from agent processing.
-- A single ingestion worker will populate this table from Gmail, and agents 
-- (Tracking, Acknowledgement, AP Identifier) will process rows from here
-- to prevent API exhaustion and race conditions.
CREATE TABLE IF NOT EXISTS email_inbox_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The unique Gmail message ID to prevent duplicate ingestion
    gmail_message_id TEXT UNIQUE NOT NULL,
    -- Metadata about the email
    from_email TEXT,
    subject TEXT,
    body_snippet TEXT,
    -- Fast-path indicator so AP agents don't have to download the raw body if false
    has_pdf BOOLEAN DEFAULT false,
    -- Workflow Management
    -- unprocessed: Freshly ingested, untouched
    -- processing: Checked out by a worker
    -- completed: Processed successfully
    -- failed: Encounered an error during processing
    status TEXT NOT NULL DEFAULT 'unprocessed',
    -- Audit trail
    processed_by TEXT,
    -- the name of the agent that locked/completed it
    error_message TEXT,
    -- details if status = 'failed'
    -- Basic timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Note: We omit a trigger to update updated_at here for simplicity, 
-- but we should manually update it in our client code if needed.

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_email_inbox_queue_agents.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add agent tracking columns to email_inbox_queue
-- Created: 2026-03-05
-- Rollback: ALTER TABLE email_inbox_queue DROP COLUMN IF EXISTS processed_by_ack, DROP COLUMN IF EXISTS processed_by_ap, DROP COLUMN IF EXISTS processed_by_tracking;
--
-- DECISION(2026-03-05): An email might contain both an invoice (AP Agent)
-- and a tracking number (Tracking Agent), and still need an Acknowledgement.
-- A single status string ('completed') would cause the first agent to hide the
-- row from the others. These separate boolean flags allow decoupled processing.
ALTER TABLE email_inbox_queue
ADD COLUMN IF NOT EXISTS processed_by_ack BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS processed_by_ap BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS processed_by_tracking BOOLEAN DEFAULT false;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_email_inbox_queue_source.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add source_inbox to email_inbox_queue
-- Created: 2026-03-05
ALTER TABLE email_inbox_queue
ADD COLUMN IF NOT EXISTS source_inbox TEXT DEFAULT 'default';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_email_inbox_queue_threading.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add threaded email columns
-- Created: 2026-03-05
ALTER TABLE email_inbox_queue
ADD COLUMN IF NOT EXISTS rfc_message_id TEXT,
    ADD COLUMN IF NOT EXISTS thread_id TEXT;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305_ops_agent_exceptions.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: ops_agent_exceptions table
-- Created: 2026-03-05
-- Rollback: DROP TABLE IF EXISTS ops_agent_exceptions;
--
-- DECISION(2026-03-05): Establishing an exception queue for the Multi-Agent System.
-- Instead of agents sending immediate, un-actionable text messages when they crash 
-- or encounter parsing issues, they write here. A SupervisorAgent scans this table
-- to attempt automatic fix/reset, and only escalates to human (Telegram) if stumped.
CREATE TABLE IF NOT EXISTS ops_agent_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_stack TEXT,
    -- JSON holding the table name, row ID, or context where it crashed so the Supervisor can reset it
    context_data JSONB DEFAULT '{}'::jsonb,
    -- Workflow: pending -> resolved (auto-fixed) OR escalated (sent to Telegram) OR ignored
    status TEXT NOT NULL DEFAULT 'pending',
    resolution_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260305212429_add_last_tracking_purchasing_calendar.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE purchasing_calendar_events
ADD COLUMN last_tracking text DEFAULT '';
COMMENT ON COLUMN purchasing_calendar_events.last_tracking IS 'Stores a stringified representation of the tracking numbers last synced to Google Calendar, used to detect changes.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260306_create_feedback_events.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: feedback_events table — Aria's Kaizen feedback loop
-- Created: 2026-03-06
-- Rollback: DROP TABLE IF EXISTS feedback_events;
--
-- DECISION(2026-03-06): Single table for ALL feedback signals.
-- Categories: correction, outcome, error_pattern, engagement, prediction, vendor_reliability
-- This table is the source of truth for Aria's self-improvement metrics.
CREATE TABLE IF NOT EXISTS feedback_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    -- What kind of feedback signal
    category TEXT NOT NULL CHECK (
        category IN (
            'correction',
            'outcome',
            'error_pattern',
            'engagement',
            'prediction',
            'vendor_reliability'
        )
    ),
    -- Specific event type (e.g. 'reconciliation_rejected', 'po_created_after_suggestion')
    event_type TEXT NOT NULL,
    -- Which agent generated this signal
    agent_source TEXT NOT NULL,
    -- What entity this feedback is about
    subject_type TEXT CHECK (
        subject_type IN (
            'vendor',
            'sku',
            'po',
            'invoice',
            'alert',
            'message',
            'build',
            NULL
        )
    ),
    subject_id TEXT,
    -- What Aria predicted/recommended
    prediction JSONB DEFAULT '{}'::jsonb,
    -- What actually happened
    actual_outcome JSONB DEFAULT '{}'::jsonb,
    -- Accuracy score (0.00 to 1.00) — null if not yet scoreable
    accuracy_score NUMERIC(3, 2) CHECK (
        accuracy_score IS NULL
        OR (
            accuracy_score >= 0
            AND accuracy_score <= 1
        )
    ),
    -- What the user did in response
    user_action TEXT CHECK (
        user_action IN (
            'approved',
            'rejected',
            'ignored',
            'corrected',
            'engaged',
            'snoozed',
            NULL
        )
    ),
    -- Extra context
    context_data JSONB DEFAULT '{}'::jsonb,
    -- Has this learning been synced to Pinecone memory?
    synced_to_memory BOOLEAN DEFAULT false
);
-- Indexes for common query patterns
CREATE INDEX idx_feedback_events_category_created ON feedback_events (category, created_at DESC);
CREATE INDEX idx_feedback_events_agent_created ON feedback_events (agent_source, created_at DESC);
CREATE INDEX idx_feedback_events_subject ON feedback_events (subject_type, subject_id)
WHERE subject_type IS NOT NULL;
CREATE INDEX idx_feedback_events_unsynced ON feedback_events (synced_to_memory)
WHERE synced_to_memory = false;
CREATE INDEX idx_feedback_events_accuracy ON feedback_events (category, accuracy_score)
WHERE accuracy_score IS NOT NULL;
ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON feedback_events USING (true) WITH CHECK (true);
COMMENT ON TABLE feedback_events IS 'Aria Kaizen feedback loop — every signal of "was Aria right?" flows through this table for accuracy tracking, self-review, and continuous improvement.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260310_create_pending_dropships.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create pending_dropships table
-- Purpose: Persist dropship PDF references across pm2 restarts.
--          Previously stored in an in-memory Map with setTimeout expiry,
--          which was lost on restart — PDFs gone, Telegram buttons dead.
--
-- Rollback: DROP TABLE IF EXISTS pending_dropships;
CREATE TABLE IF NOT EXISTS pending_dropships (
    id TEXT PRIMARY KEY,
    invoice_number TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    total NUMERIC(12, 2) NOT NULL DEFAULT 0,
    subject TEXT,
    email_from TEXT,
    filename TEXT,
    document_id UUID,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'forwarded', 'expired', 'skipped')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260310_add_ocr_tracking_to_documents.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add OCR quality tracking columns to documents table
-- Purpose:  M1 — track which OCR strategy succeeded and how long it took.
--           Enables monitoring extraction quality per vendor and per strategy.
--
-- Rollback: ALTER TABLE documents DROP COLUMN IF EXISTS ocr_strategy;
--           ALTER TABLE documents DROP COLUMN IF EXISTS ocr_duration_ms;
--
-- DECISION(2026-03-10): Wrapped in DO block with IF EXISTS guard because the
-- documents table may not exist in all environments (defined in separate migration path).
-- The OCR tracking columns are advisory — if the table is absent, the insert calls
-- in ap-agent.ts will naturally fail and get caught by their try/catch blocks.
DO $$ BEGIN IF EXISTS (
    SELECT
    FROM information_schema.tables
    WHERE table_schema = 'public'
        AND table_name = 'documents'
) THEN
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS ocr_strategy TEXT;
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS ocr_duration_ms INTEGER;
COMMENT ON COLUMN documents.ocr_strategy IS 'Which extraction strategy succeeded (pdf-parse, anthropic, openai, openrouter, gemini, unknown)';
COMMENT ON COLUMN documents.ocr_duration_ms IS 'Time taken for PDF extraction in milliseconds';
RAISE NOTICE 'Added ocr_strategy and ocr_duration_ms columns to documents table';
ELSE RAISE NOTICE 'documents table does not exist — skipping OCR tracking columns';
END IF;
END $$;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260310_add_status_to_pending_reconciliations.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add status column to pending_reconciliations
-- Purpose: Enable marking entries as approved/rejected/expired instead of deleting.
--          Previously, rows were deleted on approve/reject/expire, losing the audit trail.
--          Now we keep the row and update the status.
--
-- Rollback: ALTER TABLE pending_reconciliations DROP COLUMN IF EXISTS status;
ALTER TABLE pending_reconciliations
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'approved', 'rejected', 'expired')
    );
CREATE INDEX IF NOT EXISTS idx_pending_recon_status ON pending_reconciliations(status)
WHERE status = 'pending';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260310_pending_reconciliations.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: pending_reconciliations
-- Purpose: Persist pending Telegram approval requests across pm2 restarts.
--          Previously these lived only in an in-memory Map (lost on restart).
--          Now storePendingApproval() writes here; approve/reject deletes the row.
-- Created: 2026-03-10

CREATE TABLE IF NOT EXISTS pending_reconciliations (
    approval_id         TEXT        PRIMARY KEY,
    invoice_number      TEXT,
    vendor_name         TEXT,
    po_number           TEXT,
    order_id            TEXT,
    result              JSONB       NOT NULL,           -- Full ReconciliationResult (serialized)
    telegram_message_id INTEGER,                        -- Telegram message ID for the approval prompt
    telegram_chat_id    TEXT,                           -- Chat ID to send follow-up to
    status              TEXT        NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL            -- created_at + 24h
);

-- Add status column to existing table if it was created without it
ALTER TABLE pending_reconciliations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_reconciliations_expires
    ON pending_reconciliations (expires_at);

CREATE INDEX IF NOT EXISTS idx_pending_reconciliations_order
    ON pending_reconciliations (order_id);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260310_reconciliation_report.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE ap_activity_log
  ADD COLUMN IF NOT EXISTS reconciliation_report JSONB;

CREATE INDEX IF NOT EXISTS idx_ap_activity_log_report
  ON ap_activity_log USING GIN (reconciliation_report)
  WHERE reconciliation_report IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260313_email_inbox_queue_body_text.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add body_text and pdf_filenames to email_inbox_queue
-- Created: 2026-03-13
-- Rollback: ALTER TABLE email_inbox_queue DROP COLUMN IF EXISTS body_text;
--           ALTER TABLE email_inbox_queue DROP COLUMN IF EXISTS pdf_filenames;
--
-- DECISION(2026-03-13): PO #124462 revealed that storing only the Gmail snippet
-- (~200 chars) caused downstream agents to fail on inline invoice detection.
-- body_text stores the full decoded plain-text email body.
-- pdf_filenames stores an array of PDF attachment names for pre-classification
-- override logic (e.g., "BASPO-124462.pdf" → force INVOICE classification).

ALTER TABLE email_inbox_queue
    ADD COLUMN IF NOT EXISTS body_text TEXT,
    ADD COLUMN IF NOT EXISTS pdf_filenames TEXT[];

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260313_price_change_audit.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create price_change_audit table for queryable cost tracking
-- Created: 2026-03-13
-- Rollback: DROP TABLE IF EXISTS price_change_audit;
--
-- DECISION(2026-03-13): PO #124462 exposed that price/fee data was only in JSONB
-- (ap_activity_log.reconciliation_report), making it impossible to answer
-- "What did we pay vendor X for freight?" or "Show all price changes for SKU Y".
-- This flat table enables simple SQL queries for any cost audit question.

CREATE TABLE IF NOT EXISTS price_change_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number TEXT NOT NULL,
    vendor_name TEXT,
    invoice_number TEXT,
    -- 'item_price' | 'freight' | 'tax' | 'tariff' | 'labor' | 'discount' | 'fuel_surcharge'
    change_type TEXT NOT NULL,
    sku TEXT,                      -- NULL for fee changes
    description TEXT,
    old_value NUMERIC(12,4),       -- prior PO value (0 if new fee)
    new_value NUMERIC(12,4),       -- invoice value being applied
    quantity NUMERIC(12,4),        -- for item prices: used in dollar_impact calc
    dollar_impact NUMERIC(12,4),   -- (new - old) * qty for items; (new - old) for fees
    percent_change NUMERIC(8,4),
    verdict TEXT,                  -- auto_approve | needs_approval | rejected | no_change
    approved_by TEXT,              -- 'system' | 'Will'
    carrier_name TEXT,             -- for freight/shipping context
    tracking_numbers TEXT[],       -- associated tracking
    source TEXT DEFAULT 'pdf_invoice',  -- 'pdf_invoice' | 'inline_invoice' | 'manual'
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common audit queries
CREATE INDEX IF NOT EXISTS idx_price_audit_po ON price_change_audit(po_number);
CREATE INDEX IF NOT EXISTS idx_price_audit_vendor ON price_change_audit(vendor_name);
CREATE INDEX IF NOT EXISTS idx_price_audit_sku ON price_change_audit(sku) WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_price_audit_type ON price_change_audit(change_type);
CREATE INDEX IF NOT EXISTS idx_price_audit_date ON price_change_audit(created_at);

-- Example audit queries this table enables:
-- "What freight have we paid to Organic AG Products?"
--   SELECT * FROM price_change_audit WHERE vendor_name ILIKE '%organic ag%' AND change_type = 'freight';
--
-- "Show all price changes for SKU BLM209"
--   SELECT * FROM price_change_audit WHERE sku = 'BLM209' AND change_type = 'item_price' ORDER BY created_at;
--
-- "Total tariffs this month"
--   SELECT SUM(new_value) FROM price_change_audit WHERE change_type = 'tariff' AND created_at >= date_trunc('month', now());

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260316_create_paid_invoices.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create paid_invoices table
-- Purpose: Logs paid invoice confirmation emails for recall and PO correlation.
-- Rollback: DROP TABLE IF EXISTS paid_invoices;

CREATE TABLE IF NOT EXISTS paid_invoices (
    id              BIGSERIAL PRIMARY KEY,
    vendor_name     TEXT NOT NULL,
    invoice_number  TEXT NOT NULL,
    amount_paid     NUMERIC(12,2) NOT NULL DEFAULT 0,
    date_paid       DATE,
    po_number       TEXT,                         -- Matched Finale PO orderId (null if unmatched)
    po_matched      BOOLEAN NOT NULL DEFAULT FALSE,
    product_description TEXT,
    vendor_address  TEXT,
    email_from      TEXT,
    email_subject   TEXT,
    gmail_message_id TEXT,
    confidence      TEXT DEFAULT 'medium',         -- high | medium | low
    source_inbox    TEXT DEFAULT 'default',
    draft_po_id     TEXT,                          -- Draft PO created by Aria (null if matched or failed)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for quick lookups by vendor and invoice number
CREATE INDEX IF NOT EXISTS idx_paid_invoices_vendor ON paid_invoices (vendor_name);
CREATE INDEX IF NOT EXISTS idx_paid_invoices_invoice ON paid_invoices (invoice_number);
CREATE INDEX IF NOT EXISTS idx_paid_invoices_gmail ON paid_invoices (gmail_message_id);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260317_create_vendor_invoices.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create vendor_invoices table
-- Created: 2026-03-17
-- Purpose: Unified archive of every vendor invoice across all intake channels.
--          Single source of truth for "What did we pay vendor X this year?"
-- Rollback: DROP TABLE IF EXISTS vendor_invoices;

CREATE TABLE IF NOT EXISTS vendor_invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name     TEXT NOT NULL,
    invoice_number  TEXT,
    invoice_date    DATE,
    due_date        DATE,
    po_number       TEXT,                          -- Matched Finale PO (null if unmatched)
    subtotal        NUMERIC(12,2) DEFAULT 0,
    freight         NUMERIC(12,2) DEFAULT 0,
    tax             NUMERIC(12,2) DEFAULT 0,
    total           NUMERIC(12,2) DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','reconciled','paid','disputed','void')),
    source          TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('email_attachment','portal_scrape','csv_import',
                                          'sandbox_drop','payment_confirm','manual')),
    source_ref      TEXT,                          -- Gmail msg ID, scrape run ID, filename, etc.
    pdf_storage_path TEXT,                         -- Supabase Storage path (documents/{type}/{vendor}/...)
    line_items      JSONB DEFAULT '[]',            -- [{sku, description, qty, unit_price, ext_price}]
    raw_data        JSONB DEFAULT '{}',            -- Full original parsed payload for audit
    reconciled_at   TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate imports of the same invoice from the same vendor
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_invoices_vendor_inv
    ON vendor_invoices (vendor_name, invoice_number)
    WHERE invoice_number IS NOT NULL;

-- Common query indexes
CREATE INDEX IF NOT EXISTS idx_vi_vendor      ON vendor_invoices (vendor_name);
CREATE INDEX IF NOT EXISTS idx_vi_date        ON vendor_invoices (invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_vi_po          ON vendor_invoices (po_number)   WHERE po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vi_status      ON vendor_invoices (status);
CREATE INDEX IF NOT EXISTS idx_vi_source      ON vendor_invoices (source);
CREATE INDEX IF NOT EXISTS idx_vi_created     ON vendor_invoices (created_at DESC);

COMMENT ON TABLE vendor_invoices IS
    'Unified vendor invoice archive — single source of truth for every invoice regardless of intake channel.';

-- ── Backfill from existing invoices table ─────────────────────────────────────
INSERT INTO vendor_invoices (
    vendor_name, invoice_number, invoice_date, due_date, po_number,
    subtotal, freight, tax, total, status, source, source_ref,
    line_items, raw_data, reconciled_at, created_at
)
SELECT
    COALESCE(i.vendor_name, 'Unknown'),
    i.invoice_number,
    i.invoice_date::DATE,
    CASE WHEN i.due_date ~ '^\d{4}-\d{2}-\d{2}' THEN i.due_date::DATE ELSE NULL END,
    i.po_number,
    i.subtotal,
    i.freight,
    i.tax,
    i.total,
    CASE
        WHEN i.status IN ('reconciled','matched_approved') THEN 'reconciled'
        WHEN i.status = 'paid'                             THEN 'paid'
        ELSE 'received'
    END,
    'email_attachment',
    i.document_id::TEXT,
    COALESCE(i.raw_data->'lineItems', '[]'::JSONB),
    COALESCE(i.raw_data, '{}'::JSONB),
    CASE WHEN i.status IN ('reconciled','matched_approved') THEN i.updated_at ELSE NULL END,
    i.created_at
FROM invoices i
ON CONFLICT (vendor_name, invoice_number)
    WHERE invoice_number IS NOT NULL
    DO NOTHING;

-- ── Backfill from paid_invoices table ─────────────────────────────────────────
INSERT INTO vendor_invoices (
    vendor_name, invoice_number, total, po_number,
    status, source, source_ref, paid_at, created_at,
    notes
)
SELECT
    pi.vendor_name,
    pi.invoice_number,
    pi.amount_paid,
    pi.po_number,
    'paid',
    'payment_confirm',
    pi.gmail_message_id,
    pi.created_at,          -- treat logged-at as paid-at
    pi.created_at,
    CONCAT_WS(' | ',
        NULLIF(pi.product_description, ''),
        NULLIF(pi.email_subject, '')
    )
FROM paid_invoices pi
ON CONFLICT (vendor_name, invoice_number)
    WHERE invoice_number IS NOT NULL
    DO UPDATE SET
        status  = 'paid',
        paid_at = EXCLUDED.paid_at,
        notes   = CONCAT_WS(' | ', vendor_invoices.notes, EXCLUDED.notes);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260317_add_axiom_demand_queue.sql
-- ════════════════════════════════════════════════════════════════

-- 20260317_add_axiom_demand_queue.sql
create table public.axiom_demand_queue (
  id uuid default gen_random_uuid() primary key,
  sku text not null,
  product_name text,
  suggested_qty integer not null,
  velocity_30d numeric,
  runway_days integer,
  status text not null default 'pending' check (status in ('pending', 'ordered', 'dismissed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index for fast queries on the dashboard
create index idx_axiom_demand_status on public.axiom_demand_queue(status);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260317_add_receiving_to_ap_activity_log.sql
-- ════════════════════════════════════════════════════════════════

-- Add receiving status tracking to ap_activity_log
ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS receiving_status JSONB,
ADD COLUMN IF NOT EXISTS short_shipment_detected BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS short_shipment_lines TEXT[], -- SKU list of short-shipped lines
ADD COLUMN IF NOT EXISTS receiving_gap_total NUMERIC DEFAULT 0; -- Total units short across all lines

-- Create table for pending approvals queue
CREATE TABLE IF NOT EXISTS ap_pending_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  order_id TEXT,
  reconciliation_result JSONB NOT NULL,
  verdict_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'holding_credit_memo', 'rejected'
  telegram_message_id TEXT,
  telegram_chat_id TEXT,
  hold_reason TEXT,
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Index for quick lookup of short shipments
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_short_shipment
  ON ap_activity_log(short_shipment_detected, created_at DESC)
  WHERE short_shipment_detected = TRUE;

-- Index for pending approvals
CREATE INDEX IF NOT EXISTS idx_ap_pending_approvals_status
  ON ap_pending_approvals(status, expires_at);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260317_add_reconciliation_views.sql
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW ap_reconciliation_daily_summary AS
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS total_invoices,
  COUNT(CASE WHEN metadata->>'verdict' = 'auto_approve' THEN 1 END) AS auto_approved,
  COUNT(CASE WHEN metadata->>'verdict' = 'needs_approval' THEN 1 END) AS needs_approval,
  COUNT(CASE WHEN metadata->>'verdict' = 'short_shipment_hold' THEN 1 END) AS short_shipment_holds,
  COUNT(CASE WHEN metadata->>'verdict' = 'rejected' THEN 1 END) AS rejected,
  ROUND(SUM(CAST(metadata->>'invoiceTotal' AS NUMERIC)), 2) AS total_amount,
  COUNT(CASE WHEN short_shipment_detected = TRUE THEN 1 END) AS short_shipments_detected,
  ROUND(SUM(receiving_gap_total), 2) AS total_receiving_gaps
FROM ap_activity_log
WHERE intent = 'RECONCILIATION'
GROUP BY DATE(created_at)
ORDER BY DATE DESC;

CREATE OR REPLACE VIEW ap_short_shipments_by_vendor AS
SELECT
  metadata->>'vendorName' AS vendor,
  COUNT(*) AS shipment_count,
  COUNT(DISTINCT metadata->>'invoiceNumber') AS affected_invoices,
  ROUND(SUM(receiving_gap_total), 2) AS total_gap_amount,
  MIN(created_at) AS first_occurrence,
  MAX(created_at) AS latest_occurrence
FROM ap_activity_log
WHERE intent = 'RECONCILIATION' AND short_shipment_detected = TRUE
GROUP BY metadata->>'vendorName'
ORDER BY shipment_count DESC;

CREATE OR REPLACE VIEW ap_pending_approvals_active AS
SELECT
  id,
  invoice_number,
  vendor_name,
  order_id,
  verdict_type,
  status,
  AGE(expires_at, created_at) AS ttl_remaining,
  created_at
FROM ap_pending_approvals
WHERE status = 'pending' AND expires_at > NOW()
ORDER BY created_at DESC;

CREATE OR REPLACE VIEW ap_receiving_variance_analysis AS
SELECT
  metadata->>'vendorName' AS vendor,
  COUNT(*) AS invoices_processed,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC)),
    0
  ) AS total_units_ordered,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)),
    0
  ) AS total_units_received,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC))
    - SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)),
    0
  ) AS units_short,
  ROUND(
    (SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)) /
      NULLIF(SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC)), 0)
    ) * 100,
    2
  ) AS receipt_percentage
FROM ap_activity_log
WHERE intent = 'RECONCILIATION'
GROUP BY metadata->>'vendorName'
ORDER BY units_short DESC;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260317_add_vendor_aliases.sql
-- ════════════════════════════════════════════════════════════════

-- 20260317_add_vendor_aliases.sql
-- Description: Adds a table to map vendor aliases found on invoices to their official Finale supplier names/IDs.

CREATE TABLE IF NOT EXISTS public.vendor_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    finale_supplier_name TEXT NOT NULL,
    alias TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(alias)
);

-- Enable RLS
ALTER TABLE public.vendor_aliases ENABLE ROW LEVEL SECURITY;

-- Create policy for authenticated users
CREATE POLICY "Enable read access for authenticated users" 
ON public.vendor_aliases FOR SELECT 
USING (auth.role() = 'authenticated');

CREATE POLICY "Enable write access for authenticated users" 
ON public.vendor_aliases FOR INSERT 
WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Enable update access for authenticated users" 
ON public.vendor_aliases FOR UPDATE 
USING (auth.role() = 'authenticated');

-- Create policy for service role (used by AP Agent)
CREATE POLICY "Enable all access for service role" 
ON public.vendor_aliases FOR ALL 
USING (true);

-- Add index on alias for fast lookups
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_alias ON public.vendor_aliases(alias);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260317_vendor_invoices_uq_constraint.sql
-- ════════════════════════════════════════════════════════════════

-- Add a named unique constraint on (vendor_name, invoice_number) so that
-- Supabase .upsert({ onConflict: "vendor_name,invoice_number" }) works correctly.
-- PostgreSQL treats NULL as distinct in unique constraints, so multiple rows with
-- invoice_number = NULL are still allowed.

ALTER TABLE vendor_invoices
    DROP CONSTRAINT IF EXISTS uq_vendor_name_invoice;

ALTER TABLE vendor_invoices
    ADD CONSTRAINT uq_vendor_name_invoice
    UNIQUE (vendor_name, invoice_number);

-- Keep the partial index for query performance on non-null invoice numbers
-- (already created in 20260317_create_vendor_invoices.sql)

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260318_add_last_eta_update_to_po.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS last_eta_update JSONB DEFAULT '{}'::jsonb;
COMMENT ON COLUMN purchase_orders.last_eta_update IS 'Tracks the last known status of each tracking number to prevent redundant Slack updates.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260324_create_nightshift_queue.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create nightshift_queue table for local LLM email pre-classification
-- Created: 2026-03-24
-- Rollback: DROP TABLE IF EXISTS nightshift_queue;
--
-- DECISION(2026-03-24): Nightshift agent uses a local Qwen model (via llama-server)
-- to pre-classify AP emails overnight. Results are stored here so the 8 AM AP
-- identifier poll can skip the paid Sonnet call when confidence >= 0.7.
-- Safety: getPreClassification() returns null on any failure — daytime AP flow is
-- completely unaffected if the nightshift system never ran.

CREATE TABLE IF NOT EXISTS nightshift_queue (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type        TEXT NOT NULL DEFAULT 'email_classification',
    gmail_message_id TEXT NOT NULL,
    payload          JSONB NOT NULL DEFAULT '{}',
    -- { from_email, subject, body_snippet, source_inbox }
    status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','processing','completed','failed')),
    result           JSONB,
    -- { classification, confidence, handler, reasoning }
    handler          TEXT,  -- 'local' | 'claude-haiku'
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nightshift_queue_msg_type
    ON nightshift_queue (gmail_message_id, task_type);
CREATE INDEX IF NOT EXISTS idx_nq_status ON nightshift_queue (status)
    WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_nq_gmail_id ON nightshift_queue (gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_nq_expires  ON nightshift_queue (expires_at);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260325_create_copilot_artifacts_and_sessions.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: copilot_artifacts + copilot_action_sessions
-- Purpose:
--   Durable persistence for the shared copilot layer.
--
--   copilot_artifacts  — normalized artifact records (photos, docs, uploads) so
--                        follow-up questions can bind to "that screenshot" across
--                        channels and after restarts.
--
--   copilot_action_sessions — persisted pending action state (PO send, approval,
--                             review) that previously lived in in-memory Maps.
--                             Survives pm2 restart; stale sessions expire via TTL.
--
-- Created: 2026-03-25

-- ── copilot_artifacts ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS copilot_artifacts (
    artifact_id     TEXT        PRIMARY KEY,
    thread_id       TEXT        NOT NULL,
    channel         TEXT        NOT NULL CHECK (channel IN ('telegram', 'dashboard')),
    source_type     TEXT        NOT NULL CHECK (source_type IN (
                                    'telegram_photo',
                                    'telegram_document',
                                    'dashboard_upload',
                                    'sandbox_drop'
                                )),
    filename        TEXT        NOT NULL,
    mime_type       TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'ready', 'expired')),
    raw_text        TEXT,
    summary         TEXT,
    structured_data JSONB,
    tags            TEXT[],
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_copilot_artifacts_thread
    ON copilot_artifacts (thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copilot_artifacts_channel_created
    ON copilot_artifacts (channel, created_at DESC);

ALTER TABLE copilot_artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON copilot_artifacts
    USING (true) WITH CHECK (true);

COMMENT ON TABLE copilot_artifacts IS
    'Normalized artifact records (photos, documents, uploads) for shared copilot context. '
    'Follow-up questions bind to the most recent artifact for their thread.';

-- ── copilot_action_sessions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS copilot_action_sessions (
    session_id          TEXT        PRIMARY KEY,
    channel             TEXT        NOT NULL CHECK (channel IN ('telegram', 'dashboard')),
    action_type         TEXT        NOT NULL,   -- 'po_send' | 'po_review' | 'reconcile_approve' | ...
    payload             JSONB       NOT NULL,   -- Full serialized action state
    status              TEXT        NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
    telegram_message_id INTEGER,               -- Telegram message ID for the pending prompt
    telegram_chat_id    TEXT,                  -- Chat ID to send recovery messages to
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL   -- Caller sets; typically created_at + 1-48h
);

CREATE INDEX IF NOT EXISTS idx_copilot_sessions_status_expires
    ON copilot_action_sessions (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_copilot_sessions_channel
    ON copilot_action_sessions (channel, created_at DESC);

ALTER TABLE copilot_action_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON copilot_action_sessions
    USING (true) WITH CHECK (true);

COMMENT ON TABLE copilot_action_sessions IS
    'Durable pending action sessions (PO send/review, reconciliation approval). '
    'Replaces in-memory Maps in po-sender.ts and reconciler.ts. Survives pm2 restart.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260325_ap_inbox_queue_add_pdf_hash.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add pdf_content_hash to ap_inbox_queue for content-based dedup
-- Created: 2026-03-25
-- Purpose: Some vendors (e.g. Abel's ACE) send identical PDFs in separate emails
--          with different subjects or invoice numbers. Filename+subject dedup is
--          insufficient — hash the actual PDF bytes to catch true duplicates.
ALTER TABLE ap_inbox_queue
    ADD COLUMN IF NOT EXISTS pdf_content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_ap_inbox_queue_hash
    ON ap_inbox_queue (email_from, pdf_content_hash)
    WHERE pdf_content_hash IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260401_create_statement_reconciliation_framework.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create statement reconciliation framework tables
-- Created: 2026-04-01
-- Purpose: Durable intake queue + run history for on-demand vendor statement reconciliation.

CREATE TABLE IF NOT EXISTS statement_intake_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('email_statement', 'download_statement')),
    source_ref TEXT NOT NULL,
    artifact_path TEXT,
    artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('pdf', 'csv', 'none')),
    statement_date DATE,
    period_start DATE,
    period_end DATE,
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'processing', 'reconciled', 'needs_review', 'error', 'ignored')),
    adapter_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    queued_by TEXT NOT NULL,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_intake_queue_fingerprint
    ON statement_intake_queue (fingerprint);

CREATE INDEX IF NOT EXISTS idx_statement_intake_queue_status
    ON statement_intake_queue (status, discovered_at DESC);

CREATE INDEX IF NOT EXISTS idx_statement_intake_queue_vendor
    ON statement_intake_queue (vendor_name, discovered_at DESC);

CREATE TABLE IF NOT EXISTS statement_reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intake_id UUID NOT NULL REFERENCES statement_intake_queue(id) ON DELETE CASCADE,
    vendor_name TEXT NOT NULL,
    adapter_key TEXT NOT NULL,
    run_status TEXT NOT NULL DEFAULT 'queued'
        CHECK (run_status IN ('queued', 'processing', 'completed', 'needs_review', 'error')),
    trigger_source TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    normalized_statement_json JSONB,
    results_json JSONB,
    matched_count INTEGER NOT NULL DEFAULT 0,
    missing_count INTEGER NOT NULL DEFAULT 0,
    mismatch_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    needs_review_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statement_reconciliation_runs_status
    ON statement_reconciliation_runs (run_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_statement_reconciliation_runs_intake
    ON statement_reconciliation_runs (intake_id, created_at DESC);

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'statement_artifacts',
    'statement_artifacts',
    false,
    20971520,
    ARRAY ['application/pdf', 'text/csv', 'application/csv']
) ON CONFLICT (id) DO UPDATE
SET allowed_mime_types = ARRAY ['application/pdf', 'text/csv', 'application/csv'];

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260402_create_shipments.sql
-- ════════════════════════════════════════════════════════════════

create table if not exists public.shipments (
    id text primary key,
    tracking_key text not null unique,
    tracking_number text not null,
    normalized_tracking_number text not null,
    carrier_name text,
    carrier_key text,
    tracking_kind text not null default 'unknown',
    po_numbers text[] not null default '{}',
    vendor_names text[] not null default '{}',
    status_category text,
    status_display text,
    public_tracking_url text,
    estimated_delivery_at timestamptz,
    delivered_at timestamptz,
    last_checked_at timestamptz,
    last_source text,
    source_confidence numeric,
    source_refs jsonb not null default '[]'::jsonb,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists shipments_po_numbers_gin_idx
    on public.shipments using gin (po_numbers);

create index if not exists shipments_status_category_idx
    on public.shipments (status_category);

create index if not exists shipments_active_updated_idx
    on public.shipments (active, updated_at desc);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260407_create_purchasing_snapshots.sql
-- ════════════════════════════════════════════════════════════════

-- purchasing_snapshots: Persisted snapshots of scraped dashboard + assessed purchases
-- One row per automated run (9 AM Mon-Fri cron) or manual /scrape_purchasing trigger.
-- Stores raw scraped data, assessed items, purchase requests, and diff summary.

CREATE TABLE purchasing_snapshots (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at     timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  source           text NOT NULL DEFAULT 'cron',              -- 'cron' or 'manual'
  triggered_by     text,                                       -- who triggered (user_id, 'cron', etc.)
  
  -- Raw scraped data (full fidelity)
  raw_purchases     jsonb NOT NULL DEFAULT '{}',              -- purchases-data.json content
  raw_requests      jsonb NOT NULL DEFAULT '{}',              -- purchase-requests.json content (filtered to Pending)
  
  -- Assessed results (computed)
  assessed_items    jsonb NOT NULL DEFAULT '{}',              -- array of assessed items with necessity levels
  high_need_count   integer NOT NULL DEFAULT 0,
  medium_count      integer NOT NULL DEFAULT 0,
  low_count         integer NOT NULL DEFAULT 0,
  noise_count       integer NOT NULL DEFAULT 0,
  
  -- Diff vs previous snapshot
  new_high_need_skus jsonb NOT NULL DEFAULT '[]',             -- array of SKU strings
  new_pending_requests jsonb NOT NULL DEFAULT '[]',           -- array of request details (date, details, quantity)
  
  -- Metadata
  duration_ms       integer,                                   -- total pipeline duration
  items_processed   integer NOT NULL DEFAULT 0,
  requests_processed integer NOT NULL DEFAULT 0
);

CREATE INDEX idx_purchasing_snapshots_generated_at ON purchasing_snapshots (generated_at DESC);
CREATE INDEX idx_purchasing_snapshots_source ON purchasing_snapshots (source);

COMMENT ON TABLE purchasing_snapshots IS 'Persisted snapshots of automated purchasing assessment runs. Used for diffing to detect new HIGH_NEED items and new Pending requests for Telegram alerts.';

-- Enable RLS (service role bypass)
ALTER TABLE purchasing_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON purchasing_snapshots
  USING (true) WITH CHECK (true);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260409000001_add_po_lifecycle_columns.sql
-- ════════════════════════════════════════════════════════════════

-- Add purchase_orders lifecycle and evidence columns
ALTER TABLE purchase_orders 
ADD COLUMN IF NOT EXISTS lifecycle_state TEXT,
ADD COLUMN IF NOT EXISTS evidence JSONB;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260409000002_correct_po_lifecycle_columns.sql
-- ════════════════════════════════════════════════════════════════

-- Corrections: Remove extra default and index from evidence column
ALTER TABLE purchase_orders ALTER COLUMN evidence DROP DEFAULT;
DROP INDEX IF EXISTS idx_purchase_orders_lifecycle_state;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260409000003_fix_po_lifecycle_columns.sql
-- ════════════════════════════════════════════════════════════════

-- Drop incorrect columns
ALTER TABLE "public"."purchase_orders" 
DROP COLUMN IF EXISTS "lifecycle_state",
DROP COLUMN IF EXISTS "evidence";

-- Add correct columns
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "lifecycle_stage" TEXT,
ADD COLUMN IF NOT EXISTS "draft_created_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "committed_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "po_sent_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "po_email_message_id" TEXT,
ADD COLUMN IF NOT EXISTS "vendor_acknowledged_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "vendor_ack_source" TEXT,
ADD COLUMN IF NOT EXISTS "shipping_evidence" JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS "tracking_status_summary" TEXT,
ADD COLUMN IF NOT EXISTS "tracking_unavailable_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "tracking_requested_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "tracking_request_count" INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS "last_tracking_evidence_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "last_movement_update_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "last_movement_summary" TEXT;

-- Add indexes
CREATE INDEX IF NOT EXISTS "idx_po_lifecycle_stage" ON "public"."purchase_orders" ("lifecycle_stage");
CREATE INDEX IF NOT EXISTS "idx_po_tracking_requested_at" ON "public"."purchase_orders" ("tracking_requested_at");
CREATE INDEX IF NOT EXISTS "idx_po_vendor_acknowledged_at" ON "public"."purchase_orders" ("vendor_acknowledged_at");

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260410000001_add_human_reply_detection.sql
-- ════════════════════════════════════════════════════════════════

-- Add human_reply_detected_at to track when human manually responds to vendor
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "human_reply_detected_at" TIMESTAMPTZ;

COMMENT ON COLUMN "purchase_orders"."human_reply_detected_at" IS 'Timestamp when a human (Will) was detected replying to vendor. De-escalates follow-up flow.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260410000002_add_vendor_noncomm.sql
-- ════════════════════════════════════════════════════════════════

-- Add vendor_noncomm_at to track when a vendor was labeled non-communicative
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "vendor_noncomm_at" TIMESTAMPTZ;

COMMENT ON COLUMN "purchase_orders"."vendor_noncomm_at" IS 'Timestamp when vendor was labeled non-communicative after multiple unresponded follow-ups.';

-- Add vendor_noncomm flag to vendor_profiles for tracking problematic vendors
ALTER TABLE "public"."vendor_profiles"
ADD COLUMN IF NOT EXISTS "is_noncomm" BOOLEAN DEFAULT false;

COMMENT ON COLUMN "vendor_profiles"."is_noncomm" IS 'True if vendor consistently fails to respond to follow-ups.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260410000003_add_needs_human_review.sql
-- ════════════════════════════════════════════════════════════════

-- Add needs_human_review flag for vendor replies that need manual handling
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "needs_human_review" BOOLEAN DEFAULT false;

COMMENT ON COLUMN "purchase_orders"."needs_human_review" IS 'True when vendor reply needs human review (unclear tracking, partial info, etc.).';

COMMENT ON COLUMN "purchase_orders"."needs_human_review" IS 'True when vendor reply needs human review (unclear tracking, partial info, etc.).';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260410000004_add_intended_multi_flag.sql
-- ════════════════════════════════════════════════════════════════

-- Add is_intended_multi to distinguish between scheduled/blanket POs and accidental partials
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "is_intended_multi" BOOLEAN DEFAULT false;

COMMENT ON COLUMN "purchase_orders"."is_intended_multi" IS 'True if the PO is intended to be delivered in multiple stages (Blanket PO, Quarterly Buy, etc.)';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260410000005_add_lifecycle_transitions.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add lifecycle_transitions JSONB column for append-only PO state history
-- Created: 2026-04-10
-- Purpose: Replace single-text last_movement_summary with an append-only audit trail
--          of every lifecycle state transition the PO goes through.

ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "lifecycle_transitions" JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_po_lifecycle_transitions
ON "public"."purchase_orders" USING GIN (lifecycle_transitions);

COMMENT ON COLUMN "public"."purchase_orders"."lifecycle_transitions" IS
'Append-only audit trail of lifecycle state transitions. Each entry: { at: timestamptz, from: string, to: string, trigger: string, detail: string }';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260410000006_add_vendor_domains.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add vendor_domains column for multi-domain vendor tracking
-- Created: 2026-04-10
-- Purpose: Enables outside-thread email search to check ALL known vendor domains,
--          not just the single domain from the PO To: header. Vendors like
--          Amazon sometimes use multiple domains (e.g., orders@ vs shipments@).

ALTER TABLE "public"."vendor_profiles"
ADD COLUMN IF NOT EXISTS "vendor_domains" TEXT[] DEFAULT '{}'::TEXT[];

CREATE INDEX IF NOT EXISTS idx_vendor_profiles_domains
ON "public"."vendor_profiles" USING GIN (vendor_domains);

COMMENT ON COLUMN "public"."vendor_profiles"."vendor_domains" IS
'Known email domains for this vendor. Used for multi-domain outside-thread email search.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260415_create_ops_control_plane.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create Supabase ops control plane for AP reliability
-- Created: 2026-04-15
-- Purpose: Add durable bot heartbeats, restart/control requests, alert dedupe,
--          and a health summary view so Supabase can act as the operational
--          control plane for AP/nightshift reliability.
-- Rollback:
--   DROP VIEW IF EXISTS public.ops_health_summary;
--   DROP TRIGGER IF EXISTS trg_ops_exception_signal ON public.ops_agent_exceptions;
--   DROP FUNCTION IF EXISTS public.signal_ops_exception();
--   DROP TABLE IF EXISTS public.ops_alert_events;
--   DROP TABLE IF EXISTS public.ops_control_requests;
--   DROP TABLE IF EXISTS public.agent_heartbeats;
--   DROP TABLE IF EXISTS public.cron_runs;
--
-- DECISION(2026-04-15): Use additive, table-backed control requests first rather
-- than replacing existing AP queue tables. This keeps rollback simple while still
-- giving Supabase a durable restart/control surface.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.cron_runs (
    id            BIGSERIAL PRIMARY KEY,
    task_name     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    duration_ms   INTEGER,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_task_started
    ON public.cron_runs (task_name, started_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_heartbeats (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name   TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'healthy'
                     CHECK (status IN ('healthy', 'degraded', 'starting', 'stopped')),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_heartbeat
    ON public.agent_heartbeats (heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS public.ops_control_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    command      TEXT NOT NULL
                     CHECK (command IN ('restart_bot', 'run_ap_poll_now', 'run_nightshift_now', 'clear_stuck_processing')),
    target       TEXT NOT NULL DEFAULT 'all'
                     CHECK (target IN ('aria-bot', 'watchdog', 'all')),
    status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled')),
    requested_by TEXT NOT NULL,
    reason       TEXT,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    claimed_at   TIMESTAMPTZ,
    claimed_by   TEXT,
    completed_at TIMESTAMPTZ,
    result       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_control_requests_status_target
    ON public.ops_control_requests (status, target, created_at);

CREATE TABLE IF NOT EXISTS public.ops_alert_events (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_key  TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'sent'
                   CHECK (status IN ('sent', 'suppressed', 'failed')),
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_alert_events_key_created
    ON public.ops_alert_events (alert_key, created_at DESC);

CREATE OR REPLACE FUNCTION public.signal_ops_exception()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    alert_key TEXT;
BEGIN
    IF NEW.status = 'pending' THEN
        alert_key := 'ops_exception:' || COALESCE(NEW.agent_name, 'unknown') || ':' || TO_CHAR(DATE_TRUNC('hour', NOW()), 'YYYYMMDDHH24');
        INSERT INTO public.ops_alert_events (alert_key, alert_type, status, payload)
        VALUES (
            alert_key,
            'ops_exception',
            'suppressed',
            jsonb_build_object(
                'agent_name', NEW.agent_name,
                'error_message', NEW.error_message,
                'context_data', COALESCE(NEW.context_data, '{}'::jsonb)
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ops_exception_signal ON public.ops_agent_exceptions;
CREATE TRIGGER trg_ops_exception_signal
AFTER INSERT ON public.ops_agent_exceptions
FOR EACH ROW
EXECUTE FUNCTION public.signal_ops_exception();

CREATE OR REPLACE VIEW public.ops_health_summary AS
WITH now_ref AS (
    SELECT NOW() AS now_utc
),
latest_bot AS (
    SELECT heartbeat_at, status, metadata
    FROM public.agent_heartbeats
    WHERE agent_name = 'aria-bot'
    LIMIT 1
),
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('APPolling'::TEXT, INTERVAL '20 minutes')
    ) AS thresholds(task_name, stale_after)
),
latest_crons AS (
    SELECT task_name, MAX(started_at) AS last_started_at
    FROM public.cron_runs
    GROUP BY task_name
),
stale_crons AS (
    SELECT COALESCE(jsonb_agg(t.task_name ORDER BY t.task_name), '[]'::jsonb) AS names
    FROM cron_thresholds t
    LEFT JOIN latest_crons c
        ON c.task_name = t.task_name
    CROSS JOIN now_ref n
    WHERE c.last_started_at IS NULL
       OR c.last_started_at < (n.now_utc - t.stale_after)
),
ap_email_queue AS (
    SELECT MIN(created_at) AS oldest_pending_at
    FROM public.email_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status IN ('unprocessed', 'processing')
),
ap_forward_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status NOT IN ('FORWARDED', 'ERROR_FORWARDING', 'ERROR_PROCESSING')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'PROCESSING_FORWARD'
              AND updated_at < NOW() - INTERVAL '20 minutes'
        ) AS stuck_processing_count
    FROM public.ap_inbox_queue
),
nightshift_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'processing'
              AND updated_at < NOW() - INTERVAL '10 minutes'
        ) AS stuck_processing_count,
        MAX(processed_at) FILTER (
            WHERE status = 'completed'
              AND task_type IN ('email_classification', 'default_inbox_invoice')
        ) AS last_completed_at
    FROM public.nightshift_queue
),
pending_exceptions AS (
    SELECT COUNT(*) AS pending_count
    FROM public.ops_agent_exceptions
    WHERE status = 'pending'
),
last_ap_forward AS (
    SELECT MAX(updated_at) AS last_forwarded_at
    FROM public.ap_inbox_queue
    WHERE status = 'FORWARDED'
),
merged_backlog AS (
    SELECT
        CASE
            WHEN e.oldest_pending_at IS NULL THEN f.oldest_pending_at
            WHEN f.oldest_pending_at IS NULL THEN e.oldest_pending_at
            ELSE LEAST(e.oldest_pending_at, f.oldest_pending_at)
        END AS oldest_ap_backlog_at
    FROM ap_email_queue e
    CROSS JOIN ap_forward_queue f
)
SELECT
    NOW() AS generated_at,
    lb.heartbeat_at AS bot_heartbeat_at,
    CASE
        WHEN lb.heartbeat_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - lb.heartbeat_at)) / 60.0)::numeric, 1)
    END AS bot_heartbeat_age_minutes,
    COALESCE(sc.names, '[]'::jsonb) AS stale_crons,
    jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) AS stale_cron_count,
    mb.oldest_ap_backlog_at AS ap_queue_backlog_at,
    CASE
        WHEN mb.oldest_ap_backlog_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - mb.oldest_ap_backlog_at)) / 60.0)::numeric, 1)
    END AS ap_queue_backlog_age_minutes,
    COALESCE(afq.stuck_processing_count, 0) AS ap_processing_stuck_count,
    nq.oldest_pending_at AS nightshift_queue_backlog_at,
    CASE
        WHEN nq.oldest_pending_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.oldest_pending_at)) / 60.0)::numeric, 1)
    END AS nightshift_queue_backlog_age_minutes,
    COALESCE(nq.stuck_processing_count, 0) AS nightshift_processing_stuck_count,
    COALESCE(pe.pending_count, 0) AS pending_exception_count,
    laf.last_forwarded_at AS last_ap_forward_at,
    CASE
        WHEN laf.last_forwarded_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - laf.last_forwarded_at)) / 60.0)::numeric, 1)
    END AS last_ap_forward_age_minutes,
    nq.last_completed_at AS last_nightshift_completion_at,
    CASE
        WHEN nq.last_completed_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.last_completed_at)) / 60.0)::numeric, 1)
    END AS last_nightshift_completion_age_minutes,
    CASE
        WHEN jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) > 0
          OR COALESCE(afq.stuck_processing_count, 0) > 0
          OR COALESCE(nq.stuck_processing_count, 0) > 0
          OR COALESCE(pe.pending_count, 0) > 0
          OR (
              lb.heartbeat_at IS NOT NULL
              AND lb.heartbeat_at < NOW() - INTERVAL '10 minutes'
          )
          OR (
              mb.oldest_ap_backlog_at IS NOT NULL
              AND mb.oldest_ap_backlog_at < NOW() - INTERVAL '30 minutes'
          )
          OR (
              nq.oldest_pending_at IS NOT NULL
              AND nq.oldest_pending_at < NOW() - INTERVAL '60 minutes'
          )
        THEN 'degraded'
        ELSE 'healthy'
    END AS health_status
FROM latest_bot lb
FULL OUTER JOIN stale_crons sc ON TRUE
CROSS JOIN ap_forward_queue afq
CROSS JOIN nightshift_queue nq
CROSS JOIN pending_exceptions pe
CROSS JOIN last_ap_forward laf
CROSS JOIN merged_backlog mb;

COMMENT ON VIEW public.ops_health_summary IS
'Single-row ops control-plane health summary for AP/nightshift reliability, used by Supabase alerting and the local watchdog.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260415_create_vendor_case_multipliers.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vendor_case_multipliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_pattern TEXT NOT NULL,
  sku_pattern TEXT,                    -- null = applies to all SKUs from vendor
  multiplier NUMERIC NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vcm_vendor_sku 
  ON vendor_case_multipliers(vendor_pattern, COALESCE(sku_pattern, ''));

INSERT INTO vendor_case_multipliers (vendor_pattern, sku_pattern, multiplier, notes)
VALUES 
  ('teraganix', 'EM102', 12, 'EM-1 32oz case of 12'),
  ('teraganix', 'EM108', 12, 'EM-1 16oz case of 12'),
  ('teraganix', 'EM103', 4,  'EM-1 1 gallon case of 4'),
  ('teraganix', 'EM105', 1,  'EM-1 5 gallon each')
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260415_fix_ops_health_and_schedule.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Fix ops health backlog detection and schedule ops-health-check
-- Created: 2026-04-15
-- Purpose:
--   1. Only count truly active AP/nightshift backlog in ops_health_summary.
--   2. Add a Vault-backed pg_cron job that invokes the deployed ops-health-check
--      Edge Function every 5 minutes when the required secrets are present.
-- Notes:
--   - This migration expects Vault secrets named:
--       * ops_health_check_url
--       * ops_health_check_bearer
--   - If those secrets are absent, the invoke function is still created but the
--     cron job is skipped until the secrets are added and the migration logic
--     is re-run (or the schedule block is applied manually).

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_ops_health_check()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    function_url TEXT;
    auth_token   TEXT;
    request_id   BIGINT;
BEGIN
    SELECT decrypted_secret
      INTO function_url
      FROM vault.decrypted_secrets
     WHERE name = 'ops_health_check_url'
     ORDER BY updated_at DESC
     LIMIT 1;

    SELECT decrypted_secret
      INTO auth_token
      FROM vault.decrypted_secrets
     WHERE name = 'ops_health_check_bearer'
     ORDER BY updated_at DESC
     LIMIT 1;

    IF function_url IS NULL OR function_url = '' THEN
        RAISE EXCEPTION 'Missing Vault secret: ops_health_check_url';
    END IF;

    IF auth_token IS NULL OR auth_token = '' THEN
        RAISE EXCEPTION 'Missing Vault secret: ops_health_check_bearer';
    END IF;

    SELECT net.http_post(
        url := function_url,
        body := jsonb_build_object('triggered_at', NOW()::text),
        params := '{}'::jsonb,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || auth_token
        ),
        timeout_milliseconds := 5000
    )
    INTO request_id;

    RETURN request_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_ops_health_check() IS
'Vault-backed pg_net wrapper used by pg_cron to invoke the ops-health-check Edge Function.';

CREATE OR REPLACE VIEW public.ops_health_summary AS
WITH now_ref AS (
    SELECT NOW() AS now_utc
),
latest_bot AS (
    SELECT heartbeat_at
    FROM public.agent_heartbeats
    WHERE agent_name = 'aria-bot'
    ORDER BY heartbeat_at DESC
    LIMIT 1
),
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('APPolling',           INTERVAL '25 minutes'),
            ('SlackETASync',        INTERVAL '3 hours'),
            ('POSync',              INTERVAL '45 minutes'),
            ('POSweep',             INTERVAL '6 hours'),
            ('UlineConfirmationSync', INTERVAL '25 minutes'),
            ('POReceivingWatcher',  INTERVAL '45 minutes'),
            ('PurchasingCalendarSync', INTERVAL '6 hours'),
            ('DailySummary',        INTERVAL '36 hours'),
            ('WeeklySummary',       INTERVAL '8 days'),
            ('ReconcileAxiom',      INTERVAL '36 hours'),
            ('ReconcileFedEx',      INTERVAL '36 hours'),
            ('ReconcileTeraGanix',  INTERVAL '36 hours'),
            ('ReconcileULINE',      INTERVAL '36 hours'),
            ('BuildCompletionWatcher', INTERVAL '45 minutes'),
            ('BuildRisk',           INTERVAL '36 hours'),
            ('NightshiftEnqueue',   INTERVAL '36 hours'),
            ('Housekeeping',        INTERVAL '36 hours'),
            ('StatIndexing',        INTERVAL '90 minutes')
    ) AS t(task_name, stale_after)
),
latest_crons AS (
    SELECT task_name, MAX(started_at) AS last_started_at
    FROM public.cron_runs
    GROUP BY task_name
),
stale_crons AS (
    SELECT COALESCE(jsonb_agg(t.task_name ORDER BY t.task_name), '[]'::jsonb) AS names
    FROM cron_thresholds t
    LEFT JOIN latest_crons c
        ON c.task_name = t.task_name
    CROSS JOIN now_ref n
    WHERE c.last_started_at IS NULL
       OR c.last_started_at < (n.now_utc - t.stale_after)
),
ap_email_queue AS (
    SELECT MIN(created_at) AS oldest_pending_at
    FROM public.email_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status IN ('unprocessed', 'processing')
      AND COALESCE(processed_by_ap, FALSE) = FALSE
),
ap_forward_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status IN ('PENDING_FORWARD', 'PROCESSING_FORWARD')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status = 'PROCESSING_FORWARD'
              AND updated_at < NOW() - INTERVAL '20 minutes'
        ) AS stuck_processing_count
    FROM public.ap_inbox_queue
),
nightshift_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
              AND (expires_at IS NULL OR expires_at >= NOW())
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'processing'
              AND (expires_at IS NULL OR expires_at >= NOW())
              AND updated_at < NOW() - INTERVAL '10 minutes'
        ) AS stuck_processing_count,
        MAX(processed_at) FILTER (
            WHERE status = 'completed'
              AND task_type IN ('email_classification', 'default_inbox_invoice')
        ) AS last_completed_at
    FROM public.nightshift_queue
),
pending_exceptions AS (
    SELECT COUNT(*) AS pending_count
    FROM public.ops_agent_exceptions
    WHERE status = 'pending'
),
last_ap_forward AS (
    SELECT MAX(updated_at) AS last_forwarded_at
    FROM public.ap_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status = 'FORWARDED'
),
merged_backlog AS (
    SELECT
        CASE
            WHEN e.oldest_pending_at IS NULL THEN f.oldest_pending_at
            WHEN f.oldest_pending_at IS NULL THEN e.oldest_pending_at
            ELSE LEAST(e.oldest_pending_at, f.oldest_pending_at)
        END AS oldest_ap_backlog_at
    FROM ap_email_queue e
    CROSS JOIN ap_forward_queue f
)
SELECT
    NOW() AS generated_at,
    lb.heartbeat_at AS bot_heartbeat_at,
    CASE
        WHEN lb.heartbeat_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - lb.heartbeat_at)) / 60.0)::numeric, 1)
    END AS bot_heartbeat_age_minutes,
    COALESCE(sc.names, '[]'::jsonb) AS stale_crons,
    jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) AS stale_cron_count,
    mb.oldest_ap_backlog_at AS ap_queue_backlog_at,
    CASE
        WHEN mb.oldest_ap_backlog_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - mb.oldest_ap_backlog_at)) / 60.0)::numeric, 1)
    END AS ap_queue_backlog_age_minutes,
    COALESCE(afq.stuck_processing_count, 0) AS ap_processing_stuck_count,
    nq.oldest_pending_at AS nightshift_queue_backlog_at,
    CASE
        WHEN nq.oldest_pending_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.oldest_pending_at)) / 60.0)::numeric, 1)
    END AS nightshift_queue_backlog_age_minutes,
    COALESCE(nq.stuck_processing_count, 0) AS nightshift_processing_stuck_count,
    COALESCE(pe.pending_count, 0) AS pending_exception_count,
    laf.last_forwarded_at AS last_ap_forward_at,
    CASE
        WHEN laf.last_forwarded_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - laf.last_forwarded_at)) / 60.0)::numeric, 1)
    END AS last_ap_forward_age_minutes,
    nq.last_completed_at AS last_nightshift_completion_at,
    CASE
        WHEN nq.last_completed_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.last_completed_at)) / 60.0)::numeric, 1)
    END AS last_nightshift_completion_age_minutes,
    CASE
        WHEN jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) > 0
          OR COALESCE(afq.stuck_processing_count, 0) > 0
          OR COALESCE(nq.stuck_processing_count, 0) > 0
          OR COALESCE(pe.pending_count, 0) > 0
          OR (
              lb.heartbeat_at IS NOT NULL
              AND lb.heartbeat_at < NOW() - INTERVAL '10 minutes'
          )
          OR (
              mb.oldest_ap_backlog_at IS NOT NULL
              AND mb.oldest_ap_backlog_at < NOW() - INTERVAL '30 minutes'
          )
          OR (
              nq.oldest_pending_at IS NOT NULL
              AND nq.oldest_pending_at < NOW() - INTERVAL '60 minutes'
          )
        THEN 'degraded'
        ELSE 'healthy'
    END AS health_status
FROM latest_bot lb
FULL OUTER JOIN stale_crons sc ON TRUE
CROSS JOIN ap_forward_queue afq
CROSS JOIN nightshift_queue nq
CROSS JOIN pending_exceptions pe
CROSS JOIN last_ap_forward laf
CROSS JOIN merged_backlog mb;

DO $$
DECLARE
    existing_job_id BIGINT;
    has_url_secret BOOLEAN;
    has_bearer_secret BOOLEAN;
BEGIN
    SELECT jobid
      INTO existing_job_id
      FROM cron.job
     WHERE jobname = 'ops-health-check-every-5-minutes'
     LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
        PERFORM cron.unschedule(existing_job_id);
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ops_health_check_url'
    ) INTO has_url_secret;

    SELECT EXISTS(
        SELECT 1 FROM vault.decrypted_secrets WHERE name = 'ops_health_check_bearer'
    ) INTO has_bearer_secret;

    IF has_url_secret AND has_bearer_secret THEN
        PERFORM cron.schedule(
            'ops-health-check-every-5-minutes',
            '*/5 * * * *',
            'SELECT public.invoke_ops_health_check();'
        );
    ELSE
        RAISE NOTICE 'Skipping ops-health-check schedule; missing Vault secrets ops_health_check_url and/or ops_health_check_bearer';
    END IF;
END
$$;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260416_fix_stale_cron_alerts.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Fix false-positive stale cron alerts
-- Created: 2026-04-16
-- Purpose:
--   1. Remove phantom crons (SlackETASync, UlineConfirmationSync) that no longer
--      exist in ops-manager.ts but were still monitored.
--   2. Only monitor high-frequency "always running" crons (APPolling, POSync,
--      BuildCompletionWatcher, POReceivingWatcher, StatIndexing).
--      Once-daily/weekly crons (DailySummary, BuildRisk, etc.) should NOT trigger
--      staleness alerts — they only run during narrow time windows and will always
--      appear stale outside those windows.

CREATE OR REPLACE VIEW public.ops_health_summary AS
WITH now_ref AS (
    SELECT NOW() AS now_utc
),
latest_bot AS (
    SELECT heartbeat_at
    FROM public.agent_heartbeats
    WHERE agent_name = 'aria-bot'
    ORDER BY heartbeat_at DESC
    LIMIT 1
),
-- Only monitor crons that run frequently enough that staleness = something broke.
-- Once-daily/weekly crons are NOT included — they legitimately go 20+ hours between runs.
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('APPolling',              INTERVAL '25 minutes'),
            ('POSync',                 INTERVAL '45 minutes'),
            ('BuildCompletionWatcher', INTERVAL '45 minutes'),
            ('POReceivingWatcher',     INTERVAL '45 minutes'),
            ('StatIndexing',           INTERVAL '90 minutes'),
            ('POSweep',                INTERVAL '6 hours'),
            ('PurchasingCalendarSync', INTERVAL '6 hours')
    ) AS t(task_name, stale_after)
),
latest_crons AS (
    SELECT task_name, MAX(started_at) AS last_started_at
    FROM public.cron_runs
    GROUP BY task_name
),
stale_crons AS (
    SELECT COALESCE(jsonb_agg(t.task_name ORDER BY t.task_name), '[]'::jsonb) AS names
    FROM cron_thresholds t
    LEFT JOIN latest_crons c
        ON c.task_name = t.task_name
    CROSS JOIN now_ref n
    WHERE c.last_started_at IS NULL
       OR c.last_started_at < (n.now_utc - t.stale_after)
),
ap_email_queue AS (
    SELECT MIN(created_at) AS oldest_pending_at
    FROM public.email_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status IN ('unprocessed', 'processing')
      AND COALESCE(processed_by_ap, FALSE) = FALSE
),
ap_forward_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status IN ('PENDING_FORWARD', 'PROCESSING_FORWARD')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status = 'PROCESSING_FORWARD'
              AND updated_at < NOW() - INTERVAL '20 minutes'
        ) AS stuck_processing_count
    FROM public.ap_inbox_queue
),
nightshift_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
              AND (expires_at IS NULL OR expires_at >= NOW())
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'processing'
              AND (expires_at IS NULL OR expires_at >= NOW())
              AND updated_at < NOW() - INTERVAL '10 minutes'
        ) AS stuck_processing_count,
        MAX(processed_at) FILTER (
            WHERE status = 'completed'
              AND task_type IN ('email_classification', 'default_inbox_invoice')
        ) AS last_completed_at
    FROM public.nightshift_queue
),
pending_exceptions AS (
    SELECT COUNT(*) AS pending_count
    FROM public.ops_agent_exceptions
    WHERE status = 'pending'
),
last_ap_forward AS (
    SELECT MAX(updated_at) AS last_forwarded_at
    FROM public.ap_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status = 'FORWARDED'
),
merged_backlog AS (
    SELECT
        CASE
            WHEN e.oldest_pending_at IS NULL THEN f.oldest_pending_at
            WHEN f.oldest_pending_at IS NULL THEN e.oldest_pending_at
            ELSE LEAST(e.oldest_pending_at, f.oldest_pending_at)
        END AS oldest_ap_backlog_at
    FROM ap_email_queue e
    CROSS JOIN ap_forward_queue f
)
SELECT
    NOW() AS generated_at,
    lb.heartbeat_at AS bot_heartbeat_at,
    CASE
        WHEN lb.heartbeat_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - lb.heartbeat_at)) / 60.0)::numeric, 1)
    END AS bot_heartbeat_age_minutes,
    COALESCE(sc.names, '[]'::jsonb) AS stale_crons,
    jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) AS stale_cron_count,
    mb.oldest_ap_backlog_at AS ap_queue_backlog_at,
    CASE
        WHEN mb.oldest_ap_backlog_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - mb.oldest_ap_backlog_at)) / 60.0)::numeric, 1)
    END AS ap_queue_backlog_age_minutes,
    COALESCE(afq.stuck_processing_count, 0) AS ap_processing_stuck_count,
    nq.oldest_pending_at AS nightshift_queue_backlog_at,
    CASE
        WHEN nq.oldest_pending_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.oldest_pending_at)) / 60.0)::numeric, 1)
    END AS nightshift_queue_backlog_age_minutes,
    COALESCE(nq.stuck_processing_count, 0) AS nightshift_processing_stuck_count,
    COALESCE(pe.pending_count, 0) AS pending_exception_count,
    laf.last_forwarded_at AS last_ap_forward_at,
    CASE
        WHEN laf.last_forwarded_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - laf.last_forwarded_at)) / 60.0)::numeric, 1)
    END AS last_ap_forward_age_minutes,
    nq.last_completed_at AS last_nightshift_completion_at,
    CASE
        WHEN nq.last_completed_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.last_completed_at)) / 60.0)::numeric, 1)
    END AS last_nightshift_completion_age_minutes,
    CASE
        WHEN jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) > 0
          OR COALESCE(afq.stuck_processing_count, 0) > 0
          OR COALESCE(nq.stuck_processing_count, 0) > 0
          OR COALESCE(pe.pending_count, 0) > 0
          OR (
              lb.heartbeat_at IS NOT NULL
              AND lb.heartbeat_at < NOW() - INTERVAL '10 minutes'
          )
          OR (
              mb.oldest_ap_backlog_at IS NOT NULL
              AND mb.oldest_ap_backlog_at < NOW() - INTERVAL '30 minutes'
          )
          OR (
              nq.oldest_pending_at IS NOT NULL
              AND nq.oldest_pending_at < NOW() - INTERVAL '60 minutes'
          )
        THEN 'degraded'
        ELSE 'healthy'
    END AS health_status
FROM latest_bot lb
FULL OUTER JOIN stale_crons sc ON TRUE
CROSS JOIN ap_forward_queue afq
CROSS JOIN nightshift_queue nq
CROSS JOIN pending_exceptions pe
CROSS JOIN last_ap_forward laf
CROSS JOIN merged_backlog mb;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260417_create_agent_heartbeats.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Reconcile agent_heartbeats with the live 0415 schema
-- Original 2026-04-17: this file used to CREATE TABLE IF NOT EXISTS agent_heartbeats
-- with a divergent schema (last_heartbeat_at TIMESTAMPTZ, current_task TEXT,
-- metrics JSONB, status enum HEALTHY|DEGRADED|DOWN|UNKNOWN). The live schema is
-- defined in 20260415_create_ops_control_plane.sql:
--   id UUID, agent_name TEXT UNIQUE, status TEXT (healthy|degraded|starting|stopped),
--   heartbeat_at TIMESTAMPTZ, metadata JSONB, created_at, updated_at.
--
-- Production code uses the 0415 shape (see src/lib/intelligence/oversight-agent.ts:54-65).
-- Migrations run in lexicographic order, so 0415 always wins on a real deploy. But
-- because both files used CREATE TABLE IF NOT EXISTS, applying 0417 alone to a
-- fresh DB (e.g. via `supabase db reset` against an isolated environment) would
-- silently produce the wrong shape and break OversightAgent.
--
-- This migration is now an ALTER no-op against the 0415 schema. It only adds the
-- two indexes that the original 0417 added (status + agent_name) — the table
-- itself is left to 0415 to define.

ALTER TABLE public.agent_heartbeats
    ALTER COLUMN status SET DEFAULT 'healthy';

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_status
    ON public.agent_heartbeats(status);

CREATE INDEX IF NOT EXISTS idx_agent_heartbeats_agent_name
    ON public.agent_heartbeats(agent_name);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260417_create_skills.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]',
  confidence NUMERIC(5,4) DEFAULT 1.0,
  times_invoked INTEGER DEFAULT 0,
  times_succeeded INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto', 'manual')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  rejection_feedback TEXT,
  archived BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_skills_review_status ON skills(review_status) WHERE archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_skills_agent_name ON skills(agent_name);
CREATE INDEX IF NOT EXISTS idx_skills_confidence ON skills(confidence) WHERE archived = FALSE;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260417_create_task_history.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS task_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'shadow')),
  skill_id UUID REFERENCES skills(id),
  execution_trace JSONB DEFAULT '[]',
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_history_agent_name ON task_history(agent_name);
CREATE INDEX IF NOT EXISTS idx_task_history_status ON task_history(status);
CREATE INDEX IF NOT EXISTS idx_task_history_created_at ON task_history(created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260421_create_memories.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260423_reconciliation_runs.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    invoices_found INT DEFAULT 0,
    invoices_processed INT DEFAULT 0,
    pos_updated INT DEFAULT 0,
    price_changes INT DEFAULT 0,
    freight_added_cents BIGINT DEFAULT 0,
    errors JSONB DEFAULT '[]'::jsonb,
    warnings JSONB DEFAULT '[]'::jsonb,
    summary TEXT,
    invoked_by TEXT DEFAULT 'manual' CHECK (invoked_by IN ('manual', 'cron', 'telegram')),
    run_args JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_recon_runs_vendor_started ON reconciliation_runs(vendor, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_runs_status ON reconciliation_runs(status) WHERE status IN ('running', 'failed', 'partial');

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260428_create_agent_task.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create agent_task hub for the Aria control plane
-- Created: 2026-04-28
-- Purpose: Single physical "ticket" table that every spoke (approvals, dropships,
--          PO sends, exceptions, control requests, failed cron runs) can link to
--          via (source_table, source_id). Powers the /dashboard/tasks page.
--
-- Phase 1 of the control plane plan (see .agents/plans/control-plane.md).
-- This migration is fully additive. No spoke writers are wired in this phase —
-- the hub is seeded once from the existing pending rows in 6 spoke tables, and
-- subsequent population happens in phase 2.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.agent_task;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Hub table ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_task (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type                TEXT NOT NULL
                            CHECK (type IN (
                                'cron_failure',
                                'approval',
                                'dropship_forward',
                                'po_send_confirm',
                                'agent_exception',
                                'control_command',
                                'manual',
                                'code_change'
                            )),
    source_table        TEXT,
    source_id           TEXT,
    goal                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN (
                                'PENDING',
                                'CLAIMED',
                                'RUNNING',
                                'NEEDS_APPROVAL',
                                'APPROVED',
                                'REJECTED',
                                'SUCCEEDED',
                                'FAILED',
                                'EXPIRED',
                                'CANCELLED'
                            )),
    owner               TEXT NOT NULL DEFAULT 'aria',
    priority            SMALLINT NOT NULL DEFAULT 2
                            CHECK (priority BETWEEN 0 AND 4),
    parent_task_id      UUID REFERENCES public.agent_task(id) ON DELETE SET NULL,
    requires_approval   BOOLEAN NOT NULL DEFAULT FALSE,
    approval_decision   TEXT
                            CHECK (approval_decision IS NULL OR approval_decision IN ('approve', 'reject')),
    approval_decided_by TEXT,
    approval_decided_at TIMESTAMPTZ,
    inputs              JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs             JSONB NOT NULL DEFAULT '{}'::jsonb,
    cost_cents          INTEGER NOT NULL DEFAULT 0,
    retry_count         SMALLINT NOT NULL DEFAULT 0,
    max_retries         SMALLINT NOT NULL DEFAULT 0,
    deadline_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at          TIMESTAMPTZ,
    claimed_by          TEXT,
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_task_open
    ON public.agent_task (status, priority, created_at DESC)
    WHERE status IN ('PENDING', 'CLAIMED', 'RUNNING', 'NEEDS_APPROVAL');

CREATE INDEX IF NOT EXISTS idx_agent_task_owner_status
    ON public.agent_task (owner, status);

CREATE INDEX IF NOT EXISTS idx_agent_task_source
    ON public.agent_task (source_table, source_id)
    WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_parent
    ON public.agent_task (parent_task_id)
    WHERE parent_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_type_created
    ON public.agent_task (type, created_at DESC);

-- Idempotency: a (source_table, source_id) pair can only spawn one hub row.
-- Spoke writers call upsert via (source_table, source_id); the partial unique
-- index makes that safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_task_source
    ON public.agent_task (source_table, source_id)
    WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_agent_task_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_task_set_updated_at ON public.agent_task;
CREATE TRIGGER trg_agent_task_set_updated_at
    BEFORE UPDATE ON public.agent_task
    FOR EACH ROW EXECUTE FUNCTION public.set_agent_task_updated_at();

-- ── One-time backfill ─────────────────────────────────────────────────────────
-- Each INSERT uses NOT EXISTS so re-running the migration is safe (the partial
-- unique index would refuse duplicates anyway, but NOT EXISTS skips the work).

-- 1. Pending reconciliation approvals
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, requires_approval, owner, priority, inputs)
SELECT
    'approval',
    'ap_pending_approvals',
    a.id::TEXT,
    'Reconcile invoice ' || COALESCE(a.invoice_number, '?') || ' from ' || COALESCE(a.vendor_name, '?'),
    'NEEDS_APPROVAL',
    TRUE,
    'will',
    1,
    jsonb_build_object(
        'invoice_number', a.invoice_number,
        'vendor_name',    a.vendor_name,
        'order_id',       a.order_id,
        'verdict_type',   a.verdict_type
    )
FROM public.ap_pending_approvals a
WHERE a.status = 'pending'
  AND (a.expires_at IS NULL OR a.expires_at > NOW())
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'ap_pending_approvals' AND t.source_id = a.id::TEXT
  );

-- 2. Pending copilot action sessions (PO sends, PO reviews, reconciliation approvals).
--    Dropships do NOT land here today — ap-agent.ts:409-489 forwards them to Bill.com
--    inline without writing pending_dropships rows. The pending_dropships table is
--    historical / unused in production; we deliberately omit it from the backfill so
--    the hub doesn't get seeded with stale rows. The 'dropship_forward' type stays in
--    the agent_task CHECK list so a future "needs human review" dropship path can use it.
--    Action_type → hub type mapping:
--       po_send / po_review     → po_send_confirm
--       reconcile_approve       → approval (reconciler approval)
--       <anything else>         → po_send_confirm (default; safe — phase 2 will refine)
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, requires_approval, owner, priority, inputs, deadline_at)
SELECT
    CASE
        WHEN s.action_type = 'reconcile_approve' THEN 'approval'
        ELSE 'po_send_confirm'
    END,
    'copilot_action_sessions',
    s.session_id,
    'Confirm ' || s.action_type || ' (channel: ' || s.channel || ')',
    'NEEDS_APPROVAL',
    TRUE,
    'will',
    2,
    jsonb_build_object(
        'action_type', s.action_type,
        'channel',     s.channel
    ),
    s.expires_at
FROM public.copilot_action_sessions s
WHERE s.status = 'pending'
  AND s.expires_at > NOW()
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'copilot_action_sessions' AND t.source_id = s.session_id
  );

-- 3. Pending agent exceptions (Supervisor will classify; surface them in the meantime)
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, owner, priority, inputs)
SELECT
    'agent_exception',
    'ops_agent_exceptions',
    e.id::TEXT,
    'Agent ' || e.agent_name || ' raised an exception: ' || LEFT(COALESCE(e.error_message, '(no message)'), 120),
    'PENDING',
    'aria',
    1,
    jsonb_build_object(
        'agent_name',    e.agent_name,
        'error_message', e.error_message,
        'context_data',  e.context_data
    )
FROM public.ops_agent_exceptions e
WHERE e.status = 'pending'
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'ops_agent_exceptions' AND t.source_id = e.id::TEXT
  );

-- 4. Pending control requests (runbook commands)
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, owner, priority, inputs)
SELECT
    'control_command',
    'ops_control_requests',
    c.id::TEXT,
    'Control: ' || c.command || ' on ' || c.target,
    'PENDING',
    'aria',
    0,
    jsonb_build_object(
        'command',      c.command,
        'target',       c.target,
        'requested_by', c.requested_by,
        'reason',       c.reason
    )
FROM public.ops_control_requests c
WHERE c.status = 'pending'
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'ops_control_requests' AND t.source_id = c.id::TEXT
  );

-- 5. Recent cron failures (last 24h, status='error')
INSERT INTO public.agent_task (type, source_table, source_id, goal, status, owner, priority, inputs, completed_at)
SELECT
    'cron_failure',
    'cron_runs',
    cr.id::TEXT,
    'Cron ' || cr.task_name || ' failed: ' || LEFT(COALESCE(cr.error_message, '(no message)'), 120),
    'FAILED',
    'aria',
    1,
    jsonb_build_object(
        'task_name',     cr.task_name,
        'error_message', cr.error_message,
        'duration_ms',   cr.duration_ms,
        'started_at',    cr.started_at
    ),
    cr.finished_at
FROM public.cron_runs cr
WHERE cr.status = 'error'
  AND cr.started_at >= NOW() - INTERVAL '24 hours'
  AND NOT EXISTS (
      SELECT 1 FROM public.agent_task t
      WHERE t.source_table = 'cron_runs' AND t.source_id = cr.id::TEXT
  );

COMMENT ON TABLE public.agent_task IS
    'Aria control-plane hub. One row per unit of work that a human might care about — '
    'approvals, dropships, PO confirmations, agent exceptions, control commands, cron '
    'failures, and (phase 6) code-change tasks. Spokes link via (source_table, source_id) '
    'with a partial unique index for idempotent upserts. See .agents/plans/control-plane.md.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260429_add_task_id_to_spokes.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add nullable task_id FK to spoke tables for control-plane phase 2.
-- Created: 2026-04-29
--
-- Purpose: Phase 2 wires the 5 spoke writers to also create/update an `agent_task`
-- hub row alongside their existing spoke insert. To make the link queryable from
-- both directions (and to let the dashboard "open the spoke" from a hub row), each
-- spoke gains a nullable `task_id UUID REFERENCES agent_task(id) ON DELETE SET NULL`.
--
-- `copilot_action_sessions` is included because PO-send confirmation sessions are
-- durable production spoke rows and now mirror into the hub like the other control
-- plane surfaces.
--
-- All changes additive (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
-- One-time backfill UPDATE uses NOT EXISTS / IS NULL guards so re-running is safe.
--
-- Rollback:
--   ALTER TABLE public.ap_pending_approvals    DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.copilot_action_sessions DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.ops_agent_exceptions    DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.ops_control_requests    DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.cron_runs               DROP COLUMN IF EXISTS task_id;
--   (Indexes drop with the columns.)

-- ── Add task_id to each spoke ────────────────────────────────────────────────

ALTER TABLE public.ap_pending_approvals
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.copilot_action_sessions
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.ops_agent_exceptions
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.ops_control_requests
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

ALTER TABLE public.cron_runs
    ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES public.agent_task(id) ON DELETE SET NULL;

-- ── Indexes (partial: only non-null task_id) ─────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ap_pending_approvals_task_id
    ON public.ap_pending_approvals (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_copilot_action_sessions_task_id
    ON public.copilot_action_sessions (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_agent_exceptions_task_id
    ON public.ops_agent_exceptions (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_control_requests_task_id
    ON public.ops_control_requests (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cron_runs_task_id
    ON public.cron_runs (task_id) WHERE task_id IS NOT NULL;

-- ── Backfill from existing hub rows ──────────────────────────────────────────
-- Phase 1 already seeded `agent_task` from existing pending spokes via
-- (source_table, source_id). Now hydrate the reverse FK on each spoke. Idempotent:
-- only sets where task_id IS NULL, which is the only state a row can be in
-- right after this migration adds the column.

UPDATE public.ap_pending_approvals AS a
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'ap_pending_approvals'
   AND t.source_id = a.id::TEXT
   AND a.task_id IS NULL;

UPDATE public.copilot_action_sessions AS s
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'copilot_action_sessions'
   AND t.source_id = s.session_id
   AND s.task_id IS NULL;

UPDATE public.ops_agent_exceptions AS e
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'ops_agent_exceptions'
   AND t.source_id = e.id::TEXT
   AND e.task_id IS NULL;

UPDATE public.ops_control_requests AS c
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'ops_control_requests'
   AND t.source_id = c.id::TEXT
   AND c.task_id IS NULL;

UPDATE public.cron_runs AS cr
   SET task_id = t.id
  FROM public.agent_task AS t
 WHERE t.source_table = 'cron_runs'
   AND t.source_id = cr.id::TEXT
   AND cr.task_id IS NULL;

COMMENT ON COLUMN public.ap_pending_approvals.task_id IS
    'FK to agent_task hub row. Set by reconciler.storePendingApproval after the hub upsert. NULL until phase 2 wiring runs (HUB_TASKS_ENABLED).';
COMMENT ON COLUMN public.ops_agent_exceptions.task_id IS
    'FK to agent_task hub row. Set by ops-manager.safeRun failure path via SupervisorAgent. NULL on legacy rows pre-phase-2.';
COMMENT ON COLUMN public.ops_control_requests.task_id IS
    'FK to agent_task hub row. Set by oversight-agent.escalate after createOpsControlRequest.';
COMMENT ON COLUMN public.cron_runs.task_id IS
    'FK to agent_task hub row. Set ONLY for failures (status=error). Successful runs do not generate hub rows.';
COMMENT ON COLUMN public.copilot_action_sessions.task_id IS
    'FK to agent_task hub row. Set by po-sender after mirroring pending PO-send confirmations into the agent_task hub.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260430_seed_uline_pack_sizes_bulk.sql
-- ════════════════════════════════════════════════════════════════

-- ULINE pack-size bulk seed (auto-generated from MyOrderHistory.xlsx)
-- Run: node _run_migration.js supabase/migrations/20260430_seed_uline_pack_sizes_bulk.sql
-- Generated: 2026-04-30T21:25:46.012Z
-- Source: MyOrderHistory.xlsx

-- 64 SKUs with pack size parsed from description.
-- Upsert (ON CONFLICT) so re-running is safe and existing seeds get refreshed.
INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, ea_unit_price, source, notes) VALUES
    ('S-4905', 25, 'bundle', 0.0795, 'uline_history', '24 x 14 x 6" Corrugated Boxes 25/bundle'),
    ('S-4122', 25, 'bundle', 0.0396, 'uline_history', '12 x 12 x 6" Corrugated Boxes 25/bundle'),
    ('S-4738', 20, 'bundle', 0.1145, 'uline_history', '24 x 14 x 10" Corrugated Boxes 20/bundle'),
    ('S-6645', 6, 'case', 21.1765, 'uline_history', 'Uline Jumbo Industrial Reinforced Kraft Tape - 3" x 900'' 6 rolls/case'),
    ('S-4092', 25, 'bundle', 0.0203, 'uline_history', '9 x 5 x 5" Corrugated Boxes 25/bundle'),
    ('S-4503', 20, 'bundle', 0.1115, 'uline_history', '24 x 14 x 8" Corrugated Boxes 20/bundle'),
    ('S-4125', 25, 'bundle', 0.0436, 'uline_history', '12 x 12 x 12" Corrugated Boxes 25/bundle'),
    ('S-4128', 25, 'bundle', 0.0260, 'uline_history', '12 x 6 x 6" Long Corrugated Boxes 25/bundle'),
    ('S-4796', 20, 'bundle', 0.0995, 'uline_history', '22 x 14 x 6" Corrugated Boxes 20/bundle'),
    ('S-4181', 25, 'bundle', 0.0628, 'uline_history', '18 x 12 x 12" Corrugated Boxes 25/bundle'),
    ('S-3193', 25, 'bundle', 0.0816, 'uline_history', '40 x 48" 200 lb Corrugated Pads 25/bundle'),
    ('S-4551', 15, 'bundle', 0.2220, 'uline_history', '30 x 15 x 15" Corrugated Boxes 15/bundle'),
    ('S-4412', 15, 'bundle', 0.1980, 'uline_history', '15 x 15 x 30" Corrugated Boxes 15/bundle'),
    ('S-4124', 25, 'bundle', 0.0419, 'uline_history', '12 x 12 x 8" Corrugated Boxes 25/bundle'),
    ('S-4126', 25, 'bundle', 0.0476, 'uline_history', '12 x 12 x 10" Corrugated Boxes 25/bundle'),
    ('S-15045', 15, 'bundle', 0.2827, 'uline_history', '18 x 18 x 30" Corrugated Boxes 15/bundle'),
    ('S-12610', 10, 'bundle', 0.4100, 'uline_history', '24 x 13 x 31" Multi-Depth Corrugated Suitcase Boxes 10/bundle'),
    ('S-1667', 500, 'carton', 0.3280, 'uline_history', '12 x 15" 6 Mil Reclosable Bags 500/carton'),
    ('S-13505B', 120, 'case', 0.0104, 'uline_history', 'F-Style Jugs Bulk Pack - 32 oz, White 120/case'),
    ('S-1665', 500, 'carton', 0.2060, 'uline_history', '9 x 12" 6 Mil Reclosable Bags 500/carton'),
    ('S-14289', 15, 'bundle', 0.2367, 'uline_history', '22 x 22 x 14" Corrugated Boxes 15/bundle'),
    ('S-15625', 24, 'case', 0.3958, 'uline_history', 'Industrial Security Tape - "If Seal is Broken", 3" x 110 yds 24   rolls/case'),
    ('S-3902', 5000, 'pail', 0.0374, 'uline_history', 'Silica Gel Desiccants - Gram Size 1, 5 Gallon Pail 5,000 bags/pail'),
    ('S-13506B', 60, 'case', 0.0250, 'uline_history', 'F-Style Jugs Bulk Pack - 1/2 Gallon, White 60/case'),
    ('S-12849', 6, 'case', 7.6667, 'uline_history', 'Uline Kraft Paper Roll Towels - 8" x 800'' 6/case'),
    ('S-4654', 15, 'bundle', 0.1787, 'uline_history', '24 x 14 x 14" Corrugated Boxes 15/bundle'),
    ('S-445', 24, 'case', 0.1312, 'uline_history', 'Uline Industrial Tape - 2 Mil, 3" x 110 yds, Clear 24 rolls/case'),
    ('S-18374', 25, 'bundle', 0.0840, 'uline_history', '28 x 10 x 10" Long Corrugated Boxes 25/bundle'),
    ('S-15837B', 240, 'case', 0.0038, 'uline_history', 'F-Style Jugs Bulk Pack - 1 Pint, White 240/case'),
    ('S-10748B', 60, 'case', 0.0275, 'uline_history', 'F-Style Jugs Bulk Pack - 1 Gallon, White 60/case'),
    ('S-5050R', 100, 'box', 0.3600, 'uline_history', 'Uline Laser Labels - Fluorescent Red, 8 1/2 x 11" 100/box'),
    ('S-6019', 4, 'case', 6.0000, 'uline_history', 'Uline Handwrap - Cast, 80 gauge, 18" x 1,500'', White Opaque 4   rolls/case'),
    ('S-15122', 200, 'carton', 0.6300, 'uline_history', '24 x 42" 3 Mil Industrial Poly Bags 200/carton'),
    ('S-6490', 250, 'carton', 0.4760, 'uline_history', '24 x 36" 3 Mil Industrial Poly Bags 250/carton'),
    ('S-7178W', 16, 'case', 0.8750, 'uline_history', 'Uline Industrial Duct Tape - 3" x 60 yds, White 16 rolls/case'),
    ('S-11196', 1000, 'carton', 0.0780, 'uline_history', 'Super Stick Packing List Envelopes - 5 1/2 x 10" 1,000/carton'),
    ('S-4504', 20, 'bundle', 0.1135, 'uline_history', '24 x 16 x 6" Corrugated Boxes 20/bundle'),
    ('S-20543', 10, 'bundle', 0.4940, 'uline_history', '28 x 28 x 8" Corrugated Boxes 10/bundle'),
    ('S-5050Y', 100, 'box', 0.3600, 'uline_history', 'Uline Laser Labels - Fluorescent Yellow, 8 1/2 x 11" 100/box'),
    ('S-5111', 100, 'carton', 0.5800, 'uline_history', 'Uline Industrial Trash Liners - 44-55 Gallon, 1.5 Mil, Black   100/carton'),
    ('S-22481', 20000, 'carton', 0.0056, 'uline_history', 'Uline Stick Staples - C34 3/4" 20,000/carton'),
    ('S-13711', 440, 'box', 0.3614, 'uline_history', 'Premium White T-Shirt Rags - 50 lb box 440/box'),
    ('S-5105', 250, 'carton', 0.3520, 'uline_history', 'Uline Industrial Trash Liners - 33 Gallon, 1.5 Mil, Black 250/carton'),
    ('S-5050G', 100, 'box', 0.3600, 'uline_history', 'Uline Laser Labels - Fluorescent Green, 8 1/2 x 11" 100/box'),
    ('S-9927', 36, 'case', 0.1694, 'uline_history', 'Industrial Security Tape - "If Seal is Broken", 2" x 110 yds 36   rolls/case'),
    ('S-2835', 1000, 'carton', 0.0410, 'uline_history', '7 x 8" 2 Mil Reclosable Bags - 1 Quart 1,000/carton'),
    ('S-3166', 500, 'carton', 0.1900, 'uline_history', '16 x 16" 4 Mil Industrial Poly Bags 500/carton'),
    ('S-1748', 250, 'carton', 0.3720, 'uline_history', '24 x 42" 2 Mil Industrial Poly Bags 250/carton'),
    ('S-12229', 1000, 'carton', 0.0150, 'uline_history', 'Shrink Bands - 66mm x 28mm, Perforated 1,000/carton'),
    ('S-13264', 1000, 'carton', 0.1060, 'uline_history', 'Reclosable Polypropylene Bags - 2 Mil, 12 x 12" 1,000/carton'),
    ('S-7220RPW', 1000, 'carton', 0.0920, 'uline_history', 'Repair Tags - #5, Pre-wired, Red 1,000/carton'),
    ('H-541', 100, 'pack', 0.3000, 'uline_history', 'Uline Metal Truck Seals - Silver 100/Pack'),
    ('S-22361', 50, 'bundle', 1.5000, 'uline_history', 'Pallet Cones - Red 50/bundle'),
    ('S-18730', 165, 'box', 0.4545, 'uline_history', 'Standard White T-Shirt Rags - 25 lb box 165/box'),
    ('S-19883L', 12, 'carton', 5.0000, 'uline_history', 'Showa Atlas 451 Thermal Latex Coated Gloves - Large 12   pairs/carton'),
    ('S-19883X', 12, 'carton', 5.0000, 'uline_history', 'Showa Atlas 451 Thermal Latex Coated Gloves - XL 12   pairs/carton'),
    ('S-14824', 12, 'case', 4.8333, 'uline_history', 'Uline Air Freshener Spray - Citrus Blossom 12 cans/case'),
    ('S-4381', 25, 'bundle', 0.0908, 'uline_history', '6 x 6 x 48" Tall Corrugated Boxes 25/bundle'),
    ('S-24314', 25, 'carton', 1.8000, 'uline_history', '3M PA1 - G Hand Applicator 25/carton'),
    ('S-12230', 1000, 'carton', 0.0150, 'uline_history', 'Shrink Bands - 75mm x 28mm, Perforated 1,000/carton'),
    ('S-14783', 100, 'box', 0.2200, 'uline_history', 'Name Badge Holders - 2 x 3", Vertical, Pre-Punched 100/box'),
    ('S-16183', 200, 'box', 0.0175, 'uline_history', '70% Isopropyl Prep Pads 200/box'),
    ('S-14138', 5000, 'carton', 0.0006, 'uline_history', 'Desktop Staples - 1/4" 5,000/carton'),
    ('S-4902', 25, 'bundle', 0.0000, 'uline_history', '20 x 16 x 6" Corrugated Boxes 25/bundle')
ON CONFLICT (sku) DO UPDATE SET
    units_per_pack = EXCLUDED.units_per_pack,
    pack_unit      = EXCLUDED.pack_unit,
    ea_unit_price  = EXCLUDED.ea_unit_price,
    source         = EXCLUDED.source,
    notes          = EXCLUDED.notes,
    updated_at     = NOW();

-- 93 SKUs with NO parseable pack size — fill in manually if needed
-- Most likely 1/each (uline lists eaches by default for many items)
-- Format: ('SKU', UNITS, 'UNIT', EA_PRICE_NULL_OR_NUM, 'uline_manual', 'NOTE')
-- S-19740    avg $417.86/unit  desc="Instant Bubble Film - Large, 12" x 1,250''"
-- H-7127     avg $3750.00/unit  desc="Portacool Jetstream Evaporative Cooler - 36""
-- H-754      avg $1650.00/unit  desc="Low Profile Floor Scale - 4 x 4'', 5,000 lbs x 1 lb"
-- S-20046    avg $6.10/unit  desc="EZ-Pour F-Style Jugs - 2 1/2 Gallon"
-- H-6754     avg $1095.00/unit  desc="Uline Manual Lift Table - Standard, 63 x 31 1/2", 1,100 lb"
-- S-12527    avg $20.78/unit  desc="3M 6006 Multiple Toxic Gases Cartridge 2/package"
-- S-17888    avg $30.80/unit  desc="Giant Plastic Stackable Bins - 17 1/2 x 16 1/2 x 12 1/2", Clear"
-- H-384BL    avg $4.82/unit  desc="Sharpie Magnum Markers - Black"
-- S-11443    avg $16.00/unit  desc=""Fragile Liquid/Handle With Care" Labels - 2 x 3" 500/roll"
-- H-1719BL   avg $116.33/unit  desc="Anti-Fatigue Mat - 5/8" thick, 3 x 8'', Black"
-- H-2646G    avg $325.00/unit  desc="Shelf Bin Organizer - 36 x 18 x 39" with 11 x 18 x 4" Green Bins"
-- H-1028     avg $318.00/unit  desc="Uline Pneumatic Stick Stapler "C" - 3/4""
-- H-7130     avg $120.00/unit  desc="Replacement Pad for Portacool Jetstream 260 Evaporative   Cooler"
-- S-14819    avg $66.00/unit  desc="Uline Industrial Wipers - Dispenser Box 90 wipes/box"
-- S-9752     avg $64.89/unit  desc="3M 501 Prefilter Retainer for Respirators 20/package"
-- S-9749     avg $24.45/unit  desc="3M 5N11 N95 Prefilter 10/package"
-- H-7893     avg $255.00/unit  desc="Little Giant Folding Step Ladder - 4 Steps"
-- S-7541P    avg $63.00/unit  desc="Heavy Duty Bubble Roll - 12" x 250'', 1/2", Perforated 4 rolls/bundle"
-- H-384R     avg $4.84/unit  desc="Sharpie Magnum Markers - Red"
-- H-4053BL   avg $460.00/unit  desc="Collapsible Bulk Container - 48 x 45 x 42", 1,500 lb Capacity, Black"
-- H-7287     avg $414.00/unit  desc="Edge Seal Wire Assembly for NewAir I.B. Flex Machine"
-- H-7831BL   avg $395.00/unit  desc="Collapsible Bulk Container - 48 x 45 x 34", 1,500 lb Capacity, Black"
-- H-4987     avg $30.45/unit  desc="3M 6503 Half-Face Respirator - Large"
-- H-7841     avg $300.00/unit  desc="Reel Rack - 36 x 24 x 84""
-- H-204      avg $48.00/unit  desc="24" Service Kit for H-86 Foot-Operated Impulse Sealer"
-- H-1211     avg $135.00/unit  desc="Rackable Plastic Pallet - 48 x 40", Black"
-- H-754-LP7510 avg $260.00/unit  desc="LP7510A Display Indicator Kit for Standard Low Profile Floor Scales"
-- H-754-7510CB avg $47.00/unit  desc="Cable for Standard Low Profile Scales"
-- H-4114     avg $235.00/unit  desc="Deluxe Mesh Task Chair"
-- S-2255     avg $235.00/unit  desc="Steel Strapping - High Tensile, 5/8" x .023" x 2,152''"
-- H-8661     avg $115.00/unit  desc="Vinyl Cover for Portacool Evaporative Cooler - 36" Fan"
-- H-5490     avg $110.00/unit  desc="Solid Top Rackable Pallet - 48 x 40", 1,600 lb Capacity, Black"
-- H-4986     avg $31.00/unit  desc="3M 6502 Half-Face Respirator - Medium"
-- H-11206    avg $190.00/unit  desc="Uline Work Chair"
-- H-2755BL   avg $7.75/unit  desc="Uline Folding Knife - Black"
-- S-18260    avg $1.18/unit  desc="Square Tubes - 2 x 2 x 37", White"
-- H-7286     avg $174.00/unit  desc="ROLLER ASSEMBLY FOR H-7259"
-- S-23380G   avg $75.00/unit  desc="Privacy Screen - 68" x 50'', Green"
-- S-17132    avg $18.50/unit  desc="Uline Tuff Scrub Hand Soap Gallon - Pumice"
-- S-19184    avg $36.00/unit  desc="3M 60921 Organic Vapor Cartridge/Filter Combo P100 2/package"
-- H-6469     avg $67.00/unit  desc="Uline ANSI Approved First Aid Kit - Class A, 25 Person"
-- H-8157     avg $21.67/unit  desc="Job Site Fan"
-- H-11036    avg $65.00/unit  desc="Uline Contractor''s First Aid Kit"
-- H-3831     avg $41.00/unit  desc="Contractors Broom - 36", Medium Bristles"
-- H-1259     avg $60.00/unit  desc="24" Service Kit for H-1257 Foot-Operated Impulse Sealer with Cutter"
-- S-11444    avg $23.00/unit  desc=""Fragile Liquid/Handle With Care" Labels - 3 x 5" 500/roll"
-- H-7259-PAD avg $114.00/unit  desc="NEW AIR FLEX MEMBRANE PAD"
-- S-14454C   avg $18.10/unit  desc="Plastic Stackable Bins - 18 x 8 x 9", Clear"
-- H-3328BL-S avg $51.00/unit  desc="Pneumatic Caster - Swivel, 8 x 2 1/2", Black"
-- H-4196     avg $50.00/unit  desc="Aircraft Wheel Chocks - 10 x 5 x 4 1/2""
-- ...and 43 more (showing top 50 by spend)

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260501_hygiene_backfill.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add hygiene columns to agent_task and collapse duplicate stale rows
-- Created: 2026-05-01
-- Source spec: .agents/plans/2026-04-27-task-learning-loop.md §3.1, §4
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN dedup_count, DROP COLUMN input_hash, DROP COLUMN closes_when;
--   (Cannot un-collapse deleted duplicate rows; rollback restores schema only.)

-- 1. Schema additions
ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS dedup_count INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS input_hash  TEXT,
    ADD COLUMN IF NOT EXISTS closes_when JSONB;

CREATE INDEX IF NOT EXISTS idx_agent_task_input_hash
    ON public.agent_task (source_table, input_hash)
    WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED');

-- 2. Populate input_hash for every existing row using a SQL canonical form
--    (server-side sha256 over a sorted JSONB representation; the TS canonicalize
--    helper produces an identical hash for new rows)
UPDATE public.agent_task
SET input_hash = encode(
    digest(
        (SELECT string_agg(key || ':' || value::text, ',' ORDER BY key)
         FROM jsonb_each_text(inputs)),
        'sha256'
    ),
    'hex'
)
WHERE input_hash IS NULL;

-- 3. Populate closes_when from static map keyed on (type, inputs).
--    control_command/restart_bot → close when aria-bot heartbeat is fresh
UPDATE public.agent_task
SET closes_when = jsonb_build_object('kind','agent_boot_after','agent','aria-bot')
WHERE type = 'control_command'
  AND inputs->>'command' = 'restart_bot'
  AND closes_when IS NULL;

-- approval-type tasks → close when spoke row reaches 'approved' or 'rejected'
UPDATE public.agent_task
SET closes_when = jsonb_build_object(
    'kind','spoke_status',
    'table', source_table,
    'value_in', jsonb_build_array('approved','rejected','completed','sent','done')
)
WHERE type IN ('approval','po_send_confirm','dropship_forward')
  AND source_table IS NOT NULL
  AND closes_when IS NULL;

-- everything else → 24h deadline
UPDATE public.agent_task
SET closes_when = jsonb_build_object('kind','deadline','max_age_hours',24)
WHERE closes_when IS NULL;

-- 4. Dedup: collapse open rows with same (source_table, source_id, input_hash).
--    Keep the oldest row, increment its dedup_count to the group size, delete the rest.
WITH dup_groups AS (
    SELECT source_table, source_id, input_hash,
           array_agg(id ORDER BY created_at ASC) AS ids,
           count(*) AS n
    FROM public.agent_task
    WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED')
      AND source_table IS NOT NULL
      AND source_id IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(*) > 1
),
keep_ids AS (
    SELECT ids[1] AS keep_id, n FROM dup_groups
)
UPDATE public.agent_task t
SET dedup_count = k.n,
    updated_at = NOW()
FROM keep_ids k
WHERE t.id = k.keep_id;

DELETE FROM public.agent_task
WHERE id IN (
    SELECT unnest(ids[2:]) FROM (
        SELECT array_agg(id ORDER BY created_at ASC) AS ids
        FROM public.agent_task
        WHERE status IN ('PENDING','NEEDS_APPROVAL','RUNNING','CLAIMED')
          AND source_table IS NOT NULL
          AND source_id IS NOT NULL
        GROUP BY source_table, source_id, input_hash
        HAVING count(*) > 1
    ) sub
);

COMMENT ON COLUMN public.agent_task.dedup_count IS
    'Count of identical signals collapsed into this row by incrementOrCreate. 1 for unique tasks.';
COMMENT ON COLUMN public.agent_task.input_hash IS
    'sha256 of canonical inputs JSONB; dedup key for incrementOrCreate.';
COMMENT ON COLUMN public.agent_task.closes_when IS
    'Predicate the closeFinishedTasks cron evaluates against current DB state. See agent-task-closure.ts.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260502_extend_task_history_ledger.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Phase 3 — Extend task_history as the unified event ledger.
-- Created: 2026-05-02
--
-- Purpose: Phase 3 of the control-plane plan repurposes `task_history` as the
-- append-only event ledger for `agent_task`. Adds:
--   - task_id UUID FK → agent_task.id (nullable; legacy rows have no task_id)
--   - event_type TEXT (status transitions: 'created', 'claimed', 'running',
--     'needs_approval', 'approved', 'rejected', 'succeeded', 'failed',
--     'cancelled', 'expired', 'dedup_increment', plus skill events)
--
-- Why no new table: `task_history` already has agent_name, task_type, status,
-- input_summary, output_summary, skill_id, execution_trace, created_at — every
-- field a ledger needs. Adding two columns and an index gives us the ledger
-- without a fourth audit table on top of cron_runs + task_history + ops_alert_events.
--
-- agent-task.ts `appendEvent()` now writes ledger rows here. Phase 4 (skill
-- registry) and phase A1 (pattern miner) read from this table.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_task_history_task_event;
--   DROP INDEX IF EXISTS idx_task_history_event_type;
--   ALTER TABLE public.task_history DROP COLUMN IF EXISTS task_id;
--   ALTER TABLE public.task_history DROP COLUMN IF EXISTS event_type;

ALTER TABLE public.task_history
    ADD COLUMN IF NOT EXISTS task_id    UUID REFERENCES public.agent_task(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS event_type TEXT;

CREATE INDEX IF NOT EXISTS idx_task_history_task_event
    ON public.task_history (task_id, created_at DESC)
    WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_history_event_type
    ON public.task_history (event_type, created_at DESC)
    WHERE event_type IS NOT NULL;

COMMENT ON COLUMN public.task_history.task_id IS
    'FK to agent_task hub row. Set by agent-task.ts appendEvent. NULL on legacy rows pre-phase-3.';
COMMENT ON COLUMN public.task_history.event_type IS
    'Discriminator for ledger entries: created | claimed | running | needs_approval | approved | rejected | succeeded | failed | cancelled | expired | dedup_increment | skill_invoked | skill_succeeded | skill_failed.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260503_create_email_context_log.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Replace Pinecone email-embeddings dummy-vector hack with a real Supabase table
-- Created: 2026-05-03
-- Rollback: DROP TABLE IF EXISTS public.email_context_log;
--
-- DECISION(2026-05-03): The email-embeddings Pinecone index (768d) was being used as a
-- dedup/audit ledger with `new Array(768).fill(0.0001)` dummy vectors — the wrong tool
-- for non-vector workload. Move to a plain Supabase table; the function signature in
-- src/lib/intelligence/pinecone.ts is preserved so callers don't change.

CREATE TABLE IF NOT EXISTS public.email_context_log (
    id           TEXT PRIMARY KEY,
    text         TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_context_log_indexed_at
    ON public.email_context_log (indexed_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_context_log_metadata
    ON public.email_context_log USING GIN (metadata);

COMMENT ON TABLE public.email_context_log IS
    'Audit log of email/document context that used to be written to Pinecone email-embeddings index. Write-only sink today; queryable via SQL when needed.';
COMMENT ON COLUMN public.email_context_log.id IS
    'Stable id from the caller — typically gmail message_id or message_id + attachment hash.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260504_agent_task_constraints_fixup.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Fix-up for 20260501 — add 'stuck_source' to agent_task.type CHECK
-- and prepare for input_hash recompute via TS.
-- Created: 2026-05-04
--
-- WHY THIS EXISTS
--
-- 20260501_hygiene_backfill.sql shipped two latent bugs that surfaced on first
-- real use:
--
-- (1) `incrementOrCreate` in src/lib/intelligence/agent-task.ts can emit a
--     `stuck_source` meta-task when dedup_count > 5 AND the original task is
--     >1h old. But agent_task.type's CHECK constraint (created in
--     20260428_create_agent_task.sql) does not include 'stuck_source' as an
--     allowed value. The next stuck_source emission would fail with
--     "new row violates check constraint" and the spoke writer's try/catch
--     would swallow the error — meaning the stuck_source surfacing path
--     would silently never fire.
--
-- (2) 20260501's input_hash backfill used a SQL canonical form
--       digest(string_agg(key||':'||value::text, ',' ORDER BY key), 'sha256')
--     that does NOT match the TypeScript canonicalize form in
--     src/lib/intelligence/agent-task-hash.ts. The TS form recursively sorts
--     object keys and produces compact JSON ({"a":1,"b":2}, no spaces); the
--     SQL form produced a flat key:value text concatenation. SHA-256 of those
--     two strings differ for any non-trivial JSONB. As a result, dedup-on-
--     insert against existing backfilled rows is broken — the same signal
--     creates a NEW row with a fresh TS-computed hash instead of incrementing
--     the existing row's dedup_count.
--
-- THIS MIGRATION FIXES (1) ONLY.
--
-- (1) is a one-line CHECK-constraint update — DROP + re-ADD with the
-- expanded value set.
--
-- (2) is NOT fixed in SQL. Postgres can't easily produce text matching TS's
-- canonicalize() because JSONB::text inserts spaces after `:` and `,`
-- (yielding `{"a": 1, "b": 2}` vs TS's `{"a":1,"b":2}`). Writing a PL/pgSQL
-- function that exactly replicates TS canonicalize is doable but error-prone
-- and a maintenance burden. Cleaner: recompute input_hash from TS for every
-- existing row via a one-shot script.
--
-- AFTER APPLYING THIS MIGRATION, run:
--
--   node --import tsx src/cli/recompute-input-hashes.ts
--
-- That script pages every row in agent_task, recomputes input_hash using the
-- exact same inputHash() function the spoke writers use, and UPDATEs in place.
-- Idempotent — safe to re-run.
--
-- Rollback:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN ('cron_failure','approval','dropship_forward','po_send_confirm',
--                     'agent_exception','control_command','manual','code_change'));
--   (No way to roll back input_hash recompute since old SQL form cannot be
--    reconstructed from current data; future signals would simply create new
--    rows that the old hashes wouldn't dedup against. Leaving rollback as
--    "drop the new constraint" is sufficient.)

-- (1) Drop the inline CHECK that came from CREATE TABLE in 20260428 and
--     re-add it with 'stuck_source' included. Postgres auto-names inline
--     CHECKs as <table>_<column>_check; verified that name is in use by
--     the table created in 20260428_create_agent_task.sql.

ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;

ALTER TABLE public.agent_task
    ADD CONSTRAINT agent_task_type_check
    CHECK (type IN (
        'cron_failure',
        'approval',
        'dropship_forward',
        'po_send_confirm',
        'agent_exception',
        'control_command',
        'manual',
        'code_change',
        'stuck_source'
    ));

COMMENT ON CONSTRAINT agent_task_type_check ON public.agent_task IS
    'Permitted hub task types. stuck_source added in 20260504_agent_task_constraints_fixup.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260505_add_auto_handled_by.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add auto_handled_by column to agent_task
-- Created: 2026-05-05
-- Purpose: Track which autonomous source resolved a task (vs human action).
--          Powers the "auto-handled by X" badge on dashboard command-board
--          lane cards in the Recently Closed lane. Manual actions
--          (will-telegram, will-dashboard) leave this NULL — only autonomous
--          paths (closure cron, reconciler auto-apply, etc.) populate it.
--
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN auto_handled_by;
--   DROP INDEX IF EXISTS idx_agent_task_auto_handled_by;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS auto_handled_by TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_task_auto_handled_by
    ON public.agent_task (auto_handled_by)
    WHERE auto_handled_by IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260505000001_add_po_sent_verification.sql
-- ════════════════════════════════════════════════════════════════

ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "po_sent_verified_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "po_sent_verified_source" TEXT,
ADD COLUMN IF NOT EXISTS "po_sent_verified_evidence" JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN "public"."purchase_orders"."po_sent_verified_at" IS
'When the purchasing workflow verified that the PO was actually sent to the vendor.';

COMMENT ON COLUMN "public"."purchase_orders"."po_sent_verified_source" IS
'Evidence source for PO send verification: po_send, purchase_order, tracking, vendor_reply, or manual.';

COMMENT ON COLUMN "public"."purchase_orders"."po_sent_verified_evidence" IS
'Evidence records supporting PO send verification.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260505000002_qty_calibration.sql
-- ════════════════════════════════════════════════════════════════

-- Phase 2-3 of canonical-formula rollout: calibration loop, draft reservation,
-- vendor MOQ, and the data needed to compute "Aria vs Finale" divergence stats.

-- ──────────────────────────────────────────────────
-- qty_recommendations — every recommendation snapshot
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qty_recommendations (
    id              BIGSERIAL PRIMARY KEY,
    product_id      TEXT NOT NULL,
    vendor_party_id TEXT,
    vendor_name     TEXT,
    formula_version TEXT NOT NULL,
    recommended_qty NUMERIC(14,2) NOT NULL,
    finale_reorder_qty NUMERIC(14,2),
    inputs_jsonb    JSONB NOT NULL,
    provenance_jsonb JSONB,
    recommended_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Filled in by the receive hook after the PO that consumed this recommendation closes:
    po_number       TEXT,
    actual_consumed_eaches NUMERIC(14,2),
    consumption_window_days INTEGER,
    error_pct       NUMERIC(8,2),
    calibrated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS qty_recs_product_idx
    ON public.qty_recommendations (product_id, recommended_at DESC);
CREATE INDEX IF NOT EXISTS qty_recs_vendor_idx
    ON public.qty_recommendations (vendor_party_id, recommended_at DESC);
CREATE INDEX IF NOT EXISTS qty_recs_uncalibrated_idx
    ON public.qty_recommendations (po_number)
    WHERE calibrated_at IS NULL AND po_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS qty_recs_formula_idx
    ON public.qty_recommendations (formula_version, recommended_at DESC);

COMMENT ON TABLE public.qty_recommendations IS
    'Phase 2 calibration snapshot. One row per (product_id, recommended_at) capturing the inputs and formula version used so we can later compute error_pct against actual consumption.';

-- ──────────────────────────────────────────────────
-- qty_reservations — draft PO reservation, 72h TTL
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.qty_reservations (
    id              BIGSERIAL PRIMARY KEY,
    product_id      TEXT NOT NULL,
    vendor_party_id TEXT,
    qty             NUMERIC(14,2) NOT NULL,
    draft_po_number TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '72 hours',
    released_at     TIMESTAMPTZ,
    release_reason  TEXT
);

CREATE INDEX IF NOT EXISTS qty_reservations_active_idx
    ON public.qty_reservations (product_id)
    WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS qty_reservations_draft_idx
    ON public.qty_reservations (draft_po_number);

COMMENT ON TABLE public.qty_reservations IS
    'Phase 3a — when a draft PO is created, qty for each line is reserved here so the next recommendation cycle does not double-order. Auto-releases on commit, cancel, or 72h TTL.';

-- ──────────────────────────────────────────────────
-- vendor_minimum_orders — MOQ enforcement at recommend time
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_minimum_orders (
    vendor_party_id TEXT PRIMARY KEY,
    vendor_name     TEXT,
    minimum_order_dollars NUMERIC(12,2),
    minimum_order_eaches  NUMERIC(14,2),
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_minimum_orders IS
    'Vendor minimum-order constraints applied at recommend time so the panel never suggests an order that would be rejected by the vendor. Either dollar or each-count threshold.';

-- ──────────────────────────────────────────────────
-- vendor_calibration_stats — rolling per-vendor error stats
-- ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_calibration_stats (
    vendor_party_id TEXT PRIMARY KEY,
    vendor_name     TEXT,
    sample_count    INTEGER NOT NULL DEFAULT 0,
    median_error_pct NUMERIC(8,2),
    mean_error_pct  NUMERIC(8,2),
    bias_pct        NUMERIC(8,2),
    safety_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.0,
    last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_calibration_stats IS
    'Rolling calibration metrics per vendor. safety_multiplier is fed back into the recommender when |median_error_pct| exceeds 25% so future recommendations adjust. bias_pct distinguishes consistent over-ordering from under-ordering.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260505100000_qty_rec_resulting_po.sql
-- ════════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260506_add_ci_failure_tripwire_task_types.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add ci_failure + tripwire_violation to agent_task type CHECK
-- Created: 2026-05-06
-- Purpose: Self-Heal Layer A introduces two new task types so that CI
--          failures and tripwire violations land on the command-board
--          work queue. The type column has a CHECK constraint that must
--          permit the new literals or all inserts fail.
--
--          The TypeScript AgentTaskType union has already been extended
--          (src/lib/intelligence/agent-task.ts) — this migration brings
--          the DB into alignment.
--
-- Rollback:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task
--     ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN ('cron_failure','approval','dropship_forward','po_send_confirm',
--                     'agent_exception','control_command','manual','code_change',
--                     'stuck_source'));

ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;

ALTER TABLE public.agent_task
    ADD CONSTRAINT agent_task_type_check
    CHECK (type IN (
        'cron_failure',
        'approval',
        'dropship_forward',
        'po_send_confirm',
        'agent_exception',
        'control_command',
        'manual',
        'code_change',
        'stuck_source',
        'ci_failure',
        'tripwire_violation'
    ));

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260506000001_cron_runs.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260506000001_cron_runs.sql
--
-- Extends the existing cron_runs table (from 20260415_create_ops_control_plane.sql)
-- with three columns the new src/cron/ registry needs:
--
--   invoked_by      cron | manual | dependency
--   failure_reason  short machine-readable code (concurrency-locked, duration-exceeded, …)
--   metadata_jsonb  correlation id + any extra structured context
--
-- Existing columns we reuse as-is:
--   task_name       → JobDef.name
--   status          → 'running'|'succeeded'|'failed'|'cancelled'|'skipped'
--   started_at, finished_at, duration_ms
--   error_message   → human-readable failure detail
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-running is safe.

ALTER TABLE public.cron_runs
    ADD COLUMN IF NOT EXISTS invoked_by      TEXT NOT NULL DEFAULT 'cron'
        CHECK (invoked_by IN ('cron', 'manual', 'dependency')),
    ADD COLUMN IF NOT EXISTS failure_reason  TEXT,
    ADD COLUMN IF NOT EXISTS metadata_jsonb  JSONB;

-- Widen the status CHECK constraint to allow 'skipped' and 'cancelled' which
-- the new framework emits (existing constraint allowed any TEXT — confirm by inspection).
-- If a CHECK exists on status, we drop and re-add. Otherwise this is a no-op.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT con.conname INTO constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE rel.relname = 'cron_runs' AND att.attname = 'status' AND con.contype = 'c'
    LIMIT 1;
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.cron_runs DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

-- Constraint allows both legacy values ('success', 'error') and new framework
-- values ('succeeded', 'failed', 'cancelled', 'skipped'). Old rows stay readable;
-- new code writes the new vocabulary. Tighten later once legacy rows age out.
ALTER TABLE public.cron_runs
    ADD CONSTRAINT cron_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'skipped', 'success', 'error'));

-- Index for the /jobs lastRun lookup (latest row per task).
CREATE INDEX IF NOT EXISTS cron_runs_task_started_desc_idx
    ON public.cron_runs (task_name, started_at DESC);

COMMENT ON COLUMN public.cron_runs.invoked_by IS
    'How this run was triggered. cron=scheduled tick, manual=/run command, dependency=downstream of dependsOn.';
COMMENT ON COLUMN public.cron_runs.failure_reason IS
    'Machine-readable failure code (concurrency-locked, duration-exceeded, dependency-not-succeeded, handler-threw, disabled).';
COMMENT ON COLUMN public.cron_runs.metadata_jsonb IS
    'Free-form structured context. Always includes correlationId.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260506000002_vendor_reorder_policies.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260506000002_vendor_reorder_policies.sql
--
-- Vendor-level reorder planning policy. Separate from vendor_minimum_orders
-- on purpose: MOQ rows are *facts* (vendor stated this); policy rows are
-- *preferences* (we chose to handle MOQ this way / use 180d cover here).
--
-- Default-unchanged invariant: every vendor without a row keeps current
-- behavior. Default moq_mode is 'enforce' to match existing pipeline
-- semantics.

CREATE TABLE IF NOT EXISTS public.vendor_reorder_policies (
    vendor_party_id            TEXT PRIMARY KEY,
    vendor_name                TEXT,
    lead_time_override_days    INTEGER,
    target_cover_days          INTEGER,
    moq_mode                   TEXT NOT NULL DEFAULT 'enforce',
    overbuy_review_pct         NUMERIC(8,2) NOT NULL DEFAULT 50,
    overbuy_review_dollars     NUMERIC(12,2) NOT NULL DEFAULT 1000,
    notes                      TEXT,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vendor_reorder_policies_moq_mode_chk
        CHECK (moq_mode IN ('enforce', 'warn', 'ignore')),
    CONSTRAINT vendor_reorder_policies_lead_chk
        CHECK (lead_time_override_days IS NULL OR lead_time_override_days > 0),
    CONSTRAINT vendor_reorder_policies_cover_chk
        CHECK (target_cover_days IS NULL OR target_cover_days > 0)
);

COMMENT ON TABLE public.vendor_reorder_policies IS
    'Vendor-level reorder planning policy. Finale remains SKU-level source for order increments; this table controls vendor lead-time override, cover window, MOQ behavior, and review thresholds.';

INSERT INTO public.vendor_reorder_policies (
    vendor_party_id,
    vendor_name,
    lead_time_override_days,
    target_cover_days,
    moq_mode,
    overbuy_review_pct,
    overbuy_review_dollars,
    notes
)
VALUES (
    '10918',
    'Colorful Packaging Ltd',
    45,
    180,
    'warn',
    50,
    1000,
    'Custom packaging: 30-45 day lead time, order roughly 6 months at a time.'
)
ON CONFLICT (vendor_party_id) DO UPDATE SET
    vendor_name             = EXCLUDED.vendor_name,
    lead_time_override_days = EXCLUDED.lead_time_override_days,
    target_cover_days       = EXCLUDED.target_cover_days,
    moq_mode                = EXCLUDED.moq_mode,
    overbuy_review_pct      = EXCLUDED.overbuy_review_pct,
    overbuy_review_dollars  = EXCLUDED.overbuy_review_dollars,
    notes                   = EXCLUDED.notes,
    updated_at              = now();

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260506000003_vendor_favorite_batches.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260506000003_vendor_favorite_batches.sql
--
-- Per-vendor explicit "favorite batch sizes" override. When set, takes
-- precedence over historical learning AND the generic cognitive ladder.
-- NULL means "use historical learning + cognitive ladder fallback".

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS favorite_batches INTEGER[];

COMMENT ON COLUMN public.vendor_reorder_policies.favorite_batches IS
    'Explicit batch sizes the recommender should snap to (e.g. {500,1000} for Colorful). When NULL, the recommender learns from PO history; when set, this overrides history.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260507_create_invoice_review_corpus.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create invoice_review_corpus table
-- Created: 2026-05-07
-- Background:
--   This table was defined in the legacy `migrations/` folder
--   (002_invoice_review_corpus.sql) but never copied into the active
--   `supabase/migrations/` pipeline, so it was never applied to Supabase.
--   The bot logs `[invoice-review-corpus] Upsert failed: Could not find the
--   table 'public.invoice_review_corpus' in the schema cache` every time the
--   AP pipeline tries to record a review-corpus row. Applying the original
--   schema verbatim, idempotently.

CREATE TABLE IF NOT EXISTS invoice_review_corpus (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_invoice_id UUID NOT NULL,
    pdf_storage_path TEXT,
    gmail_message_id TEXT,
    source_ref TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    expected_vendor_name TEXT,
    expected_invoice_number TEXT,
    expected_po_number TEXT,
    expected_invoice_date DATE,
    expected_total DECIMAL(12, 2),
    expected_freight DECIMAL(12, 2),
    expected_tax DECIMAL(12, 2),
    expected_line_item_count INTEGER,
    expected_match_status TEXT,
    expected_order_id TEXT,
    first_pass_strategy TEXT,
    first_pass_confidence TEXT,
    first_pass_po_number TEXT,
    first_pass_vendor_name TEXT,
    first_pass_total DECIMAL(12, 2),
    first_pass_line_item_count INTEGER,
    retry_pass_strategy TEXT,
    retry_pass_confidence TEXT,
    retry_pass_po_number TEXT,
    retry_pass_vendor_name TEXT,
    retry_pass_total DECIMAL(12, 2),
    retry_pass_line_item_count INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT invoice_review_corpus_vendor_invoice_unique UNIQUE (vendor_invoice_id)
);

CREATE INDEX IF NOT EXISTS invoice_review_corpus_status_idx
    ON invoice_review_corpus(review_status);

CREATE INDEX IF NOT EXISTS invoice_review_corpus_expected_po_idx
    ON invoice_review_corpus(expected_po_number);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260507_add_playbook_columns.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add playbook_kind + playbook_state to agent_task
-- Created: 2026-05-07
-- Purpose: Layer B of the self-healing system. Make "what is being done
--          about this task" a first-class field instead of inferring from
--          status. The Layer C runner will read these to know what to
--          dispatch; until then they are populated only by manual triage
--          (e.g. reconciler approval rows mark themselves manual_only).
--
-- Rollback:
--   ALTER TABLE agent_task DROP COLUMN playbook_state;
--   ALTER TABLE agent_task DROP COLUMN playbook_kind;
--   DROP INDEX IF EXISTS idx_agent_task_playbook_kind;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS playbook_kind TEXT;

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS playbook_state TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_task_playbook_state_check'
    ) THEN
        ALTER TABLE public.agent_task
            ADD CONSTRAINT agent_task_playbook_state_check
            CHECK (
                playbook_state IS NULL
                OR playbook_state IN (
                    'queued',
                    'running',
                    'succeeded',
                    'failed',
                    'manual_only'
                )
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_task_playbook_kind
    ON public.agent_task (playbook_kind, playbook_state)
    WHERE playbook_kind IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260508_max_retries_default.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: agent_task.max_retries default 3
-- Created: 2026-05-08
-- Purpose: Layer C runner uses retry_count < max_retries as the stop
--          condition for autonomous attempts. Existing rows have
--          max_retries = 0 (set by the phase 1 schema), which would
--          escalate every queued playbook on the first failure with no
--          retry budget. Default to 3 going forward; backfill 3 for any
--          row that has a playbook_kind set.
--
-- Rollback:
--   ALTER TABLE agent_task ALTER COLUMN max_retries DROP DEFAULT;

ALTER TABLE public.agent_task
    ALTER COLUMN max_retries SET DEFAULT 3;

UPDATE public.agent_task
SET max_retries = 3
WHERE playbook_kind IS NOT NULL
  AND (max_retries IS NULL OR max_retries < 3);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260509_create_agent_issue.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create agent_issue parent ledger + extend task_history for issues
-- Created: 2026-05-09
-- Purpose: Phase 1 of agentic issue lifecycle. Issues group related agent_task
--          rows under a parent ledger with explicit lifecycle / autonomy /
--          blocker / next_action fields. Phase 1 is additive — existing
--          agent_task writes proceed unchanged. A projection cron derives
--          issues from tasks via shared business-flow key.
--
-- Rollback:
--   DROP INDEX IF EXISTS idx_task_history_issue_event;
--   ALTER TABLE task_history DROP CONSTRAINT IF EXISTS task_history_task_or_issue_check;
--   ALTER TABLE task_history ALTER COLUMN task_id SET NOT NULL;
--   ALTER TABLE task_history DROP COLUMN IF EXISTS issue_id;
--   DROP INDEX IF EXISTS idx_agent_task_issue_id;
--   ALTER TABLE agent_task DROP COLUMN IF EXISTS issue_id;
--   DROP INDEX IF EXISTS idx_agent_issue_owner_priority;
--   DROP INDEX IF EXISTS idx_agent_issue_business_flow_key;
--   DROP INDEX IF EXISTS idx_agent_issue_lifecycle_state;
--   DROP INDEX IF EXISTS uq_agent_issue_business_flow_open;
--   DROP TABLE IF EXISTS agent_issue;

CREATE TABLE IF NOT EXISTS public.agent_issue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    source_table    TEXT,
    source_id       TEXT,
    business_flow_key TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL DEFAULT 'detected'
        CHECK (lifecycle_state IN ('detected','triaging','working','waiting_external','blocked','complete')),
    autonomy_state  TEXT
        CHECK (autonomy_state IS NULL OR autonomy_state IN ('working','waiting','retrying','resolved','needs_policy')),
    current_handler TEXT,
    blocker_reason  TEXT
        CHECK (blocker_reason IS NULL OR blocker_reason IN (
            'missing_receipt','po_not_found','vendor_mismatch','extraction_failed',
            'policy_required','external_pending','duplicate_or_conflict',
            'source_unavailable','auth_required','data_integrity_error',
            'retry_exhausted','human_approval_required','unknown'
        )),
    next_action     TEXT,
    priority        SMALLINT NOT NULL DEFAULT 2,
    owner           TEXT NOT NULL DEFAULT 'aria',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT agent_issue_priority_range CHECK (priority BETWEEN 0 AND 9)
);

-- Open business-flow keys must be unique. Closed/complete rows can repeat
-- (e.g. same flow re-fired after a complete).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_issue_business_flow_open
    ON public.agent_issue (business_flow_key)
    WHERE lifecycle_state IN ('detected','triaging','working','waiting_external','blocked');

CREATE INDEX IF NOT EXISTS idx_agent_issue_lifecycle_state
    ON public.agent_issue (lifecycle_state, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_issue_business_flow_key
    ON public.agent_issue (business_flow_key);

CREATE INDEX IF NOT EXISTS idx_agent_issue_owner_priority
    ON public.agent_issue (owner, priority, created_at DESC);

ALTER TABLE public.agent_task
    ADD COLUMN IF NOT EXISTS issue_id UUID REFERENCES public.agent_issue(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_task_issue_id
    ON public.agent_task (issue_id)
    WHERE issue_id IS NOT NULL;

-- Issue-scoped events live in the same task_history ledger as task events,
-- but task_history.task_id is FK'd to agent_task — passing an agent_issue.id
-- would silently fail FK validation. Add a parallel issue_id column so
-- issue events have a real home.
ALTER TABLE public.task_history
    ADD COLUMN IF NOT EXISTS issue_id UUID REFERENCES public.agent_issue(id) ON DELETE SET NULL;

ALTER TABLE public.task_history
    ALTER COLUMN task_id DROP NOT NULL;

-- Use NOT VALID so the constraint applies to new rows only.
-- The DB already has ~2k task_history rows with task_id IS NULL — those
-- predate this design and we don't want to backfill placeholders.
-- Run a manual `ALTER ... VALIDATE CONSTRAINT` later if Will wants to
-- enforce retroactively after cleanup.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'task_history_task_or_issue_check'
    ) THEN
        ALTER TABLE public.task_history
            ADD CONSTRAINT task_history_task_or_issue_check
            CHECK (task_id IS NOT NULL OR issue_id IS NOT NULL)
            NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_history_issue_event
    ON public.task_history (issue_id, created_at DESC)
    WHERE issue_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260509100000_task_history_issue_cascade.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: task_history.issue_id should ON DELETE CASCADE, not SET NULL
-- Created: 2026-05-09
-- Purpose: Original 20260509 set FK action to SET NULL. But task_history rows
--          can have task_id=NULL (issue-only events), so SET NULL on issue_id
--          would leave both NULL — violating the task_or_issue CHECK on the
--          implicit UPDATE postgres performs during cascade.
--
--          Issue-scoped events belong to their issue; when the issue is
--          deleted (rare — usually only via test/smoke cleanup), the events
--          should go with it. CASCADE is the right semantic.
--
-- Rollback:
--   ALTER TABLE task_history DROP CONSTRAINT task_history_issue_id_fkey;
--   ALTER TABLE task_history ADD CONSTRAINT task_history_issue_id_fkey
--     FOREIGN KEY (issue_id) REFERENCES agent_issue(id) ON DELETE SET NULL;

ALTER TABLE public.task_history
    DROP CONSTRAINT IF EXISTS task_history_issue_id_fkey;

ALTER TABLE public.task_history
    ADD CONSTRAINT task_history_issue_id_fkey
    FOREIGN KEY (issue_id) REFERENCES public.agent_issue(id) ON DELETE CASCADE;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260510_create_agent_budget.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create agent_budget — Phase 4 of the path-forward plan
-- Created: 2026-05-10
-- Purpose: Per-agent monthly USD + token caps with hard-stop enforcement.
--          The LLM tier routing (src/lib/intelligence/llm.ts) charges this
--          table after every call; checkBudget() refuses calls when an
--          agent has exceeded its monthly cap. Period roll-over happens
--          on the first call of a new calendar month.
--
-- Backfill: known Aria agents get sensible defaults. Will (the human
-- board) gets a higher cap; per-task agents (ap-identifier, watchdog,
-- nightshift) get smaller caps because they fire often but small.
--
-- Rollback:
--   DROP TABLE IF EXISTS agent_budget;

CREATE TABLE IF NOT EXISTS public.agent_budget (
    agent_id                    TEXT PRIMARY KEY,
    monthly_usd_cap             NUMERIC(10,2) NOT NULL DEFAULT 50.00,
    monthly_token_cap           BIGINT,
    current_period_start        TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    current_period_usd_spent    NUMERIC(10,2) NOT NULL DEFAULT 0,
    current_period_tokens_spent BIGINT NOT NULL DEFAULT 0,
    paused_until                TIMESTAMPTZ,
    last_charged_at             TIMESTAMPTZ,
    notes                       TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_budget_caps_nonneg CHECK (monthly_usd_cap >= 0 AND (monthly_token_cap IS NULL OR monthly_token_cap >= 0)),
    CONSTRAINT agent_budget_spent_nonneg CHECK (current_period_usd_spent >= 0 AND current_period_tokens_spent >= 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_budget_paused
    ON public.agent_budget (paused_until)
    WHERE paused_until IS NOT NULL;

-- Backfill known agents. ON CONFLICT DO NOTHING so re-running is safe.
INSERT INTO public.agent_budget (agent_id, monthly_usd_cap, notes)
VALUES
    ('ap-agent',            50.00, 'AP inbox poller — bulk classification + extraction'),
    ('ap-reconciler',       30.00, 'AP reconciliation engine — fewer calls, deeper'),
    ('ap-identifier',       10.00, 'Email intent classifier — high frequency, small calls'),
    ('reconciliation',      20.00, 'Catalog umbrella for reconciler agents'),
    ('purchasing',          20.00, 'Purchasing intelligence + draft PO suggestions'),
    ('build-risk',           5.00, 'Daily build risk cron — low LLM use'),
    ('watchdog',             5.00, 'Slack watchdog — small classification per channel'),
    ('supervisor',          10.00, 'Cron supervision + escalation'),
    ('tracking',            10.00, 'Carrier tracking + shipment intelligence'),
    ('vendor-intelligence', 10.00, 'Vendor enrichment via Firecrawl + memory'),
    ('nightshift',           5.00, 'Overnight Ollama pre-classification (mostly free)'),
    ('ops-manager',          5.00, 'Cron orchestration only — minimal LLM'),
    ('aria-bot',            50.00, 'Telegram conversational surface'),
    ('will',               100.00, 'Human board — dashboard + ad-hoc invocations')
ON CONFLICT (agent_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260511_create_sku_pack_sizes.sql
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sku_pack_sizes (
    sku TEXT PRIMARY KEY,
    units_per_pack INTEGER NOT NULL,
    pack_unit TEXT NOT NULL DEFAULT 'case',
    ea_unit_price NUMERIC(12,2),
    source TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sku_pack_sizes_source ON sku_pack_sizes(source);

COMMENT ON TABLE sku_pack_sizes IS
    'Canonical pack-size registry: 1 pack_unit = units_per_pack eaches. '
    'Used by purchasing intelligence, draft PO creation, and invoice reconciliation '
    'to keep UOM assumptions in one place.';

-- Seed from existing vendor_case_multipliers knowledge
INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, source, notes)
VALUES
    ('EM102', 12, 'case', 'teraganix_invoice', 'EM-1 32oz case of 12'),
    ('EM108', 12, 'case', 'teraganix_invoice', 'EM-1 16oz case of 12'),
    ('EM103', 4,  'case', 'teraganix_invoice', 'EM-1 1 gallon case of 4'),
    ('EM105', 1,  'each', 'teraganix_invoice', 'EM-1 5 gallon each')
ON CONFLICT (sku) DO UPDATE SET
    units_per_pack = EXCLUDED.units_per_pack,
    pack_unit      = EXCLUDED.pack_unit,
    source         = EXCLUDED.source,
    notes          = EXCLUDED.notes,
    updated_at     = NOW();

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260511_seed_uline_pack_sizes.sql
-- ════════════════════════════════════════════════════════════════

-- Seed ULINE pack sizes for shop-supplies SKUs sold by carton.
-- Will called these out 2026-05-11: receiving must enter as eaches, not cartons,
-- so cost-per-each lands correctly in inventory.
--
-- Pattern: 1 carton = 500 eaches, list price ~$164/carton → $0.328/each.
-- Add more rows here as we identify additional carton-pack ULINE SKUs.

INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, source, notes)
VALUES
    ('S-1665', 500, 'carton', 'uline_catalog', 'ULINE poly bag — 500/carton'),
    ('S-1667', 500, 'carton', 'uline_catalog', 'ULINE poly bag — 500/carton')
ON CONFLICT (sku) DO UPDATE SET
    units_per_pack = EXCLUDED.units_per_pack,
    pack_unit      = EXCLUDED.pack_unit,
    source         = EXCLUDED.source,
    notes          = EXCLUDED.notes,
    updated_at     = NOW();

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260512_create_reconciliation_outcomes.sql
-- ════════════════════════════════════════════════════════════════

-- Phase 1a observability: structured reconciliation outcome tracking.
-- Replaces freeform ap_activity_log entries with typed rows for dashboards and digests.

CREATE TABLE IF NOT EXISTS reconciliation_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL,
  invoice_id TEXT,
  po_id TEXT,
  vendor_name TEXT,
  outcome TEXT NOT NULL,
  outcome_meta JSONB,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

COMMENT ON COLUMN reconciliation_outcomes.outcome IS
  'Enum-by-convention. Allowed values:
    auto_applied        — reconciler updated the PO automatically (within thresholds)
    pending_approval    — queued to ap_pending_approvals, awaiting Will
    approved_by_user    — Will approved a pending proposal
    rejected_by_user    — Will rejected a pending proposal
    expired             — pending approval hit 24h TTL with no decision
    match_failed        — invoice arrived but no PO match found
    rejected_10x        — guardrail blocked: >=10x price magnitude shift
    rejected_invariant  — guardrail blocked: subtotal mismatch or price reasonableness check failed
    received_only       — receiving event without reconciliation context (future use; reserve)
  ';

CREATE INDEX IF NOT EXISTS idx_recon_outcomes_outcome_date ON reconciliation_outcomes (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_vendor ON reconciliation_outcomes (vendor_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_invoice ON reconciliation_outcomes (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_po ON reconciliation_outcomes (po_id) WHERE po_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260513_fix_reconciliation_outcomes.sql
-- ════════════════════════════════════════════════════════════════

-- Fix 3 reviewer-flagged issues from 20260512_create_reconciliation_outcomes.sql.
-- Table has zero rows, making all changes safe.

-- Issue 1: run_id should be UUID to match reconciliation_runs.id primary key type.
-- Avoids explicit casts on joins and ensures index compatibility.
ALTER TABLE reconciliation_outcomes
  ALTER COLUMN run_id TYPE UUID USING run_id::uuid;

-- Issue 2: Remove received_only from the outcome column comment (scope creep; no writer exists).
COMMENT ON COLUMN reconciliation_outcomes.outcome IS
  'Enum-by-convention. Allowed values:
    auto_applied        — reconciler updated the PO automatically (within thresholds)
    pending_approval    — queued to ap_pending_approvals, awaiting Will
    approved_by_user    — Will approved a pending proposal
    rejected_by_user    — Will rejected a pending proposal
    expired             — pending approval hit 24h TTL with no decision
    match_failed        — invoice arrived but no PO match found
    rejected_10x        — guardrail blocked: >=10x price magnitude shift
    rejected_invariant  — guardrail blocked: subtotal mismatch or price reasonableness check failed
  ';

-- Issue 3: Make idx_recon_outcomes_vendor a partial index (WHERE vendor_name IS NOT NULL),
-- consistent with idx_recon_outcomes_invoice and idx_recon_outcomes_po patterns.
DROP INDEX IF EXISTS idx_recon_outcomes_vendor;
CREATE INDEX IF NOT EXISTS idx_recon_outcomes_vendor
  ON reconciliation_outcomes (vendor_name, created_at DESC)
  WHERE vendor_name IS NOT NULL;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260514_activity_human_workflow.sql
-- ════════════════════════════════════════════════════════════════

-- Activity Human Workflow columns
-- Adds human annotation + process state fields to ap_activity_log

ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS human_note TEXT,
ADD COLUMN IF NOT EXISTS human_note_by TEXT,
ADD COLUMN IF NOT EXISTS human_note_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS process_state TEXT CHECK (process_state IN ('new','opened','waiting_on_vendor','handled','learned')),
ADD COLUMN IF NOT EXISTS resolution TEXT,
ADD COLUMN IF NOT EXISTS learning_candidate BOOLEAN DEFAULT FALSE;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260514_fix_stale_cron_kebab_names.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Fix false-positive stale cron alerts after kebab-case rename
-- Created: 2026-05-07
-- Background:
--   The cron framework (src/cron/) writes cron_runs.task_name in kebab-case
--   (e.g. 'ap-polling', 'po-sync'), while the ops_health_summary view's
--   cron_thresholds CTE was still asserting PascalCase names from the legacy
--   ops-manager (e.g. 'APPolling', 'POSync'). Result: every monitored job
--   appeared stale forever, ops-health-check edge function paged Telegram on
--   every restart, and the in-bot cron-watchdog kept screaming `stale_cron:*`.
--
--   This migration swaps the CTE values to the kebab-case names actually used
--   by `defineJob({ name: ... })` entries in src/cron/jobs/index.ts.
--   Also drops 'PurchasingCalendarSync' from the watchlist — it ticks every
--   4h, sometimes longer in practice (legitimate slow tick), and was firing
--   nuisance alerts.

CREATE OR REPLACE VIEW public.ops_health_summary AS
WITH now_ref AS (
    SELECT NOW() AS now_utc
),
latest_bot AS (
    SELECT heartbeat_at
    FROM public.agent_heartbeats
    WHERE agent_name = 'aria-bot'
    ORDER BY heartbeat_at DESC
    LIMIT 1
),
-- High-frequency "always running" jobs only. Once-daily/weekly jobs are NOT
-- listed — they legitimately go 20+ hours between runs.
-- Names match defineJob({ name: ... }) in src/cron/jobs/index.ts (kebab-case).
cron_thresholds AS (
    SELECT *
    FROM (
        VALUES
            ('ap-polling',                INTERVAL '25 minutes'),
            ('po-sync',                   INTERVAL '6 hours'),
            ('build-completion-watcher',  INTERVAL '45 minutes'),
            ('po-receiving-watcher',      INTERVAL '45 minutes'),
            ('stat-indexing',             INTERVAL '90 minutes'),
            ('purchasing-calendar-sync',  INTERVAL '6 hours')
    ) AS t(task_name, stale_after)
),
latest_crons AS (
    SELECT task_name, MAX(started_at) AS last_started_at
    FROM public.cron_runs
    GROUP BY task_name
),
stale_crons AS (
    SELECT COALESCE(jsonb_agg(t.task_name ORDER BY t.task_name), '[]'::jsonb) AS names
    FROM cron_thresholds t
    LEFT JOIN latest_crons c
        ON c.task_name = t.task_name
    CROSS JOIN now_ref n
    WHERE c.last_started_at IS NULL
       OR c.last_started_at < (n.now_utc - t.stale_after)
),
ap_email_queue AS (
    SELECT MIN(created_at) AS oldest_pending_at
    FROM public.email_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status IN ('unprocessed', 'processing')
      AND COALESCE(processed_by_ap, FALSE) = FALSE
),
ap_forward_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status IN ('PENDING_FORWARD', 'PROCESSING_FORWARD')
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE COALESCE(source_inbox, 'default') = 'ap'
              AND status = 'PROCESSING_FORWARD'
              AND updated_at < NOW() - INTERVAL '20 minutes'
        ) AS stuck_processing_count
    FROM public.ap_inbox_queue
),
nightshift_queue AS (
    SELECT
        MIN(created_at) FILTER (
            WHERE status IN ('pending', 'processing')
              AND (expires_at IS NULL OR expires_at >= NOW())
        ) AS oldest_pending_at,
        COUNT(*) FILTER (
            WHERE status = 'processing'
              AND (expires_at IS NULL OR expires_at >= NOW())
              AND updated_at < NOW() - INTERVAL '10 minutes'
        ) AS stuck_processing_count,
        MAX(processed_at) FILTER (
            WHERE status = 'completed'
              AND task_type IN ('email_classification', 'default_inbox_invoice')
        ) AS last_completed_at
    FROM public.nightshift_queue
),
pending_exceptions AS (
    SELECT COUNT(*) AS pending_count
    FROM public.ops_agent_exceptions
    WHERE status = 'pending'
),
last_ap_forward AS (
    SELECT MAX(updated_at) AS last_forwarded_at
    FROM public.ap_inbox_queue
    WHERE COALESCE(source_inbox, 'default') = 'ap'
      AND status = 'FORWARDED'
),
merged_backlog AS (
    SELECT
        CASE
            WHEN e.oldest_pending_at IS NULL THEN f.oldest_pending_at
            WHEN f.oldest_pending_at IS NULL THEN e.oldest_pending_at
            ELSE LEAST(e.oldest_pending_at, f.oldest_pending_at)
        END AS oldest_ap_backlog_at
    FROM ap_email_queue e
    CROSS JOIN ap_forward_queue f
)
SELECT
    NOW() AS generated_at,
    lb.heartbeat_at AS bot_heartbeat_at,
    CASE
        WHEN lb.heartbeat_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - lb.heartbeat_at)) / 60.0)::numeric, 1)
    END AS bot_heartbeat_age_minutes,
    COALESCE(sc.names, '[]'::jsonb) AS stale_crons,
    jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) AS stale_cron_count,
    mb.oldest_ap_backlog_at AS ap_queue_backlog_at,
    CASE
        WHEN mb.oldest_ap_backlog_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - mb.oldest_ap_backlog_at)) / 60.0)::numeric, 1)
    END AS ap_queue_backlog_age_minutes,
    COALESCE(afq.stuck_processing_count, 0) AS ap_processing_stuck_count,
    nq.oldest_pending_at AS nightshift_queue_backlog_at,
    CASE
        WHEN nq.oldest_pending_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.oldest_pending_at)) / 60.0)::numeric, 1)
    END AS nightshift_queue_backlog_age_minutes,
    COALESCE(nq.stuck_processing_count, 0) AS nightshift_processing_stuck_count,
    COALESCE(pe.pending_count, 0) AS pending_exception_count,
    laf.last_forwarded_at AS last_ap_forward_at,
    CASE
        WHEN laf.last_forwarded_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - laf.last_forwarded_at)) / 60.0)::numeric, 1)
    END AS last_ap_forward_age_minutes,
    nq.last_completed_at AS last_nightshift_completion_at,
    CASE
        WHEN nq.last_completed_at IS NULL THEN NULL
        ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - nq.last_completed_at)) / 60.0)::numeric, 1)
    END AS last_nightshift_completion_age_minutes,
    CASE
        WHEN jsonb_array_length(COALESCE(sc.names, '[]'::jsonb)) > 0
          OR COALESCE(afq.stuck_processing_count, 0) > 0
          OR COALESCE(nq.stuck_processing_count, 0) > 0
          OR COALESCE(pe.pending_count, 0) > 0
          OR (
              lb.heartbeat_at IS NOT NULL
              AND lb.heartbeat_at < NOW() - INTERVAL '10 minutes'
          )
          OR (
              mb.oldest_ap_backlog_at IS NOT NULL
              AND mb.oldest_ap_backlog_at < NOW() - INTERVAL '30 minutes'
          )
          OR (
              nq.oldest_pending_at IS NOT NULL
              AND nq.oldest_pending_at < NOW() - INTERVAL '60 minutes'
          )
        THEN 'degraded'
        ELSE 'healthy'
    END AS health_status
FROM latest_bot lb
FULL OUTER JOIN stale_crons sc ON TRUE
CROSS JOIN ap_forward_queue afq
CROSS JOIN nightshift_queue nq
CROSS JOIN pending_exceptions pe
CROSS JOIN last_ap_forward laf
CROSS JOIN merged_backlog mb;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260515_create_stockout_events.sql
-- ════════════════════════════════════════════════════════════════

-- ============================================================================
-- Stockout events — per-SKU log of when adjusted runway fell below lead time.
--
-- Detected at scan time in getBOMDemand. Reading the historical count lets
-- the urgency classifier pad lead time for SKUs that have stocked out before
-- — capturing the "burned by being late" signal lead-time medians can't.
-- ============================================================================

CREATE TABLE IF NOT EXISTS stockout_events (
    id BIGSERIAL PRIMARY KEY,
    product_id TEXT NOT NULL,
    vendor_party_id TEXT,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    detected_on DATE NOT NULL DEFAULT CURRENT_DATE,
    stock_on_hand NUMERIC,
    stock_on_order NUMERIC,
    daily_burn NUMERIC,
    runway_days NUMERIC,
    lead_time_days NUMERIC
);

-- One event row per SKU per day. Repeated scans on the same day upsert into
-- the same row rather than spamming the table.
CREATE UNIQUE INDEX IF NOT EXISTS stockout_events_product_day
    ON stockout_events (product_id, detected_on);

CREATE INDEX IF NOT EXISTS stockout_events_product
    ON stockout_events (product_id);

CREATE INDEX IF NOT EXISTS stockout_events_recent
    ON stockout_events (detected_at DESC);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260516_add_tracking_requested_at_l2.sql
-- ════════════════════════════════════════════════════════════════

-- ============================================================================
-- Track second-level vendor follow-up timestamp so po-followup-watcher can
-- escalate L1 → L2 → NONCOMM without losing state between cron ticks.
-- ============================================================================

ALTER TABLE "purchase_orders"
ADD COLUMN IF NOT EXISTS "tracking_requested_at_l2" TIMESTAMPTZ;

COMMENT ON COLUMN "purchase_orders"."tracking_requested_at_l2" IS
    'Second-level vendor follow-up timestamp. Set after L1 went 7+ days unanswered.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260517_add_vendor_party_id_to_purchase_orders.sql
-- ════════════════════════════════════════════════════════════════

-- Add vendor_party_id so the follow-up watcher and other tracking flows can
-- resolve the vendor's primary contact email via lookupVendorOrderEmail
-- without needing a second join through po_sends.

ALTER TABLE "purchase_orders"
ADD COLUMN IF NOT EXISTS "vendor_party_id" TEXT;

CREATE INDEX IF NOT EXISTS "idx_purchase_orders_vendor_party_id"
    ON "purchase_orders" ("vendor_party_id");

COMMENT ON COLUMN "purchase_orders"."vendor_party_id" IS
    'Finale party group ID for the vendor; mirrors po_sends.vendor_party_id.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260518_add_vendor_stated_eta.sql
-- ════════════════════════════════════════════════════════════════

-- Vendor-stated ETA / ship-date captured by the LLM extractor from
-- free-text vendor replies. Read by active-purchases as a high-confidence
-- ETA source above vendor-median lead time.

ALTER TABLE "purchase_orders"
ADD COLUMN IF NOT EXISTS "vendor_stated_eta"        DATE,
ADD COLUMN IF NOT EXISTS "vendor_stated_ship_date"  DATE,
ADD COLUMN IF NOT EXISTS "vendor_stated_eta_confidence" TEXT,
ADD COLUMN IF NOT EXISTS "vendor_stated_eta_extracted_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "vendor_stated_eta_rationale" TEXT;

COMMENT ON COLUMN "purchase_orders"."vendor_stated_eta" IS
    'Vendor-stated expected arrival date, parsed by LLM from a reply email.';
COMMENT ON COLUMN "purchase_orders"."vendor_stated_ship_date" IS
    'Vendor-stated ship date, parsed by LLM from a reply email.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260519_add_vendors_orders_email.sql
-- ════════════════════════════════════════════════════════════════

-- DECISION(2026-05-19, audit): split the order-routing address from the
-- generic vendor_emails[] list. po-correlator dumps EVERY address Aria has
-- ever seen on a PO thread into vendor_emails[] (sales rep, AR, AP, ops,
-- whoever happened to reply), and lookupVendorOrderEmail() blindly picks
-- vendor_emails[0]. That sent POs to bookkeepers who don't fulfill orders.
--
-- `orders_email` is the trusted address for outgoing PO emails. It's only
-- set by:
--   1. po-followup-watcher when a vendor REPLIES to one of our POs — the
--      responder is by definition the right person to talk to about orders
--      (write-back loop, self-correcting routing).
--   2. Will, manually.
--   3. enricher (web scrape — lowest trust, only used if nothing else set).
--
-- The `vendors` table referenced by older code does not exist on this
-- deployment, so we live on vendor_profiles (the table that's actually
-- populated and queried).

ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS orders_email TEXT;

ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS orders_email_source TEXT;

ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS orders_email_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN vendor_profiles.orders_email IS
  'Preferred address for outgoing PO emails. Higher priority than vendor_emails[] heuristic pick. Auto-set by po-followup-watcher when a vendor replies.';
COMMENT ON COLUMN vendor_profiles.orders_email_source IS
  'How orders_email was set: vendor_reply (auto, highest trust), manual (Will edited), enricher (web-scraped, lowest trust).';
COMMENT ON COLUMN vendor_profiles.orders_email_confirmed_at IS
  'Last time a vendor reply confirmed this address — prevents pointless re-writes on every reply.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260520_create_axiom_order_lifecycle.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create Axiom order templates and lifecycle tracker
-- Created: 2026-05-20
--
-- Purpose:
--   Axiom ordering must be SKU/template gated. A draft PO can start the
--   workflow, but website order preparation is allowed only when every SKU has
--   an explicit approved Axiom spec template.

CREATE TABLE IF NOT EXISTS public.axiom_order_templates (
    finale_sku TEXT PRIMARY KEY,
    axiom_job_name TEXT,
    spec JSONB NOT NULL DEFAULT '{}'::jsonb,
    auto_order_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    approved BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.axiom_order_lifecycle (
    po_number TEXT PRIMARY KEY,
    vendor_name TEXT NOT NULL DEFAULT 'Axiom Print',
    vendor_party_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'needs_spec',
        'blocked_duplicate',
        'ready_for_order_prep',
        'order_prep_started',
        'order_created',
        'invoice_received',
        'po_updated',
        'shipped',
        'received',
        'cancelled'
    )),
    finale_skus TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    template_skus TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    missing_template_skus TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    duplicate_blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL DEFAULT 'draft_po_trigger',
    source_ref TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_axiom_lifecycle_status
    ON public.axiom_order_lifecycle(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_axiom_lifecycle_skus
    ON public.axiom_order_lifecycle USING GIN(finale_skus);

CREATE INDEX IF NOT EXISTS idx_axiom_templates_approved
    ON public.axiom_order_templates(approved, updated_at DESC);

COMMENT ON TABLE public.axiom_order_templates IS
    'Approved per-SKU Axiom order specs. Automation cannot infer sticker options without a row here.';

COMMENT ON TABLE public.axiom_order_lifecycle IS
    'Tracks Axiom draft PO -> website order -> invoice -> shipment -> receipt lifecycle.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260520_create_axiom_sku_mappings.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Create axiom_sku_mappings table
-- Created: 2026-05-20
-- Rollback: DROP TABLE IF EXISTS axiom_sku_mappings;
--
-- DECISION(2026-05-20): Migrate hardcoded AXIOM_TO_FINALE SKU mappings to
-- a dynamic database table so they can be managed via the dashboard.

CREATE TABLE IF NOT EXISTS axiom_sku_mappings (
    axiom_job_name TEXT PRIMARY KEY,
    finale_skus TEXT[] NOT NULL,
    qty_fraction NUMERIC NOT NULL DEFAULT 1.0,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE axiom_sku_mappings IS 'Stores dynamic SKU mappings from Axiom Print Job Names to Finale SKUs';
COMMENT ON COLUMN axiom_sku_mappings.axiom_job_name IS 'The exact Job Name as provided in the Axiom invoice or API estimate';
COMMENT ON COLUMN axiom_sku_mappings.finale_skus IS 'The array of Finale product SKUs that this job name corresponds to';
COMMENT ON COLUMN axiom_sku_mappings.qty_fraction IS 'Fraction of total quantity assigned to each SKU (e.g. 0.5 for front/back split)';

-- Seed initial static mappings
INSERT INTO axiom_sku_mappings (axiom_job_name, finale_skus, qty_fraction, description) VALUES
    ('GNS11_12', ARRAY['GNS11', 'GNS21'], 0.5, 'GnarBar-Whole 2lb F+B'),
    ('GNAR BAR 2lbs', ARRAY['GNS11', 'GNS21'], 0.5, 'GnarBar-Whole 2lb F+B'),
    ('GNAR BAR 6 lbs', ARRAY['GNS12', 'GNS22'], 0.5, 'GnarBar-Whole 6lb F+B'),
    ('GnarBar062lbs', ARRAY['GNS16', 'GNS06'], 0.5, 'GnarBar-Milled 2lb F+B'),
    ('GnarBar07Milled', ARRAY['GNS17', 'GNS07'], 0.5, 'GnarBar-Milled 6lb F+B'),
    ('OAG104FRBK', ARRAY['OAG104LABELFR', 'OAG104LABELBK'], 0.5, 'FCB Castor Bean 1gal F+B'),
    ('OAG207FRBK', ARRAY['OAG207LABELFR', 'OAG207LABELBK'], 0.5, 'V-N 10-2-2 Veg 25lb F+B'),
    ('OAG211FRBK', ARRAY['OAG211LABELFR', 'OAG211LABELBK'], 0.5, 'V-TR 4-5-5 Trans 25lb F+B'),
    ('VCal OA Gallon Labels', ARRAY['OAG110LABELFR', 'OAG110LABELBK'], 0.5, 'VCal 1gal F+B'),
    ('VCal OA Pint Label', ARRAY['OAG109LABELFR', 'OAG109LABELBK'], 0.5, 'VCal 1pint F+B'),
    ('APL102', ARRAY['APL102'], 1.0, '3.0 Soil Cubic Foot Label'),
    ('APL105', ARRAY['APL105'], 1.0, 'B.A.F. 8.5x11 Label'),
    ('BBL101', ARRAY['BBL101'], 1.0, 'BuildASoil Big Label'),
    ('BBL101 124469', ARRAY['BBL101'], 1.0, 'BuildASoil Big Label (reorder)'),
    ('BABL101', ARRAY['BABL101'], 1.0, 'BuildASoil Big-ish Label'),
    ('DOM101', ARRAY['DOM101'], 1.0, 'Domain product label'),
    ('GBB08', ARRAY['GBB08'], 1.0, 'Gnar Bud Butter v8'),
    ('GBB07', ARRAY['GBB07'], 1.0, 'Gnar Bud Butter v7'),
    ('BAF00LABEL', ARRAY['BAF00LABEL'], 1.0, 'BAF00 product label'),
    ('BAF1G', ARRAY['BAF1G'], 1.0, 'BAF 1gal label'),
    ('KGD104', ARRAY['KGD104'], 1.0, 'KGD product label'),
    ('GA105', ARRAY['GA105'], 1.0, 'GA product label'),
    ('PU105L', ARRAY['PU105L'], 1.0, 'PU product label'),
    ('AG111', ARRAY['AG111'], 1.0, 'AG product label'),
    ('FCB1G', ARRAY['FCB1G'], 1.0, 'FCB 1gal label'),
    ('CWP DRINK SOME', ARRAY['CWP DRINK SOME'], 1.0, 'CWP sticker')
ON CONFLICT (axiom_job_name) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260520_create_flow_events_and_runs.sql
-- ════════════════════════════════════════════════════════════════

-- 20260520_create_flow_events_and_runs.sql
-- Substrate for the backend agentic flow path. Domain writes emit events to
-- `flow_events`; a registry of flows subscribes to event types; the flow
-- runner spawns `flow_runs` and advances them step-by-step. The Activity
-- board reads `flow_runs` as the source of truth for in-flight work.
--
-- Escalation is explicit: a step returning kind='escalate' (or exhausting
-- retries) flips the run to BREACHED and surfaces via agent_task. Silent
-- stalls are not possible — every run is RUNNING, SUCCEEDED, FAILED, or
-- BREACHED.
--
-- Phase 1 canary: dropship_forward (one step). Future flows:
-- po_lifecycle, invoice_reconcile, vendor_ack_watcher.

CREATE TABLE IF NOT EXISTS flow_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    correlation_id text,
    emitted_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_flow_events_unprocessed
    ON flow_events (emitted_at)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_flow_events_type ON flow_events (type);

CREATE TABLE IF NOT EXISTS flow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_name text NOT NULL,
    status text NOT NULL DEFAULT 'RUNNING',  -- RUNNING | SUCCEEDED | FAILED | BREACHED
    current_step text,
    triggered_by_event uuid REFERENCES flow_events(id),
    correlation_id text,
    inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
    state jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempts integer NOT NULL DEFAULT 0,
    deadline_at timestamptz,
    failure_reason text,
    escalated_task_id uuid,  -- agent_task.id when BREACHED
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_status   ON flow_runs (status);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow     ON flow_runs (flow_name);
CREATE INDEX IF NOT EXISTS idx_flow_runs_active   ON flow_runs (flow_name, correlation_id)
    WHERE status = 'RUNNING';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260520_ap_vendor_autonomy_phases.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add autonomy phase tracking to vendor_profiles
-- Created: 2026-05-20
-- Purpose: Track per-vendor "Noted" tap history to graduate vendors through
--          autonomy phases: 1=Surface (buttons), 2=Routine (daily digest), 3=Silent.
--          Will taps "Noted" on Telegram → counter increments → vendor graduates.
--          Will taps "Flag" → counter resets, vendor reverts to Phase 1.
--
-- Rollback:
--   ALTER TABLE vendor_profiles
--     DROP COLUMN IF EXISTS noted_count,
--     DROP COLUMN IF EXISTS flag_count,
--     DROP COLUMN IF EXISTS autonomy_phase,
--     DROP COLUMN IF EXISTS phase_upgraded_at,
--     DROP COLUMN IF EXISTS last_noted_at;

ALTER TABLE vendor_profiles
  ADD COLUMN IF NOT EXISTS noted_count       INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS flag_count        INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autonomy_phase    INTEGER     DEFAULT 1,
  ADD COLUMN IF NOT EXISTS phase_upgraded_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_noted_at     TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN vendor_profiles.noted_count IS
  'Number of consecutive "Noted" taps on invoice diffs for this vendor. Resets to 0 on any Flag tap.';

COMMENT ON COLUMN vendor_profiles.flag_count IS
  'Total number of "Flag" taps for this vendor. Never resets — audit trail.';

COMMENT ON COLUMN vendor_profiles.autonomy_phase IS
  'Current autonomy phase: 1=Surface (real-time Telegram + buttons), 2=Routine (daily digest only), 3=Silent (log only). Starts at 1.';

COMMENT ON COLUMN vendor_profiles.phase_upgraded_at IS
  'Timestamp when the vendor last graduated to a higher autonomy phase.';

COMMENT ON COLUMN vendor_profiles.last_noted_at IS
  'Timestamp of most recent "Noted" tap. Used for phase decay (30 days inactive → reconsider phase).';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260520144012_add_farm_fuel_vendor_aliases.sql
-- ════════════════════════════════════════════════════════════════

/**
 * @file    20260520144012_add_farm_fuel_vendor_aliases.sql
 * @purpose Add vendor aliases for Farm Fuel, Inc and additional Grassroots
 *          Fabric Pots name variants. These ensure resolveVendorAlias() maps
 *          OCR-extracted vendor names to the correct Finale supplier names so
 *          the PO vendor correlation waterfall has accurate names to compare.
 *
 * @decision Farm Fuel: An agricultural input vendor (concentrates, ferticel-class
 *           amendments, etc.) that ships truck freight — same class as Marion Ag.
 *           OCR reads "Farm Fuel, Inc" (with a comma) from their invoices; Finale
 *           stores the supplier as "Farm Fuel Inc." (no comma, trailing period).
 *           The mismatch doesn't break PO# matching when a PO# is on the invoice,
 *           but it degrades vendor correlation confidence from "high" to "medium",
 *           which can gate auto-apply on the downstream reconciler.
 *
 * @decision Grassroots: existing aliases cover "Grassroots Fabric Pots Inc" and
 *           "Grassroots Fabric Pots Inc." but not the bare "Grassroots Fabric Pots"
 *           that the LLM parser sometimes returns. Added the bare form as a
 *           belt-and-suspenders alias.
 *
 * Rollback:
 *   DELETE FROM vendor_aliases WHERE alias IN (
 *     'Farm Fuel, Inc', 'Farm Fuel Inc', 'Farm Fuel Inc.',
 *     'FARM FUEL INC', 'Grassroots Fabric Pots'
 *   );
 */

INSERT INTO vendor_aliases (alias, finale_supplier_name)
VALUES
    -- Farm Fuel: normalise OCR variants to exact Finale supplier name
    ('Farm Fuel, Inc',          'Farm Fuel Inc.'),
    ('Farm Fuel Inc',           'Farm Fuel Inc.'),
    ('FARM FUEL INC',           'Farm Fuel Inc.'),

    -- Grassroots: belt-and-suspenders for bare name and QuickBooks sender
    -- (bare "Grassroots Fabric Pots" is already in DB but add ON CONFLICT guard)
    ('Grassroots Fabric Pots',  'Grassroots Fabric Pots')
ON CONFLICT (alias) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260521_create_po_shipment_legs.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260521_create_po_shipment_legs.sql
--
-- Per-leg delivery schedule for bulk purchase orders.
-- A PO with no rows here behaves exactly as before (single-leg assumption in recommender).
-- When rows exist, the recommender credits only legs arriving within the lead-time window
-- rather than the full on-order quantity — preventing over-credit on multi-truck bulk orders.
--
-- Primary use cases:
--   Covico  (CWP101 worm castings) — typically 3 truck shipments ~30 days apart
--   Plantae (quillaja SKUs)         — typically 2 legs ~45 days apart
--
-- Rollback: DROP TABLE IF EXISTS public.po_shipment_legs;

CREATE TABLE IF NOT EXISTS public.po_shipment_legs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number           TEXT        NOT NULL,
    vendor_party_id     TEXT,                              -- Finale party ID (denormalized for query speed)
    vendor_name         TEXT,                              -- denormalized for readability
    leg_number          INTEGER     NOT NULL,              -- 1-based ordering within the PO
    expected_qty        NUMERIC(12, 2) NOT NULL,           -- units expected on this leg
    received_qty        NUMERIC(12, 2),                    -- NULL = not yet received
    expected_date       DATE        NOT NULL,              -- when we expect this leg to arrive
    actual_date         DATE,                              -- NULL = pending arrival
    tracking_number     TEXT,                              -- optional; filled when carrier provides it
    carrier_name        TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT po_shipment_legs_leg_number_pos CHECK (leg_number >= 1),
    CONSTRAINT po_shipment_legs_qty_pos        CHECK (expected_qty > 0),
    UNIQUE (po_number, leg_number)                        -- no duplicate leg numbers on a PO
);

-- Fast lookup by PO number (primary access pattern)
CREATE INDEX IF NOT EXISTS po_shipment_legs_po_number_idx
    ON public.po_shipment_legs (po_number);

-- Fast lookup of pending legs by expected date (recommender credit window)
CREATE INDEX IF NOT EXISTS po_shipment_legs_pending_date_idx
    ON public.po_shipment_legs (expected_date)
    WHERE actual_date IS NULL;

-- Vendor-level history for the "historical clarity" use case
CREATE INDEX IF NOT EXISTS po_shipment_legs_vendor_idx
    ON public.po_shipment_legs (vendor_party_id, expected_date DESC)
    WHERE vendor_party_id IS NOT NULL;

COMMENT ON TABLE public.po_shipment_legs IS
    'Per-leg delivery schedule for bulk purchase orders. '
    'When rows exist for a PO, the recommender credits only legs arriving within '
    'the lead-time window (not the full on-order qty). '
    'Empty = legacy single-leg behavior — no behavioral change for non-bulk vendors.';

COMMENT ON COLUMN public.po_shipment_legs.leg_number    IS '1-based delivery leg number within the PO.';
COMMENT ON COLUMN public.po_shipment_legs.expected_qty  IS 'Units expected to arrive on this leg.';
COMMENT ON COLUMN public.po_shipment_legs.received_qty  IS 'Units actually received. NULL until the leg arrives.';
COMMENT ON COLUMN public.po_shipment_legs.expected_date IS 'Target arrival date for this leg.';
COMMENT ON COLUMN public.po_shipment_legs.actual_date   IS 'Actual receipt date. NULL = pending.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260521_add_bulk_order_cols_to_vendor_reorder_policies.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260521_add_bulk_order_cols_to_vendor_reorder_policies.sql
--
-- Adds bulk-order metadata to vendor_reorder_policies.
-- is_bulk_vendor = true enables the leg-aware credit path in the recommender.
-- typical_leg_count / typical_leg_interval_days pre-populate the leg entry UI
-- and are used by the Telegram /legs command to suggest a default schedule.
--
-- Default-unchanged invariant: all existing vendors default to is_bulk_vendor = false
-- and keep exactly current behavior.
--
-- Rollback:
--   ALTER TABLE public.vendor_reorder_policies
--       DROP COLUMN IF EXISTS is_bulk_vendor,
--       DROP COLUMN IF EXISTS typical_leg_count,
--       DROP COLUMN IF EXISTS typical_leg_interval_days;

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS is_bulk_vendor              BOOLEAN  NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS typical_leg_count           INTEGER,    -- e.g. 3 = "usually 3 trucks"
    ADD COLUMN IF NOT EXISTS typical_leg_interval_days   INTEGER;    -- e.g. 30 = "one truck per month"

COMMENT ON COLUMN public.vendor_reorder_policies.is_bulk_vendor IS
    'When true, the recommender uses po_shipment_legs to credit incoming supply per-leg '
    'instead of crediting the full PO quantity at once.';
COMMENT ON COLUMN public.vendor_reorder_policies.typical_leg_count IS
    'Typical number of delivery legs for a bulk order from this vendor. '
    'Used to pre-populate the /legs command default schedule.';
COMMENT ON COLUMN public.vendor_reorder_policies.typical_leg_interval_days IS
    'Typical days between consecutive delivery legs from this vendor. '
    'Combined with typical_leg_count to auto-suggest leg dates.';

-- ── Seed Covico and Plantae ────────────────────────────────────────────────
-- TODO(will)[2026-05-21]: Replace '?????' with actual Finale party IDs.
--   Find them at: Finale → Contacts → [vendor name] → URL ends with /partygroup/{id}
--
-- INSERT INTO public.vendor_reorder_policies
--     (vendor_party_id, vendor_name, is_bulk_vendor, typical_leg_count, typical_leg_interval_days, notes)
-- VALUES
--     ('?????', 'Covico',  true, 3, 30, 'CWP101 worm castings — typically 3 truck shipments ~30d apart'),
--     ('?????', 'Plantae', true, 2, 45, 'Quillaja extract — typically 2 legs ~45d apart')
-- ON CONFLICT (vendor_party_id) DO UPDATE SET
--     is_bulk_vendor              = EXCLUDED.is_bulk_vendor,
--     typical_leg_count           = EXCLUDED.typical_leg_count,
--     typical_leg_interval_days   = EXCLUDED.typical_leg_interval_days,
--     notes                       = EXCLUDED.notes,
--     updated_at                  = now();

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260527_add_vendor_autonomy_levels.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add tiered autonomy levels to vendor_profiles
-- Created: 2026-05-27
-- Purpose: Track per-vendor autonomy settings: 0=Manual, 1=Auto-Draft, 2=Auto-Commit & Send
--
-- Rollback:
--   ALTER TABLE vendor_profiles DROP COLUMN IF EXISTS autonomy_level;

ALTER TABLE vendor_profiles
  ADD COLUMN IF NOT EXISTS autonomy_level INTEGER DEFAULT 0;

COMMENT ON COLUMN vendor_profiles.autonomy_level IS
  'Tiered autonomy setting: 0=Manual (recs only), 1=Auto-Draft (create drafts automatically), 2=Auto-Commit & Send (full autonomous PO flow). Default is 0.';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260528_add_last_nudge_at_to_slack_requests.sql
-- ════════════════════════════════════════════════════════════════

-- Add last_nudge_at to slack_requests for follow-up SOP cooldown tracking.
-- Used by: followup-sop cron job, /followup Telegram command.
-- Part of: core-04 (Slack/Email responder — auto-ack + follow-up SOP)

ALTER TABLE slack_requests ADD COLUMN IF NOT EXISTS last_nudge_at timestamptz;

-- Index for the query that finds requests needing a nudge
CREATE INDEX IF NOT EXISTS idx_slack_requests_nudge
    ON slack_requests (status, created_at, last_nudge_at)
    WHERE status = 'pending';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260601_ap_activity_log_metadata_index.sql
-- ════════════════════════════════════════════════════════════════

-- GIN index for JSONB metadata lookups in po-receipt-recheck and other queries
-- Speeds up filter("metadata->poNumber", "eq", ...) queries on ap_activity_log
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_metadata_poNumber
    ON ap_activity_log USING GIN (metadata jsonb_path_ops)
    WHERE metadata ? 'poNumber';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260601_po_lifecycle_state.sql
-- ════════════════════════════════════════════════════════════════

-- PO Lifecycle State Machine
-- Tracks every PO through: ORDERED → INVOICED → RECONCILED → RECEIVED → COMPLETED
-- Part of the cohesive AP pipeline (kaizen 2026-06-01)

-- Add lifecycle state to purchase_orders
ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'ORDERED';

CREATE INDEX IF NOT EXISTS idx_purchase_orders_lifecycle
    ON purchase_orders(lifecycle_state, updated_at DESC);

-- State transition audit log
CREATE TABLE IF NOT EXISTS po_lifecycle_transitions (
    id SERIAL PRIMARY KEY,
    po_number VARCHAR(50) NOT NULL,
    from_state VARCHAR(20) NOT NULL,
    to_state VARCHAR(20) NOT NULL,
    transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triggered_by VARCHAR(50) NOT NULL,
    metadata JSONB,
    invoice_id VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_po_lifecycle_po
    ON po_lifecycle_transitions(po_number, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_po_lifecycle_state
    ON po_lifecycle_transitions(to_state, transitioned_at DESC);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260601_po_lifecycle_v2_dispatch_states.sql
-- ════════════════════════════════════════════════════════════════

-- PO Lifecycle State Migration V2
-- Adds dispatch stages: REVIEW, SENT, ACKNOWLEDGED, CANCELLED
-- Part of the trust-building pipeline (kaizen 2026-06-01)
--
-- Backward compatible: existing POs with state 'ORDERED' keep their state.
-- New POs default to 'REVIEW' instead of 'ORDERED'.

-- Widen column to fit longer state names (ACKNOWLEDGED = 12 chars)
ALTER TABLE purchase_orders
ALTER COLUMN lifecycle_state TYPE VARCHAR(30);

-- Change default from ORDERED to REVIEW for new POs
ALTER TABLE purchase_orders
ALTER COLUMN lifecycle_state SET DEFAULT 'REVIEW';

-- Add CANCELLED to po_lifecycle_transitions to_state (widen there too)
ALTER TABLE po_lifecycle_transitions
ALTER COLUMN from_state TYPE VARCHAR(30);

ALTER TABLE po_lifecycle_transitions
ALTER COLUMN to_state TYPE VARCHAR(30);

-- Update existing null/empty states to REVIEW
UPDATE purchase_orders
SET lifecycle_state = 'REVIEW'
WHERE lifecycle_state IS NULL OR lifecycle_state = '';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260601_vendor_pattern_rpc.sql
-- ════════════════════════════════════════════════════════════════

-- Supabase RPC for vendor_po_patterns upsert
-- Single-call upsert that handles both fail/success increment in one transaction
CREATE OR REPLACE FUNCTION upsert_vendor_po_pattern(
    p_vendor_name TEXT,
    p_last_failed_at TIMESTAMPTZ DEFAULT NULL,
    p_last_matched_at TIMESTAMPTZ DEFAULT NULL,
    p_increment_fail BOOLEAN DEFAULT FALSE,
    p_increment_success BOOLEAN DEFAULT FALSE,
    p_po_format_hint TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO vendor_po_patterns (vendor_name, fail_count, success_count, last_failed_at, last_matched_at, po_format_hint)
    VALUES (
        p_vendor_name,
        CASE WHEN p_increment_fail THEN 1 ELSE 0 END,
        CASE WHEN p_increment_success THEN 1 ELSE 0 END,
        p_last_failed_at,
        p_last_matched_at,
        p_po_format_hint
    )
    ON CONFLICT (vendor_name) DO UPDATE SET
        fail_count = vendor_po_patterns.fail_count + CASE WHEN p_increment_fail THEN 1 ELSE 0 END,
        success_count = vendor_po_patterns.success_count + CASE WHEN p_increment_success THEN 1 ELSE 0 END,
        last_failed_at = COALESCE(p_last_failed_at, vendor_po_patterns.last_failed_at),
        last_matched_at = COALESCE(p_last_matched_at, vendor_po_patterns.last_matched_at),
        po_format_hint = COALESCE(p_po_format_hint, vendor_po_patterns.po_format_hint),
        confidence = LEAST(1.0, vendor_po_patterns.confidence + CASE WHEN p_increment_success THEN 0.05 ELSE 0 END),
        updated_at = NOW();
END;
$$;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260601_vendor_po_patterns.sql
-- ════════════════════════════════════════════════════════════════

-- Vendor PO Pattern Learning
-- Tracks per-vendor PO match success/failure to improve OCR extraction
-- Part of the cohesive AP pipeline (kaizen 2026-06-01)

CREATE TABLE IF NOT EXISTS vendor_po_patterns (
    id SERIAL PRIMARY KEY,
    vendor_name TEXT NOT NULL UNIQUE,
    po_format_hint TEXT,          -- LLM prompt hint for PO extraction
    examples JSONB DEFAULT '[]',  -- Array of {poNumber, invoiceDate, total, success: bool}
    confidence FLOAT DEFAULT 0.5, -- How confident we are in the pattern (0.0-1.0)
    fail_count INT DEFAULT 0,     -- Total PO match failures
    success_count INT DEFAULT 0,  -- Total PO match successes
    last_failed_at TIMESTAMPTZ,
    last_matched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_po_patterns_vendor
    ON vendor_po_patterns(vendor_name);

CREATE INDEX IF NOT EXISTS idx_vendor_po_patterns_confidence
    ON vendor_po_patterns(confidence DESC);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260610_colorful_lead_time_update.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260610_colorful_lead_time_update.sql
--
-- Update Colorful Packaging's vendor_reorder_policies to reflect the actual
-- build/ship time from payment (60 days, not the original 45d estimate).
--
-- Bill confirmed 2026-06-10:
--   - Lead time: 60 days from payment (was 45d)
--   - Cover target: 180 days (6 months of bagging supply) — already correct
--   - MOQ mode: 'warn' (keep — CC vendor, no hard MOQ enforcement needed on drafts)
--
-- The target_cover_days stays at 180 — orders roughly 6 months of supply.
-- With the 60d lead time now correct, the BOM pipeline will:
--   - Classify urgency correctly (critical when adjustedRunway < 60d)
--   - Suggest qty = dailyBurn × 180d - stockOnHand
--   - Project next-order-date correctly

UPDATE public.vendor_reorder_policies
SET
    lead_time_override_days = 60,
    notes = 'Custom bagging: 60 day build/ship from payment. Order 4-6 months supply at a time.',
    updated_at = now()
WHERE vendor_party_id = '10918';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260610_vendor_lead_time_tracking.sql
-- ════════════════════════════════════════════════════════════════

-- supabase/migrations/20260610_vendor_lead_time_tracking.sql
--
-- Adds observed lead-time statistics + auto-update opt-in for vendor policies.
--
-- Layer 1: vendor_lead_time_stats — persist observed P50/P90/on-time-rate
-- Layer 3: auto_update_override on vendor_reorder_policies — opt-in auto-update
--          with drift-detection guardrails

-- ── Layer 1: Observed lead time stats ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendor_lead_time_stats (
    vendor_party_id            TEXT PRIMARY KEY,
    vendor_name                TEXT,
    sample_count               INTEGER NOT NULL DEFAULT 0,
    p50_days                   INTEGER,
    p90_days                   INTEGER,
    avg_days_recent_30         INTEGER,
    on_time_rate               NUMERIC(4,3),
    spread_days                INTEGER,
    first_po_date              DATE,
    last_po_date               DATE,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.vendor_lead_time_stats IS
    'Nightly-observed lead time aggregates from Finale PO history. Source of truth for drift detection.';

COMMENT ON COLUMN public.vendor_lead_time_stats.spread_days IS
    'Days between first and last PO in sample. Used as stability signal for auto-update guardrails.';

COMMENT ON COLUMN public.vendor_lead_time_stats.avg_days_recent_30 IS
    'Average lead time for POs received in the last 30 days. Catches trend shifts (vendor slowing down).';

-- ── Layer 3: Auto-update opt-in + rate-limiting ────────────────────
ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS auto_update_override BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS override_last_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.vendor_reorder_policies.auto_update_override IS
    'When TRUE, nightly cron may auto-update lead_time_override_days when drift is detected and guardrails pass.';

COMMENT ON COLUMN public.vendor_reorder_policies.override_last_updated_at IS
    'Last time lead_time_override_days was auto-updated. Rate-limits to one update per 30 days.';

-- ── Seed Colorful with auto-update OFF (conservative default) ──────
UPDATE public.vendor_reorder_policies
SET auto_update_override = FALSE
WHERE vendor_party_id = '10918';

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260611_add_jit_task_types.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add jit_order_trigger + cron_summary + cognitive_critical to agent_task type CHECK
-- Created: 2026-06-11
-- Purpose: JIT forward projection routes cron alerts through the agent_task hub.
--          Three new task types: jit_order_trigger (SKU order triggers, 72h auto-close),
--          cron_summary (daily AP reports, 24h auto-close), and cognitive_critical
--          (critical cognitive round decisions, no auto-close).
--          The type column has a CHECK constraint that must permit these literals
--          or all inserts fail silently — breaking the entire task-first notification path.
--
-- Rollback:
--   ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;
--   ALTER TABLE public.agent_task
--     ADD CONSTRAINT agent_task_type_check
--     CHECK (type IN ('cron_failure','approval','dropship_forward','po_send_confirm',
--                     'agent_exception','control_command','manual','code_change',
--                     'stuck_source','ci_failure','tripwire_violation'));

ALTER TABLE public.agent_task DROP CONSTRAINT IF EXISTS agent_task_type_check;

ALTER TABLE public.agent_task
    ADD CONSTRAINT agent_task_type_check
    CHECK (type IN (
        'cron_failure',
        'approval',
        'dropship_forward',
        'po_send_confirm',
        'agent_exception',
        'control_command',
        'manual',
        'code_change',
        'stuck_source',
        'ci_failure',
        'tripwire_violation',
        'jit_order_trigger',
        'cron_summary',
        'cognitive_critical'
    ));

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260611_vendor_standard_order_qty.sql
-- ════════════════════════════════════════════════════════════════

/**
 * v2.6 — Add standard_order_qty to vendor_reorder_policies.
 *
 * Per-vendor explicit ordering floor. "Faust always gets 20."
 * When set, the qty-recommender enforces this as a HARD floor
 * on suggestedQty, preventing POs from going out under the
 * vendor's typical order amount.
 *
 * NULL = use historical auto-detect (skuPurchaseHistory pattern).
 */

ALTER TABLE vendor_reorder_policies
ADD COLUMN IF NOT EXISTS standard_order_qty integer;

COMMENT ON COLUMN vendor_reorder_policies.standard_order_qty
IS 'Per-vendor standard order quantity. When set, recommender enforces this as a floor on suggestedQty. NULL = use historical auto-detect.';

-- Backfill Faust Bio Agriculture with standard order qty of 20
-- (consistent historical pattern — every PO has been 20 units)
UPDATE vendor_reorder_policies
SET standard_order_qty = 20
WHERE vendor_party_id IN (
    SELECT DISTINCT vendor_party_id
    FROM vendor_reorder_policies
    WHERE vendor_name ILIKE '%faust%'
);

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260615_add_addressed_flags_to_slack_requests.sql
-- ════════════════════════════════════════════════════════════════

-- Add addressed_to_bill and is_dm flags to slack_requests for daily accountability review.
-- Captures DMs to Bill and @Bill mentions in channels (beyond just #purchase-orders SKU requests).
-- Used by: addressed-message-watcher / daily-slack-review cron, extends existing slack_requests ledger.
-- Part of: 2026-06-15 daily Slack review feature (closes DM/@mention gap).

ALTER TABLE slack_requests ADD COLUMN IF NOT EXISTS addressed_to_bill boolean DEFAULT false;
ALTER TABLE slack_requests ADD COLUMN IF NOT EXISTS is_dm boolean DEFAULT false;

-- Index for the daily review query (filter recent addressed messages)
CREATE INDEX IF NOT EXISTS idx_slack_requests_addressed
    ON slack_requests (addressed_to_bill, created_at, status)
    WHERE addressed_to_bill = true;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260618_add_po_sends_gmail_thread_id.sql
-- ════════════════════════════════════════════════════════════════

-- Migration: Add gmail_thread_id to po_sends
-- Purpose: Store the Gmail thread ID when a PO is emailed, so the
--          po-reply-watcher can check for vendor replies in the same thread.
--          Also backfills from existing gmail_message_id where possible.
-- Author:  Hermia
-- Created: 2026-06-18

ALTER TABLE public.po_sends
ADD COLUMN IF NOT EXISTS gmail_thread_id text;

-- ════════════════════════════════════════════════════════════════
-- Migration: 20260623_colorful_tighten_cover.sql
-- ════════════════════════════════════════════════════════════════

-- Colorful Packaging: tighten target_cover_days from 180 → 90
-- 180d = "order 6 months" was too aggressive with 3 active POs.
-- 90d + 60d lead time = 150d threshold: items below 150d trigger order.
UPDATE vendor_reorder_policies
SET target_cover_days = 90,
    notes = 'Custom bagging: 60d build/ship. Order ~90d supply (tightened 2026-06-23 — 3 active POs)',
    updated_at = NOW()
WHERE vendor_party_id = '10918';

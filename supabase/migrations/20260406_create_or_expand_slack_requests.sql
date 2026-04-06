-- Migration: Create or expand slack_requests for durable Slack request tracking
-- Created: 2026-04-06
-- Purpose: Persist Slack product requests so Aria can mark seen/completed state,
--          match Amazon confirmations, and support manual completion overrides.

CREATE TABLE IF NOT EXISTS slack_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id          TEXT NOT NULL,
    channel_name        TEXT,
    message_ts          TEXT NOT NULL,
    thread_ts           TEXT,
    requester_user_id   TEXT,
    requester_name      TEXT,
    original_text       TEXT,
    items_requested     JSONB DEFAULT '[]'::jsonb,
    matched_skus        TEXT[] DEFAULT '{}'::text[],
    quantity            NUMERIC(12, 2),
    extracted_urls      TEXT[] DEFAULT '{}'::text[],
    status              TEXT NOT NULL DEFAULT 'pending',
    eyes_reacted_at     TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    completed_via       TEXT,
    completion_po_numbers TEXT[] DEFAULT '{}'::text[],
    amazon_order_id     TEXT,
    amazon_items        JSONB DEFAULT '[]'::jsonb,
    amazon_total        NUMERIC(12, 2),
    tracking_number     TEXT,
    carrier             TEXT,
    estimated_delivery  TIMESTAMPTZ,
    matched_at          TIMESTAMPTZ,
    notified_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE slack_requests
    ADD COLUMN IF NOT EXISTS channel_name TEXT,
    ADD COLUMN IF NOT EXISTS message_ts TEXT,
    ADD COLUMN IF NOT EXISTS thread_ts TEXT,
    ADD COLUMN IF NOT EXISTS requester_user_id TEXT,
    ADD COLUMN IF NOT EXISTS requester_name TEXT,
    ADD COLUMN IF NOT EXISTS original_text TEXT,
    ADD COLUMN IF NOT EXISTS items_requested JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS matched_skus TEXT[] DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS quantity NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS extracted_urls TEXT[] DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS eyes_reacted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_via TEXT,
    ADD COLUMN IF NOT EXISTS completion_po_numbers TEXT[] DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS amazon_order_id TEXT,
    ADD COLUMN IF NOT EXISTS amazon_items JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS amazon_total NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS tracking_number TEXT,
    ADD COLUMN IF NOT EXISTS carrier TEXT,
    ADD COLUMN IF NOT EXISTS estimated_delivery TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE slack_requests
    ALTER COLUMN items_requested SET DEFAULT '[]'::jsonb,
    ALTER COLUMN matched_skus SET DEFAULT '{}'::text[],
    ALTER COLUMN extracted_urls SET DEFAULT '{}'::text[],
    ALTER COLUMN completion_po_numbers SET DEFAULT '{}'::text[],
    ALTER COLUMN amazon_items SET DEFAULT '[]'::jsonb,
    ALTER COLUMN status SET DEFAULT 'pending',
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS slack_requests_channel_message_uq
    ON slack_requests (channel_id, message_ts);

CREATE UNIQUE INDEX IF NOT EXISTS slack_requests_amazon_order_uq
    ON slack_requests (amazon_order_id)
    WHERE amazon_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS slack_requests_status_idx
    ON slack_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS slack_requests_completed_idx
    ON slack_requests (completed_at DESC)
    WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS slack_requests_matched_skus_gin_idx
    ON slack_requests USING GIN (matched_skus);

CREATE INDEX IF NOT EXISTS slack_requests_extracted_urls_gin_idx
    ON slack_requests USING GIN (extracted_urls);

COMMENT ON TABLE slack_requests IS
    'Durable Slack request ledger used for seen/completed tracking, Amazon order matching, and manual overrides.';

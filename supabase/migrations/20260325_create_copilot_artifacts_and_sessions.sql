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

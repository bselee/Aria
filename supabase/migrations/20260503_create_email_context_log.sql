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

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

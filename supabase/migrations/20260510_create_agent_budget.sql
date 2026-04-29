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

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
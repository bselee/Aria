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

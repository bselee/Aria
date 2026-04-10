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

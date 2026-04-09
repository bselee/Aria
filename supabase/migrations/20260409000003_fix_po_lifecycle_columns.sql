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

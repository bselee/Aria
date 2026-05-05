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

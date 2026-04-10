-- Add is_intended_multi to distinguish between scheduled/blanket POs and accidental partials
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "is_intended_multi" BOOLEAN DEFAULT false;

COMMENT ON COLUMN "purchase_orders"."is_intended_multi" IS 'True if the PO is intended to be delivered in multiple stages (Blanket PO, Quarterly Buy, etc.)';

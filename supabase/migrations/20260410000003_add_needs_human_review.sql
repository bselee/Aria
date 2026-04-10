-- Add needs_human_review flag for vendor replies that need manual handling
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "needs_human_review" BOOLEAN DEFAULT false;

COMMENT ON COLUMN "purchase_orders"."needs_human_review" IS 'True when vendor reply needs human review (unclear tracking, partial info, etc.).';

COMMENT ON COLUMN "purchase_orders"."needs_human_review" IS 'True when vendor reply needs human review (unclear tracking, partial info, etc.).';

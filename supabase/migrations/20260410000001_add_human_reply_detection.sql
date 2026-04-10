-- Add human_reply_detected_at to track when human manually responds to vendor
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "human_reply_detected_at" TIMESTAMPTZ;

COMMENT ON COLUMN "purchase_orders"."human_reply_detected_at" IS 'Timestamp when a human (Will) was detected replying to vendor. De-escalates follow-up flow.';

-- Add vendor_noncomm_at to track when a vendor was labeled non-communicative
ALTER TABLE "public"."purchase_orders"
ADD COLUMN IF NOT EXISTS "vendor_noncomm_at" TIMESTAMPTZ;

COMMENT ON COLUMN "purchase_orders"."vendor_noncomm_at" IS 'Timestamp when vendor was labeled non-communicative after multiple unresponded follow-ups.';

-- Add vendor_noncomm flag to vendor_profiles for tracking problematic vendors
ALTER TABLE "public"."vendor_profiles"
ADD COLUMN IF NOT EXISTS "is_noncomm" BOOLEAN DEFAULT false;

COMMENT ON COLUMN "vendor_profiles"."is_noncomm" IS 'True if vendor consistently fails to respond to follow-ups.';

-- Migration: Add vendor_domains column for multi-domain vendor tracking
-- Created: 2026-04-10
-- Purpose: Enables outside-thread email search to check ALL known vendor domains,
--          not just the single domain from the PO To: header. Vendors like
--          Amazon sometimes use multiple domains (e.g., orders@ vs shipments@).

ALTER TABLE "public"."vendor_profiles"
ADD COLUMN IF NOT EXISTS "vendor_domains" TEXT[] DEFAULT '{}'::TEXT[];

CREATE INDEX IF NOT EXISTS idx_vendor_profiles_domains
ON "public"."vendor_profiles" USING GIN (vendor_domains);

COMMENT ON COLUMN "public"."vendor_profiles"."vendor_domains" IS
'Known email domains for this vendor. Used for multi-domain outside-thread email search.';

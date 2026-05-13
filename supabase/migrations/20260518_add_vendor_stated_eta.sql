-- Vendor-stated ETA / ship-date captured by the LLM extractor from
-- free-text vendor replies. Read by active-purchases as a high-confidence
-- ETA source above vendor-median lead time.

ALTER TABLE "purchase_orders"
ADD COLUMN IF NOT EXISTS "vendor_stated_eta"        DATE,
ADD COLUMN IF NOT EXISTS "vendor_stated_ship_date"  DATE,
ADD COLUMN IF NOT EXISTS "vendor_stated_eta_confidence" TEXT,
ADD COLUMN IF NOT EXISTS "vendor_stated_eta_extracted_at" TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS "vendor_stated_eta_rationale" TEXT;

COMMENT ON COLUMN "purchase_orders"."vendor_stated_eta" IS
    'Vendor-stated expected arrival date, parsed by LLM from a reply email.';
COMMENT ON COLUMN "purchase_orders"."vendor_stated_ship_date" IS
    'Vendor-stated ship date, parsed by LLM from a reply email.';

-- Add vendor_party_id so the follow-up watcher and other tracking flows can
-- resolve the vendor's primary contact email via lookupVendorOrderEmail
-- without needing a second join through po_sends.

ALTER TABLE "purchase_orders"
ADD COLUMN IF NOT EXISTS "vendor_party_id" TEXT;

CREATE INDEX IF NOT EXISTS "idx_purchase_orders_vendor_party_id"
    ON "purchase_orders" ("vendor_party_id");

COMMENT ON COLUMN "purchase_orders"."vendor_party_id" IS
    'Finale party group ID for the vendor; mirrors po_sends.vendor_party_id.';

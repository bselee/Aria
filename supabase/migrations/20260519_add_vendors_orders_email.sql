-- DECISION(2026-05-19, audit): split the order-routing address from the
-- generic vendor_emails[] list. po-correlator dumps EVERY address Aria has
-- ever seen on a PO thread into vendor_emails[] (sales rep, AR, AP, ops,
-- whoever happened to reply), and lookupVendorOrderEmail() blindly picks
-- vendor_emails[0]. That sent POs to bookkeepers who don't fulfill orders.
--
-- `orders_email` is the trusted address for outgoing PO emails. It's only
-- set by:
--   1. po-followup-watcher when a vendor REPLIES to one of our POs — the
--      responder is by definition the right person to talk to about orders
--      (write-back loop, self-correcting routing).
--   2. Will, manually.
--   3. enricher (web scrape — lowest trust, only used if nothing else set).
--
-- The `vendors` table referenced by older code does not exist on this
-- deployment, so we live on vendor_profiles (the table that's actually
-- populated and queried).

ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS orders_email TEXT;

ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS orders_email_source TEXT;

ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS orders_email_confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN vendor_profiles.orders_email IS
  'Preferred address for outgoing PO emails. Higher priority than vendor_emails[] heuristic pick. Auto-set by po-followup-watcher when a vendor replies.';
COMMENT ON COLUMN vendor_profiles.orders_email_source IS
  'How orders_email was set: vendor_reply (auto, highest trust), manual (Will edited), enricher (web-scraped, lowest trust).';
COMMENT ON COLUMN vendor_profiles.orders_email_confirmed_at IS
  'Last time a vendor reply confirmed this address — prevents pointless re-writes on every reply.';

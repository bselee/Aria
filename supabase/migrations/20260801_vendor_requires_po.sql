-- @file    supabase/migrations/20260801_vendor_requires_po.sql
-- @purpose Add requires_po flag to vendor_profiles so service/utility vendors
--          whose invoices never have a matching PO aren't surfaced as exceptions.
--          Seeds vendor_profiles entries for known service vendors with OCR variants.
-- @author  Hermia
-- @created 2026-08-01
-- @deps    20260226_create_vendor_profiles.sql (vendor_profiles table must exist)
-- @env     Local PG16 + PostgREST
-- Rollback:
--   ALTER TABLE vendor_profiles DROP COLUMN IF EXISTS requires_po;
--   DELETE FROM vendor_profiles WHERE requires_po = false;
--   (requires_po = false was set for deliberately-seeded vendors only.)

BEGIN;

-- ── 1. Add the column ───────────────────────────────────────────────────────
ALTER TABLE vendor_profiles
    ADD COLUMN IF NOT EXISTS requires_po BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN vendor_profiles.requires_po IS
    'false = this vendor bills for services/utilities/freight and its invoices '
    'are not expected to reference a purchase order. They must not be surfaced '
    'as unmatched-invoice exceptions.';

-- ── 2. Seed service/utility vendors ─────────────────────────────────────────
-- IMPORTANT: Vendor names in the wild have OCR/spelling variants (CRLF, ™,
-- case differences). The seeds below match the actual vendor_name values in
-- vendor_invoices. A follow-up will normalize names centrally via
-- src/lib/purchasing/vendor-name-normalize.ts — when that lands, switch to a
-- canonical lookup instead of exact-name matching.

-- FedEx — freight carrier
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('FedEx', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- Logan Labs LLC — soil testing laboratory (service)
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('Logan Labs LLC', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- WWEX (Worldwide Express) — freight carrier
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('WWEX (Worldwide Express)', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('Worldwide Express', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- AAA COOPER Transportation — freight carrier (5 OCR variants found in live data)
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('AAA Cooper Transportation', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('AAA COOPER', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('AAA COOPER TRANSPORTATION', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('AAA COOPER TRANSPORTION™', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES (E'AAA COOPER\r\nTRANSPORTATION™', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('ACT AAA COOPER TRANSPORTATION', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- Culligan Water — water service/utility (2 variants)
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('Culligan Water', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('CULLIGAN OF MONTROSE', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- Terminix — pest control service (3 variants)
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('Terminix', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('terminix5493@gmail.com', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('Terminix Pest Control', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- Toyota Commercial Finance — equipment finance/leasing (service)
INSERT INTO vendor_profiles (vendor_name, requires_po)
    VALUES ('Toyota Commercial Finance', false)
    ON CONFLICT (vendor_name) DO UPDATE SET requires_po = false;

-- ⚠  NOTE: The following vendors were CONSIDERED but NOT flagged as
--    no-PO-required because they could plausibly be goods vendors. They are
--    reported to Bill for confirmation:
--      * Abel's Ace Hardware ("ABEL'S ACE HARDWARE") — 27+5 unmatched invoices.
--        Hardware store — could be goods bought on account or COD.
--      * Arnold Machinery (ARNOLD MACHINERY CO MH 76 GJ, ARNOLD MACHINERY
--        MATERIAL HANDLING) — 15+1+1 unmatched invoices. Machinery/equipment
--        dealer — could sell physical goods.
--      * Accounts Payable — 26 unmatched. Internal routing category, not a real
--        vendor — separate from this flag.
--      * Kevin Dirk — 11 unmatched. Individual — possible contractor.
--      * Various people (Christine Rosales, Gayle Vaillancourt, Debi Remillard,
--        Melissa Holder, D Cadet, Kyle, etc.) — individual reimbursements.
--      * poco@parishoil.com / Parish Oil — 3 unmatched. Fuel delivery — good or service?
--      * "Intuit E-Commerce Service" — 3 unmatched ($24K+). Payment processing.
--      * Dash Billing — 3 unmatched. Billing service.
--      * Bouldin & Lawson LLC — 3 unmatched. Equipment manufacturer.

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';

COMMIT;

/**
 * @file    20260728_backfill_po_vendor_party_id.sql
 * @purpose Backfill purchase_orders.vendor_party_id from the canonical mapping
 *          derived from qty_recommendations (the only table with a reliable
 *          vendor_name → vendor_party_id mapping). Only updates rows where
 *          the mapping is UNAMBIGUOUS — one distinct party ID per normalized
 *          vendor name. Rows with no mapping or an ambiguous mapping stay NULL.
 *
 *          Also resolves vendor_name aliases through the vendor_aliases table:
 *          when a PO's vendor_name doesn't match a qty_recommendations name
 *          directly, it's looked up through the alias chain.
 *
 *          Idempotent: wrapped in BEGIN/COMMIT, only touches rows WHERE
 *          vendor_party_id IS NULL.
 *
 * @author  Hermia
 * @created 2026-07-28
 * @deps    purchase_orders, qty_recommendations, vendor_aliases
 */
BEGIN;

-- Step 1: Build a clean, unambiguous name → party_id mapping from
--         qty_recommendations. Only include names that map to exactly
--         one party ID (none are ambiguous in current data, but this
--         guard prevents future drift from guessing).
CREATE TEMP TABLE _vendor_party_map AS
SELECT
    LOWER(TRIM(qr.vendor_name)) AS normalized_name,
    MIN(qr.vendor_party_id)     AS party_id,
    COUNT(DISTINCT qr.vendor_party_id) AS id_count
FROM qty_recommendations qr
WHERE qr.vendor_party_id IS NOT NULL
  AND qr.vendor_name IS NOT NULL
  AND qr.vendor_name != ''
GROUP BY LOWER(TRIM(qr.vendor_name))
HAVING COUNT(DISTINCT qr.vendor_party_id) = 1;

-- Step 2: Build an alias resolution table from vendor_aliases.
--         Maps any alias (or finale_supplier_name used as alias) to the
--         canonical normalized name that exists in the mapping above.
CREATE TEMP TABLE _alias_resolutions AS
SELECT
    LOWER(TRIM(va.alias))                    AS alias_name,
    LOWER(TRIM(va.finale_supplier_name))     AS canonical_name
FROM vendor_aliases va
WHERE LOWER(TRIM(va.finale_supplier_name)) IN (
    SELECT normalized_name FROM _vendor_party_map
);

-- Step 3: Apply the backfill — first via direct name match
UPDATE purchase_orders po
SET vendor_party_id = m.party_id,
    updated_at = NOW()
FROM _vendor_party_map m
WHERE po.vendor_party_id IS NULL
  AND LOWER(TRIM(po.vendor_name)) = m.normalized_name;

-- Step 4: Apply via alias resolution (for POs still NULL after direct match)
UPDATE purchase_orders po
SET vendor_party_id = m.party_id,
    updated_at = NOW()
FROM _alias_resolutions ar
JOIN _vendor_party_map m ON ar.canonical_name = m.normalized_name
WHERE po.vendor_party_id IS NULL
  AND LOWER(TRIM(po.vendor_name)) = ar.alias_name;

-- Step 5: Report results
SELECT
    (SELECT COUNT(*) FROM purchase_orders) AS total_pos,
    (SELECT COUNT(*) FROM purchase_orders WHERE vendor_party_id IS NOT NULL) AS with_party_id,
    (SELECT COUNT(*) FROM purchase_orders WHERE vendor_party_id IS NULL) AS still_null;

-- Cleanup
DROP TABLE IF EXISTS _vendor_party_map;
DROP TABLE IF EXISTS _alias_resolutions;

COMMIT;

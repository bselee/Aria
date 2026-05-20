/**
 * @file    20260520144012_add_farm_fuel_vendor_aliases.sql
 * @purpose Add vendor aliases for Farm Fuel, Inc and additional Grassroots
 *          Fabric Pots name variants. These ensure resolveVendorAlias() maps
 *          OCR-extracted vendor names to the correct Finale supplier names so
 *          the PO vendor correlation waterfall has accurate names to compare.
 *
 * @decision Farm Fuel: An agricultural input vendor (concentrates, ferticel-class
 *           amendments, etc.) that ships truck freight — same class as Marion Ag.
 *           OCR reads "Farm Fuel, Inc" (with a comma) from their invoices; Finale
 *           stores the supplier as "Farm Fuel Inc." (no comma, trailing period).
 *           The mismatch doesn't break PO# matching when a PO# is on the invoice,
 *           but it degrades vendor correlation confidence from "high" to "medium",
 *           which can gate auto-apply on the downstream reconciler.
 *
 * @decision Grassroots: existing aliases cover "Grassroots Fabric Pots Inc" and
 *           "Grassroots Fabric Pots Inc." but not the bare "Grassroots Fabric Pots"
 *           that the LLM parser sometimes returns. Added the bare form as a
 *           belt-and-suspenders alias.
 *
 * Rollback:
 *   DELETE FROM vendor_aliases WHERE alias IN (
 *     'Farm Fuel, Inc', 'Farm Fuel Inc', 'Farm Fuel Inc.',
 *     'FARM FUEL INC', 'Grassroots Fabric Pots'
 *   );
 */

INSERT INTO vendor_aliases (alias, finale_supplier_name)
VALUES
    -- Farm Fuel: normalise OCR variants to exact Finale supplier name
    ('Farm Fuel, Inc',          'Farm Fuel Inc.'),
    ('Farm Fuel Inc',           'Farm Fuel Inc.'),
    ('FARM FUEL INC',           'Farm Fuel Inc.'),

    -- Grassroots: belt-and-suspenders for bare name and QuickBooks sender
    -- (bare "Grassroots Fabric Pots" is already in DB but add ON CONFLICT guard)
    ('Grassroots Fabric Pots',  'Grassroots Fabric Pots')
ON CONFLICT (alias) DO NOTHING;

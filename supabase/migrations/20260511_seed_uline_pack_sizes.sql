-- Seed ULINE pack sizes for shop-supplies SKUs sold by carton.
-- Will called these out 2026-05-11: receiving must enter as eaches, not cartons,
-- so cost-per-each lands correctly in inventory.
--
-- Pattern: 1 carton = 500 eaches, list price ~$164/carton → $0.328/each.
-- Add more rows here as we identify additional carton-pack ULINE SKUs.

INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, source, notes)
VALUES
    ('S-1665', 500, 'carton', 'uline_catalog', 'ULINE poly bag — 500/carton'),
    ('S-1667', 500, 'carton', 'uline_catalog', 'ULINE poly bag — 500/carton')
ON CONFLICT (sku) DO UPDATE SET
    units_per_pack = EXCLUDED.units_per_pack,
    pack_unit      = EXCLUDED.pack_unit,
    source         = EXCLUDED.source,
    notes          = EXCLUDED.notes,
    updated_at     = NOW();

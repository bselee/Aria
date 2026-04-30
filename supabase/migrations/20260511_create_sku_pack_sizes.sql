CREATE TABLE IF NOT EXISTS sku_pack_sizes (
    sku TEXT PRIMARY KEY,
    units_per_pack INTEGER NOT NULL,
    pack_unit TEXT NOT NULL DEFAULT 'case',
    ea_unit_price NUMERIC(12,2),
    source TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sku_pack_sizes_source ON sku_pack_sizes(source);

COMMENT ON TABLE sku_pack_sizes IS
    'Canonical pack-size registry: 1 pack_unit = units_per_pack eaches. '
    'Used by purchasing intelligence, draft PO creation, and invoice reconciliation '
    'to keep UOM assumptions in one place.';

-- Seed from existing vendor_case_multipliers knowledge
INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, source, notes)
VALUES
    ('EM102', 12, 'case', 'teraganix_invoice', 'EM-1 32oz case of 12'),
    ('EM108', 12, 'case', 'teraganix_invoice', 'EM-1 16oz case of 12'),
    ('EM103', 4,  'case', 'teraganix_invoice', 'EM-1 1 gallon case of 4'),
    ('EM105', 1,  'each', 'teraganix_invoice', 'EM-1 5 gallon each')
ON CONFLICT (sku) DO UPDATE SET
    units_per_pack = EXCLUDED.units_per_pack,
    pack_unit      = EXCLUDED.pack_unit,
    source         = EXCLUDED.source,
    notes          = EXCLUDED.notes,
    updated_at     = NOW();

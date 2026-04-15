CREATE TABLE IF NOT EXISTS vendor_case_multipliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_pattern TEXT NOT NULL,
  sku_pattern TEXT,                    -- null = applies to all SKUs from vendor
  multiplier NUMERIC NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vcm_vendor_sku 
  ON vendor_case_multipliers(vendor_pattern, COALESCE(sku_pattern, ''));

INSERT INTO vendor_case_multipliers (vendor_pattern, sku_pattern, multiplier, notes)
VALUES 
  ('teraganix', 'EM102', 12, 'EM-1 32oz case of 12'),
  ('teraganix', 'EM108', 12, 'EM-1 16oz case of 12'),
  ('teraganix', 'EM103', 4,  'EM-1 1 gallon case of 4'),
  ('teraganix', 'EM105', 1,  'EM-1 5 gallon each')
ON CONFLICT DO NOTHING;

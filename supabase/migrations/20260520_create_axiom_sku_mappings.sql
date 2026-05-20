-- Migration: Create axiom_sku_mappings table
-- Created: 2026-05-20
-- Rollback: DROP TABLE IF EXISTS axiom_sku_mappings;
--
-- DECISION(2026-05-20): Migrate hardcoded AXIOM_TO_FINALE SKU mappings to
-- a dynamic database table so they can be managed via the dashboard.

CREATE TABLE IF NOT EXISTS axiom_sku_mappings (
    axiom_job_name TEXT PRIMARY KEY,
    finale_skus TEXT[] NOT NULL,
    qty_fraction NUMERIC NOT NULL DEFAULT 1.0,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE axiom_sku_mappings IS 'Stores dynamic SKU mappings from Axiom Print Job Names to Finale SKUs';
COMMENT ON COLUMN axiom_sku_mappings.axiom_job_name IS 'The exact Job Name as provided in the Axiom invoice or API estimate';
COMMENT ON COLUMN axiom_sku_mappings.finale_skus IS 'The array of Finale product SKUs that this job name corresponds to';
COMMENT ON COLUMN axiom_sku_mappings.qty_fraction IS 'Fraction of total quantity assigned to each SKU (e.g. 0.5 for front/back split)';

-- Seed initial static mappings
INSERT INTO axiom_sku_mappings (axiom_job_name, finale_skus, qty_fraction, description) VALUES
    ('GNS11_12', ARRAY['GNS11', 'GNS21'], 0.5, 'GnarBar-Whole 2lb F+B'),
    ('GNAR BAR 2lbs', ARRAY['GNS11', 'GNS21'], 0.5, 'GnarBar-Whole 2lb F+B'),
    ('GNAR BAR 6 lbs', ARRAY['GNS12', 'GNS22'], 0.5, 'GnarBar-Whole 6lb F+B'),
    ('GnarBar062lbs', ARRAY['GNS16', 'GNS06'], 0.5, 'GnarBar-Milled 2lb F+B'),
    ('GnarBar07Milled', ARRAY['GNS17', 'GNS07'], 0.5, 'GnarBar-Milled 6lb F+B'),
    ('OAG104FRBK', ARRAY['OAG104LABELFR', 'OAG104LABELBK'], 0.5, 'FCB Castor Bean 1gal F+B'),
    ('OAG207FRBK', ARRAY['OAG207LABELFR', 'OAG207LABELBK'], 0.5, 'V-N 10-2-2 Veg 25lb F+B'),
    ('OAG211FRBK', ARRAY['OAG211LABELFR', 'OAG211LABELBK'], 0.5, 'V-TR 4-5-5 Trans 25lb F+B'),
    ('VCal OA Gallon Labels', ARRAY['OAG110LABELFR', 'OAG110LABELBK'], 0.5, 'VCal 1gal F+B'),
    ('VCal OA Pint Label', ARRAY['OAG109LABELFR', 'OAG109LABELBK'], 0.5, 'VCal 1pint F+B'),
    ('APL102', ARRAY['APL102'], 1.0, '3.0 Soil Cubic Foot Label'),
    ('APL105', ARRAY['APL105'], 1.0, 'B.A.F. 8.5x11 Label'),
    ('BBL101', ARRAY['BBL101'], 1.0, 'BuildASoil Big Label'),
    ('BBL101 124469', ARRAY['BBL101'], 1.0, 'BuildASoil Big Label (reorder)'),
    ('BABL101', ARRAY['BABL101'], 1.0, 'BuildASoil Big-ish Label'),
    ('DOM101', ARRAY['DOM101'], 1.0, 'Domain product label'),
    ('GBB08', ARRAY['GBB08'], 1.0, 'Gnar Bud Butter v8'),
    ('GBB07', ARRAY['GBB07'], 1.0, 'Gnar Bud Butter v7'),
    ('BAF00LABEL', ARRAY['BAF00LABEL'], 1.0, 'BAF00 product label'),
    ('BAF1G', ARRAY['BAF1G'], 1.0, 'BAF 1gal label'),
    ('KGD104', ARRAY['KGD104'], 1.0, 'KGD product label'),
    ('GA105', ARRAY['GA105'], 1.0, 'GA product label'),
    ('PU105L', ARRAY['PU105L'], 1.0, 'PU product label'),
    ('AG111', ARRAY['AG111'], 1.0, 'AG product label'),
    ('FCB1G', ARRAY['FCB1G'], 1.0, 'FCB 1gal label'),
    ('CWP DRINK SOME', ARRAY['CWP DRINK SOME'], 1.0, 'CWP sticker')
ON CONFLICT (axiom_job_name) DO NOTHING;

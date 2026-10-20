-- Migration: Add Surepack / SP USA vendor aliases
-- Created: 2026-10-20
-- Purpose: Surepack ships freight under "SPUSA" / "SP USA" / "Surepack USA"
--          but Finale stores the supplier as "SP USA". The vendor_aliases table
--          (read by the AP invoice→PO correlation pipeline) had no entry, so a
--          FedEx Freight bill with a blank P.O. Number (only a QuoteID) never
--          correlated to the vendor — the reconciler reported "no PO in order
--          window" for a PO that was right there.
--
--          Decision: canonical name = "SP USA" (matches Finale exactly, so the
--          downstream vendor-agreement guard passes).
--
-- Rollback:
--   DELETE FROM vendor_aliases WHERE finale_supplier_name = 'SP USA'
--     AND alias IN ('Surepack USA', 'Surepack', 'SPUSA', 'S.P. USA', 'S P USA');

INSERT INTO vendor_aliases (alias, finale_supplier_name)
VALUES
    ('Surepack USA', 'SP USA'),
    ('Surepack',     'SP USA'),
    ('SPUSA',        'SP USA'),
    ('S.P. USA',     'SP USA'),
    ('S P USA',      'SP USA')
ON CONFLICT (alias) DO NOTHING;

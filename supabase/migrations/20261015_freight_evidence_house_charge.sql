-- Migration: Separate a vendor's house charge from real carriage in freight evidence
-- Created: 2026-10-15
-- Purpose: po_freight_evidence.invoice_freight recorded only the amount the vendor
--          invoiced. For a COLLECT vendor that amount is the vendor's house charge
--          (Uline bills $1.50 on every invoice), never the carriage, which arrives on
--          the carrier's bill. Comparing the PO's freight against that house charge
--          reported freight_matched = true on POs that carried no carriage at all, and
--          fed the classifier a "vendor pays freight" bucket. Fourteen Uline rows sat
--          this way while five figures of FedEx collect went unallocated.
--
--          carrier: po_freight_total and inbound_freight now make the carriage
--          explicit, so a row whose inbound_freight is 0 cannot be read as verified
--          carriage.
--
-- Rollback:
--   ALTER TABLE po_freight_evidence
--     DROP COLUMN IF EXISTS po_freight_total,
--     DROP COLUMN IF EXISTS house_freight_charge,
--     DROP COLUMN IF EXISTS inbound_freight;

ALTER TABLE po_freight_evidence
  ADD COLUMN IF NOT EXISTS po_freight_total     NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS house_freight_charge NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inbound_freight      NUMERIC(12,2) DEFAULT 0;

COMMENT ON COLUMN po_freight_evidence.po_freight_total IS
  'Every FREIGHT adjustment on the PO, summed. Two lines are normal for a COLLECT vendor (house charge + carrier collect).';
COMMENT ON COLUMN po_freight_evidence.house_freight_charge IS
  'The vendor per-invoice house charge that is not carriage (Uline 1.50). Subtracted before anything is called inbound freight.';
COMMENT ON COLUMN po_freight_evidence.inbound_freight IS
  'Carriage on the PO: po_freight_total minus house_freight_charge. 0 means no carriage landed on the PO, whatever invoice_freight says.';
COMMENT ON COLUMN po_freight_evidence.freight_matched IS
  'True only when the PO carries carriage AND an inbound amount was available to check it against AND they agree. Never true merely because the vendor invoice freight landed on the PO.';

-- supabase/migrations/20260521_create_po_shipment_legs.sql
--
-- Per-leg delivery schedule for bulk purchase orders.
-- A PO with no rows here behaves exactly as before (single-leg assumption in recommender).
-- When rows exist, the recommender credits only legs arriving within the lead-time window
-- rather than the full on-order quantity — preventing over-credit on multi-truck bulk orders.
--
-- Primary use cases:
--   Covico  (CWP101 worm castings) — typically 3 truck shipments ~30 days apart
--   Plantae (quillaja SKUs)         — typically 2 legs ~45 days apart
--
-- Rollback: DROP TABLE IF EXISTS public.po_shipment_legs;

CREATE TABLE IF NOT EXISTS public.po_shipment_legs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number           TEXT        NOT NULL,
    vendor_party_id     TEXT,                              -- Finale party ID (denormalized for query speed)
    vendor_name         TEXT,                              -- denormalized for readability
    leg_number          INTEGER     NOT NULL,              -- 1-based ordering within the PO
    expected_qty        NUMERIC(12, 2) NOT NULL,           -- units expected on this leg
    received_qty        NUMERIC(12, 2),                    -- NULL = not yet received
    expected_date       DATE        NOT NULL,              -- when we expect this leg to arrive
    actual_date         DATE,                              -- NULL = pending arrival
    tracking_number     TEXT,                              -- optional; filled when carrier provides it
    carrier_name        TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT po_shipment_legs_leg_number_pos CHECK (leg_number >= 1),
    CONSTRAINT po_shipment_legs_qty_pos        CHECK (expected_qty > 0),
    UNIQUE (po_number, leg_number)                        -- no duplicate leg numbers on a PO
);

-- Fast lookup by PO number (primary access pattern)
CREATE INDEX IF NOT EXISTS po_shipment_legs_po_number_idx
    ON public.po_shipment_legs (po_number);

-- Fast lookup of pending legs by expected date (recommender credit window)
CREATE INDEX IF NOT EXISTS po_shipment_legs_pending_date_idx
    ON public.po_shipment_legs (expected_date)
    WHERE actual_date IS NULL;

-- Vendor-level history for the "historical clarity" use case
CREATE INDEX IF NOT EXISTS po_shipment_legs_vendor_idx
    ON public.po_shipment_legs (vendor_party_id, expected_date DESC)
    WHERE vendor_party_id IS NOT NULL;

COMMENT ON TABLE public.po_shipment_legs IS
    'Per-leg delivery schedule for bulk purchase orders. '
    'When rows exist for a PO, the recommender credits only legs arriving within '
    'the lead-time window (not the full on-order qty). '
    'Empty = legacy single-leg behavior — no behavioral change for non-bulk vendors.';

COMMENT ON COLUMN public.po_shipment_legs.leg_number    IS '1-based delivery leg number within the PO.';
COMMENT ON COLUMN public.po_shipment_legs.expected_qty  IS 'Units expected to arrive on this leg.';
COMMENT ON COLUMN public.po_shipment_legs.received_qty  IS 'Units actually received. NULL until the leg arrives.';
COMMENT ON COLUMN public.po_shipment_legs.expected_date IS 'Target arrival date for this leg.';
COMMENT ON COLUMN public.po_shipment_legs.actual_date   IS 'Actual receipt date. NULL = pending.';

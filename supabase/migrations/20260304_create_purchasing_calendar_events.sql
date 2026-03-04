-- Tracks the Google Calendar event ID for each Finale purchase order.
-- One row per PO — upserted when status changes so the calendar event stays current.
-- Used by syncPurchasingCalendar() (4h cron) and pollPOReceivings() (30min cron).

CREATE TABLE IF NOT EXISTS purchasing_calendar_events (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number    text NOT NULL UNIQUE,
  event_id     text NOT NULL,
  calendar_id  text NOT NULL,
  status       text NOT NULL DEFAULT 'open',  -- 'open' | 'received' | 'cancelled'
  created_at   timestamp with time zone DEFAULT now() NOT NULL,
  updated_at   timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pce_po_number ON purchasing_calendar_events (po_number);

ALTER TABLE purchasing_calendar_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON purchasing_calendar_events
  USING (true) WITH CHECK (true);

COMMENT ON TABLE purchasing_calendar_events IS
  'Maps Finale PO numbers to Google Calendar event IDs in the purchasing calendar. Enables in-place event updates when PO status changes.';

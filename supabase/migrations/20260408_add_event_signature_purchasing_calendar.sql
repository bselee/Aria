ALTER TABLE purchasing_calendar_events
ADD COLUMN IF NOT EXISTS event_signature text DEFAULT '';

COMMENT ON COLUMN purchasing_calendar_events.event_signature IS
  'Stores a rendered title/description/date signature so calendar sync can update stale or reformatted PO events retroactively.';

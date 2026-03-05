ALTER TABLE purchasing_calendar_events
ADD COLUMN last_tracking text DEFAULT '';
COMMENT ON COLUMN purchasing_calendar_events.last_tracking IS 'Stores a stringified representation of the tracking numbers last synced to Google Calendar, used to detect changes.';
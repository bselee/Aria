-- Tracks manufacturing build completions detected by the Aria build watcher cron.
-- One row per completed build order. Used by the dashboard BuildSchedulePanel
-- to show emerald "completed" indicators alongside upcoming scheduled builds.

CREATE TABLE build_completions (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  build_id          text NOT NULL UNIQUE,          -- Finale buildId (e.g. "59127")
  sku               text NOT NULL,                  -- Finale productId (e.g. "CRAFT4")
  quantity          integer NOT NULL DEFAULT 0,
  completed_at      text NOT NULL,                  -- Raw Finale timestamp (e.g. "Mar 3 2026 11:12:41 am")
  calendar_event_id text,                           -- Google Calendar event ID (null if no match found)
  calendar_id       text,                           -- e.g. 'manufacturing@buildasoil.com'
  created_at        timestamp with time zone DEFAULT timezone('utc', now()) NOT NULL
);

CREATE INDEX idx_build_completions_sku ON build_completions (sku);
CREATE INDEX idx_build_completions_created_at ON build_completions (created_at DESC);

ALTER TABLE build_completions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON build_completions
  USING (true) WITH CHECK (true);

COMMENT ON TABLE build_completions IS
  'Finale build completions detected by Aria build watcher. Drives dashboard emerald completion indicators.';

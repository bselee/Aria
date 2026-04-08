-- purchasing_snapshots: Persisted snapshots of scraped dashboard + assessed purchases
-- One row per automated run (9 AM Mon-Fri cron) or manual /scrape_purchasing trigger.
-- Stores raw scraped data, assessed items, purchase requests, and diff summary.

CREATE TABLE purchasing_snapshots (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at     timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  source           text NOT NULL DEFAULT 'cron',              -- 'cron' or 'manual'
  triggered_by     text,                                       -- who triggered (user_id, 'cron', etc.)
  
  -- Raw scraped data (full fidelity)
  raw_purchases     jsonb NOT NULL DEFAULT '{}',              -- purchases-data.json content
  raw_requests      jsonb NOT NULL DEFAULT '{}',              -- purchase-requests.json content (filtered to Pending)
  
  -- Assessed results (computed)
  assessed_items    jsonb NOT NULL DEFAULT '{}',              -- array of assessed items with necessity levels
  high_need_count   integer NOT NULL DEFAULT 0,
  medium_count      integer NOT NULL DEFAULT 0,
  low_count         integer NOT NULL DEFAULT 0,
  noise_count       integer NOT NULL DEFAULT 0,
  
  -- Diff vs previous snapshot
  new_high_need_skus jsonb NOT NULL DEFAULT '[]',             -- array of SKU strings
  new_pending_requests jsonb NOT NULL DEFAULT '[]',           -- array of request details (date, details, quantity)
  
  -- Metadata
  duration_ms       integer,                                   -- total pipeline duration
  items_processed   integer NOT NULL DEFAULT 0,
  requests_processed integer NOT NULL DEFAULT 0
);

CREATE INDEX idx_purchasing_snapshots_generated_at ON purchasing_snapshots (generated_at DESC);
CREATE INDEX idx_purchasing_snapshots_source ON purchasing_snapshots (source);

COMMENT ON TABLE purchasing_snapshots IS 'Persisted snapshots of automated purchasing assessment runs. Used for diffing to detect new HIGH_NEED items and new Pending requests for Telegram alerts.';

-- Enable RLS (service role bypass)
ALTER TABLE purchasing_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON purchasing_snapshots
  USING (true) WITH CHECK (true);

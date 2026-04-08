-- purchasing_dash_snapshots: Snapshots for purchasing dashboard data
CREATE TABLE purchasing_dash_snapshots (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  checksum TEXT
);

CREATE INDEX idx_purchasing_dash_snapshots_created_at ON purchasing_dash_snapshots (created_at DESC);

COMMENT ON TABLE purchasing_dash_snapshots IS 'Snapshots of purchasing dashboard data for caching and historical reference.';

-- Enable RLS (service role bypass)
ALTER TABLE purchasing_dash_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON purchasing_dash_snapshots
  USING (true) WITH CHECK (true);
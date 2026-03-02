CREATE TABLE build_risk_snapshots (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at     timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  days_out         integer NOT NULL DEFAULT 30,
  critical_count   integer NOT NULL DEFAULT 0,
  warning_count    integer NOT NULL DEFAULT 0,
  watch_count      integer NOT NULL DEFAULT 0,
  ok_count         integer NOT NULL DEFAULT 0,
  total_components integer NOT NULL DEFAULT 0,
  builds           jsonb,
  components       jsonb,
  unrecognized_skus jsonb
);

CREATE INDEX idx_build_risk_snapshots_generated_at ON build_risk_snapshots (generated_at DESC);

ALTER TABLE build_risk_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON build_risk_snapshots
  USING (true) WITH CHECK (true);

COMMENT ON TABLE build_risk_snapshots IS 'Persisted snapshots of build risk analysis runs. One row per run (cron or manual /buildrisk).';

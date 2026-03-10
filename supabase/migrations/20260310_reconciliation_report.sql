ALTER TABLE ap_activity_log
  ADD COLUMN IF NOT EXISTS reconciliation_report JSONB;

CREATE INDEX IF NOT EXISTS idx_ap_activity_log_report
  ON ap_activity_log USING GIN (reconciliation_report)
  WHERE reconciliation_report IS NOT NULL;

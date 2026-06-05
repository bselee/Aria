-- cleanup-ap-zombies.sql
-- One-time cleanup: delete zombie ERROR_PROCESSING records from ap_inbox_queue
-- that accumulated as pipeline debris with empty/null extracted_json.
--
-- Criteria:
--   status = 'ERROR_PROCESSING'
--   AND (extracted_json IS NULL OR extracted_json::text = '{}'::text)
--   AND created_at < '2026-05-01'
--
-- 68 such rows were identified as of 2026-06-05.

BEGIN;

DELETE FROM ap_inbox_queue
WHERE status = 'ERROR_PROCESSING'
  AND (extracted_json IS NULL OR extracted_json::text = '{}'::text)
  AND created_at < '2026-05-01';

COMMIT;

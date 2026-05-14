-- Activity Human Workflow columns
-- Adds human annotation + process state fields to ap_activity_log

ALTER TABLE ap_activity_log
ADD COLUMN IF NOT EXISTS human_note TEXT,
ADD COLUMN IF NOT EXISTS human_note_by TEXT,
ADD COLUMN IF NOT EXISTS human_note_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS process_state TEXT CHECK (process_state IN ('new','opened','waiting_on_vendor','handled','learned')),
ADD COLUMN IF NOT EXISTS resolution TEXT,
ADD COLUMN IF NOT EXISTS learning_candidate BOOLEAN DEFAULT FALSE;

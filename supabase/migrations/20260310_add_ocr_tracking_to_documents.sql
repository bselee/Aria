-- Migration: Add OCR quality tracking columns to documents table
-- Purpose:  M1 — track which OCR strategy succeeded and how long it took.
--           Enables monitoring extraction quality per vendor and per strategy.
--
-- Rollback: ALTER TABLE documents DROP COLUMN IF EXISTS ocr_strategy;
--           ALTER TABLE documents DROP COLUMN IF EXISTS ocr_duration_ms;
--
-- DECISION(2026-03-10): Wrapped in DO block with IF EXISTS guard because the
-- documents table may not exist in all environments (defined in separate migration path).
-- The OCR tracking columns are advisory — if the table is absent, the insert calls
-- in ap-agent.ts will naturally fail and get caught by their try/catch blocks.
DO $$ BEGIN IF EXISTS (
    SELECT
    FROM information_schema.tables
    WHERE table_schema = 'public'
        AND table_name = 'documents'
) THEN
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS ocr_strategy TEXT;
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS ocr_duration_ms INTEGER;
COMMENT ON COLUMN documents.ocr_strategy IS 'Which extraction strategy succeeded (pdf-parse, anthropic, openai, openrouter, gemini, unknown)';
COMMENT ON COLUMN documents.ocr_duration_ms IS 'Time taken for PDF extraction in milliseconds';
RAISE NOTICE 'Added ocr_strategy and ocr_duration_ms columns to documents table';
ELSE RAISE NOTICE 'documents table does not exist — skipping OCR tracking columns';
END IF;
END $$;
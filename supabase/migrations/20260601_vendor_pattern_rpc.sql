-- Supabase RPC for vendor_po_patterns upsert
-- Single-call upsert that handles both fail/success increment in one transaction
CREATE OR REPLACE FUNCTION upsert_vendor_po_pattern(
    p_vendor_name TEXT,
    p_last_failed_at TIMESTAMPTZ DEFAULT NULL,
    p_last_matched_at TIMESTAMPTZ DEFAULT NULL,
    p_increment_fail BOOLEAN DEFAULT FALSE,
    p_increment_success BOOLEAN DEFAULT FALSE,
    p_po_format_hint TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO vendor_po_patterns (vendor_name, fail_count, success_count, last_failed_at, last_matched_at, po_format_hint)
    VALUES (
        p_vendor_name,
        CASE WHEN p_increment_fail THEN 1 ELSE 0 END,
        CASE WHEN p_increment_success THEN 1 ELSE 0 END,
        p_last_failed_at,
        p_last_matched_at,
        p_po_format_hint
    )
    ON CONFLICT (vendor_name) DO UPDATE SET
        fail_count = vendor_po_patterns.fail_count + CASE WHEN p_increment_fail THEN 1 ELSE 0 END,
        success_count = vendor_po_patterns.success_count + CASE WHEN p_increment_success THEN 1 ELSE 0 END,
        last_failed_at = COALESCE(p_last_failed_at, vendor_po_patterns.last_failed_at),
        last_matched_at = COALESCE(p_last_matched_at, vendor_po_patterns.last_matched_at),
        po_format_hint = COALESCE(p_po_format_hint, vendor_po_patterns.po_format_hint),
        confidence = LEAST(1.0, vendor_po_patterns.confidence + CASE WHEN p_increment_success THEN 0.05 ELSE 0 END),
        updated_at = NOW();
END;
$$;
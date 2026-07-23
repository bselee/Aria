-- ============================================================================
-- Vendor Intelligence Model — V2 (matches actual schemas)
-- ============================================================================

-- 1. VENDOR DELIVERY PERFORMANCE
CREATE OR REPLACE VIEW vendor_delivery AS
SELECT 
    vendor_name,
    p50_days,
    p90_days,
    on_time_rate,
    sample_count as deliveries_tracked,
    avg_days_recent_30,
    spread_days,
    first_po_date,
    last_po_date,
    CASE 
        WHEN on_time_rate IS NULL THEN 'unknown'
        WHEN on_time_rate >= 0.85 THEN 'reliable'
        WHEN on_time_rate >= 0.60 THEN 'unpredictable'
        ELSE 'unreliable'
    END as reliability
FROM vendor_lead_time_stats
ORDER BY on_time_rate DESC NULLS LAST;

-- 2. VENDOR SHIPPING PATTERNS
CREATE OR REPLACE VIEW vendor_shipping AS
SELECT 
    unnest(vendor_names) as vendor_name,
    count(*) as total_shipments,
    count(DISTINCT carrier_name) as carrier_count,
    string_agg(DISTINCT carrier_name, ', ' ORDER BY carrier_name) as carriers_used,
    string_agg(DISTINCT tracking_kind, ', ' ORDER BY tracking_kind) as tracking_kinds_used,
    count(*) FILTER (WHERE tracking_kind IN ('ltl_freight','ltl_pro')) as ltl_shipments,
    count(*) FILTER (WHERE carrier_name ILIKE '%ups%') as ups_shipments,
    count(*) FILTER (WHERE carrier_name ILIKE '%fedex%') as fedex_shipments,
    count(*) FILTER (WHERE tracking_number IS NOT NULL) as tracked_shipments,
    count(*) FILTER (WHERE delivered_at IS NOT NULL) as delivered_count,
    round(avg(extract(day from (delivered_at - estimated_delivery_at)))::numeric, 1) as avg_delivery_deviation_days
FROM shipments
GROUP BY unnest(vendor_names)
ORDER BY total_shipments DESC;

-- 3. VENDOR INVOICE PATTERNS (uses correct columns)
CREATE OR REPLACE VIEW vendor_invoice_patterns AS
SELECT 
    vendor_name,
    count(*) as invoice_count,
    min(created_at) as first_invoice,
    max(created_at) as last_invoice,
    count(*) FILTER (WHERE status = 'received') as received_count,
    count(*) FILTER (WHERE status = 'reconciled') as reconciled_count,
    count(*) FILTER (WHERE status = 'paid') as paid_count,
    count(*) FILTER (WHERE status IN ('received') AND reconciled_at IS NULL) as pending_reconciliation,
    round(avg(total)::numeric, 2) as avg_invoice_total,
    round(sum(total)::numeric, 2) as total_spend,
    round(avg(freight)::numeric, 2) as avg_freight,
    count(*) FILTER (WHERE freight > 0) as invoices_with_freight,
    round(avg(subtotal)::numeric, 2) as avg_subtotal,
    round(avg(tax)::numeric, 2) as avg_tax,
    -- PO correlation
    count(DISTINCT po_number) FILTER (WHERE po_number IS NOT NULL) as unique_pos_referenced,
    -- Stockout correlation
    (SELECT count(*) FROM stockout_events se 
     JOIN vendor_lead_time_stats vl ON se.vendor_party_id = vl.vendor_party_id
     WHERE vl.vendor_name = vi.vendor_name) as stockout_events
FROM vendor_invoices vi
WHERE vendor_name IS NOT NULL
GROUP BY vendor_name
ORDER BY invoice_count DESC;

-- 4. VENDOR EMAIL ACTIVITY
CREATE OR REPLACE VIEW vendor_email_activity AS
SELECT 
    SPLIT_PART(from_email, '@', 2) as vendor_domain,
    count(*) as email_count,
    min(created_at) as first_email,
    max(created_at) as last_email,
    count(*) FILTER (WHERE has_pdf = true) as pdf_attachments,
    count(*) FILTER (WHERE status = 'processed') as processed_count,
    count(*) FILTER (WHERE status = 'unprocessed') as unprocessed_count,
    count(*) FILTER (WHERE processed_by_ap = true) as ap_processed,
    count(*) FILTER (WHERE processed_by_tracking = true) as tracking_processed,
    count(*) FILTER (WHERE source_inbox = 'ap') as ap_inbox_count,
    count(*) FILTER (WHERE source_inbox = 'default') as default_inbox_count
FROM email_inbox_queue
WHERE from_email IS NOT NULL
GROUP BY SPLIT_PART(from_email, '@', 2)
ORDER BY email_count DESC;

-- 5. UNIFIED VENDOR INTELLIGENCE
CREATE OR REPLACE VIEW vendor_intelligence AS
SELECT 
    COALESCE(vd.vendor_name, vs.vendor_name, vi.vendor_name) as vendor_name,
    -- Delivery performance
    vd.p50_days,
    vd.p90_days,
    vd.on_time_rate,
    vd.reliability,
    vd.deliveries_tracked,
    -- Shipping patterns
    vs.total_shipments,
    vs.carriers_used,
    vs.tracking_kinds_used,
    vs.ltl_shipments,
    vs.ups_shipments,
    vs.fedex_shipments,
    vs.tracked_shipments,
    vs.avg_delivery_deviation_days,
    -- Invoice patterns
    vi.invoice_count,
    vi.pending_reconciliation,
    vi.avg_invoice_total,
    vi.total_spend,
    vi.avg_freight,
    vi.invoices_with_freight,
    vi.stockout_events,
    -- Vendor profile
    vp.communication_pattern,
    vp.is_noncomm as vendor_is_noncomm,
    vp.orders_email,
    vp.auto_approve_threshold,
    vp.total_pos as profile_pos_count,
    vp.responded_count,
    vp.avg_dollar_impact,
    -- PO patterns
    vpp.po_format_hint,
    vpp.confidence as po_format_confidence,
    -- Calibration
    vcs.median_error_pct,
    vcs.safety_multiplier,
    vcs.last_computed_at as last_calibrated_at,
    -- ASSESSMENT
    CASE 
        WHEN vd.reliability = 'reliable' AND vi.invoice_count > 5 THEN 'trusted'
        WHEN vd.reliability = 'unreliable' OR (vi.stockout_events > 2) THEN 'caution'
        WHEN vd.deliveries_tracked < 5 THEN 'insufficient_data'
        WHEN vp.is_noncomm = true THEN 'non_communicative'
        ELSE 'monitor'
    END as trust_assessment,
    -- ACTION HINT
    CASE 
        WHEN vi.pending_reconciliation > 10 THEN 'Review ' || vi.pending_reconciliation::text || ' unreconciled invoices'
        WHEN vd.on_time_rate < 0.60 AND vd.on_time_rate IS NOT NULL THEN 'Buffer stock: ' || round((100 - vd.on_time_rate*100)::numeric)::text || '% late deliveries'
        WHEN vp.is_noncomm = true THEN 'Non-communicative vendor — may need manual outreach'
        WHEN vp.orders_email IS NULL THEN 'Missing orders email — auto-send may fail'
        WHEN vi.total_spend > 10000 THEN 'High-spend vendor: $' || round(vi.total_spend::numeric)::text || ' — prioritize relationship'
        ELSE 'OK'
    END as action_hint,
    -- Combined risk score (0-100, higher = more attention needed)
    (CASE WHEN vd.reliability = 'unreliable' THEN 30 WHEN vd.reliability = 'unpredictable' THEN 15 ELSE 0 END +
     CASE WHEN vi.pending_reconciliation > 10 THEN 25 WHEN vi.pending_reconciliation > 5 THEN 10 ELSE 0 END +
     CASE WHEN vi.stockout_events > 2 THEN 20 ELSE 0 END +
     CASE WHEN vp.is_noncomm THEN 15 ELSE 0 END +
     CASE WHEN vp.orders_email IS NULL THEN 10 ELSE 0 END) as attention_score
FROM vendor_delivery vd
FULL OUTER JOIN vendor_shipping vs ON vd.vendor_name = vs.vendor_name
FULL OUTER JOIN vendor_invoice_patterns vi ON COALESCE(vd.vendor_name, vs.vendor_name) = vi.vendor_name
LEFT JOIN vendor_profiles vp ON COALESCE(vd.vendor_name, vs.vendor_name, vi.vendor_name) = vp.vendor_name
LEFT JOIN vendor_po_patterns vpp ON COALESCE(vd.vendor_name, vs.vendor_name, vi.vendor_name) = vpp.vendor_name
LEFT JOIN vendor_calibration_stats vcs ON COALESCE(vd.vendor_name, vs.vendor_name, vi.vendor_name) = vcs.vendor_name
WHERE COALESCE(vd.vendor_name, vs.vendor_name, vi.vendor_name) IS NOT NULL
ORDER BY attention_score DESC, COALESCE(vi.total_spend, 0) DESC;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon;

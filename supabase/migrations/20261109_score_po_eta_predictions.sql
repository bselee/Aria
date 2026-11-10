-- ════════════════════════════════════════════════════════════════
-- Migration: 20261109_score_po_eta_predictions.sql
-- Purpose:   Score stored ETA predictions against the date goods actually landed,
--            bucketed by evidence source (carrier / vendor / planned / lead time).
--
--            Actual date precedence: a carrier delivery scan on a PO-linked
--            shipment, then the PO's own past receive_date when the PO is
--            received. A FUTURE receive_date is a schedule, not an arrival.
--
--            One result row per source, so "how wrong are we" is a number.
-- Author:   Hermia
-- Created:  2026-11-09
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION score_po_eta_predictions(p_days integer DEFAULT 90)
RETURNS TABLE (
    provenance          text,
    n                   bigint,
    bias_days           numeric,
    mae_days            numeric,
    within_one_day_pct  numeric
)
LANGUAGE sql
AS $$
WITH latest AS (
    SELECT DISTINCT ON (p.po_number)
           p.po_number,
           p.predicted_date,
           p.provenance
      FROM po_eta_predictions p
     WHERE p.snapshot_date >= CURRENT_DATE - (p_days || ' days')::interval
     ORDER BY p.po_number, p.snapshot_date DESC
),
ship_actual AS (
    SELECT unnest(s.po_numbers) AS po_number,
           -- A PO can arrive in several parcels; it is delivered when the LAST
           -- one lands. Predictions use the same end date.
           MAX(s.delivered_at::date) AS actual_date
      FROM shipments s
     WHERE s.delivered_at IS NOT NULL
       AND s.po_numbers IS NOT NULL
       AND COALESCE(s.status_category, '') <> 'abandoned'
     GROUP BY 1
),
po_actual AS (
    SELECT o.po_number,
           o.receive_date::date AS actual_date
      FROM purchase_orders o
     WHERE o.receive_date IS NOT NULL
       AND o.receive_date::date <= CURRENT_DATE
       AND (o.status = 'received' OR o.lifecycle_stage IN ('COMPLETED', 'INVOICED'))
),
actual AS (
    SELECT DISTINCT ON (u.po_number) u.po_number, u.actual_date
      FROM (
            SELECT po_number, actual_date FROM ship_actual
            UNION ALL
            SELECT po_number, actual_date FROM po_actual
           ) u
     ORDER BY u.po_number, u.actual_date
)
SELECT l.provenance::text,
       count(*)::bigint,
       round(avg((a.actual_date - l.predicted_date))::numeric, 1),
       round(avg(abs(a.actual_date - l.predicted_date))::numeric, 1),
       round(100.0 * count(*) FILTER (WHERE abs(a.actual_date - l.predicted_date) <= 1) / count(*), 0)
  FROM latest l
  JOIN actual a ON a.po_number = l.po_number
 GROUP BY l.provenance
 ORDER BY count(*) DESC;
$$;

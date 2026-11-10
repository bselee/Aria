-- ════════════════════════════════════════════════════════════════
-- Migration: 20261109_po_eta_predictions.sql
-- Purpose:   Store what we predicted, when we predicted it, and from which
--            evidence source — so arrival accuracy stops being a feeling.
--
--            Before this, ETA was recomputed on demand and thrown away, so
--            there was no way to answer "how wrong are we, by source?". A PO
--            whose ETA was a carrier scan and a PO whose ETA was a 21-day
--            default looked identical after the fact.
--
--            One row per PO per snapshot day (idempotent re-runs).
-- Author:   Hermia
-- Created:  2026-11-09
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS po_eta_predictions (
    id              BIGSERIAL PRIMARY KEY,
    po_number       TEXT NOT NULL,
    vendor_name     TEXT,
    snapshot_date   DATE NOT NULL,
    predicted_date  DATE NOT NULL,
    -- delivered | carrier | vendor | finale_planned | lead_time | fallback
    provenance      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (po_number, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_po_eta_predictions_po
    ON po_eta_predictions (po_number);

CREATE INDEX IF NOT EXISTS idx_po_eta_predictions_snapshot
    ON po_eta_predictions (snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_po_eta_predictions_provenance
    ON po_eta_predictions (provenance);

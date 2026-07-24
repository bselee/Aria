-- Migration: Persistent Finale SKU/BOM cache
-- Created: 2026-07-24
-- Purpose: BOM/product-detail data from Finale (vendor, lead time, BOM
--          components) rarely changes — recipes update maybe monthly. The
--          existing in-memory caches (products.ts _vendorCache, 4h TTL) are
--          wiped on every PM2 restart, forcing a full ~700-SKU rescan that
--          slams Finale's rate limiter (429s observed 2026-07-24 during
--          heavy purchasing-intelligence runs).
--
--          This table persists per-SKU Finale product detail across process
--          restarts with a 24h TTL. Only stale/missing SKUs get refetched,
--          cutting steady-state Finale calls from ~700/cycle to <20/day.
--
-- Rollback:
--   DROP TABLE IF EXISTS finale_sku_cache;

CREATE TABLE IF NOT EXISTS finale_sku_cache (
    sku                 TEXT PRIMARY KEY,
    vendor_name         TEXT,
    vendor_party_id     TEXT,
    unit_cost           NUMERIC(12,4),
    lead_time_days      INTEGER,
    has_bom             BOOLEAN DEFAULT false,
    bom_components       JSONB,          -- [{ componentSku, quantity }]
    do_not_reorder      BOOLEAN DEFAULT false,
    reorder_method      TEXT,
    raw_detail          JSONB,          -- full FinaleProductDetail for future fields without another migration
    cached_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finale_sku_cache_cached_at
  ON finale_sku_cache (cached_at);

COMMENT ON TABLE finale_sku_cache IS
  'Persistent cross-restart cache of Finale /api/product/<sku> lookups. 24h TTL enforced in application code (products.ts). Prevents 429 rate-limit storms on every cold PM2 restart — BOM/vendor/lead-time data is stale-safe for a day.';

COMMENT ON COLUMN finale_sku_cache.cached_at IS
  'When this row was last refreshed from Finale. Rows older than 24h are treated as stale and refetched.';

COMMENT ON COLUMN finale_sku_cache.bom_components IS
  'BOM component list if this SKU is manufactured: [{ componentSku: string, quantity: number }, ...]. NULL for resale/component SKUs with no BOM.';

COMMENT ON COLUMN finale_sku_cache.raw_detail IS
  'Full FinaleProductDetail JSON blob — forward-compatible escape hatch so new fields don''t require a schema migration.';

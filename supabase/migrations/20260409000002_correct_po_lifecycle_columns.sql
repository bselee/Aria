-- Corrections: Remove extra default and index from evidence column
ALTER TABLE purchase_orders ALTER COLUMN evidence DROP DEFAULT;
DROP INDEX IF EXISTS idx_purchase_orders_lifecycle_state;
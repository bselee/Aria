-- @file supabase/migrations/20260727_normalize_line_items_jsonb.sql
-- @purpose Repair purchase_orders.line_items rows that hold a double-encoded JSON
--          *string* instead of a JSON array. Caused by JSON.stringify() into a jsonb
--          column in src/lib/purchasing/po-cache.ts (fixed 2026-07-27). Readers that
--          guard with Array.isArray() silently skipped these POs, so purchase history
--          and BOM/consumption lookups under-reported real orders.
-- @author Hermia
-- @created 2026-07-27
-- @deps none
-- @env none
--
-- Idempotent: only touches rows where jsonb_typeof(line_items) = 'string', and only
-- when the inner text parses to a JSON array. Rows already arrays are left alone.
-- Rollback: not required (no data loss — this is a lossless representation change).

BEGIN;

UPDATE public.purchase_orders
   SET line_items = (line_items #>> '{}')::jsonb
 WHERE jsonb_typeof(line_items) = 'string'
   AND left(btrim(line_items #>> '{}'), 1) = '[';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- supabase/migrations/20260506000003_vendor_favorite_batches.sql
--
-- Per-vendor explicit "favorite batch sizes" override. When set, takes
-- precedence over historical learning AND the generic cognitive ladder.
-- NULL means "use historical learning + cognitive ladder fallback".

ALTER TABLE public.vendor_reorder_policies
    ADD COLUMN IF NOT EXISTS favorite_batches INTEGER[];

COMMENT ON COLUMN public.vendor_reorder_policies.favorite_batches IS
    'Explicit batch sizes the recommender should snap to (e.g. {500,1000} for Colorful). When NULL, the recommender learns from PO history; when set, this overrides history.';

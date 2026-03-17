-- Add a named unique constraint on (vendor_name, invoice_number) so that
-- Supabase .upsert({ onConflict: "vendor_name,invoice_number" }) works correctly.
-- PostgreSQL treats NULL as distinct in unique constraints, so multiple rows with
-- invoice_number = NULL are still allowed.

ALTER TABLE vendor_invoices
    DROP CONSTRAINT IF EXISTS uq_vendor_name_invoice;

ALTER TABLE vendor_invoices
    ADD CONSTRAINT uq_vendor_name_invoice
    UNIQUE (vendor_name, invoice_number);

-- Keep the partial index for query performance on non-null invoice numbers
-- (already created in 20260317_create_vendor_invoices.sql)

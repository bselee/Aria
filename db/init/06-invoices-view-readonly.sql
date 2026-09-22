-- @file    06-invoices-view-readonly.sql
-- @purpose Stop writes to the public.invoices view. It is a projection over
--          vendor_invoices that casts invoice_date to text and exposes
--          document_id as a null constant, so an upsert that sets either column
--          fails with 0A000 after the view has already accepted the statement.
--          That failure is what kept AP rows stuck and the overwatch heal
--          re-forwarding the same bill to Bill.com. A trigger rejects the write
--          up front and names the table to use instead.
-- @author  Hermia
-- @created 2026-09-22

CREATE OR REPLACE FUNCTION public.reject_invoices_view_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'public.invoices is a read-only view. Write to vendor_invoices (conflict key vendor_name, invoice_number).'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS invoices_view_no_write ON public.invoices;
CREATE TRIGGER invoices_view_no_write
  INSTEAD OF INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_invoices_view_write();

-- paid_invoices is the same trap under another name: it renames total to
-- amount_paid and invents columns, so a write lands on vendor_invoices with the
-- wrong fields. Reject it the same way.
CREATE OR REPLACE FUNCTION public.reject_paid_invoices_view_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'public.paid_invoices is a read-only view. Write to vendor_invoices.'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS paid_invoices_view_no_write ON public.paid_invoices;
CREATE TRIGGER paid_invoices_view_no_write
  INSTEAD OF INSERT OR UPDATE OR DELETE ON public.paid_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_paid_invoices_view_write();

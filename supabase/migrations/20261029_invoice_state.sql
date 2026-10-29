-- Awaiting-invoice sweep state (2026-10-29).
-- A received PO with no matched invoice is either (a) the vendor hasn't billed
-- yet, or (b) the bill is already sitting in Gmail but never ingested because
-- the sender domain doesn't map to the vendor (Rootwise bills from a personal
-- Gmail). The sweep (src/lib/purchasing/awaiting-invoice-sweep.ts) stamps which
-- case it is, plus the email that proved it. Idempotent.

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_state TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_email_thread_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_email_subject TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_email_found_at TIMESTAMPTZ;

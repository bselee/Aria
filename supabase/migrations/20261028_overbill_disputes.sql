-- 20261028_overbill_disputes.sql
-- Durable record of a bill that exceeds the delivered value. Bill's flow
-- (2026-10-28): he does NOT enter the overbill in Bill.com. He emails the
-- vendor for a chance to correct, and enters payment only for what was
-- delivered. One open row per PO; resolved when the credit or revised
-- invoice lands.
create table if not exists public.overbill_disputes (
    id uuid primary key default gen_random_uuid(),
    po_number text not null,
    vendor_name text,
    invoice_number text,
    invoiced_total numeric,
    received_value numeric,
    received_qty_sum numeric,
    delta numeric,
    disposition text not null default 'held' check (disposition in ('held')),
    status text not null default 'open' check (status in ('open', 'resolved')),
    vendor_notified_at timestamptz,
    vendor_draft_id text,
    resolution text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists overbill_disputes_po_idx on public.overbill_disputes (po_number);

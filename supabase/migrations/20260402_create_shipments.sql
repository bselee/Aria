create table if not exists public.shipments (
    id text primary key,
    tracking_key text not null unique,
    tracking_number text not null,
    normalized_tracking_number text not null,
    carrier_name text,
    carrier_key text,
    tracking_kind text not null default 'unknown',
    po_numbers text[] not null default '{}',
    vendor_names text[] not null default '{}',
    status_category text,
    status_display text,
    public_tracking_url text,
    estimated_delivery_at timestamptz,
    delivered_at timestamptz,
    last_checked_at timestamptz,
    last_source text,
    source_confidence numeric,
    source_refs jsonb not null default '[]'::jsonb,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists shipments_po_numbers_gin_idx
    on public.shipments using gin (po_numbers);

create index if not exists shipments_status_category_idx
    on public.shipments (status_category);

create index if not exists shipments_active_updated_idx
    on public.shipments (active, updated_at desc);

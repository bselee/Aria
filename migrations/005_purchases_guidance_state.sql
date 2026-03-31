create table if not exists purchases_guidance_state (
    source_key text primary key,
    status text not null,
    refreshed_at timestamptz not null,
    last_success_at timestamptz null,
    summary jsonb not null default '{}'::jsonb,
    guidance_items jsonb not null default '[]'::jsonb,
    comparisons jsonb not null default '[]'::jsonb,
    error text null,
    updated_at timestamptz not null default now()
);

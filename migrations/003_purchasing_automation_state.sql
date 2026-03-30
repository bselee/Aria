create table if not exists purchasing_automation_state (
    vendor_key text primary key,
    vendor_name text not null,
    last_processed_order_ref text,
    last_processed_at timestamptz,
    last_mapping_sync_at timestamptz,
    cooldown_until timestamptz,
    constraints jsonb not null default '{}'::jsonb,
    override_memory jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default timezone('utc', now()),
    updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists purchasing_automation_state_vendor_name_idx
    on purchasing_automation_state (vendor_name);

create index if not exists purchasing_automation_state_cooldown_until_idx
    on purchasing_automation_state (cooldown_until);

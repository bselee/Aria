-- purchase_assessment_runs: one row per assessment execution
create table if not exists purchase_assessment_runs (
    id uuid primary key default gen_random_uuid(),
    run_at timestamptz not null default now(),
    scrape_success boolean not null default true,
    auth_redirected boolean not null default false,
    created_at timestamptz not null default now()
);

-- purchase_assessments: individual item assessments from each run
create table if not exists purchase_assessments (
    id bigserial primary key,
    run_id uuid not null references purchase_assessment_runs(id) on delete cascade,
    source text not null check (source in ('VENDOR_SUGGESTION', 'TEAM_REQUEST')),
    vendor text not null,
    sku text not null,
    description text not null,
    raw_details text,
    raw_request_json jsonb,
    fuzzy_match_score float,
    scraped_urgency text,
    necessity text not null check (necessity in ('HIGH_NEED', 'MEDIUM', 'LOW', 'NOISE')),
    stock_on_hand int not null default 0,
    stock_on_order int not null default 0,
    sales_velocity float not null default 0,
    purchase_velocity float not null default 0,
    daily_rate float not null default 0,
    runway_days int not null default -1,
    adjusted_runway_days int not null default -1,
    lead_time_days int not null default 14,
    open_pos_json jsonb,
    explanation text not null,
    finale_found boolean not null default false,
    do_not_reorder boolean not null default false,
    created_at timestamptz not null default now()
);

-- Indexes for efficient diff queries
create index if not exists idx_purchase_assessments_run_id on purchase_assessments(run_id);
create index if not exists idx_purchase_assessments_item_key on purchase_assessments(sku, source, vendor);
create index if not exists idx_purchase_assessments_necessity on purchase_assessments(necessity);
create index if not exists idx_purchase_assessment_runs_run_at on purchase_assessment_runs(run_at desc);

-- Enable RLS (Row Level Security) if needed; for now allow service role full access
-- alter table purchase_assessment_runs enable row level security;
-- alter table purchase_assessments enable row level security;

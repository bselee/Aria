-- 20261028_bag_artwork.sql
-- Phase 2: bag artwork repository sync + ordering gate.
-- The teammate's two-tab Google Sheet (Review gid 0 / Complete gid 1893895146)
-- is read-only via Drive export. Aria mirrors it into bag_artwork, resolves
-- sheet SKUs (Finale FG SKUs) to bag/label component SKUs in bag_artwork_link,
-- and enriches the purchasing scan with artStatus so a bag/label in review
-- never gets reordered until its art lands on the Complete tab.
create table if not exists public.bag_artwork (
    artwork_sku text not null,
    tab text not null check (tab in ('review', 'complete')),
    family text,
    version text,
    status text,
    weight text,
    front_file text,
    back_file text,
    rtp_file text,
    canva_link text,
    prop65_status text,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    completed_at timestamptz,
    removed_at timestamptz,
    primary key (artwork_sku, tab)
);

create index if not exists bag_artwork_tab_idx on public.bag_artwork (tab);

create table if not exists public.bag_artwork_link (
    component_sku text not null,
    artwork_sku text not null,
    link_source text not null default 'seed' check (link_source in ('seed', 'bom', 'identity')),
    vendor text,
    note text,
    linked_at timestamptz not null default now(),
    primary key (component_sku, artwork_sku)
);

create table if not exists public.bag_artwork_events (
    id bigserial primary key,
    artwork_sku text not null,
    kind text not null check (kind in ('new', 'tab_move', 'status_change', 'removed')),
    from_tab text,
    to_tab text,
    from_status text,
    to_status text,
    at timestamptz not null default now()
);

create index if not exists bag_artwork_events_sku_idx on public.bag_artwork_events (artwork_sku);

create table if not exists public.bag_artwork_link_attempt (
    artwork_sku text primary key,
    tried_at timestamptz not null default now()
);

create table if not exists public.bag_artwork_alerts (
    id bigserial primary key,
    component_sku text not null,
    artwork_sku text not null,
    art_version text,
    runway_days numeric,
    at timestamptz not null default now(),
    acknowledged boolean not null default false
);

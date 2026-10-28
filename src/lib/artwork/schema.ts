/**
 * @file    src/lib/artwork/schema.ts
 * @purpose Idempotent DDL for the bag-artwork tables (bag_artwork,
 *          bag_artwork_link, bag_artwork_events, bag_artwork_alerts).
 *          The canonical record lives in supabase/migrations/20261028_bag_artwork.sql;
 *          the sync ensures schema on boot via direct pg (PostgREST cannot DDL).
 * @author  Hermia
 * @created 2026-10-28
 * @deps    pg
 * @env     DATABASE_URL (from .env.local)
 */
import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
    if (pool) return pool;
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL must be set in .env.local to run bag-artwork schema');
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    return pool;
}

const DDL = `
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
`;

/**
 * Apply the bag-artwork DDL. All statements are `if not exists`, so this is
 * safe to call on every sync. Throws on connection failure; the caller
 * decides whether to abort the sync.
 */
export async function ensureBagArtworkSchema(): Promise<void> {
    const p = getPool();
    const client = await p.connect();
    try {
        await client.query(DDL);
        // PostgREST serves from a schema cache; new tables 404 (PGRST205)
        // until it reloads. pg_notify triggers the reload.
        await client.query(`select pg_notify('pgrst', 'reload schema')`).catch(() => undefined);
    } finally {
        client.release();
    }
}

/** Close the pool (tests, CLI exit). */
export async function closeBagArtworkPool(): Promise<void> {
    if (pool) {
        await pool.end().catch(() => undefined);
        pool = null;
    }
}

-- 20260317_add_axiom_demand_queue.sql
create table public.axiom_demand_queue (
  id uuid default gen_random_uuid() primary key,
  sku text not null,
  product_name text,
  suggested_qty integer not null,
  velocity_30d numeric,
  runway_days integer,
  status text not null default 'pending' check (status in ('pending', 'ordered', 'dismissed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index for fast queries on the dashboard
create index idx_axiom_demand_status on public.axiom_demand_queue(status);

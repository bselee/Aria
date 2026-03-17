-- 20260317_add_vendor_aliases.sql
-- Description: Adds a table to map vendor aliases found on invoices to their official Finale supplier names/IDs.

CREATE TABLE IF NOT EXISTS public.vendor_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    finale_supplier_name TEXT NOT NULL,
    alias TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(alias)
);

-- Enable RLS
ALTER TABLE public.vendor_aliases ENABLE ROW LEVEL SECURITY;

-- Create policy for authenticated users
CREATE POLICY "Enable read access for authenticated users" 
ON public.vendor_aliases FOR SELECT 
USING (auth.role() = 'authenticated');

CREATE POLICY "Enable write access for authenticated users" 
ON public.vendor_aliases FOR INSERT 
WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Enable update access for authenticated users" 
ON public.vendor_aliases FOR UPDATE 
USING (auth.role() = 'authenticated');

-- Create policy for service role (used by AP Agent)
CREATE POLICY "Enable all access for service role" 
ON public.vendor_aliases FOR ALL 
USING (true);

-- Add index on alias for fast lookups
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_alias ON public.vendor_aliases(alias);

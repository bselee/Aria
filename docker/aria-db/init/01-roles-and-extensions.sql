-- Init script: runs on first DB creation only (docker-entrypoint-initdb.d)
-- Sets up PostgREST roles, extensions, and Supabase-compatible storage schema

-- Create the anon role that PostgREST uses
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
END $$;

-- Grant schema permissions to anon
GRANT USAGE ON SCHEMA public TO anon;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;

-- Extensions that migrations depend on
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Supabase-compatible storage schema (dummy — real storage is MinIO)
-- Migrations reference storage.buckets, storage.objects, etc.
-- We create empty tables so INSERTs don't fail, but actual file
-- storage goes to MinIO.
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id text PRIMARY KEY,
    name text NOT NULL,
    public boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    bucket_id text REFERENCES storage.buckets(id),
    name text,
    owner uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    last_accessed_at timestamptz DEFAULT now(),
    metadata jsonb,
    path_tokens text[]
);

-- Allow anon to access storage tables
GRANT USAGE ON SCHEMA storage TO anon;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage TO anon;

-- Allow anon to create temp tables (PostgREST needs this)
GRANT TEMPORARY ON DATABASE aria TO anon;

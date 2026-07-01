/**
 * @file    src/lib/supabase.ts
 * @purpose DEPRECATED — re-exports from src/lib/db.ts for backward compatibility.
 *          All new code should import from "@/lib/db" directly.
 *
 *          This file was the original Supabase client wrapper.
 *          As of 2026-07-01, the project no longer uses Supabase.
 *          The main operational DB is PostgREST + Postgres in Docker (WSL2).
 *          Local-only ops use aria-local.db via src/lib/storage/local-db.ts.
 *
 * @see     src/lib/db.ts for the replacement PostgREST client (no Supabase SDK).
 */

export { createClient, createClient as createBrowserClient, resetClient } from "./db";

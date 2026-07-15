/**
 * @file    supabase.ts
 * @purpose Backward-compatible re-export for code that still imports @/lib/supabase.
 *          The Supabase SDK was replaced with local PostgREST + SQLite in 2026-07-15.
 *          All new code should import from @/lib/db directly.
 * @deps    @/lib/db
 */
export { createClient, createClient as createBrowserClient } from "@/lib/db";

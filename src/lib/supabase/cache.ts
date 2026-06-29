/**
 * @file    cache.ts
 * @purpose Shared Supabase query caching wrapper for dashboard API routes.
 *          Uses Next.js `unstable_cache` to prevent redundant Supabase reads
 *          on repeated page loads. Short TTL (30s default) keeps data fresh
 *          while eliminating the bulk of free-tier request volume from UI polls.
 *
 *          Callers pass a cache key + query function. The cache is per-request-
 *          scoped via `revalidateTag` and can be busted with `?bust=1`.
 *
 * @author  Hermia
 * @created 2026-06-24
 * @deps    next/cache
 */

import { unstable_cache } from "next/cache";

/** Default: 30 seconds — short enough for near-realtime dashboards, long
 *  enough to collapse bursts of 5-10 rapid page loads into one query. */
const DEFAULT_TTL_S = 30;

/**
 * Wrap a Supabase query in unstable_cache. On cache hit, returns the cached
 * value without hitting Supabase. On cache miss or expiry, executes the
 * query and caches the result.
 *
 * Cache is tagged with `supabase-query:<key>` for invalidation via
 * `revalidateTag()` from mutation endpoints.
 *
 * @example
 *   const data = await cachedQuery("vendor-insights", () =>
 *     supabase.from("vendor_profiles").select("*").eq("vendor_name", vendor).single()
 *   );
 */
export async function cachedQuery<T>(
    key: string,
    queryFn: () => Promise<T>,
    ttlSeconds: number = DEFAULT_TTL_S,
): Promise<T> {
    return unstable_cache(
        queryFn,
        [`supabase-query:${key}`],
        { revalidate: ttlSeconds, tags: [`supabase-query:${key}`] },
    )();
}

/**
 * Bypass the cache and execute a query directly. Use in mutation endpoints
 * (POST/PUT/DELETE) where stale data is unacceptable.
 */
export async function uncachedQuery<T>(queryFn: () => Promise<T>): Promise<T> {
    return queryFn();
}

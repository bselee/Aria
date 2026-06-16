/**
 * @file    instrumentation.ts
 * @purpose Next.js 15 instrumentation hook — runs once at dashboard boot.
 *
 * Starts the purchasing prewarm loop so the Ordering screen never serves a
 * cold cache. Server-only (skips Edge runtime where Finale APIs aren't
 * reachable anyway).
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    try {
        const { startPurchasingPrewarm } = await import('@/lib/purchasing/cache');
        startPurchasingPrewarm();
    } catch (err: any) {
        // Instrumentation chunk resolution can fail on some builds/restarts
        // (e.g. './chunks/_instrument_src_lib_purchasing_cache_ts.js').
        // Prewarm is best-effort; dashboard still works via on-demand SWR + disk fallback.
        console.warn('[instrumentation] Failed to start purchasing prewarm (chunk issue):', err?.message || err);
    }
}

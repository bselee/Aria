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

    const { startPurchasingPrewarm } = await import('@/lib/purchasing/cache');
    startPurchasingPrewarm();
}

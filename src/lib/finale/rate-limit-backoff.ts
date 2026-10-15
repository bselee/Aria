/**
 * @file    rate-limit-backoff.ts
 * @purpose Pure backoff policy for Finale 429s: how long the whole process should
 *          stop talking to Finale after being rate limited, and how to read the
 *          Retry-After header. Extracted so the policy is unit-testable without a
 *          network or a constructed client.
 * @author  Hermia
 * @created 2026-10-15
 * @deps    none
 * @env     none
 */

/** First cooldown after a 429. */
export const BASE_COOLDOWN_MS = 10_000;

/** Longest a single cooldown may wait. */
export const MAX_COOLDOWN_MS = 120_000;

/** Cooldowns stop doubling after this many consecutive 429s. */
export const MAX_COOLDOWN_STEPS = 4;

/**
 * How long to pause ALL Finale traffic after a 429.
 *
 * Doubles per consecutive 429, stops doubling at MAX_COOLDOWN_STEPS, honours a
 * longer server-supplied Retry-After, and never exceeds MAX_COOLDOWN_MS.
 *
 * The point is that one 429 pauses every caller. Retrying per call is what turns
 * ordinary throttling into a storm: a BOM pass over the whole catalog kept firing
 * into the limit until thousands of requests had failed.
 *
 * @param   consecutive429 429s seen since the last success.
 * @param   retryAfterMs   Server Retry-After in ms, if any.
 * @returns                Milliseconds to wait before the next Finale request.
 */
export function nextCooldownMs(consecutive429: number, retryAfterMs?: number | null): number {
    // Sanitise both inputs: a NaN here would propagate into setTimeout, which fires
    // immediately, so a broken counter would silently disable the cooldown entirely.
    const count = Number.isFinite(consecutive429) ? Math.max(0, consecutive429) : 0;
    const steps = Math.min(count, MAX_COOLDOWN_STEPS);
    const backoff = BASE_COOLDOWN_MS * Math.pow(2, steps);
    const retry = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs as number) : 0;
    return Math.min(MAX_COOLDOWN_MS, Math.max(retry, backoff));
}

/**
 * Parse a Retry-After header, which may be delta-seconds or an HTTP date.
 *
 * @param   header Header value.
 * @param   now    Clock override for tests.
 * @returns        Milliseconds to wait, or null when absent or unparseable.
 */
export function parseRetryAfterMs(
    header: string | null | undefined,
    now: number = Date.now(),
): number | null {
    const raw = String(header ?? "").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw) * 1000;
    const when = Date.parse(raw);
    return Number.isFinite(when) ? Math.max(0, when - now) : null;
}

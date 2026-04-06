const DEFAULT_CACHE_HOURS = 6;
const MIN_CACHE_HOURS = 4;
const MAX_CACHE_HOURS = 6;

export function resolvePurchasingCacheTtlMs(rawValue: string | undefined): number {
    const parsed = parseInt(rawValue || "", 10);
    if (!Number.isFinite(parsed) || parsed < MIN_CACHE_HOURS || parsed > MAX_CACHE_HOURS) {
        return DEFAULT_CACHE_HOURS * 60 * 60 * 1000;
    }
    return parsed * 60 * 60 * 1000;
}

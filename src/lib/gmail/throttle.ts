/**
 * @file    src/lib/gmail/throttle.ts
 * @purpose Gmail API rate limiting via exponential backoff.
 *          Gmail free tier: 250 quota units/user/sec.
 *          A burst of 50+ emails can hit the wall without this.
 *
 * @author  Hermia
 * @created 2026-05-28
 *
 * USAGE:
 *   Wrap any Gmail API call:
 *     const result = await gmailThrottle(() => gmail.users.messages.send({...}));
 *
 * BEHAVIOR:
 *   - On 200: returns immediately
 *   - On 429/rateLimitExceeded/tooManyConcurrentRequests: exponential backoff
 *   - Max 3 retries with jitter, then throws
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Execute a Gmail API call with rate-limit backoff.
 * Retries up to MAX_RETRIES times with exponential delay + jitter.
 */
export async function gmailThrottle<T>(
    fn: () => Promise<T>,
    context: string = "gmail",
): Promise<T> {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const status = err?.code || err?.response?.status;
            const message = err?.message || "";

            // Retry on rate-limit-specific errors
            const isRateLimit =
                status === 429 ||
                /rateLimitExceeded/i.test(message) ||
                /tooManyConcurrentRequests/i.test(message) ||
                /quota/i.test(message) ||
                /userRateLimitExceeded/i.test(message);

            if (!isRateLimit || attempt >= MAX_RETRIES) {
                throw err; // Not retryable or exhausted
            }

            attempt++;
            // Exponential backoff with jitter: base * 2^attempt + jitter
            const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
            console.warn(`⏳ [${context}] Rate limited (attempt ${attempt}/${MAX_RETRIES}), backing off ${Math.round(delay)}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Track Gmail API quota usage via a sliding window counter.
 * Gmail free tier allows 250 quota units per second per user.
 * This doesn't enforce — it logs when we're approaching the limit.
 */
class GmailQuotaTracker {
    private calls: number[] = [];
    private readonly WINDOW_MS = 1000;
    private readonly SOFT_LIMIT = 200; // Warn at 80% of 250

    record(): void {
        this.calls.push(Date.now());
        this.prune();
    }

    currentRate(): number {
        this.prune();
        return this.calls.length;
    }

    isNearLimit(): boolean {
        return this.currentRate() >= this.SOFT_LIMIT;
    }

    private prune(): void {
        const cutoff = Date.now() - this.WINDOW_MS;
        this.calls = this.calls.filter(t => t >= cutoff);
    }
}

export const gmailQuota = new GmailQuotaTracker();

/**
 * Throttle-aware wrapper that also tracks quota usage.
 */
export async function gmailThrottled<T>(
    fn: () => Promise<T>,
    context: string = "gmail",
): Promise<T> {
    gmailQuota.record();

    if (gmailQuota.isNearLimit()) {
        // Pre-emptive slowdown — add 200ms buffer
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    return gmailThrottle(fn, context);
}

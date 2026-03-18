/**
 * @file    rate-limiter.ts
 * @purpose Global Gemini API rate limiter — prevents quota exhaustion across all consumers.
 * @author  Will / Antigravity
 * @created 2026-03-18
 * @updated 2026-03-18
 * @deps    none (zero-dependency, shared singleton)
 *
 * DECISION(2026-03-18): Gemini free tier allows ~10 RPM / ~1,500 RPD.
 * Even Tier 1 (billing activated) can be overwhelmed by concurrent AP agent,
 * Telegram bot, and dashboard calls. This token-bucket limiter smooths bursts
 * and provides back-pressure before the API returns 429.
 *
 * Usage:
 *   import { geminiLimiter } from './rate-limiter';
 *   await geminiLimiter.acquire();   // resolves when a slot is available
 *   // …make your Gemini call…
 */

// ── Configuration ───────────────────────────────────────────────────────────
// DECISION(2026-03-18): Billing activated ($20 budget). Tier 1 allows 1,000 RPM / 5M RPD.
// Defaults set conservatively below actual Tier 1 caps to leave headroom.
// Override via env: GEMINI_RPM_LIMIT, GEMINI_RPD_LIMIT (0 = unlimited daily).
const MAX_RPM = parseInt(process.env.GEMINI_RPM_LIMIT || '500', 10);  // requests per minute (Tier 1 allows 1,000)
const MAX_RPD = parseInt(process.env.GEMINI_RPD_LIMIT || '0', 10);    // requests per day (0 = unlimited; Tier 1 allows 5M)
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

class GeminiRateLimiter {
    private minuteTimestamps: number[] = [];
    private dayTimestamps: number[] = [];
    private waitQueue: Array<() => void> = [];
    private drainTimer: ReturnType<typeof setTimeout> | null = null;

    /** Total calls made since process start (diagnostic) */
    public totalCalls = 0;
    /** Total time spent waiting for a slot (ms) */
    public totalWaitMs = 0;

    /**
     * Acquire a rate-limit slot. Resolves immediately if under limit,
     * otherwise queues and resolves when a slot opens up.
     * Throws if the daily cap is exhausted (callers should fall back).
     */
    async acquire(): Promise<void> {
        this.pruneOld();

        // Daily cap — hard reject so callers fall back to OpenRouter
        if (MAX_RPD > 0 && this.dayTimestamps.length >= MAX_RPD) {
            throw new Error(`Gemini daily quota exhausted (${MAX_RPD} RPD). Use fallback provider.`);
        }

        // Under minute limit — proceed immediately
        if (this.minuteTimestamps.length < MAX_RPM) {
            this.record();
            return;
        }

        // Over limit — wait for the oldest request to age out
        const waitStart = Date.now();
        await new Promise<void>((resolve) => {
            this.waitQueue.push(resolve);
            this.scheduleDrain();
        });
        this.totalWaitMs += Date.now() - waitStart;
        this.record();
    }

    /**
     * Check if we can make a call right now without waiting.
     * Useful for deciding whether to skip Gemini and go straight to fallback.
     */
    canProceed(): boolean {
        this.pruneOld();
        if (MAX_RPD > 0 && this.dayTimestamps.length >= MAX_RPD) return false;
        return this.minuteTimestamps.length < MAX_RPM;
    }

    /** Current diagnostics snapshot */
    getStatus(): { rpm: number; rpd: number; maxRpm: number; maxRpd: number; queueDepth: number; totalCalls: number; totalWaitMs: number } {
        this.pruneOld();
        return {
            rpm: this.minuteTimestamps.length,
            rpd: this.dayTimestamps.length,
            maxRpm: MAX_RPM,
            maxRpd: MAX_RPD,
            queueDepth: this.waitQueue.length,
            totalCalls: this.totalCalls,
            totalWaitMs: this.totalWaitMs,
        };
    }

    // ── Internal ────────────────────────────────────────────────────────────

    private record() {
        const now = Date.now();
        this.minuteTimestamps.push(now);
        this.dayTimestamps.push(now);
        this.totalCalls++;
    }

    private pruneOld() {
        const now = Date.now();
        const minuteAgo = now - MINUTE_MS;
        const dayAgo = now - DAY_MS;
        this.minuteTimestamps = this.minuteTimestamps.filter(t => t > minuteAgo);
        this.dayTimestamps = this.dayTimestamps.filter(t => t > dayAgo);
    }

    private scheduleDrain() {
        if (this.drainTimer) return;
        // Calculate when the oldest request in the minute window will expire
        const oldest = this.minuteTimestamps[0];
        if (!oldest) return;
        const delay = Math.max(oldest + MINUTE_MS - Date.now() + 50, 100); // +50ms safety margin

        this.drainTimer = setTimeout(() => {
            this.drainTimer = null;
            this.pruneOld();

            // Release queued waiters that can now proceed
            while (this.waitQueue.length > 0 && this.minuteTimestamps.length < MAX_RPM) {
                const resolve = this.waitQueue.shift()!;
                resolve();
            }

            // If there are still waiters, schedule another drain
            if (this.waitQueue.length > 0) {
                this.scheduleDrain();
            }
        }, delay);
    }
}

/**
 * Shared singleton — all Gemini consumers import this same instance.
 * The limiter is process-global, so Telegram bot + AP agent + dashboard
 * all share the same rate window.
 */
export const geminiLimiter = new GeminiRateLimiter();

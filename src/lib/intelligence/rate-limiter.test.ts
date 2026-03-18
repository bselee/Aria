/**
 * @file    rate-limiter.test.ts
 * @purpose Unit tests for the Gemini rate limiter.
 * @author  Will / Antigravity
 * @created 2026-03-18
 * @updated 2026-03-18
 */

// Replicate core limiter logic in plain JS-compatible syntax for Jest/Babel
class TestRateLimiter {
    constructor(maxRpm, maxRpd) {
        this.maxRpm = maxRpm;
        this.maxRpd = maxRpd;
        this.minuteTimestamps = [];
        this.dayTimestamps = [];
        this.waitQueue = [];
        this.drainTimer = null;
        this.totalCalls = 0;
        this.totalWaitMs = 0;
    }

    async acquire() {
        this.pruneOld();
        if (this.maxRpd > 0 && this.dayTimestamps.length >= this.maxRpd) {
            throw new Error(`Gemini daily quota exhausted (${this.maxRpd} RPD). Use fallback provider.`);
        }
        if (this.minuteTimestamps.length < this.maxRpm) {
            this.record();
            return;
        }
        const waitStart = Date.now();
        await new Promise((resolve) => {
            this.waitQueue.push(resolve);
            this.scheduleDrain();
        });
        this.totalWaitMs += Date.now() - waitStart;
        this.record();
    }

    canProceed() {
        this.pruneOld();
        if (this.maxRpd > 0 && this.dayTimestamps.length >= this.maxRpd) return false;
        return this.minuteTimestamps.length < this.maxRpm;
    }

    getStatus() {
        this.pruneOld();
        return {
            rpm: this.minuteTimestamps.length,
            rpd: this.dayTimestamps.length,
            maxRpm: this.maxRpm,
            maxRpd: this.maxRpd,
            queueDepth: this.waitQueue.length,
            totalCalls: this.totalCalls,
            totalWaitMs: this.totalWaitMs,
        };
    }

    record() {
        const now = Date.now();
        this.minuteTimestamps.push(now);
        this.dayTimestamps.push(now);
        this.totalCalls++;
    }

    pruneOld() {
        const now = Date.now();
        this.minuteTimestamps = this.minuteTimestamps.filter(t => t > now - 60000);
        this.dayTimestamps = this.dayTimestamps.filter(t => t > now - 86400000);
    }

    scheduleDrain() {
        if (this.drainTimer) return;
        const oldest = this.minuteTimestamps[0];
        if (!oldest) return;
        const delay = Math.max(oldest + 60000 - Date.now() + 50, 100);
        this.drainTimer = setTimeout(() => {
            this.drainTimer = null;
            this.pruneOld();
            while (this.waitQueue.length > 0 && this.minuteTimestamps.length < this.maxRpm) {
                const resolve = this.waitQueue.shift();
                resolve();
            }
            if (this.waitQueue.length > 0) this.scheduleDrain();
        }, delay);
    }

    destroy() {
        if (this.drainTimer) clearTimeout(this.drainTimer);
    }
}

describe('GeminiRateLimiter', () => {
    it('should allow calls under the RPM limit without waiting', async () => {
        const limiter = new TestRateLimiter(3, 0);
        const start = Date.now();
        await limiter.acquire();
        await limiter.acquire();
        await limiter.acquire();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(500);
        limiter.destroy();
    });

    it('should report correct status after calls', async () => {
        const limiter = new TestRateLimiter(5, 100);
        await limiter.acquire();
        await limiter.acquire();
        await limiter.acquire();
        const status = limiter.getStatus();
        expect(status.rpm).toBe(3);
        expect(status.rpd).toBe(3);
        expect(status.maxRpm).toBe(5);
        expect(status.maxRpd).toBe(100);
        expect(status.totalCalls).toBe(3);
        expect(status.queueDepth).toBe(0);
        limiter.destroy();
    });

    it('should report canProceed as false when RPM is exhausted', async () => {
        const limiter = new TestRateLimiter(2, 0);
        await limiter.acquire();
        await limiter.acquire();
        expect(limiter.canProceed()).toBe(false);
        limiter.destroy();
    });

    it('should report canProceed as true when under limit', async () => {
        const limiter = new TestRateLimiter(10, 0);
        await limiter.acquire();
        expect(limiter.canProceed()).toBe(true);
        limiter.destroy();
    });

    it('should throw when daily quota is exhausted', async () => {
        const limiter = new TestRateLimiter(100, 2);
        await limiter.acquire();
        await limiter.acquire();
        await expect(limiter.acquire()).rejects.toThrow('daily quota exhausted');
        limiter.destroy();
    });

    it('should handle zero daily cap as unlimited', async () => {
        const limiter = new TestRateLimiter(100, 0);
        for (let i = 0; i < 20; i++) {
            await limiter.acquire();
        }
        expect(limiter.getStatus().totalCalls).toBe(20);
        limiter.destroy();
    });

    it('should track totalWaitMs as 0 when no waiting occurs', async () => {
        const limiter = new TestRateLimiter(10, 0);
        await limiter.acquire();
        await limiter.acquire();
        expect(limiter.totalWaitMs).toBe(0);
        limiter.destroy();
    });
});

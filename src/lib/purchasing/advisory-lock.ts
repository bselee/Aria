/**
 * @file advisory-lock.ts
 * @purpose In-process mutex for preventing concurrent writes to the same PO
 *          from different agents (TrackingAgent, syncPOConversations) running
 *          in the same PM2 process.
 *
 * Uses a Map as an in-memory lock table. Keys are resource identifiers
 * (e.g., "po:12345"). Values are the timestamp when the lock was acquired.
 *
 * Locks auto-expire after `ttlMs` to prevent deadlocks if a process crashes
 * while holding a lock.
 */

const locks = new Map<string, number>();
const WAIT_TIMEOUT_MS = 5000;
const DEFAULT_TTL_MS = 30000;

export class AdvisoryLock {
    constructor(
        private readonly resource: string,
        private readonly ttlMs: number = DEFAULT_TTL_MS,
    ) {}

    /**
     * Attempt to acquire the lock. Returns true if acquired, false if another
     * party already holds it (or it expired).
     */
    tryAcquire(): boolean {
        const now = Date.now();
        const expiresAt = locks.get(this.resource);

        // If expired, clean it up
        if (expiresAt !== undefined && expiresAt < now) {
            locks.delete(this.resource);
        }

        // Try to acquire
        if (locks.has(this.resource)) {
            return false;
        }

        locks.set(this.resource, now + this.ttlMs);
        return true;
    }

    /**
     * Acquire the lock with a short spin-wait. Throws if not acquired within
     * WAIT_TIMEOUT_MS.
     */
    acquire(): void {
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (this.tryAcquire()) return;
        }
        throw new Error(`AdvisoryLock: timed out waiting for resource "${this.resource}"`);
    }

    release(): void {
        locks.delete(this.resource);
    }

    isHeld(): boolean {
        const expiresAt = locks.get(this.resource);
        if (expiresAt === undefined) return false;
        if (expiresAt < Date.now()) {
            locks.delete(this.resource);
            return false;
        }
        return true;
    }
}

/**
 * Run a function with an advisory lock around a resource.
 * If the lock cannot be acquired within WAIT_TIMEOUT_MS, the function is skipped
 * and returns undefined.
 */
export async function withAdvisoryLock<T>(
    resource: string,
    fn: () => Promise<T>,
    options: { ttlMs?: number; skipIfLocked?: boolean } = {},
): Promise<T | undefined> {
    const lock = new AdvisoryLock(resource, options.ttlMs ?? DEFAULT_TTL_MS);
    const acquired = lock.tryAcquire();
    if (!acquired) {
        if (options.skipIfLocked) {
            console.warn(`[advisory-lock] Skipping — resource "${resource}" is locked by another agent`);
            return undefined;
        }
        lock.acquire();
    }
    try {
        return await fn();
    } finally {
        lock.release();
    }
}

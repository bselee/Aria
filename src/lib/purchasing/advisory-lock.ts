/**
 * @file    advisory-lock.ts
 * @purpose In-process mutex for preventing concurrent writes to the same PO
 *          from different agents (TrackingAgent, syncPOConversations) running
 *          in the same PM2 process.
 * @author  Will
 * @created 2026-03-20
 * @updated 2026-05-20
 * @deps    (none)
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
     *
     * @returns {boolean} True if the lock was acquired, false otherwise.
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
     * Acquire the lock with a short spin-wait that yields to the event loop.
     * Throws an Error if the lock is not acquired within WAIT_TIMEOUT_MS.
     *
     * @returns {Promise<void>} Resolves when the lock is acquired.
     * @throws {Error} If the wait times out.
     */
    async acquire(): Promise<void> {
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (this.tryAcquire()) return;
            // Yield control back to the event loop so that other async flows
            // can execute and release the lock.
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`AdvisoryLock: timed out waiting for resource "${this.resource}"`);
    }

    /**
     * Release the lock, making the resource available for other acquire calls.
     */
    release(): void {
        locks.delete(this.resource);
    }

    /**
     * Check if the resource lock is currently held and not expired.
     *
     * @returns {boolean} True if the lock is active.
     */
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
 *
 * @param   resource - Unique identifier for the locked resource (e.g. "po:12345")
 * @param   fn - Async function to run under the lock
 * @param   options - ttlMs (lock expiration duration) and skipIfLocked (whether to immediately skip on busy lock)
 * @returns The resolved value of the input function, or undefined if skipped
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
        await lock.acquire();
    }
    try {
        return await fn();
    } finally {
        lock.release();
    }
}

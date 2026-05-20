/**
 * @file    advisory-lock.test.ts
 * @purpose Unit tests for AdvisoryLock and withAdvisoryLock utility.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    vitest, advisory-lock
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdvisoryLock, withAdvisoryLock } from './advisory-lock';

describe('AdvisoryLock', () => {
    const resource = 'test-resource';
    let warnSpy: any;

    beforeEach(() => {
        // Clear global lock state by releasing if held
        const lock = new AdvisoryLock(resource);
        lock.release();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        const lock = new AdvisoryLock(resource);
        lock.release();
        warnSpy.mockRestore();
    });

    it('should successfully acquire the lock if it is free', () => {
        const lock = new AdvisoryLock(resource);
        const acquired = lock.tryAcquire();
        expect(acquired).toBe(true);
        expect(lock.isHeld()).toBe(true);
    });

    it('should return false on tryAcquire if lock is already held', () => {
        const lock1 = new AdvisoryLock(resource);
        const lock2 = new AdvisoryLock(resource);

        expect(lock1.tryAcquire()).toBe(true);
        expect(lock2.tryAcquire()).toBe(false);
    });

    it('should release the lock and make the resource available again when release is called', () => {
        const lock = new AdvisoryLock(resource);
        expect(lock.tryAcquire()).toBe(true);
        lock.release();
        expect(lock.isHeld()).toBe(false);

        const lock2 = new AdvisoryLock(resource);
        expect(lock2.tryAcquire()).toBe(true);
    });

    it('should asynchronously acquire the lock after it is released by another agent', async () => {
        const lock1 = new AdvisoryLock(resource);
        const lock2 = new AdvisoryLock(resource);

        expect(lock1.tryAcquire()).toBe(true);

        // Schedule lock1 release after 100ms
        setTimeout(() => {
            lock1.release();
        }, 100);

        const startTime = Date.now();
        await lock2.acquire();
        const duration = Date.now() - startTime;

        expect(duration).toBeGreaterThanOrEqual(100);
        expect(lock2.isHeld()).toBe(true);
    });

    it('should throw an Error if the lock is held and never released within the timeout period', async () => {
        vi.useFakeTimers();

        const lock1 = new AdvisoryLock(resource);
        const lock2 = new AdvisoryLock(resource);

        expect(lock1.tryAcquire()).toBe(true);

        const acquirePromise = lock2.acquire();

        // Attach expectation/catch handler before advancing timers to avoid unhandled rejection warning
        const expectationPromise = expect(acquirePromise).rejects.toThrow('AdvisoryLock: timed out waiting for resource');

        // Advance timers by 6000ms to trigger the timeout
        await vi.advanceTimersByTimeAsync(6000);

        await expectationPromise;
        
        vi.useRealTimers();
    });

    it('should auto-expire the lock after the TTL duration has elapsed', async () => {
        vi.useFakeTimers();
        const lock1 = new AdvisoryLock(resource, 100); // 100ms TTL
        expect(lock1.tryAcquire()).toBe(true);

        // Advance timers past TTL
        await vi.advanceTimersByTimeAsync(150);

        const lock2 = new AdvisoryLock(resource);
        expect(lock2.tryAcquire()).toBe(true);
        vi.useRealTimers();
    });
});

describe('withAdvisoryLock', () => {
    const resource = 'test-with-lock';
    let warnSpy: any;

    beforeEach(() => {
        const lock = new AdvisoryLock(resource);
        lock.release();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        const lock = new AdvisoryLock(resource);
        lock.release();
        warnSpy.mockRestore();
    });

    it('should execute the wrapped function and automatically release the lock afterwards', async () => {
        let executed = false;
        const result = await withAdvisoryLock(resource, async () => {
            executed = true;
            return 'success';
        });

        expect(executed).toBe(true);
        expect(result).toBe('success');

        const lock = new AdvisoryLock(resource);
        expect(lock.isHeld()).toBe(false);
    });

    it('should release the lock even if the wrapped function throws an error', async () => {
        const promise = withAdvisoryLock(resource, async () => {
            throw new Error('inner failure');
        });

        await expect(promise).rejects.toThrow('inner failure');

        const lock = new AdvisoryLock(resource);
        expect(lock.isHeld()).toBe(false);
    });

    it('should immediately skip execution and return undefined if skipIfLocked is true and lock is already held', async () => {
        const lock = new AdvisoryLock(resource);
        expect(lock.tryAcquire()).toBe(true);

        let executed = false;
        const result = await withAdvisoryLock(resource, async () => {
            executed = true;
            return 'skipped';
        }, { skipIfLocked: true });

        expect(executed).toBe(false);
        expect(result).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping — resource "test-with-lock" is locked'));
    });

    it('should wait and successfully execute the wrapped function once the lock is released', async () => {
        const lock = new AdvisoryLock(resource);
        expect(lock.tryAcquire()).toBe(true);

        setTimeout(() => {
            lock.release();
        }, 100);

        let executed = false;
        const result = await withAdvisoryLock(resource, async () => {
            executed = true;
            return 'delayed-success';
        }, { skipIfLocked: false });

        expect(executed).toBe(true);
        expect(result).toBe('delayed-success');
    });
});

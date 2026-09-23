/**
 * @file    process-lock.test.ts
 * @purpose Cross-process cron lock: second acquire fails, dead PID is stolen.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryAcquireProcessLock } from "./process-lock";

const dir = path.join(os.tmpdir(), `aria-cron-lock-test-${process.pid}`);

describe("tryAcquireProcessLock", () => {
    beforeEach(() => {
        process.env.ARIA_CRON_LOCK_DIR = dir;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.ARIA_CRON_LOCK_DIR;
    });

    it("second acquire of the same job fails while the first holds it", () => {
        const release = tryAcquireProcessLock("ap-polling");
        expect(release).not.toBeNull();
        expect(tryAcquireProcessLock("ap-polling")).toBeNull();
        release!();
        expect(tryAcquireProcessLock("ap-polling")).not.toBeNull();
    });

    it("steals a lock whose PID is dead", () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "ap-polling.lock"), "99999999");
        const release = tryAcquireProcessLock("ap-polling");
        expect(release).not.toBeNull();
        release!();
    });
});

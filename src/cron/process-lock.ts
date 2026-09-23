/**
 * @file    process-lock.ts
 * @purpose Cross-process lock for cron jobs. The in-process Bottleneck lock
 *          does not stop a second node process (orphan PM2 fork) from running
 *          the same job. That is how ap-polling fired three times at 8:00.
 * @author  Hermia
 * @created 2026-09-23
 * @deps    node:fs, node:path, node:os
 */
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Directory for cron lock files. Tests set ARIA_CRON_LOCK_DIR.
 * Production uses %LOCALAPPDATA%/aria/cron-locks so every bot process
 * on this machine sees the same files.
 */
export function cronLockDir(): string {
    if (process.env.ARIA_CRON_LOCK_DIR) return process.env.ARIA_CRON_LOCK_DIR;
    const base = process.env.LOCALAPPDATA || os.tmpdir();
    return path.join(base, "aria", "cron-locks");
}

/** True when `pid` is this process or a live other process. */
export function pidIsAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        return err?.code === "EPERM";
    }
}

/**
 * Acquire an exclusive lock for `jobName`. Returns a release function, or
 * null when another live process already holds it.
 *
 * A lock file whose PID is dead is stolen by renaming it aside, then
 * re-reading that renamed file. Rename is atomic, so two processes cannot
 * both delete the winner's fresh lock. A crash cannot block the next tick.
 */
export function tryAcquireProcessLock(jobName: string): (() => void) | null {
    const safe = jobName.replace(/[^a-z0-9_-]/gi, "_");
    const dir = cronLockDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe}.lock`);

    for (let attempt = 0; attempt < 4; attempt++) {
        if (createLock(file) && stillOurs(file)) return releaseOf(file);
        const steal = stealDeadLock(file, attempt === 3);
        if (steal === "live") return null;
    }
    return null;
}

function stillOurs(file: string): boolean {
    try {
        return Number(fs.readFileSync(file, "utf8").trim()) === process.pid;
    } catch {
        return false;
    }
}

/** Exclusive create, then write the PID before the handle is visible as complete. */
function createLock(file: string): boolean {
    let fd: number;
    try {
        fd = fs.openSync(file, "wx");
    } catch {
        return false;
    }
    try {
        fs.writeFileSync(fd, String(process.pid));
        return true;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * If the lock holds a dead PID, rename it aside and delete it only when the
 * renamed bytes are still that dead PID. A live PID is put back. An empty
 * file is a create still in progress, so it is left alone until the last try.
 */
function stealDeadLock(file: string, stealEmpty: boolean): "live" | "retry" {
    let holder = NaN;
    try {
        holder = Number(fs.readFileSync(file, "utf8").trim());
    } catch {
        return "retry";
    }
    if (pidIsAlive(holder)) return "live";
    if (!Number.isFinite(holder) || holder <= 0) {
        if (!stealEmpty) return "retry";
        holder = 0;
    }

    const claim = `${file}.stealing.${process.pid}`;
    try {
        fs.renameSync(file, claim);
    } catch {
        return "retry";
    }

    let moved = NaN;
    try {
        moved = Number(fs.readFileSync(claim, "utf8").trim());
    } catch {
        return "retry";
    }
    if (moved !== holder || pidIsAlive(moved)) {
        try { fs.renameSync(claim, file); } catch { /* owner recreated it */ }
        return pidIsAlive(moved) ? "live" : "retry";
    }
    try { fs.unlinkSync(claim); } catch { /* already gone */ }
    return "retry";
}

function releaseOf(file: string): () => void {
    return () => {
        try {
            const holder = Number(fs.readFileSync(file, "utf8").trim());
            if (holder === process.pid) fs.unlinkSync(file);
        } catch {
            /* already released */
        }
    };
}

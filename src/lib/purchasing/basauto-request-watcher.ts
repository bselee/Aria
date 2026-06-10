/**
 * @file    src/lib/purchasing/basauto-request-watcher.ts
 * @purpose Surfaces basauto.vercel.app pending purchase requests via Telegram,
 *          same funnel as Slack stale-request-watcher. Reads the snapshot
 *          file written by scripts/basauto_poll.py (Hermes cron at 6AM).
 * @author  Hermia
 * @created 2026-06-09
 * @deps    @/lib/intelligence/telegram-notify, @/lib/intelligence/alert-gate
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { sendTelegramNotify } from "../intelligence/telegram-notify";
import { isBusinessHours } from "../intelligence/alert-gate";

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), "AppData", "Local", "hermes", "cache", "basauto");
const SNAPSHOT_FILE = join(DATA_DIR, "latest-snapshot.json");
const SEEN_FILE = join(DATA_DIR, "seen-request-ids.json");

// ── Types ─────────────────────────────────────────────────────────────────────

interface BasautoRequest {
    _id: string;
    status: string;
    department: string;
    requestType: string;
    existingProduct: {
        lookup: string;
        description: string;
        category: string;
        url: string;
    } | null;
    newProduct: {
        title: string;
        purchaseLink: string;
        reason: string;
    } | null;
    requestedBy: string;
    createdAt: string;
}

interface BasautoSnapshot {
    requests: BasautoRequest[];
    _poll_timestamp?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadSnapshot(): BasautoSnapshot | null {
    if (!existsSync(SNAPSHOT_FILE)) return null;
    try {
        const raw = readFileSync(SNAPSHOT_FILE, "utf-8");
        return JSON.parse(raw) as BasautoSnapshot;
    } catch {
        return null;
    }
}

function loadSeenIds(): Set<string> {
    if (!existsSync(SEEN_FILE)) return new Set();
    try {
        const raw = readFileSync(SEEN_FILE, "utf-8");
        return new Set(JSON.parse(raw));
    } catch {
        return new Set();
    }
}

function saveSeenIds(ids: Set<string>): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SEEN_FILE, JSON.stringify(Array.from(ids)), "utf-8");
}

/**
 * Format a single pending request as a terse one-liner.
 * Same voice as stale-request-watcher — no bullet points, no headers.
 */
function formatRequest(req: BasautoRequest): string {
    const dept = req.department || "?";
    if (req.requestType === "existing" && req.existingProduct) {
        return `${dept} wants ${req.existingProduct.lookup} - ${req.existingProduct.description}`;
    }
    if (req.requestType === "new" && req.newProduct) {
        let line = `${dept} wants: ${req.newProduct.title}`;
        if (req.newProduct.reason) {
            line += ` (${req.newProduct.reason.slice(0, 80)})`;
        }
        return line;
    }
    return `${dept} pending request (${req.requestType})`;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Check for new pending basauto purchase requests and notify Bill.
 * Called from the followup-sop cron (every 2 hours).
 *
 * Pattern: same funnel as runStaleSlackRequests — read snapshot, diff against
 * seen IDs, send TG for any new pending items, update seen set.
 */
export async function runBasautoRequestWatcher(): Promise<void> {
    if (!isBusinessHours()) {
        console.log("[basauto-watcher] Outside business hours — skipping.");
        return;
    }

    const snapshot = loadSnapshot();
    if (!snapshot || !snapshot.requests) {
        console.log("[basauto-watcher] No snapshot file — poll hasn't run yet.");
        return;
    }

    const pending = snapshot.requests.filter((r) => r.status === "Pending");
    if (pending.length === 0) {
        console.log("[basauto-watcher] No pending requests.");
        return;
    }

    const seen = loadSeenIds();
    const newPending = pending.filter((r) => !seen.has(r._id));

    if (newPending.length === 0) {
        console.log(`[basauto-watcher] ${pending.length} pending request(s), all already seen.`);
        return;
    }

    // Format notification — same terse voice as Slack request watcher
    let msg: string;
    if (newPending.length === 1) {
        msg = `📋 BASAUTO purchase request needs action:\n${formatRequest(newPending[0])}`;
    } else {
        const items = newPending.slice(0, 5).map(formatRequest).join("\n");
        const extra = newPending.length > 5 ? `\n...and ${newPending.length - 5} more` : "";
        msg = `📋 ${newPending.length} BASAUTO purchase requests pending:\n${items}${extra}`;
    }

    console.log(msg);
    await sendTelegramNotify(msg).catch(() => {});

    // Update seen IDs
    for (const r of pending) {
        seen.add(r._id);
    }
    saveSeenIds(seen);

    console.log(`[basauto-watcher] Notified Bill about ${newPending.length} new BASAUTO request(s).`);
}

/**
 * Report of pending basauto requests — used by dashboard or Telegram commands
 * to show current pending queue without triggering notifications.
 */
export function getPendingBasautoRequests(): BasautoRequest[] {
    const snapshot = loadSnapshot();
    if (!snapshot?.requests) return [];
    return snapshot.requests.filter((r) => r.status === "Pending");
}

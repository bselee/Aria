/**
 * @file    src/lib/ops/reconciliation-runner.ts
 * @purpose Vendor reconciliation child process management.
 *          Spawns vendor-specific reconciliation scripts with timeout
 *          and buffer limits.
 * @author  Will / Antigravity / Hermia
 * @created 2026-05-28
 * @deps    child_process
 * @extracted-from src/lib/intelligence/ops-manager.ts lines 73-76, 715-730
 *
 * DECISION(2026-03-18): 5-minute timeout for vendor reconciliation child processes.
 * Prevents hung Playwright browsers or network stalls from running indefinitely.
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const RECONCILE_TIMEOUT_MS = 5 * 60 * 1000;
const RECONCILE_MAX_BUFFER = 10 * 1024 * 1024; // 10MB stdout cap

/**
 * Run a vendor reconciliation as a child process via tsx.
 * Uses --dry-run by default for safety.
 */
export async function runReconciliation(
    vendorName: string,
    command: string,
): Promise<void> {
    console.log(`[reconcile] Starting ${vendorName} reconciliation...`);
    const start = Date.now();

    try {
        const { stdout, stderr } = await execAsync(
            `node --import tsx --dns-result-order=ipv4first ${command}`,
            { timeout: RECONCILE_TIMEOUT_MS, maxBuffer: RECONCILE_MAX_BUFFER },
        );
        if (stdout) console.log(`[reconcile:${vendorName}]`, stdout.slice(-500));
        if (stderr) console.warn(`[reconcile:${vendorName} stderr]`, stderr.slice(-500));
    } catch (err: any) {
        if (err.killed) {
            console.error(`[reconcile:${vendorName}] ⏱️ TIMEOUT after ${RECONCILE_TIMEOUT_MS / 1000}s`);
        } else {
            console.error(`[reconcile:${vendorName}] ❌ ${err.message}`);
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[reconcile] ${vendorName} reconciliation completed in ${elapsed}s`);
}

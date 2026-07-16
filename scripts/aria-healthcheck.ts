/**
 * @file    aria-healthcheck.ts
 * @purpose PM2 healthcheck that ensures WSL2 Docker containers are running.
 *          Runs every 60s. If PostgREST is down, restarts Docker containers
 *          and PM2 processes in the correct order.
 *
 * @author  Hermia
 * @created 2026-07-16
 *
 * PM2 setup:
 *   pm2 start scripts/aria-healthcheck.ts --name aria-healthcheck --interpreter npx --interpreter-args tsx
 */

import { execSync } from "child_process";

const PGREST_URL = "http://localhost:5434/";
const MAX_RETRIES = 18; // ~3 min of retries before giving up

/** Run a WSL command and return stdout */
function wsl(cmd: string): string {
    try {
        return execSync(`wsl -d Ubuntu -u root bash -c '${cmd}'`, {
            timeout: 30_000,
            encoding: "utf-8",
            shell: "powershell.exe",
        }).trim();
    } catch (e: any) {
        return `ERROR: ${e.message}`;
    }
}

/** Check if PostgREST is reachable through the proxy */
async function checkPostgREST(): Promise<boolean> {
    try {
        const res = await fetch(PGREST_URL, { signal: AbortSignal.timeout(5_000) });
        return res.status === 200 || res.status === 206 || res.status === 503;
        // 503 = schema cache loading (PostgREST is alive, just not ready)
    } catch {
        return false;
    }
}

async function recoverInfrastructure(): Promise<boolean> {
    console.log("[healthcheck] PostgREST down — attempting recovery...");

    // Step 1: Check if WSL is alive
    const wslCheck = wsl("echo alive");
    if (wslCheck !== "alive") {
        console.error("[healthcheck] WSL not responding — cannot recover");
        return false;
    }

    // Step 2: Restart Docker containers in correct order
    console.log("[healthcheck] Restarting aria-db...");
    wsl("docker restart aria-db && sleep 8");

    console.log("[healthcheck] Restarting aria-postgrest...");
    wsl("docker restart aria-postgrest && sleep 5");

    // Step 3: Wait for PostgREST to come back
    for (let i = 0; i < MAX_RETRIES; i++) {
        const ok = await checkPostgREST();
        if (ok) {
            console.log(`[healthcheck] PostgREST recovered after ${i + 1}s`);
            return true;
        }
        await new Promise(r => setTimeout(r, 10_000));
    }

    console.error("[healthcheck] PostgREST failed to recover after 3 minutes");
    return false;
}

async function run() {
    const pgrOk = await checkPostgREST();

    if (!pgrOk) {
        const recovered = await recoverInfrastructure();
        if (recovered) {
            // Restart wsl-proxy to clear its fallback port
            execSync("pm2 restart aria-wsl-proxy", { timeout: 10_000, shell: "powershell.exe" });
            console.log("[healthcheck] wsl-proxy restarted, infra healthy ✓");
        } else {
            console.error("[healthcheck] Recovery failed — exiting for PM2 restart");
            process.exit(1);
        }
    } else {
        console.log(`[healthcheck] ✓ PostgREST healthy at ${new Date().toISOString()}`);
    }
}

// Run immediately, then every 60s
run().catch(e => console.error("[healthcheck] Error:", e.message));
setInterval(() => run().catch(e => console.error("[healthcheck] Error:", e.message)), 60_000);

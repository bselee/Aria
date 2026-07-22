/**
 * @file    src/cli/obsidian-honcho-sync.ts
 * @purpose CLI tool that reads all vault notes and pushes key facts into Honcho
 *          peer memory via the HTTP API. This bridges Obsidian's filesystem-only
 *          knowledge into Honcho's cross-session semantic recall.
 *
 *          Bridge 3 of 3: Obsidian Vault → Honcho Peer Memory
 *
 *          KAIZEN(2026-07-22): Removed WSL curl fallback. The TCP proxy
 *          (wsl-proxy.js) forwards port 8000 via plain TCP — same reliable
 *          path as PostgreSQL. Retry with backoff instead of spawning wsl.exe.
 *
 * @author  Hermia
 * @created 2026-06-26
 * @updated 2026-07-22 — removed wsl.exe fallback, added retry
 * @deps    obsidian/bridge
 * @env     HONCHO_BASE_URL (default: http://127.0.0.1:8000)
 *          HONCHO_WORKSPACE (default: aria)
 *          HONCHO_OBSERVER_PEER (default: hermia)
 *          HONCHO_OBSERVED_PEER (default: Bill)
 */

import { readVaultForSync } from "../lib/obsidian/bridge";

const HONCHO_BASE_URL = process.env.HONCHO_BASE_URL || "http://127.0.0.1:8000";
const HONCHO_WORKSPACE = process.env.HONCHO_WORKSPACE || "aria";
const HONCHO_OBSERVER_PEER = process.env.HONCHO_OBSERVER_PEER || "hermia";
const HONCHO_OBSERVED_PEER = process.env.HONCHO_OBSERVED_PEER || "Bill";

/** Retry a fetch with exponential backoff (1s → 2s → 4s), up to 3 attempts. */
async function fetchWithRetry(
    url: string,
    options: RequestInit & { timeoutMs?: number },
    retries = 3
): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? 5000;
    let lastError: any;

    for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) {
            const delay = Math.pow(2, attempt - 1) * 1000;
            await new Promise(r => setTimeout(r, delay));
        }
        try {
            const { timeoutMs: _, ...fetchOpts } = options;
            const resp = await fetch(url, {
                ...fetchOpts,
                signal: AbortSignal.timeout(timeoutMs + attempt * 3000),
            });
            if (resp.ok || resp.status === 404) return resp;
            // 502/503 — transient, retry
            if (resp.status === 502 || resp.status === 503) {
                lastError = new Error(`Honcho ${resp.status}`);
                continue;
            }
            return resp; // Other status codes — return as-is
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error("Honcho unreachable after retries");
}

/**
 * Check if Honcho is reachable via the TCP proxy.
 */
async function honchoHealthCheck(): Promise<boolean> {
    try {
        const resp = await fetchWithRetry(`${HONCHO_BASE_URL}/health`, { timeoutMs: 3000 }, 2);
        if (resp.ok) {
            console.log("[obsidian-honcho-sync] Honcho reachable.");
            return true;
        }
    } catch {
        // Will return false below
    }
    return false;
}

/**
 * Create a Honcho conclusion for the user peer.
 *
 * API: POST /v3/workspaces/{workspace_id}/conclusions
 */
async function pushConclusionToHoncho(
    conclusion: string
): Promise<boolean> {
    const url = `${HONCHO_BASE_URL}/v3/workspaces/${HONCHO_WORKSPACE}/conclusions`;
    const body = JSON.stringify({
        conclusions: [{
            content: conclusion,
            observer_id: HONCHO_OBSERVER_PEER,
            observed_id: HONCHO_OBSERVED_PEER,
        }],
    });

    try {
        const resp = await fetchWithRetry(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            timeoutMs: 10000,
        });
        if (resp.ok) return true;
        const text = await resp.text().catch(() => "");
        console.error(`[obsidian-honcho-sync] Honcho API returned ${resp.status}: ${text.slice(0, 200)}`);
        return false;
    } catch (err: any) {
        console.error(`[obsidian-honcho-sync] Honcho push failed: ${err.message}`);
        return false;
    }
}

/**
 * Get existing conclusions to avoid duplicates.
 */
async function getExistingConclusions(): Promise<string[]> {
    const url = `${HONCHO_BASE_URL}/v3/workspaces/${HONCHO_WORKSPACE}/conclusions/list`;
    const body = JSON.stringify({
        filters: {
            observer_id: HONCHO_OBSERVER_PEER,
            observed_id: HONCHO_OBSERVED_PEER,
        },
    });

    try {
        const resp = await fetchWithRetry(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            timeoutMs: 5000,
        });
        if (resp.ok) {
            const data = await resp.json();
            const items = data?.items ?? [];
            return items.map((c: any) => c?.content ?? "");
        }
    } catch (err: any) {
        console.error(`[obsidian-honcho-sync] Failed to list conclusions: ${err.message}`);
    }
    return [];
}

async function main() {
    console.log("[obsidian-honcho-sync] Starting vault to Honcho sync...");

    const healthy = await honchoHealthCheck();
    if (!healthy) {
        console.error(
            "[obsidian-honcho-sync] Honcho is not reachable. Skipping sync."
        );
        process.exit(0);
    }

    const notes = readVaultForSync(100);
    console.log(`[obsidian-honcho-sync] Read ${notes.length} notes from vault.`);

    if (notes.length === 0) {
        console.log("[obsidian-honcho-sync] No notes to sync. Done.");
        process.exit(0);
    }

    const existing = await getExistingConclusions();
    console.log(
        `[obsidian-honcho-sync] Found ${existing.length} existing conclusions in Honcho.`
    );

    let pushed = 0;
    let skipped = 0;
    let failed = 0;

    for (const note of notes) {
        const contentLines = note.content
            .split("\n")
            .filter(
                (l: string) =>
                    !l.startsWith("---") &&
                    !l.startsWith("tags:") &&
                    !l.startsWith("created:") &&
                    !l.startsWith("updated:") &&
                    l.trim().length > 10
            );

        if (contentLines.length < 3) {
            skipped++;
            continue;
        }

        const noteConclusion = `Obsidian note "${note.title}" (${note.path}): ${contentLines.slice(0, 5).join(" ").substring(0, 300)}`;

        const noteDedupKey = noteConclusion.substring(0, 80);
        let isDup = false;
        for (const existingConclusion of existing) {
            if (existingConclusion.includes(noteDedupKey)) {
                isDup = true;
                break;
            }
        }

        if (isDup) {
            skipped++;
            continue;
        }

        const success = await pushConclusionToHoncho(noteConclusion);
        if (success) {
            pushed++;
        } else {
            failed++;
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log(
        `[obsidian-honcho-sync] Done: ${pushed} pushed, ${skipped} skipped (duplicates/short), ${failed} failed.`
    );
}

main().catch((err) => {
    console.error("[obsidian-honcho-sync] Fatal:", err);
    process.exit(1);
});

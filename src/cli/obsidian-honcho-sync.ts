/**
 * @file    src/cli/obsidian-honcho-sync.ts
 * @purpose CLI tool that reads all vault notes and pushes key facts into Honcho
 *          peer memory via the HTTP API. This bridges Obsidian's filesystem-only
 *          knowledge into Honcho's cross-session semantic recall.
 *
 *          Bridge 3 of 3: Obsidian Vault → Honcho Peer Memory
 *
 *          Honcho runs in WSL2 Docker. When direct fetch() fails from Windows
 *          (IPv6/WSL2 port-forward issue), the script falls back to calling
 *          curl through WSL to reach the API at 127.0.0.1:8000 inside WSL.
 *
 * @author  Hermia
 * @created 2026-06-26
 * @deps    obsidian/bridge, child_process
 * @env     OBSIDIAN_VAULT_PATH
 *          HONCHO_BASE_URL (default: http://127.0.0.1:8000)
 *          HONCHO_WORKSPACE (default: aria)
 *          HONCHO_OBSERVER_PEER (default: hermia)
 *          HONCHO_OBSERVED_PEER (default: Bill)
 */

import { execSync } from "child_process";
import { readVaultForSync } from "../lib/obsidian/bridge";

const HONCHO_BASE_URL = process.env.HONCHO_BASE_URL || "http://127.0.0.1:8000";
const HONCHO_WORKSPACE = process.env.HONCHO_WORKSPACE || "aria";
const HONCHO_OBSERVER_PEER = process.env.HONCHO_OBSERVER_PEER || "hermia";
const HONCHO_OBSERVED_PEER = process.env.HONCHO_OBSERVED_PEER || "Bill";

/**
 * Check if Honcho is reachable via direct fetch (Windows → WSL2 port forward).
 * If that fails, try via WSL curl fallback.
 */
async function honchoHealthCheck(): Promise<boolean> {
    // Try direct fetch first
    try {
        const resp = await fetch(`${HONCHO_BASE_URL}/health`, {
            signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
            console.log("[obsidian-honcho-sync] Honcho reachable via direct fetch.");
            return true;
        }
    } catch {
        // Fall through to WSL fallback
    }

    // Try WSL curl fallback
    try {
        const result = execSync(
            `wsl -e curl -s --max-time 5 http://127.0.0.1:8000/health`,
            { timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        if (result.includes('"ok"')) {
            console.log("[obsidian-honcho-sync] Honcho reachable via WSL curl fallback.");
            return true;
        }
    } catch {
        // Both failed
    }

    return false;
}

/**
 * HTTP POST via WSL curl fallback.
 * Used when Node.js fetch() can't reach WSL2's port-forwarded service.
 */
function wslCurlPost(url: string, body: string): { ok: boolean; status: number; text: string } {
    try {
        // Write body to a temp file to avoid shell escaping issues
        const tmpFile = `/tmp/honcho-sync-${Date.now()}.json`;
        const winTmpFile = execSync(`wsl -e mktemp`, { encoding: "utf-8" }).trim();
        // Write body via wsl
        execSync(`wsl -e bash -c 'cat > ${winTmpFile}'`, {
            input: body,
            encoding: "utf-8",
            timeout: 5000,
        });

        const result = execSync(
            `wsl -e curl -s --max-time 10 -w "\\n%{http_code}" -X POST "http://127.0.0.1:8000${url}" -H "Content-Type: application/json" -d @${winTmpFile}`,
            { timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );

        // Clean up temp file
        execSync(`wsl -e rm -f ${winTmpFile}`, { encoding: "utf-8" });

        const lines = result.trim().split("\n");
        const status = parseInt(lines[lines.length - 1], 10);
        const text = lines.slice(0, -1).join("\n");
        return { ok: status >= 200 && status < 300, status, text };
    } catch (err: any) {
        return { ok: false, status: 0, text: err.message };
    }
}

/**
 * HTTP POST via WSL curl fallback (for listing conclusions).
 */
function wslCurlPostJson(url: string, body: string): { ok: boolean; data: any } {
    const result = wslCurlPost(url, body);
    if (!result.ok) return { ok: false, data: null };
    try {
        return { ok: true, data: JSON.parse(result.text) };
    } catch {
        return { ok: false, data: null };
    }
}

let useWslFallback = false;

/**
 * Create a Honcho conclusion for the user peer.
 *
 * API: POST /v3/workspaces/{workspace_id}/conclusions
 * Body: { "conclusions": [{ "content": "...", "observer_id": "...", "observed_id": "..." }] }
 */
async function pushConclusionToHoncho(
    conclusion: string
): Promise<boolean> {
    const url = `/v3/workspaces/${HONCHO_WORKSPACE}/conclusions`;
    const body = JSON.stringify({
        conclusions: [
            {
                content: conclusion,
                observer_id: HONCHO_OBSERVER_PEER,
                observed_id: HONCHO_OBSERVED_PEER,
            },
        ],
    });

    // Try direct fetch first (if not already in fallback mode)
    if (!useWslFallback) {
        try {
            const resp = await fetch(`${HONCHO_BASE_URL}${url}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(10000),
            });

            if (resp.ok) return true;

            if (resp.status === 404 || resp.status === 0) {
                // Switch to fallback mode
                console.log("[obsidian-honcho-sync] Direct fetch failed, switching to WSL curl fallback.");
                useWslFallback = true;
            } else {
                const text = await resp.text().catch(() => "");
                console.error(`[obsidian-honcho-sync] Honcho API returned ${resp.status}: ${text}`);
                return false;
            }
        } catch {
            useWslFallback = true;
            console.log("[obsidian-honcho-sync] Direct fetch failed, switching to WSL curl fallback.");
        }
    }

    // WSL curl fallback
    const result = wslCurlPost(url, body);
    if (!result.ok) {
        console.error(`[obsidian-honcho-sync] WSL curl failed (status ${result.status}): ${result.text.substring(0, 200)}`);
        return false;
    }
    return true;
}

/**
 * Get existing conclusions to avoid duplicates.
 *
 * API: POST /v3/workspaces/{workspace_id}/conclusions/list
 */
async function getExistingConclusions(): Promise<string[]> {
    const url = `/v3/workspaces/${HONCHO_WORKSPACE}/conclusions/list`;
    const body = JSON.stringify({
        filters: {
            observer_id: HONCHO_OBSERVER_PEER,
            observed_id: HONCHO_OBSERVED_PEER,
        },
    });

    // Try direct fetch first
    if (!useWslFallback) {
        try {
            const resp = await fetch(`${HONCHO_BASE_URL}${url}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(5000),
            });

            if (resp.ok) {
                const data = await resp.json();
                const items = data?.items ?? [];
                return items.map((c: any) => c?.content ?? "");
            }
        } catch {
            useWslFallback = true;
        }
    }

    // WSL curl fallback
    const result = wslCurlPostJson(url, body);
    if (!result.ok || !result.data) return [];
    const items = result.data?.items ?? [];
    return items.map((c: any) => c?.content ?? "");
}

async function main() {
    console.log("[obsidian-honcho-sync] Starting vault to Honcho sync...");

    // 1. Health check Honcho
    const healthy = await honchoHealthCheck();
    if (!healthy) {
        console.error(
            "[obsidian-honcho-sync] Honcho is not reachable. Skipping sync."
        );
        process.exit(0); // Non-fatal — will retry next cron tick
    }

    // 2. Read vault notes
    const notes = readVaultForSync(100);
    console.log(`[obsidian-honcho-sync] Read ${notes.length} notes from vault.`);

    if (notes.length === 0) {
        console.log("[obsidian-honcho-sync] No notes to sync. Done.");
        process.exit(0);
    }

    // 3. Get existing conclusions to avoid duplicates
    const existing = await getExistingConclusions();
    console.log(
        `[obsidian-honcho-sync] Found ${existing.length} existing conclusions in Honcho.`
    );

    // 4. Build conclusion strings from vault notes
    let pushed = 0;
    let skipped = 0;
    let failed = 0;

    for (const note of notes) {
        // Only push notes with substantive content (not just frontmatter)
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

        // Create a concise conclusion from the note
        const noteConclusion = `Obsidian note "${note.title}" (${note.path}): ${contentLines.slice(0, 5).join(" ").substring(0, 300)}`;

        // Check dedup
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

        // Rate limit: don't flood Honcho
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

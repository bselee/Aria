/**
 * @file    complete-no-freight-pos.ts
 * @purpose Dry-run (default) or complete committed received POs for vendors
 *          that never need freight attached, once invoice goods match the PO.
 *
 *          Does not flip PO_AUTO_COMPLETE_ENABLED. --live is the only write
 *          from this CLI. The weekday cron stays dry-run unless
 *          NO_FREIGHT_PO_COMPLETE_ENABLED is set.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/complete-no-freight-pos.ts
 *   node --env-file=.env.local --import tsx src/cli/complete-no-freight-pos.ts --po 125273
 *   node --env-file=.env.local --import tsx src/cli/complete-no-freight-pos.ts --live
 *
 * @author  Hermia
 * @created 2026-09-28
 * @deps    purchasing/no-freight-po-complete
 * @env     NO_FREIGHT_PO_COMPLETE_ENABLED, FINALE_API_KEY, FINALE_API_SECRET
 */

import { pathToFileURL } from "url";
import { runNoFreightPOComplete } from "../lib/purchasing/no-freight-po-complete";

function arg(flag: string): string | undefined {
    const i = process.argv.indexOf(flag);
    if (i === -1) return undefined;
    return process.argv[i + 1];
}

async function main(): Promise<void> {
    const live = process.argv.includes("--live");
    const orderId = arg("--po");
    const limitRaw = arg("--limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const stats = await runNoFreightPOComplete({
        live,
        orderId,
        limit: Number.isFinite(limit) ? limit : undefined,
    });
    console.log(
        `scanned=${stats.scanned} eligible=${stats.eligible} completed=${stats.completed} ` +
        `skipped=${stats.skipped} errors=${stats.errors} dryRun=${stats.dryRun}`,
    );
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exit(1);
    });
}

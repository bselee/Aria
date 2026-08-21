/**
 * @file    src/cli/three-way-match-dry-run.ts
 * @purpose CLI dry-run of the 3-way automation — loads every matched invoice's
 *          PO + receipt + invoice, prints the canonical verdict for each, and
 *          writes NOTHING. Documents the three-way verdict across the live
 *          dataset (the golden fixture test covers the reference case).
 *
 * @author  aria-coder
 * @created 2026-08-12
 * @deps    @/lib/purchasing/three-way-match-runner, dotenv
 *
 * Usage:
 *   node --import tsx --env-file=.env.local src/cli/three-way-match-dry-run.ts
 *   node --import tsx --env-file=.env.local src/cli/three-way-match-dry-run.ts --limit 100
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { runThreeWayMatchAutomation } from "@/lib/purchasing/three-way-match-runner";

const args = process.argv.slice(2);
const LIMIT_INDEX = args.indexOf("--limit");
const LIMIT = LIMIT_INDEX >= 0 ? parseInt(args[LIMIT_INDEX + 1], 10) : 50;

async function main() {
    const r = await runThreeWayMatchAutomation({ limit: LIMIT, dryRun: true });
    console.log(
        `[three-way-dry-run] processed=${r.processed} matched=${r.matched} ` +
        `variance=${r.variance} exception=${r.exception} ` +
        `incomplete=${r.incomplete} errors=${r.errors}`,
    );
    for (const d of r.details) console.log("  " + d);
}

main().catch((e) => {
    console.error("[three-way-dry-run] fatal:", e);
    process.exit(1);
});

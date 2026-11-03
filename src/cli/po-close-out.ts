/**
 * @file    src/cli/po-close-out.ts
 * @purpose Run the PO close-out rule as a dry-run (default) or live.
 *
 *   node --import tsx --env-file=.env.local src/cli/po-close-out.ts
 *   node --import tsx --env-file=.env.local src/cli/po-close-out.ts --order 125247
 *   PO_CLOSE_OUT_ENABLED=true node ... --order 125247        # live, one PO
 *
 * Live requires BOTH the env flag and --order, so a bare run can never write.
 *
 * @author  Hermia
 * @created 2026-10-29
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import { FinaleClient } from "../lib/finale/client";
import { isOpenOrderingStatus } from "../lib/purchasing/ordering-po-coverage";
import { runPoCloseOut, closeOutEnabled } from "../lib/purchasing/po-close-out-runner";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const orderIdx = args.indexOf("--order");
    const single = orderIdx >= 0 ? args[orderIdx + 1] : null;

    let ids: string[];
    if (single) {
        ids = [single];
    } else {
        const client = new FinaleClient();
        const pos = await client.getRecentPurchaseOrders(180, 500);
        ids = pos
            .filter((p) => isOpenOrderingStatus(p.status ?? ""))
            .map((p) => String(p.orderId));
    }

    console.log(
        `[po-close-out] enabled=${closeOutEnabled()} candidates=${ids.length}` +
            (single ? " (single PO — live path is permitted)" : " (scan — dry-run only)"),
    );

    // Never let a bare scan write, even with the flag on: a scan writes nothing
    // unless the operator named a PO.
    const stats = single
        ? await runPoCloseOut(ids)
        : await runPoCloseOutDryOnly(ids);

    for (const a of stats.actions) {
        const verdict = a.action === "none" ? "skip " : a.action.toUpperCase().padEnd(6);
        console.log(
            `  ${verdict} ${a.orderId} — ${a.reason}` +
                (a.blockers.length ? ` | blockers: ${a.blockers.join("; ")}` : ""),
        );
    }
    console.log(
        `[po-close-out] scanned=${stats.scanned} commit=${stats.committed} complete=${stats.completed} skipped=${stats.skipped} errors=${stats.errors} dryRun=${stats.dryRun}`,
    );
}

/**
 * Force a dry-run for the scan path regardless of the env flag.
 *
 * @param ids PO numbers to evaluate.
 */
async function runPoCloseOutDryOnly(ids: string[]) {
    const prev = process.env.PO_CLOSE_OUT_ENABLED;
    process.env.PO_CLOSE_OUT_ENABLED = "false";
    try {
        return await runPoCloseOut(ids);
    } finally {
        if (prev === undefined) delete process.env.PO_CLOSE_OUT_ENABLED;
        else process.env.PO_CLOSE_OUT_ENABLED = prev;
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });

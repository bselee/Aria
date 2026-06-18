/**
 * @file    run-ap-local.ts
 * @purpose CLI entry point to run the local-first AP forwarder standalone.
 *          Scans Gmail, forwards invoice PDFs to Bill.com, tracks in local SQLite.
 *          Optionally runs reconciliation handoff only.
 * @usage   node --import tsx --env-file=.env.local src/cli/run-ap-local.ts
 *          node --import tsx --env-file=.env.local src/cli/run-ap-local.ts --reconcile
 *          node --import tsx --env-file=.env.local src/cli/run-ap-local.ts --queue
 */
import { runLocalApForward, runReconciliationHandoff, getLocalForwardQueue } from "../lib/intelligence/workers/ap-local-forwarder";

(async () => {
    const args = process.argv.slice(2);

    // --queue: print the local forward queue
    if (args.includes("--queue")) {
        console.log("=== AP Local Forward Queue ===\n");
        const queue = getLocalForwardQueue();
        if (queue.length === 0) {
            console.log("(empty)");
        } else {
            for (const row of queue) {
                console.log(
                    `[${row.id}] ${row.status} | ${row.reconciliation_status || "—"} | ` +
                    `${row.pdf_filename} | from=${row.email_from?.slice(0, 25)} | ` +
                    `PO=${row.matched_po_number || "—"} | ${row.forwarded_at}`,
                );
            }
        }
        process.exit(0);
    }

    // --reconcile: run reconciliation handoff only (no Gmail scanning)
    if (args.includes("--reconcile")) {
        console.log("=== Aria AP Reconciliation Handoff (standalone) ===\n");
        const result = await runReconciliationHandoff();
        console.log("\n=== Result ===");
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    }

    // Default: run full forward cycle (includes reconciliation handoff at end)
    console.log("=== Aria AP Local Forwarder (standalone) ===\n");
    const result = await runLocalApForward();
    console.log("\n=== Result ===");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
})();

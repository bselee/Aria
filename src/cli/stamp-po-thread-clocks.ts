/**
 * @file    src/cli/stamp-po-thread-clocks.ts
 * @purpose One pass: stamp sold-out PO threads from bill.selee@ onto purchase_orders.
 * @author  Hermia
 * @created 2026-09-24
 * @deps    po-thread-clock-stamp
 * @env     Gmail OAuth default slot, PostgREST
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { stampStockoutThreads } from "@/lib/purchasing/po-thread-clock-stamp";

async function main(): Promise<void> {
    const result = await stampStockoutThreads();
    console.log(JSON.stringify(result));
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
});

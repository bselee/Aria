/**
 * @file    reconcile-received-pos.ts
 * @purpose Runs a PO-first sweep: fetches recently received or committed POs from 
 *          Finale, looks for matching invoices in vendor_invoices, and runs 
 *          the reconciliation engine on any new matches.
 *
 * @usage   node --import tsx src/cli/reconcile-received-pos.ts [--days=60] [--dry-run]
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { runPOSweep } from "../lib/matching/po-sweep";

const DRY_RUN = process.argv.includes("--dry-run");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS_BACK = daysArg ? Math.max(1, parseInt(daysArg.split("=")[1], 10)) : 60;

async function run() {
    await runPOSweep(DAYS_BACK, DRY_RUN);
}

run();

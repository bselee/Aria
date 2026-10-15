/**
 * @file    src/cli/audit-po-status.ts
 * @purpose Read-only status audit for purchase orders: every fully received PO belongs in
 *          ORDER_COMPLETED, but an unlock/restore edit cycle maps COMPLETED back to
 *          ORDER_LOCKED by design (see `restoreOrderStatus`, DECISION 2026-03-18, and the
 *          "restores completed or locked orders back to committed" test in
 *          src/lib/finale/client.test.ts). That leaves edited, fully received POs looking
 *          open to Active Purchases, the dashboard po-sync, and the reorder engine.
 *
 *          Reads status from the order document, NOT GraphQL: GraphQL `status` lags behind
 *          a REST status write and reports "Committed" for a PO that is already
 *          ORDER_COMPLETED.
 *
 * Usage:
 *   tsx src/cli/audit-po-status.ts --pos 124289,124312
 *   tsx src/cli/audit-po-status.ts --file .tmp/po-list.json        # array of {po} or ["124289"]
 *   tsx src/cli/audit-po-status.ts --pos ... --live                # re-complete the drifted ones
 *   --gap <ms>   pause between Finale reads (default 900)
 *
 * Exit code 1 when a fully received PO is not COMPLETED.
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as fs from "fs";
import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
};
const GAP = Number(argVal("--gap") || process.env.AUDIT_GAP_MS || 900);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PO ids from --pos (csv) or --file (array of ids or of objects with a `po` field). */
function poList(): string[] {
    const csv = argVal("--pos");
    if (csv) return csv.split(",").map((s) => s.trim()).filter(Boolean);
    const file = argVal("--file");
    if (file) {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (!Array.isArray(raw)) throw new Error("--file must contain a JSON array");
        return raw.map((r: unknown) => (typeof r === "string" ? r : String((r as { po?: string })?.po ?? ""))).filter(Boolean);
    }
    throw new Error("pass --pos <csv> or --file <json>");
}

/**
 * Received and remaining units per line, from the line documents.
 * The order-level item list does not carry them.
 */
async function lineUnits(client: any, doc: any): Promise<{ remaining: number | null; received: number | null }> {
    const urls: string[] = (doc.orderItemList || []).map((l: any) => l.orderItemUrl).filter(Boolean);
    if (!urls.length) return { remaining: 0, received: 0 };
    let remaining = 0;
    let received = 0;
    for (const url of urls) {
        const line: any = await client.get(url).catch(() => null);
        if (!line) return { remaining: null, received: null };
        const rem = line.productUnitsRemainingToBeShipped;
        const rec = line.productUnitsReceived;
        if (rem === undefined && rec === undefined) return { remaining: null, received: null };
        remaining += Number(String(rem ?? 0).replace(/,/g, "")) || 0;
        received += Number(String(rec ?? 0).replace(/,/g, "")) || 0;
        await sleep(250);
    }
    return { remaining, received };
}

async function main(): Promise<void> {
    const pos = poList();
    const client: any = new FinaleClient();
    console.log(`${pos.length} PO(s) | mode=${LIVE ? "LIVE" : "report only"}\n`);
    console.log("po        status            lines  received  remaining  verdict");
    const drifted: string[] = [];
    for (const po of pos) {
        const doc: any = await client.getOrderDetails(po).catch((e: any) => ({ error: String(e.message).slice(0, 50) }));
        if (doc.error) {
            console.log(`${po}  read failed: ${doc.error}`);
            await sleep(GAP);
            continue;
        }
        const lines = (doc.orderItemList || []).length;
        const isOpen = doc.statusId !== "ORDER_COMPLETED" && doc.statusId !== "ORDER_CANCELLED";
        const units = isOpen ? await lineUnits(client, doc) : { remaining: null, received: null };
        let verdict = "";
        if (doc.statusId === "ORDER_CANCELLED") verdict = "cancelled";
        else if (doc.statusId === "ORDER_COMPLETED") verdict = "";
        else if (units.remaining === 0) {
            verdict = "SHOULD BE COMPLETED";
            drifted.push(po);
        } else verdict = "genuinely open";
        console.log(
            `${po}  ${String(doc.statusId).padEnd(17)} ${String(lines).padStart(5)}  ${String(units.received ?? "-").padStart(8)}  ${String(units.remaining ?? "-").padStart(9)}  ${verdict}`,
        );
        await sleep(GAP);
    }
    console.log(`\n${drifted.length} fully received but not COMPLETED: ${drifted.join(", ") || "none"}`);
    if (!LIVE || !drifted.length) {
        if (drifted.length) console.log("re-run with --live to re-complete them.");
        process.exitCode = drifted.length ? 1 : 0;
        return;
    }
    for (const po of drifted) {
        await client.completeOrder(po);
        await sleep(GAP);
        const after: any = await client.getOrderDetails(po);
        console.log(`${po} -> ${after.statusId}`);
        await sleep(GAP);
    }
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

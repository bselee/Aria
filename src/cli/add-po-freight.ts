/**
 * @file    src/cli/add-po-freight.ts
 * @purpose Append a missing freight amount to existing POs, either a vendor house
 *          charge or the inbound carrier amount.
 *
 *          Uline bills $1.50 of shipping/handling on every FREIGHT COLLECT invoice,
 *          and the carriage itself arrives on the FedEx bill. A collect PO must
 *          therefore carry two Freight lines: 1.50 and the carrier amount. POs have
 *          gone wrong in both directions: some got the carrier amount without the
 *          house charge, and some were completed with only the house charge because
 *          the carrier bill had not landed yet.
 *
 *          Appends a bare `Freight` line with ADJ_BY_WEIGHT and an allocation list
 *          sized to the raw item count, which is what makes it reach landed cost.
 *          Never removes or rewrites an existing line.
 *
 *          The unlock cycle maps a COMPLETED PO back to ORDER_LOCKED, so a PO that
 *          was completed before the edit is re-completed afterwards.
 *
 * Usage:
 *   tsx src/cli/add-po-freight.ts --pos 123820,123835
 *   tsx src/cli/add-po-freight.ts --pos 123820,123835 --live
 *   --amount <n>  freight amount to add (default 1.5, the Uline house charge)
 *   --gap <ms>    pause between Finale calls (default 1500)
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client, finale/freight-adjustment
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import { freightAdjustmentForPo, FINALE_FREIGHT_PROMO_URL } from "../lib/finale/freight-adjustment";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
};
const AMOUNT = Number(argVal("--amount") || 1.5);
const GAP = Number(argVal("--gap") || 1500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POS = (argVal("--pos") || "").split(",").map((s) => s.trim()).filter(Boolean);

/** Existing freight lines on a PO document. */
function freightLines(doc: any): any[] {
    return (doc.orderAdjustmentList || []).filter((a: any) =>
        String(a.productPromoUrl || "").includes(FINALE_FREIGHT_PROMO_URL.split("/").pop()!),
    );
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;

async function main(): Promise<void> {
    if (!POS.length) {
        console.error("usage: add-po-freight.ts --pos <csv> [--amount 1.5] [--live]");
        process.exit(2);
    }
    const client: any = new FinaleClient();
    console.log(`${POS.length} PO(s) | freight ${money(AMOUNT)} | mode=${LIVE ? "LIVE" : "report only"}\n`);

    for (const po of POS) {
        const doc: any = await client.getOrderDetails(po);
        const items = (doc.orderItemList || []).length;
        const lines = freightLines(doc);
        const total = lines.reduce((s: number, a: any) => s + Number(a.amount || 0), 0);
        const hasHouse = lines.some((a: any) => Math.abs(Number(a.amount) - AMOUNT) < 0.001);
        console.log(
            `${po}  ${doc.statusId}  items=${items}  freight=${money(total)}  lines=${lines.map((a: any) => money(a.amount)).join("+") || "none"}${hasHouse ? "  (house charge already present)" : ""}`,
        );
        if (hasHouse) {
            await sleep(GAP);
            continue;
        }
        if (!LIVE) {
            console.log(`      would append Freight ${money(AMOUNT)} with ADJ_BY_WEIGHT over ${items} line(s)`);
            await sleep(200);
            continue;
        }

        const originalStatus = await client.unlockForEditing(doc, po);
        const allocLines = await client.freightAllocLines(doc.orderItemList);
        doc.orderAdjustmentList = [
            ...(doc.orderAdjustmentList || []),
            freightAdjustmentForPo(AMOUNT, allocLines),
        ];
        await sleep(GAP);
        await client.post(`/${process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics"}/api/order/${encodeURIComponent(po)}`, doc);
        await sleep(GAP);
        await client.restoreOrderStatus(po, originalStatus);
        if (originalStatus === "ORDER_COMPLETED") {
            await sleep(GAP);
            await client.completeOrder(po);
        }
        await sleep(GAP);
        const after: any = await client.getOrderDetails(po);
        const afterLines = freightLines(after);
        console.log(
            `      -> ${after.statusId}  freight=${money(afterLines.reduce((s: number, a: any) => s + Number(a.amount || 0), 0))}  lines=${afterLines.map((a: any) => `${money(a.amount)}/${a.adjustmentAllocationEnumId ?? "-"}/${(a.orderAdjustmentAllocationList || []).length}`).join("  ")}`,
        );
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

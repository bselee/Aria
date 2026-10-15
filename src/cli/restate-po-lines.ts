/**
 * @file    src/cli/restate-po-lines.ts
 * @purpose Restate purchase-order line quantities and unit prices in place, with no
 *          receiving and no inventory movement. The order document is unlocked
 *          (actionUrlEdit), each targeted line is rewritten by its orderItem id, the
 *          document is posted back whole so freight/tax adjustments survive, and the
 *          original status is restored. Report-only unless --live is passed.
 *
 *          Built for the Uline pack-vs-each class of error: a vendor invoice bills
 *          "2 CT @ 103.00" while our SKU is stocked in eaches (Finale stdPacking
 *          500/case), so the PO must read "1,000 @ 0.206" to match both the invoice
 *          and how the goods were received historically.
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    src/lib/finale/client.ts (getOrderDetails, unlockForEditing, post, restoreOrderStatus)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/restate-po-lines.ts --plan <file.json>
 *   node --env-file=.env.local --import tsx src/cli/restate-po-lines.ts --plan <file.json> --live
 *
 * Plan shape:
 *   { "po": "124636",
 *     "lines": [ { "orderItemId": "00000001", "sku": "S-1665", "quantity": 500, "unitPrice": 0.206 } ] }
 *
 * orderItemId is the trailing segment of orderItemUrl (".../orderItem/00000001"), which
 * is the only unambiguous way to address a PO that carries the same SKU on two lines.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as fs from "fs";
import { FinaleClient } from "../lib/finale/client";

interface RestateLine {
    orderItemId: string;
    sku: string;
    quantity: number;
    unitPrice: number;
}

interface RestatePlan {
    po: string;
    lines: RestateLine[];
}

/** Pause between Finale calls; the API rate-limits hard and 429s strand a PO mid-edit. */
const GAP_MS = Number(process.env.FINALE_GAP_MS || 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function money(n: number): string {
    return `$${n.toFixed(2)}`;
}

/** Sum of quantity x unitPrice across the order lines. */
function goodsTotal(items: any[]): number {
    return (items || []).reduce((sum, it) => sum + Number(it.quantity) * Number(it.unitPrice), 0);
}

/** Trailing id of an orderItemUrl ("/api/order/124636/orderItem/00000001" -> "00000001"). */
function itemIdOf(line: any): string {
    const url: string = line.orderItemUrl || "";
    return url.split("/").filter(Boolean).pop() || "";
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const planPath = args[args.indexOf("--plan") + 1];
    const live = args.includes("--live");
    if (!planPath || planPath.startsWith("--")) {
        console.error("Usage: restate-po-lines.ts --plan <file.json> [--live]");
        process.exit(2);
    }
    const plan: RestatePlan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    const client: any = new FinaleClient();

    console.log(`PO ${plan.po} | ${plan.lines.length} line(s) | mode=${live ? "LIVE" : "report only"}`);
    const doc: any = await client.getOrderDetails(plan.po);
    const beforeItems: any[] = doc.orderItemList || [];
    console.log(`status=${doc.statusId}  lines=${beforeItems.length}  goods now=${money(goodsTotal(beforeItems))}`);
    console.log(`\n${"line".padEnd(9)} ${"sku".padEnd(9)} ${"qty".padStart(6)} ${"->".padStart(4)} ${"qty".padStart(7)}   ${"price".padStart(8)} ${"->".padStart(3)} ${"price".padStart(9)}   ext before -> after`);

    const projected = beforeItems.map((it) => ({ ...it }));
    for (const spec of plan.lines) {
        const target = projected.find((it) => itemIdOf(it) === spec.orderItemId);
        if (!target) {
            console.error(`  !! orderItem ${spec.orderItemId} (${spec.sku}) not found on PO ${plan.po}`);
            process.exit(1);
        }
        if (target.productId !== spec.sku) {
            console.error(`  !! orderItem ${spec.orderItemId} is ${target.productId}, plan says ${spec.sku}`);
            process.exit(1);
        }
        const extBefore = Number(target.quantity) * Number(target.unitPrice);
        target.quantity = spec.quantity;
        target.unitPrice = spec.unitPrice;
        const extAfter = target.quantity * target.unitPrice;
        console.log(
            `${spec.orderItemId.padEnd(9)} ${spec.sku.padEnd(9)} ${String(beforeItems.find((b) => itemIdOf(b) === spec.orderItemId).quantity).padStart(6)} ${"->".padStart(4)} ${String(spec.quantity).padStart(7)}   ${String(beforeItems.find((b) => itemIdOf(b) === spec.orderItemId).unitPrice).padStart(8)} ${"->".padStart(3)} ${String(spec.unitPrice).padStart(9)}   ${money(extBefore)} -> ${money(extAfter)}`,
        );
    }
    console.log(`\ngoods before ${money(goodsTotal(beforeItems))} -> after ${money(goodsTotal(projected))}`);

    if (!live) {
        console.log("\nreport only. re-run with --live to write.");
        return;
    }

    const originalStatus = await client.unlockForEditing(doc, plan.po);
    for (const spec of plan.lines) {
        const target = (doc.orderItemList || []).find((it: any) => itemIdOf(it) === spec.orderItemId);
        target.quantity = spec.quantity;
        target.unitPrice = spec.unitPrice;
    }
    await sleep(GAP_MS);
    await client.post(`/${process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics"}/api/order/${encodeURIComponent(plan.po)}`, doc);
    await sleep(GAP_MS);
    await client.restoreOrderStatus(plan.po, originalStatus);

    await sleep(GAP_MS);
    const after: any = await client.getOrderDetails(plan.po);
    const afterItems: any[] = after.orderItemList || [];
    console.log(`\nwrote. status=${after.statusId} (was ${originalStatus})  goods=${money(goodsTotal(afterItems))}`);
    for (const spec of plan.lines) {
        const it = afterItems.find((x: any) => itemIdOf(x) === spec.orderItemId);
        console.log(`  ${spec.sku.padEnd(9)} qty=${String(it.quantity).padStart(6)} @${String(it.unitPrice).padStart(9)}  ext=${money(it.quantity * it.unitPrice)}`);
    }
    console.log(`  adjustments: ${(after.orderAdjustmentList || []).map((a: any) => `${a.description} ${money(a.amount)}`).join(" | ")}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

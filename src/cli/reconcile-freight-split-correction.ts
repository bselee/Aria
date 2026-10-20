/**
 * @file    reconcile-freight-split-correction.ts
 * @purpose Apply a multi-PO freight split correction to Finale POs: rewrite each
 *          PO's freight adjustment to the weight-split-correct amount. Forced
 *          fresh name-first allocation (does NOT reuse a stale/buggy allocation
 *          list). Bare "Freight" line only — no BOL/PRO/notes, ADJ_BY_WEIGHT,
 *          allocation list sized to the raw order item count.
 *
 *          Completion rule (Bill 2026-10-20): complete iff fully received; a
 *          partial-receipt PO stays committed/open. `restoreOrderStatus` demotes
 *          COMPLETED → LOCKED, so this re-completes when the PO started completed
 *          OR is fully received.
 *
 *          Targets are passed on the CLI as PO:amount pairs. Report-only by
 *          default; --live writes.
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/reconcile-freight-split-correction.ts \
 *            125393:117.04 125271:187.27 125241:523.62 125008:514.35 [--live] [--gap 800]
 *
 * @author  Hermia
 * @created 2026-10-20
 * @deps    finale/client, finale/freight-adjustment, finale/core-client
 * @env     FINALE_API_KEY, FINALE_API_SECRET
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { FinaleClient } from "../lib/finale/client";
import { freightAdjustmentForPo, FINALE_FREIGHT_PROMO_URL } from "../lib/finale/freight-adjustment";
import { getShipmentReceiptItems } from "../lib/finale/core-client";

const LIVE = process.argv.includes("--live");
const gapIdx = process.argv.indexOf("--gap");
const GAP = gapIdx >= 0 ? (Number(process.argv[gapIdx + 1]) || 800) : 800;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Narrow write surface over FinaleClient (same pattern as the mailbox CLI). */
interface FinaleWriteSurface {
    getOrderDetails(orderId: string): Promise<any>;
    getShipmentDetails(shipmentUrl: string): Promise<any>;
    freightAllocLines(
        orderItemList: Array<{ productId?: string; quantity?: number; weight?: number }> | undefined,
    ): Promise<Array<{ quantity: number; weight?: number }>>;
    unlockForEditing(currentPO: any, orderId: string): Promise<string>;
    restoreOrderStatus(orderId: string, originalStatus: string): Promise<void>;
    completeOrder(orderId: string): Promise<unknown>;
    post(endpoint: string, body: unknown): Promise<unknown>;
}

/** Parse PO:amount targets from argv, e.g. "125393:117.04". */
function parseTargets(argv: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const a of argv) {
        if (a.startsWith("--")) continue;
        const m = a.match(/^(\d{6}):([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) throw new Error(`bad target "${a}" — expected PO:amount (e.g. 125393:117.04)`);
        out[m[1]] = Number(m[2]);
    }
    if (!Object.keys(out).length) throw new Error("no PO:amount targets given");
    return out;
}

/** True when every non-blank order line has received ≥ ordered qty. */
async function fullyReceived(finale: FinaleWriteSurface, poId: string): Promise<boolean> {
    const po = await finale.getOrderDetails(poId);
    const lines = (po.orderItemList || []).filter((i: any) => i.productId && (Number(i.quantity) || 0) > 0);
    if (!lines.length) return false;
    const got = new Map<string, number>();
    const urls = (po.shipmentUrlList || []).map(String).filter(Boolean);
    for (const url of urls) {
        const s = await finale.getShipmentDetails(url);
        if (s.statusId !== "SHIPMENT_DELIVERED") continue;
        for (const it of getShipmentReceiptItems(s)) {
            got.set(String(it.productId), (got.get(String(it.productId)) || 0) + (Number(it.quantity) || 0));
        }
    }
    for (const ln of lines) {
        const need = Number(ln.quantity) || 0;
        if ((got.get(String(ln.productId)) || 0) < need) return false;
    }
    return true;
}

async function applyOne(finale: FinaleWriteSurface, poId: string, target: number): Promise<void> {
    const po = await finale.getOrderDetails(poId);
    const originalStatus = po.statusId;
    const items = await finale.freightAllocLines(po.orderItemList);

    // Fresh allocation — pass null so a stale allocation list is NOT reused.
    const replacement = freightAdjustmentForPo(target, items, null);

    const adjustments = (po.orderAdjustmentList || []).filter(
        (a: any) => a.productPromoUrl !== FINALE_FREIGHT_PROMO_URL,
    );
    adjustments.push(replacement);

    const postBody = { ...po, orderAdjustmentList: adjustments };
    const currentFreight = (po.orderAdjustmentList || [])
        .filter((a: any) => (a.productPromoUrl || "").includes("/10007") && Number(a.amount) > 2.5)
        .reduce((s: number, a: any) => s + (Number(a.amount) || 0), 0);

    const received = await fullyReceived(finale, poId);
    const alloc = replacement.orderAdjustmentAllocationList || [];
    console.log(
        `PO ${poId}: freight $${currentFreight.toFixed(2)} → $${target.toFixed(2)}  ` +
        `(status ${originalStatus}, fullyReceived=${received})  alloc=[${alloc.join(", ")}]`,
    );

    if (!LIVE) return;

    await finale.unlockForEditing(po, poId);
    await finale.post(
        `/buildasoilorganics/api/order/${encodeURIComponent(poId)}`,
        postBody,
    );
    await finale.restoreOrderStatus(poId, originalStatus);
    if (originalStatus === "ORDER_COMPLETED" || received) {
        await finale.completeOrder(poId);
    }
    await sleep(GAP);
}

async function main() {
    const targets = parseTargets(process.argv.slice(2));
    const finale = new FinaleClient() as unknown as FinaleWriteSurface;
    console.log(LIVE ? "LIVE MODE — writing" : "DRY RUN — no writes\n");
    for (const [poId, target] of Object.entries(targets)) {
        await applyOne(finale, poId, target);
    }
    console.log(LIVE ? "\nDone." : "\nPass --live to write.");
}

main().catch((e) => { console.error(e); process.exit(1); });

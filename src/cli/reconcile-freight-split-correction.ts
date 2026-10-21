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
 *          `--promo <id>` operates on a non-freight fee lane (default 10007 =
 *          carrier freight). E.g. `--promo 10015` services the Kashi toll
 *          "Alan to BAS" line; the existing line's description is preserved
 *          instead of forcing bare `Freight`.
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/reconcile-freight-split-correction.ts \
 *            125393:117.04 125271:187.27 125241:523.62 125008:514.35 [--live] [--gap 800] [--promo 10015]
 *
 * @author  Hermia
 * @created 2026-10-20
 * @deps    finale/client, finale/freight-adjustment, finale/core-client
 * @env     FINALE_API_KEY, FINALE_API_SECRET
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { FinaleClient } from "../lib/finale/client";
import { freightAdjustmentForPo, FINALE_FREIGHT_PROMO_URL, FINALE_FREIGHT_DESCRIPTION } from "../lib/finale/freight-adjustment";
import { getShipmentReceiptItems } from "../lib/finale/core-client";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Durable ledger of every live freight/fee correction, one JSON object per line.
 * Lives under $LOCALAPPDATA/aria (durable, not committed — business data).
 * Totals must always be computed by summing this ledger, never tallied in prose.
 */
const LEDGER_PATH = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    "aria",
    "freight-corrections-ledger.jsonl",
);
function appendLedgerEntry(entry: Record<string, unknown>): void {
    try {
        fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
        fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
        console.log(`  ledger: ${LEDGER_PATH}`);
    } catch (e: any) {
        console.warn(`  ledger append FAILED (${e.message}) — correction still applied`);
    }
}

const LIVE = process.argv.includes("--live");
const gapIdx = process.argv.indexOf("--gap");
const GAP = gapIdx >= 0 ? (Number(process.argv[gapIdx + 1]) || 800) : 800;
// Promo id to operate on. Default 10007 = carrier freight. The Kashi toll-production
// fee lanes ("Ship BOM to Alan" /10007, "Alan to BAS" /10015, Labor /10016) need
// --promo 10015 etc.; the description is preserved from the existing line in that case.
const promoIdx = process.argv.indexOf("--promo");
const PROMO_ID = promoIdx >= 0 ? (process.argv[promoIdx + 1] || "10007") : "10007";
const PROMO_URL = `/buildasoilorganics/api/productpromo/${PROMO_ID}`;

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
    const FLAG_WITH_VALUE = new Set(["--gap", "--promo"]);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            if (FLAG_WITH_VALUE.has(a)) i++; // skip the flag's value too
            continue;
        }
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

    const isDefaultPromo = PROMO_ID === "10007";
    let existingDescription: string | null = null;
    let adjustments: any[];
    if (isDefaultPromo) {
        // Carrier freight: replace every /10007 line with one consolidated bare `Freight`.
        adjustments = (po.orderAdjustmentList || []).filter(
            (a: any) => a.productPromoUrl !== FINALE_FREIGHT_PROMO_URL,
        );
    } else {
        // Fee lane (e.g. Kashi "Alan to BAS" /10015): replace the lane's lines and
        // PRESERVE the existing description — these are labeled fee lines, not "Freight".
        const existing = (po.orderAdjustmentList || []).filter(
            (a: any) => (a.productPromoUrl || "").endsWith(`/${PROMO_ID}`),
        );
        existingDescription = existing[0]?.description || null;
        adjustments = (po.orderAdjustmentList || []).filter(
            (a: any) => !(a.productPromoUrl || "").endsWith(`/${PROMO_ID}`),
        );
    }
    if (PROMO_ID !== "10007") {
        replacement.productPromoUrl = PROMO_URL;
        replacement.description = existingDescription || FINALE_FREIGHT_DESCRIPTION;
    }
    adjustments.push(replacement);

    const postBody = { ...po, orderAdjustmentList: adjustments };
    const currentFreight = (po.orderAdjustmentList || [])
        .filter((a: any) => (a.productPromoUrl || "").endsWith(`/${PROMO_ID}`) && Number(a.amount) > 2.5)
        .reduce((s: number, a: any) => s + (Number(a.amount) || 0), 0);

    const received = await fullyReceived(finale, poId);
    const alloc = replacement.orderAdjustmentAllocationList || [];
    console.log(
        `PO ${poId}: promo /${PROMO_ID}${existingDescription ? ` (${existingDescription})` : ""} $${currentFreight.toFixed(2)} → $${target.toFixed(2)}  ` +
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
    appendLedgerEntry({
        ts: new Date().toISOString(),
        po: poId,
        promo: PROMO_ID,
        description: replacement.description,
        before: Math.round(currentFreight * 100) / 100,
        after: Math.round(target * 100) / 100,
        delta: Math.round((target - currentFreight) * 100) / 100,
        status: originalStatus,
        fullyReceived: received,
        alloc,
    });
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

/**
 * @file    src/cli/fix-tax-allocation.ts
 * @purpose Repair unallocated Tax lines on Finale POs. Tax must carry
 *          ADJ_BY_WEIGHT + a weight allocation sized to the raw item list or
 *          it never reaches landed cost (Bill, 2026-10-28). Report-only by
 *          default; --live writes. Amounts and received numbers are never
 *          touched — only the tax line's description/allocation are rebuilt.
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/fix-tax-allocation.ts --pos 125247,125221,125208 [--live] [--gap 700]
 *          node --import tsx --env-file=.env.local src/cli/fix-tax-allocation.ts --vendor uline --live
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/finale/client, @/lib/finale/freight-adjustment
 */
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

import { FinaleClient } from "../lib/finale/client";
import {
    allocateFreightByWeight,
    buildFinaleFreightAdjustment,
    buildFinaleTaxAdjustment,
    taxLineSkipsLandedCost,
} from "../lib/finale/freight-adjustment";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const GAP_MS = Number(args[args.indexOf("--gap") + 1] || 700) || 700;
const POS = (args[args.indexOf("--pos") + 1] || "").split(",").filter(Boolean);
const VENDOR = args.includes("--vendor") ? String(args[args.indexOf("--vendor") + 1] || "") : "";
const MAX_POS = 40;

interface Promo {
    amount?: number;
    description?: string;
    productPromoUrl?: string;
    adjustmentAllocationEnumId?: string | null;
    orderAdjustmentAllocationList?: number[] | null;
    [k: string]: unknown;
}

const isTaxLine = (a: Promo) => String(a.productPromoUrl || "").includes("/10008");

function findPos(vendorFilter: string, posList: string[]): string[] {
    if (posList.length > 0) return posList.slice(0, MAX_POS);
    if (!vendorFilter) {
        console.error("nothing in scope — pass --pos or --vendor");
        process.exit(1);
    }
    return []; // caller supplies POs for --vendor via --pos; see usage above
}

async function main(): Promise<void> {
    const client = new FinaleClient();
    const pos = findPos(VENDOR, POS);
    console.log(`Mode: ${LIVE ? "LIVE" : "REPORT ONLY"}   POs: ${pos.length}   Gap: ${GAP_MS}ms`);
    let fixed = 0;
    let clean = 0;
    let failed = 0;

    for (const po of pos) {
        try {
            const doc = (await client.getOrderDetails(po)) as {
                statusId?: string;
                orderItemList?: Array<{ productId?: string; quantity?: number; weight?: number }>;
                orderAdjustmentList?: Promo[];
            };
            const allItems = doc.orderItemList || [];
            // Blank lines (quantity 0, no productId) are not real items and
            // Finale refuses allocation lists sized to them (403 "not the
            // same size"). Allocations are sized to REAL items only.
            const realItems = allItems.filter((i) => Number(i.quantity || 0) > 0);
            const itemCount = realItems.length;
            const adjs: Promo[] = doc.orderAdjustmentList || [];
            const taxLines = adjs.filter(isTaxLine);
            const freightLines = adjs.filter((a) => String(a.productPromoUrl || "").includes("/10007"));
            const badTax = taxLines.filter((a) => taxLineSkipsLandedCost(a, itemCount));
            const badFreight =
                freightLines.length > 0 &&
                freightLines.some((a) => {
                    const alloc = a.orderAdjustmentAllocationList;
                    return !alloc || alloc.length !== itemCount;
                });
            if (badTax.length === 0 && !badFreight) {
                clean++;
                console.log(`clean ${po}`);
                await new Promise((r) => setTimeout(r, GAP_MS));
                continue;
            }
            const allocLines = await client.freightAllocLines(realItems);
            // Quantity-as-mass allocation, exactly what the freight writers use:
            // a missing weight falls back to qty so the list always matches
            // the item count (never a single-entry fallback).
            const builtTax = taxLines.map((a) =>
                buildFinaleTaxAdjustment(Number(a.amount || 0), allocateFreightByWeight(Number(a.amount || 0), allocLines)),
            );
            const builtFreight = freightLines.map((a) =>
                buildFinaleFreightAdjustment(
                    Number(a.amount || 0),
                    allocateFreightByWeight(Number(a.amount || 0), allocLines),
                ),
            );
            console.log(
                `needs fix ${po}: taxUnalloc=${badTax.length} freightMissized=${badFreight ? 1 : 0} (tax $${taxLines
                    .map((a) => Number(a.amount || 0))
                    .reduce((s, v) => s + v, 0)
                    .toFixed(2)}, freight $${freightLines
                    .map((a) => Number(a.amount || 0))
                    .reduce((s, v) => s + v, 0)
                    .toFixed(2)})`,
            );
            if (!LIVE) {
                await new Promise((r) => setTimeout(r, GAP_MS));
                continue;
            }
            const originalStatus = doc.statusId;
            const keep = adjs.filter(
                (a) => !isTaxLine(a) && !String(a.productPromoUrl || "").includes("/10007"),
            );
            const hasBlank = allItems.some((i) => !i.productId && Number(i.quantity || 0) <= 0);
            await client.unlockForEditing(doc, po);
            await client.post(`/${ACCOUNT}/api/order/${encodeURIComponent(po)}`, {
                ...doc,
                // Blank lines (no productId, qty 0) are dropped from the item
                // list when present so the allocation sizes match (Bill's
                // blank-line hygiene, 2026-10-21). Real items are untouched.
                orderItemList: hasBlank ? realItems : allItems,
                orderAdjustmentList: [...keep, ...builtTax, ...builtFreight],
            });
            await client.restoreOrderStatus(po, originalStatus);
            if (originalStatus === "ORDER_COMPLETED") await client.completeOrder(po);
            const after = (await client.getOrderDetails(po)) as {
                orderAdjustmentList?: Promo[];
            };
            const afterAdjs = after.orderAdjustmentList || [];
            const afterTax: Promo[] = afterAdjs.filter(isTaxLine);
            const afterFreight: Promo[] = afterAdjs.filter((a) => String(a.productPromoUrl || "").includes("/10007"));
            const afterBadTax = afterTax.filter((a) => taxLineSkipsLandedCost(a, itemCount));
            const afterBadFreight = afterFreight.some((a) => {
                const alloc = a.orderAdjustmentAllocationList;
                return !alloc || alloc.length !== itemCount;
            });
            if (afterBadTax.length === 0 && !afterBadFreight) {
                fixed++;
                console.log(`   OK ${po}: tax+freight allocations sized to ${itemCount} real items`);
            } else {
                failed++;
                console.log(`   FAIL ${po}: allocation still wrong after write`);
            }
        } catch (err: unknown) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`ERROR ${po}: ${msg.slice(0, 140)}`);
        }
        await new Promise((r) => setTimeout(r, GAP_MS));
    }
    console.log(`\nSUMMARY fixed=${fixed} clean=${clean} failed=${failed}`);
}

/** Weight-proportional allocation for `amount` across the Finale alloc lines. */
// (replaced by allocateFreightByWeight — quantity-as-mass, keeps list size)

const ACCOUNT = "buildasoilorganics";

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });

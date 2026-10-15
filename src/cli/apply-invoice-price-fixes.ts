/**
 * @file    src/cli/apply-invoice-price-fixes.ts
 * @purpose Put the invoice's unit price on a PO line, and on Supplier 1 so the
 *          next PO copies it. Quantity is never touched: a quantity difference is a
 *          pack-versus-each question, not a price fix.
 *
 *          The Supplier 1 write goes through the repo's own gates:
 *          `decideSupplierPriceWrite` (2% / clean-multiple / own price span) plus a
 *          unit-mismatch block for integer-factor swings.
 *
 * Usage:
 *   tsx src/cli/apply-invoice-price-fixes.ts 125166:S-11674:46.00 124828:S-4796:1.99
 *   tsx src/cli/apply-invoice-price-fixes.ts ... --live
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client, purchasing/invoice-line-pair, db
 * @env     FINALE_API_KEY, FINALE_API_SECRET
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import { decideSupplierPriceWrite } from "../lib/purchasing/invoice-line-pair";
import { createClient } from "../lib/db";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const GAP_MS = Number(process.env.PRICE_FIX_GAP_MS || 1500);

interface Spec {
    po: string;
    sku: string;
    price: number;
}
const specs: Spec[] = args
    .filter((a) => /^\d{6}:[^:]+:\d+(\.\d+)?$/.test(a))
    .map((a) => {
        const [po, sku, price] = a.split(":");
        return { po, sku, price: Number(price) };
    });

/** Prior unit prices for a SKU from the local PO mirror (best effort). */
async function priorPrices(sku: string): Promise<number[]> {
    const sb = createClient();
    if (!sb) return [];
    try {
        const { data } = await sb.from("purchase_orders").select("line_items").limit(800);
        const out: number[] = [];
        for (const row of (data ?? []) as Array<{ line_items?: Array<{ productId?: string; unitPrice?: number }> }>) {
            for (const li of row.line_items ?? []) {
                if (li.productId === sku && Number(li.unitPrice) > 0) out.push(Number(li.unitPrice));
            }
        }
        return out;
    } catch {
        return [];
    }
}

/** A clean integer-factor swing is a case-versus-each miss, not a price move. */
function isUnitMismatch(candidate: number, existing: number | null | undefined): boolean {
    if (!existing || existing <= 0 || candidate <= 0) return false;
    const r = Math.max(candidate, existing) / Math.min(candidate, existing);
    if (r <= 2.5) return false;
    const nearest = Math.round(r);
    return nearest >= 2 && Math.abs(r - nearest) / nearest < 0.12;
}

async function main(): Promise<void> {
    if (!specs.length) {
        console.error("usage: apply-invoice-price-fixes.ts PO:SKU:PRICE [...] [--live]");
        process.exit(1);
    }
    console.log(`Mode: ${LIVE ? "LIVE" : "DRY RUN"}  (${specs.length} spec(s))\n`);
    const client: any = new FinaleClient();

    for (const spec of specs) {
        const doc: any = await client.getOrderDetails(spec.po);
        const line = (doc.orderItemList || []).find(
            (i: any) => String(i.productId) === spec.sku,
        );
        if (!line) {
            console.log(`${spec.po} ${spec.sku}: line not found — skipped`);
            continue;
        }
        const before = Number(line.unitPrice) || 0;
        const qty = Number(line.quantity) || 0;
        const src = await client.getProductSupplierInfo(spec.sku).catch(() => null);
        const supplierPrice = src?.price ?? null;
        const delta = spec.price * qty - before * qty;
        console.log(
            `${spec.po} ${spec.sku.padEnd(12)} qty=${String(qty).padStart(7)} $${before.toFixed(4)} -> $${spec.price.toFixed(4)}` +
                `  goods ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}  supplier1=$${supplierPrice ?? "?"}`,
        );
        if (!LIVE) continue;

        const res = await client.updateOrderItemPrice(spec.po, spec.sku, spec.price);
        console.log(`      PO line: $${res.oldPrice} -> $${res.newPrice} (${res.updated ? "updated" : "no change"})`);

        const resolvedUrl = res.supplierPartyUrl ?? src?.supplierPartyUrl ?? null;
        if (!resolvedUrl) {
            console.log("      Supplier 1: no supplier link — skipped");
        } else if (isUnitMismatch(spec.price, supplierPrice)) {
            console.log(`      Supplier 1: BLOCKED, integer-factor swing vs $${supplierPrice} (unit mismatch)`);
        } else {
            const decision = decideSupplierPriceWrite({
                currentSupplierPrice: supplierPrice ?? 0,
                invoicePrice: spec.price,
                priorPrices: await priorPrices(spec.sku),
            });
            if (!decision.write) {
                console.log(`      Supplier 1: held (${decision.reason})`);
            } else {
                const ok = await client.updateProductSupplierPrice(spec.sku, resolvedUrl, spec.price);
                console.log(`      Supplier 1: ${ok ? "updated" : "skipped"} -> $${spec.price} (${decision.reason})`);
            }
        }

        await new Promise((r) => setTimeout(r, GAP_MS));
        const after: any = await client.getOrderDetails(spec.po);
        const line2 = (after.orderItemList || []).find((i: any) => String(i.productId) === spec.sku);
        const goods = (after.orderItemList || []).reduce(
            (s: number, i: any) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0),
            0,
        );
        console.log(
            `      verified: qty=${line2?.quantity} unit=$${Number(line2?.unitPrice).toFixed(4)} PO goods=$${goods.toFixed(2)}`,
        );
        await new Promise((r) => setTimeout(r, GAP_MS));
    }
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

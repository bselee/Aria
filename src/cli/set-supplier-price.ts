/**
 * @file    src/cli/set-supplier-price.ts
 * @purpose Correct a Finale SKU's Supplier 1 price when master data is the thing that
 *          is wrong, so the next purchase order copies the right number.
 *
 *          Every write runs through the repo's own gate, `decideSupplierPriceWrite`,
 *          which holds anything that looks like a case-versus-each miss. That gate is
 *          exactly right for an invoice-driven write, but a supplier record that
 *          already holds a pack price is the case it cannot distinguish, so a
 *          deliberate unit correction must pass `--force "<reason>"`. The reason is
 *          printed with the gate's verdict and the before/after values are re-read.
 *
 * Usage:
 *   tsx src/cli/set-supplier-price.ts S-3906:0.291667 S-7502:69.00
 *   tsx src/cli/set-supplier-price.ts S-3906:0.291667 --live --force "supplier1 held the 600-count pail price; our unit is the each"
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    finale/client, purchasing/invoice-line-pair, db
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pathToFileURL } from "url";
import { FinaleClient } from "../lib/finale/client";
import { decideSupplierPriceWrite } from "../lib/purchasing/invoice-line-pair";
import { createClient } from "../lib/db";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const forceIdx = args.indexOf("--force");
const FORCE_REASON = forceIdx >= 0 ? args[forceIdx + 1] : null;
const GAP_MS = Number(process.env.SUPPLIER_PRICE_GAP_MS || 1500);

interface Spec {
    sku: string;
    price: number;
}

const specs: Spec[] = args
    .filter((a) => /^[^:]+:\d+(\.\d+)?$/.test(a))
    .map((a) => {
        const i = a.lastIndexOf(":");
        return { sku: a.slice(0, i), price: Number(a.slice(i + 1)) };
    });

/** Prior unit prices for a SKU from the local PO mirror. */
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

/**
 * Resolve the product path segment Finale's REST API answers on.
 *
 * Most SKUs are their own path segment, but a few products carry a legacy numeric id
 * (S-7502 lives at /api/product/10112) and 404 when addressed by SKU. Fall back to
 * GraphQL, which returns the canonical productUrl.
 *
 * @param client Finale client
 * @param sku    SKU or numeric product id as supplied on the command line
 * @returns Path segment usable in /api/product/<segment>
 */
async function resolveProductSegment(client: any, sku: string): Promise<string | null> {
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";
    try {
        await client.get(`/${accountPath}/api/product/${encodeURIComponent(sku)}`);
        return sku;
    } catch {
        // fall through to GraphQL
    }
    const base = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const auth = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString("base64")}`;
    const res = await fetch(`${base}/${accountPath}/api/graphql`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
            query: `{ productViewConnection(first: 5, productId: ${JSON.stringify([sku])}) { edges { node { productId productUrl } } } }`,
        }),
    });
    const json: any = await res.json();
    const node = json?.data?.productViewConnection?.edges?.[0]?.node;
    if (!node?.productUrl) return null;
    const segment = String(node.productUrl).split("/").filter(Boolean).pop() || null;
    if (segment && segment !== sku) console.log(`      resolved ${sku} -> product path /api/product/${segment} (productId ${node.productId})`);
    return segment;
}

async function main(): Promise<void> {
    if (!specs.length) {
        console.error('usage: set-supplier-price.ts SKU:PRICE [...] [--live] [--force "<reason>"]');
        process.exit(2);
    }
    console.log(`Mode: ${LIVE ? "LIVE" : "DRY RUN"}${FORCE_REASON ? `  (forced: ${FORCE_REASON})` : ""}\n`);
    const client: any = new FinaleClient();

    for (const spec of specs) {
        const segment = await resolveProductSegment(client, spec.sku);
        if (!segment) {
            console.log(`${spec.sku}: product not found — skipped`);
            continue;
        }
        const info = await client.getProductSupplierInfo(segment).catch(() => null);
        if (!info) {
            console.log(`${spec.sku}: no Supplier 1 link on the product — skipped`);
            continue;
        }
        const priors = await priorPrices(spec.sku);
        const decision = decideSupplierPriceWrite({
            currentSupplierPrice: Number(info.price) || 0,
            invoicePrice: spec.price,
            priorPrices: priors,
        });
        console.log(
            `${spec.sku.padEnd(9)} supplier1 $${Number(info.price).toFixed(4)} -> $${spec.price.toFixed(4)}` +
                `   gate: ${decision.write ? "write" : "HOLD"} (${decision.reason})`,
        );
        if (!decision.write && !FORCE_REASON) {
            console.log("      not written. pass --force \"<reason>\" if this is a deliberate unit correction.");
            continue;
        }
        if (!decision.write && FORCE_REASON) {
            console.log(`      gate held; forcing: ${FORCE_REASON}`);
        }
        if (!LIVE) continue;
        if (decision.write && spec.price === 0) {
            console.log("      refused: zero price");
            continue;
        }
        const ok = await client.updateProductSupplierPrice(segment, info.supplierPartyUrl, spec.price);
        await new Promise((r) => setTimeout(r, GAP_MS));
        const after = await client.getProductSupplierInfo(segment).catch(() => null);
        console.log(`      write=${ok ? "ok" : "skipped"}  verified supplier1=$${Number(after?.price ?? NaN).toFixed(4)}`);
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

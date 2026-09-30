/**
 * @file    src/cli/scan-stock-ledger.ts
 * @purpose Pull the full Finale stock-movement ledger for a rolling window and
 *          aggregate NET consumption per product. This is the determination
 *          source that does NOT depend on Finale's per-product reorder
 *          configuration (reorderQuantityToOrder) or its product-level velocity
 *          fields, both of which read zero on job supplies and unconfigured SKUs
 *          while the ledger shows real burn.
 *
 *          One paged query over the whole ledger (not one call per SKU) to
 *          respect Finale's rate limits.
 *
 *          Read-only. No writes to Finale.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    dotenv
 * @env     .env.local (FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL)
 *          LEDGER_DAYS (optional, default 90)
 */
import * as dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
dotenv.config({ path: ".env.local" });

const apiBase = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
const auth = Buffer.from(
    `${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`,
).toString("base64");
const DAYS = process.env.LEDGER_DAYS ? Number(process.env.LEDGER_DAYS) : 90;
const PAGE = 500;

// Movement that represents consumption or leaving the building.
// Transfer is internal (moves between facilities) so it never counts.
const CONSUME = new Set(["Build", "Stock change or take", "Sale shipment", "Return shipment"]);

/** GraphQL payload shape varies by endpoint; only fields we read are typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GqlJson = Record<string, any>;

function num(v: unknown): number {
    if (v === null || v === undefined || v === "" || v === "--") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function skuFromProductUrl(u: unknown): string {
    const s = String(u ?? "");
    const m = s.match(/\/api\/product\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    // product { productId } shape
    return s && !s.includes("/") ? s : "";
}

async function gql(query: string): Promise<GqlJson> {
    const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(90_000),
    });
    return res.json();
}

interface Agg { sku: string; net: number; gross: number; rows: number; types: Record<string, number>; last: string }

async function main() {
    const now = new Date();
    const begin = new Date(now);
    begin.setDate(begin.getDate() - DAYS);
    const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const endStr = new Date(now.getTime() + 86_400_000).toLocaleDateString("en-CA", {
        timeZone: "America/Denver",
    });

    const agg = new Map<string, Agg>();
    let cursor: string | null = null;
    let pages = 0;
    let scanned = 0;

    for (;;) {
        const after = cursor ? `, after: "${cursor}"` : "";
        const q = `{ stockHistoryViewConnection(first: ${PAGE}${after}
            recordDate: { begin: "${beginStr}", end: "${endStr}" }) {
            pageInfo { hasNextPage endCursor }
            edges { node { transactionType recordDate unitsIn unitsOut quantity product { productId } } }
        } }`;
        const j = await gql(q);
        if (j?.errors?.length) {
            console.error("GraphQL error:", j.errors[0].message);
            break;
        }
        const conn = j?.data?.stockHistoryViewConnection;
        if (!conn) { console.error("no connection in response"); break; }

        for (const e of conn.edges || []) {
            const n = e.node || {};
            scanned++;
            const sku = skuFromProductUrl(n.product?.productId ?? n.product);
            if (!sku) continue;
            let a = agg.get(sku);
            if (!a) { a = { sku, net: 0, gross: 0, rows: 0, types: {}, last: "" }; agg.set(sku, a); }
            const t = String(n.transactionType || "?");
            const out = Math.abs(num(n.unitsOut));
            const inn = num(n.unitsIn);
            a.rows++;
            a.types[t] = (a.types[t] || 0) + 1;
            if (CONSUME.has(t)) {
                a.gross += out;
                a.net += (out - inn);
                if (n.recordDate && n.recordDate > a.last) a.last = n.recordDate;
            }
        }
        pages++;
        if (pctDone(pages)) process.stderr.write(`  page ${pages} scanned=${scanned} skus=${agg.size}\n`);
        if (!conn.pageInfo?.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
        await new Promise(r => setTimeout(r, 250)); // gentle on Finale
    }

    const out = [...agg.values()]
        .filter(a => a.net > 0)
        .map(a => ({ ...a, dailyRate: a.net / DAYS }))
        .sort((x, y) => y.net - x.net);

    mkdirSync("data", { recursive: true });
    writeFileSync("data/stock-ledger-scan.json", JSON.stringify({
        generatedAt: new Date().toISOString(), days: DAYS, pages, scannedRows: scanned,
        skusWithBurn: out.length, rows: out,
    }, null, 2));

    console.log(`\nledger window ${beginStr} .. ${endStr} (${DAYS}d)`);
    console.log(`pages=${pages} ledgerRows=${scanned} | SKUs with net consumption > 0: ${out.length}`);
    console.log("\ntop 30 by net consumption:");
    for (const a of out.slice(0, 30)) {
        console.log(`  ${a.sku.padEnd(18)} net=${String(Math.round(a.net)).padStart(9)}  ${a.dailyRate.toFixed(3)}/d  last=${a.last.slice(0, 10)}`);
    }
    console.log("\nwrote data/stock-ledger-scan.json");
}

function pctDone(pages: number) { return pages % 5 === 0; }

main().catch(e => { console.error(e); process.exit(1); });

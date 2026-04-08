/**
 * uline-top-skus.ts — One-shot: highest-purchased ULINE SKUs over the last 365 days.
 *
 * Pages PURCHASE_ORDERs with orderDate in the past year, filters to ULINE supplier,
 * sums quantities per SKU across received/completed POs.
 *
 * Usage: node --import tsx src/cli/uline-top-skus.ts [--days 365] [--all-status]
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH || '';
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY || ''}:${process.env.FINALE_API_SECRET || ''}`).toString('base64')}`;

function parseNum(v: any): number {
    if (v == null) return 0;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
}

async function main() {
    const args = process.argv.slice(2);
    const daysIdx = args.indexOf('--days');
    const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 365;
    const allStatus = args.includes('--all-status');

    const end = new Date();
    const begin = new Date();
    begin.setDate(begin.getDate() - days);
    const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

    console.log(`\n  Querying ULINE POs from ${beginStr} → ${endStr} (${days}d)\n`);

    const PAGE_SIZE = 200;
    const MAX_PAGES = 30;
    let cursor: string | null = null;
    const allEdges: any[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
        const after = cursor ? `, after: "${cursor}"` : '';
        const query = {
            query: `{
                orderViewConnection(
                    first: ${PAGE_SIZE}
                    type: ["PURCHASE_ORDER"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]${after}
                ) {
                    pageInfo { hasNextPage endCursor }
                    edges { node {
                        orderId orderDate status
                        supplier { name }
                        itemList(first: 100) {
                            edges { node { product { productId } quantity } }
                        }
                    }}
                }
            }`
        };

        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        });
        if (!res.ok) {
            console.error(`Page ${page}: HTTP ${res.status}`);
            break;
        }
        const json = await res.json();
        if (json.errors) {
            console.error(`Page ${page}: ${json.errors[0].message}`);
            break;
        }
        const conn = json.data?.orderViewConnection;
        if (!conn) break;
        allEdges.push(...(conn.edges || []));
        process.stdout.write(`  page ${page + 1}: +${conn.edges?.length || 0} (total ${allEdges.length})\r`);
        if (!conn.pageInfo?.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
        if (!cursor) break;
    }
    console.log('');

    // Filter to ULINE
    const ulineEdges = allEdges.filter(e => /uline/i.test(e?.node?.supplier?.name || ''));
    console.log(`  ${ulineEdges.length} ULINE POs / ${allEdges.length} total POs in window\n`);

    // Aggregate qty by SKU (skip ORDER_ABANDONED / cancelled / draft unless --all-status)
    const includedStatuses = allStatus
        ? null
        : new Set(['Completed', 'Committed', 'Partial', 'Received']);

    const totals = new Map<string, number>();
    let countedPOs = 0;
    for (const e of ulineEdges) {
        const status = e?.node?.status;
        if (includedStatuses && !includedStatuses.has(status)) continue;
        countedPOs++;
        for (const ie of e?.node?.itemList?.edges || []) {
            const sku = ie?.node?.product?.productId;
            if (!sku) continue;
            const qty = parseNum(ie?.node?.quantity);
            if (qty <= 0) continue;
            totals.set(sku, (totals.get(sku) || 0) + qty);
        }
    }

    console.log(`  Counted ${countedPOs} ULINE POs (statuses: ${allStatus ? 'all' : 'Completed/Committed/Partial/Received'})`);
    console.log(`  ${totals.size} unique SKUs aggregated\n`);

    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);

    // Enrich top 80 with product names via REST so we can filter to boxes
    const topToEnrich = sorted.slice(0, 80);
    console.log(`  Looking up product names for top ${topToEnrich.length} SKUs...\n`);

    const enriched: Array<{ sku: string; qty: number; name: string }> = [];
    for (const [sku, qty] of topToEnrich) {
        try {
            const r = await fetch(`${apiBase}/${accountPath}/api/product/${encodeURIComponent(sku)}`, {
                headers: { Authorization: authHeader, Accept: 'application/json' },
            });
            let name = '';
            if (r.ok) {
                const j: any = await r.json();
                name = j?.internalName || j?.description || '';
            }
            enriched.push({ sku, qty, name });
        } catch {
            enriched.push({ sku, qty, name: '' });
        }
        await new Promise(res => setTimeout(res, 80));
    }

    const BOX_RE = /\bbox(es)?\b|carton|mailer|corrugated/i;
    const NON_BOX_RE = /tape|label|\bbag\b|wrap|peanut|cushion|stretch|strap|knife|dispenser|marker|sharpie|glove|bubble|foam|edge|corner|fill|void|paper|liner|sheet|pallet|skid|ream|\btag\b|tie\b|twist|zip|stencil|pen\b/i;

    const boxes = enriched.filter(e => BOX_RE.test(e.name) && !NON_BOX_RE.test(e.name));
    const nonBoxes = enriched.filter(e => !(BOX_RE.test(e.name) && !NON_BOX_RE.test(e.name)));

    console.log(`  Top ULINE BOXES by quantity purchased (last ${days}d):`);
    console.log('  ' + '─'.repeat(95));
    console.log(`  ${'SKU'.padEnd(14)} ${'Qty'.padStart(8)}   Description`);
    console.log('  ' + '─'.repeat(95));
    for (const e of boxes.slice(0, 40)) {
        console.log(`  ${e.sku.padEnd(14)} ${Math.round(e.qty).toString().padStart(8)}   ${e.name.slice(0, 70)}`);
    }
    console.log('');
    console.log(`  (${nonBoxes.length} non-box SKUs filtered out)`);
    console.log('');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

/**
 * Probe: getPurchasingIntelligence output format
 * Runs the full pipeline but caps at the first 20 candidates for speed.
 * Usage: node --import tsx src/cli/probe-purchasing.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';

async function run() {
    const client = new FinaleClient();

    const CAP = 20; // max candidates to actually process (keeps probe fast)
    console.log(`Scanning active products with consumption > 0 (cap: ${CAP} qualifying)...\n`);

    const PAGE_SIZE = 500;
    const apiKey = process.env.FINALE_API_KEY || '';
    const apiSecret = process.env.FINALE_API_SECRET || '';
    const account = process.env.FINALE_ACCOUNT_PATH || '';
    const base = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
    const auth = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

    // Scan up to 10 pages to find qualifying items (alphabetical ordering means
    // early pages are dominated by internal "AC*" SKUs)
    const candidates: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    while (candidates.length < CAP && pages < 10) {
        const afterClause: string = cursor ? `, after: "${cursor}"` : '';
        const res: Response = await fetch(`${base}/${account}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `{
                    productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                        pageInfo { hasNextPage endCursor }
                        edges { node { productId status consumptionQuantity reorderQuantityToOrder } }
                    }
                }`
            }),
        });
        const json: any = await res.json();
        const conn: any = json.data?.productViewConnection;
        if (!conn) break;
        pages++;

        for (const edge of conn.edges || []) {
            const p = edge.node;
            if (p.status !== 'Active') continue;
            const parseNum = (v: any) => { if (!v || v === '--') return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
            const consumption = parseNum(p.consumptionQuantity);
            const reorderQty = parseNum(p.reorderQuantityToOrder);
            if ((consumption !== null && consumption > 0) || (reorderQty !== null && reorderQty > 0)) {
                candidates.push(p.productId);
            }
            if (candidates.length >= CAP) break;
        }

        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }

    console.log(`Found ${candidates.length} candidates across ${pages} page(s). Processing...\n`);
    console.log('SKUs:', candidates.join(', '), '\n');

    // Process each candidate individually using existing public methods
    for (const sku of candidates) {
        try {
            const [prodData, purchaseData, salesData, openPOs] = await Promise.all([
                // Raw REST
                fetch(`${base}/${account}/api/product/${encodeURIComponent(sku)}`, {
                    headers: { Authorization: auth, Accept: 'application/json' }
                }).then(r => r.json()),
                client.getPurchasedQty(sku, 90),
                client.getSalesQty(sku, 90),
                client.findCommittedPOsForProduct(sku),
            ]);

            const suppliers: any[] = prodData.supplierList || [];
            const mainSupplier = suppliers.find((s: any) => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
            if (!mainSupplier?.supplierPartyUrl) {
                console.log(`  ${sku} — no supplier, skip`);
                continue;
            }

            // Resolve party name
            const partyId = mainSupplier.supplierPartyUrl.split('/').pop();
            const partyRes = await fetch(`${base}/${account}/api/partygroup/${partyId}`, {
                headers: { Authorization: auth, Accept: 'application/json' }
            });
            const partyData = await partyRes.json();
            const supplierName = partyData.groupName || 'Unknown';

            // Skip manufactured
            if (/buildasoil|manufacturing|soil dept|bas soil/i.test(supplierName)) {
                console.log(`  ${sku} — manufactured (${supplierName}), skip`);
                continue;
            }

            const stockOnHand = parseFloat(String(prodData.quantityOnHand ?? prodData.stockLevel ?? 0).replace(/,/g, '')) || 0;
            const stockOnOrder = openPOs.reduce((s, po) => s + po.quantityOnOrder, 0);
            const purchaseVelocity = purchaseData.totalQty / 90;
            const salesVelocity = salesData.totalSoldQty / 90;
            const dailyRate = Math.max(purchaseVelocity, salesVelocity);

            if (dailyRate === 0) {
                console.log(`  ${sku} — zero velocity, skip`);
                continue;
            }

            const rawLead = prodData.leadTime != null ? parseInt(String(prodData.leadTime), 10) : NaN;
            const leadTimeDays = !isNaN(rawLead) && rawLead > 0 ? rawLead : 14;
            const runwayDays = stockOnHand / dailyRate;
            const adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyRate;

            const urgency = runwayDays < leadTimeDays ? 'CRITICAL'
                : runwayDays < leadTimeDays + 30 ? 'WARNING'
                    : runwayDays < leadTimeDays + 60 ? 'WATCH'
                        : 'OK';

            const rateSource = purchaseVelocity >= salesVelocity ? 'receipts' : 'shipments';
            const suggestedQty = Math.max(50, Math.ceil(dailyRate * (leadTimeDays + 60) / 50) * 50);

            console.log(`\n── ${sku} (${prodData.internalName || sku})`);
            console.log(`   Vendor      : ${supplierName}`);
            console.log(`   Stock REST  : ${stockOnHand}`);
            console.log(`   On Order    : ${stockOnOrder} (${openPOs.length} POs)`);
            console.log(`   Purchase 90d: ${purchaseData.totalQty} total  → ${purchaseVelocity.toFixed(2)}/day`);
            console.log(`   Sales 90d   : ${salesData.totalSoldQty} total  → ${salesVelocity.toFixed(2)}/day`);
            console.log(`   Daily rate  : ${dailyRate.toFixed(2)}/day (${rateSource})`);
            console.log(`   Runway      : ${runwayDays.toFixed(1)}d raw  /  ${adjustedRunwayDays.toFixed(1)}d adjusted`);
            console.log(`   Lead time   : ${leadTimeDays}d`);
            console.log(`   Urgency     : ${urgency}`);
            console.log(`   Suggest qty : ${suggestedQty}`);
        } catch (err: any) {
            console.log(`  ${sku} — error: ${err.message}`);
        }
    }

    console.log('\nDone.');
}

run().catch(console.error);

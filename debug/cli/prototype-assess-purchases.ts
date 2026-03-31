/**
 * assess-purchases.ts — Cross-reference scraped purchasing suggestions against Finale inventory.
 *
 * Reads purchases-data.json (scraped from basauto.vercel.app/purchases), queries Finale for
 * each SKU's stock, sales velocity, open POs, and lead time, then ranks items by genuine need.
 *
 * Usage:
 *   node --import tsx src/cli/assess-purchases.ts
 *   node --import tsx src/cli/assess-purchases.ts --json          # Machine-readable output
 *   node --import tsx src/cli/assess-purchases.ts --vendor ULINE  # Filter to one vendor
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as fs from 'fs';
import * as path from 'path';
import { FinaleClient } from '../lib/finale/client';

// ── Types ──

interface ScrapedItem {
    sku: string;
    description: string;
    urgency: string;
    [key: string]: string; // remaining fields all empty strings
}

type ScrapedData = Record<string, ScrapedItem[]>;

type NecessityLevel = 'HIGH_NEED' | 'MEDIUM' | 'LOW' | 'NOISE';

interface AssessedItem {
    sku: string;
    description: string;
    scrapedUrgency: string;         // what the dashboard claimed
    necessity: NecessityLevel;       // our computed verdict
    stockOnHand: number;
    stockOnOrder: number;            // committed POs
    salesVelocity: number;           // units/day (90d)
    purchaseVelocity: number;        // units/day (90d)
    dailyRate: number;               // best signal
    runwayDays: number;              // stock / dailyRate
    adjustedRunwayDays: number;      // (stock + onOrder) / dailyRate
    leadTimeDays: number;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    explanation: string;
    finaleFound: boolean;            // false if SKU not in Finale at all
    doNotReorder: boolean;
}

interface VendorAssessment {
    vendor: string;
    items: AssessedItem[];
    highNeedCount: number;
    mediumCount: number;
    noiseCount: number;
}

// ── Finale GraphQL: combined stock + activity query (mirrors getProductActivity) ──

async function getSkuActivity(
    client: FinaleClient,
    sku: string,
    accountPath: string,
    apiBase: string,
    authHeader: string,
    daysBack: number,
): Promise<{
    purchasedQty: number;
    soldQty: number;
    openPOs: Array<{ orderId: string; quantityOnOrder: number; orderDate: string }>;
    stockOnHand: number;
}> {
    const end = new Date();
    const begin = new Date();
    begin.setDate(begin.getDate() - daysBack);
    const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const productUrl = `/${accountPath}/api/product/${sku}`;

    const query = {
        query: `{
            purchasedIn: orderViewConnection(
                first: 100
                type: ["PURCHASE_ORDER"]
                product: ["${productUrl}"]
                orderDate: { begin: "${beginStr}", end: "${endStr}" }
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    status
                    itemList(first: 20) {
                        edges { node { product { productId } quantity } }
                    }
                }}
            }
            soldIn: orderViewConnection(
                first: 50
                type: ["SALES_ORDER"]
                product: ["${productUrl}"]
                orderDate: { begin: "${beginStr}", end: "${endStr}" }
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    status
                    itemList(first: 20) {
                        edges { node { product { productId } quantity } }
                    }
                }}
            }
            committedPOs: orderViewConnection(
                first: 20
                type: ["PURCHASE_ORDER"]
                product: ["${productUrl}"]
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId status orderDate
                    itemList(first: 20) {
                        edges { node { product { productId } quantity } }
                    }
                }}
            }
            stockInfo: productViewConnection(first: 1, productId: "${sku}") {
                edges { node {
                    stockOnHand
                    stockAvailable
                    unitsInStock
                }}
            }
        }`
    };

    let res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
    });

    // 429 rate-limit backoff: wait 5s and retry once
    if (res.status === 429) {
        console.warn(`  [rate limited] ${sku} — backing off 5s`);
        await new Promise(r => setTimeout(r, 5000));
        res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(query),
        });
    }

    if (!res.ok) return { purchasedQty: 0, soldQty: 0, openPOs: [], stockOnHand: 0 };
    const result = await res.json();
    if (result.errors) return { purchasedQty: 0, soldQty: 0, openPOs: [], stockOnHand: 0 };

    // Parse purchased qty (completed POs only)
    let purchasedQty = 0;
    for (const edge of result.data?.purchasedIn?.edges || []) {
        if (edge.node.status !== 'Completed') continue;
        for (const ie of edge.node.itemList?.edges || []) {
            if (ie.node.product?.productId === sku) {
                purchasedQty += parseNum(ie.node.quantity);
                break;
            }
        }
    }

    // Parse sold qty (completed/shipped sales orders)
    let soldQty = 0;
    for (const edge of result.data?.soldIn?.edges || []) {
        const status = edge.node.status;
        if (status !== 'Completed' && status !== 'Shipped') continue;
        for (const ie of edge.node.itemList?.edges || []) {
            if (ie.node.product?.productId === sku) {
                soldQty += parseNum(ie.node.quantity);
                break;
            }
        }
    }

    // Parse committed POs (truly open/outstanding only)
    const openPOs: Array<{ orderId: string; quantityOnOrder: number; orderDate: string }> = [];
    for (const edge of result.data?.committedPOs?.edges || []) {
        if (edge.node.status !== 'Committed') continue;
        for (const ie of edge.node.itemList?.edges || []) {
            if (ie.node.product?.productId === sku) {
                openPOs.push({
                    orderId: edge.node.orderId,
                    quantityOnOrder: parseNum(ie.node.quantity),
                    orderDate: edge.node.orderDate || '',
                });
                break;
            }
        }
    }

    // Stock from GraphQL (more reliable than REST for these products)
    const stockNode = result.data?.stockInfo?.edges?.[0]?.node;
    const stockOnHand = parseNum(stockNode?.stockOnHand ?? stockNode?.unitsInStock ?? 0);

    return { purchasedQty, soldQty, openPOs, stockOnHand };
}

function parseNum(val: any): number {
    if (val == null) return 0;
    const cleaned = String(val).replace(/[^0-9.\-]/g, '');
    const n = parseFloat(cleaned);
    return isNaN(n) ? 0 : n;
}

// ── Necessity scoring ──

function computeNecessity(
    stockOnHand: number,
    stockOnOrder: number,
    dailyRate: number,
    leadTimeDays: number,
    finaleFound: boolean,
    doNotReorder: boolean,
): { necessity: NecessityLevel; explanation: string } {
    if (!finaleFound) {
        return { necessity: 'NOISE', explanation: 'SKU not found in Finale — may be discontinued or mistyped.' };
    }
    if (doNotReorder) {
        return { necessity: 'NOISE', explanation: 'Marked "Do Not Reorder" in Finale.' };
    }
    if (dailyRate === 0) {
        // No movement at all in 90 days
        if (stockOnHand <= 0) {
            return { necessity: 'LOW', explanation: 'Zero stock, but no sales/purchase activity in 90 days — likely dormant.' };
        }
        return { necessity: 'NOISE', explanation: `No sales or purchase activity in 90 days. ${Math.round(stockOnHand)} in stock sitting idle.` };
    }

    const adjustedRunway = (stockOnHand + stockOnOrder) / dailyRate;
    const rawRunway = stockOnHand / dailyRate;

    const parts: string[] = [];
    parts.push(`${dailyRate.toFixed(2)}/day velocity`);
    parts.push(`${Math.round(stockOnHand)} on hand`);
    if (stockOnOrder > 0) parts.push(`+${Math.round(stockOnOrder)} on order`);
    parts.push(`${Math.round(rawRunway)}d runway (${Math.round(adjustedRunway)}d adjusted)`);
    parts.push(`${leadTimeDays}d lead time`);

    if (adjustedRunway < leadTimeDays) {
        return {
            necessity: 'HIGH_NEED',
            explanation: parts.join(' · ') + ' — STOCKOUT RISK: runway shorter than lead time, order now.',
        };
    }
    if (adjustedRunway < leadTimeDays + 30) {
        return {
            necessity: 'MEDIUM',
            explanation: parts.join(' · ') + ' — approaching reorder point, order soon.',
        };
    }
    if (adjustedRunway < 60) {
        return {
            necessity: 'MEDIUM',
            explanation: parts.join(' · ') + ' — under 60 days coverage, keep an eye on it.',
        };
    }
    return {
        necessity: 'LOW',
        explanation: parts.join(' · ') + ' — adequately stocked.',
    };
}

// ── Main ──

async function main() {
    const args = process.argv.slice(2);
    const jsonOutput = args.includes('--json');
    const vendorFilterIdx = args.indexOf('--vendor');
    const vendorFilter = vendorFilterIdx >= 0 ? args[vendorFilterIdx + 1]?.toLowerCase() : null;

    // Load scraped data
    const dataPath = path.resolve(__dirname, '../../purchases-data.json');
    if (!fs.existsSync(dataPath)) {
        console.error(`purchases-data.json not found at ${dataPath}`);
        process.exit(1);
    }
    const scrapedData: ScrapedData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

    // Flatten into work queue
    const workQueue: Array<{ vendor: string; item: ScrapedItem }> = [];
    for (const [vendorKey, items] of Object.entries(scrapedData)) {
        // Vendor keys have trailing digits from scraper (e.g., "ULINE7") — strip them
        const vendor = vendorKey.replace(/\d+$/, '').trim();
        if (vendorFilter && !vendor.toLowerCase().includes(vendorFilter)) continue;
        for (const item of items) {
            workQueue.push({ vendor, item });
        }
    }

    console.log(`\n  Assessing ${workQueue.length} SKUs across ${new Set(workQueue.map(w => w.vendor)).size} vendors...\n`);

    // Initialize Finale client
    const client = new FinaleClient();
    await client.testConnection();

    // We need raw auth for GraphQL calls (getProductActivity is private on the class)
    const accountPath = process.env.FINALE_ACCOUNT_PATH || '';
    const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
    const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY || ''}:${process.env.FINALE_API_SECRET || ''}`).toString('base64')}`;

    const DAYS_BACK = 90;
    const results: Map<string, AssessedItem[]> = new Map();

    // 3 concurrent workers, 100ms inter-SKU throttle (matches getPurchasingIntelligence pattern)
    const queue = [...workQueue];
    const assessed: Array<{ vendor: string; assessed: AssessedItem }> = [];

    await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length > 0) {
            const work = queue.shift()!;
            const { vendor, item } = work;
            const sku = item.sku;

            try {
                // Step 1: REST product lookup — stock, lead time, supplier, do-not-reorder check
                let prodData: any = null;
                let finaleFound = false;
                let doNotReorder = false;
                let leadTimeDays = 14; // default

                try {
                    const res = await fetch(`${apiBase}/${accountPath}/api/product/${encodeURIComponent(sku)}`, {
                        headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
                    });
                    if (res.ok) {
                        prodData = await res.json();
                        finaleFound = true;
                        doNotReorder = FinaleClient.isDoNotReorder(prodData);
                        const rawLead = prodData.leadTime != null ? parseInt(String(prodData.leadTime), 10) : NaN;
                        if (!isNaN(rawLead) && rawLead > 0) leadTimeDays = rawLead;
                    }
                } catch {
                    // Product not found or API error — finaleFound stays false
                }

                // Step 2: GraphQL activity query (even if REST 404'd — GraphQL may still find stock/orders)
                const activity = await getSkuActivity(client, sku, accountPath, apiBase, authHeader, DAYS_BACK);

                // If REST failed but GraphQL found stock, mark as found
                if (!finaleFound && activity.stockOnHand > 0) finaleFound = true;

                const stockOnHand = finaleFound
                    ? (activity.stockOnHand || parseNum(prodData?.quantityOnHand ?? 0))
                    : 0;
                const stockOnOrder = activity.openPOs.reduce((sum, po) => sum + po.quantityOnOrder, 0);

                const purchaseVelocity = activity.purchasedQty / DAYS_BACK;
                const salesVelocity = activity.soldQty / DAYS_BACK;
                const dailyRate = Math.max(purchaseVelocity, salesVelocity);
                const runwayDays = dailyRate > 0 ? stockOnHand / dailyRate : Infinity;
                const adjustedRunwayDays = dailyRate > 0 ? (stockOnHand + stockOnOrder) / dailyRate : Infinity;

                const { necessity, explanation } = computeNecessity(
                    stockOnHand, stockOnOrder, dailyRate, leadTimeDays, finaleFound, doNotReorder,
                );

                const openPOs = activity.openPOs.map(po => ({
                    orderId: po.orderId,
                    quantity: po.quantityOnOrder,
                    orderDate: po.orderDate,
                }));

                const assessedItem: AssessedItem = {
                    sku,
                    description: item.description,
                    scrapedUrgency: item.urgency || '(none)',
                    necessity,
                    stockOnHand,
                    stockOnOrder,
                    salesVelocity,
                    purchaseVelocity,
                    dailyRate,
                    runwayDays: runwayDays === Infinity ? -1 : Math.round(runwayDays),
                    adjustedRunwayDays: adjustedRunwayDays === Infinity ? -1 : Math.round(adjustedRunwayDays),
                    leadTimeDays,
                    openPOs,
                    explanation,
                    finaleFound,
                    doNotReorder,
                };

                assessed.push({ vendor, assessed: assessedItem });

                const icon = necessity === 'HIGH_NEED' ? '🔴' : necessity === 'MEDIUM' ? '🟡' : necessity === 'LOW' ? '🟠' : '⚪';
                if (!jsonOutput) {
                    console.log(`  ${icon} ${sku.padEnd(12)} ${necessity.padEnd(10)} stock=${Math.round(stockOnHand)} vel=${dailyRate.toFixed(2)}/d runway=${runwayDays === -1 ? '∞' : Math.round(runwayDays as number) + 'd'}`);
                }
            } catch (err: any) {
                console.error(`  [error] ${sku}: ${err.message}`);
                assessed.push({
                    vendor,
                    assessed: {
                        sku,
                        description: item.description,
                        scrapedUrgency: item.urgency || '(none)',
                        necessity: 'NOISE',
                        stockOnHand: 0,
                        stockOnOrder: 0,
                        salesVelocity: 0,
                        purchaseVelocity: 0,
                        dailyRate: 0,
                        runwayDays: -1,
                        adjustedRunwayDays: -1,
                        leadTimeDays: 14,
                        openPOs: [],
                        explanation: `Error querying Finale: ${err.message}`,
                        finaleFound: false,
                        doNotReorder: false,
                    },
                });
            }

            // 100ms throttle between SKU dispatches
            await new Promise(r => setTimeout(r, 100));
        }
    }));

    // ── Group by vendor ──
    for (const { vendor, assessed: item } of assessed) {
        if (!results.has(vendor)) results.set(vendor, []);
        results.get(vendor)!.push(item);
    }

    // ── Sort: HIGH_NEED first within each vendor, vendors with most HIGH_NEED first ──
    const necessityRank: Record<NecessityLevel, number> = { HIGH_NEED: 0, MEDIUM: 1, LOW: 2, NOISE: 3 };
    const vendorAssessments: VendorAssessment[] = [];

    for (const [vendor, items] of results) {
        items.sort((a, b) => necessityRank[a.necessity] - necessityRank[b.necessity]);
        vendorAssessments.push({
            vendor,
            items,
            highNeedCount: items.filter(i => i.necessity === 'HIGH_NEED').length,
            mediumCount: items.filter(i => i.necessity === 'MEDIUM').length,
            noiseCount: items.filter(i => i.necessity === 'NOISE' || i.necessity === 'LOW').length,
        });
    }
    vendorAssessments.sort((a, b) => b.highNeedCount - a.highNeedCount || b.mediumCount - a.mediumCount);

    // ── Output ──
    if (jsonOutput) {
        console.log(JSON.stringify(vendorAssessments, null, 2));
        process.exit(0);
    }

    // Summary counts
    const allItems = vendorAssessments.flatMap(v => v.items);
    const highCount = allItems.filter(i => i.necessity === 'HIGH_NEED').length;
    const medCount = allItems.filter(i => i.necessity === 'MEDIUM').length;
    const lowCount = allItems.filter(i => i.necessity === 'LOW').length;
    const noiseCount = allItems.filter(i => i.necessity === 'NOISE').length;

    console.log('\n' + '═'.repeat(80));
    console.log(`  PURCHASE ASSESSMENT — ${allItems.length} SKUs from scraped dashboard`);
    console.log('═'.repeat(80));
    console.log(`  🔴 HIGH NEED: ${highCount}   🟡 MEDIUM: ${medCount}   🟠 LOW: ${lowCount}   ⚪ NOISE: ${noiseCount}`);
    console.log('─'.repeat(80));

    for (const va of vendorAssessments) {
        console.log(`\n  ┌─ ${va.vendor} (${va.highNeedCount} high, ${va.mediumCount} med, ${va.noiseCount} noise)`);
        console.log('  │');
        for (const item of va.items) {
            const icon = item.necessity === 'HIGH_NEED' ? '🔴' : item.necessity === 'MEDIUM' ? '🟡' : item.necessity === 'LOW' ? '🟠' : '⚪';
            console.log(`  │  ${icon} ${item.necessity.padEnd(10)} ${item.sku.padEnd(14)} ${item.description}`);
            console.log(`  │     ${item.explanation}`);
            if (item.openPOs.length > 0) {
                const poList = item.openPOs.map(po => `${po.orderId} (qty ${Math.round(po.quantity)})`).join(', ');
                console.log(`  │     Open POs: ${poList}`);
            }
            if (item.scrapedUrgency && item.scrapedUrgency !== '(none)') {
                console.log(`  │     Dashboard claimed: ${item.scrapedUrgency}`);
            }
        }
        console.log('  └─');
    }

    console.log('\n' + '═'.repeat(80));

    // Actionable summary: only HIGH_NEED items
    if (highCount > 0) {
        console.log('\n  ACTION ITEMS — Order these now:\n');
        for (const va of vendorAssessments) {
            const highItems = va.items.filter(i => i.necessity === 'HIGH_NEED');
            if (highItems.length === 0) continue;
            console.log(`    ${va.vendor}:`);
            for (const item of highItems) {
                const suggest = Math.max(1, Math.ceil(item.dailyRate * (item.leadTimeDays + 60)));
                console.log(`      ${item.sku.padEnd(14)} stock=${Math.round(item.stockOnHand)} runway=${item.adjustedRunwayDays}d → suggest ordering ~${suggest}`);
            }
        }
    }

    console.log('');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

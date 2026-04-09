/**
 * assessor.ts — Core purchasing assessment logic (shared between CLI and bot)
 */

import { FinaleClient } from '@/lib/finale/client';
import { createClient } from '@/lib/supabase';
import { FuzzyMatcher, KnownProduct } from '@/lib/scraping/fuzzy-matcher';
import * as fs from 'fs';
import * as path from 'path';

// ── Configuration ──
export const PRODUCT_CATALOG_LIMIT = 100;
export const FUZZY_THRESHOLD = 0.4;
export const FUZZY_MIN_MATCH = 3;
const DAYS_BACK_DEFAULT = 90;
const REQUEST_WORKERS = 2;

// ── Types ──
export interface ScrapedItem {
    sku: string;
    description: string;
    urgency: string;
    [key: string]: string;
}
export type ScrapedData = Record<string, ScrapedItem[]>;

export type ItemSource = 'VENDOR_SUGGESTION' | 'TEAM_REQUEST';

export interface PurchaseRequest {
    date: string;
    department: string;
    type: 'Existing product' | 'New product';
    details: string;
    quantity: string;
    link: string;
    status: string;
    ordered: string;
}

export interface RawRequestsData {
    scrapedAt: string;
    requests: PurchaseRequest[];
    rawDump?: string;
}

export type NecessityLevel = 'HIGH_NEED' | 'MEDIUM' | 'LOW' | 'NOISE';

export interface AssessedItem {
    vendor: string;                    // vendor name or department
    sku: string;
    description: string;
    source: ItemSource;
    rawDetails?: string;
    rawRequest?: PurchaseRequest;
    scrapedUrgency?: string;
    fuzzyMatchScore?: number;
    necessity: NecessityLevel;
    stockOnHand: number;
    stockOnOrder: number;
    salesVelocity: number;
    purchaseVelocity: number;
    dailyRate: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    leadTimeDays: number;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    explanation: string;
    finaleFound: boolean;
    doNotReorder: boolean;
}

export interface VendorAssessment {
    vendor: string;
    items: AssessedItem[];
    highNeedCount: number;
    mediumCount: number;
    noiseCount: number;
}

export interface AssessmentResult {
    vendorAssessments: VendorAssessment[];
    allAssessed: AssessedItem[];
}

export interface AssessmentOptions {
    scrapedData?: ScrapedData;
    requestsData?: RawRequestsData;
    vendorFilter?: string | null;
    jsonOutput?: boolean;
    daysBack?: number;
}

// ── Finale GraphQL ──
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

// ── Product catalog ──


export async function buildProductCatalog(): Promise<{ products: KnownProduct[] }> {
    const supabase = createClient();
    if (!supabase) {
        console.warn('⚠️ No Supabase connection — using empty catalog');
        return { products: [] };
    }

    try {
        const { data: pos } = await supabase
            .from('purchase_orders')
            .select('line_items, vendor_name, created_at')
            .order('created_at', { ascending: false })
            .limit(PRODUCT_CATALOG_LIMIT);

        const seen = new Set<string>();
        const products: KnownProduct[] = [];

        for (const po of (pos || [])) {
            for (const item of (po.line_items || [])) {
                const key = (item.sku || item.description || '').toLowerCase();
                if (key && !seen.has(key)) {
                    seen.add(key);
                    products.push({
                        name: item.description || item.name || key,
                        sku: item.sku || 'N/A',
                        vendor: po.vendor_name,
                        lastOrdered: po.created_at,
                    });
                }
            }
        }



        console.log(`📦 Product catalog loaded: ${products.length} unique items from PO history`);
        return { products };
    } catch (err: any) {
        console.warn('⚠️ Catalog build error:', err.message);
        return { products: [] };
    }
}



// ── Necessity scoring ──
export function computeNecessity(
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

// ── Unified assessment routine ──
export async function assessSku(
    sku: string,
    description: string,
    source: ItemSource,
    client: FinaleClient,
    apiBase: string,
    accountPath: string,
    authHeader: string,
    DAYS_BACK: number,
    scrapedUrgency?: string,
    rawRequest?: PurchaseRequest,
    vendorName?: string,
): Promise<AssessedItem> {
    let prodData: any = null;
    let finaleFound = false;
    let doNotReorder = false;
    let leadTimeDays = 14;

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
        // ignore
    }

    const activity = await getSkuActivity(client, sku, accountPath, apiBase, authHeader, DAYS_BACK);
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

    return {
        vendor: vendorName || (rawRequest?.department) || 'Unknown',
        sku,
        description,
        source,
        rawDetails: rawRequest?.details,
        rawRequest,
        scrapedUrgency,
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
}

// ── Main assessment orchestration ──
export async function assess(options: AssessmentOptions = {}): Promise<AssessmentResult> {
    const {
        scrapedData,
        requestsData,
        vendorFilter,
        jsonOutput,
        daysBack = DAYS_BACK_DEFAULT,
    } = options;

    let finalScrapedData: ScrapedData;
    if (scrapedData) {
        finalScrapedData = scrapedData;
    } else {
        const dataPath = path.resolve(__dirname, '../../purchases-data.json');
        if (!fs.existsSync(dataPath)) {
            throw new Error(`purchases-data.json not found at ${dataPath}`);
        }
        finalScrapedData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    }

    let finalRequestsData: RawRequestsData;
    if (requestsData) {
        finalRequestsData = requestsData;
    } else {
        const requestsPath = path.resolve(__dirname, '../../purchase-requests.json');
        if (fs.existsSync(requestsPath)) {
            finalRequestsData = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
        } else {
            finalRequestsData = { scrapedAt: new Date().toISOString(), requests: [] };
        }
    }

    const workQueue: Array<{ vendor: string; item: ScrapedItem }> = [];
    for (const [vendorKey, items] of Object.entries(finalScrapedData)) {
        const vendor = vendorKey.replace(/\d+$/, '').trim();
        if (vendorFilter && !vendor.toLowerCase().includes(vendorFilter)) continue;
        for (const item of items) {
            workQueue.push({ vendor, item });
        }
    }



    const client = new FinaleClient();
    await client.testConnection();

    const accountPath = process.env.FINALE_ACCOUNT_PATH || '';
    const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
    const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY || ''}:${process.env.FINALE_API_SECRET || ''}`).toString('base64')}`;

    const results: Map<string, AssessedItem[]> = new Map();
    const assessed: Array<{ vendor: string; assessed: AssessedItem }> = [];

    // Vendor suggestions
    const vendorQueue = [...workQueue];
    await Promise.all(Array.from({ length: 3 }, async () => {
        while (vendorQueue.length > 0) {
            const work = vendorQueue.shift()!;
            const { vendor, item } = work;
            const sku = item.sku;

            try {
                const assessedItem = await assessSku(
                    sku,
                    item.description,
                    'VENDOR_SUGGESTION',
                    client,
                    apiBase,
                    accountPath,
                    authHeader,
                    daysBack,
                    item.urgency || undefined,
                    undefined,
                    vendor // pass vendor name
                );
                assessed.push({ vendor, assessed: assessedItem });


            } catch (err: any) {
                assessed.push({
                    vendor,
                    assessed: {
                        vendor, // add vendor here
                        sku,
                        description: item.description,
                        source: 'VENDOR_SUGGESTION',
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

            await new Promise(r => setTimeout(r, 100));
        }
    }));

    // Pending requests
    const pendingRequests = finalRequestsData.requests.filter(r => r.status === 'Pending');
    if (pendingRequests.length > 0) {

        const { products } = await buildProductCatalog();
        const matcher = new FuzzyMatcher(products);
        const requestQueue = [...pendingRequests];
        const requestResults: Array<{ vendor: string; assessed: AssessedItem }> = [];

        await Promise.all(Array.from({ length: REQUEST_WORKERS }, async () => {
            while (requestQueue.length > 0) {
                const req = requestQueue.shift()!;
                const details = req.details;

                try {
                    const match = matcher.match(details);
                    if (!match || match.score < FUZZY_THRESHOLD) {
                        const assessedItem: AssessedItem = {
                            vendor: req.department,
                            sku: '(no match)',
                            description: details,
                            source: 'TEAM_REQUEST',
                            rawDetails: details,
                            rawRequest: req,
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
                            explanation: 'Could not fuzzy-match to a known SKU in Finale.',
                            finaleFound: false,
                            doNotReorder: false,
                            fuzzyMatchScore: match?.score,
                        };
                        requestResults.push({ vendor: req.department, assessed: assessedItem });

                        continue;
                    }

                    const sku = match.product.sku;
                    const assessedItem = await assessSku(
                        sku,
                        details,
                        'TEAM_REQUEST',
                        client,
                        apiBase,
                        accountPath,
                        authHeader,
                        daysBack,
                        undefined,
                        req,
                        req.department
                    );
                    assessedItem.fuzzyMatchScore = match.score;

                    requestResults.push({ vendor: req.department, assessed: assessedItem });


                } catch (err: any) {
                    requestResults.push({
                        vendor: req.department,
                        assessed: {
                            vendor: req.department,
                            sku: '(error)',
                            description: details,
                            source: 'TEAM_REQUEST',
                            rawDetails: details,
                            rawRequest: req,
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
                            explanation: `Error: ${err.message}`,
                            finaleFound: false,
                            doNotReorder: false,
                        },
                    });
                }

                await new Promise(r => setTimeout(r, 100));
            }
        }));

        assessed.push(...requestResults);
    }

    // Group
    for (const { vendor, assessed: item } of assessed) {
        if (!results.has(vendor)) results.set(vendor, []);
        results.get(vendor)!.push(item);
    }

    const necessityRank: Record<NecessityLevel, number> = { HIGH_NEED: 0, MEDIUM: 1, LOW: 2, NOISE: 3 };
    const vendorAssessments: VendorAssessment[] = [];

    for (const [group, items] of results) {
        items.sort((a, b) => necessityRank[a.necessity] - necessityRank[b.necessity]);
        vendorAssessments.push({
            vendor: group,
            items,
            highNeedCount: items.filter(i => i.necessity === 'HIGH_NEED').length,
            mediumCount: items.filter(i => i.necessity === 'MEDIUM').length,
            noiseCount: items.filter(i => i.necessity === 'NOISE' || i.necessity === 'LOW').length,
        });
    }
    vendorAssessments.sort((a, b) => b.highNeedCount - a.highNeedCount || b.mediumCount - a.mediumCount);

    return { vendorAssessments, allAssessed: assessed.map(a => a.assessed) };
}

// ── Printer ──
export function printAssessment(result: AssessmentResult, jsonOutput: boolean = false): void {
    if (jsonOutput) {
        console.log(JSON.stringify(result.vendorAssessments, null, 2));
        return;
    }

    const allItems = result.allAssessed;
    const highCount = allItems.filter(i => i. necessity === 'HIGH_NEED').length;
    const medCount = allItems.filter(i => i.necessity === 'MEDIUM').length;
    const lowCount = allItems.filter(i => i.necessity === 'LOW').length;
    const noiseCount = allItems.filter(i => i.necessity === 'NOISE').length;

    console.log('\n' + '═'.repeat(80));
    console.log(`  PURCHASE ASSESSMENT — ${allItems.length} items`);
    console.log('═'.repeat(80));
    console.log(`  🔴 HIGH NEED: ${highCount}   🟡 MEDIUM: ${medCount}   🟠 LOW: ${lowCount}   ⚪ NOISE: ${noiseCount}`);
    console.log('─'.repeat(80));

    for (const va of result.vendorAssessments) {
        console.log(`\n  ┌─ ${va.vendor} (${va.highNeedCount} high, ${va.mediumCount} med, ${va.noiseCount} noise)`);
        console.log('  │');
        for (const item of va.items) {
            const icon = item.necessity === 'HIGH_NEED' ? '🔴' : item.necessity === 'MEDIUM' ? '🟡' : item.necessity === 'LOW' ? '🟠' : '⚪';
            const sourceTag = item.source === 'TEAM_REQUEST' ? '[REQ]' : '';
            console.log(`  │  ${icon} ${sourceTag} ${item.necessity.padEnd(10)} ${item.sku.padEnd(14)} ${item.description}`);
            console.log(`  │     ${item.explanation}`);
            if (item.openPOs.length > 0) {
                const poList = item.openPOs.map(po => `${po.orderId} (qty ${Math.round(po.quantity)})`).join(', ');
                console.log(`  │     Open POs: ${poList}`);
            }
            if (item.scrapedUrgency && item.scrapedUrgency !== '(none)') {
                console.log(`  │     Dashboard claimed: ${item.scrapedUrgency}`);
            }
            if (item.fuzzyMatchScore !== undefined) {
                console.log(`  │     Fuzzy match score: ${item.fuzzyMatchScore.toFixed(2)}`);
            }
            if (item.rawDetails && item.rawDetails !== item.description) {
                console.log(`  │     Request: ${item.rawDetails}`);
            }
        }
        console.log('  └─');
    }

    console.log('\n' + '═'.repeat(80));

    if (highCount > 0) {
        console.log('\n  ACTION ITEMS — Order these now:\n');
        for (const va of result.vendorAssessments) {
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
}

/**
 * @file    purchasing.ts
 * @purpose Decomposed module for Finale purchasing algorithms, velocity metrics, cover calculations, and draft PO actions.
 * @author  Aria / Antigravity
 * @created 2026-05-26
 */

import { recommendQty } from "@/lib/purchasing/qty-recommender";
import { applySmartMOQTopUp } from "@/lib/purchasing/moq-topup";
import { getPackSizes } from "@/lib/purchasing/pack-size-registry";
import {
    loadActiveReservations,
    loadAllVendorReorderPolicies,
    loadCalibrationStats,
    loadVendorMOQs,
    loadVendorReorderPolicies,
    loadVendorRecentLineQtys,
    loadShipmentLegs,
    type ShipmentLeg,
    type VendorReorderPolicy,
    recordRecommendationSnapshots,
    type RecommendationSnapshot,
} from "@/lib/purchasing/calibration";
import { leadTimeService } from "@/lib/builds/lead-time-service";
import { shouldIncludePurchasingCandidate } from "./purchasing-candidate";
import {
    enrichOpenPOs,
    hasDeliverablePO,
    deliverableStockOnOrder,
    type OpenPOReliable,
} from "../purchasing/po-reliability-scorer";
import {
    FinaleProductsClient,
    EXCLUDED_VENDOR_PATTERN,
    _partyCacheShared,
    PARTY_CACHE_TTL,
    PARTY_CACHE_MAX,
    _skuHasNoBomCache,
    _bomComponent404Cache,
} from "./products";
import {
    type FinaleReorderMethod,
    parseFinaleNumber,
    parseISODateOnly,
    chooseVelocitySignal,
    normalizeFinaleReorderMethod,
    type ExternalReorderItem,
    type ExternalReorderGroup,
    type PurchasingItem,
    type PurchasingGroup,
    type DraftPOReview,
    type ConsumptionReport,
    type ProductConsumptionAnalysis,
    type ConsumptionPeriodBucket,
    type SendPurchaseOrderEmailInput,
    type SendPurchaseOrderEmailResult,
} from "./core-client";

let _vendorLeadTimeRawCache: Map<string, number[]> | null = null;
let _vendorLeadTimeRawCacheAt = 0;
const VENDOR_LEAD_TIME_RAW_TTL = 4 * 60 * 60 * 1000;

let _vendorOnTimeRateCache: Map<string, number> = new Map();
let _vendorOnTimeRateCacheAt = 0;
const MAX_VENDOR_LEAD_TIME_DAYS = 90;

/**
 * Parallel vendor party-ID cache. Populated by getVendorLeadTimeHistory() from
 * the same GraphQL query — zero extra API calls. Key = lowercased vendor name,
 * value = party ID string. Used by lead-time-tracker to key vendor_lead_time_stats
 * by party ID (the canonical identifier) rather than vendor name (which can drift).
 */
let _vendorPartyIdCache: Map<string, string> = new Map();

/**
 * Per-PO date cache for lead-time temporal analysis. Key = vendor name,
 * value = array of { receiveDate, days } for each completed PO in the lookback
 * window. Populated alongside _vendorLeadTimeRawCache in getVendorLeadTimeHistory()
 * — same GraphQL call, zero extra API overhead.
 *
 * Used by lead-time-tracker to compute:
 *   - spread_days: calendar days between earliest and latest receiveDate (true PO cadence signal)
 *   - first_po_date / last_po_date: actual temporal boundaries
 *   - avg_days_recent_30: trend signal (is the vendor getting faster or slower?)
 */
interface LeadTimePOEntry { receiveDate: string; days: number; }
let _vendorLeadTimeDateCache: Map<string, LeadTimePOEntry[]> = new Map();
let _vendorLeadTimeDateCacheAt = 0;

export class FinalePurchasingClient extends FinaleProductsClient {
    constructor() {
        super();
    }

    /**
     * Helper to retrieve sales quantity, stock on hand, and open demand quantity.
     * Maps to getProductActivity behind the scenes to fetch these statistics in one GraphQL query.
     */
    protected async getSalesQty(sku: string, daysBack: number): Promise<{
        totalSoldQty: number;
        stockOnHand: number | null;
        openDemandQty: number;
        stockAvailable: number | null;
    }> {
        try {
            const activity = await this.getProductActivity(sku, daysBack);
            return {
                totalSoldQty: activity.soldQty,
                stockOnHand: activity.stockOnHand,
                openDemandQty: 0,
                stockAvailable: activity.stockAvailable,
            };
        } catch (err) {
            console.error(`[finale] getSalesQty error for ${sku}:`, err);
            return {
                totalSoldQty: 0,
                stockOnHand: null,
                openDemandQty: 0,
                stockAvailable: null,
            };
        }
    }

    /**
     * Check for existing open/committed POs from the same vendor that overlap
     * with the items about to be ordered. Prevents accidental double-ordering.
     *
     * @param vendorPartyId - Finale party URL or ID for the vendor
     * @param productIds    - Array of SKUs being ordered
     * @returns Array of overlapping POs with their shared SKUs (empty = no dups)
     */
    async checkDuplicatePOs(
        vendorPartyId: string,
        productIds: string[]
    ): Promise<Array<{ orderId: string; status: string; orderDate: string; overlappingSKUs: string[]; finaleUrl: string }>> {
        try {
            const partyId = vendorPartyId.split('/').pop() || vendorPartyId;
            const now = new Date();
            const begin = new Date(now);
            begin.setDate(begin.getDate() - 180);
            const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            const endStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            const query = {
                query: `{
                    orderViewConnection(
                        first: 200
                        type: ["PURCHASE_ORDER"]
                        orderDate: { begin: "${beginStr}", end: "${endStr}" }
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges { node {
                            orderId orderUrl status orderDate
                            supplier { partyUrl name }
                            itemList(first: 100) {
                                edges { node { product { productId } } }
                            }
                        }}
                    }
                }`
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            const json: any = await res.json();
            const edges: any[] = json.data?.orderViewConnection?.edges || [];

            const productSet = new Set(productIds.map(p => p.toLowerCase()));
            const duplicates: Array<{ orderId: string; status: string; orderDate: string; overlappingSKUs: string[]; finaleUrl: string }> = [];

            for (const edge of edges) {
                const po = edge.node;
                if (!["Draft", "Committed"].includes(po.status || "")) continue;
                // Match vendor by partyUrl suffix
                const poVendorId = po.supplier?.partyUrl?.split('/').pop() || '';
                if (poVendorId !== partyId) continue;

                const poSkus = (po.itemList?.edges || []).map((ie: any) =>
                    (ie.node.product?.productId || '').toLowerCase()
                );
                const overlap = poSkus.filter((s: string) => productSet.has(s));

                if (overlap.length > 0) {
                    const encodedUrl = Buffer.from(po.orderUrl || '').toString('base64');
                    duplicates.push({
                        orderId: po.orderId,
                        status: po.status,
                        orderDate: po.orderDate || '',
                        overlappingSKUs: overlap,
                        finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
                    });
                }
            }

            if (duplicates.length > 0) {
                console.log(`[finale] checkDuplicatePOs: ${duplicates.length} existing PO(s) with overlapping SKUs for vendor ${partyId}`);
            }
            return duplicates;
        } catch (err: any) {
            console.warn('[finale] checkDuplicatePOs failed:', err.message);
            return [];
        }
    }

    /**
     * List recent POs for a vendor by fuzzy supplier-name match.
     *
     * Used by po-resolver.ts as a fallback when the printed PO# doesn't
     * resolve. Will's intuition: for vendors like Axiom Print, the most
     * recent OPEN PO for the vendor is almost always the right correlation
     * for an arriving invoice.
     *
     * Vendor matching: case-insensitive substring match on the supplier
     * name. We can't reliably look up partyId from a name, so we filter
     * server-side by date and post-filter in JS by name overlap.
     *
     * Returns POs sorted by `orderDate desc`. Each row carries enough to
     * drive correlation strategies (SKUs, total, status).
     */
    async listRecentPosByVendor(
        vendorName: string,
        opts: { daysBack?: number; statuses?: string[]; limit?: number } = {},
    ): Promise<Array<{
        orderId: string;
        status: string;
        orderDate: string;
        supplierName: string;
        supplierPartyUrl: string | null;
        total: number;
        skus: string[];
    }>> {
        const daysBack = opts.daysBack ?? 60;
        const statuses = opts.statuses ?? ["ORDER_CREATED", "ORDER_LOCKED", "ORDER_COMMITTED"];
        const limit = opts.limit ?? 50;
        try {
            const now = new Date();
            const begin = new Date(now);
            begin.setDate(begin.getDate() - daysBack);
            const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const endStr = now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

            const query = {
                query: `{
                    orderViewConnection(
                        first: ${limit}
                        type: ["PURCHASE_ORDER"]
                        status: [${statuses.map(s => `"${s}"`).join(", ")}]
                        orderDate: { begin: "${beginStr}", end: "${endStr}" }
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges { node {
                            orderId
                            status
                            orderDate
                            supplier { partyUrl name }
                            totalAmount { amount }
                            itemList(first: 200) {
                                edges { node { product { productId } } }
                            }
                        }}
                    }
                }`,
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
                body: JSON.stringify(query),
            });
            const json: any = await res.json();
            const edges: any[] = json.data?.orderViewConnection?.edges || [];

            const vendorWords = vendorName
                .toLowerCase()
                .split(/\s+/)
                .filter(w => w.length > 2 && !["inc", "llc", "co", "ltd", "the"].includes(w));

            const matches: Array<{
                orderId: string;
                status: string;
                orderDate: string;
                supplierName: string;
                supplierPartyUrl: string | null;
                total: number;
                skus: string[];
            }> = [];

            for (const e of edges) {
                const po = e.node;
                const supplierName = (po.supplier?.name ?? "").toString();
                const supplierLower = supplierName.toLowerCase();
                // Match if any meaningful invoice word appears in supplier name
                // OR supplier name appears in invoice vendor name (catches "Axiom" ↔ "Axiom Print").
                const hasOverlap = vendorWords.some(w => supplierLower.includes(w))
                    || vendorWords.length === 0
                    || supplierLower.split(/\s+/).some(w => w.length > 2 && vendorName.toLowerCase().includes(w));
                if (!hasOverlap) continue;

                const skus = (po.itemList?.edges ?? [])
                    .map((ie: any) => (ie.node?.product?.productId ?? "").toString())
                    .filter(Boolean);
                matches.push({
                    orderId: po.orderId,
                    status: po.status ?? "",
                    orderDate: po.orderDate ?? "",
                    supplierName,
                    supplierPartyUrl: po.supplier?.partyUrl ?? null,
                    total: Number(po.totalAmount?.amount ?? 0),
                    skus,
                });
            }
            return matches;
        } catch (err: any) {
            console.warn(`[finale] listRecentPosByVendor failed for "${vendorName}": ${err.message}`);
            return [];
        }
    }

    /**
     * Calculate the actual average lead time for a vendor by examining
     * the last N completed POs: avg(receiveDate - orderDate).
     *
     * @param supplierName - Vendor name (case-insensitive match)
     * @param limit        - Number of recent POs to analyze (default 10)
     * @returns Actual lead time in days, or null if insufficient data
     */
    async getVendorLeadTimeActual(supplierName: string, limit: number = 50): Promise<number | null> {
        try {
            const query = {
                query: `{
                    orderViewConnection(
                        first: ${limit}
                        type: ["PURCHASE_ORDER"]
                        status: ["ORDER_COMPLETED"]
                        sort: [{ field: "receiveDate", mode: "desc" }]
                    ) {
                        edges { node {
                            orderId orderDate receiveDate
                            supplier { name }
                        }}
                    }
                }`
            };

            const data = await this.graphql(query, `Vendor Lead Time: ${supplierName}`);
            const edges: any[] = data?.orderViewConnection?.edges || [];

            const vendorPOs = edges
                .map((e: any) => e.node)
                .filter((po: any) =>
                    po.supplier?.name?.toLowerCase().includes(supplierName.toLowerCase()) &&
                    po.orderDate && po.receiveDate
                );

            if (vendorPOs.length < 2) return null; // Need at least 2 data points

            const leadTimes = vendorPOs.map((po: any) => {
                const ordered = new Date(po.orderDate).getTime();
                const received = new Date(po.receiveDate).getTime();
                return Math.max(0, Math.round((received - ordered) / 86_400_000));
            });

            const avg = Math.round(leadTimes.reduce((s: number, d: number) => s + d, 0) / leadTimes.length);
            console.log(`[finale] Vendor lead time for "${supplierName}": ${avg}d avg (from ${leadTimes.length} POs: ${leadTimes.join(', ')}d)`);
            return avg;
        } catch (err: any) {
            console.warn('[finale] getVendorLeadTimeActual failed:', err.message);
            return null;
        }
    }

    /**
     * Compare a product's current supplier price against the last committed PO price.
     * Returns the price change details if a significant deviation is detected.
     *
     * @param productId    - SKU to check
     * @param currentPrice - Current supplier list price
     * @param threshold    - Percentage change to flag (default 10%)
     * @returns Price change info or null if no significant change
     */
    async checkPriceChange(
        productId: string,
        currentPrice: number,
        threshold: number = 10
    ): Promise<{ productId: string; previousPrice: number; currentPrice: number; changePct: number; lastPOId: string; lastPODate: string } | null> {
        if (!currentPrice || currentPrice <= 0) return null;
        try {
            const productUrl = `/${this.accountPath}/api/product/${productId}`;
            const query = {
                query: `{
                    orderViewConnection(
                        first: 20
                        type: ["PURCHASE_ORDER"]
                        product: ["${productUrl}"]
                        status: ["ORDER_COMMITTED", "ORDER_COMPLETED"]
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges { node {
                            orderId orderDate
                            itemList(first: 20) {
                                edges { node {
                                    product { productId }
                                    unitPrice
                                }}
                            }
                        }}
                    }
                }`
            };

            const data = await this.graphql(query, `Price Change Check: ${productId}`);
            const edges: any[] = data?.orderViewConnection?.edges || [];

            for (const edge of edges) {
                const po = edge.node;
                for (const itemEdge of (po.itemList?.edges || [])) {
                    const item = itemEdge.node;
                    if (item.product?.productId?.toLowerCase() === productId.toLowerCase()) {
                        const prevPrice = parseFinaleNumber(item.unitPrice);
                        if (prevPrice <= 0) continue;
                        const changePct = Math.round(((currentPrice - prevPrice) / prevPrice) * 100);
                        if (Math.abs(changePct) >= threshold) {
                            return {
                                productId,
                                previousPrice: prevPrice,
                                currentPrice,
                                changePct,
                                lastPOId: po.orderId,
                                lastPODate: po.orderDate || '',
                            };
                        }
                        return null; // Found the SKU but price change is within threshold
                    }
                }
            }
            return null; // SKU not found in recent POs — first order
        } catch (err: any) {
            console.warn(`[finale] checkPriceChange failed for ${productId}:`, err.message);
            return null;
        }
    }

    /**
     * Fetch draft Purchase Orders older than N days (for stale draft cleanup alerts).
     *
     * @param daysOld - Minimum age in days (default 3)
     * @returns Array of stale draft POs with vendor, age, and item count
     */
    async getStaleDraftPOs(daysOld: number = 3): Promise<Array<{
        orderId: string; supplier: string; orderDate: string;
        ageDays: number; itemCount: number; total: number; finaleUrl: string;
    }>> {
        try {
            const query = {
                query: `{
                    orderViewConnection(
                        first: 100
                        type: ["PURCHASE_ORDER"]
                        status: ["ORDER_CREATED"]
                        sort: [{ field: "orderDate", mode: "asc" }]
                    ) {
                        edges { node {
                            orderId orderUrl orderDate total status
                            supplier { name }
                            itemList(first: 50) {
                                edges { node { product { productId } } }
                            }
                        }}
                    }
                }`
            };

            const data = await this.graphql(query, 'Stale Draft POs');
            const edges: any[] = data?.orderViewConnection?.edges || [];
            const now = Date.now();

            return edges
                .map((e: any) => {
                    const po = e.node;
                    const orderMs = new Date(po.orderDate || now).getTime();
                    const ageDays = Math.floor((now - orderMs) / 86_400_000);
                    const encodedUrl = Buffer.from(po.orderUrl || '').toString('base64');
                    return {
                        orderId: po.orderId,
                        supplier: po.supplier?.name || 'Unknown',
                        orderDate: po.orderDate || '',
                        ageDays,
                        itemCount: po.itemList?.edges?.length ?? 0,
                        total: parseFinaleNumber(po.total),
                        finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
                    };
                })
                .filter(po => po.ageDays >= daysOld);
        } catch (err: any) {
            console.warn('[finale] getStaleDraftPOs failed:', err.message);
            return [];
        }
    }

    /**
     * Project purchasing spend over a time horizon, grouped by vendor.
     * Uses daily consumption velocity × unit price × days.
     *
     * @param days - Forecast horizon (30, 60, or 90)
     * @returns Array of vendor spend projections sorted by highest spend first
     */
    async getSpendForecast(days: number = 30): Promise<Array<{
        vendor: string; projectedSpend: number;
        topSkus: Array<{ sku: string; spend: number; dailyRate: number }>;
    }>> {
        try {
            // Reuse external reorder items since they already have velocity + price
            const groups = await this.getExternalReorderItems();
            const forecast: Array<{
                vendor: string; projectedSpend: number;
                topSkus: Array<{ sku: string; spend: number; dailyRate: number }>;
            }> = [];

            for (const group of groups) {
                let vendorTotal = 0;
                const skuSpends: Array<{ sku: string; spend: number; dailyRate: number }> = [];

                for (const item of group.items) {
                    const dailyRate = item.consumptionQty / 90; // 90-day lookback → daily
                    const projected = dailyRate * days * item.unitPrice;
                    vendorTotal += projected;
                    skuSpends.push({
                        sku: item.productId,
                        spend: Math.round(projected),
                        dailyRate: Math.round(dailyRate * 10) / 10,
                    });
                }

                if (vendorTotal > 0) {
                    forecast.push({
                        vendor: group.vendorName,
                        projectedSpend: Math.round(vendorTotal),
                        topSkus: skuSpends.sort((a, b) => b.spend - a.spend).slice(0, 5),
                    });
                }
            }

            return forecast.sort((a, b) => b.projectedSpend - a.projectedSpend);
        } catch (err: any) {
            console.warn('[finale] getSpendForecast failed:', err.message);
            return [];
        }
    }

    /**
     * Get consumption and stock data for a SKU using Finale's native GraphQL fields.
     * 
     * DECISION(2026-02-24): Instead of reconstructing consumption from build orders
     * (which Finale doesn't expose as a separate order type), we use Finale's own
     * calculated fields: consumptionQuantity, demandQuantity, stockoutDays, etc.
     * These are the same values shown in Finale's Product List screen.
     * 
     * Key fields from Finale's GraphQL:
     * - stockOnHand: Current units in stock ("--" if not tracked)
     * - stockAvailable: Available after committed allocations
     * - stockOnOrder: Units on open POs
     * - consumptionQuantity: Finale's calculated consumption
     * - demandQuantity: Units needed for committed orders/builds
     * - stockoutDays: Days until stockout (Finale-calculated)
     * - reorderQuantityToOrder: Finale's suggested reorder qty
     * - potentialBuildQuantity: How many can be built with current components
     * - safetyStockDays: Configured safety stock days
     */
    async getBOMConsumption(productId: string, days: number = 90): Promise<ConsumptionReport> {
        let product = await this.lookupProduct(productId);
        let actualProductId = productId;

        // Auto-correct if EXACT lookup fails (useful for "GnarBar" instead of "GNARBAR01B")
        if (!product) {
            const fuzzy = await this.searchProducts(productId, 1);
            if (fuzzy.results && fuzzy.results.length > 0) {
                actualProductId = fuzzy.results[0].productId;
                product = await this.lookupProduct(actualProductId);
            }
        }

        const productName = product?.name || actualProductId;

        // Query Finale's native stock and consumption fields via GraphQL
        let finaleData: Record<string, string | null> = {};
        try {
            const query = {
                query: `{
                    productViewConnection(first: 1, productId: "${actualProductId}") {
                        edges {
                            node {
                                productId
                                stockOnHand
                                stockAvailable
                                stockOnOrder
                                stockReserved
                                consumptionQuantity
                                demandQuantity
                                stockoutDays
                                reorderQuantityToOrder
                                potentialBuildQuantity
                                stockBomQuantity
                                safetyStockDays
                                reorderQuantity
                                unitsInStock
                            }
                        }
                    }
                }`
            };
            const data = await this.graphql(query, `BOM Consumption ${actualProductId}`);
            const node = data?.productViewConnection?.edges?.[0]?.node;
            if (node) {
                finaleData = {
                    stockOnHand: node.stockOnHand ?? null,
                    stockAvailable: node.stockAvailable ?? null,
                    stockOnOrder: node.stockOnOrder ?? null,
                    stockReserved: node.stockReserved ?? null,
                    consumptionQuantity: node.consumptionQuantity ?? null,
                    demandQuantity: node.demandQuantity ?? null,
                    stockoutDays: node.stockoutDays ?? null,
                    reorderQuantityToOrder: node.reorderQuantityToOrder ?? null,
                    potentialBuildQuantity: node.potentialBuildQuantity ?? null,
                    stockBomQuantity: node.stockBomQuantity ?? null,
                    safetyStockDays: node.safetyStockDays ?? null,
                    reorderQuantity: node.reorderQuantity ?? null,
                    unitsInStock: node.unitsInStock ?? null,
                };
            }
        } catch (err: any) {
            console.error('Stock query failed:', err.message);
        }

        // Parse Finale's values (they come as strings, "--" means not tracked)
        const parseVal = (val: string | null | undefined): number | null => {
            if (!val || val === '--' || val === 'null') return null;
            const n = parseFloat(val.replace(/,/g, ''));
            return isNaN(n) ? null : n;
        };

        const stockOnHand = parseVal(finaleData.stockOnHand) ?? parseVal(finaleData.unitsInStock);
        const stockAvailable = parseVal(finaleData.stockAvailable);
        const stockOnOrder = parseVal(finaleData.stockOnOrder);
        const consumption = parseVal(finaleData.consumptionQuantity);
        const demand = parseVal(finaleData.demandQuantity);
        const stockoutDays = parseVal(finaleData.stockoutDays);
        const reorderQty = parseVal(finaleData.reorderQuantityToOrder) ?? parseVal(finaleData.reorderQuantity);
        const potentialBuild = parseVal(finaleData.potentialBuildQuantity);
        const bomQty = parseVal(finaleData.stockBomQuantity);
        const safetyDays = parseVal(finaleData.safetyStockDays);

        // Calculate daily rate from demand or consumption
        const totalConsumed = demand ?? consumption ?? 0;
        const dailyRate = days > 0 && totalConsumed > 0 ? totalConsumed / days : 0;
        const estimatedDaysLeft = stockoutDays ?? (
            (stockOnHand !== null && dailyRate > 0) ? Math.round(stockOnHand / dailyRate) : null
        );

        // Build Telegram message (clean design, minimal icons)
        let msg = `*${productName}* (\`${actualProductId}\`)\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        // Stock section
        if (stockOnHand !== null) {
            msg += `On Hand: *${stockOnHand.toLocaleString()}* units\n`;
        }
        if (stockAvailable !== null && stockAvailable !== stockOnHand) {
            msg += `Available: ${stockAvailable.toLocaleString()} units\n`;
        }
        if (stockOnOrder !== null && stockOnOrder > 0) {
            msg += `On Order: ${stockOnOrder.toLocaleString()} units\n`;
        }

        // Consumption section
        msg += `\n*Demand & Consumption*\n`;
        if (demand !== null) {
            msg += `Demand: ${demand.toLocaleString()} units\n`;
        }
        if (consumption !== null && consumption > 0) {
            msg += `Consumption: ${consumption.toLocaleString()} units\n`;
        }
        if (dailyRate > 0) {
            msg += `Daily rate: ~${dailyRate.toFixed(1)} units/day\n`;
        }

        // Stockout section  
        if (estimatedDaysLeft !== null) {
            const urgency = estimatedDaysLeft < 30 ? 'CRITICAL:' : estimatedDaysLeft < 60 ? 'WARNING:' : 'OK:';
            msg += `\n*${urgency} Est. ${estimatedDaysLeft} days to stockout*\n`;
        }

        // BOM info
        if (potentialBuild !== null && potentialBuild > 0) {
            msg += `\n*Manufacturing Potential*\n`;
            msg += `Can build: ${potentialBuild.toLocaleString()} units\n`;
        }
        if (bomQty !== null && bomQty > 0) {
            msg += `BOM qty/build: ${bomQty.toLocaleString()} units\n`;
        }

        // Reorder recommendation
        if (reorderQty !== null && reorderQty > 0) {
            msg += `\n*Finale Suggests Ordering: ${reorderQty.toLocaleString()} units*\n`;
        }
        if (safetyDays !== null) {
            msg += `Safety stock setting: ${safetyDays} days\n`;
        }

        // Supplier & lead time from product detail
        if (product?.leadTimeDays || (product?.suppliers && product.suppliers.length > 0)) {
            msg += `\n*Supplier Info*\n`;
            if (product.leadTimeDays) {
                msg += `Lead time: ${product.leadTimeDays} days\n`;
            }
            if (product.suppliers && product.suppliers.length > 0) {
                const main = product.suppliers.find(s => s.role === 'MAIN') || product.suppliers[0];
                msg += `Supplier: ${main.name}`;
                if (main.cost) msg += ` ($${main.cost.toFixed(2)}/unit)`;
                msg += `\n`;
            }
        }

        // Open POs
        if (product?.openPOs && product.openPOs.length > 0) {
            msg += `\n*Open POs:*\n`;
            for (const po of product.openPOs) {
                msg += `PO ${po.orderId}: ${po.quantityOnOrder} from ${po.supplier}\n`;
            }
        }

        return {
            productId: actualProductId,
            name: productName,
            periodDays: days,
            totalConsumed,
            dailyRate,
            currentStock: stockOnHand,
            estimatedDaysLeft,
            buildOrders: [], // Not available via this method
            telegramMessage: msg,
        };
    }

    /**
     * Product consumption / demand analysis bucketed into monthly, quarterly,
     * and yearly totals. Accepts a SKU or a description keyword — falls back
     * to searchProducts() fuzzy match when exact lookup fails.
     *
     * Data sources (single combined GraphQL call):
     *   - purchasedIn : PURCHASE_ORDER line quantities (receipts)  → demand proxy for components/supplies
     *   - soldIn      : SALES_ORDER line quantities (shipments)    → demand for finished goods
     *   - productView : current stock + Finale's rolling consumption/demand
     *
     * Classification heuristic:
     *   - supplier groupName matches "buildasoil"/"manufacturing" → finished_good
     *   - otherwise if Finale reports consumptionQuantity > 0     → component
     *   - otherwise                                               → supply
     *
     * Note: For components consumed inside manufactured builds, shipments
     * on the component SKU are typically zero (the parent ships, not the
     * component). Use `totals.purchased` + Finale's `totals.consumption`
     * as the demand signal for components. Velocity basis is auto-selected.
     */
    async getProductConsumptionAnalysis(
        query: string,
        daysBack: number = 365
    ): Promise<ProductConsumptionAnalysis | null> {
        // 1. Resolve query → actual SKU
        let product = await this.lookupProduct(query);
        let actualProductId = query;
        if (!product) {
            const fuzzy = await this.searchProducts(query, 1);
            if (!fuzzy.results || fuzzy.results.length === 0) {
                return null;
            }
            actualProductId = fuzzy.results[0].productId;
            product = await this.lookupProduct(actualProductId);
            if (!product) return null;
        }
        const productName = product?.name || actualProductId;

        // 2. Resolve vendor / product type
        let vendorName: string | null = null;
        let productType: ProductConsumptionAnalysis['productType'] = 'unknown';
        try {
            const prodData = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(actualProductId)}`);
            const suppliers: any[] = prodData.supplierList || [];
            const mainSupplier = suppliers.find(s => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
            if (mainSupplier?.supplierPartyUrl) {
                const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                if (partyId) {
                    try {
                        const party = await this.get(`/${this.accountPath}/api/partygroup/${partyId}`);
                        vendorName = party.groupName || null;
                        const nameLc = (vendorName || '').toLowerCase();
                        if (nameLc.includes('buildasoil') || nameLc.includes('manufacturing')) {
                            productType = 'finished_good';
                        }
                    } catch { /* fall through */ }
                }
            }
        } catch { /* fall through */ }

        // 3. GraphQL: receipts + shipments + stock/consumption (single call)
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 1);
        const beginDate = new Date(now);
        beginDate.setDate(beginDate.getDate() - daysBack);
        const beginStr = beginDate.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const productUrl = `/${this.accountPath}/api/product/${actualProductId}`;

        const gql = {
            query: `query {
                purchasedIn: orderViewConnection(
                    first: 500
                    type: ["PURCHASE_ORDER"]
                    product: ["${productUrl}"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]
                ) {
                    edges { node {
                        status orderDate
                        itemList(first: 20) { edges { node { product { productId } quantity } } }
                    }}
                }
                soldIn: orderViewConnection(
                    first: 500
                    type: ["SALES_ORDER"]
                    product: ["${productUrl}"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]
                ) {
                    edges { node {
                        status orderDate
                        itemList(first: 20) { edges { node { product { productId } quantity } } }
                    }}
                }
                productView: productViewConnection(first: 1, productId: "${actualProductId}") {
                    edges { node {
                        stockOnHand stockAvailable unitsInStock
                        consumptionQuantity demandQuantity
                    }}
                }
            }`
        };

        const data = await this.graphql(gql, `Consumption Analysis ${actualProductId}`);

        // 4. Bucket by YYYY-MM
        const monthMap = new Map<string, ConsumptionPeriodBucket>();
        const getBucket = (period: string): ConsumptionPeriodBucket => {
            let b = monthMap.get(period);
            if (!b) { b = { period, purchasedQty: 0, soldQty: 0, orderCount: 0 }; monthMap.set(period, b); }
            return b;
        };

        let totalPurchased = 0;
        for (const edge of data?.purchasedIn?.edges || []) {
            const node = edge.node;
            if (node.status !== 'Completed') continue;
            const dateStr = (node.orderDate || '').slice(0, 7); // YYYY-MM
            if (!dateStr) continue;
            for (const ie of node.itemList?.edges || []) {
                if (ie.node?.product?.productId !== actualProductId) continue;
                const qty = parseFinaleNumber(ie.node.quantity);
                if (qty <= 0) continue;
                const bucket = getBucket(dateStr);
                bucket.purchasedQty += qty;
                bucket.orderCount += 1;
                totalPurchased += qty;
                break;
            }
        }

        let totalSold = 0;
        for (const edge of data?.soldIn?.edges || []) {
            const node = edge.node;
            if (node.status !== 'Completed' && node.status !== 'Shipped') continue;
            const dateStr = (node.orderDate || '').slice(0, 7);
            if (!dateStr) continue;
            for (const ie of node.itemList?.edges || []) {
                if (ie.node?.product?.productId !== actualProductId) continue;
                const qty = parseFinaleNumber(ie.node.quantity);
                if (qty <= 0) continue;
                const bucket = getBucket(dateStr);
                bucket.soldQty += qty;
                bucket.orderCount += 1;
                totalSold += qty;
                break;
            }
        }

        // Sort monthly ascending (oldest → newest) for a readable timeline
        const monthly = Array.from(monthMap.values()).sort((a, b) => a.period.localeCompare(b.period));

        // Roll up quarterly + yearly
        const quarterMap = new Map<string, ConsumptionPeriodBucket>();
        const yearMap = new Map<string, ConsumptionPeriodBucket>();
        for (const m of monthly) {
            const [yStr, mStr] = m.period.split('-');
            const q = Math.floor((parseInt(mStr, 10) - 1) / 3) + 1;
            const qKey = `${yStr}-Q${q}`;
            let qb = quarterMap.get(qKey);
            if (!qb) { qb = { period: qKey, purchasedQty: 0, soldQty: 0, orderCount: 0 }; quarterMap.set(qKey, qb); }
            qb.purchasedQty += m.purchasedQty; qb.soldQty += m.soldQty; qb.orderCount += m.orderCount;

            let yb = yearMap.get(yStr);
            if (!yb) { yb = { period: yStr, purchasedQty: 0, soldQty: 0, orderCount: 0 }; yearMap.set(yStr, yb); }
            yb.purchasedQty += m.purchasedQty; yb.soldQty += m.soldQty; yb.orderCount += m.orderCount;
        }
        const quarterly = Array.from(quarterMap.values()).sort((a, b) => a.period.localeCompare(b.period));
        const yearly = Array.from(yearMap.values()).sort((a, b) => a.period.localeCompare(b.period));

        // 5. Pull live stock + Finale's rolling consumption/demand
        const parseVal = (v: any): number | null => {
            if (v == null || v === '--' || v === 'null') return null;
            const n = parseFloat(String(v).replace(/,/g, ''));
            return isNaN(n) ? null : n;
        };
        const pvNode = data?.productView?.edges?.[0]?.node;
        const stockOnHand = parseVal(pvNode?.stockOnHand) ?? parseVal(pvNode?.unitsInStock);
        const consumption = parseVal(pvNode?.consumptionQuantity);
        const demand = parseVal(pvNode?.demandQuantity);

        // Refine classification from signals gathered
        if (productType === 'unknown') {
            if ((consumption ?? 0) > 0 && totalSold === 0) productType = 'component';
            else if (totalSold > 0) productType = 'supply'; // directly sold but not manufactured
            else productType = 'supply';
        }

        // 6. Velocity — auto-pick the strongest signal
        let basis: ProductConsumptionAnalysis['velocity']['basis'] = 'none';
        let perDay = 0;
        if (totalSold > 0) { basis = 'sold'; perDay = totalSold / daysBack; }
        else if ((consumption ?? 0) > 0) { basis = 'consumption'; perDay = (consumption as number) / daysBack; }
        else if (totalPurchased > 0) { basis = 'purchased'; perDay = totalPurchased / daysBack; }
        else if ((demand ?? 0) > 0) { basis = 'demand'; perDay = (demand as number) / daysBack; }

        const velocity = {
            perDay,
            perMonth: perDay * 30,
            perQuarter: perDay * 91,
            perYear: perDay * 365,
            basis,
        };

        // 7. Build telegram message
        const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
        const typeLabel: Record<string, string> = {
            finished_good: 'Finished Good', component: 'Component', supply: 'Supply', unknown: 'Product',
        };
        let msg = `*${productName}* (\`${actualProductId}\`)\n`;
        msg += `_${typeLabel[productType]}${vendorName ? ` · ${vendorName}` : ''}_\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        if (stockOnHand !== null) msg += `On Hand: *${fmt(stockOnHand)}*\n`;
        msg += `\n*Window: ${daysBack}d*\n`;
        msg += `Received: ${fmt(totalPurchased)}  ·  Shipped: ${fmt(totalSold)}\n`;
        if (consumption !== null) msg += `Finale consumption (rolling): ${fmt(consumption)}\n`;
        if (demand !== null) msg += `Finale demand (rolling): ${fmt(demand)}\n`;

        if (basis !== 'none') {
            msg += `\n*Demand Velocity* (basis: ${basis})\n`;
            msg += `~${fmt(velocity.perMonth)}/mo  ·  ~${fmt(velocity.perQuarter)}/qtr  ·  ~${fmt(velocity.perYear)}/yr\n`;
            if (stockOnHand !== null && perDay > 0) {
                msg += `Runway: ~${Math.round(stockOnHand / perDay)}d\n`;
            }
        }

        if (yearly.length > 0) {
            msg += `\n*Yearly*\n`;
            for (const y of yearly) {
                msg += `  ${y.period}: recv ${fmt(y.purchasedQty)} · ship ${fmt(y.soldQty)}\n`;
            }
        }
        if (quarterly.length > 0 && quarterly.length <= 12) {
            msg += `\n*Quarterly*\n`;
            for (const q of quarterly) {
                msg += `  ${q.period}: recv ${fmt(q.purchasedQty)} · ship ${fmt(q.soldQty)}\n`;
            }
        }
        if (monthly.length > 0) {
            msg += `\n*Monthly* (last ${Math.min(monthly.length, 12)})\n`;
            for (const m of monthly.slice(-12)) {
                msg += `  ${m.period}: recv ${fmt(m.purchasedQty)} · ship ${fmt(m.soldQty)}\n`;
            }
        }
        if (monthly.length === 0 && totalPurchased === 0 && totalSold === 0) {
            msg += `\n_No order activity in the last ${daysBack}d._\n`;
        }

        return {
            productId: actualProductId,
            productName,
            productType,
            vendorName,
            windowDays: daysBack,
            stockOnHand,
            totals: { purchased: totalPurchased, sold: totalSold, consumption, demand },
            velocity,
            monthly,
            quarterly,
            yearly,
            telegramMessage: msg,
        };
    }

    /**
     * Fetch just the lead time (days) for a component SKU.
     * Single REST call — no supplier resolution or PO lookup.
     * Returns null if the product has no lead time set or on any error.
     */
    async getLeadTime(sku: string): Promise<number | null> {
        try {
            const data = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(sku.trim())}`);
            const raw = data?.leadTime;
            if (raw == null) return null;
            const n = parseInt(String(raw), 10);
            return isNaN(n) ? null : n;
        } catch {
            return null;
        }
    }

    /**
     * Batch sales velocity for a list of finished-good SKUs.
     * Returns a Map of sku → { dailyRate, stockOnHand, daysOfFinishedStock, openDemandQty }
     * used to augment build risk reports with actual sell-through data.
     *
     * Uses getSalesQty() per SKU with a 90-day lookback, run in parallel (5x concurrency).
     * Never throws — returns an empty Map on any failure.
     */
    async getFinishedGoodVelocity(skus: string[], daysBack: number = 90): Promise<Map<string, {
        dailyRate: number;
        stockOnHand: number | null;
        daysOfFinishedStock: number | null;
        openDemandQty: number;
        stockAvailable: number | null;
    }>> {
        const result = new Map<string, {
            dailyRate: number;
            stockOnHand: number | null;
            daysOfFinishedStock: number | null;
            openDemandQty: number;
            stockAvailable: number | null;
        }>();

        if (skus.length === 0) return result;

        // Run 5 at a time to stay well inside Finale rate limits
        const concurrency = 5;
        const queue = [...skus];
        const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            while (queue.length > 0) {
                const sku = queue.shift()!;
                try {
                    const data = await this.getSalesQty(sku, daysBack);
                    const dailyRate = daysBack > 0 ? data.totalSoldQty / daysBack : 0;
                    // HERMIA(2026-06-12): Use min(stockOnHand, stockAvailable) for
                    // daysOfFinishedStock so FG shelf coverage reflects committed stock.
                    const stockForShelf = data.stockAvailable != null && data.stockOnHand != null && data.stockAvailable < data.stockOnHand
                        ? data.stockAvailable
                        : (data.stockOnHand ?? null);
                    const daysOfFinishedStock =
                        stockForShelf !== null && dailyRate > 0
                            ? Math.round(stockForShelf / dailyRate)
                            : null;
                    result.set(sku, {
                        dailyRate,
                        stockOnHand: data.stockOnHand,
                        daysOfFinishedStock,
                        openDemandQty: data.openDemandQty,
                        // HERMIA(2026-06-12): Carry stockAvailable through so FG coverage
                        // filter can use the lower of stockOnHand and stockAvailable.
                        stockAvailable: data.stockAvailable,
                    });
                } catch {
                    // Non-fatal: skip this SKU
                }
            }
        });
        await Promise.all(workers);
        return result;
    }

    /**
     * Compute median actual lead time per vendor from the last N days of completed POs.
     * Only includes vendors with ≥ 2 completed POs.
     *
     * Also populates `_vendorOnTimeRateCache` (vendors on-time within median + 7d)
     * and `_vendorLeadTimeRawCache` (P50/P90 distribution).
     *
     * Returns Map<vendorName, medianDays>. Never throws — returns empty Map on error.
     */
    /**
     * Vendor on-time arrival rate (0..1). Computed from the same data as
     * lead-time history — a PO is "on-time" if it arrived within the vendor's
     * median + 7d buffer. Fuzzy name match.
     *
     * Returns 1.0 (assume on-time) when no history exists for the vendor, or
     * when the cache is cold (call ensureVendorLeadTimeHistoryWarm() first in
     * any code path that does not go through getPurchasingIntelligence).
     */
    getVendorOnTimeRate(vendorName: string): number {
        if (!vendorName) return 1;
        // If the cache is stale (> 4h), treat as empty — avoids serving very old
        // data in long-running processes between scheduled refreshes.
        if (_vendorOnTimeRateCacheAt > 0 && Date.now() - _vendorOnTimeRateCacheAt > VENDOR_LEAD_TIME_RAW_TTL) {
            return 1;
        }
        const key = vendorName.trim().toLowerCase();
        for (const [cacheKey, rate] of _vendorOnTimeRateCache.entries()) {
            const ck = cacheKey.toLowerCase();
            if (ck === key || ck.includes(key) || key.includes(ck)) return rate;
        }
        return 1;
    }

    /**
     * Expose the full on-time rate cache. Used by lead-time-tracker to persist
     * per-vendor on-time rates to vendor_lead_time_stats.
     */
    getVendorOnTimeRates(): Map<string, number> {
        if (_vendorOnTimeRateCacheAt > 0 && Date.now() - _vendorOnTimeRateCacheAt > VENDOR_LEAD_TIME_RAW_TTL) {
            return new Map();
        }
        return _vendorOnTimeRateCache;
    }

    /**
     * Ensures the vendor lead-time history cache (and the derived on-time rate
     * cache) is warm. No-op when the cache is fresh (< 4h old). Call this before
     * any code path that reads getVendorOnTimeRate() or getVendorLeadTimeDistribution()
     * but does NOT go through getPurchasingIntelligence() first.
     *
     * Example: the Crystal Ball route reads SWR-cached purchasing data and then
     * calls getVendorOnTimeRate() — on a cold process start it would get 1.0 for
     * every vendor without this guard.
     *
     * @param daysBack  Look-back window passed to getVendorLeadTimeHistory(). Defaults to 365.
     */
    async ensureVendorLeadTimeHistoryWarm(daysBack = 365): Promise<void> {
        const cacheAge = _vendorOnTimeRateCacheAt > 0 ? Date.now() - _vendorOnTimeRateCacheAt : Infinity;
        if (cacheAge < VENDOR_LEAD_TIME_RAW_TTL) return; // already fresh — no-op
        // DECISION(2026-05-20): Warm the cache on cold process start so callers like
        // the Crystal Ball route always get real on-time rates, not the 1.0 default.
        // getVendorLeadTimeHistory() is idempotent and handles its own error suppression.
        await this.getVendorLeadTimeHistory(daysBack).catch(() => {});
    }

    getVendorLeadTimeDistribution(): Map<string, { p50: number; p90: number; sampleCount: number }> {
        const out = new Map<string, { p50: number; p90: number; sampleCount: number }>();
        if (!_vendorLeadTimeRawCache) return out;
        if (Date.now() - _vendorLeadTimeRawCacheAt > VENDOR_LEAD_TIME_RAW_TTL) return out;

        for (const [vendor, days] of _vendorLeadTimeRawCache) {
            if (days.length < 3) continue;
            const sorted = [...days].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const p50 = sorted.length % 2 === 0
                ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
                : sorted[mid];
            const p90Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
            const p90 = sorted[p90Index];
            out.set(vendor, { p50, p90, sampleCount: days.length });
        }
        return out;
    }

    /**
     * Expose the party-ID cache populated by getVendorLeadTimeHistory().
     * Used by lead-time-tracker to key stats by canonical party ID.
     */
    getVendorPartyIdMap(): Map<string, string> {
        return _vendorPartyIdCache;
    }

    /**
     * Raw lead-time arrays from the last getVendorLeadTimeHistory() call.
     * Used by lead-time-tracker to compute spread_days (first→last PO span).
     * Empty map when cache is cold or stale (>4h).
     */
    getRawLeadTimeArrays(): Map<string, number[]> {
        if (!_vendorLeadTimeRawCache) return new Map();
        if (Date.now() - _vendorLeadTimeRawCacheAt > VENDOR_LEAD_TIME_RAW_TTL) return new Map();
        return _vendorLeadTimeRawCache;
    }

    /**
     * Per-PO dated entries from the last getVendorLeadTimeHistory() call.
     * Used by lead-time-tracker to compute true temporal spread (calendar days
     * between first and last receiveDate) and recent-30d trend signal.
     * Empty map when cache is cold or stale (>4h).
     */
    getLeadTimeDateEntries(): Map<string, Array<{ receiveDate: string; days: number }>> {
        if (Date.now() - _vendorLeadTimeDateCacheAt > VENDOR_LEAD_TIME_RAW_TTL) return new Map();
        return _vendorLeadTimeDateCache;
    }

    async getVendorLeadTimeHistory(daysBack: number = 365): Promise<Map<string, number>> {
        try {
            const now = new Date();
            const end = new Date(now);
            end.setDate(end.getDate() + 1);
            const begin = new Date(now);
            begin.setDate(begin.getDate() - daysBack);

            const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: 500
                            type: ["PURCHASE_ORDER"]
                            receiveDate: { begin: "${beginStr}", end: "${endStr}" }
                            sort: [{ field: "receiveDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    status
                                    orderDate
                                    receiveDate
                                    supplier { name partyUrl }
                                }
                            }
                        }
                    }
                `
            };

            // Load po_sent_verified_at from Supabase so we can use the verified
            // send timestamp as the lead-time anchor instead of Finale's orderDate
            // (which is the draft-creation time and inflates lead times when POs
            // sit in draft for a day or more before being emailed).
            const { loadPOSentTimestamps, resolveLeadTimeAnchor } = await import('../purchasing/lead-time-enricher');
            // DECISION(2026-05-20): Load sentAtMap with a wider window than daysBack.
            // A PO sent 300 days ago but received 100 days ago would be inside the
            // receiveDate window but outside a 180d sentAt window — the anchor would
            // silently fall back to orderDate. Adding MAX_VENDOR_LEAD_TIME_DAYS (90d)
            // ensures any PO we might receive during this window has its sentAt available.
            const sentAtMap = await loadPOSentTimestamps(daysBack + MAX_VENDOR_LEAD_TIME_DAYS).catch(() => new Map<string, string>());

            const data = await this.graphql(query, 'Vendor Lead Time History');
            const edges = data?.orderViewConnection?.edges || [];
            // Group lead times by vendor
            const byVendor = new Map<string, number[]>();
            const partyIds = new Map<string, string>(); // vendor name → party ID (from same query, zero extra calls)
            const dateEntries = new Map<string, LeadTimePOEntry[]>(); // vendor name → dated PO entries (temporal analysis)
            for (const edge of edges) {
                const po = edge.node;
                if (po.status !== 'Completed') continue;
                if (!po.orderDate || !po.receiveDate) continue;
                const vendor = po.supplier?.name;
                if (!vendor) continue;
                // Capture party ID from same query — used by lead-time-tracker to key stats by party ID.
                const partyUrl: string | undefined = po.supplier?.partyUrl;
                if (partyUrl && !partyIds.has(vendor)) {
                    const pid = partyUrl.split('/').pop();
                    if (pid) partyIds.set(vendor, pid);
                }
                // Use po_sent_verified_at when available — more accurate than Finale's
                // orderDate (which is draft-creation time, not the email-sent time).
                const anchorDate = resolveLeadTimeAnchor(po.orderDate, po.orderId, sentAtMap);
                const orderMs = new Date(anchorDate).getTime();
                const receiveMs = new Date(po.receiveDate).getTime();
                if (isNaN(orderMs) || isNaN(receiveMs)) continue;
                const days = Math.round((receiveMs - orderMs) / 86_400_000);
                if (days < 0 || days > 365) continue; // sanity check
                if (!byVendor.has(vendor)) byVendor.set(vendor, []);
                byVendor.get(vendor)!.push(days);
                // Capture dated entry for temporal analysis (spread_days, dates, recent-30d trend)
                if (!dateEntries.has(vendor)) dateEntries.set(vendor, []);
                dateEntries.get(vendor)!.push({ receiveDate: po.receiveDate, days });
            }

            // Compute median for vendors with ≥ 2 data points (was 3; monthly-cadence
            // vendors had too few POs in the 90d window to qualify).
            const result2 = new Map<string, number>();
            const onTimeMap = new Map<string, number>();
            for (const [vendor, days] of byVendor) {
                if (days.length < 2) continue;
                const sorted = [...days].sort((a, b) => a - b);
                const mid = Math.floor(sorted.length / 2);
                const median = sorted.length % 2 === 0
                    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
                    : sorted[mid];
                result2.set(vendor, median);

                // On-time rate: count POs that arrived within median + 7d buffer.
                const tolerance = median + 7;
                const onTime = days.filter(d => d <= tolerance).length;
                onTimeMap.set(vendor, onTime / days.length);
            }
            // Stash the raw distribution for callers that want P90 — see
            // getVendorLeadTimeDistribution(). Module-level cache because
            // FinaleClient is reinstantiated frequently.
            _vendorLeadTimeRawCache = byVendor;
            _vendorLeadTimeRawCacheAt = Date.now();
            _vendorOnTimeRateCache = onTimeMap;
            _vendorOnTimeRateCacheAt = Date.now();
            _vendorPartyIdCache = partyIds;
            _vendorLeadTimeDateCache = dateEntries;
            _vendorLeadTimeDateCacheAt = Date.now();
            return result2;
        } catch (err: any) {
            console.error('[finale] getVendorLeadTimeHistory error:', err.message);
            return new Map();
        }
    }

    /**
     * Scan ALL active products for external-vendor reorder needs.
     *
     * Triggers (either qualifies):
     *   - Finale's reorderQuantityToOrder > 0  (Finale explicitly recommends ordering)
     *   - stockoutDays < 45 AND consumptionQuantity > 0  (velocity-based detection)
     *
     * Excludes:
     *   - Products with no velocity and no Finale reorder flag
     *   - Products whose primary supplier is BuildASoil-internal (BOM-driven, handled elsewhere)
     *   - Products with no supplier configured
     *
     * Returns items grouped by vendor for easy consolidated PO creation.
     *
     * One full scan ≈ 16 Finale GraphQL pages + ~N REST calls for at-risk products.
     * Should be called once before creating draft POs, not on a hot path.
     */
    async getExternalReorderItems(): Promise<ExternalReorderGroup[]> {
        const PAGE_SIZE = 500;

        // ── Step 1: Paginate productViewConnection for all active products ──
        const atRisk: Array<{
            productId: string;
            stockoutDays: number | null;
            reorderQty: number | null;
            consumptionQty: number;
        }> = [];

        let cursor: string | null = null;
        let pageCount = 0;

        while (true) {
            const afterClause: string = cursor ? `, after: "${cursor}"` : '';
            const query: { query: string } = {
                query: `{
                    productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                        pageInfo { hasNextPage endCursor }
                        edges { node {
                            productId status
                            stockoutDays consumptionQuantity reorderQuantityToOrder
                        }}
                    }
                }`
            };

            const res: Response = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            const json: any = await res.json();
            const conn: any = json.data?.productViewConnection;
            if (!conn) break;

            for (const edge of conn.edges || []) {
                const p = edge.node;
                if (p.status !== 'Active') continue;

                const reorderQty = this.parseFinaleNum(p.reorderQuantityToOrder);
                const stockoutDays = this.parseFinaleNum(p.stockoutDays);
                const consumptionQty = this.parseFinaleNum(p.consumptionQuantity) ?? 0;

                const finaleRecommends = reorderQty !== null && reorderQty > 0;
                const velocityAlert = consumptionQty > 0 && stockoutDays !== null && stockoutDays < 45;

                if (finaleRecommends || velocityAlert) {
                    atRisk.push({ productId: p.productId, stockoutDays, reorderQty, consumptionQty });
                }
            }

            pageCount++;
            if (!conn.pageInfo.hasNextPage) break;
            cursor = conn.pageInfo.endCursor;
        }

        console.log(`[finale] getExternalReorderItems: scanned ${pageCount} pages, ${atRisk.length} at-risk products`);

        if (atRisk.length === 0) return [];

        // ── Step 2: Resolve supplier for each at-risk product (batched, 5x concurrency) ──
        // Uses module-level _partyCacheShared (TTL 1h, 200-entry cap) so concurrent
        // scans with getPurchasingIntelligence() share partygroup lookups.
        // isDropship: fulfilled direct-to-customer — no BAS reorder needed
        //   (Autopot, Printful, Grand Master, HLG, Evergreen, AC Infinity)
        const resolveParty = async (partyId: string): Promise<{ groupName: string; isManufactured: boolean; isDropship: boolean }> => {
            const cached = _partyCacheShared.get(partyId);
            if (cached && Date.now() - cached.ts < PARTY_CACHE_TTL) {
                return { groupName: cached.groupName, isManufactured: cached.isManufactured, isDropship: cached.isDropship };
            }
            try {
                const res = await fetch(`${this.apiBase}/${this.accountPath}/api/partygroup/${partyId}`, {
                    headers: { Authorization: this.authHeader, Accept: 'application/json' },
                });
                const data = await res.json();
                const groupName: string = data.groupName || data.name || 'Unknown';
                const isManufactured = groupName.toLowerCase().includes('buildasoil') ||
                    groupName.toLowerCase().includes('manufacturing') ||
                    groupName.toLowerCase().includes('soil dept') ||
                    groupName.toLowerCase().includes('bas soil');
                const isDropship = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i.test(groupName);
                const result = { groupName, isManufactured, isDropship };
                if (_partyCacheShared.size >= PARTY_CACHE_MAX) {
                    const oldestKey = _partyCacheShared.keys().next().value;
                    if (oldestKey !== undefined) _partyCacheShared.delete(oldestKey);
                }
                _partyCacheShared.set(partyId, { ...result, ts: Date.now() });
                return result;
            } catch {
                return { groupName: 'Unknown', isManufactured: false, isDropship: false };
            }
        };

        interface RichItem {
            productId: string;
            stockoutDays: number | null;
            reorderQty: number | null;
            consumptionQty: number;
            supplierPartyId: string | null;
            supplierName: string;
            unitPrice: number;
            isManufactured: boolean;
            isDropship: boolean;
            orderIncrementQty: number | null;
            isBulkDelivery: boolean;
        }

        const richItems: RichItem[] = [];
        const queue = [...atRisk];

        await Promise.all(Array.from({ length: 5 }, async () => {
            while (queue.length > 0) {
                const item = queue.shift()!;
                try {
                    const prodRes = await fetch(
                        `${this.apiBase}/${this.accountPath}/api/product/${encodeURIComponent(item.productId)}`,
                        { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
                    );
                    const prod = await prodRes.json();
                    const suppliers: any[] = prod.supplierList || [];
                    const mainSupplier = suppliers.find(s => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];

                    if (!mainSupplier?.supplierPartyUrl) {
                        // No supplier configured — skip (can't create a PO without a vendor)
                        continue;
                    }

                    // DECISION(2026-03-04): Skip products flagged "Do not reorder" in Finale.
                    // Checks multiple possible locations for this flag:
                    //   - reorderPointPolicy field (e.g. "DO_NOT_REORDER")
                    //   - doNotReorder boolean field
                    //   - Product name/description containing "do not reorder"
                    if (FinaleProductsClient.isDoNotReorder(prod)) {
                        continue;
                    }

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop();
                    const party = await resolveParty(partyId);

                    richItems.push({
                        ...item,
                        supplierPartyId: partyId,
                        supplierName: party.groupName,
                        unitPrice: mainSupplier.price ?? 0,
                        isManufactured: party.isManufactured,
                        isDropship: party.isDropship,
                        // DECISION(2026-03-04): Extract order increment qty from REST product data.
                        // Finale stores this as "orderIncrementQuantity" — the "Std reorder in qty of" field.
                        // Falls back to null if not set, meaning no rounding is applied.
                        orderIncrementQty: this.parseFinaleNum(prod.orderIncrementQuantity),
                        isBulkDelivery: FinaleProductsClient.isBulkDelivery(prod),
                    });
                } catch {
                    // Skip products we can't resolve
                }
            }
        }));

        // ── Step 3: Filter to external, non-dropship vendors only, group by supplier ──
        const external = richItems.filter(i => !i.isManufactured && !i.isDropship && i.supplierPartyId);
        const byVendor = new Map<string, RichItem[]>();
        for (const item of external) {
            const key = item.supplierPartyId!;
            if (!byVendor.has(key)) byVendor.set(key, []);
            byVendor.get(key)!.push(item);
        }

        const groups: ExternalReorderGroup[] = [];
        for (const [partyId, items] of byVendor) {
            const urgency = items.some(i => i.stockoutDays !== null && i.stockoutDays < 14) ? 'critical'
                : items.some(i => i.stockoutDays !== null && i.stockoutDays < 45) ? 'warning'
                    : 'reorder_flagged';

            groups.push({
                vendorName: items[0].supplierName,
                vendorPartyId: partyId,
                urgency,
                items: items.sort((a, b) => (a.stockoutDays ?? 999) - (b.stockoutDays ?? 999)),
            });
        }

        return groups.sort((a, b) => {
            const rank = { critical: 0, warning: 1, reorder_flagged: 2 };
            return rank[a.urgency] - rank[b.urgency];
        });
    }

    /**
     * Create a draft purchase order in Finale for human review and commit.
     *
     * Created with statusId=ORDER_CREATED (visible in Finale as "Draft/Open").
     * The human commits it in Finale UI by clicking the commit/lock button.
     *
     * DECISION(2026-03-04): Enhanced with Purchase Destination and order increment support.
     *   - `originFacilityUrl` routes receiving to either Shipping (default) or Soil (bulk).
     *   - Bulk detection auto-infers Soil when any item is flagged as bulk delivery.
     *   - Order quantities snap UP to the product's "Std reorder in qty of" increment.
     *   - Override via `purchaseDestination` param takes priority over auto-detection.
     *
     * @param vendorPartyId       Finale partyId of the supplier
     * @param items               Line items — now supports optional orderIncrementQty and isBulkDelivery per item
     * @param memo                Optional memo/notes for the PO
     * @param purchaseDestination Override: "Shipping" | "Soil" (case-insensitive). If omitted, auto-detects.
     * @returns                   { orderId, finaleUrl, facilityName } of the created draft
     */
    async createDraftPurchaseOrder(
        vendorPartyId: string,
        items: Array<{
            productId: string;
            quantity: number;
            unitPrice: number;
            orderIncrementQty?: number | null;
            isBulkDelivery?: boolean;
        }>,
        memo?: string,
        purchaseDestination?: string
    ): Promise<{
        orderId: string;
        finaleUrl: string;
        facilityName: string;
        duplicateWarnings: string[];
        priceAlerts: string[];
        expectedDelivery: import('../purchasing/po-verification').ExpectedDelivery;
        verification: import('../purchasing/po-verification').DraftVerification;
    }> {
        const today = new Date().toISOString().split('T')[0] + 'T00:00:00';

        // ── Step 0: Duplicate PO detection ──────────────────────────────────
        // DECISION(2026-03-04): Check for existing open/committed POs from the same
        // vendor with overlapping SKUs. We warn but still create — the caller decides.
        const duplicateWarnings: string[] = [];
        const productIds = items.map(i => i.productId);
        const activeDrafts = await (this as any).findActiveDraftPOsForVendor(vendorPartyId);
        if (activeDrafts.length > 0) {
            const existing = activeDrafts[0];
            console.log(`[finale] createDraftPurchaseOrder: reusing active draft PO #${existing.orderId} for vendor ${vendorPartyId}`);

            for (const item of items) {
                const exists = await this.validateProductExists(item.productId);
                if (!exists) {
                    throw new Error(
                        `Product "${item.productId}" not found in Finale. ` +
                        `Cannot reuse draft PO with unlinked products. ` +
                        `Verify the SKU exists in Finale before retrying.`
                    );
                }
            }

            return (this as any).reuseExistingDraftPurchaseOrder(existing.orderId, items);
        }
        let dups: Array<{ orderId: string; status: string; orderDate: string; overlappingSKUs: string[]; finaleUrl: string }> = [];
        try {
            dups = await this.checkDuplicatePOs(vendorPartyId, productIds);
            for (const dup of dups) {
                const skuList = dup.overlappingSKUs.slice(0, 3).join(', ');
                const more = dup.overlappingSKUs.length > 3 ? ` +${dup.overlappingSKUs.length - 3} more` : '';
                duplicateWarnings.push(
                    `⚠️ PO #${dup.orderId} (${dup.status}) already has: ${skuList}${more}`
                );
            }
        } catch (e: any) {
            console.warn('[finale] Duplicate check failed (non-blocking):', e.message);
        }

        // ── Step 0b: Price change detection ─────────────────────────────────
        // DECISION(2026-03-04): Flag SKUs with >=10% price change vs last PO.
        const priceAlerts: string[] = [];
        try {
            for (const item of items) {
                if (!item.unitPrice || item.unitPrice <= 0) continue;
                const change = await this.checkPriceChange(item.productId, item.unitPrice);
                if (change) {
                    const direction = change.changePct > 0 ? '📈' : '📉';
                    priceAlerts.push(
                        `${direction} ${change.productId}: $${change.previousPrice.toFixed(2)} → $${change.currentPrice.toFixed(2)} (${change.changePct > 0 ? '+' : ''}${change.changePct}% since PO #${change.lastPOId})`
                    );
                }
            }
        } catch (e: any) {
            console.warn('[finale] Price check failed (non-blocking):', e.message);
        }

        // ── Step 0.5: Pre-validate all product SKUs exist in Finale ──────────
        // DECISION(2026-03-23): Finale silently accepts POs with invalid productUrls,
        // creating line items with no product linked. Pre-validate to fail fast.
        for (const item of items) {
            const exists = await this.validateProductExists(item.productId);
            if (!exists) {
                throw new Error(
                    `Product "${item.productId}" not found in Finale. ` +
                    `Cannot create PO with unlinked products. ` +
                    `Verify the SKU exists in Finale before retrying.`
                );
            }
        }

        // ── Step 1: Snap quantities to order increments ──────────────────────
        const adjustedItems = items.map(item => {
            const rawQty = item.quantity;
            const snapped = FinaleProductsClient.snapToIncrement(rawQty, item.orderIncrementQty ?? null);

            if (snapped !== rawQty) {
                console.log(`[finale] PO qty snap: ${item.productId}: ${rawQty} → ${snapped} (increment: ${item.orderIncrementQty})`);
            }

            return {
                productUrl: `/${this.accountPath}/api/product/${encodeURIComponent(item.productId)}`,
                quantity: snapped,
                unitPrice: item.unitPrice,
            };
        });

        // ── Step 2: Resolve Purchase Destination (facility) ──────────────────
        // Priority: explicit override > auto-detect bulk > default Shipping
        let facilityName = 'Shipping';
        let facilityUrl: string | null = null;

        if (purchaseDestination) {
            // Explicit override from caller
            facilityName = purchaseDestination;
            facilityUrl = await this.getFacilityUrl(purchaseDestination);
        } else {
            // Auto-detect: if ANY item in this PO is bulk, route to Soil
            const hasBulk = items.some(item => item.isBulkDelivery === true);
            if (hasBulk) {
                facilityName = 'Soil';
                facilityUrl = await this.getFacilityUrl('Soil');
            } else {
                facilityUrl = await this.getFacilityUrl('Shipping');
            }
        }

        // ── Step 3: Build PO payload ─────────────────────────────────────────
        // DECISION(2026-03-19): Set dueDate to today + 14 days as default expected
        // arrival. This populates the expected arrival date directly on the PO in
        // Finale — calendar sync, OOS reports, and ordering UI all read this field.
        // Vendor actual lead time may differ; Will can adjust in Finale if needed.
        const dueDate14d = new Date();
        dueDate14d.setDate(dueDate14d.getDate() + 14);
        const dueDateStr = dueDate14d.toISOString().split('T')[0] + 'T00:00:00';

        const payload: Record<string, any> = {
            orderTypeId: 'PURCHASE_ORDER',
            statusId: 'ORDER_CREATED',
            orderDate: today,
            dueDate: dueDateStr,
            orderRoleList: [{ roleTypeId: 'SUPPLIER', partyId: vendorPartyId }],
            orderItemList: adjustedItems,
        };

        // Set the Purchase Destination if we resolved a valid facility URL
        if (facilityUrl) {
            payload.destinationFacilityUrl = facilityUrl;
        }

        // DECISION(2026-03-23): Do not set privateNotes on POs.
        // Internal memos create noise in Finale's PO records.
        // The memo parameter is retained in the method signature for
        // structured logging but is no longer written to the PO.

        const res = await fetch(`${this.apiBase}/${this.accountPath}/api/order`, {
            method: 'POST',
            headers: {
                Authorization: this.authHeader,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Finale PO creation failed (${res.status}): ${body.slice(0, 200)}`);
        }

        const data = await res.json();
        const orderId = data.orderId;
        if (!orderId) throw new Error('Finale returned no orderId');

        // ── Post-creation verification: ensure all products are linked ──────
        // DECISION(2026-03-23): Finale silently drops product linkage when the
        // productUrl doesn't resolve internally (even if pre-validation passed).
        // Verify and auto-cancel if any line items are missing products.
        const createdItems = data.orderItemList || [];
        const unlinkedItems = createdItems.filter((i: any) => !i.productUrl);
        if (unlinkedItems.length > 0) {
            console.error(`[finale] ⚠️ PO #${orderId}: ${unlinkedItems.length}/${createdItems.length} items have no product linked — cancelling PO`);
            try {
                await fetch(`${this.apiBase}/${this.accountPath}/api/order/${orderId}`, {
                    method: 'PUT',
                    headers: {
                        Authorization: this.authHeader,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ statusId: 'ORDER_CANCELLED' }),
                });
                console.log(`[finale] Auto-cancelled broken PO #${orderId}`);
            } catch (cancelErr: any) {
                console.error(`[finale] Failed to auto-cancel PO #${orderId}:`, cancelErr.message);
            }
            throw new Error(
                `PO #${orderId} created but ${unlinkedItems.length} products failed to link. ` +
                `PO auto-cancelled. Check that all SKUs exist in Finale.`
            );
        }

        // Build the human-readable Finale URL (same base64 pattern used throughout client.ts)
        const finaleUrl = (this as any).buildFinaleOrderUrl(data.orderUrl, orderId);

        console.log(`[finale] createDraftPurchaseOrder: created PO #${orderId} for party ${vendorPartyId} (${items.length} items) → ${facilityName}${facilityUrl ? '' : ' (facility URL not found)'}`);
        if (duplicateWarnings.length > 0) console.log(`[finale] Duplicate warnings: ${duplicateWarnings.join(' | ')}`);
        if (priceAlerts.length > 0) console.log(`[finale] Price alerts: ${priceAlerts.join(' | ')}`);

        // Phase 3a — write reservations so the next purchasing scan does not
        // double-order the same SKUs while this draft is still open.
        // Best-effort; reservation failure must not block PO creation.
        try {
            const { recordReservations: _recordReservations } = await import("@/lib/purchasing/calibration");
            await _recordReservations(
                orderId,
                vendorPartyId,
                items.map(i => ({ productId: i.productId, qty: i.quantity })),
            );
        } catch (err: any) {
            console.warn(`[finale] reservation write failed for PO #${orderId}: ${err.message}`);
        }

        // Phase C — stamp the most recent recommendation per (vendor, SKU) with the
        // draft PO number so the dashboard ribbon can show "Aria recommended N → drafted as M".
        // Best-effort; calibration matching falls back to fuzzy receive-time match if this skips.
        try {
            const { stampRecommendationsWithDraftPO: _stamp } = await import("@/lib/purchasing/calibration");
            await _stamp(
                orderId,
                items.map(i => ({
                    productId: i.productId,
                    vendorPartyId,
                    draftedQty: i.quantity,
                })),
            );
        } catch (err: any) {
            console.warn(`[finale] rec-stamp write failed for PO #${orderId}: ${err.message}`);
        }

        // Post-create verification + expected delivery lookup (best-effort)
        const { expectedDelivery, verification } = await (this as any).verifyDraftAndExpectedDelivery(
            orderId,
            vendorPartyId,
            items,
        );

        await this.recordAxiomDraftLifecycleIfApplicable(orderId, vendorPartyId, items);

        return { orderId, finaleUrl, facilityName, duplicateWarnings, priceAlerts, expectedDelivery, verification };
    }

    protected async recordAxiomDraftLifecycleIfApplicable(
        orderId: string,
        vendorPartyId: string | null | undefined,
        items: Array<{ productId: string; quantity: number; unitPrice?: number | null }>,
    ): Promise<void> {
        if (!vendorPartyId || items.length === 0) return;

        try {
            const partyId = vendorPartyId.split('/').pop() || vendorPartyId;
            const partyUrl = `/${this.accountPath}/api/partygroup/${encodeURIComponent(partyId)}`;
            const vendorName = await this.resolvePartyName(partyUrl);
            const { recordAxiomDraftPOCreated, isAxiomVendorName } = await import("@/lib/axiom/lifecycle");

            if (!isAxiomVendorName(vendorName)) return;

            await recordAxiomDraftPOCreated({
                poNumber: orderId,
                vendorName,
                vendorPartyId: partyId,
                items: items.map(item => ({
                    productId: item.productId,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice ?? null,
                })),
            });
        } catch (err: any) {
            console.warn(`[finale] Axiom lifecycle trigger failed for PO #${orderId}: ${err?.message ?? err}`);
        }
    }

    /**
     * Combines purchase history, sales history, and committed open POs into a single
     * GraphQL request using field aliases. Replaces three separate calls
     * (getPurchasedQty + getSalesQty + findCommittedPOsForProduct) used by
     * getPurchasingIntelligence, requesting only the fields that method needs.
     *
     * purchasedIn / soldIn  — date-windowed velocity signals
     * committedPOs          — all-time open supply (no date filter; Committed = always current)
     */
    async getProductActivity(sku: string, daysBack: number): Promise<{
        purchasedQty: number;
        soldQty: number;
        openPOs: Array<{ orderId: string; quantity: number; orderDate: string; dueDate: string | null }>;
        stockOnHand: number | null;
        stockAvailable: number | null;
        lastPurchaseDate: string | null;
        firstPurchaseDate: string | null;
        purchaseCount: number;
        purchaseDates: string[];
        purchaseQtys: number[];
    }> {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 1);
        const beginDate = new Date(now);
        beginDate.setDate(beginDate.getDate() - daysBack);

        const beginStr = beginDate.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const productUrl = `/${this.accountPath}/api/product/${sku}`;

        const query = {
            query: `query {
                purchasedIn: orderViewConnection(
                    first: 100
                    type: ["PURCHASE_ORDER"]
                    product: ["${productUrl}"]
                    orderDate: { begin: "${beginStr}", end: "${endStr}" }
                    sort: [{ field: "orderDate", mode: "desc" }]
                ) {
                    edges { node {
                        status
                        orderDate
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
                        orderId status orderDate dueDate
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

        try {
            const data = await this.graphql(query, `Product Activity ${sku}`);

            let purchasedQty = 0;
            let lastPurchaseDate: string | null = null;
            let firstPurchaseDate: string | null = null;
            let purchaseCount = 0;
            const purchaseDates: string[] = [];
            const purchaseQtys: number[] = [];
            for (const edge of data?.purchasedIn?.edges || []) {
                const po = edge.node;
                if (po.status !== 'Completed') continue;
                if (!lastPurchaseDate && po.orderDate) {
                    lastPurchaseDate = po.orderDate;
                }
                if (po.orderDate) firstPurchaseDate = po.orderDate; // edges are desc; last seen = earliest
                for (const ie of po.itemList?.edges || []) {
                    if (ie.node.product?.productId === sku) {
                        const lineQty = parseFinaleNumber(ie.node.quantity);
                        purchasedQty += lineQty;
                        purchaseCount += 1;
                        if (po.orderDate) purchaseDates.push(po.orderDate);
                        if (lineQty > 0) purchaseQtys.push(lineQty);
                        break;
                    }
                }
            }

            let soldQty = 0;
            for (const edge of data?.soldIn?.edges || []) {
                const so = edge.node;
                if (so.status !== 'Completed' && so.status !== 'Shipped') continue;
                for (const ie of so.itemList?.edges || []) {
                    if (ie.node.product?.productId === sku) {
                        soldQty += parseFinaleNumber(ie.node.quantity);
                        break;
                    }
                }
            }

            const openPOs: Array<{ orderId: string; quantity: number; orderDate: string; dueDate: string | null }> = [];
            for (const edge of data?.committedPOs?.edges || []) {
                const po = edge.node;
                if (po.status !== 'Committed' && po.status !== 'Locked') continue;
                for (const ie of po.itemList?.edges || []) {
                    if (ie.node.product?.productId === sku) {
                        const toIsoDate = (d: unknown): string | null => {
                            if (!d || typeof d !== 'string') return null;
                            const parsed = new Date(d);
                            // Finale returns "M/D/YYYY" or ISO — normalize to YYYY-MM-DD
                            return isNaN(parsed.getTime()) ? null
                                : parsed.toISOString().split('T')[0];
                        };
                        openPOs.push({
                            orderId: po.orderId,
                            quantity: parseFinaleNumber(ie.node.quantity),
                            orderDate: po.orderDate || '',
                            dueDate: toIsoDate(po.dueDate),
                        });
                        break;
                    }
                }
            }

            const stockNode = data?.stockInfo?.edges?.[0]?.node;
            const stockOnHand = this.parseFinaleNum(stockNode?.stockOnHand)
                ?? this.parseFinaleNum(stockNode?.unitsInStock);
            return {
                purchasedQty,
                soldQty,
                openPOs,
                stockOnHand,
                stockAvailable: this.parseFinaleNum(stockNode?.stockAvailable),
                lastPurchaseDate,
                firstPurchaseDate,
                purchaseCount,
                purchaseDates,
                purchaseQtys,
            };
        } catch (err: any) {
            console.error(`[finale] getProductActivity error for ${sku}:`, err.message);
            return { purchasedQty: 0, soldQty: 0, openPOs: [] as Array<{ orderId: string; quantity: number; orderDate: string; dueDate: string | null }>, stockOnHand: null, stockAvailable: null, lastPurchaseDate: null, firstPurchaseDate: null, purchaseCount: 0, purchaseDates: [], purchaseQtys: [] };
        }
    }

    /**
     * Scan all active products with consumption history and compute velocity-based
     * purchasing intelligence from raw receipt/shipment data.
     *
     * Unlike getExternalReorderItems(), this method:
     *   - Uses purchase receipt history (not Finale's unreliable reorderQuantityToOrder)
     *   - Uses shipment history as a second velocity signal
     *   - Fetches REST stock levels (GraphQL stockOnHand = "--" for most products)
     *   - Computes runway, adjusted runway (with open POs), and urgency independently
     *   - Generates natural language explanations per item
     *
     * @param daysBack  Lookback window for velocity calculation (default: 90 days)
     */
    /**
     * Demand-driven BOM component purchasing pipeline.
     *
     * 1. Page active SKUs (productViewConnection)
     * 2. For each active SKU: getBillOfMaterials → if non-empty, treat as FG candidate
     * 3. For FG candidates with sales in window: collect (sku, name, dailySalesRate, bom)
     * 4. Explode burn rates per component (computeComponentBurnRates)
     * 5. For each component: REST product GET → stock, supplier; resolve vendor;
     *    leadTimeService.getForVendor(); classify urgency
     * 6. Group by vendor, sort worst-first
     *
     * Returns PurchasingGroup[] where every item has itemType='bom-component'.
     * Caching is the route's responsibility (same pattern as getPurchasingIntelligence).
     *
     * v1 simplification: pages all Active products and BOM-checks each one. Most
     * Active SKUs have no BOM, so this wastes ~1 product GET per non-FG SKU. The
     * 30-min route cache absorbs the cost. v2 should narrow the candidate set
     * via a productAssocList GraphQL filter or a sales-velocity prefilter.
     */
    async getBOMDemand(daysBack = 90): Promise<PurchasingGroup[]> {
        const { computeComponentBurnRates, chooseBomVelocity, computeReceiptConfidence, computeMedianPOGap, classifyBomUrgency, projectNextOrderDate, applyCommonOrderRounding, computeTrendAdjustedVelocity } = await import('./bom-demand');
        const { loadStockoutCounts, recordStockoutEvent } = await import('@/lib/purchasing/stockout-history');
        const { readForwardDemand } = await import('@/lib/purchasing/forward-demand');
        type FGVelocity = import('./bom-demand').FGVelocity;

        // ── Step 1: Page Active SKUs ──
        const PAGE_SIZE = 500;
        let cursor: string | null = null;
        const activeSkus: string[] = [];

        while (true) {
            const afterClause = cursor ? `, after: "${cursor}"` : '';
            const body = {
                query: `{
                    productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                        pageInfo { hasNextPage endCursor }
                        edges { node { productId status } }
                    }
                }`
            };
            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json: any = await res.json();
            const conn = json.data?.productViewConnection;
            if (!conn) break;
            for (const edge of conn.edges || []) {
                if (edge.node.status === 'Active') activeSkus.push(edge.node.productId);
            }
            if (!conn.pageInfo.hasNextPage) break;
            cursor = conn.pageInfo.endCursor;
        }

        // ── Step 2-3: Find FG candidates (have BOM + have sales) ──
        const fgVelocities: FGVelocity[] = [];
        const skuQueue = [...activeSkus];

        await Promise.all(Array.from({ length: 3 }, async () => {
            while (skuQueue.length > 0) {
                const sku = skuQueue.shift()!;
                // Skip SKUs we've already proven have no BOM (saves ~80% of
                // network roundtrips on warm scans).
                if (_skuHasNoBomCache.has(sku)) continue;
                try {
                    const bom = await this.getBillOfMaterials(sku);
                    if (bom.length === 0) {
                        _skuHasNoBomCache.add(sku);
                        continue; // not an FG
                    }

                    const activity = await this.getProductActivity(sku, daysBack);
                    const dailySalesRate = activity.soldQty / daysBack;

                    // DECISION(2026-05-12): Don't gate on FG sales rate. Components
                    // surface based on their own receipt velocity (primary signal),
                    // so build-ahead/contract FGs that never show retail sales still
                    // contribute via their components' historical purchasing.
                    const prodData = await this.get(
                        `/${this.accountPath}/api/product/${encodeURIComponent(sku)}`
                    );
                    const name: string = prodData.internalName || prodData.productId || sku;
                    fgVelocities.push({ sku, name, dailySalesRate, bom });
                } catch (err: any) {
                    console.error(`[bom-demand] FG ${sku} failed:`, err.message);
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }));

        if (fgVelocities.length === 0) return [];

        // ── Step 4: Burn rates ──
        const componentDemands = computeComponentBurnRates(fgVelocities);

        // Load 180-day stockout counts up front so each component loop iteration
        // can read in O(1) and pad its lead time accordingly.
        const stockoutCounts = await loadStockoutCounts();
        // Forward-demand snapshot from the calendar BOM pipeline (LLM-cached
        // separately, refreshes every 4h). Cold cache returns empty — that's
        // fine; the next scan picks up the calendar lift.
        const forwardDemand = readForwardDemand(30);

        // Pre-load vendor reorder policies once (small table, <50 rows) so the
        // per-component loop can read in O(1). Fixes the bug where BOM components
        // from long-lead-time vendors (e.g., Colorful Packaging — 60d lead, 180d
        // cover target) were being suggested with hardcoded 60d cover regardless
        // of the vendor_reorder_policies configuration.
        const bomVendorPolicies = await loadAllVendorReorderPolicies();

        // ── Step 5: Resolve each component (stock, vendor, lead time, urgency) ──
        const { leadTimeService } = await import('@/lib/builds/lead-time-service');
        const items: PurchasingItem[] = [];
        const componentQueue = Array.from(componentDemands.entries());

        await Promise.all(Array.from({ length: 3 }, async () => {
            while (componentQueue.length > 0) {
                const [compSku, demand] = componentQueue.shift()!;
                // Win #2: Skip components that have permanently 404'd this process lifetime.
                if (_bomComponent404Cache.has(compSku)) continue;
                try {
                    // Win #1: Fire REST product details + GraphQL activity in parallel —
                    // both target the same compSku, so cut wall-clock per component ~in half.
                    // Finale REST returns "--" for stockOnHand on every product —
                    // GraphQL productViewConnection (via getProductActivity) is the only
                    // reliable source. getProductActivity also gives us open POs for free.
                    // 2026-05-14: wrap REST product fetch with the 404-list-cache
                    // fallback. Finale's /api/product/{sku} 404s for ~50 valid
                    // SKUs (QUE215BAG, PLQ102, WDG101, etc); the bulk
                    // /api/product list has them with full supplier info.
                    // Without this wrap those components were silently dropped
                    // from Purchasing Intelligence with noisy error logs.
                    const fetchProdDataWith404Fallback = async () => {
                        try {
                            return await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(compSku)}`);
                        } catch (e: any) {
                            if (typeof e?.message === "string" && /Finale API 404\b/.test(e.message)) {
                                const synthetic = await this.lookupProductFromListCache(compSku);
                                if (synthetic) return synthetic;
                            }
                            throw e;
                        }
                    };
                    const [prodData, compActivity] = await Promise.all([
                        fetchProdDataWith404Fallback(),
                        this.getProductActivity(compSku, daysBack),
                    ]);
                    if (FinaleProductsClient.isDoNotReorder(prodData)) continue;

                    const suppliers: any[] = prodData.supplierList || [];
                    const mainSupplier = suppliers.find((s: any) =>
                        s.supplierPrefOrderId?.includes('MAIN')
                    ) || suppliers[0];
                    if (!mainSupplier?.supplierPartyUrl) continue;

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                    let groupName = 'Unknown';
                    try {
                        const partyRes = await fetch(
                            `${this.apiBase}/${this.accountPath}/api/partygroup/${partyId}`,
                            { headers: { Authorization: this.authHeader, Accept: 'application/json' } }
                        );
                        const partyData = await partyRes.json();
                        groupName = partyData.groupName || partyData.name || 'Unknown';
                    } catch { /* keep Unknown */ }

                    if (EXCLUDED_VENDOR_PATTERN.test(groupName)) continue;

                    // ── VENDOR POLICY LOOKUP (BOM pipeline) ───────────────────
                    // Pre-loaded once before the loop; zero-cost per component.
                    // Drives lead-time override (e.g., Colorful Packaging 60d) and
                    // cover target (e.g., Colorful 4-6 month supply = 180d).
                    const bomPolicy = bomVendorPolicies.get(partyId) ?? null;

                    const rawStockOnHand = compActivity.stockOnHand ?? 0;
                    const finaleAvailable = compActivity.stockAvailable;
                    const committedQty = (finaleAvailable != null && rawStockOnHand > finaleAvailable)
                        ? rawStockOnHand - finaleAvailable
                        : 0;
                    const effectiveStock = finaleAvailable != null && finaleAvailable < rawStockOnHand
                        ? finaleAvailable
                        : rawStockOnHand;
                    if (committedQty > 0) {
                        console.log(`[purchasing] BOM ${compSku}: stockAvailable=${finaleAvailable} < stockOnHand=${rawStockOnHand} — committed=${committedQty.toFixed(2)} — using effectiveStock=${effectiveStock.toFixed(2)}`);
                    }
                    // Keep raw value for display purposes downstream
                    const stockOnHand = rawStockOnHand;

                    // HERMIA(2026-06-10): Enrich open POs with delivery reliability data.
                    // Stuck/unacknowledged/overdue POs don't count toward on-order coverage.
                    const bomEnrichedPOs: OpenPOReliable[] = compActivity.openPOs.length > 0
                        ? await enrichOpenPOs(compActivity.openPOs)
                        : [];
                    const rawStockOnOrder = deliverableStockOnOrder(bomEnrichedPOs);
                    // Discount deliverable stockOnOrder by the vendor's historical on-time rate.
                    // 100% on-time → no discount. 60% on-time → trust only 60% of
                    // DELIVERABLE open POs as supply we'll have when we need it.
                    const onTimeRate = this.getVendorOnTimeRate(groupName);
                    const stockOnOrder = rawStockOnOrder * onTimeRate;

                    const lt = await leadTimeService.getForVendor(groupName, compSku);
                    const baseLeadTimeDays = lt.days;
                    // Pad lead time for SKUs with prior stockouts — they proved the
                    // default buffer wasn't enough. 1 event → 1.5×, 2 → 2.0×, 3+ → 2.5×.
                    const { leadTimeMultiplierFromStockouts } = await import('@/lib/purchasing/stockout-history');
                    const priorStockouts = stockoutCounts.get(compSku)?.eventCount ?? 0;
                    const stockoutMultiplier = leadTimeMultiplierFromStockouts(priorStockouts);
                    const leadTimeDays = Math.ceil(baseLeadTimeDays * stockoutMultiplier);
                    // Policy override: take explicit Will-set lead time over Finale's
                    // lead-time service. Stockout multiplier NOT applied to overrides —
                    // the override is the ground-truth build/ship time Bill knows.
                    const effectiveLeadTimeDays = bomPolicy?.leadTimeOverrideDays ?? leadTimeDays;
                    const leadTimeProvenance = bomPolicy?.leadTimeOverrideDays
                        ? `${effectiveLeadTimeDays}d vendor policy override (was ${leadTimeDays}d ${lt.label})`
                        : priorStockouts > 0
                            ? `${leadTimeDays}d (${lt.label.replace(/^\d+d /, '')} × ${stockoutMultiplier.toFixed(1)} for ${priorStockouts} prior stockout${priorStockouts === 1 ? '' : 's'})`
                            : lt.label;

                    // DECISION(2026-05-12): Receipt velocity is the primary signal.
                    // Captures seasonality, builds, contracts, wholesale, growth —
                    // everything the FG-sales-derived burn rate misses. FG-derived
                    // demand is the fallback for components with no purchase history.
                    // Trend-adjusted: if recent half is materially higher than prior
                    // half, use the recent rate so growing SKUs aren't understated.
                    const trend = computeTrendAdjustedVelocity({
                        purchaseDates: compActivity.purchaseDates,
                        purchaseQtys: compActivity.purchaseQtys,
                        daysBack,
                    });
                    const receiptVelocity = trend.velocity;
                    const bomDerivedVelocity = demand.totalBurnRate;
                    const chosen = chooseBomVelocity({ receiptVelocity, bomDerivedVelocity });
                    const confidence = chosen.source === 'receipts'
                        ? computeReceiptConfidence({
                            purchaseCount: compActivity.purchaseCount,
                            firstPurchaseDate: compActivity.firstPurchaseDate,
                            lastPurchaseDate: compActivity.lastPurchaseDate,
                        })
                        : 'medium';
                    const dailyBurn = chosen.value;
                    if (dailyBurn <= 0) continue; // nothing to order — no receipts AND no FG demand

                    const runwayDays = dailyBurn > 0 ? effectiveStock / dailyBurn : 9999;
                    const adjustedRunwayDays = dailyBurn > 0
                        ? (effectiveStock + stockOnOrder) / dailyBurn
                        : 9999;
                    const medianPOGapDays = computeMedianPOGap(compActivity.purchaseDates);

                    // Forward-demand bump: if upcoming calendar builds will consume
                    // more than (effectiveStock + stockOnOrder), that's a hard shortfall
                    // — bump urgency regardless of historical-velocity math.
                    const forward = forwardDemand.get(compSku);
                    const forwardShortfall = forward
                        ? Math.max(0, forward.requiredQty - (effectiveStock + stockOnOrder))
                        : 0;

                    let urgency = classifyBomUrgency({
                        adjustedRunwayDays,
                        leadTimeDays: effectiveLeadTimeDays,
                        medianPOGapDays,
                    });
                    if (forwardShortfall > 0) {
                        // Days until earliest build that needs this component
                        const buildMs = forward ? new Date(forward.earliestBuildDate).getTime() - Date.now() : Infinity;
                        const buildDays = buildMs / 86_400_000;
                        // HERMIA(2026-06-01): Guard forward-demand critical bump.
                        // Previously any shortfall + build within lead time forced critical,
                        // even when the item had 1028d or 1920d of runway. A BOM explosion
                        // for a year of builds shouldn't override "we have 3 years of stock."
                        // Rule: force critical ONLY if runway is genuinely short (< leadTime × 3),
                        // so items with plenty of normal-velocity stock stay in planning buckets.
                        const runwayCap = effectiveLeadTimeDays * 3;
                        if (buildDays < effectiveLeadTimeDays && adjustedRunwayDays < runwayCap) urgency = 'critical';
                        else if (forwardShortfall > 0 && (urgency === 'ok' || urgency === 'watch')) urgency = 'warning';
                    }
                    const projectedNextOrderDate = projectNextOrderDate({
                        stockOnHand: effectiveStock,
                        stockOnOrder,
                        dailyBurn,
                        leadTimeDays: effectiveLeadTimeDays,
                    });

                    // Record stockout event if adjusted runway dropped below lead time
                    // (this is the "we're already late ordering" condition). Idempotent
                    // per SKU per day. Fire-and-forget — don't block the scan.
                    if (adjustedRunwayDays < effectiveLeadTimeDays && dailyBurn > 0) {
                        void recordStockoutEvent({
                            productId: compSku,
                            vendorPartyId: partyId || null,
                            stockOnHand: effectiveStock,
                            stockOnOrder,
                            dailyBurn,
                            runwayDays: adjustedRunwayDays,
                            leadTimeDays: effectiveLeadTimeDays,
                        });
                    }

                    // buildsWorth approximation: batch ≈ dailySalesRate*30. Phase 2 derives
                    // real batch sizes from production receipt history.
                    const feedsFinishedGoods = demand.feedsFinishedGoods.map(fg => {
                        const batchSize = fg.dailySalesRate * 30;
                        const buildsWorth = batchSize > 0 && fg.qtyPerUnit > 0
                            ? effectiveStock / (fg.qtyPerUnit * batchSize)
                            : 0;
                        return {
                            sku: fg.sku,
                            name: fg.name,
                            dailySalesRate: fg.dailySalesRate,
                            buildsWorth: Math.round(buildsWorth * 10) / 10,
                        };
                    });

                    // ── COVER DAYS: vendor policy override or default 60 ────────
                    // Default 60d covers most domestic vendors (lead + 30-45d safety).
                    // Long-lead-time overseas vendors (Colorful Packaging — 60d build/ship,
                    // target 4-6 month supply) override via vendor_reorder_policies.target_cover_days.
                    const coverDays = bomPolicy?.targetCoverDays ?? 60;
                    const baseNeed = Math.max(
                        0,
                        Math.ceil(dailyBurn * coverDays - effectiveStock)
                    );
                    // Floor the suggestion at the forward shortfall — we have to
                    // cover scheduled builds first, then add coverage cushion.
                    // HERMIA(2026-06-01): Cap forward shortfall influence at 180d of supply.
                    // BOM explosions for annual builds produce absurd shortfalls
                    // (e.g., 2.8M units = 24 years of rice bran). The build schedule
                    // should drive ordering cadence, not total coverage in one PO.
                    const MAX_COVERAGE_DAYS = 180;
                    const cappedShortfall = dailyBurn > 0
                        ? Math.min(forwardShortfall, dailyBurn * MAX_COVERAGE_DAYS)
                        : forwardShortfall;
                    const rawSuggestedQty = Math.max(baseNeed, cappedShortfall);
                    const rounded = applyCommonOrderRounding({
                        rawSuggestedQty,
                        purchaseQtys: compActivity.purchaseQtys,
                    });
                    const suggestedQty = rounded.suggestedQty;

                    const cadenceLabel = medianPOGapDays
                        ? `~${Math.round(medianPOGapDays)}d cadence`
                        : `${compActivity.purchaseCount} PO${compActivity.purchaseCount === 1 ? '' : 's'}`;
                    const trendLabel = trend.trendingUp && chosen.source === 'receipts'
                        ? ` ↑ trending up`
                        : trend.trendingDown && chosen.source === 'receipts'
                            ? ` ↓ trending down`
                            : '';
                    const onTimeLabel = onTimeRate < 0.85 && rawStockOnOrder > 0
                        ? ` On-order discounted ${Math.round((1 - onTimeRate) * 100)}% (vendor late ${Math.round((1 - onTimeRate) * 100)}% historically).`
                        : '';
                    const forwardLabel = forward && forwardShortfall > 0
                        ? ` 📅 Build ${forward.earliestBuildDate} needs ${forward.requiredQty} (${forwardShortfall} short).`
                        : forward
                            ? ` 📅 Covers build ${forward.earliestBuildDate} (need ${forward.requiredQty}).`
                            : '';
                    const sourceLabel = chosen.source === 'receipts'
                        ? `${dailyBurn.toFixed(2)}/d from receipts (${cadenceLabel}, ${confidence} confidence)${trendLabel}`
                        : `${dailyBurn.toFixed(2)}/d from FG sales × BOM`;
                    const roundingLabel = rounded.commonOrderQty != null
                        ? rounded.rationale === 'mode'
                            ? ` Rounded up to your usual order of ${rounded.commonOrderQty} (raw need ${rounded.rawSuggestedQty}).`
                            : rounded.rationale === 'median'
                                ? ` Rounded up to median order of ${rounded.commonOrderQty} (raw need ${rounded.rawSuggestedQty}).`
                                : ` Last order was ${rounded.commonOrderQty}; matched up (raw need ${rounded.rawSuggestedQty}).`
                        : '';

                    items.push({
                        productId: compSku,
                        productName: prodData.internalName || compSku,
                        supplierName: groupName,
                        supplierPartyId: partyId,
                        unitPrice: mainSupplier.unitPrice ?? mainSupplier.price ?? 0,
                        stockOnHand,
                        stockOnOrder,
                        purchaseVelocity: receiptVelocity,
                        salesVelocity: 0,
                        demandVelocity: bomDerivedVelocity,
                        dailyRate: dailyBurn,
                        dailyRateSource: chosen.source === 'none' ? undefined : chosen.source,
                        runwayDays: Math.round(runwayDays * 10) / 10,
                        adjustedRunwayDays: Math.round(adjustedRunwayDays * 10) / 10,
                        leadTimeDays: effectiveLeadTimeDays,
                        leadTimeProvenance,
                        openPOs: compActivity.openPOs,
                        urgency,
                        explanation:
                            `BOM component — ${sourceLabel}. ${Math.round(runwayDays)}d runway across ` +
                            `${demand.feedsFinishedGoods.length} FGs.${roundingLabel}${onTimeLabel}${forwardLabel}`,
                        suggestedQty,
                        orderIncrementQty: prodData.orderIncrementQuantity ?? null,
                        isBulkDelivery: true, // BOM materials route to production facility
                        finaleReorderQty: null,
                        finaleStockoutDays: null,
                        finaleConsumptionQty: null,
                        finaleDemandQty: null,
                        itemType: 'bom-component',
                        feedsFinishedGoods,
                        totalBurnRate: dailyBurn,
                        stockAvailable: compActivity.stockAvailable ?? stockOnHand,
                        forwardDemandEntry: forward ? {
                            requiredQty: forward.requiredQty,
                            earliestBuildDate: forward.earliestBuildDate,
                            feedsBuilds: forward.feedsBuilds
                        } : undefined,
                        medianPOGapDays: medianPOGapDays ?? undefined,
                        projectedNextOrderDate,
                        receiptConfidence: chosen.source === 'receipts' ? confidence : undefined,
                        roundingMethod: rounded.commonOrderQty != null ? 'historical' : null,
                        roundingAlternatives: rounded.commonOrderQty != null && rounded.rawSuggestedQty !== rounded.suggestedQty
                            ? [rounded.rawSuggestedQty]
                            : undefined,
                        // Per-row trigger reason — priority order: build > stockout > runway > cadence.
                        triggerReason: forwardShortfall > 0
                            ? 'build-driven'
                            : stockoutMultiplier > 1
                                ? 'stockout-padded'
                                : adjustedRunwayDays < baseLeadTimeDays
                                    ? 'runway-short'
                                    : urgency === 'critical' || urgency === 'warning'
                                        ? 'cadence'
                                        : null,
                        triggerDetail: forwardShortfall > 0 && forward
                            ? `Build ${forward.earliestBuildDate}: need ${forward.requiredQty.toLocaleString()}, ${forwardShortfall.toLocaleString()} short`
                            : stockoutMultiplier > 1
                                ? `Lead time padded ×${stockoutMultiplier.toFixed(1)} (${priorStockouts} prior stockout${priorStockouts === 1 ? '' : 's'})`
                                : adjustedRunwayDays < baseLeadTimeDays
                                    ? `${Math.round(adjustedRunwayDays)}d runway < ${baseLeadTimeDays}d lead time`
                                    : medianPOGapDays
                                        ? `Due in ~${Math.round(adjustedRunwayDays - baseLeadTimeDays)}d (${Math.round(medianPOGapDays)}d cadence)`
                                        : undefined,
                        // Why-drawer provenance for the BOM row.
                        recommendation: {
                            formulaVersion: 'bom-v3-2026-05-12',
                            coverDays,
                            rawNeededEaches: rounded.rawSuggestedQty,
                            provenance: [
                                {
                                    step: 'Daily burn',
                                    detail: chosen.source === 'receipts'
                                        ? `${dailyBurn.toFixed(2)}/d from receipts · ${compActivity.purchaseCount} POs · ${confidence} confidence${trend.trendingUp ? ' · trending up' : trend.trendingDown ? ' · trending down (using recent half-window rate)' : ''}`
                                        : `${dailyBurn.toFixed(2)}/d from FG sales × BOM`,
                                    value: dailyBurn,
                                },
                                {
                                    step: 'Lead time',
                                    detail: leadTimeProvenance,
                                    value: effectiveLeadTimeDays,
                                },
                                ...(forward ? [{
                                    step: 'Calendar build',
                                    detail: `Earliest build ${forward.earliestBuildDate} consumes ${forward.requiredQty.toLocaleString()}; shortfall ${forwardShortfall.toLocaleString()}`,
                                    value: forward.requiredQty,
                                }] : []),
                                ...(onTimeRate < 1 ? [{
                                    step: 'Vendor on-time',
                                    detail: `${Math.round(onTimeRate * 100)}% historical on-time rate · on-order discounted to ${stockOnOrder.toLocaleString()}`,
                                    value: onTimeRate,
                                }] : []),
                                {
                                    step: 'Cover days target',
                                    detail: `${coverDays}d`,
                                    value: coverDays,
                                },
                                {
                                    step: 'Raw need',
                                    detail: `ceil(${dailyBurn.toFixed(2)} × ${coverDays} − ${stockOnHand.toLocaleString()}) = ${rounded.rawSuggestedQty.toLocaleString()}`,
                                    value: rounded.rawSuggestedQty,
                                },
                                ...(rounded.commonOrderQty != null ? [{
                                    step: 'Cognitive rounding',
                                    detail: `${rounded.rationale === 'mode' ? 'Mode' : rounded.rationale === 'median' ? 'Median' : 'Last order'} ${rounded.commonOrderQty.toLocaleString()} from past POs → ${rounded.suggestedQty.toLocaleString()}`,
                                    value: rounded.suggestedQty,
                                }] : []),
                            ],
                        },
                    });
                } catch (err: any) {
                    // Win #2: Cache clean-404s so we skip them next call this process lifetime.
                    // Match `Finale API 404:` from get() / getProductActivity. Don't poison
                    // on 5xx / network errors — those are transient.
                    if (typeof err?.message === 'string' && /Finale API 404\b/.test(err.message)) {
                        _bomComponent404Cache.add(compSku);
                    }
                    console.error(`[bom-demand] component ${compSku} failed:`, err.message);
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }));

        // ── Step 6: Group by vendor, worst-urgency-first ──
        const urgencyRank = { critical: 0, warning: 1, watch: 2, ok: 3 } as const;
        const vendorMap = new Map<string, PurchasingGroup>();
        for (const item of items) {
            const existing = vendorMap.get(item.supplierPartyId);
            if (existing) {
                existing.items.push(item);
                if (urgencyRank[item.urgency] < urgencyRank[existing.urgency]) {
                    existing.urgency = item.urgency;
                }
            } else {
                vendorMap.set(item.supplierPartyId, {
                    vendorName: item.supplierName,
                    vendorPartyId: item.supplierPartyId,
                    urgency: item.urgency,
                    items: [item],
                });
            }
        }
        return Array.from(vendorMap.values()).sort((a, b) => {
            const ud = urgencyRank[a.urgency] - urgencyRank[b.urgency];
            return ud !== 0 ? ud : a.vendorName.localeCompare(b.vendorName);
        });
    }

    async getPurchasingIntelligence(daysBack = 365, vendorFilter?: string | null): Promise<PurchasingGroup[]> {
        const PAGE_SIZE = 500;
        const normalizedVendorFilter = vendorFilter?.trim().toLowerCase() || "";

        // ── Step 1: Page productViewConnection — presence signal only ──
        // v2.7 (2026-06-11): Broadened candidate admission. Previously only
        // Finale-flagged reorder qty admitted a SKU. Now also admits any
        // product with measurable demand — Aria's engine evaluates it and
        // downstream filters (party resolution, DNR, dailyRate===0,
        // hasDeliverablePO) prune noise. Catches SKUs like RMC103 that
        // Finale's native engine silently drops on low-volume items.
        const candidates: Array<{ productId: string, finaleReorderQty: number | null, finaleStockoutDays: number | null, finaleConsumptionQty: number | null, finaleDemandQty: number | null, finaleDemandPerDay: number | null }> = [];
        const failedProductIds: string[] = [];

        if (normalizedVendorFilter) {
            const externalGroups = await this.getExternalReorderItems();
            const vendorCandidates = externalGroups
                .filter(group => group.vendorName.toLowerCase().includes(normalizedVendorFilter))
                .flatMap(group => group.items.map(item => ({
                    productId: item.productId,
                    finaleReorderQty: item.reorderQty,
                    finaleStockoutDays: item.stockoutDays,
                    finaleConsumptionQty: item.consumptionQty,
                    finaleDemandQty: null,
                    finaleDemandPerDay: null,
                })));
            const deduped = new Map<string, typeof vendorCandidates[number]>();
            for (const candidate of vendorCandidates) {
                deduped.set(candidate.productId, candidate);
            }
            candidates.push(...deduped.values());
            console.log(`[finale] getPurchasingIntelligence: vendor filter "${vendorFilter}" seeded ${candidates.length} candidates`);
        } else {
            let cursor: string | null = null;

            while (true) {
                const afterClause: string = cursor ? `, after: "${cursor}"` : '';
                const query: { query: string } = {
                    query: `{
                        productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                            pageInfo { hasNextPage endCursor }
                            edges { node { productId status consumptionQuantity reorderQuantityToOrder stockoutDays demandQuantity demandPerDay } }
                        }
                    }`
                };

                const res: Response = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                    method: 'POST',
                    headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                    body: JSON.stringify(query),
                });
                const json: any = await res.json();
                const conn: any = json.data?.productViewConnection;
                if (!conn) break;

                for (const edge of conn.edges || []) {
                    const p = edge.node;
                    if (p.status !== 'Active') continue;
                    const consumption = this.parseFinaleNum(p.consumptionQuantity);
                    const reorderQty = this.parseFinaleNum(p.reorderQuantityToOrder);
                    const stockoutDays = this.parseFinaleNum(p.stockoutDays);
                    const demandQty = this.parseFinaleNum(p.demandQuantity);
                    const demandPerDay = this.parseFinaleNum(p.demandPerDay);
                    const candidate = {
                        productId: p.productId,
                        finaleReorderQty: reorderQty,
                        finaleStockoutDays: stockoutDays,
                        finaleConsumptionQty: consumption,
                        finaleDemandQty: demandQty,
                        finaleDemandPerDay: demandPerDay,
                    };
                    if (shouldIncludePurchasingCandidate(candidate)) {
                        candidates.push(candidate);
                    } else {
                        // Track failures for second-pass ariaPOHistory check
                        failedProductIds.push(p.productId);
                    }
                }

                if (!conn.pageInfo.hasNextPage) break;
                cursor = conn.pageInfo.endCursor;
                }

                // ── Second pass STUB ──────────────────────────────────────────
                // TODO(aria-2026-06-11): revive products that Finale drops silently
                // but have strong PO history in our purchase_orders table.
                // Requires batchLoadAriaPurchaseHistory() — not yet implemented.
                // Keeping failedProductIds collected for when the function lands.
                if (failedProductIds.length > 0) {
                    console.log(`[finale] getPurchasingIntelligence: ${failedProductIds.length} products failed Finale gate (second-pass revival not wired yet)`);
                }
                // ── End second pass stub ──────────────────────────────────────
            }

        console.log(`[finale] getPurchasingIntelligence: ${candidates.length} candidates found`);
        if (candidates.length === 0) return [];

        // Load pack-size registry for all candidates in one batch
        const packSizeMap = await getPackSizes(candidates.map(c => c.productId));
        console.log(`[finale] getPurchasingIntelligence: ${packSizeMap.size} pack-size records loaded`);

        // ── Phase 2/3 cross-cutting loads — best-effort, parallel ──
        // We don't have vendorPartyIds at this stage (party resolution happens
        // per-SKU in the worker loop), so calibration + MOQ are loaded lazily
        // inside the loop using a memo. Reservations are keyed on productId,
        // which we DO have, so we batch-load them up front.
        const productIds = candidates.map(c => c.productId);
        const [reservationsMap] = await Promise.all([
            loadActiveReservations(productIds),
            leadTimeService.warmCache(),
        ]);
        const calibrationCache = new Map<string, Awaited<ReturnType<typeof loadCalibrationStats>> extends Map<string, infer V> ? V : never>();
        const moqCache = new Map<string, Awaited<ReturnType<typeof loadVendorMOQs>> extends Map<string, infer V> ? V : never>();
        const reorderPolicyCache = new Map<string, VendorReorderPolicy>();
        // v2.2 — last 8 completed PO line qtys per vendor, used by cognitive
        // rounding to detect favorite-batch clusters.
        const recentLineQtysCache = new Map<string, number[]>();
        const seenVendorIds = new Set<string>();
        const recommendationSnapshots: RecommendationSnapshot[] = [];
        // DECISION(2026-05-21): vendorLegsCache maps vendorPartyId → (poNumber → ShipmentLeg[]).
        // Populated lazily on first-encounter per vendor (same pattern as calibration/MOQ caches).
        // Used to credit only legs landing in the reorder horizon for bulk vendors (isBulkVendor).
        // Non-bulk vendors never touch this cache — zero behavioral change for standard vendors.
        const vendorLegsCache = new Map<string, Map<string, ShipmentLeg[]>>();

        // ── Step 2-8: 5x concurrent workers per candidate SKU ──
        // Vendors excluded from purchasing intelligence:
        //   isManufactured : internal BAS production depts
        //   isDropship     : fulfilled direct by vendor — no BAS reorder needed
        //                    (Autopot, Printful, Grand Master, HLG, Evergreen, AC Infinity)
        // Uses module-level _partyCacheShared (TTL 1h, 200-entry cap) so concurrent
        // scans with getExternalReorderItems() share partygroup lookups.

        const resolveParty = async (partyUrl: string): Promise<{ groupName: string; isManufactured: boolean; isDropship: boolean }> => {
            const partyId = partyUrl.split('/').pop() || '';
            const cached = _partyCacheShared.get(partyId);
            if (cached && Date.now() - cached.ts < PARTY_CACHE_TTL) {
                return { groupName: cached.groupName, isManufactured: cached.isManufactured, isDropship: cached.isDropship };
            }
            try {
                const r = await fetch(`${this.apiBase}/${this.accountPath}/api/partygroup/${partyId}`, {
                    headers: { Authorization: this.authHeader, Accept: 'application/json' },
                });
                const data = await r.json();
                const groupName: string = data.groupName || data.name || 'Unknown';
                const isManufactured = /buildasoil|manufacturing|soil dept|bas soil/i.test(groupName);
                const isDropship = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i.test(groupName);
                const result = { groupName, isManufactured, isDropship };
                if (_partyCacheShared.size >= PARTY_CACHE_MAX) {
                    const oldestKey = _partyCacheShared.keys().next().value;
                    if (oldestKey !== undefined) _partyCacheShared.delete(oldestKey);
                }
                _partyCacheShared.set(partyId, { ...result, ts: Date.now() });
                return result;
            } catch {
                return { groupName: 'Unknown', isManufactured: false, isDropship: false };
            }
        };

        const urgencyRank = { critical: 0, warning: 1, watch: 2, ok: 3 };
        const items: PurchasingItem[] = [];
        const queue = [...candidates];

        const { readForwardDemand } = await import('@/lib/purchasing/forward-demand');
        const forwardDemand = readForwardDemand(30);
        // DECISION(2026-05-20): Import recordStockoutEvent here (same lazy-import
        // pattern as getBOMDemand) so resale-path near-stockouts are also tracked.
        // Before this, only BOM components accumulated stockout_events history.
        const { recordStockoutEvent: recordResaleStockout } = await import('@/lib/purchasing/stockout-history');

        // 3 workers: keeps peak concurrency at ~3 simultaneous Finale requests.
        // 100ms inter-SKU pause spreads load to ~180 calls/min sustained — well within limits.
        await Promise.all(Array.from({ length: 3 }, async () => {
            while (queue.length > 0) {
                const candidate = queue.shift()!;
                const sku = candidate.productId;
                try {
                    // Step A: REST product data first — need supplier URL to check exclusions
                    // before spending any GraphQL calls on manufactured/dropship vendors.
                    const prodData = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(sku)}`);
                    const suppliers: any[] = prodData.supplierList || [];
                    const mainSupplier = suppliers.find(s => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
                    if (!mainSupplier?.supplierPartyUrl) continue;

                    // Step B: Resolve supplier and check exclusions (_partyCacheShared keeps this fast after first hit)
                    const party = await resolveParty(mainSupplier.supplierPartyUrl);
                    if (party.isManufactured || party.isDropship) continue;

                    // Skip products flagged "Do not reorder" in Finale
                    if (FinaleProductsClient.isDoNotReorder(prodData)) continue;

                    // Step C: Single combined GraphQL request — purchase history + sales history + open POs
                    const activity = await this.getProductActivity(sku, daysBack);

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                    const productName: string = prodData.internalName || prodData.productId || sku;
                    const unitPrice: number = mainSupplier.price ?? 0;
                    const reorderMethod = normalizeFinaleReorderMethod(prodData);

                    // Lead time: REST product field → 14d default
                    const rawLeadTime = prodData.leadTime != null ? parseInt(String(prodData.leadTime), 10) : NaN;
                    const leadTimeDays = !isNaN(rawLeadTime) && rawLeadTime > 0 ? rawLeadTime : 14;
                    const leadTimeProvenance = !isNaN(rawLeadTime) && rawLeadTime > 0
                        ? `${rawLeadTime}d (Finale)`
                        : '14d default';

                    // DECISION(2026-03-16): Use GraphQL stock from getProductActivity().
                    const restStock = this.parseFinaleNum(prodData.quantityOnHand ?? prodData.stockLevel ?? null);
                    const stockOnHand = activity.stockOnHand ?? restStock;

                    // HERMIA(2026-06-10): Enrich open POs with Supabase lifecycle data so
                    // we can distinguish "in transit" POs from stuck/unacknowledged ones.
                    // Only DELIVERABLE POs should remove a SKU from Ordering.
                    const enrichedOpenPOs: OpenPOReliable[] = activity.openPOs.length > 0
                        ? await enrichOpenPOs(activity.openPOs)
                        : [];
                    const stuckPOs = enrichedOpenPOs.filter(po => !po.isDeliverable);
                    if (stuckPOs.length > 0) {
                        const stuckSummary = stuckPOs.map(po =>
                            `${po.orderId}(${po.stuckReason}/${po.ageDays}d)`,
                        ).join(", ");
                        console.log(`[purchasing] ${sku}: ${stuckPOs.length} stuck PO(s) — ${stuckSummary} — SKU remains orderable`);
                    }

                    // Open PO supply — ONLY count deliverable POs toward coverage.
                    // Bulk vendor effective value is recomputed below after policy lookup.
                    const rawStockOnOrder = deliverableStockOnOrder(enrichedOpenPOs);

                    // DECISION(2026-06-10, Will + Hermia): a PO only exits this SKU from
                    // Ordering when it's genuinely deliverable — sent, with ack/tracking
                    // or movement evidence. Stuck/unacknowledged/overdue POs do NOT count;
                    // the SKU stays in the Ordering panel so Will can reorder if needed.
                    if (hasDeliverablePO(enrichedOpenPOs)) continue;

                    // Step 4: velocity + runway
                    const purchaseVelocity = activity.purchasedQty / daysBack;
                    const salesVelocity = activity.soldQty / daysBack;

                    // Demand velocity: prefer demandPerDay (direct field) → demandQuantity / 90
                    const demandVelocity = candidate.finaleDemandPerDay != null && candidate.finaleDemandPerDay > 0
                        ? candidate.finaleDemandPerDay
                        : candidate.finaleDemandQty != null && candidate.finaleDemandQty > 0
                            ? candidate.finaleDemandQty / 90
                            : 0;

                    // DECISION(2026-03-31): Prefer demandVelocity over purchaseVelocity.
                    // We fall back to purchaseVelocity via chooseVelocitySignal BOM→receipts fallback
                    // (handles items where Finale doesn't track BOM consumption in demandVelocity).
                    const chosenVelocity = chooseVelocitySignal({
                        reorderMethod,
                        demandVelocity,
                        salesVelocity,
                        purchaseVelocity,
                        consumptionQty: candidate.finaleConsumptionQty,
                    });
                    let dailyRate = chosenVelocity.dailyRate;
                    let rateSource: PurchasingItem["dailyRateSource"] | "none" = chosenVelocity.signal;

                    if (dailyRate === 0) continue; // no actual movement within windows


                    // Identify which signal is driving the rate (for explanation)
                    const rateSourceLabel = rateSource === "demand"
                        ? "90d demand"
                        : rateSource === "sales"
                            ? `${daysBack}d sales`
                            : `${daysBack}d receipts`;

                    // HERMIA(2026-06-12): Use Finale's stockAvailable (stockOnHand minus
                    // committed) when it's meaningfully lower than raw stockOnHand. This
                    // kills the phantom-runway bug on slow-velocity items: PPD201 had
                    // 4.18 on-hand but 4.55 committed to builds → effective remaining =
                    // -0.37, yet the recommender saw 83 days of runway. stockAvailable
                    // reflects quantity already allocated to open work orders / sales
                    // orders — units that aren't actually available to fulfill new demand.
                    const rawStockOnHand = stockOnHand ?? 0;
                    const finaleAvailable = activity.stockAvailable;
                    const committedQty = (finaleAvailable != null && rawStockOnHand > finaleAvailable)
                        ? rawStockOnHand - finaleAvailable
                        : 0;
                    const effectiveStock = finaleAvailable != null && finaleAvailable < rawStockOnHand
                        ? finaleAvailable
                        : rawStockOnHand;
                    if (committedQty > 0) {
                        console.log(`[purchasing] ${sku}: stockAvailable=${finaleAvailable} < stockOnHand=${rawStockOnHand} — committed=${committedQty.toFixed(2)} — using effectiveStock=${effectiveStock.toFixed(2)}`);
                    }
                    if (effectiveStock === 0 && stockOnHand === null) {
                        console.warn(`[finale] getPurchasingIntelligence: no stock data for ${sku}, skipping`);
                        continue;
                    }

                    const orderIncrementQty = this.parseFinaleNum(prodData.orderIncrementQuantity);

                    // ── Phase 2/3/v2.2 lookups: calibration, MOQ, vendor policy, recent line qtys ──
                    if (!seenVendorIds.has(partyId)) {
                        seenVendorIds.add(partyId);
                        const [calMap, moqMap, policyMap, recentQtys, poLegsMap] = await Promise.all([
                            loadCalibrationStats([partyId]),
                            loadVendorMOQs([partyId]),
                            loadVendorReorderPolicies([partyId]),
                            loadVendorRecentLineQtys(this.authHeader, this.apiBase, this.accountPath, partyId, 8),
                            // Load shipment legs for all open POs from this vendor in one Supabase call.
                            // Only used when isBulkVendor = true; harmless no-op for standard vendors.
                            loadShipmentLegs(activity.openPOs.map(p => p.orderId)),
                        ]);
                        const cal = calMap.get(partyId);
                        if (cal) calibrationCache.set(partyId, cal);
                        const moq = moqMap.get(partyId);
                        if (moq) moqCache.set(partyId, moq);
                        const policy = policyMap.get(partyId);
                        if (policy) reorderPolicyCache.set(partyId, policy);
                        recentLineQtysCache.set(partyId, recentQtys);
                        vendorLegsCache.set(partyId, poLegsMap);
                    }
                    const calibration = calibrationCache.get(partyId);
                    const moq = moqCache.get(partyId);
                    const reorderPolicy = reorderPolicyCache.get(partyId);
                    const reservation = reservationsMap.get(sku);
                    const distribution = await leadTimeService.getDistribution(party.groupName);
                    const forward = forwardDemand.get(sku);

                    // v2.1 — vendor policy lead-time override flows through both the
                    // recommender input AND the surfaced item.leadTimeProvenance so the
                    // dashboard "Why X?" drawer reflects what the recommender actually used.
                    const effectiveLeadTimeDays = reorderPolicy?.leadTimeOverrideDays ?? leadTimeDays;
                    const effectiveLeadTimeProvenance = reorderPolicy?.leadTimeOverrideDays
                        ? `${reorderPolicy.leadTimeOverrideDays}d vendor policy override`
                        : leadTimeProvenance;
                    // DECISION(2026-05-21): Leg-aware stock-on-order for bulk vendors.
                    // For vendors with isBulkVendor=true and explicit po_shipment_legs rows,
                    // credit only legs arriving within the reorder horizon instead of the full
                    // PO quantity. This prevents the recommender from believing 120,000 units
                    // of CWP101 (Covico) are all available tomorrow when they arrive in 3 trucks
                    // over 90 days. For non-bulk vendors, behavior is identical to before.
                    const horizonDays = (reorderPolicy?.leadTimeOverrideDays ?? leadTimeDays) + 60;
                    const horizonDate = new Date(Date.now() + horizonDays * 86400000).toISOString().slice(0, 10);
                    const vendorPoLegs = vendorLegsCache.get(partyId);

                    const stockOnOrder = (() => {
                        if (!reorderPolicy?.isBulkVendor) {
                            // Standard path: full PO qty credited immediately — unchanged.
                            return rawStockOnOrder;
                        }
                        // Bulk path: credit received qty + pending legs landing inside horizon.
                        // Fall back to full PO qty for any PO that has no leg records yet
                        // (prevents under-crediting when legs haven't been entered yet).
                        let credited = 0;
                        for (const po of activity.openPOs) {
                            const legs = vendorPoLegs?.get(po.orderId);
                            if (!legs || legs.length === 0) {
                                // No legs registered — fall back to full qty (safe over-credit
                                // is better than triggering a false reorder recommendation).
                                credited += po.quantity;
                            } else {
                                const receivedQty    = legs.reduce((s, l) => s + (l.receivedQty ?? 0), 0);
                                const pendingCredit  = legs
                                    .filter(l => !l.actualDate && l.expectedDate <= horizonDate)
                                    .reduce((s, l) => s + l.expectedQty, 0);
                                credited += receivedQty + pendingCredit;
                            }
                        }
                        return credited;
                    })();

                    // All reorder math runs through the pure recommender so every
                    // qty, runway, and urgency comes with an auditable trace the
                    // dashboard can render in a "Why X?" drawer.
                    const recInputs = {
                        sku,
                        vendorName: party.groupName,
                        dailyRate,
                        dailyRateSource: rateSource,
                        dailyRateLabel: rateSourceLabel,
                        velocityInflated: chosenVelocity.inflated,
                        velocityRawRate: chosenVelocity.rawRate,
                        velocityRealityCap: chosenVelocity.realityCap,
                        stockOnHand: effectiveStock,
                        stockOnOrder,
                        openPOCount: activity.openPOs.length,
                        leadTimeDays: effectiveLeadTimeDays,
                        leadTimeProvenance: effectiveLeadTimeProvenance,
                        leadTimeP90: distribution?.p90 ?? null,
                        coverBufferDays: 30,
                        orderIncrementQty,
                        safetyMultiplier: calibration?.safetyMultiplier ?? 1,
                        calibrationSampleCount: calibration?.sampleCount ?? 0,
                        calibrationMedianErrorPct: calibration?.medianErrorPct ?? null,
                        reservedQty: reservation?.qty ?? 0,
                        reservedDraftPOs: reservation?.draftPONumbers ?? [],
                        minimumOrderEaches: moq?.minimumOrderEaches ?? null,
                        minimumOrderDollars: moq?.minimumOrderDollars ?? null,
                        unitPrice,
                        // v2.1 — vendor policy
                        leadTimeOverrideDays: reorderPolicy?.leadTimeOverrideDays ?? null,
                        targetCoverDays: reorderPolicy?.targetCoverDays ?? null,
                        moqMode: reorderPolicy?.moqMode ?? "enforce",
                        overbuyReviewPct: reorderPolicy?.overbuyReviewPct ?? 50,
                        overbuyReviewDollars: reorderPolicy?.overbuyReviewDollars ?? 1000,
                        // v2.2 — cognitive rounding inputs
                        historicalLineQtys: recentLineQtysCache.get(partyId) ?? [],
                        favoriteBatches: reorderPolicy?.favoriteBatches ?? null,
                        // v2.4 — actual quantity ordered last time for exact SKU deviation check
                        lastPurchaseQty: activity.purchaseQtys[0] ?? null,
                        // v2.6 — full SKU purchase history for consistent-pattern floor detection
                        skuPurchaseHistory: activity.purchaseQtys.length > 1 ? activity.purchaseQtys : undefined,
                        // v2.6 — explicit vendor standard order qty override
                        standardOrderQty: reorderPolicy?.standardOrderQty ?? null,
                    } as const;
                    const rec = recommendQty(recInputs);

                    if (rec.suggestedQty > 0) {
                        recommendationSnapshots.push({
                            productId: sku,
                            vendorPartyId: partyId,
                            vendorName: party.groupName,
                            formulaVersion: rec.formulaVersion,
                            recommendedQty: rec.suggestedQty,
                            finaleReorderQty: candidate.finaleReorderQty,
                            inputs: recInputs as Record<string, any>,
                            provenance: rec.provenance as Array<Record<string, any>>,
                        });
                    }

                    const runwayDays = rec.runwayDays;
                    const adjustedRunwayDays = rec.adjustedRunwayDays;
                    let urgency = rec.urgency;
                    const explanation = rec.explanation;
                    const suggestedQty = rec.suggestedQty;

                    // Record stockout event if adjusted runway dropped below lead time.
                    // Idempotent per SKU per day via upsert on (product_id, detected_on).
                    // Fire-and-forget — never blocks the scan.
                    if (adjustedRunwayDays < effectiveLeadTimeDays && dailyRate > 0) {
                        void recordResaleStockout({
                            productId: sku,
                            vendorPartyId: partyId || null,
                            stockOnHand: effectiveStock,
                            stockOnOrder,
                            dailyBurn: dailyRate,
                            runwayDays: adjustedRunwayDays,
                            leadTimeDays: effectiveLeadTimeDays,
                        });
                    }

                    // HERMIA(2026-06-12): Forward-demand shortfall urgency bump for resale
                    // items. If upcoming calendar builds will consume more than
                    // (effectiveStock + stockOnOrder), that's a hard shortfall — force
                    // critical urgency. Same pattern as BOM path at line ~2243. Catches
                    // projected-but-yet-uncommitted demand that Finale's stockAvailable
                    // may not include yet. Guarded: only bumps when runway is genuinely
                    // short (< 3× lead time) so items with plenty of stock stay green.
                    if (forward) {
                        const forwardShortfall = Math.max(0, forward.requiredQty - (effectiveStock + stockOnOrder));
                        if (forwardShortfall > 0) {
                            const buildMs = new Date(forward.earliestBuildDate).getTime() - Date.now();
                            const buildDays = buildMs / 86_400_000;
                            const runwayCap = effectiveLeadTimeDays * 3;
                            if (buildDays < effectiveLeadTimeDays && adjustedRunwayDays < runwayCap) {
                                urgency = 'critical';
                                console.log(`[purchasing] ${sku}: forward-demand shortfall=${forwardShortfall.toFixed(1)} (needs ${forward.requiredQty}, has ${effectiveStock + stockOnOrder}) — build in ${buildDays.toFixed(0)}d — forcing critical`);
                            } else if (urgency === 'ok' || urgency === 'watch') {
                                urgency = 'warning';
                            }
                        }
                    }

                    // Qty divergence: compare our velocity-based suggestion vs Finale's reorderQuantityToOrder
                    const finaleReorderQty = candidate.finaleReorderQty;
                    let qtyDiverged: boolean | undefined;
                    let qtyDivergencePct: number | undefined;
                    if (finaleReorderQty && finaleReorderQty > 0 && suggestedQty > 0) {
                        qtyDivergencePct = Math.round(((suggestedQty - finaleReorderQty) / finaleReorderQty) * 100);
                        qtyDiverged = Math.abs(qtyDivergencePct) > 20;
                    }

                    // Pack-size context from canonical registry
                    const packSizeRec = packSizeMap.get(sku);
                    const packSize = packSizeRec
                        ? { unitsPerPack: packSizeRec.unitsPerPack, packUnit: packSizeRec.packUnit }
                        : undefined;

                    // Bulk delivery detection for facility routing
                    const isBulkDelivery = FinaleProductsClient.isBulkDelivery(prodData);

                    items.push({
                        productId: sku,
                        productName,
                        supplierName: party.groupName,
                        supplierPartyId: partyId,
                        unitPrice,
                        stockOnHand: stockOnHand as number,  // guaranteed non-null — we skip above if null
                        stockOnOrder,
                        purchaseVelocity,
                        salesVelocity,
                        demandVelocity,
                        dailyRate,
                        runwayDays,
                        adjustedRunwayDays,
                        leadTimeDays: effectiveLeadTimeDays,
                        leadTimeProvenance: effectiveLeadTimeProvenance,
                        openPOs: activity.openPOs.map(po => ({
                            orderId: po.orderId,
                            quantity: po.quantity,
                            orderDate: po.orderDate,
                        })),
                        urgency,
                        explanation,
                        suggestedQty,
                        orderIncrementQty,
                        isBulkDelivery,
                        finaleReorderQty: candidate.finaleReorderQty,
                        finaleStockoutDays: candidate.finaleStockoutDays,
                        finaleConsumptionQty: candidate.finaleConsumptionQty,
                        finaleDemandQty: candidate.finaleDemandQty,
                        reorderMethod,
                        dailyRateSource: rateSource === "none" ? undefined : rateSource,
                        qtyDiverged,
                        qtyDivergencePct,
                        packSize,
                        velocityInflated: chosenVelocity.inflated,
                        velocityRawRate: chosenVelocity.rawRate,
                        velocityRealityCap: chosenVelocity.realityCap,
                        stockAvailable: activity.stockAvailable ?? (stockOnHand as number),
                        forwardDemandEntry: forward ? {
                            requiredQty: forward.requiredQty,
                            earliestBuildDate: forward.earliestBuildDate,
                            feedsBuilds: forward.feedsBuilds
                        } : undefined,
                        // v2.1 — vendor reorder policy + flags
                        vendorPolicy: reorderPolicy ? {
                            leadTimeOverrideDays: reorderPolicy.leadTimeOverrideDays,
                            targetCoverDays: reorderPolicy.targetCoverDays,
                            moqMode: reorderPolicy.moqMode,
                            overbuyReviewPct: reorderPolicy.overbuyReviewPct,
                            overbuyReviewDollars: reorderPolicy.overbuyReviewDollars,
                            notes: reorderPolicy.notes,
                        } : undefined,
                        moqWarning: rec.moqWarning,
                        reviewRequired: rec.reviewRequired,
                        reviewReasons: rec.reviewReasons,
                        // v2.2 — cognitive rounding metadata for the dashboard override dropdown
                        roundingMethod: rec.roundingMethod,
                        roundingAlternatives: rec.roundingAlternatives,
                        recommendation: {
                            formulaVersion: rec.formulaVersion,
                            coverDays: rec.coverDays,
                            rawNeededEaches: rec.rawNeededEaches,
                            provenance: rec.provenance,
                        },
                        // Bulk-vendor context — drives BULK badge + last-receipt row in ordering panel.
                        // lastPurchaseDate: most recent completed PO order date (already fetched by getProductActivity).
                        // lastPurchaseQty:  qty from that PO line (purchaseQtys[] is desc-sorted by date).
                        // isBulkVendor:     true when vendor_reorder_policies.is_bulk_vendor = true.
                        lastPurchaseDate: activity.lastPurchaseDate ?? null,
                        lastPurchaseQty:  activity.purchaseQtys[0] ?? null,
                        isBulkVendor:     reorderPolicy?.isBulkVendor ?? false,
                        // vendorOnTimeRate: populated from _vendorOnTimeRateCache — warmed by
                        // ensureLeadTimeServiceWarm() called earlier in getPurchasingIntelligence.
                        // Zero extra API calls: getVendorOnTimeRate() reads the in-process cache.
                        vendorOnTimeRate: this.getVendorOnTimeRate(party.groupName),
                    });
                } catch {
                    // Skip products that error — non-fatal
                }
                // 100ms breathing room between SKUs — keeps sustained load ~180 req/min
                await new Promise(r => setTimeout(r, 100));
            }
        }));

        // Step 9: group by vendor, sort vendors by worst urgency
        const byVendor = new Map<string, PurchasingItem[]>();
        for (const item of items) {
            if (!byVendor.has(item.supplierPartyId)) byVendor.set(item.supplierPartyId, []);
            byVendor.get(item.supplierPartyId)!.push(item);
        }

        const groups: PurchasingGroup[] = [];
        for (const groupItems of byVendor.values()) {
            const partyId = groupItems[0].supplierPartyId;
            const moq = moqCache.get(partyId);
            
            // If there's an MOQ and we have a critical item triggering a purchase
            const hasCriticalTrigger = groupItems.some(item => item.urgency === "critical" && item.suggestedQty > 0);
            
            if (moq && (moq.minimumOrderDollars || moq.minimumOrderEaches) && hasCriticalTrigger) {
                const topUps = applySmartMOQTopUp(
                    groupItems.map(item => ({
                        productId: item.productId,
                        suggestedQty: item.suggestedQty,
                        unitPrice: item.unitPrice,
                        orderIncrementQty: item.orderIncrementQty,
                        dailyRate: item.dailyRate,
                        stockOnHand: item.stockOnHand,
                        stockOnOrder: item.stockOnOrder,
                        reservedQty: item.recommendation?.reservedQty ?? 0,
                        adjustedRunwayDays: item.adjustedRunwayDays,
                        urgency: item.urgency,
                        productName: item.productName,
                    })),
                    {
                        minimumOrderDollars: moq.minimumOrderDollars,
                        minimumOrderEaches: moq.minimumOrderEaches,
                    },
                    180 // max cover days
                );
                
                for (const tu of topUps) {
                    if (tu.topUpQty > 0) {
                        const item = groupItems.find(i => i.productId === tu.productId);
                        if (item) {
                            item.suggestedQty = tu.suggestedQty;
                            item.explanation += ` [Smart MOQ Top-up: +${tu.topUpQty} units to satisfy vendor order minimums]`;
                            
                            if (item.recommendation) {
                                if (!item.recommendation.provenance) {
                                    item.recommendation.provenance = [];
                                }
                                item.recommendation.provenance.push({
                                    step: "smart_moq_topup",
                                    detail: `Added ${tu.topUpQty} units as top-up (runway was ${Math.round(item.adjustedRunwayDays)}d) to meet MOQ requirement`,
                                    value: tu.suggestedQty,
                                });
                            }
                        }
                    }
                }
            }

            groupItems.sort((a, b) =>
                urgencyRank[a.urgency] - urgencyRank[b.urgency] || a.runwayDays - b.runwayDays
            );
            const worstUrgency = groupItems.reduce<PurchasingItem['urgency']>(
                (worst, item) => urgencyRank[item.urgency] < urgencyRank[worst] ? item.urgency : worst,
                'ok'
            );
            groups.push({
                vendorName: groupItems[0].supplierName,
                vendorPartyId: groupItems[0].supplierPartyId,
                urgency: worstUrgency,
                items: groupItems,
            });
        }

        groups.sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency]);
        console.log(`[finale] getPurchasingIntelligence: ${items.length} items across ${groups.length} vendors`);

        // Persist recommendation snapshots — best-effort, non-blocking. Each row is
        // the input -> output that the receive hook will calibrate against.
        if (recommendationSnapshots.length > 0) {
            void recordRecommendationSnapshots(recommendationSnapshots).then(n => {
                if (n > 0) console.log(`[finale] getPurchasingIntelligence: ${n} recommendation snapshots persisted`);
            });
        }
        return groups;
    }

    /**
     * Fetch a draft PO and return a structured review object for the commit/send flow.
     * Only returns canCommit=true when statusId === 'ORDER_CREATED'.
     */
    async getDraftPOForReview(orderId: string): Promise<DraftPOReview> {
        const po = await (this as any).getOrderDetails(orderId);

        // Resolve vendor name from supplier role
        let vendorName = "Unknown Vendor";
        let vendorPartyId = "";
        const supplierRole = (po.orderRoleList || []).find((r: any) => r.roleTypeId === "SUPPLIER");
        if (supplierRole?.partyId) {
            vendorPartyId = supplierRole.partyId;
            try {
                vendorName = await this.resolvePartyName(
                    `/${this.accountPath}/api/partygroup/${supplierRole.partyId}`
                );
            } catch {
                vendorName = `Party#${supplierRole.partyId}`;
            }
        }

        const items = (po.orderItemList || [])
            .filter((item: any) => item.productId && (item.quantity ?? 0) > 0)
            .map((item: any) => ({
                productId: item.productId,
                productName: item.itemDescription || item.productId,
                quantity: item.quantity || 0,
                unitPrice: item.unitPrice || 0,
                lineTotal: (item.quantity || 0) * (item.unitPrice || 0),
                supplierSku: item.supplierProductId || undefined,
                packing: item.quantityUomId || undefined,
            }));

        const rawOrderUrl = po.orderUrl || `/${this.accountPath}/api/order/${orderId}`;
        const encodedUrl = Buffer.from(rawOrderUrl).toString("base64");
        const finaleUrl = `${this.apiBase}/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`;

        return {
            orderId: po.orderId || orderId,
            vendorName,
            vendorPartyId,
            orderDate: po.orderDate || new Date().toISOString().split("T")[0],
            total: po.orderItemListTotal || items.reduce((s: number, i: any) => s + i.lineTotal, 0),
            items,
            finaleUrl,
            canCommit: po.statusId === "ORDER_CREATED",
        };
    }

    /**
     * Commit a draft PO in Finale (ORDER_CREATED → ORDER_LOCKED).
     * Throws if the PO is not in ORDER_CREATED status (guards against re-commit).
     *
     * DECISION(2026-05-12): "No reception, no complete." Use direct statusId
     * POST → ORDER_LOCKED instead of actionUrlComplete. Finale's /complete
     * endpoint auto-promotes the PO to ORDER_COMPLETED even when zero units
     * have been received, which falsely marks the PO as fully received and
     * hides it from open-PO queries. Mirrors the pattern in restoreOrderStatus.
     */
    async commitDraftPO(orderId: string): Promise<{ orderId: string; committed: boolean; finalStatus: string }> {
        const po = await (this as any).getOrderDetails(orderId);

        if (po.statusId !== "ORDER_CREATED") {
            throw new Error(`PO ${orderId} is in status "${po.statusId}" — can only commit ORDER_CREATED drafts`);
        }

        const updated: any = await this.post(
            `/${this.accountPath}/api/order/${encodeURIComponent(orderId)}`,
            { ...po, statusId: "ORDER_LOCKED" }
        );

        const finalStatus = updated?.statusId || "ORDER_LOCKED";
        console.log(`[finale] commitDraftPO: PO #${orderId} committed → ${finalStatus}`);

        // Release reservations now that the PO is locked into reality —
        // future scans will see the qty as on-order through stockOnOrder.
        try {
            const { releaseReservations: _release } = await import("@/lib/purchasing/calibration");
            const released = await _release(orderId, "committed");
            if (released > 0) console.log(`[finale] commitDraftPO: released ${released} reservation(s) for PO #${orderId}`);
        } catch (err: any) {
            console.warn(`[finale] reservation release failed for PO #${orderId}: ${err.message}`);
        }

        return { orderId, committed: true, finalStatus };
    }

    /**
     * Cancel a draft PO that hasn't been sent yet.
     * HERMIA(2026-05-28): Lets Bill undo a draft without opening Finale.
     * Only ORDER_CREATED drafts can be canceled — committed (ORDER_LOCKED)
     * or already-sent POs cannot be canceled through this method; those
     * require opening Finale or issuing a vendor-visible cancellation email.
     */
    async cancelDraftPO(orderId: string): Promise<{ orderId: string; canceled: boolean; finalStatus: string }> {
        const po = await (this as any).getOrderDetails(orderId);

        if (po.statusId !== "ORDER_CREATED") {
            throw new Error(`PO ${orderId} is in status "${po.statusId}" — can only cancel ORDER_CREATED drafts`);
        }

        const updated: any = await this.post(
            `/${this.accountPath}/api/order/${encodeURIComponent(orderId)}`,
            { ...po, statusId: "ORDER_CANCELED" }
        );

        const finalStatus = updated?.statusId || "ORDER_CANCELED";
        console.log(`[finale] cancelDraftPO: PO #${orderId} canceled → ${finalStatus}`);

        // Release reservations so stock is freed for real orders.
        try {
            const { releaseReservations: _release } = await import("@/lib/purchasing/calibration");
            const released = await _release(orderId, "cancelled");
            if (released > 0) console.log(`[finale] cancelDraftPO: released ${released} reservation(s) for PO #${orderId}`);
        } catch (err: any) {
            console.warn(`[finale] reservation release failed for PO #${orderId}: ${err.message}`);
        }

        return { orderId, canceled: true, finalStatus };
    }

    async sendPurchaseOrderEmail(
        orderId: string,
        input: SendPurchaseOrderEmailInput,
    ): Promise<SendPurchaseOrderEmailResult> {
        const po = await (this as any).getOrderDetails(orderId);
        const actionUrl = this.resolvePurchaseOrderEmailActionUrl(orderId, po);
        if (!actionUrl) {
            throw new Error(
                `Finale order ${orderId} does not expose a native PO email action URL; configure FINALE_PO_EMAIL_ACTION_TEMPLATE or use Gmail fallback`,
            );
        }

        const result = await this.post(actionUrl, {
            toEmail: input.toEmail,
            to: input.toEmail,
            subject: input.subject,
            body: input.body,
            message: input.body,
        });

        return {
            orderId,
            sent: true,
            pdfAttached: true,
            actionUrl,
            messageId: result?.messageId ?? result?.id ?? null,
        };
    }

    protected resolvePurchaseOrderEmailActionUrl(orderId: string, po: any): string | undefined {
        const template = process.env.FINALE_PO_EMAIL_ACTION_TEMPLATE;
        if (template) {
            return template
                .replaceAll("{accountPath}", this.accountPath)
                .replaceAll("{orderId}", encodeURIComponent(orderId));
        }

        const candidates = [
            po.actionUrlEmailPurchaseOrder,
            po.actionUrlEmailPO,
            po.actionUrlSendPurchaseOrder,
            po.actionUrlSendPO,
            po.actionUrlEmailOrder,
            po.actionUrlEmail,
            po.emailPurchaseOrderActionUrl,
            po.sendPurchaseOrderActionUrl,
        ].filter((value): value is string => typeof value === "string" && value.length > 0);

        const nativePOEmailAction = candidates.find((url) => {
            const normalized = url.toLowerCase();
            return normalized.includes("email") && (normalized.includes("purchase") || normalized.includes("po"));
        }) ?? candidates[0];

        return nativePOEmailAction;
    }

    // ── protected helper: parse Finale numeric strings like "24 d", "1,200", null, "--" ──
    protected parseFinaleNum(val: any): number | null {
        if (val === null || val === undefined || val === 'null' || val === '--') return null;
        const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? null : n;
    }
}

/**
 * @file    client.ts
 * @purpose Lean Finale Inventory API client for Aria.
 *          Direct SKU lookups ONLY — no catalog loading.
 *          Returns: status, suppliers, lead time, cost, PO history, BOM flag.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @updated 2026-02-25
 * @deps    (none — uses native fetch)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *
 * DECISION(2026-02-24): Supplier names require resolving partygroup URLs.
 * This adds 1-2 extra API calls per lookup but gives us real vendor names.
 * We cache resolved party names to avoid repeated lookups.
 *
 * DOMAIN RULE: If supplier name starts with "BuildASoil" or "Manufacturing",
 * the product is manufactured (has a BOM), not purchased.
 */

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface SupplierInfo {
    name: string;
    role: string;        // "MAIN" | "ALT1" | "ALT2" etc.
    cost: number | null;
    partyUrl: string;
}

export interface POInfo {
    orderId: string;
    status: string;
    orderDate: string;
    expectedDelivery?: string;
    supplier: string;
    quantityOnOrder: number;
    total: number;
}

export interface FinaleProductDetail {
    productId: string;
    name: string;
    statusId: string;
    leadTimeDays: number | null;
    packing: string | null;
    category: string | null;
    lastUpdated: string | null;
    suppliers: SupplierInfo[];
    isManufactured: boolean;
    hasBOM: boolean;
    doNotReorder: boolean;         // Finale ROM = "Do not reorder" or category = "Deprecating"
    finaleUrl: string;
    openPOs: POInfo[];             // Committed POs containing this product
}

export interface ProductReport {
    found: boolean;
    product: FinaleProductDetail | null;
    telegramMessage: string;
}

export interface ReceivedPO {
    orderId: string;
    orderDate: string;
    receiveDate: string;
    supplier: string;
    total: number;
    items: Array<{ productId: string; quantity: number; orderedQuantity?: number }>;
    finaleUrl: string;
}

export interface ExternalReorderItem {
    productId: string;
    stockoutDays: number | null;  // null = Finale can't calculate (no demand history)
    reorderQty: number | null;    // Finale's suggested order quantity; null = not configured
    consumptionQty: number;       // 90-day consumption
    supplierPartyId: string | null;
    supplierName: string;
    unitPrice: number;
    isManufactured: boolean;      // always false for items in ExternalReorderGroup
    orderIncrementQty: number | null;  // "Std reorder in qty of" from Finale — snap quantities to this multiple
    isBulkDelivery: boolean;           // true → route to Soil facility instead of Shipping
}

export interface ExternalReorderGroup {
    vendorName: string;
    vendorPartyId: string;
    urgency: 'critical' | 'warning' | 'reorder_flagged';
    items: ExternalReorderItem[];
}

export interface PurchasingItem {
    productId: string;
    productName: string;
    supplierName: string;
    supplierPartyId: string;
    unitPrice: number;
    stockOnHand: number;
    stockOnOrder: number;
    purchaseVelocity: number;      // units/day from purchase receipts (bulk-inflated for packaging)
    salesVelocity: number;         // units/day from outbound shipments
    demandVelocity: number;        // units/day from Finale 90-day demand (sales + BOM consumption)
    dailyRate: number;             // best signal: demandVelocity → salesVelocity → purchaseVelocity
    runwayDays: number;            // stockOnHand / dailyRate
    adjustedRunwayDays: number;    // (stockOnHand + stockOnOrder) / dailyRate
    leadTimeDays: number;
    leadTimeProvenance: string;    // e.g. "14d (Finale)" | "14d default"
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';
    explanation: string;           // natural language, computed server-side
    suggestedQty: number;
    orderIncrementQty: number | null;  // "Std reorder in qty of" — snap order quantities to this multiple
    isBulkDelivery: boolean;           // true → route to Soil facility
    finaleReorderQty: number | null;
    finaleStockoutDays: number | null;
    finaleConsumptionQty: number | null;
    finaleDemandQty: number | null;    // 90-day demand quantity from Finale productView
}

export interface PurchasingGroup {
    vendorName: string;
    vendorPartyId: string;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';  // worst of all items
    items: PurchasingItem[];
}

type PurchasingIntelligenceCandidate = {
    productId: string;
    finaleReorderQty: number | null;
    finaleStockoutDays: number | null;
    finaleConsumptionQty: number | null;
    finaleDemandQty: number | null;
    finaleDemandPerDay: number | null;
};

export interface FullPO {
    orderId: string;
    vendorName: string;
    orderDate: string;           // YYYY-MM-DD
    expectedDate: string | null; // Finale's dueDate field (quoted delivery date)
    receiveDate: string | null;  // null if not yet received
    status: string;              // 'Committed' | 'Completed' | 'Cancelled' | etc.
    total: number;
    items: Array<{ productId: string; quantity: number }>;
    finaleUrl: string;
    shipments?: Array<{ shipmentId: string; status: string; receiveDate: string | null; shipDate: string | null }>;
}

export interface DraftPOReview {
    orderId: string;
    vendorName: string;
    vendorPartyId: string;
    orderDate: string;
    total: number;
    items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number }>;
    finaleUrl: string;
    canCommit: boolean;   // true only if statusId === 'ORDER_CREATED'
}

export interface ConsumptionReport {
    productId: string;
    name: string;
    periodDays: number;
    totalConsumed: number;         // Total units consumed via builds
    dailyRate: number;             // Average units consumed per day
    currentStock: number | null;   // Current on-hand stock
    estimatedDaysLeft: number | null;  // Stock / dailyRate
    buildOrders: Array<{
        orderId: string;
        buildDate: string;
        quantityUsed: number;      // How much of this component was consumed
        builtProduct: string;      // What finished product was built
    }>;
    telegramMessage: string;
}

// ──────────────────────────────────────────────────
// CLIENT
// ──────────────────────────────────────────────────

function parseFinaleNumber(val: string | number | null | undefined): number {
    if (val == null) return 0;
    const cleaned = String(val).replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

/**
 * DECISION(2026-03-04): Purchase Destination routing.
 * Finale POs use `originFacilityUrl` to set where received goods go.
 * Two destinations at BAS: "Shipping" (default) and "Soil" (bulk/raw).
 * Bulk detection infers Soil routing from product characteristics:
 *   - Product name contains: tote, bulk, raw, pallet, super sack, truckload
 *   - Packing string implies >2000 lbs or yard/ton/CY units
 *   - Multiple large-format items ordered together
 * Override via optional `purchaseDestination` param on createDraftPurchaseOrder.
 */

/** Facility URL cache — module-level so it persists across FinaleClient instances. */
interface FacilityInfo {
    url: string;   // e.g. "/buildasoilorganics/api/facility/12345"
    name: string;  // e.g. "Shipping", "Soil"
}
let _facilityCache: FacilityInfo[] | null = null;
let _facilityCacheAt = 0;
const FACILITY_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// DECISION(2026-03-09): Moved partyNameCache from instance-level to module-level.
// Previously, each `new FinaleClient()` created its own Map that populated
// independently. With 48+ instantiation sites (cron jobs, command handlers),
// this caused unbounded memory growth as async closures kept instances alive.
// Module-level cache is shared across all instances — one Map, bounded.
const _partyNameCache = new Map<string, string>();  // party URL → name
let _partyNameCacheAt = 0;
const PARTY_NAME_CACHE_TTL = 60 * 60 * 1000;  // 1 hour
const PARTY_NAME_CACHE_MAX = 500;

// Shared party resolution cache — partyId → resolved party info + timestamp.
// Shared across getExternalReorderItems() and getPurchasingIntelligence() so
// concurrent scans don't duplicate partygroup API calls for the same vendor.
const _partyCacheShared = new Map<string, { groupName: string; isManufactured: boolean; isDropship: boolean; ts: number }>();
const PARTY_CACHE_TTL = 60 * 60 * 1000;  // 1 hour
const PARTY_CACHE_MAX = 200;

export class FinaleClient {
    private authHeader: string;
    private apiBase: string;
    private accountPath: string;

    constructor() {
        const apiKey = process.env.FINALE_API_KEY || "";
        const apiSecret = process.env.FINALE_API_SECRET || "";
        this.accountPath = process.env.FINALE_ACCOUNT_PATH || "";
        const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";

        this.apiBase = baseUrl;
        this.authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    }

    /**
     * Test the connection to Finale
     */
    async testConnection(): Promise<boolean> {
        try {
            await this.get(`/${this.accountPath}/api/facility`);
            console.log("✅ Finale API connected");
            return true;
        } catch (err: any) {
            console.error("❌ Finale connection failed:", err.message);
            return false;
        }
    }

    /**
     * Fetch and cache all Finale facility URLs.
     * Used to set `originFacilityUrl` (Purchase Destination) on POs.
     * Typically returns: Shipping, Soil, and any other configured locations.
     */
    async getFacilities(): Promise<FacilityInfo[]> {
        if (_facilityCache && Date.now() - _facilityCacheAt < FACILITY_CACHE_TTL) return _facilityCache;

        try {
            const data = await this.get(`/${this.accountPath}/api/facility`);
            // Finale often returns parallel collections ({ facilityId: [...], facilityUrl: [...] })
            let facilities: FacilityInfo[] = [];

            if (Array.isArray(data)) {
                facilities = data.map((f: any) => ({
                    url: f.facilityUrl || f.url || `/${this.accountPath}/api/facility/${f.facilityId}`,
                    name: f.facilityName || f.name || f.facilityId || 'Unknown',
                }));
            } else if (data && Array.isArray(data.facilityId)) {
                for (let i = 0; i < data.facilityId.length; i++) {
                    facilities.push({
                        url: data.facilityUrl?.[i] || `/${this.accountPath}/api/facility/${data.facilityId[i]}`,
                        name: data.facilityName?.[i] || data.facilityId[i] || 'Unknown',
                    });
                }
            } else {
                const list: any[] = data?.facilityList || [];
                facilities = list.map((f: any) => ({
                    url: f.facilityUrl || f.url || `/${this.accountPath}/api/facility/${f.facilityId}`,
                    name: f.facilityName || f.name || f.facilityId || 'Unknown',
                }));
            }

            _facilityCache = facilities;
            _facilityCacheAt = Date.now();

            console.log(`[finale] getFacilities: found ${_facilityCache.length} facilities: ${_facilityCache.map(f => f.name).join(', ')}`);
            return _facilityCache;
        } catch (err: any) {
            console.warn(`[finale] getFacilities failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Resolve a facility URL by name (case-insensitive partial match).
     * Returns null if the facility isn't found — callers should omit the field in that case.
     *
     * @param name - Facility name to match, e.g. "Shipping" or "Soil"
     */
    async getFacilityUrl(name: string): Promise<string | null> {
        const facilities = await this.getFacilities();
        const nameLower = name.toLowerCase();
        const match = facilities.find(f => f.name.toLowerCase().includes(nameLower));
        return match?.url ?? null;
    }

    /**
     * Infer whether a product is a "bulk delivery" item that should route to the Soil facility.
     *
     * DECISION(2026-03-04): Bulk detection heuristics — ordered by strongest signal:
     * 1. Product name contains: tote, bulk, raw, pallet, super sack, truckload, yard, CY
     * 2. Packing string implies large format (>2000 lbs, ton, yard, CY units)
     * 3. Category includes "raw" or "bulk"
     *
     * Default is Shipping — Soil only when we have strong signal.
     * Override is always available via the `purchaseDestination` param.
     *
     * @param productData - Raw product data from Finale REST API
     * @returns true if item should route to Soil facility
     */
    static isBulkDelivery(productData: {
        productId?: string;
        internalName?: string;
        normalizedPackingString?: string;
        userCategory?: string;
    }): boolean {
        const name = (productData.internalName || productData.productId || '').toLowerCase();
        const packing = (productData.normalizedPackingString || '').toLowerCase();
        const category = (productData.userCategory || '').toLowerCase();

        // Strong signal: product name directly indicates bulk
        const bulkNamePatterns = /\b(tote|bulk|raw|pallet|super\s*sack|truckload|truck\s*load|yard|cubic\s*yard|\bcy\b|tanker)\b/;
        if (bulkNamePatterns.test(name)) return true;

        // Packing string weight check — anything ≥2000 lbs is bulk
        const weightMatch = packing.match(/(\d[\d,.]*)\s*(lb|lbs|pound|pounds)/i);
        if (weightMatch) {
            const weight = parseFloat(weightMatch[1].replace(/,/g, ''));
            if (weight >= 2000) return true;
        }

        // Packing string with ton/yard/CY units
        if (/\b(ton|tons|yard|yards|\bcy\b|cubic\s*yard)\b/.test(packing)) return true;

        // Category-based signal
        if (/\b(raw|bulk)\b/.test(category)) return true;

        return false;
    }

    /**
     * Round a quantity UP to the nearest multiple of the order increment.
     * If increment is null/0/1, returns the original quantity unchanged.
     *
     * Examples with increment=80:
     *   40 → 80, 80 → 80, 120 → 160, 200 → 200
     *
     * @param quantity        - Raw calculated reorder quantity
     * @param incrementQty   - "Std reorder in qty of" from Finale product
     * @returns Snapped quantity (always >= increment if increment is set)
     */
    static snapToIncrement(quantity: number, incrementQty: number | null): number {
        if (!incrementQty || incrementQty <= 1) return quantity;
        return Math.max(incrementQty, Math.ceil(quantity / incrementQty) * incrementQty);
    }

    /**
     * Check whether a Finale product is flagged "Do not reorder".
     *
     * DECISION(2026-03-04): Products marked "Do not reorder" in Finale should be
     * excluded from ALL reorder assessments and draft PO creation. We check
     * multiple possible locations since Finale's storage varies:
     *   - `reorderPointPolicy` field (e.g. "DO_NOT_REORDER", "doNotReorder")
     *   - `doNotReorder` boolean field
     *   - Product name or description containing "do not reorder" (case-insensitive)
     *   - `userFieldDataList` entries with "do not reorder" values
     *
     * @param productData - Raw product data from Finale REST API
     * @returns true if the product should NOT be included in reorder calculations
     */
    static isDoNotReorder(productData: any): boolean {
        if (!productData) return false;

        // Check reorderPointPolicy field
        const policy = String(productData.reorderPointPolicy || '').toLowerCase();
        if (policy.includes('do_not_reorder') || policy.includes('donotreorder') || policy.includes('do not reorder')) {
            return true;
        }

        // Check explicit boolean field
        if (productData.doNotReorder === true) return true;

        // DECISION(2026-03-11): Finale stores "Do not reorder" in the
        // reorderGuidelineList entries via `reorderCalculationMethodId: "##doNotReorder"`.
        // This is the actual mechanism used in the Finale UI. A single matching
        // guideline (any facility) is enough to flag the product.
        const guidelines: any[] = productData.reorderGuidelineList || [];
        for (const g of guidelines) {
            const methodId = String(g.reorderCalculationMethodId || '').toLowerCase();
            if (methodId.includes('donotreorder')) return true;
        }

        // Check product name and description for "do not reorder" text
        const name = String(productData.internalName || productData.productId || '').toLowerCase();
        const desc = String(productData.description || productData.longDescription || '').toLowerCase();
        if (name.includes('do not reorder') || desc.includes('do not reorder')) return true;

        // Check user-defined fields for "do not reorder" flag
        const userFields: any[] = productData.userFieldDataList || [];
        for (const field of userFields) {
            const val = String(field.value || field.userFieldValue || field.attrValue || '').toLowerCase();
            if (val.includes('do not reorder')) return true;
        }

        return false;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // PURCHASING INTELLIGENCE METHODS
    // DECISION(2026-03-04): Five new methods for proactive purchasing alerts.
    // ──────────────────────────────────────────────────────────────────────────

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
            const query = {
                query: `{
                    orderViewConnection(
                        first: 200
                        type: ["PURCHASE_ORDER"]
                        statusId: ["ORDER_CREATED", "ORDER_COMMITTED"]
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
                        statusId: ["ORDER_COMPLETED"]
                        sort: [{ field: "receiveDate", mode: "desc" }]
                    ) {
                        edges { node {
                            orderId orderDate receiveDate
                            supplier { name }
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
                        statusId: ["ORDER_COMMITTED", "ORDER_COMPLETED"]
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

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            const json: any = await res.json();
            const edges: any[] = json.data?.orderViewConnection?.edges || [];

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
                        statusId: ["ORDER_CREATED"]
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

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            const json: any = await res.json();
            const edges: any[] = json.data?.orderViewConnection?.edges || [];
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
     * Fetch POs received today via GraphQL.
     * Uses `receiveDate: { begin, end }` filter.
     * DECISION(2026-03-12): Receivings = POs with a receiveDate, regardless of
     * status. A PO can have received items while still Committed (partial receive),
     * Created (draft, operator still adjusting), or Completed. The receiveDate
     * filter in the GraphQL query is the sole gate — no client-side status filter.
     */
    async getTodaysReceivedPOs(startDate?: string, endDate?: string): Promise<ReceivedPO[]> {
        try {
            // Get today's date in YYYY-MM-DD format (Mountain Time)
            const now = new Date();
            const today = startDate || now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = endDate || tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: 500
                            type: ["PURCHASE_ORDER"]
                            receiveDate: { begin: "${today}", end: "${tomorrowStr}" }
                            sort: [{ field: "receiveDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    orderUrl
                                    status
                                    orderDate
                                    receiveDate
                                    total
                                    supplier { name }
                                    itemList(first: 50) {
                                        edges {
                                            node {
                                                product { productId }
                                                quantity
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                `
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });

            if (!res.ok) return [];
            const result = await res.json();
            if (result.errors) {
                console.error("Receivings GraphQL error:", result.errors[0].message);
                return [];
            }

            const edges = result.data?.orderViewConnection?.edges || [];
            return edges
                .map((edge: any) => {
                    const po = edge.node;
                    const encodedUrl = Buffer.from(po.orderUrl || "").toString("base64");
                    return {
                        orderId: po.orderId,
                        orderDate: po.orderDate || "",
                        receiveDate: po.receiveDate || "",
                        supplier: po.supplier?.name || "Unknown",
                        total: parseFinaleNumber(po.total),
                        items: (po.itemList?.edges || []).map((ie: any) => ({
                            productId: ie.node.product?.productId || "?",
                            quantity: parseFinaleNumber(ie.node.quantity),
                        })),
                        finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
                    };
                });
        } catch (err: any) {
            console.error("Failed to fetch receivings:", err.message);
            return [];
        }
    }

    /**
     * Returns total quantity purchased for a SKU over a rolling date range.
     * Uses orderViewConnection with orderDate filter + client-side SKU match.
     *
     * DECISION(2026-03-04): Finale often leaves receiveDate empty on Completed POs
     * (confirmed on ULINE — all Completed POs have blank receiveDate). Using orderDate
     * ensures these show up. Status filter ("Completed") is applied client-side.
     * Designed for answering "how much did we buy last N days" questions.
     */
    async getPurchasedQty(sku: string, daysBack: number = 365): Promise<{
        sku: string;
        totalQty: number;
        orderCount: number;
        orders: Array<{ orderId: string; receiveDate: string; supplier: string; qty: number }>;
    }> {
        const end = new Date();
        const begin = new Date();
        begin.setDate(begin.getDate() - daysBack);

        const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const endStr = end.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

        // product filter narrows response to POs containing this SKU only — avoids fetching
        // all 500+ POs in the window and scanning client-side (20-50x less data per call).
        // first: 100 handles items ordered weekly over a 12-month window (~52 POs).
        const productUrl = `/${this.accountPath}/api/product/${sku}`;
        const query = {
            query: `
                query {
                    orderViewConnection(
                        first: 100
                        type: ["PURCHASE_ORDER"]
                        product: ["${productUrl}"]
                        orderDate: { begin: "${beginStr}", end: "${endStr}" }
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges {
                            node {
                                orderId
                                status
                                orderDate
                                receiveDate
                                supplier { name }
                                itemList(first: 20) {
                                    edges {
                                        node {
                                            product { productId }
                                            quantity
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            `
        };

        try {
            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
                body: JSON.stringify(query),
            });

            if (!res.ok) return { sku, totalQty: 0, orderCount: 0, orders: [] };
            const result = await res.json();
            const edges = result.data?.orderViewConnection?.edges || [];

            // Filter to Completed POs that contain this SKU
            const matchingOrders: Array<{ orderId: string; receiveDate: string; supplier: string; qty: number }> = [];

            for (const edge of edges) {
                const po = edge.node;
                if (po.status !== "Completed") continue;

                for (const ie of (po.itemList?.edges || [])) {
                    if (ie.node.product?.productId === sku) {
                        matchingOrders.push({
                            orderId: po.orderId,
                            receiveDate: po.receiveDate || po.orderDate || "",
                            supplier: po.supplier?.name || "Unknown",
                            qty: parseFinaleNumber(ie.node.quantity),
                        });
                        break; // one entry per PO
                    }
                }
            }

            const totalQty = matchingOrders.reduce((sum, o) => sum + o.qty, 0);
            return { sku, totalQty, orderCount: matchingOrders.length, orders: matchingOrders };
        } catch (err: any) {
            console.error(`getPurchasedQty failed for ${sku}:`, err.message);
            return { sku, totalQty: 0, orderCount: 0, orders: [] };
        }
    }

    /**
     * Returns total quantity sold (shipped) for a SKU over a rolling date range,
     * as well as open demand and current stock levels.
     * Uses orderViewConnection with type SALES_ORDER and productViewConnection.
     */
    async getSalesQty(sku: string, daysBack: number = 365): Promise<{
        sku: string;
        totalSoldQty: number;      // Completed / Shipped
        soldOrderCount: number;
        openDemandQty: number;     // Committed sales orders
        openDemandCount: number;
        stockOnHand: number | null;
        stockAvailable: number | null;
    }> {
        const end = new Date();
        const begin = new Date();
        begin.setDate(begin.getDate() - daysBack);

        const beginStr = begin.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const endStr = end.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

        // product filter narrows response to sales orders containing this SKU only.
        const productUrlSales = `/${this.accountPath}/api/product/${sku}`;
        const query = {
            query: `
                query {
                    orderViewConnection(
                        first: 50
                        type: ["SALES_ORDER"]
                        product: ["${productUrlSales}"]
                        orderDate: { begin: "${beginStr}", end: "${endStr}" }
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges {
                            node {
                                orderId
                                status
                                itemList(first: 20) {
                                    edges {
                                        node {
                                            product { productId }
                                            quantity
                                        }
                                    }
                                }
                            }
                        }
                    }
                    productViewConnection(first: 1, productId: "${sku}") {
                        edges {
                            node {
                                stockOnHand
                                stockAvailable
                            }
                        }
                    }
                }
            `
        };

        try {
            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
                body: JSON.stringify(query),
            });

            if (!res.ok) {
                return { sku, totalSoldQty: 0, soldOrderCount: 0, openDemandQty: 0, openDemandCount: 0, stockOnHand: null, stockAvailable: null };
            }

            const result = await res.json();
            const edges = result.data?.orderViewConnection?.edges || [];
            const productNode = result.data?.productViewConnection?.edges?.[0]?.node;

            let totalSoldQty = 0;
            let soldOrderCount = 0;
            let openDemandQty = 0;
            let openDemandCount = 0;

            for (const edge of edges) {
                const order = edge.node;
                const isSold = order.status === "Completed" || order.status === "Shipped";
                const isOpen = order.status === "Committed";

                if (!isSold && !isOpen) continue;

                for (const ie of (order.itemList?.edges || [])) {
                    if (ie.node.product?.productId === sku) {
                        const qty = parseFinaleNumber(ie.node.quantity);
                        if (isSold) {
                            totalSoldQty += qty;
                            soldOrderCount++;
                        } else if (isOpen) {
                            openDemandQty += qty;
                            openDemandCount++;
                        }
                        break;
                    }
                }
            }

            const parseVal = (val: string | null | undefined): number | null => {
                if (!val || val === '--' || val === 'null') return null;
                const cleaned = val.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
                const n = parseFloat(cleaned);
                return isNaN(n) ? null : n;
            };

            return {
                sku,
                totalSoldQty,
                soldOrderCount,
                openDemandQty,
                openDemandCount,
                stockOnHand: productNode ? parseVal(productNode.stockOnHand) : null,
                stockAvailable: productNode ? parseVal(productNode.stockAvailable) : null
            };
        } catch (err: any) {
            console.error(`getSalesQty failed for ${sku}:`, err.message);
            return { sku, totalSoldQty: 0, soldOrderCount: 0, openDemandQty: 0, openDemandCount: 0, stockOnHand: null, stockAvailable: null };
        }
    }

    /**
     * Format today's received POs as a Slack message.
     * Clean, informative, links to each PO.
     */
    formatReceivingsDigest(receivedPOs: ReceivedPO[]): string {
        if (receivedPOs.length === 0) {
            return ":package: *No receivings today* — nothing received yet.";
        }

        const totalValue = receivedPOs.reduce((sum, po) => sum + (po.total || 0), 0);
        const totalItems = receivedPOs.reduce((sum, po) =>
            sum + po.items.reduce((s, i) => s + i.quantity, 0), 0
        );

        let msg = `:package: *Today's Receivings* — ${receivedPOs.length} PO${receivedPOs.length > 1 ? "s" : ""}`;
        msg += ` · ${totalItems.toLocaleString()} units · $${totalValue.toLocaleString()}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        for (const po of receivedPOs) {
            const itemCount = po.items.reduce((s, i) => s + i.quantity, 0);
            const skuList = po.items.map(i => `\`${i.productId}\``).join(", ");
            const truncatedSkus = skuList.length > 80
                ? skuList.substring(0, 77) + "..."
                : skuList;

            msg += `\n:white_check_mark: *<${po.finaleUrl}|PO ${po.orderId}>*`;
            msg += ` — _${po.supplier}_\n`;
            msg += `      ${itemCount} units · $${po.total.toLocaleString()} · ${truncatedSkus}\n`;
        }

        return msg;
    }

    /**
     * Fetch POs committed today via GraphQL.
     */
    async getTodaysCommittedPOs(startDate?: string, endDate?: string): Promise<ReceivedPO[]> {
        try {
            const now = new Date();
            const today = startDate || now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = endDate || tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: 100
                            type: ["PURCHASE_ORDER"]
                            orderDate: { begin: "${today}", end: "${tomorrowStr}" }
                            sort: [{ field: "orderDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    orderUrl
                                    status
                                    orderDate
                                    total
                                    supplier { name }
                                    itemList(first: 50) {
                                        edges {
                                            node {
                                                product { productId }
                                                quantity
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                `
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });

            if (!res.ok) return [];
            const result = await res.json();
            if (result.errors) return [];

            const edges = result.data?.orderViewConnection?.edges || [];
            return edges
                .filter((edge: any) => edge.node.status === "Committed")
                .map((edge: any) => {
                    const po = edge.node;
                    const encodedUrl = Buffer.from(po.orderUrl || "").toString("base64");
                    return {
                        orderId: po.orderId,
                        orderDate: po.orderDate || "",
                        receiveDate: "",  // Not received yet
                        supplier: po.supplier?.name || "Unknown",
                        total: parseFinaleNumber(po.total),
                        items: (po.itemList?.edges || []).map((ie: any) => ({
                            productId: ie.node.product?.productId || "?",
                            quantity: parseFinaleNumber(ie.node.quantity),
                        })),
                        finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
                    };
                });
        } catch (err: any) {
            console.error("Failed to fetch committed POs:", err.message);
            return [];
        }
    }

    /**
     * Format today's committed POs as a message, including basic anomaly checking.
     */
    async formatCommittedDigest(committedPOs: ReceivedPO[]): Promise<string> {
        if (committedPOs.length === 0) {
            return "📝 *No POs Committed today*";
        }

        const totalValue = committedPOs.reduce((sum, po) => sum + (po.total || 0), 0);
        let msg = `📝 *Today's Committed POs* — ${committedPOs.length} New PO${committedPOs.length > 1 ? "s" : ""}`;
        msg += ` · $${totalValue.toLocaleString()}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        for (const po of committedPOs) {
            const itemCount = po.items.reduce((s, i) => s + i.quantity, 0);
            msg += `\n:inbox_tray: *<${po.finaleUrl}|PO ${po.orderId}>* — _${po.supplier}_\n`;
            msg += `      ${itemCount} units total · $${po.total.toLocaleString()}\n`;

            // Limit deep component checking to core items to avoid API rate limiting
            // In a full implementation, we would check all items
            const majorItems = po.items.filter(i => i.quantity > 50).slice(0, 3);
            for (const item of majorItems) {
                // Verify if this quantity covers the upcoming timeframe
                try {
                    const profile = await this.getComponentStockProfile(item.productId);
                    if (profile.hasFinaleData) {
                        const dailyDemand = (profile.demandQuantity || 0) / 90; // Approx 90 day view
                        const incomingDaysCovered = dailyDemand > 0 ? Math.round(item.quantity / dailyDemand) : 999;

                        if (incomingDaysCovered < 14) {
                            msg += `      ⚠️ Anomaly: Order for \`${item.productId}\` (${item.quantity} qty) only covers ~${incomingDaysCovered} days demand.\n`;
                        } else {
                            msg += `      ✅ \`${item.productId}\` order qty covers ~${incomingDaysCovered} days.\n`;
                        }
                    }
                } catch {
                    // skip
                }
            }
        }

        return msg;
    }

    /**
     * Fetch line items and Finale deep-link for a PO by its order number.
     * Queries the last 30 days of POs via GraphQL and filters client-side by orderId.
     * Only called when new tracking is detected — infrequent, cost is fine.
     */
    async getPOLineItems(poNumber: string): Promise<{
        finaleUrl: string;
        lineItems: Array<{ sku: string; qty: number }>;
    } | null> {
        try {
            const now = new Date();
            const from = new Date(now);
            from.setDate(from.getDate() - 90);
            const fromStr = from.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const toStr = new Date(now.getTime() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Denver" });

            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: 100
                            type: ["PURCHASE_ORDER"]
                            orderDate: { begin: "${fromStr}", end: "${toStr}" }
                            sort: [{ field: "orderDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    orderUrl
                                    itemList(first: 50) {
                                        edges {
                                            node {
                                                product { productId }
                                                quantity
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                `
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
                body: JSON.stringify(query),
            });

            if (!res.ok) return null;
            const result = await res.json();
            const edges = result.data?.orderViewConnection?.edges || [];
            const match = edges.find((e: any) => String(e.node.orderId).replace(/^PO-/i, '') === String(poNumber));
            if (!match) return null;

            const encodedUrl = Buffer.from(match.node.orderUrl || "").toString("base64");
            return {
                finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
                lineItems: (match.node.itemList?.edges || []).map((ie: any) => ({
                    sku: ie.node.product?.productId || "?",
                    qty: parseFinaleNumber(ie.node.quantity),
                })),
            };
        } catch (err: any) {
            console.warn(`[getPOLineItems] PO ${poNumber}: ${err.message}`);
            return null;
        }
    }

    /**
     * Look up a product by exact SKU and resolve all enrichment data.
     * Total API calls: 1 (product) + 1 per supplier to resolve names (cached).
     */
    async lookupProduct(sku: string): Promise<FinaleProductDetail | null> {
        try {
            const data = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(sku.trim())}`);
            const product = await this.parseProductDetail(data);

            // Check for committed POs containing this product (GraphQL)
            product.openPOs = await this.findCommittedPOsForProduct(sku.trim());

            return product;
        } catch (err: any) {
            if (err.message.includes("404")) {
                // DECISION(2026-03-23): Finale REST /api/product/<sku> returns 404
                // for some valid products. Fall back to product list scan.
                const exists = await this.validateProductExists(sku.trim());
                if (exists) {
                    console.warn(`[finale] lookupProduct: ${sku} 404 on direct fetch but found in product list — Finale API quirk`);
                }
                return null;
            }
            console.error(`❌ Finale lookup failed for ${sku}:`, err.message);
            return null;
        }
    }

    /**
     * Validate that a product SKU exists in Finale.
     * Tries direct REST endpoint first (fast), falls back to scanning the
     * full product list if the direct endpoint returns 404.
     *
     * DECISION(2026-03-23): Finale's REST GET /api/product/<sku> returns 404
     * for some valid products that DO appear in the product list and the UI.
     * This is a known Finale API quirk. The product list scan is the reliable
     * fallback. We cache the product list for the lifetime of the client instance.
     */
    private productListCache: string[] | null = null;

    async validateProductExists(sku: string): Promise<boolean> {
        const trimmed = sku.trim();

        // Fast path: direct endpoint
        try {
            await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(trimmed)}`);
            return true;
        } catch {
            // Direct endpoint 404s for some valid products — try list scan
        }

        // Fallback: scan product list (cached per client instance)
        try {
            if (!this.productListCache) {
                const data = await this.get(`/${this.accountPath}/api/product`);
                this.productListCache = data.productId || [];
                console.log(`[finale] Product list cached: ${this.productListCache.length} products`);
            }
            return this.productListCache.includes(trimmed);
        } catch (err: any) {
            console.error(`[finale] validateProductExists failed for ${sku}:`, err.message);
            return false;
        }
    }

    /**
     * Find committed POs that contain a specific product.
     * Uses GraphQL — REST doesn't support PO filtering.
     *
     * DECISION(2026-02-24): The `product` filter requires the full URL path
     * format (e.g. "/buildasoilorganics/api/product/SKU") NOT just the productId.
     * Also, `status` + `product` filters conflict — so we query by product only
     * and filter for Committed status client-side.
     */
    async findCommittedPOsForProduct(productId: string): Promise<POInfo[]> {
        try {
            const productUrl = `/${this.accountPath}/api/product/${productId}`;
            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: 100
                            type: ["PURCHASE_ORDER"]
                            product: ["${productUrl}"]
                            sort: [{ field: "orderDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    status
                                    orderDate
                                    expectedDelivery
                                    supplier { name }
                                    total
                                    itemList(first: 100) {
                                        edges {
                                            node {
                                                product { productId }
                                                quantity
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                `
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });

            if (!res.ok) return [];
            const result = await res.json();
            if (result.errors) return [];

            const relevantStatuses = new Set(["Committed", "Locked"]);
            const edges = result.data?.orderViewConnection?.edges || [];
            return edges
                .filter((edge: any) => relevantStatuses.has(edge.node.status))
                .map((edge: any) => {
                    const po = edge.node;
                    const items = po.itemList?.edges || [];
                    const matchingItem = items.find(
                        (item: any) => item.node.product?.productId === productId
                    );
                    return {
                        orderId: po.orderId,
                        status: po.status,
                        orderDate: po.orderDate,
                        expectedDelivery: po.expectedDelivery,
                        supplier: po.supplier?.name || "Unknown",
                        quantityOnOrder: parseFinaleNumber(matchingItem?.node.quantity) || 0,
                        total: po.total || 0,
                    };
                });
        } catch (err: any) {
            console.error("PO lookup error:", err.message);
            return [];
        }
    }

    /**
     * Generate a rich Telegram report for a product.
     */
    async productReport(sku: string): Promise<ProductReport> {
        const product = await this.lookupProduct(sku);

        if (!product) {
            return {
                found: false,
                product: null,
                telegramMessage:
                    `❌ *Product Not Found*\n\n` +
                    `SKU \`${sku}\` was not found in Finale.\n` +
                    `_Try the exact SKU (e.g. S-12527, BC101, PU102)_`,
            };
        }

        // Build the Telegram message
        const statusEmoji = product.statusId === "PRODUCT_ACTIVE" ? "🟢" : "🔴";
        const statusLabel = product.statusId === "PRODUCT_ACTIVE" ? "Active" : "Inactive";
        const typeEmoji = product.isManufactured ? "🔨" : "📦";
        const typeLabel = product.isManufactured ? "Manufactured (BOM)" : "Purchased";

        let msg = `${typeEmoji} *${product.name}*\n`;
        msg += `SKU: \`${product.productId}\`\n`;
        msg += `${statusEmoji} ${statusLabel} · ${typeLabel}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        // Suppliers
        if (product.suppliers.length > 0) {
            msg += `\n🏭 *Suppliers*\n`;
            for (const s of product.suppliers) {
                const roleLabel = s.role === "MAIN" ? "★ Primary" : `Alt`;
                const costStr = s.cost !== null ? ` · $${s.cost.toFixed(2)}` : "";
                msg += `  ${roleLabel}: ${s.name}${costStr}\n`;
            }
        }

        if (product.leadTimeDays !== null) {
            msg += `\n⏱️ Lead Time: ${product.leadTimeDays} days`;
        }
        if (product.packing) {
            msg += `\n📐 Packing: ${product.packing}`;
        }

        // On Order section
        if (product.openPOs.length > 0) {
            msg += `\n\n📋 *On Order*\n`;
            for (const po of product.openPOs) {
                msg += `  ✅ PO ${po.orderId}: ${po.quantityOnOrder} units`;
                msg += ` from ${po.supplier} (${po.orderDate})\n`;
            }
        } else {
            msg += `\n\n⚠️ *Not on any open PO*`;
        }

        if (product.isManufactured) {
            msg += `\n🔨 _Manufactured item — needs to be built, not ordered._`;
        }

        // Direct Finale link
        const encodedUrl = encodeURIComponent(`/${this.accountPath}/api/product/${product.productId}`);
        msg += `\n\n🔗 [Open in Finale](https://app.finaleinventory.com/${this.accountPath}/app#product?productUrl=${encodedUrl})`;
        msg += `\n_Updated: ${product.lastUpdated?.split("T")[0] || "unknown"}_`;

        return {
            found: true,
            product,
            telegramMessage: msg,
        };
    }

    /**
     * Get current stock level for a product.
     *
     * DECISION(2026-03-16): Canonical stock retrieval method.
     * 
     * ⚠️  DO NOT use REST `prodData.quantityOnHand` — it returns undefined for
     * most products (Finale API quirk, discovered during ULINE ordering work).
     *
     * ✅  Use GraphQL `productViewConnection.stockOnHand` — this is the same
     * query that powers getSalesQty(), getBOMConsumption(), and the Finale
     * Product List screen. It returns real stock values.
     *
     * Fallback chain: GraphQL stockOnHand → GraphQL unitsInStock → REST quantityOnHand
     *
     * @param   productId - Finale product SKU
     * @returns On-hand quantity, or null if not tracked
     */
    async getStockLevel(productId: string): Promise<number | null> {
        // Primary: GraphQL productViewConnection (reliable)
        try {
            const query = {
                query: `{
                    productViewConnection(first: 1, productId: "${productId}") {
                        edges { node {
                            stockOnHand
                            stockAvailable
                            unitsInStock
                        }}
                    }
                }`
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });

            if (res.ok) {
                const result = await res.json();
                const node = result.data?.productViewConnection?.edges?.[0]?.node;
                if (node) {
                    const parseVal = (val: string | null | undefined): number | null => {
                        if (!val || val === '--' || val === 'null') return null;
                        const n = parseFloat(val.replace(/,/g, ''));
                        return isNaN(n) ? null : n;
                    };
                    const stock = parseVal(node.stockOnHand) ?? parseVal(node.unitsInStock);
                    if (stock !== null) return stock;
                }
            }
        } catch { /* fall through to REST */ }

        // Fallback: REST API (rarely has data, but try it)
        try {
            const data = await this.get(
                `/${this.accountPath}/api/product/${encodeURIComponent(productId)}`
            );
            return data.quantityOnHand ?? data.stockLevel ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Get a comprehensive stock profile for a component including on-hand,
     * on-order (incoming POs), and Finale's native demand/stockout calculations.
     *
     * DECISION(2026-02-25): Finale returns "--" for stockOnHand for ALL products
     * via productViewConnection (stock requires facility-level queries). However,
     * Finale DOES return demandQuantity, consumptionQuantity, and stockoutDays
     * which are the calculated aggregate values. We use these for risk assessment.
     *
     * The PO lookup via findCommittedPOsForProduct returns actual incoming supply.
     */
    async getComponentStockProfile(productId: string): Promise<{
        onHand: number | null;
        onOrder: number | null;
        available: number | null;
        stockoutDays: number | null;
        demandQuantity: number | null;
        consumptionQuantity: number | null;
        leadTimeDays: number | null;
        reorderQuantityToOrder: number | null;
        hasFinaleData: boolean;      // Whether Finale returned ANY meaningful data
        incomingPOs: Array<{ orderId: string; supplier: string; quantity: number; orderDate: string; expectedDelivery?: string }>;
    }> {
        const profile = {
            onHand: null as number | null,
            onOrder: null as number | null,
            available: null as number | null,
            stockoutDays: null as number | null,
            demandQuantity: null as number | null,
            consumptionQuantity: null as number | null,
            leadTimeDays: null as number | null,
            reorderQuantityToOrder: null as number | null,
            hasFinaleData: false,
            incomingPOs: [] as Array<{ orderId: string; supplier: string; quantity: number; orderDate: string; expectedDelivery?: string }>,
        };

        const parseVal = (val: string | null | undefined): number | null => {
            if (!val || val === '--' || val === 'null') return null;
            // Handle "4 d" → 4 (stockoutDays format)
            const cleaned = val.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
            const n = parseFloat(cleaned);
            return isNaN(n) ? null : n;
        };

        // 1. GraphQL for all stock/demand metrics
        try {
            const query = {
                query: `{
                    productViewConnection(first: 1, productId: "${productId}") {
                        edges {
                            node {
                                stockOnHand
                                stockAvailable
                                stockOnOrder
                                stockoutDays
                                demandQuantity
                                consumptionQuantity
                                reorderQuantityToOrder
                            }
                        }
                    }
                }`
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });

            if (res.ok) {
                const result = await res.json();
                const node = result.data?.productViewConnection?.edges?.[0]?.node;
                if (node) {
                    profile.onHand = parseVal(node.stockOnHand);
                    profile.available = parseVal(node.stockAvailable);
                    profile.onOrder = parseVal(node.stockOnOrder);
                    profile.stockoutDays = parseVal(node.stockoutDays);
                    profile.demandQuantity = parseVal(node.demandQuantity);
                    profile.consumptionQuantity = parseVal(node.consumptionQuantity);
                    profile.reorderQuantityToOrder = parseVal(node.reorderQuantityToOrder);
                    // If we got ANY real values, Finale tracks this product
                    profile.hasFinaleData = (
                        profile.onHand !== null ||
                        profile.demandQuantity !== null ||
                        profile.consumptionQuantity !== null ||
                        profile.stockoutDays !== null
                    );
                }
            }
        } catch { /* continue with partial data */ }

        // 2. Committed POs for this component
        try {
            const pos = await this.findCommittedPOsForProduct(productId);
            profile.incomingPOs = pos.map(po => ({
                orderId: po.orderId,
                supplier: po.supplier,
                quantity: po.quantityOnOrder,
                orderDate: po.orderDate,
                expectedDelivery: po.expectedDelivery,
            }));
            if (pos.length > 0) {
                profile.onOrder = pos.reduce((sum, po) => sum + po.quantityOnOrder, 0);
                profile.hasFinaleData = true;
            }
        } catch { /* continue */ }

        // 3. Lead time from Finale product REST (single call, safe to fail)
        try {
            profile.leadTimeDays = await this.getLeadTime(productId);
        } catch { /* leave null */ }

        return profile;
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

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });

            if (res.ok) {
                const result = await res.json();
                if (!result.errors) {
                    const node = result.data?.productViewConnection?.edges?.[0]?.node;
                    if (node) finaleData = node;
                } else {
                    console.warn('Stock GraphQL error:', result.errors[0]?.message);
                }
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
     * Search products by keyword in name/description.
     * Uses Finale's GraphQL API to fetch products, then filters client-side.
     *
     * DECISION(2026-02-25): Finale's GraphQL doesn't support full-text search
     * on product names. The `productId` filter does substring matching, so we
     * use that as a first pass, then also fetch by broader criteria and filter
     * client-side by internalName (display name / description).
     *
     * @param keyword  - Search term (e.g. "kashi", "castings", "kelp")
     * @param limit    - Max results to return (default 20)
     * @returns Array of matching products with key fields
     */

    // In-memory product catalog cache (REST product list is 7,800+ items)
    private productCatalogCache: string[] | null = null;
    private catalogCacheTime: number = 0;
    private static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

    /**
     * Get the full product catalog (cached for 30 minutes).
     * Uses REST /api/product which returns all product URLs.
     */
    private async getProductCatalog(): Promise<string[]> {
        const now = Date.now();
        if (this.productCatalogCache && (now - this.catalogCacheTime) < FinaleClient.CACHE_TTL_MS) {
            return this.productCatalogCache;
        }

        try {
            const data = await this.get(`/${this.accountPath}/api/product`);
            if (data.productUrl && Array.isArray(data.productUrl)) {
                this.productCatalogCache = data.productUrl.map(
                    (url: string) => url.split('/').pop() || ''
                ).filter(Boolean);
                this.catalogCacheTime = now;
                return this.productCatalogCache!;
            }
        } catch (err: any) {
            console.error('Failed to load product catalog:', err.message);
        }
        return this.productCatalogCache || [];
    }

    async searchProducts(keyword: string, limit: number = 20): Promise<{
        results: Array<{
            productId: string;
            name: string;
            status: string;
            stockOnHand: string;
            stockAvailable: string;
            stockOnOrder: string;
        }>;
        telegramMessage: string;
    }> {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return { results: [], telegramMessage: '❌ No search keyword provided.' };

        try {
            // DECISION(2026-02-25): Use REST /api/product to get ALL product IDs,
            // then substring-match locally. This is necessary because:
            // 1. GraphQL's productId filter does exact match, not substring
            // 2. GraphQL productViewConnection only returns first N alphabetically
            // 3. REST returns all 7,800+ products as URL paths — very fast single call
            const catalog = await this.getProductCatalog();

            // Primary: substring match on SKU
            let matchedIds = catalog.filter(id => id.toLowerCase().includes(kw));

            // DECISION(2026-02-25): Fuzzy fallback when exact substring returns nothing.
            // Uses simple Levenshtein distance to find near-misses (e.g., typos like
            // "gnabar" → "GNARBAR02"). Only activates when exact matching fails.
            if (matchedIds.length === 0 && kw.length >= 3) {
                const fuzzyThreshold = Math.max(2, Math.floor(kw.length * 0.35));
                const fuzzyResults: Array<{ id: string; dist: number }> = [];

                for (const id of catalog) {
                    const idLower = id.toLowerCase();
                    // Check if any substring of the productId is close to the keyword
                    if (idLower.length < kw.length - fuzzyThreshold) continue;
                    const dist = this.levenshtein(kw, idLower.slice(0, kw.length + 2));
                    if (dist <= fuzzyThreshold) {
                        fuzzyResults.push({ id, dist });
                    }
                }

                fuzzyResults.sort((a, b) => a.dist - b.dist);
                matchedIds = fuzzyResults.map(r => r.id);
            }

            const truncatedIds = matchedIds.slice(0, limit);

            if (truncatedIds.length === 0) {
                return {
                    results: [],
                    telegramMessage: `🔍 No products found matching "${keyword}".\n_Try a different keyword or use /product <exact SKU>._`
                };
            }

            // DECISION(2026-02-25): Enrich results with names + stock via batch
            // GraphQL. We query up to 20 SKUs at once to get internalName and
            // stock data. This replaces the old "productId as name" approach.
            const enriched = await this.enrichSearchResults(truncatedIds);

            // Format Telegram message with enriched data
            let msg = `🔍 *${matchedIds.length} product(s) matching "${keyword}"*`;
            if (matchedIds.length > truncatedIds.length) {
                msg += ` _(showing first ${truncatedIds.length})_`;
            }
            msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;

            for (const p of enriched) {
                const nameLabel = p.name !== p.productId ? ` — ${p.name}` : '';
                const stockLabel = p.stockOnHand !== '--'
                    ? ` · 📦 ${p.stockOnHand}`
                    : '';
                msg += `\`${p.productId}\`${nameLabel}${stockLabel}\n`;
            }

            msg += `\n_Use \`/product <SKU>\` for full details on any item._`;

            return { results: enriched, telegramMessage: msg };

        } catch (err: any) {
            console.error('Product search error:', err.message);
            return { results: [], telegramMessage: `❌ Search failed: ${err.message}` };
        }
    }

    /**
     * Batch-query GraphQL to enrich a list of product IDs with names and stock.
     * Queries in batches of 10 to stay within Finale's query size limits.
     *
     * DECISION(2026-02-25): GraphQL productViewConnection can filter by productId
     * but only accepts a single value (exact match). We query them individually
     * but use Promise.allSettled with concurrency=5 for speed.
     */
    private async enrichSearchResults(productIds: string[]): Promise<Array<{
        productId: string;
        name: string;
        status: string;
        stockOnHand: string;
        stockAvailable: string;
        stockOnOrder: string;
    }>> {
        // Quick path: if ≤3 items, query individually for richer data
        // For larger sets, just return IDs without enrichment (fast path)
        if (productIds.length > 10) {
            // For large result sets, do a single batch query for just names
            return this.enrichBatchNames(productIds);
        }

        const results: Array<{
            productId: string;
            name: string;
            status: string;
            stockOnHand: string;
            stockAvailable: string;
            stockOnOrder: string;
        }> = [];

        // Query up to 5 concurrently
        const tasks = productIds.map(id => async () => {
            try {
                const query = {
                    query: `{
                        productViewConnection(first: 1, productId: "${id}") {
                            edges {
                                node {
                                    productId
                                    internalName
                                    statusId
                                    stockOnHand
                                    stockAvailable
                                    stockOnOrder
                                }
                            }
                        }
                    }`
                };

                const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                    method: "POST",
                    headers: {
                        Authorization: this.authHeader,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(query),
                });

                if (res.ok) {
                    const data = await res.json();
                    const node = data.data?.productViewConnection?.edges?.[0]?.node;
                    if (node) {
                        return {
                            productId: node.productId || id,
                            name: node.internalName || id,
                            status: node.statusId || 'PRODUCT_ACTIVE',
                            stockOnHand: node.stockOnHand || '--',
                            stockAvailable: node.stockAvailable || '--',
                            stockOnOrder: node.stockOnOrder || '--',
                        };
                    }
                }
            } catch { /* fall through to default */ }

            return {
                productId: id,
                name: id,
                status: 'PRODUCT_ACTIVE',
                stockOnHand: '--',
                stockAvailable: '--',
                stockOnOrder: '--',
            };
        });

        // Run with concurrency limit of 5
        const settled = await this.runPooled(tasks, 5);
        return settled;
    }

    /**
     * For larger result sets (>10), just fetch product names via REST
     * to avoid excessive GraphQL calls.
     */
    private async enrichBatchNames(productIds: string[]): Promise<Array<{
        productId: string;
        name: string;
        status: string;
        stockOnHand: string;
        stockAvailable: string;
        stockOnOrder: string;
    }>> {
        return productIds.map(id => ({
            productId: id,
            name: id, // REST catalog doesn't include names
            status: 'PRODUCT_ACTIVE',
            stockOnHand: '--',
            stockAvailable: '--',
            stockOnOrder: '--',
        }));
    }

    /**
     * Simple concurrency pool for async tasks.
     */
    private async runPooled<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
        const results: T[] = new Array(tasks.length);
        let nextIdx = 0;

        async function worker(): Promise<void> {
            while (nextIdx < tasks.length) {
                const idx = nextIdx++;
                results[idx] = await tasks[idx]();
            }
        }

        const workers = Array.from(
            { length: Math.min(concurrency, tasks.length) },
            () => worker()
        );
        await Promise.all(workers);
        return results;
    }

    /**
     * Compute the Levenshtein edit distance between two strings.
     * Used for fuzzy SKU matching when exact substring fails.
     */
    private levenshtein(a: string, b: string): number {
        const m = a.length;
        const n = b.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1]
                    ? dp[i - 1][j - 1]
                    : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }

        return dp[m][n];
    }

    // ──────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ──────────────────────────────────────────────────

    /**
     * Retrieve the Bill of Materials (BOM) for a given product.
     * Returns a list of required component SKUs and the quantity needed per 1 unit of the finished product.
     */
    async getBillOfMaterials(productId: string): Promise<Array<{ componentSku: string; quantity: number }>> {
        try {
            const data = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(productId)}`);

            if (!data.productAssocList || !Array.isArray(data.productAssocList)) {
                return [];
            }

            const manufAssoc = data.productAssocList.find((a: any) => a.productAssocTypeId === "MANUF_COMPONENT");
            if (!manufAssoc || !manufAssoc.productAssocItemList) {
                return [];
            }

            return manufAssoc.productAssocItemList.map((item: any) => ({
                componentSku: item.productId || "",
                quantity: item.quantity || 0
            })).filter((c: any) => c.componentSku && c.quantity > 0);

        } catch (err: any) {
            console.error(`Failed to fetch BOM for ${productId}:`, err.message);
            return [];
        }
    }

    /**
     * Fetch manufacturing/build orders completed after `since`.
     *
     * VERIFIED (2026-03-03): Finale exposes builds via GraphQL `buildViewConnection`.
     * - Filter: status=["Completed"], completeDateActual={ begin, afterInclusive: true }
     * - Date format: YYYY-MM-DD (en-CA locale, same as all other Finale date queries)
     * - Fields: buildId, quantityToProduce (String), completeTransactionTimestamp,
     *           productToProduce.productId
     *
     * Returns [] (never throws) — build watcher cron is always safe.
     */
    async getRecentlyCompletedBuilds(since: Date): Promise<Array<{
        buildId: string;
        buildUrl: string;
        sku: string;
        quantity: number;
        completedAt: string;
    }>> {
        const sinceDate = since.toLocaleDateString('en-CA', { timeZone: 'America/Denver' }); // YYYY-MM-DD

        try {
            // NOTE: The Finale `status` filter arg is non-functional (returns 0 regardless of value).
            // We filter client-side on status === "Completed" after fetching by date.
            const query = {
                query: `
                    query {
                        buildViewConnection(
                            first: 100
                            completeDateActual: { begin: "${sinceDate}", afterInclusive: true }
                            sort: [{ field: "completeDateActual", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    buildId
                                    buildUrl
                                    status
                                    quantityToProduce
                                    completeTransactionTimestamp
                                    productToProduce { productId }
                                }
                            }
                        }
                    }
                `
            };
            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            if (!res.ok) return [];
            const data = await res.json();
            if (data?.errors?.length) return [];

            const edges: any[] = data?.data?.buildViewConnection?.edges || [];
            return edges
                .filter((e: any) => e.node.status === 'Completed' && e.node.productToProduce?.productId)
                .map((e: any) => ({
                    buildId: e.node.buildId,
                    buildUrl: e.node.buildUrl || '',
                    sku: e.node.productToProduce.productId,
                    quantity: parseInt(e.node.quantityToProduce || '0', 10),
                    completedAt: e.node.completeTransactionTimestamp || '',
                }));
        } catch (err: any) {
            console.warn('[FinaleClient] getRecentlyCompletedBuilds failed:', err.message);
            return [];
        }
    }

    /**
     * H3 FIX: Retry wrapper with exponential backoff for transient Finale API failures.
     * Retries on: 5xx server errors, network failures, 429 rate limits.
     * Does NOT retry: 4xx client errors (bad request, not found, auth failure).
     *
     * @param fn       - Async function that performs the fetch
     * @param label    - Human-readable label for logging (e.g., "GET /api/order/123")
     * @param maxRetries - Maximum retry attempts (default: 3)
     */
    private async fetchWithRetry<T>(
        fn: () => Promise<Response>,
        label: string,
        maxRetries = 3
    ): Promise<T> {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fn();

                // 429 rate limit: wait 5s and retry
                if (response.status === 429 && attempt < maxRetries) {
                    console.warn(`[FinaleClient] 429 rate-limited on ${label} — waiting 5s (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                // 5xx server error: exponential backoff
                if (response.status >= 500 && attempt < maxRetries) {
                    const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                    console.warn(`[FinaleClient] ${response.status} on ${label} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }

                // Non-retryable error (4xx) or final attempt
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Finale API ${response.status}: ${response.statusText} — ${errorText.substring(0, 200)}`);
                }

                return await response.json() as T;
            } catch (err: any) {
                lastError = err;
                // Network error (not HTTP error): retry with backoff
                if (err.name === "TypeError" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") {
                    if (attempt < maxRetries) {
                        const delayMs = Math.pow(2, attempt) * 1000;
                        console.warn(`[FinaleClient] Network error on ${label}: ${err.message} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, delayMs));
                        continue;
                    }
                }
                throw err;
            }
        }
        throw lastError ?? new Error(`Finale API retry exhausted for ${label}`);
    }

    private async get(endpoint: string): Promise<any> {
        const url = `${this.apiBase}${endpoint}`;
        return this.fetchWithRetry(
            () => fetch(url, {
                method: "GET",
                headers: {
                    Authorization: this.authHeader,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
            }),
            `GET ${endpoint}`
        );
    }

    /**
     * POST to Finale REST API (used for all write/modification operations).
     * Finale uses POST for both creates and updates (full document replacement).
     * 
     * DECISION(2026-02-26): Finale's API uses POST for modifications, not PUT/PATCH.
     * The entire document is sent back with modifications.
     */
    private async post(endpoint: string, body: any): Promise<any> {
        const url = `${this.apiBase}${endpoint}`;
        return this.fetchWithRetry(
            () => fetch(url, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            }),
            `POST ${endpoint}`
        );
    }

    // ──────────────────────────────────────────────────
    // WRITE OPERATIONS (Phase 1 — Invoice Reconciliation)
    // ──────────────────────────────────────────────────

    /**
     * Fee type IDs from Finale's productpromo system.
     * These map invoice charge types to Finale's native fee/discount/tax entries
     * which automatically feed into landed cost per unit and COGS.
     * 
     * Discovered via Phase 0 API inspection (2026-02-26).
     */
    static readonly FINALE_FEE_TYPES = {
        FREIGHT: { id: "10007", url: "/buildasoilorganics/api/productpromo/10007", name: "Freight" },
        TAX: { id: "10008", url: "/buildasoilorganics/api/productpromo/10008", name: "Tax" },
        ESTIMATED_MAN: { id: "10009", url: "/buildasoilorganics/api/productpromo/10009", name: "Estimated Manual" },
        ESTIMATED_PCT: { id: "10010", url: "/buildasoilorganics/api/productpromo/10010", name: "Estimated 15%" },
        DISCOUNT_20: { id: "10011", url: "/buildasoilorganics/api/productpromo/10011", name: "Discount 20%" },
        DISCOUNT_10: { id: "10012", url: "/buildasoilorganics/api/productpromo/10012", name: "Discount 10%" },
        FREE: { id: "10013", url: "/buildasoilorganics/api/productpromo/10013", name: "Free" },
        TARIFF: { id: "10014", url: "/buildasoilorganics/api/productpromo/10014", name: "Duties/Tariff" },
        ALAN_TO_BAS: { id: "10015", url: "/buildasoilorganics/api/productpromo/10015", name: "Alan to BAS" },
        LABOR: { id: "10016", url: "/buildasoilorganics/api/productpromo/10016", name: "Labor" },
        SHIPPING: { id: "10017", url: "/buildasoilorganics/api/productpromo/10017", name: "Shipping" },
    } as const;

    /**
     * Fetch full PO details via REST API.
     * Returns the raw JSON document exactly as Finale stores it.
     * Used as the basis for GET → Modify → POST write operations.
     * 
     * @param orderId - The Finale orderId (e.g., "124409" or "23339077-DropshipPO")
     */
    async getOrderDetails(orderId: string): Promise<any> {
        return this.get(`/${this.accountPath}/api/order/${encodeURIComponent(orderId)}`);
    }

    /**
     * Unlock a PO for editing, regardless of whether it's Committed or Completed.
     * Returns the original statusId so the caller can restore it after edits.
     *
     * DECISION(2026-03-13): Extended to handle ORDER_COMPLETED POs using
     * actionUrlEdit, discovered during SV invoice reconciliation. The same
     * /edit endpoint works for both Committed and Completed POs.
     *
     * @param currentPO - The current PO document (mutated in place with unlocked state)
     * @param orderId   - The order ID (for re-fetching)
     * @returns The original statusId before unlocking
     */
    private async unlockForEditing(currentPO: any, orderId: string): Promise<string> {
        const originalStatus = currentPO.statusId;

        if ((originalStatus === "ORDER_LOCKED" || originalStatus === "ORDER_COMPLETED") && currentPO.actionUrlEdit) {
            await this.post(currentPO.actionUrlEdit, {});
            // Re-fetch after unlocking — status and available actions change
            const unlocked = await this.getOrderDetails(orderId);
            Object.assign(currentPO, unlocked);
        }

        return originalStatus;
    }

    /**
     * Restore a PO to committed (ORDER_LOCKED) status after editing.
     *
     * DECISION(2026-03-18): "No reception, no complete."
     * Uses direct statusId override (POST with statusId: "ORDER_LOCKED")
     * instead of actionUrlComplete, which Finale auto-promotes to
     * ORDER_COMPLETED even when zero units have been received.
     *
     * Direct statusId POST is reliable — tested and confirmed working.
     * PO always ends up committed, never auto-completed by our code.
     *
     * @param orderId       - The order ID
     * @param originalStatus - The status before we unlocked for editing
     */
    private async restoreOrderStatus(orderId: string, originalStatus: string): Promise<void> {
        if (originalStatus !== "ORDER_LOCKED" && originalStatus !== "ORDER_COMPLETED") {
            return; // Was a draft — leave as-is
        }

        const afterEdits = await this.getOrderDetails(orderId);

        if (afterEdits.statusId === "ORDER_CREATED") {
            // Direct statusId override → ORDER_LOCKED (committed).
            // Do NOT use actionUrlComplete — Finale auto-promotes to COMPLETED.
            await this.post(
                `/${this.accountPath}/api/order/${encodeURIComponent(orderId)}`,
                { ...afterEdits, statusId: "ORDER_LOCKED" }
            );
        }
        // If already ORDER_LOCKED, nothing to do.
    }

    /**
     * Add a fee/charge adjustment to a PO's orderAdjustmentList.
     * This uses Finale's native fee system and automatically affects landed cost per unit.
     *
     * Handles all PO states: Draft, Committed, and Completed.
     * Committed/Completed POs are unlocked, edited, then restored to original state.
     *
     * DECISION(2026-02-26): Uses GET → Modify → POST pattern. Must call actionUrlEdit
     * first if the PO is in Committed or Completed status to unlock it for editing.
     * UPDATED(2026-03-13): Extended to handle ORDER_COMPLETED POs and auto-restore status.
     *
     * @param orderId    - Finale order ID
     * @param feeType    - One of FINALE_FEE_TYPES keys (FREIGHT, TAX, TARIFF, etc.)
     * @param amount     - Dollar amount of the fee
     * @param description - Optional override for the description (defaults to fee type name)
     * @returns The updated order JSON, or throws on error
     */
    async addOrderAdjustment(
        orderId: string,
        feeType: keyof typeof FinaleClient.FINALE_FEE_TYPES,
        amount: number,
        description?: string
    ): Promise<any> {
        const fee = FinaleClient.FINALE_FEE_TYPES[feeType];
        const encodedId = encodeURIComponent(orderId);

        // 1. Fetch current PO state
        const currentPO = await this.getOrderDetails(orderId);

        // 2. Unlock if Committed or Completed
        const originalStatus = await this.unlockForEditing(currentPO, orderId);

        // 3. Upsert: remove any existing entries for this fee type, then add the new one.
        //    Prevents duplicate adjustment lines if called more than once.
        const promoUrl = `/${this.accountPath}/api/productpromo/${fee.id}`;
        const hint = (description || fee.name).toLowerCase().slice(0, 8);
        const adjustments = (currentPO.orderAdjustmentList || []).filter((adj: any) =>
            adj.productPromoUrl !== promoUrl &&
            !(adj.description || "").toLowerCase().includes(hint)
        );
        adjustments.push({
            amount,
            description: description || fee.name,
            productPromoUrl: promoUrl,
        });

        // 4. POST the updated PO with the new adjustment
        const updated = await this.post(
            `/${this.accountPath}/api/order/${encodedId}`,
            { ...currentPO, orderAdjustmentList: adjustments }
        );

        // 5. Restore original status (re-commit / re-complete)
        await this.restoreOrderStatus(orderId, originalStatus);

        return updated;
    }

    /**
     * Update the amount on an existing PO adjustment (e.g. Freight $0 → $4053.59).
     * Uses GET → find by productPromoUrl → update amount → POST pattern.
     * If the adjustment is not found by promo ID, falls back to description match.
     */
    async updateOrderAdjustmentAmount(
        orderId: string,
        feeType: keyof typeof FinaleClient.FINALE_FEE_TYPES,
        newAmount: number,
        descriptionHint?: string
    ): Promise<any> {
        const fee = FinaleClient.FINALE_FEE_TYPES[feeType];
        const encodedId = encodeURIComponent(orderId);
        const promoUrl = `/${this.accountPath}/api/productpromo/${fee.id}`;

        // 1. Fetch current PO state
        const currentPO = await this.getOrderDetails(orderId);

        // 2. Unlock if Committed or Completed
        const originalStatus = await this.unlockForEditing(currentPO, orderId);

        // 3. Consolidate: remove ALL entries for this fee type, add one at newAmount.
        //    This handles the case where a duplicate $0 + real amount entry exists.
        const hint = (descriptionHint || fee.name).toLowerCase().slice(0, 8);
        const adjustments = (currentPO.orderAdjustmentList || []).filter((adj: any) =>
            adj.productPromoUrl !== promoUrl &&
            !(adj.description || "").toLowerCase().includes(hint)
        ) as any[];
        adjustments.push({
            amount: newAmount,
            description: descriptionHint || fee.name,
            productPromoUrl: promoUrl,
        });

        // 4. POST back
        const updated = await this.post(
            `/${this.accountPath}/api/order/${encodedId}`,
            { ...currentPO, orderAdjustmentList: adjustments }
        );

        // 5. Restore original status
        await this.restoreOrderStatus(orderId, originalStatus);

        return updated;
    }

    /**
     * Update a specific line item's unit price on a PO.
     * Used when invoice price differs from PO price within auto-approval threshold,
     * or when reconciling vendor order confirmations against PO pricing.
     *
     * Handles all PO states: Draft, Committed, and Completed.
     * Committed/Completed POs are unlocked, edited, then restored to original state.
     *
     * UPDATED(2026-03-13): Extended to handle ORDER_COMPLETED POs via unlockForEditing.
     *
     * @param orderId     - Finale order ID
     * @param productId   - SKU of the line item to update
     * @param newUnitPrice - New unit price from the invoice
     * @returns Updated order JSON with the price change applied
     */
    async updateOrderItemPrice(
        orderId: string,
        productId: string,
        newUnitPrice: number
    ): Promise<{ updated: boolean; oldPrice: number; newPrice: number; orderData: any; supplierPartyUrl?: string }> {
        const encodedId = encodeURIComponent(orderId);
        const currentPO = await this.getOrderDetails(orderId);
        
        const supplierRole = (currentPO.orderRoleList || []).find((r: any) => r.roleTypeId === "SUPPLIER");
        const supplierPartyUrl = supplierRole?.partyId ? `/${this.accountPath}/api/partygroup/${supplierRole.partyId}` : undefined;

        // Unlock if Committed or Completed
        const originalStatus = await this.unlockForEditing(currentPO, orderId);

        // Find the matching line item
        const items = currentPO.orderItemList || [];
        const targetItem = items.find((item: any) => item.productId === productId);

        if (!targetItem) {
            // Restore status before throwing so we don't leave the PO in a draft state
            await this.restoreOrderStatus(orderId, originalStatus);
            throw new Error(`Product ${productId} not found in PO ${orderId}`);
        }

        const oldPrice = targetItem.unitPrice;
        targetItem.unitPrice = newUnitPrice;

        // POST the full document back
        const updated = await this.post(
            `/${this.accountPath}/api/order/${encodedId}`,
            currentPO
        );

        // Restore original status (re-commit / re-complete)
        await this.restoreOrderStatus(orderId, originalStatus);

        return { updated: true, oldPrice, newPrice: newUnitPrice, orderData: updated, supplierPartyUrl };
    }

    /**
     * Add new line items to an existing PO.
     * Used when a draft PO has no items and needs to be populated from an invoice.
     * Uses GET → Modify → POST pattern, same as updateOrderItemPrice.
     */
    async addItemsToPO(
        orderId: string,
        items: Array<{ productId: string; quantity: number; unitPrice: number }>
    ): Promise<void> {
        const encodedId = encodeURIComponent(orderId);
        const currentPO = await this.getOrderDetails(orderId);
        const originalStatus = await this.unlockForEditing(currentPO, orderId);

        const newItems = items.map(item => ({
            productUrl: `/${this.accountPath}/api/product/${encodeURIComponent(item.productId)}`,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
        }));

        currentPO.orderItemList = [...(currentPO.orderItemList || []), ...newItems];
        await this.post(`/${this.accountPath}/api/order/${encodedId}`, currentPO);
        await this.restoreOrderStatus(orderId, originalStatus);
    }

    /**
     * Updates the base supplier pricing for a SKU in Finale.
     * This ensures the NEXT PO automatically gets the most current pricing.
     * It finds the supplier's entry in the product's supplierList and updates the price.
     *
     * @param productId - SKU to update
     * @param supplierPartyUrl - The full API URL of the supplier
     * @param newPrice - The new base cost
     * @returns boolean - True if the supplier was found and updated, false otherwise.
     */
    async updateProductSupplierPrice(
        productId: string,
        supplierPartyUrl: string,
        newPrice: number
    ): Promise<boolean> {
        const encodedSku = encodeURIComponent(productId);
        const url = `/${this.accountPath}/api/product/${encodedSku}`;
        
        try {
            // 1. Fetch the product
            const product = await this.get(url);
            
            // 2. Find the supplier in the list
            let updated = false;
            for (const sup of product.supplierList || []) {
                if (sup.supplierPartyUrl === supplierPartyUrl) {
                    if (sup.price !== newPrice) {
                        sup.price = newPrice;
                        updated = true;
                    }
                }
            }

            // 3. POST back if changed
            if (updated) {
                await this.post(url, product);
                return true;
            }
            return false;
        } catch (error: any) {
            console.warn(`⚠️ [FinaleClient] Failed to update product supplier price for SKU ${productId}:`, error.message);
            // Don't throw — if this fails, we still want the primary PO reconciliation to succeed.
            // This is an optimization for *future* POs, not a critical failure for the *current* PO.
            return false;
        }
    }

    /**
     * Fetch full shipment details via REST API.
     * @param shipmentUrl - Full shipment URL path (e.g., "/buildasoilorganics/api/shipment/577917")
     */
    async getShipmentDetails(shipmentUrl: string): Promise<any> {
        return this.get(shipmentUrl);
    }

    /**
     * Update tracking information on a shipment.
     * Non-destructive: only modifies the fields you provide.
     * 
     * @param shipmentUrl  - Full shipment URL path from the PO's shipmentUrlList
     * @param updates      - Fields to update
     */
    async updateShipmentTracking(
        shipmentUrl: string,
        updates: {
            trackingCode?: string;
            shipDate?: string;
            receiveDateEstimated?: string;
            privateNotes?: string;
        }
    ): Promise<any> {
        // GET → Modify → POST
        const current = await this.get(shipmentUrl);

        if (updates.trackingCode !== undefined) current.trackingCode = updates.trackingCode;
        if (updates.shipDate !== undefined) current.shipDate = updates.shipDate;
        if (updates.receiveDateEstimated !== undefined) current.receiveDateEstimated = updates.receiveDateEstimated;
        if (updates.privateNotes !== undefined) {
            // Append to existing notes rather than overwrite
            const existing = current.privateNotes || "";
            current.privateNotes = existing
                ? `${existing}\n${updates.privateNotes}`
                : updates.privateNotes;
        }

        return this.post(shipmentUrl, current);
    }

    /**
     * Resolve a Finale PO by its orderId and return a summary for matching.
     * Enriches the raw data with supplier name for easier correlation.
     */
    async getOrderSummary(orderId: string): Promise<{
        orderId: string;
        orderDate: string;
        status: string;
        supplier: string;
        total: number;
        items: Array<{ productId: string; unitPrice: number; quantity: number; description: string }>;
        adjustments: Array<{ description: string; amount: number }>;
        shipmentUrls: string[];
        orderUrl: string;
    } | null> {
        try {
            const po = await this.getOrderDetails(orderId);

            // Resolve supplier name from role list
            let supplier = "Unknown";
            const supplierRole = (po.orderRoleList || []).find((r: any) => r.roleTypeId === "SUPPLIER");
            if (supplierRole?.partyId) {
                try {
                    supplier = await this.resolvePartyName(
                        `/${this.accountPath}/api/partygroup/${supplierRole.partyId}`
                    );
                } catch {
                    supplier = `Party#${supplierRole.partyId}`;
                }
            }

            return {
                orderId: po.orderId,
                orderDate: po.orderDate || "",
                status: po.statusId || "",
                supplier,
                total: po.orderItemListTotal || 0,
                items: (po.orderItemList || [])
                    .filter((item: any) => item.productId)
                    .map((item: any) => ({
                        productId: item.productId,
                        unitPrice: item.unitPrice || 0,
                        quantity: item.quantity || 0,
                        description: item.itemDescription || "",
                    })),
                adjustments: (po.orderAdjustmentList || []).map((adj: any) => ({
                    description: adj.description || "",
                    amount: adj.amount || 0,
                })),
                shipmentUrls: po.shipmentUrlList || [],
                orderUrl: po.orderUrl,
            };
        } catch (err: any) {
            console.error(`Failed to get order summary for ${orderId}:`, err.message);
            return null;
        }
    }

    /**
     * Resolve a Finale PO by supplier name and approximate date.
     * Used for fuzzy matching when invoice doesn't include a PO number.
     * Returns the best matching PO from recent orders.
     */
    async findPOByVendorAndDate(
        vendorName: string,
        invoiceDate: string,
        dayWindow: number = 30
    ): Promise<Array<{
        orderId: string;
        orderDate: string;
        supplier: string;
        total: number;
        status: string;
    }>> {
        try {
            const targetDate = new Date(invoiceDate);
            const beginDate = new Date(targetDate);
            beginDate.setDate(beginDate.getDate() - dayWindow);
            const endDate = new Date(targetDate);
            endDate.setDate(endDate.getDate() + 7); // Small forward window

            const begin = beginDate.toISOString().split("T")[0];
            const end = endDate.toISOString().split("T")[0];

            const query = {
                query: `{
                    orderViewConnection(
                        first: 50
                        type: ["PURCHASE_ORDER"]
                        orderDate: { begin: "${begin}", end: "${end}" }
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges {
                            node {
                                orderId
                                orderUrl
                                status
                                orderDate
                                total
                                supplier { name }
                            }
                        }
                    }
                }`
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            });

            if (!res.ok) return [];
            const result = await res.json();
            const edges = result.data?.orderViewConnection?.edges || [];

            // Filter by vendor name (case-insensitive partial match)
            const vendorLower = vendorName.toLowerCase();
            return edges
                .filter((e: any) => {
                    const supplierName = (e.node.supplier?.name || "").toLowerCase();
                    return supplierName.includes(vendorLower) || vendorLower.includes(supplierName);
                })
                .map((e: any) => ({
                    orderId: e.node.orderId,
                    orderDate: e.node.orderDate || "",
                    supplier: e.node.supplier?.name || "Unknown",
                    total: parseFloat(e.node.total) || 0,
                    status: e.node.status || "",
                }));
        } catch (err: any) {
            console.error(`Failed vendor+date PO search:`, err.message);
            return [];
        }
    }

    /**
     * Search for a vendor's partyId by name.
     *
     * DECISION(2026-03-16): Finale has no direct "search parties by name" API.
     * Instead, we search recent POs and extract the supplier partyId from matches.
     * Falls back to scanning all open/committed POs if the date-windowed search
     * misses (e.g., vendor hasn't been ordered from recently).
     *
     * @param   vendorName - Vendor name to search for (case-insensitive partial match)
     * @returns partyId if found, null otherwise
     */
    async findVendorPartyByName(vendorName: string): Promise<string | null> {
        try {
            const vendorLower = vendorName.toLowerCase();

            // Strategy 1: Search recent POs (last 90 days) for this vendor
            const now = new Date();
            const begin = new Date(now);
            begin.setDate(begin.getDate() - 90);
            const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            const endStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

            const query = {
                query: `{
                    orderViewConnection(
                        first: 100
                        type: ["PURCHASE_ORDER"]
                        orderDate: { begin: "${beginStr}", end: "${endStr}" }
                        sort: [{ field: "orderDate", mode: "desc" }]
                    ) {
                        edges { node {
                            supplier { name partyUrl }
                        }}
                    }
                }`
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });

            if (!res.ok) return null;
            const result = await res.json();
            const edges = result.data?.orderViewConnection?.edges || [];

            for (const edge of edges) {
                const supplierName = (edge.node.supplier?.name || '').toLowerCase();
                const partyUrl = edge.node.supplier?.partyUrl || '';
                if (!partyUrl) continue;

                // Check both directions for partial match
                if (supplierName.includes(vendorLower) || vendorLower.includes(supplierName)) {
                    const partyId = partyUrl.split('/').pop();
                    if (partyId) {
                        console.log(`[finale] findVendorPartyByName: "${vendorName}" → partyId ${partyId} (from PO history)`);
                        return partyId;
                    }
                }
            }

            // Strategy 2: Search ALL open/committed POs (no date filter)
            const openQuery = {
                query: `{
                    orderViewConnection(
                        first: 200
                        type: ["PURCHASE_ORDER"]
                        statusId: ["ORDER_CREATED", "ORDER_COMMITTED"]
                    ) {
                        edges { node {
                            supplier { name partyUrl }
                        }}
                    }
                }`
            };

            const openRes = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(openQuery),
            });

            if (!openRes.ok) return null;
            const openResult = await openRes.json();
            const openEdges = openResult.data?.orderViewConnection?.edges || [];

            for (const edge of openEdges) {
                const supplierName = (edge.node.supplier?.name || '').toLowerCase();
                const partyUrl = edge.node.supplier?.partyUrl || '';
                if (!partyUrl) continue;

                if (supplierName.includes(vendorLower) || vendorLower.includes(supplierName)) {
                    const partyId = partyUrl.split('/').pop();
                    if (partyId) {
                        console.log(`[finale] findVendorPartyByName: "${vendorName}" → partyId ${partyId} (from open POs)`);
                        return partyId;
                    }
                }
            }

            console.warn(`[finale] findVendorPartyByName: no party found for "${vendorName}"`);
            return null;
        } catch (err: any) {
            console.error(`[finale] findVendorPartyByName error:`, err.message);
            return null;
        }
    }

    /**
     * Resolve a partygroup URL to the supplier name.
     * Caches results so we don't re-fetch for the same vendor.
     */
    private async resolvePartyName(partyUrl: string): Promise<string> {
        const cache = this.getPartyNameCache();
        if (cache.has(partyUrl)) {
            return cache.get(partyUrl)!;
        }

        try {
            const data = await this.get(partyUrl);
            const name = data.groupName || data.partyId || "Unknown";
            cache.set(partyUrl, name);
            return name;
        } catch {
            return "Unknown";
        }
    }

    /**
     * Parse raw product detail and resolve supplier names.
     */
    private async parseProductDetail(data: any): Promise<FinaleProductDetail> {
        // Resolve suppliers (1 API call each, cached)
        const suppliers: SupplierInfo[] = [];
        for (const sup of data.supplierList || []) {
            if (!sup.supplierPartyUrl) continue;

            const name = await this.resolvePartyName(sup.supplierPartyUrl);
            const roleRaw = sup.supplierPrefOrderId || "";

            let role = "ALT";
            if (roleRaw.includes("MAIN")) role = "MAIN";

            suppliers.push({
                name,
                role,
                cost: sup.price ?? null,
                partyUrl: sup.supplierPartyUrl,
            });
        }

        // Determine if manufactured
        // DOMAIN RULE: If primary supplier starts with "BuildASoil" or "Manufacturing"
        const mainSupplier = suppliers.find(s => s.role === "MAIN");
        const isManufactured = mainSupplier
            ? /^(buildasoil|manufacturing)/i.test(mainSupplier.name)
            : false;

        const hasBOM = !!data.expandBillOfMaterialsPolicy;

        return {
            productId: data.productId,
            name: data.internalName || data.productId,
            statusId: data.statusId || "UNKNOWN",
            leadTimeDays: data.leadTime ?? null,
            packing: data.normalizedPackingString || null,
            category: data.userCategory || null,
            lastUpdated: data.lastUpdatedDate || null,
            suppliers,
            isManufactured,
            hasBOM,
            doNotReorder: FinaleClient.isDoNotReorder(data),
            finaleUrl: data.productUrl || "",
            openPOs: [],  // Populated later by lookupProduct()
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
    }>> {
        const result = new Map<string, {
            dailyRate: number;
            stockOnHand: number | null;
            daysOfFinishedStock: number | null;
            openDemandQty: number;
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
                    const daysOfFinishedStock =
                        data.stockOnHand !== null && dailyRate > 0
                            ? Math.round(data.stockOnHand / dailyRate)
                            : null;
                    result.set(sku, {
                        dailyRate,
                        stockOnHand: data.stockOnHand,
                        daysOfFinishedStock,
                        openDemandQty: data.openDemandQty,
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
     * Fetch all purchase orders placed within the last N days (all statuses).
     * Used by the purchasing calendar sync to create/update calendar events.
     *
     * Includes Finale's deliverDate (quoted expected delivery) as expectedDate.
     * Never throws — returns empty array on any error.
     */
    async getRecentPurchaseOrders(daysBack: number = 7, limit: number = 500): Promise<FullPO[]> {
        try {
            const now = new Date();
            const end = new Date(now);
            end.setDate(end.getDate() + 1);
            const beginDate = new Date(now);
            beginDate.setDate(beginDate.getDate() - daysBack);

            const beginStr = beginDate.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: ${limit}
                            type: ["PURCHASE_ORDER"]
                            orderDate: { begin: "${beginStr}", end: "${endStr}" }
                            sort: [{ field: "orderDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    orderUrl
                                    status
                                    orderDate
                                    dueDate
                                    receiveDate
                                    total
                                    supplier { name }
                                    shipmentList {
                                        shipmentId
                                        status
                                        shipDate
                                        receiveDate
                                    }
                                    itemList(first: 50) {
                                        edges {
                                            node {
                                                product { productId }
                                                quantity
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                `
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });

            if (!res.ok) return [];
            const result = await res.json();
            if (result.errors) {
                console.error('[finale] getRecentPurchaseOrders error:', result.errors[0]?.message);
                return [];
            }

            const edges = result.data?.orderViewConnection?.edges || [];
            return edges.map((edge: any) => {
                const po = edge.node;
                const items = (po.itemList?.edges || [])
                    .map((e: any) => ({ productId: e.node?.product?.productId ?? '', quantity: e.node?.quantity ?? 0 }))
                    .filter((i: any) => i.productId);
                // Normalize any date to YYYY-MM-DD (Finale returns inconsistent formats like "4/2/2026")
                const toISODate = (d: string | null | undefined): string | null => {
                    if (!d) return null;
                    const parsed = new Date(d);
                    return isNaN(parsed.getTime()) ? null : parsed.toISOString().split('T')[0];
                };
                const shipments = (po.shipmentList || []).map((s: any) => ({
                    shipmentId: s.shipmentId,
                    status: s.status,
                    receiveDate: toISODate(s.receiveDate),
                    shipDate: toISODate(s.shipDate),
                }));
                return {
                    orderId: po.orderId,
                    vendorName: po.supplier?.name ?? '',
                    orderDate: toISODate(po.orderDate) ?? '',
                    expectedDate: toISODate(po.dueDate),
                    receiveDate: toISODate(po.receiveDate),
                    status: po.status ?? '',
                    total: parseFinaleNumber(po.total),
                    items,
                    finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/sc2/?order/purchase/order/${Buffer.from(po.orderUrl || '').toString('base64')}`,
                    shipments
                } as FullPO;
            });
        } catch (err: any) {
            console.error('[finale] getRecentPurchaseOrders error:', err.message);
            return [];
        }
    }

    /**
     * Compute median actual lead time per vendor from the last N days of completed POs.
     * Only includes vendors with ≥ 3 completed POs (insufficient data otherwise).
     *
     * Used by the purchasing calendar sync to estimate expected arrival dates when
     * Finale's deliverDate is absent or unreliable.
     *
     * Returns Map<vendorName, medianDays>.
     * Never throws — returns empty Map on any error.
     */
    async getVendorLeadTimeHistory(daysBack: number = 90): Promise<Map<string, number>> {
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
                                    status
                                    orderDate
                                    receiveDate
                                    supplier { name }
                                }
                            }
                        }
                    }
                `
            };

            const res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });

            if (!res.ok) return new Map();
            const result = await res.json();
            if (result.errors) return new Map();

            const edges = result.data?.orderViewConnection?.edges || [];
            // Group lead times by vendor
            const byVendor = new Map<string, number[]>();
            for (const edge of edges) {
                const po = edge.node;
                if (po.status !== 'Completed') continue;
                if (!po.orderDate || !po.receiveDate) continue;
                const vendor = po.supplier?.name;
                if (!vendor) continue;
                const orderMs = new Date(po.orderDate).getTime();
                const receiveMs = new Date(po.receiveDate).getTime();
                if (isNaN(orderMs) || isNaN(receiveMs)) continue;
                const days = Math.round((receiveMs - orderMs) / 86_400_000);
                if (days < 0 || days > 365) continue; // sanity check
                if (!byVendor.has(vendor)) byVendor.set(vendor, []);
                byVendor.get(vendor)!.push(days);
            }

            // Compute median for vendors with ≥ 3 data points
            const result2 = new Map<string, number>();
            for (const [vendor, days] of byVendor) {
                if (days.length < 3) continue;
                const sorted = [...days].sort((a, b) => a - b);
                const mid = Math.floor(sorted.length / 2);
                const median = sorted.length % 2 === 0
                    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
                    : sorted[mid];
                result2.set(vendor, median);
            }
            return result2;
        } catch (err: any) {
            console.error('[finale] getVendorLeadTimeHistory error:', err.message);
            return new Map();
        }
    }

    // ──────────────────────────────────────────────────
    // EXTERNAL REORDER ASSESSMENT
    // ──────────────────────────────────────────────────

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
                    if (FinaleClient.isDoNotReorder(prod)) {
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
                        isBulkDelivery: FinaleClient.isBulkDelivery(prod),
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
    ): Promise<{ orderId: string; finaleUrl: string; facilityName: string; duplicateWarnings: string[]; priceAlerts: string[] }> {
        const today = new Date().toISOString().split('T')[0] + 'T00:00:00';

        // ── Step 0: Duplicate PO detection ──────────────────────────────────
        // DECISION(2026-03-04): Check for existing open/committed POs from the same
        // vendor with overlapping SKUs. We warn but still create — the caller decides.
        const duplicateWarnings: string[] = [];
        try {
            const productIds = items.map(i => i.productId);
            const dups = await this.checkDuplicatePOs(vendorPartyId, productIds);
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
            const snapped = FinaleClient.snapToIncrement(rawQty, item.orderIncrementQty ?? null);

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
        const rawOrderUrl = data.orderUrl || `/${this.accountPath}/api/order/${orderId}`;
        const encodedUrl = Buffer.from(rawOrderUrl).toString('base64');
        const finaleUrl = `${this.apiBase}/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`;

        console.log(`[finale] createDraftPurchaseOrder: created PO #${orderId} for party ${vendorPartyId} (${items.length} items) → ${facilityName}${facilityUrl ? '' : ' (facility URL not found)'}`);
        if (duplicateWarnings.length > 0) console.log(`[finale] Duplicate warnings: ${duplicateWarnings.join(' | ')}`);
        if (priceAlerts.length > 0) console.log(`[finale] Price alerts: ${priceAlerts.join(' | ')}`);
        return { orderId, finaleUrl, facilityName, duplicateWarnings, priceAlerts };
    }

    // ──────────────────────────────────────────────────
    // PURCHASING INTELLIGENCE
    // ──────────────────────────────────────────────────

    /**
     * Combines purchase history, sales history, and committed open POs into a single
     * GraphQL request using field aliases. Replaces three separate calls
     * (getPurchasedQty + getSalesQty + findCommittedPOsForProduct) used by
     * getPurchasingIntelligence, requesting only the fields that method needs.
     *
     * purchasedIn / soldIn  — date-windowed velocity signals
     * committedPOs          — all-time open supply (no date filter; Committed = always current)
     */
    private async getProductActivity(sku: string, daysBack: number): Promise<{
        purchasedQty: number;
        soldQty: number;
        openPOs: Array<{ orderId: string; quantityOnOrder: number; orderDate: string }>;
        stockOnHand: number | null;
        stockAvailable: number | null;
        reorderQuantityToOrder: number | null;
        stockoutDays: number | null;
        demandQuantity: number | null;
        demandPerDay: number | null;
        consumptionQuantity: number | null;
    }> {
        const end = new Date();
        const begin = new Date();
        begin.setDate(begin.getDate() - daysBack);
        const beginStr = begin.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const endStr = end.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
        const productUrl = `/${this.accountPath}/api/product/${sku}`;

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
                        reorderQuantityToOrder
                        stockoutDays
                        demandQuantity
                        demandPerDay
                        consumptionQuantity
                    }}
                }
            }`
        };

        try {
            let res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                method: 'POST',
                headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            // 429 rate-limit backoff: wait 5s and retry once
            if (res.status === 429) {
                console.warn(`[finale] rate limited on ${sku} activity query — backing off 5s`);
                await new Promise(r => setTimeout(r, 5000));
                res = await fetch(`${this.apiBase}/${this.accountPath}/api/graphql`, {
                    method: 'POST',
                    headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
                    body: JSON.stringify(query),
                });
            }
            if (!res.ok) {
                return {
                    purchasedQty: 0,
                    soldQty: 0,
                    openPOs: [],
                    stockOnHand: null,
                    stockAvailable: null,
                    reorderQuantityToOrder: null,
                    stockoutDays: null,
                    demandQuantity: null,
                    demandPerDay: null,
                    consumptionQuantity: null,
                };
            }
            const result = await res.json();
            if (result.errors) {
                return {
                    purchasedQty: 0,
                    soldQty: 0,
                    openPOs: [],
                    stockOnHand: null,
                    stockAvailable: null,
                    reorderQuantityToOrder: null,
                    stockoutDays: null,
                    demandQuantity: null,
                    demandPerDay: null,
                    consumptionQuantity: null,
                };
            }

            let purchasedQty = 0;
            for (const edge of result.data?.purchasedIn?.edges || []) {
                const po = edge.node;
                if (po.status !== 'Completed') continue;
                for (const ie of po.itemList?.edges || []) {
                    if (ie.node.product?.productId === sku) {
                        purchasedQty += parseFinaleNumber(ie.node.quantity);
                        break;
                    }
                }
            }

            let soldQty = 0;
            for (const edge of result.data?.soldIn?.edges || []) {
                const so = edge.node;
                if (so.status !== 'Completed' && so.status !== 'Shipped') continue;
                for (const ie of so.itemList?.edges || []) {
                    if (ie.node.product?.productId === sku) {
                        soldQty += parseFinaleNumber(ie.node.quantity);
                        break;
                    }
                }
            }

            const openPOs: Array<{ orderId: string; quantityOnOrder: number; orderDate: string }> = [];
            for (const edge of result.data?.committedPOs?.edges || []) {
                const po = edge.node;
                // DECISION(2026-03-16): Only 'Committed' status means truly open/outstanding.
                // ORDER_LOCKED, Completed, Received, etc. are already fulfilled.
                // Previously this filter let ORDER_LOCKED POs through, inflating on-order qty.
                if (po.status !== 'Committed') continue;
                for (const ie of po.itemList?.edges || []) {
                    if (ie.node.product?.productId === sku) {
                        openPOs.push({
                            orderId: po.orderId,
                            quantityOnOrder: parseFinaleNumber(ie.node.quantity) || 0,
                            orderDate: po.orderDate || '',
                        });
                        break;
                    }
                }
            }

            // Parse stock from the piggy-backed productViewConnection query
            const stockNode = result.data?.stockInfo?.edges?.[0]?.node;
            const parseStockVal = (val: string | null | undefined): number | null => {
                if (!val || val === '--' || val === 'null') return null;
                const n = parseFloat(val.replace(/,/g, ''));
                return isNaN(n) ? null : n;
            };
            // DECISION(2026-03-23): Prefer unitsInStock over stockOnHand.
            // stockOnHand returns 0 for many products; unitsInStock returns the
            // real physical count (verified against Finale UI for ULINE items).
            const stockOnHand = stockNode
                ? (parseStockVal(stockNode.unitsInStock) ?? parseStockVal(stockNode.stockOnHand))
                : null;
            const stockAvailable = stockNode ? parseStockVal(stockNode.stockAvailable) : null;
            const reorderQuantityToOrder = stockNode ? parseStockVal(stockNode.reorderQuantityToOrder) : null;
            const stockoutDays = stockNode ? parseStockVal(stockNode.stockoutDays) : null;
            const demandQuantity = stockNode ? parseStockVal(stockNode.demandQuantity) : null;
            const demandPerDay = stockNode ? parseStockVal(stockNode.demandPerDay) : null;
            const consumptionQuantity = stockNode ? parseStockVal(stockNode.consumptionQuantity) : null;

            return {
                purchasedQty,
                soldQty,
                openPOs,
                stockOnHand,
                stockAvailable,
                reorderQuantityToOrder,
                stockoutDays,
                demandQuantity,
                demandPerDay,
                consumptionQuantity,
            };
        } catch {
            return {
                purchasedQty: 0,
                soldQty: 0,
                openPOs: [],
                stockOnHand: null,
                stockAvailable: null,
                reorderQuantityToOrder: null,
                stockoutDays: null,
                demandQuantity: null,
                demandPerDay: null,
                consumptionQuantity: null,
            };
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
    async getPurchasingIntelligence(daysBack = 365): Promise<PurchasingGroup[]> {
        const PAGE_SIZE = 500;

        // ── Step 1: Page productViewConnection — presence signal only ──
        // Two signals qualify a product as "actively moving":
        //   - reorderQuantityToOrder > 0  : Finale is flagging it for reorder (covers purchased-for-resale)
        //   - consumptionQuantity > 0     : BOM consumption (covers purchased components)
        // NOTE: consumptionQuantity alone misses purchased-for-resale items (boxes, packaging, etc.)
        // which have consumptionQuantity=0 but reorderQuantityToOrder>0 and demandQuantity>0.
        const candidates: Array<{ productId: string, finaleReorderQty: number | null, finaleStockoutDays: number | null, finaleConsumptionQty: number | null, finaleDemandQty: number | null, finaleDemandPerDay: number | null }> = [];
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
                candidates.push({
                    productId: p.productId,
                    finaleReorderQty: reorderQty,
                    finaleStockoutDays: stockoutDays,
                    finaleConsumptionQty: consumption,
                    finaleDemandQty: demandQty,
                    finaleDemandPerDay: demandPerDay,
                });
            }

            if (!conn.pageInfo.hasNextPage) break;
            cursor = conn.pageInfo.endCursor;
        }

        console.log(`[finale] getPurchasingIntelligence: ${candidates.length} candidates found`);
        if (candidates.length === 0) return [];

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
                    if (FinaleClient.isDoNotReorder(prodData)) continue;

                    // Step C: Single combined GraphQL request — purchase history + sales history + open POs
                    const activity = await this.getProductActivity(sku, daysBack);

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                    const productName: string = prodData.internalName || prodData.productId || sku;
                    const unitPrice: number = mainSupplier.price ?? 0;

                    // Lead time: REST product field → 14d default
                    const rawLeadTime = prodData.leadTime != null ? parseInt(String(prodData.leadTime), 10) : NaN;
                    const leadTimeDays = !isNaN(rawLeadTime) && rawLeadTime > 0 ? rawLeadTime : 14;
                    const leadTimeProvenance = !isNaN(rawLeadTime) && rawLeadTime > 0
                        ? `${rawLeadTime}d (Finale)`
                        : '14d default';

                    // DECISION(2026-03-16): Use GraphQL stock from getProductActivity().
                    // REST prodData.quantityOnHand is always undefined for these products,
                    // which caused all stock to default to 0 → every item flagged critical.
                    // GraphQL productViewConnection returns real stock (same as getSalesQty).
                    const stockOnHand = activity.stockOnHand ?? parseFinaleNumber(prodData.quantityOnHand ?? prodData.stockLevel ?? 0);

                    // Open PO supply
                    const stockOnOrder = activity.openPOs.reduce((sum, po) => sum + po.quantityOnOrder, 0);

                    // Step 4: velocity + runway
                    // DECISION(2026-03-23): Use max(demandVelocity, purchaseVelocity).
                    // Verified against 2yr ULINE order history CSV (730 days, 530 line items):
                    //   - Boxes (S-4128): purchase vel 17.8/d ≈ ULINE cadence 15.4/d ✅
                    //     Finale demand = 0 because boxes consumed via stock changes, not sales/BOMs.
                    //   - Jugs (FJG102): purchase vel 2.5/d, demand 0.11/d, ULINE cadence 1.8/d
                    //     max() = 2.5/d — slightly aggressive but ensures no stockout ✅
                    //   - Direct-sell items: demand captures BOM+sales, purchase ≈ demand ✅
                    // Using max() is simplest and safest: highest known signal = "never run out".
                    // Previous cascade (demand→sales→purchase) made boxes invisible (demand=0).
                    const purchaseVelocity = activity.purchasedQty / daysBack;
                    const salesVelocity = activity.soldQty / daysBack;

                    // Demand velocity: prefer demandPerDay (direct field) → demandQuantity / 90
                    const demandVelocity = candidate.finaleDemandPerDay != null && candidate.finaleDemandPerDay > 0
                        ? candidate.finaleDemandPerDay
                        : candidate.finaleDemandQty != null && candidate.finaleDemandQty > 0
                            ? candidate.finaleDemandQty / 90
                            : 0;

                    // Best velocity = highest known consumption signal
                    const dailyRate = Math.max(demandVelocity, purchaseVelocity);
                    if (dailyRate === 0) continue; // no actual movement

                    // Identify which signal is driving the rate (for explanation)
                    const rateSource = dailyRate === demandVelocity ? '90d demand'
                        : `${daysBack}d receipts`;

                    const runwayDays = stockOnHand / dailyRate;
                    const adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyRate;

                    // Step 6: urgency based on ADJUSTED runway (on-hand + on-order)
                    // DECISION(2026-03-09): Changed from raw runwayDays to adjustedRunwayDays.
                    // Previously used on-hand only, which caused items with active POs
                    // (In Transit) to falsely flag as CRIT even when incoming supply covers demand.
                    const urgency: PurchasingItem['urgency'] =
                        adjustedRunwayDays < leadTimeDays ? 'critical'
                            : adjustedRunwayDays < leadTimeDays + 30 ? 'warning'
                                : adjustedRunwayDays < leadTimeDays + 60 ? 'watch'
                                    : 'ok';
                    const parts: string[] = [
                        `Avg ${dailyRate.toFixed(1)}/day (${rateSource})`,
                        `${Math.round(stockOnHand)} in stock → ${Math.round(runwayDays)}d`,
                        `Lead ${leadTimeDays}d`,
                    ];
                    if (stockOnOrder > 0) {
                        parts.push(`${activity.openPOs.length} open PO (+${Math.round(stockOnOrder)}) → ${Math.round(adjustedRunwayDays)}d adjusted`);
                    }
                    const urgencyNote = urgency === 'critical' ? 'order now, already short'
                        : urgency === 'warning' ? 'order soon'
                            : urgency === 'watch' ? 'monitor'
                                : 'covered';
                    const explanation = parts.join(' · ') + ` — ${urgencyNote}.`;

                    // Step 8: suggested qty — uses product's order increment if set, otherwise no rounding
                    // DECISION(2026-03-04): Formerly hard-coded round-to-50. Now respects
                    // the product's "Std reorder in qty of" field from Finale.
                    // If no increment configured, raw quantity passes through unchanged.
                    const orderIncrementQty = this.parseFinaleNum(prodData.orderIncrementQuantity);
                    const rawSuggestedQty = Math.max(1, dailyRate * (leadTimeDays + 60));
                    const suggestedQty = Math.ceil(FinaleClient.snapToIncrement(rawSuggestedQty, orderIncrementQty));

                    // Bulk delivery detection for facility routing
                    const isBulkDelivery = FinaleClient.isBulkDelivery(prodData);

                    items.push({
                        productId: sku,
                        productName,
                        supplierName: party.groupName,
                        supplierPartyId: partyId,
                        unitPrice,
                        stockOnHand,
                        stockOnOrder,
                        purchaseVelocity,
                        salesVelocity,
                        demandVelocity,
                        dailyRate,
                        runwayDays,
                        adjustedRunwayDays,
                        leadTimeDays,
                        leadTimeProvenance,
                        openPOs: activity.openPOs.map(po => ({
                            orderId: po.orderId,
                            quantity: po.quantityOnOrder,
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
        return groups;
    }

    async getPurchasingIntelligenceForSkus(skus: string[], daysBack = 90): Promise<PurchasingGroup[]> {
        const candidates: PurchasingIntelligenceCandidate[] = [];
        const preloadedActivity = new Map<string, Awaited<ReturnType<FinaleClient["getProductActivity"]>>>();
        const normalizedSkus = [...new Set(
            skus
                .map((sku) => sku.trim().toUpperCase())
                .filter(Boolean),
        )];

        for (const sku of normalizedSkus) {
            const activity = await this.getProductActivity(sku, daysBack);
            preloadedActivity.set(sku, activity);
            candidates.push({
                productId: sku,
                finaleReorderQty: activity.reorderQuantityToOrder,
                finaleStockoutDays: activity.stockoutDays,
                finaleConsumptionQty: activity.consumptionQuantity,
                finaleDemandQty: activity.demandQuantity,
                finaleDemandPerDay: activity.demandPerDay,
            });
        }

        console.log(`[finale] getPurchasingIntelligenceForSkus: ${candidates.length} requested`);
        if (candidates.length === 0) return [];

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

        await Promise.all(Array.from({ length: 3 }, async () => {
            while (queue.length > 0) {
                const candidate = queue.shift()!;
                const sku = candidate.productId;
                try {
                    const prodData = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(sku)}`);
                    const suppliers: any[] = prodData.supplierList || [];
                    const mainSupplier = suppliers.find(s => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
                    if (!mainSupplier?.supplierPartyUrl) continue;

                    const party = await resolveParty(mainSupplier.supplierPartyUrl);
                    if (party.isManufactured || party.isDropship) continue;
                    if (FinaleClient.isDoNotReorder(prodData)) continue;

                    const activity = preloadedActivity.get(sku) ?? await this.getProductActivity(sku, daysBack);

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop() || '';
                    const productName: string = prodData.internalName || prodData.productId || sku;
                    const unitPrice: number = mainSupplier.price ?? 0;
                    const rawLeadTime = prodData.leadTime != null ? parseInt(String(prodData.leadTime), 10) : NaN;
                    const leadTimeDays = !isNaN(rawLeadTime) && rawLeadTime > 0 ? rawLeadTime : 14;
                    const leadTimeProvenance = !isNaN(rawLeadTime) && rawLeadTime > 0
                        ? `${rawLeadTime}d (Finale)`
                        : '14d default';
                    const stockOnHand = activity.stockOnHand ?? parseFinaleNumber(prodData.quantityOnHand ?? prodData.stockLevel ?? 0);
                    const stockOnOrder = activity.openPOs.reduce((sum, po) => sum + po.quantityOnOrder, 0);

                    const purchaseVelocity = activity.purchasedQty / daysBack;
                    const salesVelocity = activity.soldQty / daysBack;
                    const demandVelocity = activity.demandPerDay != null && activity.demandPerDay > 0
                        ? activity.demandPerDay
                        : activity.demandQuantity != null && activity.demandQuantity > 0
                            ? activity.demandQuantity / 90
                            : 0;

                    const dailyRate = Math.max(demandVelocity, purchaseVelocity);
                    if (dailyRate === 0) continue;

                    const rateSource = dailyRate === demandVelocity ? '90d demand'
                        : `${daysBack}d receipts`;
                    const runwayDays = stockOnHand / dailyRate;
                    const adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyRate;
                    const urgency: PurchasingItem['urgency'] =
                        adjustedRunwayDays < leadTimeDays ? 'critical'
                            : adjustedRunwayDays < leadTimeDays + 30 ? 'warning'
                                : adjustedRunwayDays < leadTimeDays + 60 ? 'watch'
                                    : 'ok';
                    const parts: string[] = [
                        `Avg ${dailyRate.toFixed(1)}/day (${rateSource})`,
                        `${Math.round(stockOnHand)} in stock → ${Math.round(runwayDays)}d`,
                        `Lead ${leadTimeDays}d`,
                    ];
                    if (stockOnOrder > 0) {
                        parts.push(`${activity.openPOs.length} open PO (+${Math.round(stockOnOrder)}) → ${Math.round(adjustedRunwayDays)}d adjusted`);
                    }
                    const urgencyNote = urgency === 'critical' ? 'order now, already short'
                        : urgency === 'warning' ? 'order soon'
                            : urgency === 'watch' ? 'monitor'
                                : 'covered';
                    const explanation = parts.join(' · ') + ` — ${urgencyNote}.`;

                    const orderIncrementQty = this.parseFinaleNum(prodData.orderIncrementQuantity);
                    const rawSuggestedQty = Math.max(1, dailyRate * (leadTimeDays + 60));
                    const suggestedQty = Math.ceil(FinaleClient.snapToIncrement(rawSuggestedQty, orderIncrementQty));
                    const isBulkDelivery = FinaleClient.isBulkDelivery(prodData);

                    items.push({
                        productId: sku,
                        productName,
                        supplierName: party.groupName,
                        supplierPartyId: partyId,
                        unitPrice,
                        stockOnHand,
                        stockOnOrder,
                        purchaseVelocity,
                        salesVelocity,
                        demandVelocity,
                        dailyRate,
                        runwayDays,
                        adjustedRunwayDays,
                        leadTimeDays,
                        leadTimeProvenance,
                        openPOs: activity.openPOs.map(po => ({
                            orderId: po.orderId,
                            quantity: po.quantityOnOrder,
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
                    });
                } catch {
                    // Skip products that error — non-fatal
                }
                await new Promise(r => setTimeout(r, 100));
            }
        }));

        const byVendor = new Map<string, PurchasingItem[]>();
        for (const item of items) {
            if (!byVendor.has(item.supplierPartyId)) byVendor.set(item.supplierPartyId, []);
            byVendor.get(item.supplierPartyId)!.push(item);
        }

        const groups: PurchasingGroup[] = [];
        for (const groupItems of byVendor.values()) {
            groupItems.sort((a, b) =>
                urgencyRank[a.urgency] - urgencyRank[b.urgency] || a.runwayDays - b.runwayDays,
            );
            const worstUrgency = groupItems.reduce<PurchasingItem['urgency']>(
                (worst, item) => urgencyRank[item.urgency] < urgencyRank[worst] ? item.urgency : worst,
                'ok',
            );
            groups.push({
                vendorName: groupItems[0].supplierName,
                vendorPartyId: groupItems[0].supplierPartyId,
                urgency: worstUrgency,
                items: groupItems,
            });
        }

        groups.sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency]);
        console.log(`[finale] getPurchasingIntelligenceForSkus: ${items.length} items across ${groups.length} vendors`);
        return groups;
    }

    /**
     * Fetch a draft PO and return a structured review object for the commit/send flow.
     * Only returns canCommit=true when statusId === 'ORDER_CREATED'.
     */
    async getDraftPOForReview(orderId: string): Promise<DraftPOReview> {
        const po = await this.getOrderDetails(orderId);

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
     * Strategy: POST to actionUrlComplete if present; fall back to posting statusId: ORDER_LOCKED.
     */
    async commitDraftPO(orderId: string): Promise<{ orderId: string; committed: boolean; finalStatus: string }> {
        const po = await this.getOrderDetails(orderId);

        if (po.statusId !== "ORDER_CREATED") {
            throw new Error(`PO ${orderId} is in status "${po.statusId}" — can only commit ORDER_CREATED drafts`);
        }

        console.log(`[finale] commitDraftPO: PO #${orderId} actionUrlComplete=${po.actionUrlComplete ?? "none"}`);

        let updated: any;
        if (po.actionUrlComplete) {
            // Preferred: use Finale's built-in commit action URL
            updated = await this.post(po.actionUrlComplete, {});
        } else {
            // Fallback: POST full order document with committed status
            updated = await this.post(
                `/${this.accountPath}/api/order/${encodeURIComponent(orderId)}`,
                { ...po, statusId: "ORDER_LOCKED" }
            );
        }

        const finalStatus = updated?.statusId || "ORDER_LOCKED";
        console.log(`[finale] commitDraftPO: PO #${orderId} committed → ${finalStatus}`);
        return { orderId, committed: true, finalStatus };
    }

    // ── private helper: parse Finale numeric strings like "24 d", "1,200", null, "--" ──
    private parseFinaleNum(val: any): number | null {
        if (val === null || val === undefined || val === 'null' || val === '--') return null;
        const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? null : n;
    }

    // ── CACHE MANAGEMENT (OOM prevention) ──

    /**
     * Access the shared party name cache with TTL + size bounds.
     * All FinaleClient instances share this module-level cache.
     */
    protected getPartyNameCache(): Map<string, string> {
        const now = Date.now();
        // TTL expiry — clear entire cache if stale
        if (now - _partyNameCacheAt > PARTY_NAME_CACHE_TTL) {
            _partyNameCache.clear();
            _partyNameCacheAt = now;
        }
        // Size cap — clear if too large (simple eviction, avoids LRU complexity)
        if (_partyNameCache.size > PARTY_NAME_CACHE_MAX) {
            console.log(`[finale] partyNameCache exceeded ${PARTY_NAME_CACHE_MAX} entries — clearing`);
            _partyNameCache.clear();
            _partyNameCacheAt = now;
        }
        return _partyNameCache;
    }
}

// ──────────────────────────────────────────────────
// SINGLETON (LAZY)
// DECISION(2026-03-09): Process-level singleton for use by cron jobs,
// command handlers, and background agents. Prevents 48+ ephemeral
// instances from accumulating via async closure retention.
// API route handlers may still use `new FinaleClient()` — they're
// short-lived HTTP requests that get GC'd after the response.
//
// DECISION(2026-03-11): Changed from eager (`export const finaleClient = new FinaleClient()`)
// to lazy getter. The eager singleton was constructed at module load time
// (ES import hoisting runs before dotenv.config()), so it captured empty
// env vars — causing all cron jobs (calendar sync, PO sync, build watcher,
// lead time service) to silently return empty results. The lazy getter
// defers construction until first use, when env vars are guaranteed loaded.
// ──────────────────────────────────────────────────

let _finaleClientInstance: FinaleClient | null = null;

/**
 * Lazy process-level singleton.
 * Deferred construction ensures env vars from dotenv are loaded before
 * the FinaleClient constructor reads FINALE_API_KEY / FINALE_API_SECRET.
 */
export const finaleClient: FinaleClient = new Proxy({} as FinaleClient, {
    get(_target, prop, _receiver) {
        if (!_finaleClientInstance) {
            _finaleClientInstance = new FinaleClient();
        }
        const val = (_finaleClientInstance as any)[prop];
        return typeof val === 'function' ? val.bind(_finaleClientInstance) : val;
    },
});

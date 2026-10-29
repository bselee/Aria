/**
 * @file    core-client.ts
 * @purpose Base networking and authentication layer for Finale Inventory API.
 *          Handles HTTP GET, POST, GraphQL requests, rate limiting retries,
 *          and network-level error recovery.
 * @author  Aria
 * @created 2026-05-26
 * @updated 2026-05-26
 * @deps    (none — uses native fetch)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 */

import { MAX_COOLDOWN_MS, nextCooldownMs, parseRetryAfterMs } from "./rate-limit-backoff";

// ──────────────────────────────────────────────────────────────────────────
// BASE TYPES
// ──────────────────────────────────────────────────────────────────────────

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
    reorderMethod?: FinaleReorderMethod;
    orderIncrementQuantity: number | null;  // "Std reorder in qty of" — snap suggested qty to this multiple
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
    receiveDateTime?: string;
    receivedBy?: string | null;
    receiptStatus?: "full" | "partial" | "received";
    supplier: string;
    total: number;
    /** Goods subtotal from the bulk query. Freight is total − subtotal. Finale has no freight until we add it. */
    subtotal?: number;
    items: Array<{ productId: string; quantity: number; unitPrice?: number; orderedQuantity?: number; receivedQuantity?: number; openQuantity?: number }>;
    receiptHistory?: Array<{
        shipmentId: string;
        receiveDate: string;
        receiveDateTime: string;
        receivedBy?: string | null;
        items: Array<{ productId: string; quantity: number }>;
    }>;
    finaleUrl: string;
}

export type FinaleReorderMethod =
    | "do_not_reorder"
    | "manual"
    | "sales_velocity"
    | "demand_velocity"
    | "on_site_order"
    | "default";

// ──────────────────────────────────────────────────────────────────────────
// DOMAIN INTERFACES (Backward-Compatibility & Shared)
// ──────────────────────────────────────────────────────────────────────────

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
    dailyRateSource?: "demand" | "sales" | "receipts" | "ledger";
    runwayDays: number;            // effectiveStock / dailyRate (effectiveStock = min(stockOnHand, stockAvailable) via recommender)
    adjustedRunwayDays: number;    // (effectiveStock + stockOnOrder - reservedQty) / dailyRate
    /** Total on-hand for this physical carton size across every vendor SKU.
     *  Set by carton pooling; merge must use it instead of the SKU's own stock,
     *  otherwise a size we hold reads as a shortage on the board. */
    pooledOnHand?: number;
    /** Canonical size key (e.g. "15x15x30") when this row was carton-pooled. */
    pooledDimKey?: string;
    leadTimeDays: number;
    leadTimeProvenance: string;    // e.g. "14d (Finale)" | "21d default"
    /** The lead time the qty recommender actually used (P90 > vendor override > Finale median).
     *  May differ from `leadTimeDays` when historical lead-time distribution is wider
     *  than Finale's native estimate. Dashboard urgency recomputation MUST use this
     *  value when available, not `leadTimeDays`. */
    effectiveLeadTimeDays?: number;
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    draftPO?: {
        orderId: string;
        orderDate: string;
        quantity: number;
        supplierName: string;
        finaleUrl: string;
    } | null;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';
    explanation: string;           // natural language, computed server-side
    suggestedQty: number;
    /** Advisory sanity flag (Phase 2.2): recommendedQty > 3x the median of the
     *  SKU's last few actual orders. Flag only — never suppresses the qty. */
    sanityFlag?: { flag: boolean; detail: string };
    orderIncrementQty: number | null;  // "Std reorder in qty of" — snap order quantities to this multiple
    isBulkDelivery: boolean;           // true → route to Soil facility
    finaleReorderQty: number | null;
    finaleStockoutDays: number | null;
    finaleConsumptionQty: number | null;
    finaleDemandQty: number | null;    // 90-day demand quantity from Finale productView
    reorderMethod?: FinaleReorderMethod;
    packSize?: { unitsPerPack: number; packUnit: string }; // null = not registered
    qtyDiverged?: boolean;
    qtyDivergencePct?: number;
    velocityInflated?: boolean;        // true when chooseVelocitySignal capped a demand signal that exceeded 3× sales/receipts
    velocityRawRate?: number;          // the original (pre-cap) daily rate Finale reported, for context
    velocityRealityCap?: number;       // max(salesVelocity, purchaseVelocity) — what the cap pinned dailyRate to
    vendorPolicy?: {
        leadTimeOverrideDays: number | null;
        targetCoverDays: number | null;
        moqMode: "enforce" | "warn" | "ignore";
        overbuyReviewPct: number;
        overbuyReviewDollars: number;
        notes: string | null;
    };
    moqWarning?: boolean;
    reviewRequired?: boolean;
    reviewReasons?: string[];
    roundingMethod?: "cognitive" | "historical" | "vendor_explicit" | null;
    roundingAlternatives?: number[];
    recommendation?: {
        formulaVersion: string;
        coverDays: number;
        rawNeededEaches: number;
        provenance: Array<{ step: string; detail: string; value?: number | string }>;
    };
    itemType?: 'resale' | 'bom-component' | 'resale-bom';
    feedsFinishedGoods?: Array<{
        sku: string;
        name: string;
        dailySalesRate: number;
        buildsWorth: number;
    }>;
    totalBurnRate?: number;
    medianPOGapDays?: number;
    projectedNextOrderDate?: string;
    receiptConfidence?: 'high' | 'medium' | 'low';
    triggerReason?: 'build-driven' | 'stockout-padded' | 'runway-short' | 'cadence' | null;
    triggerDetail?: string;
    stockAvailable?: number;
    forwardDemandEntry?: {
        requiredQty: number;
        earliestBuildDate: string;
        feedsBuilds: string[];
    };
    lastPurchaseDate?: string | null;
    lastPurchaseQty?: number | null;
    isBulkVendor?: boolean;
    vendorOnTimeRate?: number;
    /** Bag/label artwork state (Phase 2). Set only for items with a
     *  bag_artwork_link row. 'in_review' blocks reorder until Complete. */
    artStatus?: 'complete' | 'in_review';
    /** Sheet SKU (Finale SKU) the artwork row is keyed on. */
    artSku?: string;
    /** Latest artwork version string seen (e.g. "v3"). */
    artVersion?: string;
}

export interface PurchasingGroup {
    vendorName: string;
    vendorPartyId: string;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';  // worst of all items
    items: PurchasingItem[];
    /** Bag variant-family checks (attached by the dashboard route when any
     *  family member is actionable). See bag-families.ts. */
    bagFamilyCheck?: import('../purchasing/bag-families').BagFamilyCheck[];
}

export interface FullPO {
    orderId: string;
    vendorName: string;
    /** Finale supplier party ID (numeric string like "10083"). Null when not resolved
     *  (e.g. cached objects that predate the vendorPartyId field). */
    vendorPartyId: string | null;
    orderDate: string;           // YYYY-MM-DD
    expectedDate: string | null; // Finale's dueDate field (quoted delivery date)
    receiveDate: string | null;  // null if not yet received
    status: string;              // 'Committed' | 'Completed' | 'Cancelled' | etc.
    total: number;
    notes?: string | null;       // Internal notes
    comments?: string | null;    // External notes (to vendor)
    finaleUrl: string;
    shipments?: Array<{ shipmentId: string; status: string; receiveDate: string | null; shipDate: string | null }>;
    /** Goods subtotal. Freight already on the PO is total − subtotal. */
    subtotal?: number;
    items: Array<{ productId: string; quantity: number; unitPrice?: number; remainingQty?: number | null }>;
}

export interface DraftPOReview {
    orderId: string;
    vendorName: string;
    vendorPartyId: string;
    orderDate: string;
    total: number;
    items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number; lineTotal: number; supplierSku?: string; packing?: string }>;
    /** Supplier postal address lines (street, city/state/zip) — Finale prints it. */
    vendorAddress?: string[];
    finaleUrl: string;
    canCommit: boolean;   // true only if statusId === 'ORDER_CREATED'
}
export interface SendPurchaseOrderEmailInput {
    toEmail: string;
    subject: string;
    body: string;
}

export interface SendPurchaseOrderEmailResult {
    orderId: string;
    sent: boolean;
    pdfAttached: boolean;
    actionUrl: string;
    messageId?: string | null;
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

export interface ConsumptionPeriodBucket {
    period: string;        // YYYY-MM | YYYY-Qn | YYYY
    purchasedQty: number;  // Incoming receipts this period (PURCHASE_ORDER lines)
    soldQty: number;       // Outgoing shipments this period (SALES_ORDER lines)
    orderCount: number;
}

export interface ProductConsumptionAnalysis {
    productId: string;
    productName: string;
    productType: 'component' | 'finished_good' | 'supply' | 'unknown';
    vendorName: string | null;
    windowDays: number;
    stockOnHand: number | null;
    totals: {
        purchased: number;           // Summed receipts across the window
        sold: number;                // Summed shipments across the window
        consumption: number | null;  // Finale native rolling BOM consumption
        demand: number | null;       // Finale native rolling demand
    };
    velocity: {
        perDay: number;      // Best of purchased/sold/consumption daily rate
        perMonth: number;
        perQuarter: number;
        perYear: number;
        basis: 'sold' | 'purchased' | 'consumption' | 'demand' | 'none';
    };
    monthly: ConsumptionPeriodBucket[];
    quarterly: ConsumptionPeriodBucket[];
    yearly: ConsumptionPeriodBucket[];
    telegramMessage: string;
}

// ──────────────────────────────────────────────────────────────────────────
// CORE CLIENT
// ──────────────────────────────────────────────────────────────────────────

export class FinaleCoreClient {
    // Process-wide static queue and rate-limiting to throttle API requests globally across all instances
    private static requestQueue: (() => Promise<void>)[] = [];
    private static isProcessingQueue = false;
    private static lastRequestTime = 0;
    private static readonly REQUEST_INTERVAL_MS = 500; // Throttle to 2 requests per second (120 requests/minute max recommended by Descartes)

    // HERMIA(2026-10-15): process-wide 429 backpressure. Finale's real limit is
    // tighter than 120/min and is shared with the bot's cron jobs, so a per-call
    // "wait 5s and retry" turns ordinary throttling into a storm: every remaining
    // SKU in a BOM pass burns its retries into the same limit (observed live: a
    // single 23-minute BOM pass with thousands of failing requests, ending with
    // zero BOMs read). A cooldown pauses ALL outbound Finale traffic so the limit
    // can recover instead of being fed.
    private static cooldownUntil = 0;
    private static consecutive429 = 0;
    private static total429 = 0;

    /**
     * Current 429 state. `hits` is monotonic for the life of the process, so a
     * caller can tell "this call was rate limited" from "this call found nothing"
     * by comparing it before and after. Without that, a swallowed 429 is
     * indistinguishable from a genuine empty answer.
     *
     * @returns cooling flag, cooldown expiry, and the monotonic 429 count.
     */
    static rateLimitState(): { cooling: boolean; until: number; hits: number } {
        return {
            cooling: Date.now() < FinaleCoreClient.cooldownUntil,
            until: FinaleCoreClient.cooldownUntil,
            hits: FinaleCoreClient.total429,
        };
    }

    /**
     * Record a 429 and extend the process-wide cooldown.
     *
     * @param   retryAfterMs Server Retry-After in ms, if any.
     * @returns              Milliseconds this cooldown will run for.
     */
    private static note429(retryAfterMs: number | null): number {
        const waitMs = nextCooldownMs(FinaleCoreClient.consecutive429, retryAfterMs);
        FinaleCoreClient.consecutive429 += 1;
        FinaleCoreClient.total429 += 1;
        FinaleCoreClient.cooldownUntil = Math.max(FinaleCoreClient.cooldownUntil, Date.now() + waitMs);
        return waitMs;
    }

    /** Clear the cooldown streak after a request succeeds. */
    private static noteSuccess(): void {
        FinaleCoreClient.consecutive429 = 0;
        FinaleCoreClient.cooldownUntil = 0;
    }

    private static async enqueueRequest<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            FinaleCoreClient.requestQueue.push(async () => {
                try {
                    const res = await fn();
                    resolve(res);
                } catch (err) {
                    reject(err);
                }
            });
            FinaleCoreClient.processQueue();
        });
    }

    private static async processQueue(): Promise<void> {
        if (FinaleCoreClient.isProcessingQueue) return;
        FinaleCoreClient.isProcessingQueue = true;

        while (FinaleCoreClient.requestQueue.length > 0) {
            // A 429 from ANY caller pauses every caller: feeding the limit harder is
            // what turned ordinary throttling into a storm.
            const cooldownMs = FinaleCoreClient.cooldownUntil - Date.now();
            if (cooldownMs > 0) {
                await new Promise(r => setTimeout(r, Math.min(cooldownMs, MAX_COOLDOWN_MS)));
            }

            const now = Date.now();
            const timeSinceLast = now - FinaleCoreClient.lastRequestTime;
            const waitTime = Math.max(0, FinaleCoreClient.REQUEST_INTERVAL_MS - timeSinceLast);

            if (waitTime > 0) {
                await new Promise(r => setTimeout(r, waitTime));
            }

            const nextReq = FinaleCoreClient.requestQueue.shift();
            if (nextReq) {
                FinaleCoreClient.lastRequestTime = Date.now();
                nextReq().catch(() => {});
            }
        }

        FinaleCoreClient.isProcessingQueue = false;
    }

    protected authHeader: string;
    protected apiBase: string;
    protected accountPath: string;

    constructor() {
        const apiKey = process.env.FINALE_API_KEY || "";
        const apiSecret = process.env.FINALE_API_SECRET || "";
        this.accountPath = process.env.FINALE_ACCOUNT_PATH || "";
        const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";

        this.apiBase = baseUrl;
        this.authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    }

    /**
     * Retries on: 5xx server errors, network failures, 429 rate limits.
     * Gated by process-wide global rate-limiting queue (max 120 reqs/min).
     */
    protected async fetchWithRetry<T>(
        fn: () => Promise<Response>,
        label: string,
        maxRetries = 3
    ): Promise<T> {
        return FinaleCoreClient.enqueueRequest(() => this.executeFetchWithRetry<T>(fn, label, maxRetries));
    }

    private async executeFetchWithRetry<T>(
        fn: () => Promise<Response>,
        label: string,
        maxRetries = 3
    ): Promise<T> {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await fn();

                // 429 rate limit: cool the WHOLE queue down, then retry.
                if (response.status === 429 && attempt < maxRetries) {
                    const waitMs = FinaleCoreClient.note429(parseRetryAfterMs(response.headers.get("retry-after")));
                    console.warn(`[FinaleCoreClient] 429 rate-limited on ${label} — cooling down ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                // 5xx server error: exponential backoff
                if (response.status >= 500 && attempt < maxRetries) {
                    const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
                    console.warn(`[FinaleCoreClient] ${response.status} on ${label} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }

                // Non-retryable error (4xx) or final attempt
                if (!response.ok) {
                    // A 429 on the FINAL attempt must still start the cooldown, or the
                    // very next caller walks straight back into the limit.
                    if (response.status === 429) {
                        FinaleCoreClient.note429(parseRetryAfterMs(response.headers.get("retry-after")));
                    }
                    const errorText = await response.text();
                    throw new Error(`Finale API ${response.status}: ${response.statusText} — ${errorText.substring(0, 200)}`);
                }

                FinaleCoreClient.noteSuccess();
                return await response.json() as T;
            } catch (err: any) {
                lastError = err;
                // Network error (not HTTP error): retry with backoff
                if (err.name === "TypeError" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") {
                    if (attempt < maxRetries) {
                        const delayMs = Math.pow(2, attempt) * 1000;
                        console.warn(`[FinaleCoreClient] Network error on ${label}: ${err.message} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(r => setTimeout(r, delayMs));
                        continue;
                    }
                }
                throw err;
            }
        }
        throw lastError ?? new Error(`Finale API retry exhausted for ${label}`);
    }

    protected async get(endpoint: string): Promise<any> {
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
     */
    protected async post(endpoint: string, body: any): Promise<any> {
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

    /**
     * POST to Finale GraphQL API with integrated retry and error checking.
     */
    protected async graphql<T = any>(query: any, label: string): Promise<T> {
        const url = `${this.apiBase}/${this.accountPath}/api/graphql`;
        const result = await this.fetchWithRetry<any>(
            () => fetch(url, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(query),
            }),
            `GraphQL ${label}`
        );

        if (result.errors && result.errors.length > 0) {
            throw new Error(`Finale GraphQL Error (${label}): ${result.errors[0].message}`);
        }

        return result.data as T;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// BASE HELPERS
// ──────────────────────────────────────────────────────────────────────────

export function parseFinaleNumber(val: string | number | null | undefined): number {
    if (val == null) return 0;
    const cleaned = String(val).replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

export function parseISODateOnly(value: string): string | null {
    return finaleDateOnly(value);
}

/**
 * Normalize a Finale date to YYYY-MM-DD WITHOUT crossing the UTC boundary
 * (2026-10-29). Finale returns naive local timestamps ("2026-10-29T18:00:00");
 * converting them through new Date().toISOString() turns 6 PM Denver into the
 * NEXT UTC day, so a same-day receipt read as "future" and dropped out of the
 * receipt evidence — PO 125394 showed "need receive" on Active Purchases while
 * Receivings showed it received. Trust the calendar date as written.
 */
export function finaleDateOnly(value: string | null | undefined): string | null {
    if (!value) return null;
    const s = String(value).trim();
    // ISO date or naive ISO datetime — take the written calendar date.
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    // US-style M/D/YYYY (Finale returns these for some fields).
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    const parsed = new Date(s);
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
}

export function toISOStringOrNull(value: string | null | undefined): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

export function getShipmentsInReceiptWindow(po: any, windowStart: string, windowEnd: string): any[] {
    return (po?.shipmentList || []).filter((shipment: any) => {
        const isoDate = parseISODateOnly(shipment.receiveDate);
        return isoDate && isoDate >= windowStart && isoDate < windowEnd;
    });
}

export function getReceiptQueryStartDate(windowStart: string, lookbackDays: number = 365): string {
    const parsed = new Date(`${windowStart}T00:00:00Z`);
    if (isNaN(parsed.getTime())) return windowStart;
    parsed.setUTCDate(parsed.getUTCDate() - lookbackDays);
    return parsed.toISOString().slice(0, 10);
}

export function getReceiptStatusFromPoStatus(status: string | null | undefined): "full" | "partial" | "received" {
    const normalized = String(status || "").toLowerCase();
    // ORDER_LOCKED is the normal state of a received-but-unclosed PO. It is not
    // evidence of a short receipt — the receipt truth lives in shipment
    // quantities. A locked PO without loaded quantities reads "received"
    // (nothing known yet), never PARTIAL. This is what made rows read PARTIAL
    // with a second sentence contradicting it.
    if (normalized.includes("locked") || normalized.includes("created")) return "received";
    const fullStatuses = ["complete", "completed", "closed", "received"];
    return fullStatuses.some(token => normalized.includes(token)) ? "full" : "partial";
}

export function isWarehouseReceivingOrder(orderId: string | null | undefined): boolean {
    const normalized = String(orderId || "").toLowerCase();
    return !normalized.includes("dropship");
}

export function getShipmentReceiptDateTime(shipment: any): string | null {
    const receiptEvent = (shipment?.statusIdHistoryList || [])
        .filter((entry: any) =>
            typeof entry?.txStamp === "number" &&
            String(entry?.statusId || "").toUpperCase().includes("DELIVERED"),
        )
        .sort((a: any, b: any) => b.txStamp - a.txStamp)[0];

    if (receiptEvent?.txStamp) {
        return new Date(receiptEvent.txStamp * 1000).toISOString();
    }

    return (
        toISOStringOrNull(shipment?.lastUpdatedDate) ||
        toISOStringOrNull(shipment?.receiveDate) ||
        toISOStringOrNull(shipment?.createdDate)
    );
}

export function getShipmentReceiverName(shipment: any): string | null {
    const directFields = [
        shipment?.receivedByName,
        shipment?.receivedBy,
        shipment?.receiverName,
        shipment?.receiver,
        shipment?.lastUpdatedByName,
        shipment?.lastUpdatedBy,
    ];

    for (const value of directFields) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }

    const deliveredEvent = (shipment?.statusIdHistoryList || [])
        .filter((entry: any) => String(entry?.statusId || "").toUpperCase().includes("DELIVERED"))
        .sort((a: any, b: any) => Number(b?.txStamp || 0) - Number(a?.txStamp || 0))[0];

    const eventFields = [
        deliveredEvent?.userName,
        deliveredEvent?.fullName,
        deliveredEvent?.displayName,
        deliveredEvent?.name,
        deliveredEvent?.updatedBy,
    ];

    for (const value of eventFields) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }

    // Finale's shipment payload carries no direct receiver name, but the
    // statusIdHistoryList SHIPMENT_DELIVERED entry carries userLoginUrl
    // (e.g. /buildasoilorganics/api/userlogin/nicholas.kubin). That user is the
    // receiver — the same correlation the EOW received-items list uses
    // (receiverFromStatusHistory in eow-report.ts). Prefer the DELIVERED
    // event's own login; fall back to the latest history entry that has one.
    const loginUrl =
        deliveredEvent?.userLoginUrl ??
        (shipment?.statusIdHistoryList || []).reduce(
            (acc: string | null, entry: any) =>
                acc ?? (typeof entry?.userLoginUrl === "string" ? entry.userLoginUrl : null),
            null,
        );

    if (loginUrl) {
        const m = String(loginUrl).match(/\/userlogin\/([^/?#]+)/);
        if (m) return prettyUserLogin(decodeURIComponent(m[1]));
    }

    return null;
}

/** Nick → nicky: prettifies a Finale user login for a compact byline. */
export function prettyUserLogin(login: string): string {
    const base = (login || "").trim();
    if (!base) return "";
    const parts = base.split(/[._\-\s]+/).filter(Boolean);
    if (parts.length >= 2) return parts.map((p) => p[0].toUpperCase()).join("");
    return base[0].toUpperCase() + base.slice(1);
}

export function getShipmentLineContainers(shipment: any): any[] {
    const candidates = [
        shipment?.itemList,
        shipment?.shipmentItemList,
        shipment?.orderItemList,
        shipment?.items,
    ];

    const lines: any[] = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (Array.isArray(candidate)) {
            lines.push(...candidate);
        } else if (Array.isArray(candidate.edges)) {
            lines.push(...candidate.edges.map((edge: any) => edge?.node ?? edge));
        }
    }
    return lines.map((line) => line?.node ?? line).filter(Boolean);
}

export function getShipmentLineProductId(line: any): string | null {
    const direct = [
        line?.productId,
        line?.sku,
        line?.product?.productId,
        line?.product?.sku,
    ];
    for (const value of direct) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }

    const productUrl = line?.productUrl || line?.product?.productUrl || line?.product?.url;
    if (typeof productUrl === "string" && productUrl.trim()) {
        const tail = productUrl.split("/").filter(Boolean).pop();
        if (tail) return decodeURIComponent(tail);
    }

    return null;
}

export function getShipmentLineQuantity(line: any): number {
    const values = [
        line?.quantityReceived,
        line?.receivedQuantity,
        line?.quantityAccepted,
        line?.receivedQty,
        line?.qtyReceived,
        line?.quantity,
        line?.qty,
    ];
    for (const value of values) {
        const parsed = parseFinaleNumber(value);
        if (parsed > 0) return parsed;
    }
    return 0;
}

export function getShipmentReceiptItems(shipment: any): Array<{ productId: string; quantity: number }> {
    return getShipmentLineContainers(shipment)
        .map((line) => {
            const productId = getShipmentLineProductId(line);
            const quantity = getShipmentLineQuantity(line);
            return productId && quantity > 0 ? { productId, quantity } : null;
        })
        .filter(Boolean) as Array<{ productId: string; quantity: number }>;
}

export function deriveReceivedPurchaseOrders(
    edges: any[],
    windowStart: string,
    windowEnd: string,
    accountPath: string,
): ReceivedPO[] {
    return edges
        .map((edge: any) => {
            const po = edge.node;
            if (!isWarehouseReceivingOrder(po?.orderId)) return null;
            const receivedShipments = getShipmentsInReceiptWindow(po, windowStart, windowEnd);

            if (receivedShipments.length === 0) return null;

            const encodedUrl = Buffer.from(po.orderUrl || "").toString("base64");
            const shipmentDates = receivedShipments
                .map((shipment: any) => shipment.receiveDate)
                .filter(Boolean)
                .sort()
                .reverse();

            return {
                orderId: po.orderId,
                orderDate: po.orderDate || "",
                receiveDate: shipmentDates[0] || "",
                receiveDateTime: shipmentDates[0] || "",
                receivedBy: null,
                receiptStatus: getReceiptStatusFromPoStatus(po.status),
                supplier: po.supplier?.name || "Unknown",
                total: parseFinaleNumber(po.total),
                subtotal: parseFinaleNumber(po.subtotal),
                items: (po.itemList?.edges || []).map((ie: any) => ({
                    productId: ie.node.product?.productId || "?",
                    quantity: parseFinaleNumber(ie.node.quantity),
                    orderedQuantity: parseFinaleNumber(ie.node.quantity),
                    unitPrice: parseFinaleNumber(ie.node.unitPrice),
                })),
                finaleUrl: `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
            } satisfies ReceivedPO;
        })
        .filter(Boolean) as ReceivedPO[];
}

export function enrichReceivedPurchaseOrdersWithShipmentDetails(
    orders: ReceivedPO[],
    shipmentDetailsByOrderId: Record<string, any[]>,
    knownShipmentUrls: string[],
    expectedShipmentUrlsByOrderId: Record<string, string[]>,
    windowStart?: string,
    windowEnd?: string,
): ReceivedPO[] {
    const warmUrls = new Set(knownShipmentUrls);
    return orders.map((order) => {
        const shipmentDetails = shipmentDetailsByOrderId[order.orderId] || [];
        const shipmentReceipts = shipmentDetails
            .map((shipment) => ({
                shipmentId: String(shipment?.shipmentId || ""),
                receiptDateTime: getShipmentReceiptDateTime(shipment),
                receivedBy: getShipmentReceiverName(shipment),
                items: getShipmentReceiptItems(shipment),
            }))
            .filter((shipment) => Boolean(shipment.receiptDateTime))
            .sort((a, b) => String(b.receiptDateTime).localeCompare(String(a.receiptDateTime)));

        if (shipmentReceipts.length === 0) return order;

        const latestReceipt = shipmentReceipts[0];
        const receiptHistory = [...shipmentReceipts]
            .sort((a, b) => String(a.receiptDateTime).localeCompare(String(b.receiptDateTime)))
            .map((receipt) => ({
                shipmentId: receipt.shipmentId,
                receiveDate: parseISODateOnly(receipt.receiptDateTime || "") || "",
                receiveDateTime: receipt.receiptDateTime || "",
                receivedBy: receipt.receivedBy || null,
                items: receipt.items,
            }));

        const receivedBySku = new Map<string, number>();
        const windowReceivedBySku = new Map<string, number>();
        for (const receipt of receiptHistory) {
            const rcvDate = receipt.receiveDate;
            const inWindow = !windowStart || !windowEnd || (rcvDate >= windowStart && rcvDate <= windowEnd);
            
            for (const item of receipt.items) {
                receivedBySku.set(item.productId, (receivedBySku.get(item.productId) ?? 0) + item.quantity);
                if (inWindow) {
                    windowReceivedBySku.set(item.productId, (windowReceivedBySku.get(item.productId) ?? 0) + item.quantity);
                }
            }
        }
        const hasLineReceiptQuantities = receivedBySku.size > 0;

        // ── Complete-or-unknown (2026-10-27) ─────────────────────────────
        // A partially warm shipment cache must never sum to a "received" number:
        // the sum over whatever subset happens to be cached understates the
        // receipt and fabricates shorts (measured: 125408 read 0/50 against a
        // real 50/50). The caller passes the full expected shipment URL set;
        // if any of this order's shipments is NOT warm, the whole order's
        // received quantities are unknown — no numbers, never wrong numbers.
        const expectedUrls = expectedShipmentUrlsByOrderId[order.orderId] || [];
        const receiptsComplete =
            expectedUrls.length === 0 || expectedUrls.every((url) => warmUrls.has(url));

        return {
            ...order,
            receiveDateTime: latestReceipt.receiptDateTime || order.receiveDateTime,
            receiveDate: parseISODateOnly(latestReceipt.receiptDateTime || "") || order.receiveDate,
            receivedBy: latestReceipt.receivedBy || order.receivedBy || null,
            receiptHistory,
            items: order.items.map((item) => {
                const orderedQuantity = item.orderedQuantity ?? item.quantity;
                if (!hasLineReceiptQuantities || !receiptsComplete) {
                    // Preserve any receivedQuantity that may have come from GraphQL
                    return { ...item, orderedQuantity };
                }
                const receivedQuantity = receivedBySku.get(item.productId) ?? item.receivedQuantity ?? 0;
                const receivedInWindow = windowReceivedBySku.get(item.productId) ?? 0;
                return {
                    ...item,
                    orderedQuantity,
                    receivedQuantity,
                    receivedInWindow,
                    openQuantity: Math.max(0, orderedQuantity - receivedQuantity),
                };
            }),
        };
    });
}

export function extractFinaleMethodTokens(productData: any): string[] {
    const tokens: string[] = [];
    tokens.push(String(productData?.reorderPointPolicy ?? ""));
    tokens.push(String(productData?.reorderCalculationMethodId ?? ""));
    for (const guideline of productData?.reorderGuidelineList || []) {
        tokens.push(String(guideline?.reorderCalculationMethodId ?? ""));
        tokens.push(String(guideline?.reorderPointPolicy ?? ""));
    }
    for (const field of productData?.userFieldDataList || []) {
        tokens.push(String(field?.value ?? field?.userFieldValue ?? field?.attrValue ?? ""));
        tokens.push(String(field?.name ?? field?.userFieldName ?? field?.label ?? ""));
    }
    return tokens.map(token => token.trim().toLowerCase()).filter(Boolean);
}

export function isDoNotReorderHelper(productData: any): boolean {
    if (!productData) return false;

    const status = String(productData.statusId || productData.status || '').toLowerCase();
    if (status.includes('inactive') || status.includes('discontinued')) {
        return true;
    }

    const category = String(productData.userCategory || productData.category || '').toLowerCase();
    if (category.includes('deprecat')) {
        return true;
    }

    const policy = String(productData.reorderPointPolicy || '').toLowerCase();
    if (policy.includes('do_not_reorder') || policy.includes('donotreorder') || policy.includes('do not reorder')) {
        return true;
    }

    if (productData.doNotReorder === true) return true;

    const guidelines: any[] = productData.reorderGuidelineList || [];
    for (const g of guidelines) {
        const methodId = String(g.reorderCalculationMethodId || '').toLowerCase();
        if (methodId.includes('donotreorder')) return true;
    }

    const name = String(productData.internalName || productData.productId || '').toLowerCase();
    const desc = String(productData.description || productData.longDescription || '').toLowerCase();
    if (name.includes('do not reorder') || desc.includes('do not reorder')) return true;

    const userFields: any[] = productData.userFieldDataList || [];
    for (const field of userFields) {
        const val = String(field.value || field.userFieldValue || field.attrValue || '').toLowerCase();
        if (val.includes('do not reorder')) return true;
    }

    return false;
}

export function normalizeFinaleReorderMethod(productData: any): FinaleReorderMethod {
    if (isDoNotReorderHelper(productData)) return "do_not_reorder";

    const tokens = extractFinaleMethodTokens(productData);

    if (tokens.some(token => token.includes("on site") || token.includes("onsite"))) {
        return "on_site_order";
    }
    if (tokens.some(token => token.includes("demand velocity") || token.includes("demandvelocity"))) {
        return "demand_velocity";
    }
    if (tokens.some(token => token.includes("sales velocity") || token.includes("salesvelocity"))) {
        return "sales_velocity";
    }
    if (tokens.some(token => token === "manual" || token.includes("manual reorder"))) {
        return "manual";
    }
    return "default";
}

/** Reality cap shared by BOTH velocity paths (resale chooseVelocitySignal and
 *  BOM chooseBomVelocity): a chosen rate may not exceed 3x the physical signal
 *  (ledger / receipts / sales). One definition — the rice-bran bug was two
 *  paths disagreeing on the same arithmetic. */
export const REALITY_CAP_FACTOR = 3;

export function capRateToReality(chosenRate: number, realityRate: number): { value: number; capped: boolean } {
    if (realityRate > 0 && chosenRate > REALITY_CAP_FACTOR * realityRate) {
        return { value: realityRate, capped: true };
    }
    return { value: chosenRate, capped: false };
}

export function chooseVelocitySignal(input: {
    reorderMethod?: FinaleReorderMethod;
    demandVelocity: number;
    salesVelocity: number;
    purchaseVelocity?: number;
    consumptionQty?: number | null;
    /**
     * HERMIA(2026-09-30 — Bill): net consumption rate from Finale's stock
     * movement ledger. This is physical consumption, independent of Finale's
     * per-product reorder configuration. When present it outranks the
     * product-level fields, which report zero on job supplies and unconfigured
     * SKUs and can diverge from the ledger by orders of magnitude.
     * See src/lib/finale/stock-ledger.ts.
     */
    ledgerVelocity?: number;
}): {
    dailyRate: number;
    signal: "demand" | "sales" | "receipts" | "ledger" | "none";
    inflated?: boolean;
    rawRate?: number;
    realityCap?: number;
    /** Set when the ledger overrode a product-level signal. */
    replacedRate?: number;
    replacedSignal?: "demand" | "sales" | "receipts";
} {
    const reorderMethod = input.reorderMethod ?? "default";
    const demandVelocity = input.demandVelocity > 0 ? input.demandVelocity : 0;
    const salesVelocity = input.salesVelocity > 0 ? input.salesVelocity : 0;
    const purchaseVelocity = input.purchaseVelocity != null && input.purchaseVelocity > 0
        ? input.purchaseVelocity
        : 0;
    const hasConsumption = (input.consumptionQty ?? 0) > 0;
    const ledgerVelocity = input.ledgerVelocity != null && input.ledgerVelocity > 0
        ? input.ledgerVelocity
        : 0;

    const preferredSignals: Array<"demand" | "sales"> =
        reorderMethod === "sales_velocity"
            ? ["sales", "demand"]
            : reorderMethod === "demand_velocity" || reorderMethod === "on_site_order"
                ? ["demand", "sales"]
                : reorderMethod === "default"
                    ? (hasConsumption ? ["demand", "sales"] : ["sales", "demand"])
                    : ["sales", "demand"];

    let chosenRate = 0;
    let chosenSignal: "demand" | "sales" | "receipts" | "ledger" | "none" = "none";

    for (const signal of preferredSignals) {
        const rate = signal === "demand" ? demandVelocity : salesVelocity;
        if (rate > 0) {
            chosenRate = rate;
            chosenSignal = signal;
            break;
        }
    }

    // HERMIA(2026-09-30 — Bill): the ledger is the physical-consumption fact, so
    // it outranks the receipts fallback. Receipts measure what we BOUGHT, which
    // is circular for sizing a new buy.
    if (chosenSignal === "none" && ledgerVelocity > 0) {
        // Record what the ledger displaced so the log line and provenance say
        // which signal it overrode. If the receipts fallback would have fired,
        // that is what it replaced.
        const wouldHaveUsedReceipts = hasConsumption && purchaseVelocity > 0;
        return wouldHaveUsedReceipts
            ? { dailyRate: ledgerVelocity, signal: "ledger", replacedRate: purchaseVelocity, replacedSignal: "receipts" }
            : { dailyRate: ledgerVelocity, signal: "ledger" };
    }

    if (chosenSignal === "none" && hasConsumption && purchaseVelocity > 0) {
        chosenRate = purchaseVelocity;
        chosenSignal = "receipts";
    }

    if (chosenSignal === "none") {
        return { dailyRate: 0, signal: "none" };
    }

    // HERMIA(2026-09-30 — Bill): when the ledger and the product-level signal
    // disagree by more than 2.5x, trust the ledger. Observed divergences on live
    // data ranged from 128x low (STICKER12 0.13/d vs 16.63/d) to 1.7x high
    // (RAWWORMCASTINGS 2800/d vs 1654/d). A 2.5x gap is a full stop, not a
    // footnote: it means the product field is not describing consumption.
    const LEDGER_DIVERGENCE_FACTOR = 2.5;
    if (ledgerVelocity > 0) {
        const ratio = chosenRate > 0 ? Math.max(chosenRate, ledgerVelocity) / Math.min(chosenRate, ledgerVelocity) : Infinity;
        if (ratio > LEDGER_DIVERGENCE_FACTOR) {
            return {
                dailyRate: ledgerVelocity,
                signal: "ledger",
                replacedRate: chosenRate,
                replacedSignal: chosenSignal as "demand" | "sales" | "receipts",
            };
        }
    }

    // HERMIA(2026-10-21 — Bill): the cap's "reality" must include the ledger.
    // The 2.5x ledger-divergence check above already trusts the ledger as the
    // physical-consumption fact; when it CORROBORATES the chosen rate (ratio
    // <= 2.5x), lumpy receipts from an old bulk buy must not cap it (BLM210:
    // demand 2.9 corroborated by ledger 2.78 was capped to the 0.685 receipts
    // of a March purchase). An absent ledger leaves sales/purchase as reality —
    // the rice-bran protection is unchanged.
    const reality = Math.max(salesVelocity, purchaseVelocity, ledgerVelocity);
    const capped = capRateToReality(chosenRate, reality);
    if (capped.capped) {
        return {
            dailyRate: capped.value,
            signal: chosenSignal,
            inflated: true,
            rawRate: chosenRate,
            realityCap: reality,
        };
    }

    return { dailyRate: chosenRate, signal: chosenSignal };
}

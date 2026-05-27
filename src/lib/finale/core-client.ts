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
    items: Array<{ productId: string; quantity: number; orderedQuantity?: number; receivedQuantity?: number; openQuantity?: number }>;
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
    dailyRateSource?: "demand" | "sales" | "receipts";
    runwayDays: number;            // stockOnHand / dailyRate
    adjustedRunwayDays: number;    // (stockOnHand + stockOnOrder) / dailyRate
    leadTimeDays: number;
    leadTimeProvenance: string;    // e.g. "14d (Finale)" | "14d default"
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
}

export interface PurchasingGroup {
    vendorName: string;
    vendorPartyId: string;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';  // worst of all items
    items: PurchasingItem[];
}

export interface FullPO {
    orderId: string;
    vendorName: string;
    orderDate: string;           // YYYY-MM-DD
    expectedDate: string | null; // Finale's dueDate field (quoted delivery date)
    receiveDate: string | null;  // null if not yet received
    status: string;              // 'Committed' | 'Completed' | 'Cancelled' | etc.
    total: number;
    notes?: string | null;       // Internal notes
    comments?: string | null;    // External notes (to vendor)
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
     * Does NOT retry: 4xx client errors (bad request, not found, auth failure).
     */
    protected async fetchWithRetry<T>(
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
                    console.warn(`[FinaleCoreClient] 429 rate-limited on ${label} — waiting 5s (attempt ${attempt + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, 5000));
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
    if (!value) return null;
    const parsed = new Date(value);
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

export function getReceiptStatusFromPoStatus(status: string | null | undefined): "full" | "partial" {
    const normalized = String(status || "").toLowerCase();
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

    return null;
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
                items: (po.itemList?.edges || []).map((ie: any) => ({
                    productId: ie.node.product?.productId || "?",
                    quantity: parseFinaleNumber(ie.node.quantity),
                    orderedQuantity: parseFinaleNumber(ie.node.quantity),
                })),
                finaleUrl: `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encodedUrl}`,
            } satisfies ReceivedPO;
        })
        .filter(Boolean) as ReceivedPO[];
}

export function enrichReceivedPurchaseOrdersWithShipmentDetails(
    orders: ReceivedPO[],
    shipmentDetailsByOrderId: Record<string, any[]>,
): ReceivedPO[] {
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
        for (const receipt of receiptHistory) {
            for (const item of receipt.items) {
                receivedBySku.set(item.productId, (receivedBySku.get(item.productId) ?? 0) + item.quantity);
            }
        }
        const hasLineReceiptQuantities = receivedBySku.size > 0;

        return {
            ...order,
            receiveDateTime: latestReceipt.receiptDateTime || order.receiveDateTime,
            receiveDate: parseISODateOnly(latestReceipt.receiptDateTime || "") || order.receiveDate,
            receivedBy: latestReceipt.receivedBy || order.receivedBy || null,
            receiptHistory,
            items: order.items.map((item) => {
                const orderedQuantity = item.orderedQuantity ?? item.quantity;
                if (!hasLineReceiptQuantities) {
                    return { ...item, orderedQuantity };
                }
                const receivedQuantity = receivedBySku.get(item.productId) ?? 0;
                return {
                    ...item,
                    orderedQuantity,
                    receivedQuantity,
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

export function chooseVelocitySignal(input: {
    reorderMethod?: FinaleReorderMethod;
    demandVelocity: number;
    salesVelocity: number;
    purchaseVelocity?: number;
    consumptionQty?: number | null;
}): {
    dailyRate: number;
    signal: "demand" | "sales" | "receipts" | "none";
    inflated?: boolean;
    rawRate?: number;
    realityCap?: number;
} {
    const reorderMethod = input.reorderMethod ?? "default";
    const demandVelocity = input.demandVelocity > 0 ? input.demandVelocity : 0;
    const salesVelocity = input.salesVelocity > 0 ? input.salesVelocity : 0;
    const purchaseVelocity = input.purchaseVelocity != null && input.purchaseVelocity > 0
        ? input.purchaseVelocity
        : 0;
    const hasConsumption = (input.consumptionQty ?? 0) > 0;

    const preferredSignals: Array<"demand" | "sales"> =
        reorderMethod === "sales_velocity"
            ? ["sales", "demand"]
            : reorderMethod === "demand_velocity" || reorderMethod === "on_site_order"
                ? ["demand", "sales"]
                : reorderMethod === "default"
                    ? (hasConsumption ? ["demand", "sales"] : ["sales", "demand"])
                    : ["sales", "demand"];

    let chosenRate = 0;
    let chosenSignal: "demand" | "sales" | "receipts" | "none" = "none";

    for (const signal of preferredSignals) {
        const rate = signal === "demand" ? demandVelocity : salesVelocity;
        if (rate > 0) {
            chosenRate = rate;
            chosenSignal = signal;
            break;
        }
    }

    if (chosenSignal === "none" && hasConsumption && purchaseVelocity > 0) {
        chosenRate = purchaseVelocity;
        chosenSignal = "receipts";
    }

    if (chosenSignal === "none") {
        return { dailyRate: 0, signal: "none" };
    }

    const reality = Math.max(salesVelocity, purchaseVelocity);
    if (reality > 0 && chosenRate > 3 * reality) {
        return {
            dailyRate: reality,
            signal: chosenSignal,
            inflated: true,
            rawRate: chosenRate,
            realityCap: reality,
        };
    }

    return { dailyRate: chosenRate, signal: chosenSignal };
}

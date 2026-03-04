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
    items: Array<{ productId: string; quantity: number }>;
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
    purchaseVelocity: number;      // units/day from 90d purchase receipts
    salesVelocity: number;         // units/day from 90d outbound shipments
    dailyRate: number;             // max(purchaseVelocity, salesVelocity)
    runwayDays: number;            // stockOnHand / dailyRate
    adjustedRunwayDays: number;    // (stockOnHand + stockOnOrder) / dailyRate
    leadTimeDays: number;
    leadTimeProvenance: string;    // e.g. "14d (Finale)" | "14d default"
    openPOs: Array<{ orderId: string; quantity: number; orderDate: string }>;
    urgency: 'critical' | 'warning' | 'watch' | 'ok';
    explanation: string;           // natural language, computed server-side
    suggestedQty: number;
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
    items: Array<{ productId: string; quantity: number }>;
    finaleUrl: string;
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

export class FinaleClient {
    private authHeader: string;
    private apiBase: string;
    private accountPath: string;
    private partyNameCache = new Map<string, string>();  // party URL → name

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
     * Fetch POs received today via GraphQL.
     * Uses `receiveDate: { begin, end }` filter.
     * DECISION(2026-02-24): status + receiveDate filters conflict in Finale's
     * GraphQL API, so we filter for Completed client-side.
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
                .filter((edge: any) => edge.node.status === "Completed")
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
            if (err.message.includes("404")) return null;
            console.error(`❌ Finale lookup failed for ${sku}:`, err.message);
            return null;
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
                            first: 20
                            type: ["PURCHASE_ORDER"]
                            product: ["${productUrl}"]
                            sort: [{ field: "orderDate", mode: "desc" }]
                        ) {
                            edges {
                                node {
                                    orderId
                                    status
                                    orderDate
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

            const edges = result.data?.orderViewConnection?.edges || [];
            return edges
                .filter((edge: any) => edge.node.status === "Committed")
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
     * Get current stock level for a product via REST API.
     * Returns quantity on hand across all facilities.
     */
    async getStockLevel(productId: string): Promise<number | null> {
        try {
            const data = await this.get(
                `/${this.accountPath}/api/product/${encodeURIComponent(productId)}`
            );
            // Finale stores stock in quantityOnHand or stockLevel
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
        incomingPOs: Array<{ orderId: string; supplier: string; quantity: number; orderDate: string }>;
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
            incomingPOs: [] as Array<{ orderId: string; supplier: string; quantity: number; orderDate: string }>,
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

    private async get(endpoint: string): Promise<any> {
        const url = `${this.apiBase}${endpoint}`;

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: this.authHeader,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Finale API ${response.status}: ${response.statusText} — ${errorText.substring(0, 200)}`);
        }

        return response.json();
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

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: this.authHeader,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Finale API POST ${response.status}: ${response.statusText} — ${errorText.substring(0, 200)}`);
        }

        return response.json();
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
     * Add a fee/charge adjustment to a PO's orderAdjustmentList.
     * This uses Finale's native fee system and automatically affects landed cost per unit.
     * 
     * DECISION(2026-02-26): Uses GET → Modify → POST pattern. Must call actionUrlEdit
     * first if the PO is in Committed status to unlock it for editing.
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

        // 2. If PO is committed (ORDER_LOCKED), unlock it for editing
        if (currentPO.statusId === "ORDER_LOCKED" && currentPO.actionUrlEdit) {
            await this.post(currentPO.actionUrlEdit, {});
            // Re-fetch after unlocking — status and available actions change
            const unlocked = await this.getOrderDetails(orderId);
            Object.assign(currentPO, unlocked);
        }

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

        // 5. Re-commit if it was committed before
        if (updated.actionUrlComplete) {
            // Note: we don't auto-recommit — leave in editable state
            // so the user can review in Finale UI if desired.
        }

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

        // 2. Unlock if committed
        if (currentPO.statusId === "ORDER_LOCKED" && currentPO.actionUrlEdit) {
            await this.post(currentPO.actionUrlEdit, {});
            const unlocked = await this.getOrderDetails(orderId);
            Object.assign(currentPO, unlocked);
        }

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
        return this.post(
            `/${this.accountPath}/api/order/${encodedId}`,
            { ...currentPO, orderAdjustmentList: adjustments }
        );
    }

    /**
     * Update a specific line item's unit price on a PO.
     * Used when invoice price differs from PO price within auto-approval threshold.
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
    ): Promise<{ updated: boolean; oldPrice: number; newPrice: number; orderData: any }> {
        const encodedId = encodeURIComponent(orderId);
        const currentPO = await this.getOrderDetails(orderId);

        // Unlock if committed
        if (currentPO.statusId === "ORDER_LOCKED" && currentPO.actionUrlEdit) {
            await this.post(currentPO.actionUrlEdit, {});
            const unlocked = await this.getOrderDetails(orderId);
            Object.assign(currentPO, unlocked);
        }

        // Find the matching line item
        const items = currentPO.orderItemList || [];
        const targetItem = items.find((item: any) => item.productId === productId);

        if (!targetItem) {
            throw new Error(`Product ${productId} not found in PO ${orderId}`);
        }

        const oldPrice = targetItem.unitPrice;
        targetItem.unitPrice = newUnitPrice;

        // POST the full document back
        const updated = await this.post(
            `/${this.accountPath}/api/order/${encodedId}`,
            currentPO
        );

        return { updated: true, oldPrice, newPrice: newUnitPrice, orderData: updated };
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
     * Resolve a partygroup URL to the supplier name.
     * Caches results so we don't re-fetch for the same vendor.
     */
    private async resolvePartyName(partyUrl: string): Promise<string> {
        if (this.partyNameCache.has(partyUrl)) {
            return this.partyNameCache.get(partyUrl)!;
        }

        try {
            const data = await this.get(partyUrl);
            const name = data.groupName || data.partyId || "Unknown";
            this.partyNameCache.set(partyUrl, name);
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
    async getRecentPurchaseOrders(daysBack: number = 7): Promise<FullPO[]> {
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
                            first: 500
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
        // Cache partyId → { groupName, isManufactured, isDropship } to avoid repeat calls
        // isDropship: fulfilled direct-to-customer — no BAS reorder needed
        //   (Autopot, Printful, Grand Master, HLG, Evergreen, AC Infinity)
        const partyCache = new Map<string, { groupName: string; isManufactured: boolean; isDropship: boolean }>();

        const resolveParty = async (partyId: string): Promise<{ groupName: string; isManufactured: boolean; isDropship: boolean }> => {
            if (partyCache.has(partyId)) return partyCache.get(partyId)!;
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
                partyCache.set(partyId, result);
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

                    const partyId = mainSupplier.supplierPartyUrl.split('/').pop();
                    const party = await resolveParty(partyId);

                    richItems.push({
                        ...item,
                        supplierPartyId: partyId,
                        supplierName: party.groupName,
                        unitPrice: mainSupplier.price ?? 0,
                        isManufactured: party.isManufactured,
                        isDropship: party.isDropship,
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
     * @param vendorPartyId  Finale partyId of the supplier (from getExternalReorderItems)
     * @param items          Line items to include
     * @param memo           Optional memo/notes for the PO
     * @returns              { orderId, finaleUrl } of the created draft
     */
    async createDraftPurchaseOrder(
        vendorPartyId: string,
        items: Array<{ productId: string; quantity: number; unitPrice: number }>,
        memo?: string
    ): Promise<{ orderId: string; finaleUrl: string }> {
        const today = new Date().toISOString().split('T')[0] + 'T00:00:00';

        const payload: Record<string, any> = {
            orderTypeId: 'PURCHASE_ORDER',
            statusId: 'ORDER_CREATED',
            orderDate: today,
            orderRoleList: [{ roleTypeId: 'SUPPLIER', partyId: vendorPartyId }],
            orderItemList: items.map(item => ({
                productUrl: `/${this.accountPath}/api/product/${encodeURIComponent(item.productId)}`,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
            })),
        };
        if (memo) payload.privateNotes = memo;

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

        // Build the human-readable Finale URL (same base64 pattern used throughout client.ts)
        const rawOrderUrl = data.orderUrl || `/${this.accountPath}/api/order/${orderId}`;
        const encodedUrl = Buffer.from(rawOrderUrl).toString('base64');
        const finaleUrl = `${this.apiBase}/${this.accountPath}/sc2/?order/purchase/order/${encodedUrl}`;

        console.log(`[finale] createDraftPurchaseOrder: created PO #${orderId} for party ${vendorPartyId} (${items.length} items)`);
        return { orderId, finaleUrl };
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
            if (!res.ok) return { purchasedQty: 0, soldQty: 0, openPOs: [] };
            const result = await res.json();
            if (result.errors) return { purchasedQty: 0, soldQty: 0, openPOs: [] };

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

            return { purchasedQty, soldQty, openPOs };
        } catch {
            return { purchasedQty: 0, soldQty: 0, openPOs: [] };
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
        const candidates: string[] = [];
        let cursor: string | null = null;

        while (true) {
            const afterClause: string = cursor ? `, after: "${cursor}"` : '';
            const query: { query: string } = {
                query: `{
                    productViewConnection(first: ${PAGE_SIZE}${afterClause}) {
                        pageInfo { hasNextPage endCursor }
                        edges { node { productId status consumptionQuantity reorderQuantityToOrder } }
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
                if ((consumption !== null && consumption > 0) || (reorderQty !== null && reorderQty > 0)) {
                    candidates.push(p.productId);
                }
            }

            if (!conn.pageInfo.hasNextPage) break;
            cursor = conn.pageInfo.endCursor;
        }

        console.log(`[finale] getPurchasingIntelligence: ${candidates.length} candidates with consumption > 0`);
        if (candidates.length === 0) return [];

        // ── Step 2-8: 5x concurrent workers per candidate SKU ──
        // Vendors excluded from purchasing intelligence:
        //   isManufactured : internal BAS production depts
        //   isDropship     : fulfilled direct by vendor — no BAS reorder needed
        //                    (Autopot, Printful, Grand Master, HLG, Evergreen, AC Infinity)
        const partyCache = new Map<string, { groupName: string; isManufactured: boolean; isDropship: boolean }>();

        const resolveParty = async (partyUrl: string): Promise<{ groupName: string; isManufactured: boolean; isDropship: boolean }> => {
            const partyId = partyUrl.split('/').pop() || '';
            if (partyCache.has(partyId)) return partyCache.get(partyId)!;
            try {
                const r = await fetch(`${this.apiBase}/${this.accountPath}/api/partygroup/${partyId}`, {
                    headers: { Authorization: this.authHeader, Accept: 'application/json' },
                });
                const data = await r.json();
                const groupName: string = data.groupName || data.name || 'Unknown';
                const isManufactured = /buildasoil|manufacturing|soil dept|bas soil/i.test(groupName);
                const isDropship = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i.test(groupName);
                const result = { groupName, isManufactured, isDropship };
                partyCache.set(partyId, result);
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
                const sku = queue.shift()!;
                try {
                    // Step A: REST product data first — need supplier URL to check exclusions
                    // before spending any GraphQL calls on manufactured/dropship vendors.
                    const prodData = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(sku)}`);
                    const suppliers: any[] = prodData.supplierList || [];
                    const mainSupplier = suppliers.find(s => s.supplierPrefOrderId?.includes('MAIN')) || suppliers[0];
                    if (!mainSupplier?.supplierPartyUrl) continue;

                    // Step B: Resolve supplier and check exclusions (partyCache keeps this fast after first hit)
                    const party = await resolveParty(mainSupplier.supplierPartyUrl);
                    if (party.isManufactured || party.isDropship) continue;

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

                    // Stock from REST (GraphQL returns "--" for most products in bulk scans)
                    const stockOnHand = parseFinaleNumber(prodData.quantityOnHand ?? prodData.stockLevel ?? 0);

                    // Open PO supply
                    const stockOnOrder = activity.openPOs.reduce((sum, po) => sum + po.quantityOnOrder, 0);

                    // Step 4: velocity + runway
                    const purchaseVelocity = activity.purchasedQty / daysBack;
                    const salesVelocity = activity.soldQty / daysBack;
                    const dailyRate = Math.max(purchaseVelocity, salesVelocity);
                    if (dailyRate === 0) continue; // no actual movement

                    const runwayDays = stockOnHand / dailyRate;
                    const adjustedRunwayDays = (stockOnHand + stockOnOrder) / dailyRate;

                    // Step 6: urgency (based on raw runway, not adjusted)
                    const urgency: PurchasingItem['urgency'] =
                        runwayDays < leadTimeDays ? 'critical'
                            : runwayDays < leadTimeDays + 30 ? 'warning'
                                : runwayDays < leadTimeDays + 60 ? 'watch'
                                    : 'ok';

                    // Step 7: natural language explanation
                    const rateSource = purchaseVelocity >= salesVelocity ? 'receipts' : 'shipments';
                    const parts: string[] = [
                        `Avg ${dailyRate.toFixed(1)}/day (${daysBack}d ${rateSource})`,
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

                    // Step 8: suggested qty (lead time + 60d buffer, rounded to 50)
                    const suggestedQty = Math.max(50, Math.ceil(dailyRate * (leadTimeDays + 60) / 50) * 50);

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

    // ── private helper: parse Finale numeric strings like "24 d", "1,200", null, "--" ──
    private parseFinaleNum(val: any): number | null {
        if (val === null || val === undefined || val === 'null' || val === '--') return null;
        const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
        return isNaN(n) ? null : n;
    }
}

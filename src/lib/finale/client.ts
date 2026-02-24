/**
 * @file    client.ts
 * @purpose Lean Finale Inventory API client for Aria.
 *          Direct SKU lookups ONLY — no catalog loading.
 *          Returns: status, suppliers, lead time, cost, PO history, BOM flag.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @updated 2026-02-24
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

// ──────────────────────────────────────────────────
// CLIENT
// ──────────────────────────────────────────────────

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
    async getTodaysReceivedPOs(): Promise<ReceivedPO[]> {
        try {
            // Get today's date in YYYY-MM-DD format (Mountain Time)
            const now = new Date();
            const today = now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

            const query = {
                query: `
                    query {
                        orderViewConnection(
                            first: 100
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
                    const encodedUrl = encodeURIComponent(po.orderUrl || "");
                    return {
                        orderId: po.orderId,
                        orderDate: po.orderDate || "",
                        receiveDate: po.receiveDate || "",
                        supplier: po.supplier?.name || "Unknown",
                        total: parseFloat(po.total) || 0,
                        items: (po.itemList?.edges || []).map((ie: any) => ({
                            productId: ie.node.product?.productId || "?",
                            quantity: parseFloat(ie.node.quantity) || 0,
                        })),
                        finaleUrl: `https://app.finaleinventory.com/${this.accountPath}/app#order?orderUrl=${encodedUrl}`,
                    };
                });
        } catch (err: any) {
            console.error("Failed to fetch receivings:", err.message);
            return [];
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
    private async findCommittedPOsForProduct(productId: string): Promise<POInfo[]> {
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
                        quantityOnOrder: matchingItem?.node.quantity || 0,
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

    // ──────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ──────────────────────────────────────────────────

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
}

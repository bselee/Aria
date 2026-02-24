/**
 * @file    client.ts
 * @purpose Lean Finale Inventory API client for Aria.
 *          Direct SKU lookups ONLY — no catalog loading.
 *          Finale has 400K+ products, so we NEVER load the catalog.
 *          Instead we use the detail endpoint (/api/product/{sku}) which
 *          returns accurate status, lead time, and supplier info.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @updated 2026-02-24
 * @deps    (none — uses native fetch)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *
 * DECISION(2026-02-24): The list endpoint (/api/product) returns bogus status
 * (PRODUCT_INACTIVE for everything) and there are 400K+ products. Loading the
 * catalog is impossible and the list data is unreliable anyway. We ONLY use
 * the individual product endpoint which returns accurate data.
 *
 * COST CONTROL: Each query = 1 API call. No bulk fetching, no polling.
 */

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface FinaleProductDetail {
    productId: string;
    name: string;
    statusId: string;         // "PRODUCT_ACTIVE" or "PRODUCT_INACTIVE"
    leadTimeDays: number | null;
    cost: number | null;
    casePrice: number | null;
    supplier: string | null;
    category: string | null;
    weight: string | null;
    packing: string | null;
    reorderGuidelines: ReorderGuideline[];
    lastUpdated: string | null;
    finaleUrl: string;
}

export interface ReorderGuideline {
    facilityName: string;
    reorderPoint: number | null;
    reorderQuantity: number | null;
}

export interface ProductReport {
    found: boolean;
    product: FinaleProductDetail | null;
    telegramMessage: string;
}

// ──────────────────────────────────────────────────
// CLIENT
// ──────────────────────────────────────────────────

export class FinaleClient {
    private authHeader: string;
    private baseUrl: string;
    private accountPath: string;

    constructor() {
        const apiKey = process.env.FINALE_API_KEY || "";
        const apiSecret = process.env.FINALE_API_SECRET || "";
        this.accountPath = process.env.FINALE_ACCOUNT_PATH || "";
        const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";

        this.baseUrl = `${baseUrl}/${this.accountPath}/api`;
        this.authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    }

    /**
     * Test the connection to Finale
     */
    async testConnection(): Promise<boolean> {
        try {
            await this.get("/facility");
            console.log("✅ Finale API connected");
            return true;
        } catch (err: any) {
            console.error("❌ Finale connection failed:", err.message);
            return false;
        }
    }

    /**
     * Look up a product by exact SKU/productId.
     * This is the ONLY reliable way to get data from Finale.
     * Returns null if product doesn't exist.
     */
    async lookupProduct(sku: string): Promise<FinaleProductDetail | null> {
        try {
            const data = await this.get(`/product/${encodeURIComponent(sku.trim())}`);
            return this.parseProductDetail(data);
        } catch (err: any) {
            // 404 = product doesn't exist, not an error
            if (err.message.includes("404")) return null;
            console.error(`❌ Finale lookup failed for ${sku}:`, err.message);
            return null;
        }
    }

    /**
     * Generate a formatted Telegram report for a product.
     * This is the main function Aria calls when you ask about a product.
     */
    async productReport(sku: string): Promise<ProductReport> {
        const product = await this.lookupProduct(sku);

        if (!product) {
            return {
                found: false,
                product: null,
                telegramMessage:
                    `❌ *Product Not Found*\n\n` +
                    `SKU \`${sku}\` was not found in Finale.\n\n` +
                    `_Try the exact SKU from Finale (e.g. S-12527, BC101, PU102)_`,
            };
        }

        // Build the Telegram message
        const statusEmoji = product.statusId === "PRODUCT_ACTIVE" ? "🟢" : "🔴";
        const statusLabel = product.statusId === "PRODUCT_ACTIVE" ? "Active" : "Inactive";

        let msg = `📦 *Product Report*\n\n`;
        msg += `*${product.name}*\n`;
        msg += `SKU: \`${product.productId}\`\n`;
        msg += `${statusEmoji} Status: *${statusLabel}*\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;

        if (product.supplier) {
            msg += `🏭 Supplier: ${product.supplier}\n`;
        }
        if (product.leadTimeDays !== null) {
            msg += `⏱️ Lead Time: ${product.leadTimeDays} days\n`;
        }
        if (product.cost !== null) {
            msg += `💰 Cost: $${product.cost.toFixed(2)}\n`;
        }
        if (product.casePrice !== null) {
            msg += `📦 Case Price: $${product.casePrice.toFixed(2)}\n`;
        }
        if (product.packing) {
            msg += `📐 Packing: ${product.packing}\n`;
        }
        if (product.weight) {
            msg += `⚖️ Weight: ${product.weight}\n`;
        }
        if (product.category) {
            msg += `🏷️ Category: ${product.category}\n`;
        }

        // Reorder guidelines
        if (product.reorderGuidelines.length > 0) {
            msg += `\n📊 *Reorder Guidelines*\n`;
            for (const rg of product.reorderGuidelines) {
                const facilityName = rg.facilityName || "Default";
                const rp = rg.reorderPoint !== null ? rg.reorderPoint : "—";
                const rq = rg.reorderQuantity !== null ? rg.reorderQuantity : "—";
                msg += `  ${facilityName}: Reorder @ ${rp} | Qty: ${rq}\n`;
            }
        }

        msg += `\n🔗 [View in Finale](https://app.finaleinventory.com/${this.accountPath}/app#product?productUrl=${encodeURIComponent(product.finaleUrl)})`;
        msg += `\n_Last updated: ${product.lastUpdated || "unknown"}_`;

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
        const url = `${this.baseUrl}${endpoint}`;

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
     * Parse the raw Finale product detail response into our clean type.
     */
    private parseProductDetail(data: any): FinaleProductDetail {
        // Extract primary supplier
        let supplier: string | null = null;
        if (data.supplierList?.length > 0) {
            // Find the primary/first supplier with a name
            for (const s of data.supplierList) {
                if (s.partyName) {
                    supplier = s.partyName;
                    break;
                }
            }
        }

        // Extract cost (LIST_PRICE)
        let cost: number | null = null;
        let casePrice: number | null = null;
        if (data.priceList) {
            for (const p of data.priceList) {
                if (p.productPriceTypeId === "LIST_PRICE" && p.price) {
                    cost = p.price;
                }
                if (p.productPriceTypeId === "LIST_CASE_PRICE" && p.price) {
                    casePrice = p.price;
                }
            }
        }

        // Extract reorder guidelines
        const reorderGuidelines: ReorderGuideline[] = [];
        if (data.reorderGuidelineList) {
            for (const rg of data.reorderGuidelineList) {
                reorderGuidelines.push({
                    facilityName: rg.facilityName || rg.facilityId || "",
                    reorderPoint: rg.reorderPoint ?? null,
                    reorderQuantity: rg.reorderQuantity ?? null,
                });
            }
        }

        // Extract weight
        let weight: string | null = null;
        if (data.weight) {
            const unit = data.weightUomId === "WT_lb" ? "lbs" : data.weightUomId || "";
            weight = `${data.weight} ${unit}`.trim();
        }

        return {
            productId: data.productId,
            name: data.internalName || data.productId,
            statusId: data.statusId || "UNKNOWN",
            leadTimeDays: data.leadTime ?? null,
            cost,
            casePrice,
            supplier,
            category: data.userCategory || null,
            weight,
            packing: data.normalizedPackingString || null,
            reorderGuidelines,
            lastUpdated: data.lastUpdatedDate || null,
            finaleUrl: data.productUrl || `/api/product/${data.productId}`,
        };
    }
}

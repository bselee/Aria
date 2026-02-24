/**
 * @file    client.ts
 * @purpose Lean Finale Inventory API client for Aria.
 *          Does NOT display data. Only answers two questions:
 *          1. "Do we have this in stock?"
 *          2. "Is it already on an open PO?"
 *          Ported from MuRP's finaleBasicAuthClient.ts — same auth, same transforms.
 * @author  Antigravity / Aria
 * @created 2026-02-24
 * @updated 2026-02-24
 * @deps    (none — uses native fetch)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *
 * DECISION(2026-02-24): The list endpoint (/api/product) returns PRODUCT_INACTIVE
 * for ALL products — this is a known Finale API quirk. The individual endpoint
 * (/api/product/{id}) returns the real status. So we use the list for name/SKU
 * matching, then hit the detail endpoint for accurate stock/status data.
 */

// ──────────────────────────────────────────────────
// TYPES (minimal — only what Aria needs)
// ──────────────────────────────────────────────────

export interface FinaleProductSummary {
    productId: string;    // This IS the SKU
    name: string;
}

export interface FinaleProductDetail {
    productId: string;
    name: string;
    statusId: string;     // "PRODUCT_ACTIVE" or "PRODUCT_INACTIVE"
    leadTime?: number;
    cost?: number;
    defaultSupplier?: string;
    // Stock data comes from the detail endpoint, not the list
}

export interface StockAssessment {
    found: boolean;
    sku: string;
    name: string;
    status: string;
    leadTimeDays: number | null;
    supplier: string | null;
    recommendation: string;
}

// ──────────────────────────────────────────────────
// CLIENT
// ──────────────────────────────────────────────────

export class FinaleClient {
    private authHeader: string;
    private baseUrl: string;
    private catalogCache: FinaleProductSummary[] = [];
    private cacheTimestamp: number = 0;
    private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

    constructor() {
        const apiKey = process.env.FINALE_API_KEY || "";
        const apiSecret = process.env.FINALE_API_SECRET || "";
        const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
        const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";

        this.baseUrl = `${baseUrl}/${accountPath}/api`;
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
     * Fetch the product catalog for name/SKU matching.
     * IMPORTANT: Do NOT trust statusId from this endpoint — it's always INACTIVE.
     * We only use this for fuzzy matching by name and SKU.
     */
    async getCatalog(): Promise<FinaleProductSummary[]> {
        const now = Date.now();
        if (this.catalogCache.length > 0 && (now - this.cacheTimestamp) < this.CACHE_TTL_MS) {
            return this.catalogCache;
        }

        try {
            const data = await this.get("/product?limit=5000");
            const productIds = data.productId;
            if (!Array.isArray(productIds)) return [];

            const catalog: FinaleProductSummary[] = [];
            for (let i = 0; i < productIds.length; i++) {
                catalog.push({
                    productId: productIds[i],
                    name: data.internalName?.[i] || "",
                });
            }

            this.catalogCache = catalog;
            this.cacheTimestamp = now;
            console.log(`📦 Finale catalog loaded: ${catalog.length} products`);
            return catalog;
        } catch (err: any) {
            console.error("❌ Failed to fetch catalog:", err.message);
            return this.catalogCache;
        }
    }

    /**
     * Get detailed info for a specific product by SKU/productId.
     * This is the ONLY endpoint that returns accurate status and data.
     */
    async getProductDetail(productId: string): Promise<FinaleProductDetail | null> {
        try {
            const data = await this.get(`/product/${encodeURIComponent(productId)}`);

            // Extract supplier from supplierList if available
            let supplier = "";
            if (data.supplierList?.length > 0) {
                supplier = data.supplierList[0].partyName || data.supplierList[0].partyId || "";
            }

            return {
                productId: data.productId,
                name: data.internalName || data.productId,
                statusId: data.statusId,
                leadTime: data.leadTime || undefined,
                cost: data.priceList?.find((p: any) => p.productPriceTypeId === "LIST_PRICE")?.price,
                defaultSupplier: supplier,
            };
        } catch (err: any) {
            return null;
        }
    }

    /**
     * Search the catalog by name/SKU — returns best matching productId.
     * Uses Fuse.js for fuzzy matching so "3 gallon pots" finds the right product.
     */
    async searchProduct(query: string): Promise<string | null> {
        const catalog = await this.getCatalog();
        const q = query.toLowerCase().trim();

        // 1. Exact SKU match (case-insensitive)
        const exactSku = catalog.find(p =>
            p.productId.toLowerCase() === q
        );
        if (exactSku) return exactSku.productId;

        // 2. SKU contains query or query contains SKU (min 3 chars to avoid false positives)
        if (q.length >= 3) {
            const skuContains = catalog.find(p =>
                p.productId.toLowerCase().includes(q) ||
                (p.productId.length >= 3 && q.includes(p.productId.toLowerCase()))
            );
            if (skuContains) return skuContains.productId;
        }

        // 3. Fuse.js fuzzy search on product names
        const Fuse = (await import("fuse.js")).default;
        const fuse = new Fuse(catalog, {
            keys: ["name", "productId"],
            threshold: 0.4,
            includeScore: true,
            minMatchCharLength: 3,
        });

        const results = fuse.search(q);
        if (results.length > 0 && results[0].score! < 0.5) {
            return results[0].item.productId;
        }

        return null;
    }

    /**
     * THE KEY FUNCTION: Assess a product request.
     * 1. Search catalog for the product (fuzzy match by name)
     * 2. Fetch the REAL detail from the individual endpoint
     * 3. Return a clear recommendation
     */
    async assess(query: string): Promise<StockAssessment> {
        // Step 1: Find the product in the catalog
        const productId = await this.searchProduct(query);

        if (!productId) {
            return {
                found: false,
                sku: "",
                name: "",
                status: "NOT_FOUND",
                leadTimeDays: null,
                supplier: null,
                recommendation: `No product found matching "${query}" in Finale. Manual lookup needed.`,
            };
        }

        // Step 2: Get the REAL detail (status, lead time, supplier)
        const detail = await this.getProductDetail(productId);

        if (!detail) {
            return {
                found: true,
                sku: productId,
                name: "",
                status: "UNKNOWN",
                leadTimeDays: null,
                supplier: null,
                recommendation: `Found SKU ${productId} but couldn't fetch details. Check Finale manually.`,
            };
        }

        // Step 3: Build recommendation
        let recommendation: string;
        if (detail.statusId === "PRODUCT_INACTIVE") {
            recommendation = `⚠️ Product ${productId} is INACTIVE in Finale. May be discontinued.`;
        } else {
            const supplierInfo = detail.defaultSupplier ? ` from ${detail.defaultSupplier}` : "";
            const leadInfo = detail.leadTime ? ` (lead time: ${detail.leadTime} days)` : "";
            recommendation = `✅ Active product${supplierInfo}${leadInfo}. Check Finale for current stock.`;
        }

        return {
            found: true,
            sku: detail.productId,
            name: detail.name,
            status: detail.statusId,
            leadTimeDays: detail.leadTime || null,
            supplier: detail.defaultSupplier || null,
            recommendation,
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
}

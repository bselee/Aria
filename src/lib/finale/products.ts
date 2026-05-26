/**
 * @file    products.ts
 * @purpose Decomposed module for Finale product details, catalog searches, and facility lookups.
 * @author  Aria / Antigravity
 * @created 2026-05-26
 */

import { getPackSizes } from "@/lib/purchasing/pack-size-registry";
import {
    FinaleCoreClient,
    type FinaleProductDetail,
    type SupplierInfo,
    type ProductReport,
    type POInfo,
    parseFinaleNumber,
    parseISODateOnly,
    toISOStringOrNull,
    isDoNotReorderHelper,
    normalizeFinaleReorderMethod,
} from "./core-client";

// Facility URL cache — module-level so it persists across FinaleClient instances.
export interface FacilityInfo {
    url: string;   // e.g. "/buildasoilorganics/api/facility/12345"
    name: string;  // e.g. "Shipping", "Soil"
}
export let _facilityCache: FacilityInfo[] | null = null;
export let _facilityCacheAt = 0;
export const FACILITY_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

export const _partyNameCache = new Map<string, string>();  // party URL → name
export let _partyNameCacheAt = 0;
export const PARTY_NAME_CACHE_TTL = 60 * 60 * 1000;  // 1 hour
export const PARTY_NAME_CACHE_MAX = 500;

export const _partyCacheShared = new Map<string, { groupName: string; isManufactured: boolean; isDropship: boolean; ts: number }>();
export const PARTY_CACHE_TTL = 60 * 60 * 1000;  // 1 hour
export const PARTY_CACHE_MAX = 200;

export const _bomComponent404Cache = new Set<string>();
export const __bomComponent404CacheForTests = _bomComponent404Cache;

export const _skuHasNoBomCache = new Set<string>();
export const __skuHasNoBomCacheForTests = _skuHasNoBomCache;

export const EXCLUDED_VENDOR_PATTERN =
    /buildasoil|manufacturing|soil dept|bas soil|autopot|printful|grand.?master| hlg |horticulture lighting|evergreen|ac.?infinity/i;

export const _vendorCache = new Map<string, { vendorName: string; vendorPartyId: string | null; ts: number }>();
export const VENDOR_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

export class FinaleProductsClient extends FinaleCoreClient {
    protected productListCache: string[] | null = null;
    protected productListBulkCache: Record<string, any[]> | null = null;
    protected productCatalogCache: string[] | null = null;
    protected catalogCacheTime: number = 0;
    protected static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

    static readonly FINALE_FEE_TYPES = {
        FREIGHT: { id: "10007", url: "/buildasoilorganics/api/productpromo/10007", name: "Freight" },
        TAX: { id: "10008", url: "/buildasoilorganics/api/productpromo/10008", name: "Tax" },
        ESTIMATED_MAN: { id: "10009", url: "/buildasoilorganics/api/productpromo/10009", name: "Estimated Manual" },
        ESTIMATED_PCT: { id: "10010", url: "/buildasoilorganics/api/productpromo/10010", name: "Estimated 15%" },
        DISCOUNT_20: { id: "10011", url: "/buildasoilorganics/api/productpromo/10011", name: "Discount 20%" },
        DISCOUNT_10: { id: "10012", url: "/buildasoilorganics/api/productpromo/10012", name: "Discount 10%" },
        TARIFF: { id: "10013", url: "/buildasoilorganics/api/productpromo/10013", name: "Tariff" },
        LOGISTICS: { id: "10014", url: "/buildasoilorganics/api/productpromo/10014", name: "Logistics" }
    };

    constructor() {
        super();
    }

    /**
     * Access the shared party name cache with TTL + size bounds.
     */
    protected getPartyNameCache(): Map<string, string> {
        const now = Date.now();
        if (now - _partyNameCacheAt > PARTY_NAME_CACHE_TTL) {
            _partyNameCache.clear();
            _partyNameCacheAt = now;
        }
        if (_partyNameCache.size > PARTY_NAME_CACHE_MAX) {
            console.log(`[finale] partyNameCache exceeded ${PARTY_NAME_CACHE_MAX} entries — clearing`);
            _partyNameCache.clear();
            _partyNameCacheAt = now;
        }
        return _partyNameCache;
    }

    /**
     * Infer whether a product is a "bulk delivery" item that should route to the Soil facility.
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

        const bulkNamePatterns = /\b(tote|bulk|raw|pallet|super\s*sack|truckload|truck\s*load|yard|cubic\s*yard|\bcy\b|tanker)\b/;
        if (bulkNamePatterns.test(name)) return true;

        const weightMatch = packing.match(/(\d[\d,.]*)\s*(lb|lbs|pound|pounds)/i);
        if (weightMatch) {
            const weight = parseFloat(weightMatch[1].replace(/,/g, ''));
            if (weight >= 2000) return true;
        }

        if (/\b(ton|tons|yard|yards|\bcy\b|cubic\s*yard)\b/.test(packing)) return true;
        if (/\b(raw|bulk)\b/.test(category)) return true;

        return false;
    }

    /**
     * Round a quantity UP to the nearest multiple of the order increment.
     */
    static snapToIncrement(quantity: number, incrementQty: number | null): number {
        if (!incrementQty || incrementQty <= 1) return quantity;
        return Math.max(incrementQty, Math.ceil(quantity / incrementQty) * incrementQty);
    }

    /**
     * Check whether a Finale product is flagged "Do not reorder".
     */
    static isDoNotReorder(productData: any): boolean {
        return isDoNotReorderHelper(productData);
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
     * Look up a product by exact SKU and resolve all enrichment data.
     * Total API calls: 1 (product) + 1 per supplier to resolve names (cached).
     */
    async lookupProduct(sku: string): Promise<FinaleProductDetail | null> {
        try {
            const data = await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(sku.trim())}`);
            const product = await this.parseProductDetail(data);

            // Check for committed POs containing this product (GraphQL)
            product.openPOs = await (this as any).findCommittedPOsForProduct(sku.trim());

            return product;
        } catch (err: any) {
            if (err.message.includes("404")) {
                // DECISION(2026-03-23): Finale REST /api/product/<sku> returns 404
                // for some valid products. Fall back to product list scan.
                // 2026-05-14: extended to actually RETURN product detail from
                // the cached bulk-list response — supplier info, status, lead
                // time, etc. all live there. Without this, ~50 components
                // silently dropped from bom-demand / Purchasing Intelligence.
                try {
                    const synthetic = await this.lookupProductFromListCache(sku.trim());
                    if (synthetic) {
                        const product = await this.parseProductDetail(synthetic);
                        product.openPOs = await (this as any).findCommittedPOsForProduct(sku.trim());
                        return product;
                    }
                } catch (cacheErr: any) {
                    console.warn(`[finale] lookupProduct: ${sku} 404, list-cache fallback failed: ${cacheErr.message}`);
                }
                return null;
            }
            console.error(`❌ Finale lookup failed for ${sku}:`, err.message);
            return null;
        }
    }

    /**
     * Batch-resolve vendor name + partyId for an array of component SKUs.
     * Uses a 4h TTL module-level cache to avoid re-fetching vendor info on every snapshot run.
     * Skips already-cached SKUs. Fetches missing/expired SKUs in parallel via lookupProduct().
     * Extracts MAIN supplier's partyUrl → partyId + groupName.
     * Unresolvable SKUs produce { vendorName: 'Unknown Vendor', vendorPartyId: null }.
     */
    async lookupComponentVendorBatch(
        skus: string[],
    ): Promise<Map<string, { vendorName: string; vendorPartyId: string | null }>> {
        const results = new Map<string, { vendorName: string; vendorPartyId: string | null }>();
        const now = Date.now();

        // Separate cached (fresh) vs uncached/expired SKUs
        const uncachedSkus: string[] = [];
        for (const sku of skus) {
            const cached = _vendorCache.get(sku);
            if (cached && now - cached.ts < VENDOR_CACHE_TTL) {
                results.set(sku, { vendorName: cached.vendorName, vendorPartyId: cached.vendorPartyId });
            } else {
                uncachedSkus.push(sku);
            }
        }

        if (uncachedSkus.length > 0) {
            await Promise.allSettled(
                uncachedSkus.map(async (sku) => {
                    try {
                        const product = await this.lookupProduct(sku);
                        if (!product || product.suppliers.length === 0) {
                            _vendorCache.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null, ts: now });
                            results.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null });
                            return;
                        }
                        const main = product.suppliers.find(s => s.role === 'MAIN') ?? product.suppliers[0];
                        const partyId = main.partyUrl.split('/').pop() ?? null;
                        const vendorName = main.name || 'Unknown Vendor';
                        _vendorCache.set(sku, { vendorName, vendorPartyId: partyId, ts: now });
                        results.set(sku, { vendorName, vendorPartyId: partyId });
                    } catch {
                        _vendorCache.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null, ts: now });
                        results.set(sku, { vendorName: 'Unknown Vendor', vendorPartyId: null });
                    }
                }),
            );
        }

        return results;
    }

    async validateProductExists(sku: string): Promise<boolean> {
        const trimmed = sku.trim();

        // Fast path: direct endpoint
        try {
            await this.get(`/${this.accountPath}/api/product/${encodeURIComponent(trimmed)}`);
            return true;
        } catch {
            // Direct endpoint 404s for some valid products — try list scan
        }

        try {
            await this.ensureProductListCache();
            return this.productListCache?.includes(trimmed) ?? false;
        } catch (err: any) {
            console.error(`[finale] validateProductExists failed for ${sku}:`, err.message);
            return false;
        }
    }

    /** Load + cache the bulk product list response on first use. Both
     *  productListCache (just SKU IDs) and productListBulkCache (parallel
     *  arrays for all fields) get populated together. */
    protected async ensureProductListCache(): Promise<void> {
        if (this.productListCache && this.productListBulkCache) return;
        const data = await this.get(`/${this.accountPath}/api/product`);
        this.productListCache = data.productId || [];
        // Strip the productId so we don't double-store it; the rest is
        // parallel arrays we'll index by SKU position.
        const { productId: _ignore, ...bulk } = data;
        this.productListBulkCache = bulk as Record<string, any[]>;
        console.log(`[finale] Product list cached: ${this.productListCache!.length} products (with details for 404-fallback)`);
    }

    /** Reconstruct a single-product-shaped object by pulling parallel-array
     *  values at the requested SKU's index. Returns null if SKU not in the
     *  cached list. The shape matches what /api/product/{sku} would have
     *  returned — feed this straight to parseProductDetail. */
    protected async lookupProductFromListCache(sku: string): Promise<any | null> {
        await this.ensureProductListCache();
        const list = this.productListCache;
        const bulk = this.productListBulkCache;
        if (!list || !bulk) return null;
        const idx = list.indexOf(sku);
        if (idx < 0) return null;
        const synthetic: Record<string, any> = { productId: sku };
        for (const [field, arr] of Object.entries(bulk)) {
            if (Array.isArray(arr) && idx < arr.length) {
                synthetic[field] = arr[idx];
            }
        }
        return synthetic;
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
        productName: string | null;
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
            productName: null as string | null,
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

        // 1. GraphQL for all stock/demand metrics. Also query unitsInStock
        // because Finale frequently returns "--" for stockOnHand on components
        // even when there is real stock (Build Demand Oracle bug 2026-05-14 —
        // KMS101 showed CRITICAL · ORDER NOW with 55.88 actually on hand).
        try {
            const query = {
                query: `{
                    productViewConnection(first: 1, productId: "${productId}") {
                        edges {
                            node {
                                productId
                                stockOnHand
                                stockAvailable
                                stockOnOrder
                                unitsInStock
                                stockoutDays
                                demandQuantity
                                consumptionQuantity
                                reorderQuantityToOrder
                            }
                        }
                    }
                }`
            };

            const data = await this.graphql(query, `Stock Profile ${productId}`);
            const node = data?.productViewConnection?.edges?.[0]?.node;
            if (node) {
                profile.productName = null;
                // Fall back to unitsInStock when stockOnHand is missing/"--".
                profile.onHand = parseVal(node.stockOnHand) ?? parseVal(node.unitsInStock);
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
        } catch (err: any) {
            console.warn(`[finale] getComponentStockProfile partial failure for ${productId}:`, err.message);
        }

        // 1b. REST fallback when GraphQL didn't return a usable stockOnHand /
        // unitsInStock. Some components only show stock via REST (the same
        // path getStockLevel() uses). Without this, the Oracle treats null
        // as zero and labels well-stocked SKUs as ORDER NOW.
        if (profile.onHand === null) {
            try {
                const restStock = await this.getStockLevel(productId);
                if (restStock !== null) {
                    profile.onHand = restStock;
                    profile.hasFinaleData = true;
                }
            } catch { /* leave null */ }
        }

        // 2. Committed POs for this component
        try {
            const pos = await (this as any).findCommittedPOsForProduct(productId);
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
            profile.leadTimeDays = await (this as any).getLeadTime(productId);
        } catch { /* leave null */ }

        return profile;
    }

    /**
     * Get the full product catalog (cached for 30 minutes).
     * Uses REST /api/product which returns all product URLs.
     */
    protected async getProductCatalog(): Promise<string[]> {
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
    protected async enrichSearchResults(productIds: string[]): Promise<Array<{
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
                            name: node.productId || id,
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
    protected async enrichBatchNames(productIds: string[]): Promise<Array<{
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
     * Compute the Levenshtein edit distance between two strings.
     * Used for fuzzy SKU matching when exact substring fails.
     */
    protected levenshtein(a: string, b: string): number {
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
            // 404 is the expected outcome for any product without a BOM (most
            // active SKUs). Logging every one drowned dashboards in noise during
            // cold scans. Real failures (5xx, network errors) still surface.
            if (!/Finale API 404\b/.test(err.message ?? '')) {
                console.error(`Failed to fetch BOM for ${productId}:`, err.message);
            }
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
                        status: ["ORDER_CREATED", "ORDER_COMMITTED"]
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
    protected async resolvePartyName(partyUrl: string): Promise<string> {
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
    protected async parseProductDetail(data: any): Promise<FinaleProductDetail> {
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
            doNotReorder: FinaleProductsClient.isDoNotReorder(data),
            reorderMethod: normalizeFinaleReorderMethod(data),
            finaleUrl: data.productUrl || "",
            openPOs: [],  // Populated later by lookupProduct()
        };
    }

    /**
     * Simple concurrency pool for async tasks.
     */
    protected async runPooled<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
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
}

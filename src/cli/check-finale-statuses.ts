import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

/**
 * Finale Data Quality Assessment
 * Understand what we're actually working with before building anything on top.
 */

async function assess() {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    const get = async (endpoint: string) => {
        const res = await fetch(`${baseUrl}/${accountPath}/api${endpoint}`, {
            headers: { Authorization: authHeader, Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
        return res.json();
    };

    // ── 1. How many products total? ──
    console.log("═══════════════════════════════════════════");
    console.log("  FINALE DATA QUALITY ASSESSMENT");
    console.log("═══════════════════════════════════════════\n");

    // Paginate to count all products
    let offset = 0;
    let allProductIds: string[] = [];
    let allNames: string[] = [];
    let totalPages = 0;

    while (true) {
        const data = await get(`/product?limit=5000&offset=${offset}`);
        const ids = data.productId || [];
        if (ids.length === 0) break;

        allProductIds.push(...ids);
        allNames.push(...(data.internalName || []));
        offset += ids.length;
        totalPages++;
        console.log(`  Page ${totalPages}: ${ids.length} products (total so far: ${allProductIds.length})`);

        if (ids.length < 5000) break; // Last page
    }

    console.log(`\n📊 TOTAL PRODUCTS IN FINALE: ${allProductIds.length}`);

    // ── 2. Check a known product via detail endpoint ──
    console.log("\n── Detail endpoint samples ──");
    const sampleSkus = ["S-12527", allProductIds[0], allProductIds[Math.floor(allProductIds.length / 2)]];

    for (const sku of sampleSkus) {
        try {
            const detail = await get(`/product/${encodeURIComponent(sku)}`);
            console.log(`\n  ${sku}: ${detail.internalName}`);
            console.log(`    status: ${detail.statusId}`);
            console.log(`    leadTime: ${detail.leadTime || 'N/A'}`);
            console.log(`    supplier: ${detail.supplierList?.[0]?.partyName || 'None'}`);
            console.log(`    reorderGuidelineList: ${JSON.stringify(detail.reorderGuidelineList || []).substring(0, 200)}`);
        } catch (e: any) {
            console.log(`  ${sku}: ERROR - ${e.message}`);
        }
    }

    // ── 3. Naming patterns ──
    console.log("\n── Product naming patterns (random sample of 20) ──");
    const indices = Array.from({ length: 20 }, () => Math.floor(Math.random() * allProductIds.length));
    for (const i of indices) {
        console.log(`  ${allProductIds[i]}: ${allNames[i]}`);
    }

    // ── 4. SKU prefix analysis ──
    console.log("\n── SKU prefix distribution (top 20) ──");
    const prefixCounts: Record<string, number> = {};
    for (const id of allProductIds) {
        // Extract prefix (letters before first digit, or first 2-3 chars)
        const match = id.match(/^([A-Za-z]+)/);
        const prefix = match ? match[1].toUpperCase() : id.substring(0, 2).toUpperCase();
        prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
    const sorted = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [prefix, count] of sorted) {
        console.log(`  ${prefix}: ${count} products`);
    }

    // ── 5. Empty names ──
    const emptyNames = allNames.filter(n => !n || n.trim() === "").length;
    console.log(`\n── Data quality ──`);
    console.log(`  Products with empty names: ${emptyNames} / ${allProductIds.length} (${(emptyNames / allProductIds.length * 100).toFixed(1)}%)`);

    // ── 6. Duplicate detection ──
    const uniqueIds = new Set(allProductIds);
    console.log(`  Unique product IDs: ${uniqueIds.size} / ${allProductIds.length}`);
    if (uniqueIds.size < allProductIds.length) {
        console.log(`  ⚠️ DUPLICATES: ${allProductIds.length - uniqueIds.size}`);
    }

    process.exit(0);
}

assess().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});

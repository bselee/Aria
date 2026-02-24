import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function debugPOFilter() {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

    const gql = async (queryStr: string) => {
        const res = await fetch(`${baseUrl}/${accountPath}/api/graphql`, {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query: queryStr }),
        });
        return res.json();
    };

    // Try product filter with ID 
    console.log("Test 1: product: [\"RAWFISHBONE\"]");
    let r = await gql(`{ orderViewConnection(first: 5, type: ["PURCHASE_ORDER"], status: ["Committed"], product: ["RAWFISHBONE"]) { edges { node { orderId status } } } }`);
    console.log(`  Result: ${r.data?.orderViewConnection?.edges?.length || 0} POs`, r.errors ? r.errors[0].message : "");

    // Try with product URL format
    console.log("\nTest 2: product: [\"/buildasoilorganics/api/product/RAWFISHBONE\"]");
    r = await gql(`{ orderViewConnection(first: 5, type: ["PURCHASE_ORDER"], status: ["Committed"], product: ["/buildasoilorganics/api/product/RAWFISHBONE"]) { edges { node { orderId status } } } }`);
    console.log(`  Result: ${r.data?.orderViewConnection?.edges?.length || 0} POs`, r.errors ? r.errors[0].message : "");

    // Try without status filter but with product
    console.log("\nTest 3: product: [\"RAWFISHBONE\"] (no status filter)");
    r = await gql(`{ orderViewConnection(first: 5, type: ["PURCHASE_ORDER"], product: ["RAWFISHBONE"]) { edges { node { orderId status orderDate } } } }`);
    console.log(`  Result: ${r.data?.orderViewConnection?.edges?.length || 0} POs`, r.errors ? r.errors[0].message : "");
    for (const e of (r.data?.orderViewConnection?.edges || [])) {
        console.log(`    PO ${e.node.orderId}: ${e.node.status} | ${e.node.orderDate}`);
    }

    // Try with URL and no status
    console.log("\nTest 4: product URL (no status filter)");
    r = await gql(`{ orderViewConnection(first: 5, type: ["PURCHASE_ORDER"], product: ["/buildasoilorganics/api/product/RAWFISHBONE"]) { edges { node { orderId status orderDate } } } }`);
    console.log(`  Result: ${r.data?.orderViewConnection?.edges?.length || 0} POs`, r.errors ? r.errors[0].message : "");
    for (const e of (r.data?.orderViewConnection?.edges || [])) {
        console.log(`    PO ${e.node.orderId}: ${e.node.status} | ${e.node.orderDate}`);
    }

    process.exit(0);
}
debugPOFilter();

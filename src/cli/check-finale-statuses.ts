import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function findProduct() {
    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    // 1. Try getting the specific product by ID
    console.log("1. Fetching product S-12527 directly...");
    try {
        const res = await fetch(`${baseUrl}/${accountPath}/api/product/S-12527`, {
            headers: { Authorization: authHeader, Accept: "application/json" },
        });
        if (res.ok) {
            const data = await res.json();
            console.log("  Full response:", JSON.stringify(data, null, 2).substring(0, 1500));
        } else {
            console.log(`  ${res.status}: ${res.statusText}`);
        }
    } catch (e: any) {
        console.log("  Error:", e.message);
    }

    // 2. Check the actionUrlActivate field — might indicate status differently
    console.log("\n2. Checking actionUrlActivate values...");
    try {
        const res = await fetch(`${baseUrl}/${accountPath}/api/product?limit=20`, {
            headers: { Authorization: authHeader, Accept: "application/json" },
        });
        const data = await res.json();

        for (let i = 0; i < Math.min(5, data.productId?.length || 0); i++) {
            console.log(`  ${data.productId[i]}: status=${data.statusId[i]}, activate=${data.actionUrlActivate?.[i]}`);
        }
    } catch (e: any) {
        console.log("  Error:", e.message);
    }

    // 3. Try the productType filter
    console.log("\n3. Checking productTypeId values...");
    try {
        const res = await fetch(`${baseUrl}/${accountPath}/api/product?limit=50`, {
            headers: { Authorization: authHeader, Accept: "application/json" },
        });
        const data = await res.json();
        if (data.productTypeId) {
            const types = [...new Set(data.productTypeId)];
            console.log("  Unique productTypeId:", types);
        }
    } catch (e: any) {
        console.log("  Error:", e.message);
    }

    process.exit(0);
}
findProduct();

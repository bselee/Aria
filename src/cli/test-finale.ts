import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';

async function test() {
    console.log("🔧 Testing Finale API (v2 — detail endpoint)...\n");

    const client = new FinaleClient();

    // Test 1: Connection
    const connected = await client.testConnection();
    if (!connected) process.exit(1);

    // Test 2: Load catalog
    console.log("\n📦 Loading product catalog...");
    const catalog = await client.getCatalog();
    console.log(`  Loaded ${catalog.length} products`);
    console.log(`  Sample: ${catalog.slice(0, 3).map(p => `${p.productId}: ${p.name}`).join(", ")}`);

    // Test 3: Assess the product from the screenshot
    console.log("\n🔍 Assessing 'S-12527' (3M Gas Cartridge)...");
    const result1 = await client.assess("S-12527");
    console.log(`  Found: ${result1.found}`);
    console.log(`  SKU: ${result1.sku}`);
    console.log(`  Name: ${result1.name}`);
    console.log(`  Status: ${result1.status}`);
    console.log(`  Lead Time: ${result1.leadTimeDays} days`);
    console.log(`  Supplier: ${result1.supplier}`);
    console.log(`  → ${result1.recommendation}`);

    // Test 4: Fuzzy search for "perlite"
    console.log("\n🔍 Assessing 'perlite'...");
    const result2 = await client.assess("perlite");
    console.log(`  Found: ${result2.found}`);
    console.log(`  SKU: ${result2.sku}`);
    console.log(`  Name: ${result2.name}`);
    console.log(`  → ${result2.recommendation}`);

    // Test 5: Fuzzy search for "3 gallon pot"
    console.log("\n🔍 Assessing '3 gallon pot'...");
    const result3 = await client.assess("3 gallon pot");
    console.log(`  Found: ${result3.found}`);
    console.log(`  SKU: ${result3.sku}`);
    console.log(`  Name: ${result3.name}`);
    console.log(`  → ${result3.recommendation}`);

    process.exit(0);
}

test().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});

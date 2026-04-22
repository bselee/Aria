import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

/**
 * SCHEMA WATCHDOG
 * Proactively verifies that Finale's GraphQL API supports the fields 
 * required for OOS reporting and purchasing intelligence.
 * 
 * Run this to verify API health after any major report failure.
 */
async function verifySchema() {
    const client = new FinaleClient();
    console.log("🛠️ Starting Finale GraphQL Schema Watchdog...");

    const testSku = 'CRP101'; // Common SKU
    const productUrl = `/${process.env.FINALE_ACCOUNT_PATH}/api/product/${testSku}`;

    const query = {
        query: `
            query {
                orderViewConnection(first: 1, type: ["PURCHASE_ORDER"], product: ["${productUrl}"]) {
                    edges {
                        node {
                            orderId
                            status
                            orderDate
                            total
                            supplier { name }
                            itemList(first: 1) {
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
        const res = await fetch(`${client.apiBase}/${client.accountPath}/api/graphql`, {
            method: "POST",
            headers: {
                Authorization: client.authHeader,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(query),
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }

        const result: any = await res.json();
        
        if (result.errors) {
            console.error("❌ SCHEMA REGRESSION DETECTED!");
            console.error(JSON.stringify(result.errors, null, 2));
            process.exit(1);
        }

        console.log("✅ GraphQL Schema Verified: All required fields present.");
        process.exit(0);

    } catch (err: any) {
        console.error("❌ SCHEMA WATCHDOG FAILED:", err.message);
        process.exit(1);
    }
}

verifySchema();

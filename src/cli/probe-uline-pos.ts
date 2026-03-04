/**
 * Inspect actual Uline POs in Finale to understand status/receiveDate structure.
 * Usage: node --import tsx src/cli/probe-uline-pos.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const base = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const account = process.env.FINALE_ACCOUNT_PATH || '';
const auth = 'Basic ' + Buffer.from(
    `${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`
).toString('base64');

async function gql(query: string) {
    const r = await fetch(`${base}/${account}/api/graphql`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    return r.json();
}

async function run() {
    // 1. Find recent POs from Uline by searching last 365 days, all statuses
    const now = new Date();
    const year = new Date(now); year.setFullYear(year.getFullYear() - 1);
    const beginStr = year.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const endStr = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

    console.log('Searching Uline POs (last 365 days, all statuses)...\n');
    const res1 = await gql(`{
        orderViewConnection(
            first: 20
            type: ["PURCHASE_ORDER"]
            orderDate: { begin: "${beginStr}", end: "${endStr}" }
            sort: [{ field: "orderDate", mode: "desc" }]
        ) {
            edges { node {
                orderId status orderDate receiveDate
                supplier { name }
                itemList(first: 5) {
                    edges { node {
                        product { productId }
                        quantity
                    }}
                }
            }}
        }
    }`);

    const edges = res1.data?.orderViewConnection?.edges || [];
    const ulinePOs = edges.filter((e: any) =>
        (e.node.supplier?.name || '').toLowerCase().includes('uline')
    );

    if (ulinePOs.length === 0) {
        console.log('No Uline POs found by supplier name. Checking all POs for S-4092...\n');
        // Try to find any PO containing S-4092
        const res2 = await gql(`{
            orderViewConnection(
                first: 20
                type: ["PURCHASE_ORDER"]
                product: ["/${account}/api/product/S-4092"]
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId status orderDate receiveDate
                    supplier { name }
                    itemList(first: 10) {
                        edges { node {
                            product { productId }
                            quantity
                        }}
                    }
                }}
            }
        }`);
        const edges2 = res2.data?.orderViewConnection?.edges || [];
        console.log(`Found ${edges2.length} POs containing S-4092:`);
        for (const e of edges2) {
            const po = e.node;
            console.log(`  PO ${po.orderId} | status=${po.status} | orderDate=${po.orderDate} | receiveDate=${po.receiveDate} | supplier=${po.supplier?.name}`);
            for (const ie of po.itemList?.edges || []) {
                console.log(`    SKU: ${ie.node.product?.productId}  qty: ${ie.node.quantity}`);
            }
        }
    } else {
        console.log(`Found ${ulinePOs.length} Uline POs:`);
        for (const e of ulinePOs) {
            const po = e.node;
            console.log(`  PO ${po.orderId} | status=${po.status} | orderDate=${po.orderDate} | receiveDate=${po.receiveDate}`);
            const items = po.itemList?.edges || [];
            const skus = items.map((ie: any) => ie.node.product?.productId).join(', ');
            console.log(`    SKUs: ${skus || '(none returned)'}`);
        }
    }

    // 2. Check all POs with S-4092 via the product filter (no date range)
    console.log('\n\nAll POs ever containing S-4092 (any status, no date filter):');
    const res3 = await gql(`{
        orderViewConnection(
            first: 10
            type: ["PURCHASE_ORDER"]
            product: ["/${account}/api/product/S-4092"]
            sort: [{ field: "orderDate", mode: "desc" }]
        ) {
            edges { node {
                orderId status orderDate receiveDate
                supplier { name }
            }}
        }
    }`);
    const edges3 = res3.data?.orderViewConnection?.edges || [];
    if (edges3.length === 0) {
        console.log('  No POs found — S-4092 has never been on a Finale PO, OR the product filter is not matching.');
    } else {
        for (const e of edges3) {
            const po = e.node;
            console.log(`  PO ${po.orderId} | status=${po.status} | orderDate=${po.orderDate} | receiveDate=${po.receiveDate} | supplier=${po.supplier?.name}`);
        }
    }
}

run().catch(console.error);

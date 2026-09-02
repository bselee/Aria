import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function main() {
    const c = new FinaleClient();

    // BASLIGHT102 product report
    console.log('=== BASLIGHT102 productReport ===');
    const r = await c.productReport('BASLIGHT102');
    console.log('found:', r.found);
    if (r.product) {
        console.log('name:', r.product.name);
        console.log('status:', r.product.statusId);
        console.log('hasBOM:', r.product.hasBOM);
        console.log('isManufactured:', r.product.isManufactured);
        console.log('suppliers:', JSON.stringify(r.product.suppliers));
        console.log('reorderMethod:', r.product.reorderMethod);
    }

    // Stock profile
    console.log('\n=== BASLIGHT102 stock profile ===');
    const q1 = {
        query: `{
            productViewConnection(first: 1, productId: "BASLIGHT102") {
                edges { node {
                    productId stockOnHand unitsInStock demandQuantity demandPerDay
                    consumptionQuantity stockoutDays reorderPoint leadTime status
                }}
            }
        }`
    };
    const r1 = await (c as any).graphql(q1, 'BASLIGHT102');
    console.log(JSON.stringify(r1?.productViewConnection?.edges?.[0]?.node, null, 2));

    // BOM
    console.log('\n=== BASLIGHT102 BOM (who does it consume?) ===');
    try {
        const bom = await c.getBillOfMaterials('BASLIGHT102');
        console.log(JSON.stringify(bom, null, 2));
    } catch(e: any) { console.error('BOM err:', e.message?.slice(0,200)); }

    // BASLIGHT search
    console.log('\n=== All BASLIGHT products ===');
    const q2 = {
        query: `{
            productViewConnection(first: 20, search: "BASLIGHT") {
                edges { node {
                    productId unitsInStock demandPerDay demandQuantity status
                }}
            }
        }`
    };
    const r2 = await (c as any).graphql(q2, 'BASLIGHT search');
    for (const e of r2?.productViewConnection?.edges || []) {
        const n = e.node;
        console.log(`  ${n.productId} | UIS=${n.unitsInStock} | dd=${n.demandPerDay} | d90=${n.demandQuantity} | status=${n.status}`);
    }

    // Check: is BASLIGHT102 a BOM component of anything else? (it IS the FG)
    // Check: does LIGHTBAGCF appear in BASLIGHT102's BOM?

    // Also sales orders for BASLIGHT102
    console.log('\n=== BASLIGHT102 sales orders (last 90d) ===');
    const q3 = {
        query: `{
            orderViewConnection(
                first: 50, type: ["SALES_ORDER"],
                product: ["/buildasoilorganics/api/product/BASLIGHT102"],
                orderDate: { begin: "2026-04-23", end: "2026-07-22" },
                sort: [{ field: "orderDate", mode: "desc" }]
            ) {
                edges { node {
                    orderId status orderDate
                    itemList(first: 5) { edges { node { product { productId } quantity unitPrice } } }
                }}
            }
        }`
    };
    const r3 = await (c as any).graphql(q3, 'BASLIGHT102 sales');
    const edges = r3?.orderViewConnection?.edges || [];
    let totalSold = 0;
    console.log(`Found ${edges.length} sales orders:`);
    for (const e of edges.slice(0, 10)) {
        const n = e.node;
        const items = n.itemList?.edges || [];
        for (const ie of items) {
            if (ie.node.product?.productId === 'BASLIGHT102') {
                totalSold += parseFloat(ie.node.quantity || '0');
                console.log(`  ${n.orderId} | ${n.orderDate} | qty=${ie.node.quantity}`);
            }
        }
    }
    console.log(`\nTotal sold in window: ${totalSold}`);

    process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

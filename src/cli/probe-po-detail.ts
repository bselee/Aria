import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

const client = new FinaleClient();

async function run() {
    // Check what's on the recent Completed Uline PO
    const po = await client.getOrderSummary('124251');
    if (!po) { console.log('PO 124251 not found'); return; }
    console.log(`PO ${po.orderId} | ${po.status} | ${po.orderDate} | ${po.supplier}`);
    console.log('Items:');
    for (const item of po.items) {
        console.log(`  ${item.productId}  qty:${item.quantity}  price:${item.unitPrice}`);
    }

    // Also check PO 123908 (Completed, 10/13/2025) which is outside 90d but good to understand
    const po2 = await client.getOrderSummary('123908');
    if (po2) {
        console.log(`\nPO ${po2.orderId} | ${po2.status} | ${po2.orderDate} | ${po2.supplier}`);
        console.log('Items:');
        for (const item of po2.items) {
            console.log(`  ${item.productId}  qty:${item.quantity}`);
        }
    }
}
run().catch(console.error);

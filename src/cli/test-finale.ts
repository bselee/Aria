import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function test() {
    const client = new FinaleClient();
    await client.testConnection();

    console.log("\n═══ Today's Received POs ═══\n");
    const received = await client.getTodaysReceivedPOs();
    console.log(`Found ${received.length} received POs today`);

    if (received.length > 0) {
        for (const po of received) {
            console.log(`  PO ${po.orderId}: ${po.supplier} | $${po.total} | ${po.items.length} line items`);
            for (const item of po.items.slice(0, 3)) {
                console.log(`    ${item.productId}: qty=${item.quantity}`);
            }
        }
    }

    console.log("\n═══ Formatted Digest ═══\n");
    console.log(client.formatReceivingsDigest(received));

    process.exit(0);
}
test();

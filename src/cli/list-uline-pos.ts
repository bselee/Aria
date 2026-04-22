import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function listAllUlineBoxPOs() {
    const client: any = new FinaleClient();
    try {
        const pos = await client.getRecentPurchaseOrders(365, 1000);
        const ulinePOs = pos.filter((po: any) => 
            po.vendorName.toUpperCase().includes('ULINE') && 
            po.status === 'Completed'
        );

        console.log(`Found ${ulinePOs.length} completed ULINE POs.`);

        const allItems = new Set();
        for (const po of ulinePOs) {
            for (const item of po.items) {
                allItems.add(`${item.productId} (${item.quantity})`);
            }
        }

        console.log("All items in ULINE POs:");
        console.log(Array.from(allItems).join('\n'));

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

listAllUlineBoxPOs();

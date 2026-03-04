import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

const client = new FinaleClient();

async function run() {
    for (const sku of ['S-4092', 'S-4128', 'S-445']) {
        const [p90, p365, s365] = await Promise.all([
            client.getPurchasedQty(sku, 90),
            client.getPurchasedQty(sku, 365),
            client.getSalesQty(sku, 365),
        ]);
        console.log(`${sku}: 90d buys=${p90.totalQty}  365d buys=${p365.totalQty}  365d sales=${s365.totalSoldQty}  stock=${s365.stockOnHand}`);
    }
}
run().catch(console.error);

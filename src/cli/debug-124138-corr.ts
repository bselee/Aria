import { findCorrelatedReception } from '../cli/reconcile-fedex';
import { FinaleClient } from '../lib/finale/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function main() {
    const finale = new FinaleClient();
    const pos = await finale.getRecentPurchaseOrders(400, 2000);
    const po124138 = pos.find(p => p.orderId === '124138');
    
    if (!po124138) {
        console.log("no po 124138");
        return;
    }

    console.log("PO 124138 shipments:");
    console.log(po124138.shipments);

    const dates = ['2026-02-09T00:00:00Z', '2026-02-12T00:00:00Z', '2026-03-11T00:00:00Z', '2026-01-20T00:00:00Z'];
    for (const d of dates) {
        const corr = findCorrelatedReception(po124138, d);
        console.log(`Date: ${d} -> Match: ${corr}`);
    }
}
main();

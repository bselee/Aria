import { FinaleClient } from '../lib/finale/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function main() {
    const finale = new FinaleClient();
    const orderDetails = await finale.getOrderDetails('124138');
    
    console.log("Receptions for PO 124138:");
    console.log("- 124138-1 on 12/18/2025");
    console.log("- 124138-2 on 1/21/2026");
    console.log("- 124138-3 on 2/13/2026");
    console.log("");
    
    const adjustments = orderDetails.orderAdjustmentList || [];
    const freight = adjustments.filter((a: any) => a.description?.toLowerCase().includes('freight') || a.description?.toLowerCase().includes('fedex'));

    console.log(`Found ${freight.length} freight adjustments on PO 124138:`);
    for (const f of freight) {
        console.log(`- $${f.amount} | ${f.description}`);
    }
}

main().catch(console.error);

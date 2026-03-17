import { FinaleClient } from '../lib/finale/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function main() {
    const finale = new FinaleClient();
    
    console.log("== PO 124138 ==");
    const po1 = await finale.getOrderDetails('124138');
    console.log(JSON.stringify({ orderDate: po1.orderDate, receiveDate: po1.receiveDate, shipments: po1.shipmentList }, null, 2));
    const adj1 = po1.orderAdjustmentList || [];
    console.log("Freight:", adj1.filter((a: any) => a.description?.toLowerCase().includes('freight')));

    console.log("\n== PO 124357 ==");
    try {
        const po2 = await finale.getOrderDetails('124357');
        console.log(JSON.stringify({ orderDate: po2.orderDate, receiveDate: po2.receiveDate, shipments: po2.shipmentList }, null, 2));
        const adj2 = po2.orderAdjustmentList || [];
        console.log("Freight:", adj2.filter((a: any) => a.description?.toLowerCase().includes('freight') || a.description?.toLowerCase().includes('fedex')));
    } catch {
        console.log("PO 124357 not found");
    }
}

main().catch(console.error);

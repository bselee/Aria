import { FinaleClient } from '../lib/finale/client';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

export function findCorrelatedReception(po: any, deliveryDateStr: string): string | null {
    if (!po.shipments || po.shipments.length === 0) return null;

    const dDate = new Date(deliveryDateStr);
    for (const [index, shipment] of po.shipments.entries()) {
        const recDate = shipment.receiveDate ? new Date(shipment.receiveDate) : null;
        if (recDate) {
            const diff = Math.abs((dDate.getTime() - recDate.getTime()) / 86400000);
            if (diff <= 7) {
                return `Rec ${po.orderId}-${index + 1} on ${recDate.toLocaleDateString()}`;
            }
        }
    }
    return null;
}

async function main() {
    const finale = new FinaleClient();
    const pos = await finale.getRecentPurchaseOrders(400, 1000);
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

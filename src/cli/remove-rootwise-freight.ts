import { FinaleClient } from '../lib/finale/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function removeAdjustments(finale: FinaleClient, poId: string, invoiceNumbers: string[]) {
    try {
        const order = await finale.getOrderDetails(poId);
        const originalStatus = order.statusId;

        // Unlock if needed
        if (originalStatus === 'ORDER_COMMITTED' || originalStatus === 'ORDER_COMPLETED') {
            await finale['unlockForEditing'](poId, originalStatus);
        }

        const originalAdj = order.orderAdjustmentList || [];
        const newAdj = originalAdj.filter((a: any) => {
            const desc = a.description || '';
            const shouldRemove = invoiceNumbers.some(inv => desc.includes(inv));
            if (shouldRemove) {
                console.log(`Removing from PO ${poId}: $${a.amount} | ${desc}`);
            }
            return !shouldRemove;
        });

        if (originalAdj.length !== newAdj.length) {
            order.orderAdjustmentList = newAdj;
            const encodedId = Buffer.from(order.orderUrl || 'purchase/order/' + poId).toString('base64');
            
            await finale['post'](`/${finale['accountPath']}/api/order/${encodedId}`, order);
            console.log(`Successfully updated PO ${poId}`);
        } else {
            console.log(`PO ${poId} had no matching adjustments to remove.`);
        }

        // Restore status
        if (originalStatus === 'ORDER_COMMITTED' || originalStatus === 'ORDER_COMPLETED') {
            await finale['restoreOrderStatus'](poId, originalStatus);
        }
    } catch (e: any) {
        console.error(`Error on PO ${poId}: ${e.message}`);
    }
}

async function main() {
    const finale = new FinaleClient();
    await removeAdjustments(finale, '124248', ['887950244199']);
    await removeAdjustments(finale, '124357', ['888484752401', '888690772665']);
    await removeAdjustments(finale, '124431', ['302207672338']);
    console.log("Done.");
}

main().catch(console.error);

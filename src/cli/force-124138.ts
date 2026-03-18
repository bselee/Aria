import { FinaleClient } from '../lib/finale/client';

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function moveFreight() {
    const finale = new FinaleClient();
    
    // 1. Remove from 124248
    const order = await finale.getOrderDetails('124248');
    const originalStatus = await (finale as any).unlockForEditing(order, '124248');

    const adj = order.orderAdjustmentList || [];
    const newAdj = adj.filter((a: any) => {
        const desc = a.description || '';
        return !desc.includes('888484752401') && !desc.includes('888690772665');
    });

    if (adj.length !== newAdj.length) {
        order.orderAdjustmentList = newAdj;
        const encodedId = encodeURIComponent('124248');
        await (finale as any).post(`/${finale['accountPath']}/api/order/${encodedId}`, order);
        console.log(`Cleared 124248`);
    }

    if (originalStatus === 'ORDER_COMMITTED' || originalStatus === 'ORDER_COMPLETED') {
        await (finale as any).restoreOrderStatus('124248', originalStatus);
    }
    
    // Clear 124241
    const order2 = await finale.getOrderDetails('124241');
    const os2 = await (finale as any).unlockForEditing(order2, '124241');
    const newAdj2 = (order2.orderAdjustmentList || []).filter((a: any) => !(a.description||'').includes('887950244199'));
    if (newAdj2.length !== (order2.orderAdjustmentList||[]).length) {
        order2.orderAdjustmentList = newAdj2;
        await (finale as any).post('/' + finale['accountPath'] + '/api/order/' + encodeURIComponent('124241'), order2);
    }
    await (finale as any).restoreOrderStatus('124241', os2);

    // 2. Add to 124138
    await finale.updateOrderAdjustmentAmount('124138', 'FREIGHT', 338.03, 'FedEx Collect Freight — Inv 888484752401 (2026-02-09) — Rec 124138-1 on 2/12/2026');
    await finale.updateOrderAdjustmentAmount('124138', 'FREIGHT', 338.03, 'FedEx Collect Freight — Inv 888690772665 (2026-02-12) — Rec 124138-1 on 2/12/2026');
    await finale.updateOrderAdjustmentAmount('124138', 'FREIGHT', 336.44, 'FedEx Collect Freight — Inv 887950244199 (2026-01-20) — Rec 124138-2 on 1/20/2026');

    console.log("Moved successfully.");
}

moveFreight().catch(console.error);

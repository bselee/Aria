import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';

async function main() {
    const client = new FinaleClient() as any;

    const orderId = '124915';

    // Cart items with S-12230 converted from 3 cartons (1000 ea) → 3000 eaches
    const items = [
        { productId: 'S-4738',    quantity: 480,   unitPrice: 2.29 },
        { productId: 'S-10748B',  quantity: 240,   unitPrice: 1.65 },
        { productId: 'S-4092',    quantity: 2000,  unitPrice: 0.51 },
        { productId: 'S-4128',    quantity: 2000,  unitPrice: 0.65 },
        { productId: 'S-4796',    quantity: 2000,  unitPrice: 1.99 },
        { productId: 'S-12230',   quantity: 3000,  unitPrice: 0.015 }, // 3 cartons × 1000 = 3000 eaches @ $15/carton = $0.015 each
        { productId: 'H-11721',   quantity: 1,     unitPrice: 735.00 },
        { productId: 'H-1717BL',  quantity: 2,     unitPrice: 60.00 },
    ];

    console.log(`Populating PO ${orderId} with ${items.length} items...`);
    console.log('Note: S-12230 converted 3 cartons → 3000 eaches');

    try {
        await client.addItemsToPO(orderId, items);
        console.log('\n✅ Successfully populated PO 124915');

        // Verify
        const updated = await client.getOrderDetails(orderId);
        const lineItems = updated.orderItemList || updated.items || [];
        console.log(`\nVerification: PO now has ${lineItems.length} line items`);
        for (const item of lineItems) {
            const sku = item.productId || '?';
            const qty = item.quantity || '?';
            const price = item.unitPrice || '?';
            console.log(`  ${sku.padEnd(12)} qty=${qty} price=$${price}`);
        }
    } catch (err: any) {
        console.error('Failed:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
}

main();

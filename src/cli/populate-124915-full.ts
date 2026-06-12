import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString('base64')}`;

async function main() {
    const orderId = '124915';
    const encodedId = encodeURIComponent(orderId);

    console.log(`Populating PO ${orderId} with all 8 Uline cart items...`);

    // Get current PO
    const getUrl = `${apiBase}/${accountPath}/api/order/${encodedId}`;
    const getRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    const currentPO = await getRes.json();

    // Unlock if needed
    if (currentPO.actionUrlEdit && (currentPO.statusId === 'ORDER_LOCKED' || currentPO.statusId === 'ORDER_COMPLETED')) {
        await fetch(currentPO.actionUrlEdit, { method: 'POST', headers: { Authorization: authHeader } });
        const unlockedRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
        Object.assign(currentPO, await unlockedRes.json());
    }

    // All 8 items from Uline cart, with S-12230 converted (3 cartons → 3000 eaches)
    const allItems = [
        { productId: 'S-4738',   quantity: 480,  unitPrice: 2.29 },
        { productId: 'S-10748B', quantity: 240,  unitPrice: 1.65 },
        { productId: 'S-4092',   quantity: 2000, unitPrice: 0.51 },
        { productId: 'S-4128',   quantity: 2000, unitPrice: 0.65 },
        { productId: 'S-4796',   quantity: 2000, unitPrice: 1.99 },
        { productId: 'S-12230',  quantity: 3000, unitPrice: 0.015 }, // Converted from 3 cartons
        { productId: 'H-11721',  quantity: 1,    unitPrice: 735.00 },
        { productId: 'H-1717BL', quantity: 2,    unitPrice: 60.00 },
    ];

    currentPO.orderItemList = allItems.map(item => ({
        productUrl: `/${accountPath}/api/product/${encodeURIComponent(item.productId)}`,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
    }));

    console.log(`Setting ${currentPO.orderItemList.length} items...`);

    const postRes = await fetch(`${apiBase}/${accountPath}/api/order/${encodedId}`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPO),
    });

    if (!postRes.ok) {
        console.error('POST failed:', postRes.status, await postRes.text());
        process.exit(1);
    }

    console.log('✅ PO updated with all 8 items');

    // Verify
    const verifyRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    const verified = await verifyRes.json();
    console.log(`\nFinal PO 124915 has ${verified.orderItemList?.length || 0} items:`);
    
    let total = 0;
    for (const item of verified.orderItemList || []) {
        const sku = item.productUrl?.split('/').pop() || '?';
        const qty = item.quantity || 0;
        const price = item.unitPrice || 0;
        const lineTotal = qty * price;
        total += lineTotal;
        console.log(`  ${sku.padEnd(12)} qty=${String(qty).padEnd(6)} @ $${price.toFixed(4)} = $${lineTotal.toFixed(2)}`);
    }
    console.log(`\nCalculated total: $${total.toFixed(2)}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });

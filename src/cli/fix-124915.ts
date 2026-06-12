import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString('base64')}`;

async function main() {
    const orderId = '124915';
    const encodedId = encodeURIComponent(orderId);

    console.log(`Fixing PO ${orderId}...`);

    // 1. Get current PO
    const getUrl = `${apiBase}/${accountPath}/api/order/${encodedId}`;
    const getRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    const currentPO = await getRes.json();

    console.log('Current status:', currentPO.statusId);
    console.log('Current items:', (currentPO.orderItemList || []).length);

    // 2. Unlock if needed
    let originalStatus = currentPO.statusId;
    if (currentPO.actionUrlEdit && (currentPO.statusId === 'ORDER_LOCKED' || currentPO.statusId === 'ORDER_COMPLETED')) {
        console.log('Unlocking PO...');
        await fetch(currentPO.actionUrlEdit, { method: 'POST', headers: { Authorization: authHeader } });
        // Re-fetch
        const unlockedRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
        Object.assign(currentPO, await unlockedRes.json());
    }

    // 3. Build correct item list with proper productUrls
    const correctItems = [
        { productId: 'S-4738',   quantity: 480,  unitPrice: 2.29 },
        { productId: 'S-10748B', quantity: 240,  unitPrice: 1.65 },
        { productId: 'S-4092',   quantity: 2000, unitPrice: 0.51 },
        { productId: 'S-4128',   quantity: 2000, unitPrice: 0.65 },
        { productId: 'S-4796',   quantity: 2000, unitPrice: 1.99 },
        { productId: 'S-12230',  quantity: 3000, unitPrice: 0.015 }, // 3 cartons → 3000 eaches
        { productId: 'H-11721',  quantity: 1,    unitPrice: 735.00 },
        { productId: 'H-1717BL', quantity: 2,    unitPrice: 60.00 },
    ];

    currentPO.orderItemList = correctItems.map(item => ({
        productUrl: `/${accountPath}/api/product/${encodeURIComponent(item.productId)}`,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
    }));

    console.log(`Setting ${currentPO.orderItemList.length} correct items...`);

    // 4. POST the updated PO
    const postRes = await fetch(`${apiBase}/${accountPath}/api/order/${encodedId}`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPO),
    });

    if (!postRes.ok) {
        const errText = await postRes.text();
        console.error('POST failed:', postRes.status, errText);
        process.exit(1);
    }

    console.log('✅ PO updated successfully');

    // 5. Verify
    const verifyRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    const verified = await verifyRes.json();
    const finalItems = verified.orderItemList || [];
    console.log(`\nFinal verification: ${finalItems.length} items`);
    for (const item of finalItems) {
        const sku = item.productId || '?';
        const qty = item.quantity || '?';
        const price = item.unitPrice || '?';
        console.log(`  ${sku.padEnd(12)} qty=${String(qty).padEnd(8)} price=$${price}`);
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });

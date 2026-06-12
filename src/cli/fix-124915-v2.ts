import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString('base64')}`;

async function main() {
    const orderId = '124915';
    const encodedId = encodeURIComponent(orderId);

    console.log(`Fixing PO ${orderId} with only valid Finale SKUs...`);

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

    // Only include SKUs that exist in Finale
    // S-10748B, H-11721, H-1717BL do not exist in Finale product master
    const validItems = [
        { productId: 'S-4738',   quantity: 480,  unitPrice: 2.29 },
        { productId: 'S-4092',   quantity: 2000, unitPrice: 0.51 },
        { productId: 'S-4128',   quantity: 2000, unitPrice: 0.65 },
        { productId: 'S-4796',   quantity: 2000, unitPrice: 1.99 },
        { productId: 'S-12230',  quantity: 3000, unitPrice: 0.015 }, // 3 cartons → 3000 eaches
    ];

    currentPO.orderItemList = validItems.map(item => ({
        productUrl: `/${accountPath}/api/product/${encodeURIComponent(item.productId)}`,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
    }));

    console.log(`Setting ${currentPO.orderItemList.length} valid items...`);

    const postRes = await fetch(`${apiBase}/${accountPath}/api/order/${encodedId}`, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(currentPO),
    });

    if (!postRes.ok) {
        console.error('POST failed:', postRes.status, await postRes.text());
        process.exit(1);
    }

    console.log('✅ PO updated');

    // Verify
    const verifyRes = await fetch(getUrl, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    const verified = await verifyRes.json();
    console.log(`\nFinal PO 124915 has ${verified.orderItemList?.length || 0} items:`);
    for (const item of verified.orderItemList || []) {
        const sku = item.productUrl?.split('/').pop() || '?';
        console.log(`  ${sku.padEnd(12)} qty=${item.quantity}  price=$${item.unitPrice}`);
    }

    console.log('\n⚠️  Skipped (not in Finale product master):');
    console.log('  S-10748B (240 @ $1.65) - F-Style Jugs');
    console.log('  H-11721 (1 @ $735) - Evaporative Cooler');
    console.log('  H-1717BL (2 @ $60) - Anti-Fatigue Mat');
}

main().catch(e => { console.error(e.message); process.exit(1); });

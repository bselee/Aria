import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY || ''}:${process.env.FINALE_API_SECRET || ''}`).toString('base64')}`;

async function main() {
    const orderId = '124915';
    console.log(`Fetching PO ${orderId} via REST...`);
    
    const url = `${apiBase}/${accountPath}/api/order/${encodeURIComponent(orderId)}`;
    const res = await fetch(url, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    
    if (!res.ok) {
        console.error(`HTTP ${res.status}: ${await res.text()}`);
        return;
    }
    
    const ord = await res.json();
    console.log(`\nPO: ${ord.orderId || ord.id}`);
    console.log(`Status: ${ord.statusId || ord.status}`);
    console.log(`Date: ${ord.orderDate}`);
    console.log(`Total: $${ord.total || ord.grandTotal || '?'}`);
    console.log(`Memo: ${(ord.memo || '').substring(0, 300)}`);
    
    const items = ord.itemList || ord.items || [];
    console.log(`\nItems (${items.length}):`);
    for (const item of items) {
        const sku = item.productId || item.product?.productId || '?';
        const qty = item.quantity ?? item.quantityOrdered ?? '?';
        const price = item.unitPrice ?? item.cost ?? '?';
        console.log(`  ${sku.padEnd(12)} qty=${String(qty).padEnd(8)} price=$${price}`);
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });

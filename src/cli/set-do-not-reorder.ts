import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString('base64')}`;

const skus = ['S-10748B', 'H-11721', 'H-1717BL'];

async function setDoNotReorder(sku: string) {
    const url = `${apiBase}/${accountPath}/api/product/${encodeURIComponent(sku)}`;
    
    // Fetch current product
    const getRes = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    if (!getRes.ok) {
        console.log(`${sku}: Could not fetch`);
        return;
    }
    const product = await getRes.json();
    
    // Update reorderMethod
    product.reorderMethod = 'do_not_reorder';
    
    const postRes = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
    });
    
    if (postRes.ok) {
        console.log(`${sku}: ✅ Set to do_not_reorder`);
    } else {
        console.log(`${sku}: ❌ Failed to update`);
    }
}

async function main() {
    for (const sku of skus) {
        await setDoNotReorder(sku);
        await new Promise(r => setTimeout(r, 300));
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });

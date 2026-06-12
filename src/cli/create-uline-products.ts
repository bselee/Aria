import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const accountPath = process.env.FINALE_ACCOUNT_PATH!;
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const authHeader = `Basic ${Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString('base64')}`;

const missingProducts = [
    {
        productId: 'S-10748B',
        internalName: 'F-Style Jugs Bulk Pack - 1 Gallon, White',
        description: 'F-Style Jugs Bulk Pack - 1 Gallon, White',
        category: '33-Jars, Jugs and Bottles',
        unitPrice: 1.65,
    },
    {
        productId: 'H-11721',
        internalName: 'Economy Evaporative Cooler - 19"',
        description: 'Economy Evaporative Cooler - 19"',
        category: '46-Fans and HVAC',
        unitPrice: 735.00,
    },
    {
        productId: 'H-1717BL',
        internalName: 'Anti-Fatigue Mat - 5/8" thick, 3 x 4, Black',
        description: 'Anti-Fatigue Mat - 5/8" thick, 3 x 4, Black',
        category: '36-Mats',
        unitPrice: 60.00,
    },
];

async function createProduct(p: any) {
    const url = `${apiBase}/${accountPath}/api/product/${encodeURIComponent(p.productId)}`;
    
    // Try minimal payload first
    const payload = {
        productId: p.productId,
        internalName: p.internalName,
        description: p.description,
        category: p.category,
        reorderMethod: 'do_not_reorder',
        status: 'Active',
    };

    console.log(`Creating ${p.productId}...`);
    
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (res.ok) {
        console.log(`  ✅ Created ${p.productId}`);
        return true;
    } else {
        const text = await res.text();
        console.log(`  ❌ Failed ${p.productId}: ${res.status} ${text.substring(0, 200)}`);
        return false;
    }
}

async function main() {
    for (const p of missingProducts) {
        await createProduct(p);
        await new Promise(r => setTimeout(r, 300));
    }
    
    console.log('\nDone creating products.');
}

main().catch(e => { console.error(e.message); process.exit(1); });

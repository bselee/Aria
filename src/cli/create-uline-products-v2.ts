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
    },
    {
        productId: 'H-11721',
        internalName: 'Economy Evaporative Cooler - 19"',
        description: 'Economy Evaporative Cooler - 19"',
        category: '46-Fans and HVAC',
    },
    {
        productId: 'H-1717BL',
        internalName: 'Anti-Fatigue Mat - 5/8" thick, 3 x 4, Black',
        description: 'Anti-Fatigue Mat - 5/8" thick, 3 x 4, Black',
        category: '36-Mats',
    },
];

async function createProduct(p: any) {
    const url = `${apiBase}/${accountPath}/api/product`;
    
    const payload = {
        productId: p.productId,
        internalName: p.internalName,
        description: p.description,
        category: p.category,
        reorderMethod: 'do_not_reorder',
        status: 'Active',
    };

    console.log(`Creating ${p.productId} via POST /api/product...`);
    
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (res.ok) {
        console.log(`  ✅ Created ${p.productId}`);
        return true;
    } else {
        console.log(`  ❌ Failed ${p.productId}: ${res.status} ${text.substring(0, 300)}`);
        return false;
    }
}

async function main() {
    for (const p of missingProducts) {
        await createProduct(p);
        await new Promise(r => setTimeout(r, 400));
    }
    console.log('\nDone.');
}

main().catch(e => { console.error(e.message); process.exit(1); });

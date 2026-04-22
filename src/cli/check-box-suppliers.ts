import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function getBoxSuppliers() {
    const client: any = new FinaleClient();
    console.log("🔍 Checking all SKUs with 'BOX' in the ID...");

    try {
        const catalog = await client.getProductCatalog();
        const boxIds = catalog.filter(id => id.toUpperCase().includes('BOX'));

        console.log(`Found ${boxIds.length} candidate box SKUs. Checking first 20 for suppliers...`);

        for (const id of boxIds.slice(0, 20)) {
            const product = await client.lookupProduct(id);
            if (!product) continue;
            console.log(`${id.padEnd(15)} | ${product.suppliers.map(s => s.name).join(', ') || 'NONE'}`);
        }

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

getBoxSuppliers();

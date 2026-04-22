import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function listAllUls() {
    const client: any = new FinaleClient();
    try {
        const catalog = await client.getProductCatalog();
        const ulsIds = catalog.filter(id => id.toUpperCase().startsWith('ULS'));
        for (const id of ulsIds) {
            const product = await client.lookupProduct(id);
            if (product) {
                console.log(`${id.padEnd(12)} | ${product.name.padEnd(40)} | ${product.suppliers.map(s => s.name).join(', ')}`);
            }
        }
    } catch (err) {}
}
listAllUls();

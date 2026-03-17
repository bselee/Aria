import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from './src/lib/finale/client';

async function run() {
    const c = new FinaleClient();
    const res = await (c as any).get('/buildasoilorganics/api/order/124312');
    console.dir({ supplierUrl: res.supplierUrl, supplierPartyUrl: res.supplierPartyUrl, partyUrl: res.partyUrl }, { depth: null });
}
run().catch(console.error);

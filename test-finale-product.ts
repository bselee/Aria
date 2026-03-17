import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from './src/lib/finale/client';

async function run() {
    const c = new FinaleClient();
    const res = await (c as any).get('/buildasoilorganics/api/product/S-4905');
    console.dir(res, { depth: null });
}
run().catch(console.error);

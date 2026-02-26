import { FinaleClient } from './src/lib/finale/client';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function run() {
    const c = new FinaleClient();
    console.log("Searching for 'GnarBar'...");
    const res = await c.searchProducts('GnarBar');
    console.log(res);

    console.log("\nSearching for 'GNARBAR'...");
    const res2 = await c.searchProducts('GNARBAR');
    console.log(res2);
    process.exit(0);
}
run();

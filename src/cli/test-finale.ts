import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function test() {
    const client = new FinaleClient();

    // Test product that IS on a committed PO (RAWFISHBONE on PO 124400)
    console.log("═══ Product ON a committed PO ═══\n");
    const report1 = await client.productReport("RAWFISHBONE");
    console.log(report1.telegramMessage);

    // Test product NOT on any PO
    console.log("\n\n═══ Product NOT on any PO ═══\n");
    const report2 = await client.productReport("S-12527");
    console.log(report2.telegramMessage);

    process.exit(0);
}
test();

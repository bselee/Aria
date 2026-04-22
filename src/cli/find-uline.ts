import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function findUlineSupplier() {
    const client: any = new FinaleClient();
    try {
        const response = await client.api.get(`/${process.env.FINALE_ACCOUNT_PATH}/api/partygroup`);
        const parties = response.data.printableList || [];
        const uline = parties.filter((p: any) => p.name.toUpperCase().includes('ULINE'));
        console.log("ULINE Parties:", JSON.stringify(uline, null, 2));
    } catch (err) {
        console.error(err);
    }
}
findUlineSupplier();

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { FinaleClient } from '../lib/finale/client';

async function checkUls490() {
    const client = new FinaleClient();
    const id = 'ULS490';
    const activity = await client.getProductActivity(id, 365);
    console.log(`Activity for ${id}:`, JSON.stringify(activity, null, 2));
}
checkUls490();

import { Pinecone } from '@pinecone-database/pinecone';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function checkPinecone() {
    const apiKey = process.env.PINECONE_API_KEY;
    const indexName = process.env.PINECONE_INDEX || 'aria-ops';

    if (!apiKey) {
        console.error('❌ PINECONE_API_KEY is missing from .env.local');
        return;
    }

    try {
        const pc = new Pinecone({ apiKey });
        const { indexes } = await pc.listIndexes();
        console.log('✅ Connected to Pinecone.');
        console.log('Available indexes:', indexes?.map(i => i.name).join(', ') || 'None');

        const indexExists = indexes?.some(i => i.name === indexName);
        if (indexExists) {
            console.log(`✅ Index "${indexName}" exists.`);
            const stats = await pc.index(indexName).describeIndexStats();
            console.log('Index Stats:', JSON.stringify(stats, null, 2));
        } else {
            console.log(`⚠️ Index "${indexName}" not found. Creating it...`);
            // This might fail if the user is on a free tier or wants specific dimensions
        }
    } catch (err: any) {
        console.error('❌ Pinecone connection failed:', err.message);
    }
}

checkPinecone();

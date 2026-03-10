/**
 * @file    check-pinecone.ts
 * @purpose CLI diagnostic — verifies Pinecone connectivity and reports stats
 *          for both indexes (gravity-memory + email-embeddings).
 * @author  Will / Antigravity
 * @created 2026-02-24
 * @updated 2026-03-09
 * @deps    @pinecone-database/pinecone, dotenv
 * @env     PINECONE_API_KEY, PINECONE_INDEX, PINECONE_EMAIL_INDEX
 */

import { Pinecone } from '@pinecone-database/pinecone';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function checkPinecone() {
    const apiKey = process.env.PINECONE_API_KEY;

    if (!apiKey) {
        console.error('❌ PINECONE_API_KEY is missing from .env.local');
        return;
    }

    try {
        const pc = new Pinecone({ apiKey });
        const { indexes } = await pc.listIndexes();
        console.log('✅ Connected to Pinecone.');
        console.log('Available indexes:', indexes?.map(i => i.name).join(', ') || 'None');

        // Check both indexes used by Aria
        const indexNames = [
            process.env.PINECONE_INDEX || 'gravity-memory',
            process.env.PINECONE_EMAIL_INDEX || 'email-embeddings',
        ];

        for (const name of indexNames) {
            const exists = indexes?.some(i => i.name === name);
            if (exists) {
                console.log(`\n✅ Index "${name}" exists.`);
                const stats = await pc.index(name).describeIndexStats();
                console.log('Index Stats:', JSON.stringify(stats, null, 2));
            } else {
                console.log(`\n⚠️ Index "${name}" not found.`);
            }
        }
    } catch (err: any) {
        console.error('❌ Pinecone connection failed:', err.message);
    }
}

checkPinecone();

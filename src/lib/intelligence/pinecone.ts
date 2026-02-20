/**
 * @file    pinecone.ts
 * @purpose Pinecone client wrapper for indexing operational context.
 */

import { Pinecone } from '@pinecone-database/pinecone';

let pc: Pinecone | null = null;

export async function indexOperationalContext(id: string, text: string, metadata: any) {
    const apiKey = process.env.PINECONE_API_KEY;
    const indexName = process.env.PINECONE_INDEX || 'aria-ops';

    if (!apiKey) {
        console.warn("⚠️ PINECONE_API_KEY missing, skipping index.");
        return;
    }

    try {
        if (!pc) {
            pc = new Pinecone({ apiKey });
        }

        const index = pc.index(indexName);

        console.log(`🧠 Indexing context for [${id}] to Pinecone (${indexName})...`);

        // In a full implementation, we'd use OpenAI embeddings here.
        // For now, we'll continue using the metadata storage strategy with a dummy vector.
        const vector = new Array(768).fill(0.0001); // Tiny non-zero vector for Pinecone compliance
        await index.upsert([{
            id,
            values: vector,
            metadata: {
                ...metadata,
                text: text.slice(0, 8000), // Store text for RAG
                indexed_at: new Date().toISOString()
            }
        }]);
        console.log(`✅ Successfully indexed operational context.`);
    } catch (err: any) {
        console.error("Pinecone error:", err.message);
    }
}

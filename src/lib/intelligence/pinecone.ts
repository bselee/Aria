/**
 * @file    pinecone.ts
 * @purpose Pinecone client wrapper for indexing PO operational context.
 *          Uses the email-embeddings index (768d) with dummy vectors.
 *          For semantic memory (remember/recall), see memory.ts → gravity-memory (1024d).
 */

import { Pinecone } from '@pinecone-database/pinecone';

let pc: Pinecone | null = null;

export async function indexOperationalContext(id: string, text: string, metadata: any) {
    const apiKey = process.env.PINECONE_API_KEY;
    // email-embeddings is a 768d index — uses dummy vectors, metadata is the payload.
    // Do NOT change to PINECONE_INDEX — that points to gravity-memory (1024d, semantic memory).
    const indexName = process.env.PINECONE_EMAIL_INDEX || 'email-embeddings';
    const indexHost = process.env.PINECONE_EMAIL_HOST;

    if (!apiKey) {
        console.warn("⚠️ PINECONE_API_KEY missing, skipping index.");
        return;
    }

    try {
        if (!pc) {
            pc = new Pinecone({ apiKey });
        }

        // Use explicit host when available — bypasses control-plane lookup on every call
        const index = indexHost ? pc.index(indexName, indexHost) : pc.index(indexName);

        console.log(`🧠 Indexing context for [${id}] to Pinecone (${indexName})...`);

        // Dummy 768d vector — matches email-embeddings index dimension.
        // Metadata is the searchable payload; vector similarity is not used here.
        const vector = new Array(768).fill(0.0001);
        await index.upsert([{
            id,
            values: vector,
            metadata: {
                ...metadata,
                text: text.slice(0, 8000),
                indexed_at: new Date().toISOString()
            }
        }]);
        console.log(`✅ Successfully indexed operational context.`);
    } catch (err: any) {
        console.error("Pinecone error:", err.message);
    }
}

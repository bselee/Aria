/**
 * @file    embedding.ts
 * @purpose Centralized embedding module — generates 1024-dimensional vectors
 *          for memory search. Uses OpenAI text-embedding-3-small.
 * @author  Will / Antigravity / Hermia
 * @created 2026-02-24
 * @updated 2026-05-28
 * @deps    openai
 * @env     OPENAI_API_KEY
 *
 * HERMIA(2026-05-28): Migrated from Pinecone Inference (llama-text-embed-v2)
 * to OpenAI text-embedding-3-small. Both output 1024d vectors.
 * Existing Pinecone vectors are INCOMPATIBLE (different embedding space) —
 * the import script re-embeds all stored content from metadata.
 *
 * Cost: ~$0.02/MTok. At Aria's volume (~1000 embeds/day, avg 500 chars each),
 * estimated cost is <$0.50/month.
 *
 * @original-deps @pinecone-database/pinecone (REMOVED)
 */

import OpenAI from 'openai';

let client: OpenAI | null = null;

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1024;
const MAX_INPUT_CHARS = 8000;
const MAX_RETRIES = 3;

// Circuit breaker: when provider issues occur, skip all calls for DEAD_TIMEOUT_MS
let deadUntil = 0;
const DEAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function getOpenAIClient(): OpenAI {
    if (!client) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error('OPENAI_API_KEY not set — required for embeddings');
        client = new OpenAI({ apiKey });
    }
    return client;
}

/**
 * Generate an embedding vector from text using OpenAI text-embedding-3-small.
 *
 * @param   text  - Input text to embed (truncated to 8000 chars internally)
 * @returns Float array (1024d), or null if all retries exhausted
 *
 * Callers MUST handle `null` gracefully:
 *   - remember() → skip the upsert, log warning
 *   - recall()   → return empty results, log warning
 */
export async function embed(text: string): Promise<number[] | null> {
    if (deadUntil && Date.now() < deadUntil) return null;
    if (deadUntil && Date.now() >= deadUntil) {
        deadUntil = 0;
        console.log('🔄 Embedding circuit breaker reset — retrying OpenAI...');
    }

    const openai = getOpenAIClient();
    const truncatedText = text.slice(0, MAX_INPUT_CHARS);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const result = await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: truncatedText,
                dimensions: EMBEDDING_DIMENSIONS,
            });

            const embedding = result?.data?.[0]?.embedding;
            if (!embedding || !Array.isArray(embedding)) {
                console.warn('⚠️ OpenAI returned no embedding data');
                return null;
            }
            return embedding;
        } catch (err: any) {
            const msg = err?.message || '';
            const is429 = err?.status === 429 || msg.includes('429') || msg.includes('rate limit');
            const isQuotaExceeded = msg.includes('quota') || msg.includes('exceeded') || msg.includes('billing') || msg.includes('insufficient');

            if (is429 && !isQuotaExceeded && attempt < MAX_RETRIES - 1) {
                const backoffMs = Math.pow(2, attempt + 1) * 1000;
                console.warn(`⏳ Embedding rate-limited (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${backoffMs / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                continue;
            }

            if (isQuotaExceeded) {
                deadUntil = Date.now() + DEAD_TIMEOUT_MS;
                console.warn('🛑 Embedding provider circuit-broken for 10 min (quota exhausted). Memory calls will be skipped.');
            } else if (attempt === 0) {
                console.error(`❌ Embedding unavailable: ${msg.slice(0, 120)}`);
            }
            return null;
        }
    }
    return null;
}

/**
 * Generate an embedding optimized for search queries (vs passage storage).
 * OpenAI text-embedding-3-small handles query/passage distinction implicitly
 * through training — no separate inputType parameter needed.
 *
 * @param   query - Search query text
 * @returns Float array (1024d), or null on failure
 */
export async function embedQuery(query: string): Promise<number[] | null> {
    // OpenAI text-embedding-3-small uses the same endpoint for queries and passages.
    // The model is trained to handle both — no asymmetric embedding needed.
    return embed(query);
}

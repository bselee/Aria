/**
 * @file    embedding.ts
 * @purpose Centralized embedding module — single source of truth for vector generation.
 *          Used by memory.ts and vendor-memory.ts. Includes retry with exponential
 *          backoff for errors and graceful null-return on failure.
 * @author  Will / Antigravity
 * @created 2026-02-24
 * @updated 2026-03-13
 * @deps    @pinecone-database/pinecone
 * @env     PINECONE_API_KEY
 *
 * DECISION(2026-03-06): Extracted from duplicated embed() in memory.ts and vendor-memory.ts.
 * Single place to swap providers (e.g., Gemini text-embedding-004) if needed later.
 * The gravity-memory Pinecone index is 1024d — any replacement model must output 1024d.
 *
 * DECISION(2026-03-11): Added circuit breaker to prevent log spam when quota is exhausted.
 * Logs the error once, then silently returns null for 10 minutes before retrying.
 *
 * DECISION(2026-03-13): Switched from OpenAI text-embedding-3-small to Pinecone Inference
 * llama-text-embed-v2 — eliminates OpenAI quota dependency entirely. Pinecone Inference
 * is included with the Pinecone API key, no separate billing. Model supports 1024d output
 * natively, matching the existing gravity-memory index dimensions.
 */

import { Pinecone } from '@pinecone-database/pinecone';

let pc: Pinecone | null = null;

/** Embedding model config — change here to swap providers project-wide. */
const EMBEDDING_MODEL = 'llama-text-embed-v2';
const MAX_INPUT_CHARS = 8000;
const MAX_RETRIES = 3;

// Circuit breaker: when provider issues occur, skip all calls for DEAD_TIMEOUT_MS
// to avoid spamming the error log on every embed() call.
let deadUntil = 0;
const DEAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Lazy-init the Pinecone client singleton.
 * Reused across embed() calls to avoid re-creating connections.
 */
function getPineconeClient(): Pinecone {
    if (!pc) {
        const apiKey = process.env.PINECONE_API_KEY;
        if (!apiKey) throw new Error('PINECONE_API_KEY not set — required for embeddings');
        pc = new Pinecone({ apiKey });
    }
    return pc;
}

/**
 * Generate an embedding vector from text using Pinecone Inference (llama-text-embed-v2).
 *
 * @param   text  - Input text to embed (truncated to 8000 chars internally)
 * @returns Float array, or null if all retries exhausted (error/rate-limit)
 *
 * Callers MUST handle `null` gracefully:
 *   - remember() → skip the upsert, log warning
 *   - recall()   → return empty results, log warning
 */
export async function embed(text: string): Promise<number[] | null> {
    // Circuit breaker — skip immediately if provider was recently dead
    if (deadUntil && Date.now() < deadUntil) {
        return null;
    }
    // If circuit breaker expired, reset it and try again
    if (deadUntil && Date.now() >= deadUntil) {
        deadUntil = 0;
        console.log('🔄 Embedding circuit breaker reset — retrying Pinecone Inference...');
    }

    const client = getPineconeClient();
    const truncatedText = text.slice(0, MAX_INPUT_CHARS);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const result = await client.inference.embed(
                EMBEDDING_MODEL,
                [truncatedText],
                { inputType: 'passage', truncate: 'END', dimension: '1024' }
            );

            // EmbeddingsList → data[0].values is the vector
            const embedding = result?.data?.[0]?.values;
            if (!embedding || !Array.isArray(embedding)) {
                console.warn('⚠️ Pinecone Inference returned no embedding data');
                return null;
            }
            return embedding as number[];
        } catch (err: any) {
            const msg = err?.message || '';
            const is429 = err?.status === 429 || msg.includes('429') || msg.includes('rate limit');
            const isQuotaExceeded = msg.includes('quota') || msg.includes('exceeded') || msg.includes('billing');

            if (is429 && !isQuotaExceeded && attempt < MAX_RETRIES - 1) {
                const backoffMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
                console.warn(`⏳ Embedding rate-limited (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${backoffMs / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                continue;
            }

            // Hard error — trip circuit breaker, log once, suppress for 10 min
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
 * Uses inputType: 'query' which produces vectors tuned for retrieval.
 *
 * @param   query - Search query text
 * @returns Float array, or null on failure
 */
export async function embedQuery(query: string): Promise<number[] | null> {
    // Circuit breaker — same as embed()
    if (deadUntil && Date.now() < deadUntil) {
        return null;
    }
    if (deadUntil && Date.now() >= deadUntil) {
        deadUntil = 0;
        console.log('🔄 Embedding circuit breaker reset — retrying Pinecone Inference...');
    }

    const client = getPineconeClient();

    try {
        const result = await client.inference.embed(
            EMBEDDING_MODEL,
            [query.slice(0, MAX_INPUT_CHARS)],
            { inputType: 'query', truncate: 'END', dimension: '1024' }
        );

        const embedding = result?.data?.[0]?.values;
        if (!embedding || !Array.isArray(embedding)) {
            console.warn('⚠️ Pinecone Inference returned no embedding data for query');
            return null;
        }
        return embedding as number[];
    } catch (err: any) {
        console.error(`❌ embedQuery() failed: ${(err?.message || '').slice(0, 120)}`);
        return null;
    }
}

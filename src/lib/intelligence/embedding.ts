/**
 * @file    embedding.ts
 * @purpose Centralized embedding module — generates 1024-dimensional vectors
 *          for memory search. Uses OpenAI text-embedding-3-small with local
 *          deterministic hashing unit-vector fallback.
 * @author  Will / Antigravity / Hermia
 * @created 2026-02-24
 * @updated 2026-06-01
 * @deps    openai
 * @env     OPENAI_API_KEY
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
 * Deterministic 1024-dimensional local embedding fallback.
 * Uses the hashing trick (feature hashing) to generate a unit vector of 1024 dimensions.
 * Safe, dependency-free, and extremely fast.
 *
 * @param   text - Input text to hash
 * @returns 1024-dimensional normalized vector
 */
export function generateLocalFallbackEmbedding(text: string): number[] {
    const dimensions = EMBEDDING_DIMENSIONS;
    const vector = new Array(dimensions).fill(0);
    
    const cleanText = text.toLowerCase().trim();
    if (!cleanText) {
        vector[0] = 1.0;
        return vector;
    }

    // Tokenize by words and n-grams
    const words = cleanText.split(/\s+/);
    const tokens = [...words];
    
    // Add 3-character n-grams for sub-word matching
    for (let i = 0; i < cleanText.length - 2; i++) {
        tokens.push(cleanText.slice(i, i + 3));
    }

    // Simple deterministic string hashing (FNV-1a style)
    const hashString = (str: string): number => {
        let hash = 2166136261;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    };

    for (const token of tokens) {
        const h = hashString(token);
        const index = h % dimensions;
        // Deterministic sign (+1 or -1) to prevent bias
        const sign = (hashString(token + "_sign") % 2 === 0) ? 1 : -1;
        vector[index] += sign;
    }

    // Calculate L2 norm
    let l2Norm = 0;
    for (let i = 0; i < dimensions; i++) {
        l2Norm += vector[i] * vector[i];
    }
    l2Norm = Math.sqrt(l2Norm);

    // Normalize to unit vector
    if (l2Norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            vector[i] = vector[i] / l2Norm;
        }
    } else {
        vector[0] = 1.0;
    }

    return vector;
}

/**
 * Generate an embedding vector from text using OpenAI text-embedding-3-small.
 * If OpenAI is unavailable, offline, or quota-limited, falls back to the deterministic local vectorizer.
 *
 * @param   text  - Input text to embed (truncated to 8000 chars internally)
 * @returns Float array (1024d)
 */
export async function embed(text: string): Promise<number[] | null> {
    if (deadUntil && Date.now() < deadUntil) {
        return generateLocalFallbackEmbedding(text);
    }
    if (deadUntil && Date.now() >= deadUntil) {
        deadUntil = 0;
        console.log('🔄 Embedding circuit breaker reset — retrying OpenAI...');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        // Fallback silently if API key is not configured (e.g. testing / local dev)
        return generateLocalFallbackEmbedding(text);
    }

    try {
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
                    return generateLocalFallbackEmbedding(text);
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
                    console.warn('🛑 Embedding provider circuit-broken for 10 min (quota exhausted). Memory calls will fall back to local embedding.');
                } else if (attempt === 0) {
                    console.error(`❌ Embedding unavailable: ${msg.slice(0, 120)}`);
                }
                return generateLocalFallbackEmbedding(text);
            }
        }
    } catch (err: any) {
        console.error(`❌ OpenAI client error: ${err.message}`);
        return generateLocalFallbackEmbedding(text);
    }
    return generateLocalFallbackEmbedding(text);
}

/**
 * Generate an embedding optimized for search queries (vs passage storage).
 * OpenAI text-embedding-3-small handles query/passage distinction implicitly
 * through training — no separate inputType parameter needed.
 *
 * @param   query - Search query text
 * @returns Float array (1024d)
 */
export async function embedQuery(query: string): Promise<number[] | null> {
    return embed(query);
}

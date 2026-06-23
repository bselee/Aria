/**
 * @file    embedding.ts
 * @purpose Centralized embedding module — generates 1024-dimensional vectors
 *          for memory search. DECISION(2026-06-23): Switched from OpenAI to
 *          OpenRouter (text-embedding-3-small) to match Honcho's config and
 *          avoid OpenAI quota exhaustion. Falls back to local deterministic
 *          hashing when OpenRouter is unavailable.
 * @author  Will / Antigravity / Hermia
 * @created 2026-02-24
 * @updated 2026-06-23
 * @deps    none (fetch-based)
 * @env     OPENROUTER_API_KEY
 */

import { createHash } from 'crypto';

const EMBEDDING_MODEL = 'openai/text-embedding-3-small'; // OpenRouter path
const EMBEDDING_DIMENSIONS = 1024;
const MAX_INPUT_CHARS = 8000;
const MAX_RETRIES = 2;

// Circuit breaker: when provider issues occur, skip all calls for deadTimeoutMs.
// DECISION(2026-06-23): Reduced from 10min to 30s. The 10min cooldown was
// excessive — a transient quota hiccup blocked the entire embedding pipeline
// for 10 minutes, starving every cron job in the single-threaded event loop.
// 30s is enough to let quota reset without killing cron cadence.
let deadUntil = 0;
const DEAD_TIMEOUT_MS = 30 * 1000; // 30 seconds

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
 * Generate an embedding vector from text using OpenRouter (text-embedding-3-small).
 * Falls back to local deterministic hashing on any failure.
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
        console.log('🔄 Embedding circuit breaker reset — retrying OpenRouter...');
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return generateLocalFallbackEmbedding(text);
    }

    try {
        const truncatedText = text.slice(0, MAX_INPUT_CHARS);

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);

                const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'HTTP-Referer': 'https://aria.buildasoil.com',
                        'X-Title': 'Aria',
                    },
                    body: JSON.stringify({
                        model: EMBEDDING_MODEL,
                        input: truncatedText,
                        dimensions: EMBEDDING_DIMENSIONS,
                    }),
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                if (!resp.ok) {
                    const errText = await resp.text().catch(() => '');
                    const is429 = resp.status === 429;
                    const isQuota = errText.includes('quota') || errText.includes('exceeded') || resp.status === 402;

                    if (is429 && !isQuota && attempt < MAX_RETRIES - 1) {
                        const backoffMs = Math.pow(2, attempt + 1) * 1000;
                        console.warn(`⏳ Embedding rate-limited (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${backoffMs / 1000}s...`);
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                        continue;
                    }

                    if (isQuota) {
                        deadUntil = Date.now() + DEAD_TIMEOUT_MS;
                        console.warn(`🛑 Embedding provider circuit-broken for ${DEAD_TIMEOUT_MS / 1000}s (quota exhausted). Memory calls will fall back to local embedding.`);
                    } else if (attempt === 0) {
                        console.error(`❌ Embedding unavailable: HTTP ${resp.status} — ${errText.slice(0, 120)}`);
                    }
                    return generateLocalFallbackEmbedding(text);
                }

                const result = await resp.json();
                const embedding = result?.data?.[0]?.embedding;
                if (!embedding || !Array.isArray(embedding)) {
                    console.warn('⚠️ OpenRouter returned no embedding data');
                    return generateLocalFallbackEmbedding(text);
                }
                return embedding;
            } catch (err: any) {
                const msg = err?.message || '';
                if (attempt < MAX_RETRIES - 1 && (msg.includes('timeout') || msg.includes('abort'))) {
                    console.warn(`⏳ Embedding timeout (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying...`);
                    continue;
                }
                throw err;
            }
        }
    } catch (err: any) {
        console.error(`❌ Embedding fetch error: ${err.message?.slice(0, 120)}`);
        return generateLocalFallbackEmbedding(text);
    }
    return generateLocalFallbackEmbedding(text);
}

/**
 * Generate an embedding optimized for search queries (vs passage storage).
 * OpenRouter text-embedding-3-small handles query/passage distinction implicitly
 * through training — no separate inputType parameter needed.
 *
 * @param   query - Search query text
 * @returns Float array (1024d)
 */
export async function embedQuery(query: string): Promise<number[] | null> {
    return embed(query);
}

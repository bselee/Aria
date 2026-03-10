/**
 * @file    embedding.ts
 * @purpose Centralized embedding module — single source of truth for vector generation.
 *          Used by memory.ts and vendor-memory.ts. Includes retry with exponential
 *          backoff for 429 errors and graceful null-return on failure.
 * @author  Will / Antigravity
 * @created 2026-03-06
 * @updated 2026-03-06
 * @deps    openai
 * @env     OPENAI_API_KEY
 *
 * DECISION(2026-03-06): Extracted from duplicated embed() in memory.ts and vendor-memory.ts.
 * Single place to swap providers (e.g., Gemini text-embedding-004) if needed later.
 * The gravity-memory Pinecone index is 1024d — any replacement model must output 1024d.
 */

import OpenAI from 'openai';

let openai: OpenAI | null = null;

/** Embedding model config — change here to swap providers project-wide. */
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1024;
const MAX_INPUT_CHARS = 8000;
const MAX_RETRIES = 3;

/**
 * Generate a 1024-dimensional embedding vector from text.
 *
 * @param   text  - Input text to embed (truncated to 8000 chars internally)
 * @returns 1024d float array, or null if all retries exhausted (quota/rate-limit)
 *
 * Callers MUST handle `null` gracefully:
 *   - remember() → skip the upsert, log warning
 *   - recall()   → return empty results, log warning
 */
export async function embed(text: string): Promise<number[] | null> {
    if (!openai) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const res = await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: text.slice(0, MAX_INPUT_CHARS),
                dimensions: EMBEDDING_DIMENSIONS,
            });
            return res.data[0].embedding;
        } catch (err: any) {
            const msg = err?.message || '';
            // Quota exceeded = billing/account limit, won't resolve with a retry in 14s.
            // Only retry for transient rate limits (too many requests per minute).
            const isQuotaExceeded = msg.includes('quota') || msg.includes('exceeded your current') || msg.includes('billing');
            const is429 = err?.status === 429 || err?.code === 429 ||
                (msg.includes('429') || msg.includes('rate limit'));

            if (is429 && !isQuotaExceeded && attempt < MAX_RETRIES - 1) {
                const backoffMs = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
                console.warn(`⏳ Embedding rate-limited (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${backoffMs / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                continue;
            }

            // Quota exceeded or non-retryable error — fail immediately, no backoff
            if (attempt === 0) {
                console.error(`❌ Embedding unavailable: ${msg.slice(0, 120)}`);
            }
            return null;
        }
    }
    return null;
}

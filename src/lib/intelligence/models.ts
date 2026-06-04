/**
 * @file    models.ts
 * @purpose Centralized LLM model configuration — single source of truth for all
 *          model slugs, fallback chains, and OpenRouter provider restrictions.
 * @author  Will / Antigravity
 * @created 2026-03-18
 * @updated 2026-03-18
 * @deps    none (pure config)
 *
 * DECISION(2026-03-18): Created to eliminate scattered model strings across llm.ts,
 * extractor.ts, route.ts, and start-bot.ts. Every model in the fallback chain is
 * proven for structured JSON extraction, tool calling, and invoice analysis.
 *
 * MIGRATION(2026-03-18): gemini-2.0-flash → gemini-2.5-flash.
 * Google deprecated 2.0-flash for new API keys. 2.5-flash is the current production model.
 *
 * Llama 3.3 70B REMOVED — unreliable at constrained JSON generation (Zod schemas),
 * tool calling, and structured invoice parsing. Only Anthropic, Google, and OpenAI
 * models are trusted for production workloads.
 */

// ── OpenRouter Provider Restrictions ────────────────────────────────────────
// DECISION(2026-03-18): Lock every OpenRouter call to the Big 3 providers.
// Prevents routing to unknown/untested providers that may degrade quality.
export const OPENROUTER_PROVIDER_OPTS = {
    only: ['anthropic', 'google', 'openai'] as string[],
    require_parameters: true,
} as const;

// ── Model Slugs ─────────────────────────────────────────────────────────────
// Canonical model identifiers — change here, propagates everywhere.

/** Direct provider models (called via native SDKs, not through OpenRouter) */
export const DIRECT_MODELS = {
    geminiFlash: 'gemini-2.5-flash',         // Background agent — current production model
    gemini25Flash: 'gemini-2.5-flash',       // Dashboard chat — same model
    gpt4o: 'gpt-4o',
    claudeSonnet: 'claude-sonnet-4-6',
    claudeHaikuOCR: 'claude-haiku-4-5-20251001',
} as const;

/** OpenRouter model slugs (org/model format) */
export const OPENROUTER_MODELS = {
    // HERMIA(2026-06-03): fixed slug — was 'claude-haiku-4-5' (hyphen) but
    // OpenRouter's actual id is 'claude-haiku-4.5' (dot). Every call to
    // the wrong slug 404'd and the chain fell through to Gemini unnecessarily.
    claudeHaiku: 'anthropic/claude-haiku-4.5',
    geminiFlash: 'google/gemini-2.5-flash',  // Uses OpenRouter's quota, not ours
    gpt4oMini: 'openai/gpt-4o-mini',
    gpt4: 'openai/gpt-4',              // Best accuracy + speed (0.62s avg)
    gpt35Turbo: 'openai/gpt-3.5-turbo', // Best value for high-volume (0.74s avg)
    // HERMIA(2026-06-04): DeepSeek V4 Flash — current default model for Aria.
    // Extremely cheap ($0.14/M input), fast, and proven reliable for structured
    // JSON and classification. Added to every chain as the cost-optimised first try.
    deepseekV4: 'deepseek/deepseek-v4-flash',
    // Cheap alternatives for free-tier fallback when openrouter/free router is down
        phi4: 'microsoft/phi-4:free',               // Small, fast, well-maintained on OpenRouter free tier
    } as const;

// ── Fallback Chains ─────────────────────────────────────────────────────────
// Each chain is ordered by: cost (cheapest first) → reliability for the task.

/**
 * OpenRouter fallback models for structured data tasks.
 * Used by llm.ts (background AP agent, reconciler, invoice analysis).
 * Every model is proven for Zod schema generation and tool calling.
 */
export const OPENROUTER_STRUCTURED_CHAIN = [
    { name: 'OpenRouter DeepSeek V4 Flash', slug: OPENROUTER_MODELS.deepseekV4 },  // $0.14/M — cheapest proven, try first
    { name: 'OpenRouter GPT-4', slug: OPENROUTER_MODELS.gpt4 },        // Best accuracy + speed (0.62s)
    { name: 'OpenRouter Claude Haiku 4.5', slug: OPENROUTER_MODELS.claudeHaiku },
    { name: 'OpenRouter Gemini 2.5 Flash', slug: OPENROUTER_MODELS.geminiFlash },
    { name: 'OpenRouter GPT-4o Mini', slug: OPENROUTER_MODELS.gpt4oMini },
] as const;

/**
 * OpenRouter fallback models for chat + tool calling (dashboard, Telegram).
 * Same models — chat quality is equally important.
 */
export const OPENROUTER_CHAT_CHAIN = [
    { name: 'OpenRouter DeepSeek V4 Flash', slug: OPENROUTER_MODELS.deepseekV4 }, // $0.14/M — cheapest, fast, try first
    { name: 'OpenRouter GPT-3.5 Turbo', slug: OPENROUTER_MODELS.gpt35Turbo }, // Fastest chat (0.74s), cheapest
    { name: 'OpenRouter GPT-4', slug: OPENROUTER_MODELS.gpt4 },               // When accuracy matters
    { name: 'OpenRouter Claude Haiku 4.5', slug: OPENROUTER_MODELS.claudeHaiku },
    { name: 'OpenRouter Gemini 2.5 Flash', slug: OPENROUTER_MODELS.geminiFlash },
    { name: 'OpenRouter GPT-4o Mini', slug: OPENROUTER_MODELS.gpt4oMini },
] as const;

/**
 * Free-tier OpenRouter chain for low-stakes classification work.
 * Used by callers that pass `tier: 'free'` to unifiedObjectGeneration.
 *
 * DECISION(2026-04-28): Email triage (acknowledgement-agent, ap-identifier)
 * runs ~1000 calls/day classifying intent. Paid models are wasted there —
 * a 70B free Llama gets the 4-class label right.
 *
 * Free tiers are rate-limited; the cascade falls through to paid Haiku if
 * 429s exhaust the free quota. Models proven viable for JSON via Zod
 * schemas in early 2026 — adjust this list when OpenRouter rotates them.
 */
export const OPENROUTER_FREE_CHAIN = [
    // DECISION(2026-04-28): `openrouter/free` is OpenRouter's "Free Models
    // Router" that auto-picks an available free model per call. Resilient to
    // upstream rotations (no slug rot to chase).
    { name: 'OpenRouter Free Router', slug: 'openrouter/free' },
    // KAIZEN(2026-06-04): Previous Qwen3 80B, MiniMax M2.5, Gemma 4 31B,
    // and Llama 3.3 70B all consistently returned "Provider returned error".
    // Replaced with Phi-4 (free-tier active, microsoft/phi-4) and DeepSeek
    // V4 ($0.14/M fallback — not free but cheap enough to not worry about).
    // The 5+ failed attempts per request were burning ~10s each on dead endpoints.
    { name: 'OpenRouter Phi-4 (free)', slug: OPENROUTER_MODELS.phi4 },
    // Paid fallback: DeepSeek V4 Flash at $0.14/M is still negligible cost
    // for low-stakes classification. Better than burning 5x failed calls.
    { name: 'OpenRouter DeepSeek V4 Flash', slug: OPENROUTER_MODELS.deepseekV4 },
] as const;

/**
 * OpenRouter model slugs for the `models` array in raw fetch calls.
 * Used by extractor.ts for server-side model fallback (one HTTP call).
 */
export const OPENROUTER_VISION_MODELS_ARRAY = [
    OPENROUTER_MODELS.geminiFlash,  // ✅ Supports PDF base64 directly — try first
    OPENROUTER_MODELS.deepseekV4,   // ✅ Supports PDF base64 — cheap $0.14/M
    OPENROUTER_MODELS.gpt4,         // ✅ Supports PDF base64, best accuracy (0.62s)
    OPENROUTER_MODELS.claudeHaiku,  // ❌ PDF base64 → 400 error
    OPENROUTER_MODELS.gpt4oMini,    // Unlikely to support PDF base64
] as const;

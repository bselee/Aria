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
    // HERMIA(2026-06-04): DeepSeek V4 Flash — current default model for Aria.
    // Extremely cheap, fast, and proven reliable for structured JSON and
    // classification. First try in every chain.
    deepseekV4: 'deepseek/deepseek-v4-flash',
    // HERMIA(2026-08-24): GPT-4 and GPT-3.5 stripped from every chain.
    // Live-verified traps: gpt-4 = $30/$60 per M, gpt-3.5-turbo = $0.50/$1.50.
    // Any DeepSeek fallback would have burned 500x on GPT-4. Replaced with
    // live-verified Qwen slugs (old 'qwen3.5-flash' slug has rotated away).
    qwen37Flash: 'qwen/qwen3.7-flash',               // $0.030/$0.130, 1M ctx — cheapest Qwen
    qwen35Flash: 'qwen/qwen3.5-flash-02-23',         // $0.065/$0.260, 1M ctx
    qwen30bA3b: 'qwen/qwen3-30b-a3b-instruct-2507',  // $0.048/$0.193 — MoE, 3B active, fastest chat
    // HERMIA(2026-08-26): Ox Alpha stealth model revealed as ZAI GLM-5.3-Flash
    // (openrouter.ai/stealth/ox-alpha now redirects to z-ai/glm-5.3-flash).
    // $0.075/$0.250 per M, 1M ctx, tools + vision input (text/images/video).
    oxAlpha: 'z-ai/glm-5.3-flash',
} as const;

// ── Fallback Chains ─────────────────────────────────────────────────────────
// Each chain is ordered by: cost (cheapest first) → reliability for the task.

/**
 * OpenRouter fallback models for structured data tasks.
 * Used by llm.ts (background AP agent, reconciler, invoice analysis).
 * Every model is proven for Zod schema generation and tool calling.
 */
export const OPENROUTER_STRUCTURED_CHAIN = [
    { name: 'OpenRouter DeepSeek V4 Flash', slug: OPENROUTER_MODELS.deepseekV4 },  // $0.081/M — proven, structured_outputs, try first
    { name: 'OpenRouter Qwen 3 30B A3B', slug: OPENROUTER_MODELS.qwen30bA3b },     // $0.048/M — cheapest structured_outputs capable
    { name: 'OpenRouter Qwen 3.5 Flash', slug: OPENROUTER_MODELS.qwen35Flash },    // $0.065/M — structured_outputs
    { name: 'OpenRouter Ox Alpha (GLM-5.3-Flash)', slug: OPENROUTER_MODELS.oxAlpha }, // $0.075/M — reasoning fallback, no structured_outputs, fences output
    { name: 'OpenRouter Qwen 3.7 Flash', slug: OPENROUTER_MODELS.qwen37Flash },    // $0.030/M — cheapest overall but response_format-only
    { name: 'OpenRouter GPT-4o Mini', slug: OPENROUTER_MODELS.gpt4oMini },
    { name: 'OpenRouter Gemini 2.5 Flash', slug: OPENROUTER_MODELS.geminiFlash },
    { name: 'OpenRouter Claude Haiku 4.5', slug: OPENROUTER_MODELS.claudeHaiku },  // best structured JSON
] as const;

/**
 * OpenRouter fallback models for chat + tool calling (dashboard, Telegram).
 * Same models — chat quality is equally important.
 */
export const OPENROUTER_CHAT_CHAIN = [
    { name: 'OpenRouter DeepSeek V4 Flash', slug: OPENROUTER_MODELS.deepseekV4 }, // $0.081/M — proven, try first
    { name: 'OpenRouter Qwen 3 30B A3B', slug: OPENROUTER_MODELS.qwen30bA3b },    // $0.048/M — MoE 3B active, cheapest tools+structured
    { name: 'OpenRouter Ox Alpha (GLM-5.3-Flash)', slug: OPENROUTER_MODELS.oxAlpha }, // $0.075/M — 1M ctx, strong reasoning/coding
    { name: 'OpenRouter GPT-4o Mini', slug: OPENROUTER_MODELS.gpt4oMini },
    { name: 'OpenRouter Gemini 2.5 Flash', slug: OPENROUTER_MODELS.geminiFlash },
    { name: 'OpenRouter Claude Haiku 4.5', slug: OPENROUTER_MODELS.claudeHaiku },
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
 *
 * DECISION(2026-07-24): Removed 'openrouter/free' (the Free Models Router).
 * It only succeeded ~30-50% of the time ("No object generated: could not
 * parse the response"), and every failure still burned a full request
 * before falling through to DeepSeek. During the 2026-07-23 heavy-use day
 * the free tier's own daily quota was exhausted, so nearly every call paid
 * for two round-trips (failed free attempt + DeepSeek) instead of one.
 * DeepSeek V4 Flash ($0.081/M live) alone is cheaper than that failure tax and
 * has proven reliable — lead with it directly.
 */
export const OPENROUTER_FREE_CHAIN = [
    { name: 'OpenRouter DeepSeek V4 Flash', slug: OPENROUTER_MODELS.deepseekV4 },
] as const;

/**
 * OpenRouter model slugs for the `models` array in raw fetch calls.
 * Used by extractor.ts for server-side model fallback (one HTTP call).
 */
export const OPENROUTER_VISION_MODELS_ARRAY = [
    OPENROUTER_MODELS.geminiFlash,  // ✅ Supports PDF base64 directly — try first; ONLY model verified OK on our extractor path (200)
    OPENROUTER_MODELS.deepseekV4,   // ❌ 404 on image input; retained only for text-path compat
    // HERMIA(2026-08-26): z-ai/glm-5.3-flash tested live — 400 code 1210 on
    // data:application/pdf;base64. Do NOT add to OCR fallback despite image support.
    // HERMIA(2026-08-24): GPT-4 removed — $30/M on base64 PDF inputs was a
    // 500x trap for every extractor fallback.
    OPENROUTER_MODELS.claudeHaiku,  // ❌ PDF base64 → 400 error
    OPENROUTER_MODELS.gpt4oMini,    // Unlikely to support PDF base64
] as const;

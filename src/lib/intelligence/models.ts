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
    claudeHaiku: 'anthropic/claude-haiku-4-5',
    geminiFlash: 'google/gemini-2.5-flash',  // Uses OpenRouter's quota, not ours
    gpt4oMini: 'openai/gpt-4o-mini',
} as const;

// ── Fallback Chains ─────────────────────────────────────────────────────────
// Each chain is ordered by: cost (cheapest first) → reliability for the task.

/**
 * OpenRouter fallback models for structured data tasks.
 * Used by llm.ts (background AP agent, reconciler, invoice analysis).
 * Every model is proven for Zod schema generation and tool calling.
 */
export const OPENROUTER_STRUCTURED_CHAIN = [
    { name: 'OpenRouter Claude Haiku 4.5', slug: OPENROUTER_MODELS.claudeHaiku },
    { name: 'OpenRouter Gemini 2.5 Flash', slug: OPENROUTER_MODELS.geminiFlash },
    { name: 'OpenRouter GPT-4o Mini', slug: OPENROUTER_MODELS.gpt4oMini },
] as const;

/**
 * OpenRouter fallback models for chat + tool calling (dashboard, Telegram).
 * Same models — chat quality is equally important.
 */
export const OPENROUTER_CHAT_CHAIN = [
    { name: 'OpenRouter Claude Haiku 4.5', slug: OPENROUTER_MODELS.claudeHaiku },
    { name: 'OpenRouter Gemini 2.5 Flash', slug: OPENROUTER_MODELS.geminiFlash },
    { name: 'OpenRouter GPT-4o Mini', slug: OPENROUTER_MODELS.gpt4oMini },
] as const;

/**
 * OpenRouter model slugs for the `models` array in raw fetch calls.
 * Used by extractor.ts for server-side model fallback (one HTTP call).
 */
export const OPENROUTER_VISION_MODELS_ARRAY = [
    OPENROUTER_MODELS.geminiFlash,  // ✅ Supports PDF base64 directly — try first
    OPENROUTER_MODELS.claudeHaiku,  // ❌ PDF base64 → 400 error
    OPENROUTER_MODELS.gpt4oMini,    // Unlikely to support PDF base64
] as const;

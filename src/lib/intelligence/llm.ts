/**
 * @file    llm.ts
 * @purpose Unified LLM entry point with automatic fallback chain.
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-03-18
 * @deps    @ai-sdk/google, @ai-sdk/openai, @ai-sdk/anthropic, ai, zod
 * @env     GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY
 * @env     GEMINI_RPM_LIMIT (optional, default 500), GEMINI_RPD_LIMIT (optional, default 0 = unlimited)
 *
 * DECISION(2026-03-09): Chain is Gemini (free) → OpenRouter (cheap fallback) → paid cloud.
 * Ollama removed — it holds 1-2GB RAM resident on the local machine, causing OOM
 * for both the Aria process and general machine usability.
 * The chain auto-skips any provider without an API key configured.
 *
 * DECISION(2026-03-18): Added shared Gemini rate limiter to prevent quota exhaustion.
 * All Gemini calls (text + object generation) acquire a slot before calling the API.
 * If the rate limiter blocks (daily cap), the chain falls back to OpenRouter immediately.
 *
 * DECISION(2026-03-18): Llama 3.3 70B REMOVED from fallback chain — unreliable at
 * structured JSON extraction (Zod schemas), tool calling, and invoice parsing.
 * Replaced with curated models from models.ts: Claude Haiku 4.5, Gemini 2.0 Flash
 * (via OpenRouter — different quota pool), and GPT-4o Mini.
 */

import { google } from '@ai-sdk/google';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, generateObject, ModelMessage } from 'ai';
import { z } from 'zod';
import { geminiLimiter } from './rate-limiter';
import {
    DIRECT_MODELS,
    OPENROUTER_STRUCTURED_CHAIN,
} from './models';

export type LLMOptions = {
    system?: string;
    prompt?: string;
    messages?: ModelMessage[];
    temperature?: number;
};

// DECISION(2026-02-27): Build provider chain dynamically based on available API keys.
// This prevents wasted time trying providers that will definitely fail.
type ProviderEntry = {
    name: string;
    model: () => any; // Lazy — only instantiate when called
    available: boolean;
};

// DECISION(2026-03-18): OpenRouter fallback models loaded from centralized config.
// All models are proven for structured JSON extraction, tool calling, and invoice analysis.
// Llama REMOVED — replaced with Claude Haiku 4.5, Gemini Flash (OR quota), GPT-4o Mini.
function getOpenRouterProvider(): ProviderEntry[] {
    if (!process.env.OPENROUTER_API_KEY) return [];
    const openrouter = createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
    });
    return OPENROUTER_STRUCTURED_CHAIN.map(entry => ({
        name: entry.name,
        model: () => openrouter(entry.slug),
        available: true,
    }));
}

// DECISION(2026-03-18): Task-appropriate provider chain for background agent work.
//
// The chain is designed with cost + resource awareness:
//   1. Gemini (free tier, fast, reliable) — handles the majority of background calls
//   2. OpenRouter (cheap) — activates when Gemini is down or quota-exhausted.
//      Provides Claude Haiku 4.5, Gemini Flash (OR quota), GPT-4o Mini.
//      ALL models proven for structured JSON, tool calling, and invoice analysis.
//   3. OpenAI / Anthropic (paid, direct) — last-resort escalation.
//
// Llama 3.3 70B REMOVED (2026-03-18): unreliable at Zod schemas and tool calling.
// Chain: Gemini (free) → OpenRouter (cheap, curated) → OpenAI → Anthropic
function getProviderChain(): ProviderEntry[] {
    return [
        {
            name: 'Gemini 2.5 Flash',
            model: () => google(DIRECT_MODELS.geminiFlash),
            available: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        },
        ...getOpenRouterProvider(),  // Cheap fallback — curated models from models.ts
        {
            name: 'OpenAI GPT-4o',
            model: () => openai.chat(DIRECT_MODELS.gpt4o),
            available: !!process.env.OPENAI_API_KEY,
        },
        {
            name: 'Anthropic Claude Sonnet 4.6',
            model: () => anthropic(DIRECT_MODELS.claudeSonnet),
            available: !!process.env.ANTHROPIC_API_KEY,
        },
    ].filter(p => p.available);
}

// Circuit Breaker: Track dead providers globally to prevent endless fail loops on big batches
const deadProviders = new Map<string, number>();
const DEAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function isProviderDead(name: string): boolean {
    const deadUntil = deadProviders.get(name);
    if (!deadUntil) return false;
    if (Date.now() > deadUntil) {
        deadProviders.delete(name);
        return false;
    }
    return true;
}

function markProviderDead(name: string, reason: string) {
    console.warn(`🛑 Circuit breaking ${name} for 5 minutes. Reason: ${reason}`);
    deadProviders.set(name, Date.now() + DEAD_TIMEOUT_MS);
}

/**
 * Get the current status of all providers in the chain.
 * Used by /status command to show circuit breaker state.
 *
 * @returns Array of { name, status, detail } for each configured provider
 */
export function getProviderStatus(): Array<{ name: string; status: 'healthy' | 'dead'; detail: string }> {
    const chain = getProviderChain();
    const limiterStatus = geminiLimiter.getStatus();
    return chain.map(p => {
        const deadUntil = deadProviders.get(p.name);
        if (deadUntil && Date.now() < deadUntil) {
            const remainingSec = Math.ceil((deadUntil - Date.now()) / 1000);
            const remainingMin = Math.ceil(remainingSec / 60);
            return {
                name: p.name,
                status: 'dead' as const,
                detail: `circuit broken (${remainingMin}m remaining)`,
            };
        }
        // Enrich Gemini entry with rate limiter stats
        if (p.name.toLowerCase().includes('gemini')) {
            return {
                name: p.name,
                status: 'healthy' as const,
                detail: `ready (${limiterStatus.rpm}/${limiterStatus.maxRpm} RPM, ${limiterStatus.rpd}/${limiterStatus.maxRpd} RPD, ${limiterStatus.queueDepth} queued)`,
            };
        }
        return {
            name: p.name,
            status: 'healthy' as const,
            detail: 'ready',
        };
    });
}

/**
 * Generates raw text using the provider fallback chain.
 * Tries each available provider in order until one succeeds.
 */
export async function unifiedTextGeneration(options: LLMOptions): Promise<string> {
    const providers = getProviderChain();

    if (providers.length === 0) {
        throw new Error('No LLM providers configured. Set GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.');
    }

    let lastError: Error | null = null;

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];

        if (isProviderDead(provider.name)) {
            continue;
        }



        try {
            // DECISION(2026-03-18): Rate-limit Gemini calls to stay within quota
            if (provider.name.toLowerCase().includes('gemini')) {
                await geminiLimiter.acquire();
            }
            const { text } = await generateText({
                model: provider.model(),
                system: options.system,
                temperature: options.temperature,
                maxRetries: 0, // IMPORTANT: Disable 3x auto-retry per provider
                ...(options.messages ? { messages: options.messages } : { prompt: options.prompt }),
            } as any);
            return text;
        } catch (err: any) {
            lastError = err;

            // If quota out, mark dead
            if (err.message && (err.message.includes("quota") || err.message.includes("credit") || err.message.includes("429"))) {
                markProviderDead(provider.name, err.message);
            }

            const next = providers[i + 1];
            if (next) {
                console.warn(`⚠️ ${provider.name} failed: ${err.message}. Falling back to ${next.name}...`);
            } else {
                console.error(`❌ All LLM providers failed. Last error (${provider.name}): ${err.message}`);
            }
        }
    }

    throw lastError || new Error('All LLM providers failed.');
}

/**
 * Generates a structured object using the provider fallback chain.
 */
export async function unifiedObjectGeneration<T>(
    options: LLMOptions & { schema: z.ZodType<T>, schemaName?: string }
): Promise<T> {
    const providers = getProviderChain();

    if (providers.length === 0) {
        throw new Error('No LLM providers configured. Set GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.');
    }

    let lastError: Error | null = null;

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];

        if (isProviderDead(provider.name)) {
            continue;
        }



        try {
            // DECISION(2026-03-18): Rate-limit Gemini calls to stay within quota
            if (provider.name.toLowerCase().includes('gemini')) {
                await geminiLimiter.acquire();
            }
            const { object } = await (generateObject({
                model: provider.model(),
                schema: options.schema,
                schemaName: options.schemaName,
                system: options.system,
                temperature: options.temperature,
                maxRetries: 0, // IMPORTANT: Disable 3x auto-retry per provider
                // Disable strict JSON schema for OpenAI-compatible endpoints (allows optional/nullable fields)
                providerOptions: { openai: { strictJsonSchema: false } },
                ...(options.messages ? { messages: options.messages } : { prompt: options.prompt }),
            } as any) as Promise<{ object: T }>);
            return object;
        } catch (err: any) {
            lastError = err;

            // If quota out, mark dead
            if (err.message && (err.message.includes("quota") || err.message.includes("credit") || err.message.includes("balance") || err.message.includes("429"))) {
                markProviderDead(provider.name, err.message);
            }

            const next = providers[i + 1];
            if (next) {
                console.warn(`⚠️ ${provider.name} failed: ${err.message}. Falling back to ${next.name}...`);
            } else {
                console.error(`❌ All LLM providers failed. Last error (${provider.name}): ${err.message}`);
            }
        }
    }

    throw lastError || new Error('All LLM providers failed.');
}

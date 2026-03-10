/**
 * @file    llm.ts
 * @purpose Unified LLM entry point with automatic fallback chain.
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-03-09
 * @deps    @ai-sdk/google, @ai-sdk/openai, @ai-sdk/anthropic, ai, zod
 * @env     GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY
 *
 * DECISION(2026-03-09): Chain is Gemini (free) → OpenRouter (cheap fallback) → paid cloud.
 * Ollama removed — it holds 1-2GB RAM resident on the local machine, causing OOM
 * for both the Aria process and general machine usability.
 * The chain auto-skips any provider without an API key configured.
 */

import { google } from '@ai-sdk/google';
import { openai, createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, generateObject, ModelMessage } from 'ai';
import { z } from 'zod';

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

// ROLLBACK: OpenRouter is the preferred fallback after Gemini.
// Cheaper than OpenAI/Anthropic direct, and no local RAM cost like Ollama.
function getOpenRouterProvider(): ProviderEntry[] {
    if (!process.env.OPENROUTER_API_KEY) return [];
    const openrouter = createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
    });
    return [
        {
            name: 'OpenRouter Claude 3.5 Haiku',
            model: () => openrouter('anthropic/claude-3.5-haiku'),
            available: true,
        },
        {
            name: 'OpenRouter Llama 3.3 70B',
            model: () => openrouter('meta-llama/llama-3.3-70b-instruct'),
            available: true,
        },
    ];
}

// DECISION(2026-03-09): Task-appropriate provider chain for background agent work.
//
// The chain is designed with cost + resource awareness:
//   1. Gemini (free tier, fast, reliable) — handles the majority of background calls
//   2. OpenRouter (cheap) — activates when Gemini is down or quota-exhausted.
//      Provides Claude 3.5 Haiku and Llama 3.3 70B at low per-token cost.
//   3. OpenAI / Anthropic (paid, direct) — last-resort escalation.
//
// Ollama removed (2026-03-09): held 1-2GB RAM resident, crushing the local machine.
// Bot chat uses Gemini directly (hardcoded in start-bot.ts), bypassing this chain.
// Chain: Gemini (free) → OpenRouter (cheap) → OpenAI → Anthropic
function getProviderChain(): ProviderEntry[] {
    return [
        {
            name: 'Gemini 2.0 Flash',
            model: () => google('gemini-2.0-flash'),
            available: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        },
        ...getOpenRouterProvider(),  // Cheap fallback — slots in right after Gemini
        {
            name: 'OpenAI GPT-4o',
            model: () => openai.chat('gpt-4o'),
            available: !!process.env.OPENAI_API_KEY,
        },
        {
            name: 'Anthropic Claude Sonnet 4.6',
            model: () => anthropic('claude-sonnet-4-6'),
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

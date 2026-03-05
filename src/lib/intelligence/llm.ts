/**
 * @file    llm.ts
 * @purpose Unified LLM entry point with automatic fallback chain.
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-02-27
 * @deps    @ai-sdk/google, @ai-sdk/openai, @ai-sdk/anthropic, ai, zod
 * @env     GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY
 *
 * DECISION(2026-02-27): Chain is Gemini (direct) → GPT-4o (direct) → OpenRouter (Gemini 2.5 Flash Lite → Mistral Small 3.2).
 * Direct APIs first for lowest latency. OpenRouter as cost-effective fallback ($0.10/M and $0.06/M).
 * Anthropic re-enabled — add ANTHROPIC_API_KEY when credits are restored.
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

// OpenRouter speaks the OpenAI API — reuse @ai-sdk/openai with a custom base URL.
// Routes: Gemini 2.5 Flash Lite ($0.10/M input) → Mistral Small 3.2 ($0.06/M input)
function getOpenRouterProvider() {
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

function getProviderChain(): ProviderEntry[] {
    return [
        {
            name: 'Gemini 2.0 Flash',
            model: () => google('gemini-2.0-flash'),
            available: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        },
        {
            name: 'OpenAI GPT-4o',
            model: () => openai('gpt-4o'),
            available: !!process.env.OPENAI_API_KEY,
        },
        {
            name: 'Anthropic Claude Sonnet 4.6',
            model: () => anthropic('claude-sonnet-4-6'),
            available: !!process.env.ANTHROPIC_API_KEY,
        },
        ...getOpenRouterProvider(),
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

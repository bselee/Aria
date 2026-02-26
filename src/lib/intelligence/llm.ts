/**
 * @file    llm.ts
 * @purpose Unified LLM entry point with automatic fallback chain.
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-02-26
 * @deps    @ai-sdk/google, @ai-sdk/openai, @ai-sdk/anthropic, ai, zod
 * @env     GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
 *
 * DECISION(2026-02-26): Fallback chain is Gemini Flash → OpenAI GPT-4o → Anthropic.
 * Gemini 2.5 Flash is fast + cheap. OpenAI is reliable fallback.
 * Anthropic is disabled until credits are added (was causing timeouts on every call).
 * The chain auto-skips any provider without an API key configured.
 */

import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, generateObject, CoreMessage } from 'ai';
import { z } from 'zod';

export type LLMOptions = {
    system?: string;
    prompt?: string;
    messages?: CoreMessage[];
    temperature?: number;
};

// DECISION(2026-02-26): Build provider chain dynamically based on available API keys.
// This prevents wasted time trying providers that will definitely fail.
type ProviderEntry = {
    name: string;
    model: () => any; // Lazy — only instantiate when called
    available: boolean;
};

function getProviderChain(): ProviderEntry[] {
    return [
        {
            name: 'Gemini 2.5 Flash',
            model: () => google('gemini-2.5-flash'),
            available: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        },
        {
            name: 'OpenAI GPT-4o',
            model: () => openai('gpt-4o'),
            available: !!process.env.OPENAI_API_KEY,
        },
        {
            name: 'Anthropic Claude 3.5 Sonnet',
            model: () => anthropic('claude-3-5-sonnet-20241022'),
            available: !!process.env.ANTHROPIC_API_KEY,
        },
    ].filter(p => p.available);
}

/**
 * Generates raw text using the provider fallback chain.
 * Tries each available provider in order until one succeeds.
 */
export async function unifiedTextGeneration(options: LLMOptions): Promise<string> {
    const providers = getProviderChain();

    if (providers.length === 0) {
        throw new Error('No LLM providers configured. Set GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
    }

    let lastError: Error | null = null;

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        try {
            const { text } = await generateText({
                model: provider.model(),
                system: options.system,
                prompt: options.prompt,
                messages: options.messages,
                temperature: options.temperature,
            });
            return text;
        } catch (err: any) {
            lastError = err;
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
        throw new Error('No LLM providers configured. Set GOOGLE_GENERATIVE_AI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
    }

    let lastError: Error | null = null;

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        try {
            const { object } = await generateObject({
                model: provider.model(),
                schema: options.schema,
                schemaName: options.schemaName,
                system: options.system,
                prompt: options.prompt,
                messages: options.messages,
                temperature: options.temperature,
            });
            return object;
        } catch (err: any) {
            lastError = err;
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

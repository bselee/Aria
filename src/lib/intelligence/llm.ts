/**
 * @file    llm.ts
 * @purpose Unified LLM entry point with automatic Anthropic -> OpenAI fallback.
 */

import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { generateText, generateObject, LanguageModelV1, CoreMessage } from 'ai';
import { z } from 'zod';

export type LLMOptions = {
    system?: string;
    prompt?: string;
    messages?: CoreMessage[];
    temperature?: number;
};

/**
 * Generates raw text with fallback logic.
 */
export async function unifiedTextGeneration(options: LLMOptions): Promise<string> {
    try {
        const { text } = await generateText({
            model: anthropic('claude-3-5-sonnet-20241022'),
            system: options.system,
            prompt: options.prompt,
            messages: options.messages,
            temperature: options.temperature,
        });
        return text;
    } catch (err: any) {
        console.warn(`⚠️ Anthropic failed: ${err.message}. Falling back to OpenAI (gpt-4o)...`);
        const { text } = await generateText({
            model: openai('gpt-4o'),
            system: options.system,
            prompt: options.prompt,
            messages: options.messages,
            temperature: options.temperature,
        });
        return text;
    }
}

/**
 * Generates a structured object with fallback logic.
 */
export async function unifiedObjectGeneration<T>(
    options: LLMOptions & { schema: z.ZodType<T>, schemaName?: string }
): Promise<T> {
    try {
        const { object } = await generateObject({
            model: anthropic('claude-3-5-sonnet-20241022'),
            schema: options.schema,
            schemaName: options.schemaName,
            system: options.system,
            prompt: options.prompt,
            messages: options.messages,
            temperature: options.temperature,
        });
        return object;
    } catch (err: any) {
        console.warn(`⚠️ Anthropic failed: ${err.message}. Falling back to OpenAI (gpt-4o)...`);
        const { object } = await generateObject({
            model: openai('gpt-4o'),
            schema: options.schema,
            schemaName: options.schemaName,
            system: options.system,
            prompt: options.prompt,
            messages: options.messages,
            temperature: options.temperature,
        });
        return object;
    }
}

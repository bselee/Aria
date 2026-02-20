/**
 * @file    anthropic.ts
 * @purpose Shared Anthropic client with lazy initialization.
 */

import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error("ANTHROPIC_API_KEY is not set in environment variables.");
        }
        client = new Anthropic({
            apiKey: apiKey,
        });
    }
    return client;
}

/**
 * @file    src/lib/copilot/channels/telegram.ts
 * @purpose Thin Telegram adapter over the shared copilot core.
 *
 *          Normal text Q&A is routed through runCopilotTurn().
 *          Channel-specific UI (buttons, callbacks, photo ingestion) stays
 *          in start-bot.ts — this module handles only text reasoning.
 */

import { runCopilotTurn } from "../core";

export interface TelegramTextInput {
    chatId: number;
    text:   string;
}

export interface TelegramTextResult {
    reply:    string;
    channel:  "telegram";
    providerUsed:     string;
    toolCalls:        string[];
    actionRefs:       string[];
    boundArtifactId?: string;
}

export async function handleTelegramText(input: TelegramTextInput): Promise<TelegramTextResult> {
    const result = await runCopilotTurn({
        channel:  "telegram",
        text:     input.text,
        threadId: String(input.chatId),
    });

    return {
        ...result,
        channel: "telegram",
    };
}

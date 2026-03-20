/**
 * @file    types.ts
 * @purpose Shared interface for all bot command modules. Defines
 *          the contract between the command router in start-bot.ts
 *          and individual command handlers.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    telegraf
 */

import type { Context, Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { FinaleClient } from '../../lib/finale/client';
import type { OpsManager } from '../../lib/intelligence/ops-manager';
import type { SlackWatchdog } from '../../lib/slack/watchdog';

/**
 * A single bot command definition. Commands are registered by
 * iterating the `allCommands` array and calling `bot.command()`.
 */
export interface BotCommand {
    /** The Telegram command name WITHOUT the leading slash, e.g. "status" */
    name: string | string[];
    /** Human-readable description shown in /help and setMyCommands list */
    description: string;
    /**
     * The handler invoked when the command is triggered.
     * Uses generic Context to stay compatible with Telegraf's bot.command() wrapper.
     * Access ctx.message.text via optional chaining since Context is not narrowed.
     */
    handler: (ctx: Context, deps: BotDeps) => Promise<any>;
}

/**
 * Shared dependency bag passed to every command handler. Avoids coupling
 * command modules to global variables and singletons in start-bot.ts.
 */
export interface BotDeps {
    bot: Telegraf;
    finale: FinaleClient;
    opsManager: OpsManager;
    watchdog: SlackWatchdog | null;
    chatHistory: Record<number, any[]>;
    chatLastActive: Record<number, number>;
    perplexityKey: string | null;
    elevenLabsKey: string | null;
    botStartTime: Date;
}

/**
 * Safely extracts the raw text from a command context.
 * Telegraf's `bot.command()` narrows ctx at runtime but our generic
 * `Context` type doesn't know about it. This helper avoids TS2339.
 */
export function getCmdText(ctx: Context): string {
    return (ctx.message as any)?.text ?? '';
}

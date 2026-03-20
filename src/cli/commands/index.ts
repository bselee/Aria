/**
 * @file    index.ts
 * @purpose Central command router for Telegram bot commands. Collects all
 *          command modules and provides a single `registerAllCommands()`
 *          function that start-bot.ts calls during boot.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    telegraf, ./types
 */

import type { Telegraf } from 'telegraf';
import type { BotCommand, BotDeps } from './types';

// ── Import command modules ──────────────────────────
import { statusCommands } from './status';
import { inventoryCommands } from './inventory';
import { operationsCommands } from './operations';
import { memoryCommands } from './memory-cmds';
import { kaizenCommands } from './kaizen';

/**
 * All bot commands, aggregated from every module.
 * Order matters: commands registered first get priority in Telegraf.
 */
export const allCommands: BotCommand[] = [
    ...statusCommands,
    ...inventoryCommands,
    ...operationsCommands,
    ...memoryCommands,
    ...kaizenCommands,
];

/**
 * Register all modular bot commands on a Telegraf instance.
 * This replaces the inline bot.command() calls scattered through start-bot.ts.
 *
 * @param bot  - The Telegraf bot instance
 * @param deps - Shared dependency bag (injected, not global)
 */
export function registerAllCommands(bot: Telegraf, deps: BotDeps): void {
    for (const cmd of allCommands) {
        const names = Array.isArray(cmd.name) ? cmd.name : [cmd.name];
        bot.command(names, (ctx) => cmd.handler(ctx, deps));
    }

    console.log(`🔧 Registered ${allCommands.length} command(s): ${allCommands.map(c =>
        Array.isArray(c.name) ? c.name.join('|') : c.name
    ).join(', ')}`);
}

// Re-export types for convenience
export type { BotCommand, BotDeps } from './types';

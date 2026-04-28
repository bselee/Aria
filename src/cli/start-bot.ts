/**
 * @file    start-bot.ts
 * @purpose Standalone Telegram bot launcher for Aria. Connects the persona,
 *          Gemini (primary chat) with automatic OpenRouter fallback, and
 *          Vercel AI SDK tool calling.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-03-18
 *
 * DECISION(2026-03-18): Chat now uses a full provider chain with tool support:
 *   Gemini Flash Ã¢â€ â€™ OpenRouter Claude Haiku 4.5 Ã¢â€ â€™ OpenRouter Gemini Flash Ã¢â€ â€™
 *   OpenRouter GPT-4o Mini Ã¢â€ â€™ unifiedTextGeneration (last resort, no tools).
 * Previously Gemini was called directly and failures lost tool calling entirely.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as http from 'http';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import {
    TELEGRAM_CONFIG
} from '../config/persona';
import { OpsManager } from '../lib/intelligence/ops-manager';
import { registerAllCommands } from './commands';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';
import { unifiedTextGeneration } from '../lib/intelligence/llm';
import { FinaleClient } from '../lib/finale/client';
import { SlackWatchdog } from '../lib/slack/watchdog';
import { APAgent } from '../lib/intelligence/ap-agent';
import { initAriaReviewWatcher } from '../lib/intelligence/aria-review-watcher';
import { initSandboxWatcher } from '../lib/intelligence/sandbox-watcher';
import { startBotControlPlane } from '../lib/ops/bot-control-plane';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
    reconcileInvoiceToPO,
    applyReconciliation,
    storePendingApproval,
    loadPendingApprovalsFromSupabase,
    type ReconciliationResult,
} from '../lib/finale/reconciler';

import {
    storePendingPOSend,
    expirePendingPOSend,
    lookupVendorOrderEmail,
} from '../lib/purchasing/po-sender';
import {
    handleTelegramDocument,
    handleTelegramPhoto,
    handleTelegramText,
} from '../lib/copilot/channels/telegram';
import { handleTelegramPOSendCallback } from '../lib/copilot/channels/telegram-callbacks';
import * as agentTask from '../lib/intelligence/agent-task';
import { approveTask, rejectTask, dismissTask } from '../lib/command-board/task-actions';
import { Markup as TgMarkup } from 'telegraf';
import { getStartupHealth } from '../lib/copilot/smoke';

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// HELPERS
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

/**
 * Build the Telegram message text for a restored (post-restart) approval prompt.
 * Mirrors the structure of the original approval message sent by ap-agent.ts, with
 * an added banner noting the bot restarted and how many minutes remain on the 24h window.
 */
function buildRestoredApprovalMessage(result: ReconciliationResult, approvalId: string, minutesLeft: number): string {
    const vendor = result.vendorName || 'Unknown vendor';
    const invNum = result.invoiceNumber || '?';
    const poNum = result.orderId || '?';

    const changes: string[] = [];
    for (const pc of result.priceChanges ?? []) {
        if (pc.verdict === 'needs_approval') {
            const delta = (pc.poPrice != null && pc.invoicePrice != null)
                ? ` ($${pc.poPrice.toFixed(2)} Ã¢â€ â€™ $${pc.invoicePrice.toFixed(2)})`
                : '';
            changes.push(`Ã¢â‚¬Â¢ ${pc.description || pc.productId || '?'}${delta}`);
        }
    }
    for (const fc of result.feeChanges ?? []) {
        if (fc.verdict === 'needs_approval') {
            changes.push(`Ã¢â‚¬Â¢ ${fc.feeType}: $${(fc.amount ?? 0).toFixed(2)}`);
        }
    }

    const changeList = changes.length > 0
        ? changes.slice(0, 5).join('\n') + (changes.length > 5 ? `\nÃ¢â‚¬Â¦+${changes.length - 5} more` : '')
        : '(no itemized changes)';

    const impact = result.totalDollarImpact != null ? `$${result.totalDollarImpact.toFixed(2)}` : '?';

    return (
        `Ã°Å¸â€â€ž *RESTORED APPROVAL* _(bot restarted Ã¢â‚¬â€ ${minutesLeft}m remaining)_\n` +
        `Ã¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€Â\n` +
        `*Vendor:* ${vendor}\n` +
        `*Invoice:* ${invNum}  Ã¢â€ â€™  *PO:* ${poNum}\n` +
        `*Impact:* ${impact}\n\n` +
        `*Changes pending approval:*\n${changeList}\n\n` +
        `_Tap Approve or Reject below_`
    );
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// CLIENT INITIALIZATION
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const token = process.env.TELEGRAM_BOT_TOKEN;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
const perplexityKey = process.env.PERPLEXITY_API_KEY;

if (!token) {
    console.error('Ã¢ÂÅ’ TELEGRAM_BOT_TOKEN is not set in .env.local');
    process.exit(1);
}

const bot = new Telegraf(token);

// Finale Inventory client
const finale = new FinaleClient();

// DECISION(2026-03-06): Chat uses Gemini 2.0 Flash (free) via Vercel AI SDK.
// Previously used OpenRouter Ã¢â€ â€™ Claude 3.5 Haiku (paid).
// Rollback: set OPENROUTER_API_KEY in .env.local to re-enable in llm.ts chain.
console.log('Ã°Å¸Å¡â‚¬ ARIA BOT BOOTING...');
console.log(`Ã°Å¸Â¤â€“ Telegram: Ã¢Å“â€¦ Connected`);
console.log(`Ã°Å¸Â§Â  Chat LLM: Ã¢Å“â€¦ Gemini 2.0 Flash (free)`);
console.log(`Ã°Å¸Â§Â  Background LLM: Ã¢Å“â€¦ Unified chain (Gemini Ã¢â€ â€™ OpenRouter Ã¢â€ â€™ OpenAI Ã¢â€ â€™ Anthropic)`);
console.log(`Ã°Å¸â€Â Perplexity: ${perplexityKey ? 'Ã¢Å“â€¦ Loaded' : 'Ã¢ÂÅ’ Not Configured'}`);
console.log(`Ã°Å¸Å½â„¢Ã¯Â¸Â ElevenLabs: ${elevenLabsKey ? 'Ã¢Å“â€¦ Loaded' : 'Ã¢ÂÅ’ Not Configured'}`);
console.log(`Ã°Å¸â€œÂ¦ Finale: ${process.env.FINALE_API_KEY ? 'Ã¢Å“â€¦ Connected' : 'Ã¢ÂÅ’ Not Configured'}`);

// DECISION(2026-02-26): Run the Slack watchdog inside the bot process so
// /requests can read live pending requests. Eliminates need for IPC/shared DB.
let globalWatchdog: SlackWatchdog | null = null;

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// COMMANDS
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

bot.start((ctx) => {
    const username = ctx.from?.first_name || 'Will';
    ctx.reply(TELEGRAM_CONFIG.welcomeMessage(username), { parse_mode: 'Markdown' });
});

const BOT_START_TIME = new Date();

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// MODULAR COMMANDS Ã¢â‚¬â€ registered after OpsManager boot (see line ~2340)
// DECISION(2026-03-20): Extracted 22 bot.command() handlers to
// src/cli/commands/ modules (status, inventory, operations, memory-cmds,
// kaizen). registerAllCommands() is called after deps are available.
// See: commands/index.ts for the router.
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// REUSABLE: Send email with PDF attachment via Gmail API
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

async function sendPdfEmail(to: string, subject: string, body: string, pdfBuffer: Buffer, pdfFilename: string): Promise<void> {
    const { getAuthenticatedClient: getGmailAuth } = await import('../lib/gmail/auth');
    const { gmail: GmailApiDyn } = await import('@googleapis/gmail');
    const auth = await getGmailAuth('default');
    const gmail = GmailApiDyn({ version: 'v1', auth });

    const boundary = '----=_Part_' + Date.now();
    const mimeMessage = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        body,
        ``,
        `--${boundary}`,
        `Content-Type: application/pdf; name="${pdfFilename}"`,
        `Content-Disposition: attachment; filename="${pdfFilename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        pdfBuffer.toString('base64'),
        `--${boundary}--`,
    ].join('\r\n');

    const encodedMessage = Buffer.from(mimeMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage },
    });
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// CONVERSATION HISTORY (shared across text + document handlers)
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

const chatHistory: Record<string, any[]> = {};
const chatLastActive: Record<string, number> = {};

// DECISION(2026-03-09): Periodic GC for stale chat history entries.
// Without this, every unique Telegram chatId creates an entry that lives forever.
// Sweep every 30 minutes Ã¢â‚¬â€ evict chats inactive for 4+ hours.
const CHAT_GC_INTERVAL = 30 * 60 * 1000;
const CHAT_GC_TTL = 4 * 60 * 60 * 1000; // 4 hours
const CHAT_MAX_KEYS = 100;
setInterval(() => {
    const now = Date.now();
    const keys = Object.keys(chatHistory);
    let evicted = 0;

    for (const key of keys) {
        const lastActive = chatLastActive[key] || 0;
        if (now - lastActive > CHAT_GC_TTL) {
            delete chatHistory[key];
            delete chatLastActive[key];
            evicted++;
        }
    }

    // If still over cap, evict oldest
    const remaining = Object.keys(chatHistory);
    if (remaining.length > CHAT_MAX_KEYS) {
        const sorted = remaining.sort((a, b) => (chatLastActive[a] || 0) - (chatLastActive[b] || 0));
        const toEvict = sorted.slice(0, remaining.length - CHAT_MAX_KEYS);
        for (const key of toEvict) {
            delete chatHistory[key];
            delete chatLastActive[key];
            evicted++;
        }
    }

    if (evicted > 0) {
        console.log(`[chat-gc] Evicted ${evicted} stale chat(s) Ã¢â‚¬â€ ${Object.keys(chatHistory).length} remaining`);
    }
}, CHAT_GC_INTERVAL);

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// DOCUMENT/FILE HANDLER Ã¢â‚¬â€ PDFs, images, Word docs
// Memory-aware: checks Pinecone for vendor patterns
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

bot.on('photo', async (ctx) => {
    const chatId = ctx.from?.id || ctx.chat.id;
    const photos = ctx.message.photo || [];
    const photo = photos[photos.length - 1];

    if (!photo) {
        return;
    }

    try {
        const fileLink = await ctx.telegram.getFileLink(photo.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const base64 = Buffer.from(await response.arrayBuffer()).toString('base64');
        await handleTelegramPhoto({
            chatId,
            fileId: photo.file_id,
            url: fileLink.href,
            base64,
        });
    } catch (err: any) {
        console.error('Telegram photo artifact error:', err.message);
    }
});

bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const filename = doc.file_name || 'unknown';
    const mimeType = doc.mime_type || '';
    const caption = ctx.message.caption || '';

    // Only process supported file types
    const SUPPORTED = ['application/pdf', 'application/x-pdf', 'image/png', 'image/jpeg',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/csv', 'text/plain', 'application/csv',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

    if (!SUPPORTED.some(m => mimeType.includes(m.split('/')[1]))) {
        await ctx.reply(`Ã°Å¸â€œÅ½ Got *${filename}* but I can't process \`${mimeType}\` files yet.\n_I handle: PDF, PNG, JPEG, DOC/DOCX, CSV, TXT, XLS/XLSX_`, { parse_mode: 'Markdown' });
        return;
    }

    if (doc.file_size && doc.file_size > 20_000_000) {
        await ctx.reply('Ã¢Å¡Â Ã¯Â¸Â File too large (>20MB). Try emailing it to me instead.');
        return;
    }

    ctx.sendChatAction('typing');
    await ctx.reply(`Ã°Å¸â€œÅ½ Processing *${filename}*... one moment.`, { parse_mode: 'Markdown' });

    try {
        // Download file from Telegram
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const response = await fetch(fileLink.href);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());

        await handleTelegramDocument({
            chatId: ctx.from?.id || ctx.chat.id,
            fileId: doc.file_id,
            filename,
            mimeType,
            rawText: caption || undefined,
            summary: `Telegram document uploaded: ${filename}`,
        });

        // Ã¢â€â‚¬Ã¢â€â‚¬ CSV / TEXT files: skip PDF pipeline, go straight to LLM Ã¢â€â‚¬Ã¢â€â‚¬
        const isTextFile = mimeType.includes('csv') || mimeType.includes('text/plain')
            || filename.endsWith('.csv') || filename.endsWith('.txt');

        // Ã¢â€â‚¬Ã¢â€â‚¬ Excel (XLS/XLSX): convert to CSV text, then analyze with LLM Ã¢â€â‚¬Ã¢â€â‚¬
        const isExcelFile = mimeType.includes('spreadsheet') || mimeType.includes('ms-excel')
            || filename.endsWith('.xlsx') || filename.endsWith('.xls');

        if (isTextFile || isExcelFile) {
            let textContent: string;
            let fileLabel: string;

            if (isExcelFile) {
                // DECISION(2026-02-26): Use xlsx library to convert Excel Ã¢â€ â€™ CSV text.
                // This avoids the PDF extraction pipeline which fails on non-PDF binaries.
                const XLSX = await import('xlsx');
                const workbook = XLSX.read(buffer, { type: 'buffer' });
                const sheetNames = workbook.SheetNames;
                const parts: string[] = [];

                for (const name of sheetNames) {
                    const sheet = workbook.Sheets[name];
                    const csv = XLSX.utils.sheet_to_csv(sheet);
                    if (sheetNames.length > 1) {
                        parts.push(`\n=== Sheet: ${name} ===\n${csv}`);
                    } else {
                        parts.push(csv);
                    }
                }
                textContent = parts.join('\n');
                fileLabel = `Ã°Å¸â€œÅ  *Excel File* (${sheetNames.length} sheet${sheetNames.length > 1 ? 's' : ''}: ${sheetNames.join(', ')})`;
            } else {
                textContent = buffer.toString('utf-8');
                fileLabel = `Ã°Å¸â€œÅ  *CSV/Text File*`;
            }

            const lineCount = textContent.split('\n').length;

            // DECISION(2026-02-26): Auto-enrich with Finale data when Excel contains SKUs.
            // Extract product IDs from the data, query Finale for consumption/demand/BOM data,
            // and append to the LLM prompt so Aria can give real answers instead of guessing.
            let finaleContext = '';
            try {
                // Look for product IDs/SKUs in the CSV data (column headers like "Product ID", "SKU", "ProductId")
                const lines = textContent.split('\n');
                const header = lines[0]?.toLowerCase() || '';
                const skuColIndex = header.split(',').findIndex(col =>
                    col.includes('product id') || col.includes('productid') ||
                    col.includes('sku') || col.includes('item id') || col.includes('itemid')
                );

                if (skuColIndex >= 0) {
                    const skus = lines.slice(1)
                        .map(line => line.split(',')[skuColIndex]?.trim().replace(/"/g, ''))
                        .filter(sku => sku && sku.length > 1 && sku.length < 30);

                    // Limit to 10 SKUs to avoid overwhelming the API
                    const uniqueSkus = [...new Set(skus)].slice(0, 10);

                    if (uniqueSkus.length > 0) {
                        ctx.sendChatAction('typing');
                        const enrichments: string[] = [];

                        for (const sku of uniqueSkus) {
                            try {
                                const profile = await finale.getComponentStockProfile(sku);
                                if (profile.hasFinaleData) {
                                    let entry = `  ${sku}:`;
                                    if (profile.onHand !== null) entry += ` QoH=${profile.onHand} units.`;

                                    // DECISION(2026-02-26): Finale's demandQuantity and consumptionQuantity
                                    // are TOTALS over ~90 days, NOT daily rates. We must pre-calculate
                                    // daily rate here to prevent the LLM from misinterpreting them.
                                    const totalDemand = profile.demandQuantity ?? profile.consumptionQuantity ?? 0;
                                    if (totalDemand > 0) {
                                        const dailyRate = totalDemand / 90;
                                        entry += ` Consumption: ${totalDemand.toFixed(1)} units over 90 days (${dailyRate.toFixed(2)} units/day).`;
                                        if (profile.onHand !== null && dailyRate > 0) {
                                            const daysOfSupply = Math.round(profile.onHand / dailyRate);
                                            entry += ` Days of supply: ~${daysOfSupply} days.`;
                                            // Annualize for "last year" type questions
                                            const annualUsage = Math.round(dailyRate * 365);
                                            entry += ` Estimated annual usage: ~${annualUsage} units/year.`;
                                        }
                                    } else {
                                        entry += ` No consumption/demand data in Finale Ã¢â‚¬â€ may need to check BOM explosion or build calendar.`;
                                    }

                                    if (profile.stockoutDays !== null) entry += ` Finale stockout estimate: ${profile.stockoutDays} days.`;
                                    if (profile.onOrder !== null && profile.onOrder > 0) entry += ` On order: ${profile.onOrder} units.`;
                                    if (profile.incomingPOs.length > 0) {
                                        entry += ` Open POs: ${profile.incomingPOs.map(po => `PO#${po.orderId} (${po.quantity} units from ${po.supplier})`).join(', ')}.`;
                                    }
                                    // DECISION(2026-02-26): Also fetch actual purchase/receiving history
                                    // so the LLM can give exact "total purchased last year" answers
                                    // instead of extrapolating from consumption.
                                    try {
                                        const purchased = await finale.getPurchasedQty(sku, 365);
                                        if (purchased.totalQty > 0) {
                                            entry += ` PURCHASED last 365 days: ${purchased.totalQty.toFixed(1)} units across ${purchased.orderCount} PO(s).`;
                                        }
                                    } catch { /* non-critical */ }

                                    enrichments.push(entry);
                                }
                            } catch { /* skip individual failures */ }
                        }

                        if (enrichments.length > 0) {
                            finaleContext = `\n\n--- FINALE INVENTORY DATA (LIVE) ---\nReal-time data from Finale Inventory. "PURCHASED last 365 days" is the EXACT received quantity from Finale POs Ã¢â‚¬â€ use this to answer purchase questions directly. "Consumption" figures are TOTALS over 90 days, daily rates are pre-calculated.\n${enrichments.join('\n')}\n--- END FINALE DATA ---`;
                        }
                    }
                }
            } catch (err: any) {
                console.warn('Excel Finale enrichment failed:', err.message);
            }

            let reply = `${fileLabel}\n`;
            reply += `Ã°Å¸â€œÅ½ File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
            reply += `Ã°Å¸â€œÂ Lines: ${lineCount}\n`;
            if (finaleContext) reply += `Ã°Å¸â€â€” _Enriched with live Finale inventory data_\n`;
            reply += `\nÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€Â\n`;

            ctx.sendChatAction('typing');
            const analysis = await unifiedTextGeneration({
                system: `You are Aria, an operations assistant for BuildASoil Ã¢â‚¬â€ a soil and growing supply manufacturer. You know this business deeply. Analyze uploaded data files and give DECISIVE, ACTIONABLE answers. Be specific with numbers, SKUs, and recommendations. Format for Telegram (markdown).

CRITICAL RULES:
1. **ANSWER THE QUESTION DIRECTLY.** Never say "you would need to check records" or "refer to purchase orders." YOU are the one who checks. If you have data, CALCULATE and ANSWER. If the data supports an estimate, give it clearly labeled as an estimate.

2. **ALWAYS DO THE MATH.** When consumption data is available:
   - If you have 90-day consumption, extrapolate: annual = (90-day value / 90) Ãƒâ€” 365
   - If asked about "last year" purchases, estimate from consumption rate: items consumed Ã¢â€°Ë† items purchased for BOM components
   - Show your calculation so Will can verify

3. **BOM Components**: If a product shows 0 sales velocity but has stock, it IS a BOM input consumed through production builds. State this as fact.
   - For BOM items, purchasing Ã¢â€°Ë† consumption over time (what goes in must be bought)
   - Use the FINALE INVENTORY DATA section (if present) for real consumption rates

4. **Be specific, not generic**: Use actual SKUs, quantities, and product names. Never give vague summaries when you have real numbers.

5. **Format answers as direct responses.** Example of GOOD response:
   "PLQ101 - Quillaja Extract Powder 20: Purchased ~223 kg last year (based on 55 kg consumed over 90 days Ã¢â€ â€™ 0.61 kg/day Ãƒâ€” 365 days)"
   
   Example of BAD response:
   "To determine purchases, you would need to check purchase records."`,
                prompt: `User's request: ${caption || 'Analyze this file'}\n\nFile: ${filename}\nData (${textContent.length} chars total, showing up to 60,000 chars):\n${textContent.slice(0, 60000)}${finaleContext}\n\nNOTE: If data appears truncated, work with what's available above Ã¢â‚¬â€ do NOT ask for the complete data. Give the best answer possible from what you have.`
            });

            reply += analysis;
            await ctx.reply(reply, { parse_mode: 'Markdown' });

            // Store in conversation history so follow-up questions have context
            const chatId = ctx.from?.id || ctx.chat.id;
            if (!chatHistory[chatId]) chatHistory[chatId] = [];
            chatLastActive[chatId] = Date.now();
            chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' Ã¢â‚¬â€ ' + caption : ''}` });
            chatHistory[chatId].push({ role: "assistant", content: reply });
            if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

            // Auto-learn: store key conclusions from the file analysis
            setImmediate(async () => {
                try {
                    const { remember } = await import('../lib/intelligence/memory');
                    const tagMatches = (caption + ' ' + analysis).match(/\b([A-Z][A-Z0-9-]{2,15})\b/g) || [];
                    const tags = [...new Set(tagMatches)].slice(0, 6);
                    await remember({
                        category: 'conversation',
                        content: `File analysis: "${filename}"${caption ? ' (' + caption + ')' : ''}. Key findings: "${analysis.slice(0, 400)}"`,
                        tags: [filename, ...tags],
                        source: 'telegram_auto',
                        priority: 'low',
                    });
                } catch { /* non-critical */ }
            });
            return;
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ PDF / Image / Word pipeline Ã¢â€â‚¬Ã¢â€â‚¬
        const { extractPDF } = await import('../lib/pdf/extractor');
        const { classifyDocument } = await import('../lib/pdf/classifier');
        const { pdfEditor } = await import('../lib/pdf/editor');
        const { recall, remember } = await import('../lib/intelligence/memory');

        // Extract text & classify
        ctx.sendChatAction('typing');
        const extraction = await extractPDF(buffer);
        const classification = await classifyDocument(extraction);

        const typeEmoji: Record<string, string> = {
            INVOICE: 'Ã°Å¸Â§Â¾', PURCHASE_ORDER: 'Ã°Å¸â€œâ€¹', VENDOR_STATEMENT: 'Ã°Å¸â€œÅ ',
            BILL_OF_LADING: 'Ã°Å¸Å¡Å¡', PACKING_SLIP: 'Ã°Å¸â€œÂ¦', FREIGHT_QUOTE: 'Ã°Å¸ÂÂ·Ã¯Â¸Â',
            CREDIT_MEMO: 'Ã°Å¸â€™Â³', COA: 'Ã°Å¸â€Â¬', SDS: 'Ã¢Å¡Â Ã¯Â¸Â', CONTRACT: 'Ã°Å¸â€œÅ“',
            PRODUCT_SPEC: 'Ã°Å¸â€œÂ', TRACKING_NOTIFICATION: 'Ã°Å¸â€œÂ', UNKNOWN: 'Ã°Å¸â€œâ€ž',
        };
        const emoji = typeEmoji[classification.type] || 'Ã°Å¸â€œâ€ž';
        const typeLabel = classification.type.replace(/_/g, ' ');

        let reply = `${emoji} *${typeLabel}* Ã¢â‚¬â€ _${classification.confidence} confidence_\n`;
        reply += `Ã°Å¸â€œÅ½ File: \`${filename}\` (${(buffer.length / 1024).toFixed(0)} KB)\n`;
        reply += `Ã°Å¸â€œâ€ž Pages: ${extraction.metadata.pageCount}\n`;
        if (extraction.tables.length > 0) {
            reply += `Ã°Å¸â€œÅ  Tables detected: ${extraction.tables.length}\n`;
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ CHECK MEMORY: Do we know this vendor's pattern? Ã¢â€â‚¬Ã¢â€â‚¬
        const docPreview = extraction.rawText.slice(0, 500);
        let vendorMemories: Awaited<ReturnType<typeof recall>> = [];
        try {
            vendorMemories = await recall(`vendor document pattern ${docPreview}`, {
                category: 'vendor_pattern',
                topK: 2,
                minScore: 0.5,
            });
        } catch (err: any) {
            console.warn('Memory lookup skipped:', err.message);
        }

        const hasVendorPattern = vendorMemories.length > 0;
        const isSplitPattern = hasVendorPattern &&
            vendorMemories[0].content.toLowerCase().includes('split');

        if (hasVendorPattern) {
            reply += `\nÃ°Å¸Â§Â  _Memory: ${vendorMemories[0].content.slice(0, 100)}..._\n`;
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Analyze pages with LLM Ã¢â€â‚¬Ã¢â€â‚¬
        const isInvoiceWorkflow = classification.type === 'VENDOR_STATEMENT'
            || classification.type === 'INVOICE'
            || caption.toLowerCase().includes('invoice')
            || caption.toLowerCase().includes('bill.com')
            || caption.toLowerCase().includes('remove')
            || isSplitPattern;

        if (isInvoiceWorkflow && extraction.pages.length >= 1) {
            ctx.sendChatAction('typing');

            // Use physical per-page extraction for accurate page text
            // (form-feed splitting often fails Ã¢â‚¬â€ this splits via pdf-lib)
            let analysisPages = extraction.pages;
            if (extraction.metadata.pageCount > 1 && extraction.pages.length < extraction.metadata.pageCount * 0.8) {
                const { extractPerPage } = await import('../lib/pdf/extractor');
                analysisPages = await extractPerPage(buffer);
                reply += `Ã°Å¸â€Â¬ Using per-page extraction (${analysisPages.length} pages)...\n`;
            }

            // Per-page analysis
            const pageAnalysis = await unifiedTextGeneration({
                system: `You analyze business documents page by page. For each page, determine:
- INVOICE: An individual invoice with line items, quantities, amounts, invoice number
- STATEMENT: An account statement summary showing list of invoices, aging, balances
- OTHER: Cover page, terms, remittance slip, etc.

Return ONLY a JSON array: [{"page":1,"type":"INVOICE","invoiceNumber":"INV-123"}]
If no invoice number found, use null for invoiceNumber.`,
                prompt: `${analysisPages.length} pages:\n\n${analysisPages.map(p =>
                    `=== PAGE ${p.pageNumber} ===\n${p.text.slice(0, 800)}\n`
                ).join('\n')}`
            });

            let pages: Array<{ page: number; type: string; invoiceNumber?: string | null }> = [];
            try {
                const jsonMatch = pageAnalysis.match(/\[[\s\S]*?\]/);
                if (jsonMatch) pages = JSON.parse(jsonMatch[0]);
            } catch { /* fall through to default */ }

            if (pages.length > 0) {
                const invoicePages = pages.filter(p => p.type === 'INVOICE');
                const statementPages = pages.filter(p => p.type === 'STATEMENT');
                const otherPages = pages.filter(p => p.type === 'OTHER');
                const invoiceNums = invoicePages.map(p => p.invoiceNumber).filter(Boolean) as string[];

                reply += `\nÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€Â\n`;
                if (statementPages.length > 0) reply += `Ã°Å¸â€œÅ  Statement pages: ${statementPages.map(p => p.page).join(', ')}\n`;
                if (invoicePages.length > 0) reply += `Ã°Å¸Â§Â¾ Invoice pages: ${invoicePages.map(p => p.page).join(', ')}\n`;
                if (invoiceNums.length > 0) reply += `Ã°Å¸â€œÂ Invoice #: ${invoiceNums.join(', ')}\n`;

                // Ã¢â€â‚¬Ã¢â€â‚¬ SPLIT WORKFLOW (AAACooper-style): each page Ã¢â€ â€™ separate PDF Ã¢â€ â€™ email Ã¢â€â‚¬Ã¢â€â‚¬
                if (isSplitPattern || (invoicePages.length > 1 && statementPages.length === 0)) {
                    reply += `\nÃ¢Å“â€šÃ¯Â¸Â Splitting ${invoicePages.length} invoices into individual PDFs...`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    const splitBuffers = await pdfEditor.splitPdf(buffer);
                    let emailsSent = 0;

                    for (const invPage of invoicePages) {
                        const pageIdx = invPage.page - 1;
                        if (pageIdx >= splitBuffers.length) continue;

                        const pageBuffer = splitBuffers[pageIdx];
                        const invNum = invPage.invoiceNumber || `page${invPage.page}`;
                        const invFilename = `${invNum.replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;

                        // Send each invoice PDF back to chat
                        await ctx.replyWithDocument({
                            source: pageBuffer,
                            filename: invFilename,
                        }, { caption: `Ã°Å¸Â§Â¾ Invoice ${invNum}` });

                        // Email each to bill.com
                        try {
                            await sendPdfEmail(
                                'buildasoilap@bill.com',
                                `Invoice ${invNum}`,
                                `Invoice ${invNum} attached.\nExtracted from: ${filename}`,
                                pageBuffer,
                                invFilename,
                            );
                            emailsSent++;
                        } catch (emailErr: any) {
                            console.error(`Email failed for ${invNum}:`, emailErr.message);
                            await ctx.reply(`Ã¢Å¡Â Ã¯Â¸Â Email failed for ${invNum}: ${emailErr.message}`, { parse_mode: 'Markdown' });
                        }
                    }

                    if (emailsSent > 0) {
                        await ctx.reply(`Ã°Å¸â€œÂ§ Ã¢Å“â€¦ Sent ${emailsSent} invoice(s) to \`buildasoilap@bill.com\``, { parse_mode: 'Markdown' });
                    }

                    return; // Done
                }

                // Ã¢â€â‚¬Ã¢â€â‚¬ REMOVE workflow: strip invoice pages, keep statement Ã¢â€â‚¬Ã¢â€â‚¬
                if (invoicePages.length > 0 && statementPages.length > 0) {
                    const pagesToRemove = invoicePages.map(p => p.page - 1);
                    const cleanedBuffer = await pdfEditor.removePages(buffer, pagesToRemove);

                    reply += `\nÃ¢Å“â€šÃ¯Â¸Â Removed ${invoicePages.length} invoice page(s) Ã¢â‚¬â€ ${statementPages.length} statement page(s) remain`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    const cleanFilename = filename.replace(/\.(pdf|PDF)$/, '_STATEMENT_ONLY.$1');
                    await ctx.replyWithDocument({
                        source: cleanedBuffer,
                        filename: cleanFilename,
                    }, { caption: `Ã°Å¸â€œÅ  Statement only (invoices removed)` });

                    try {
                        await sendPdfEmail(
                            'buildasoilap@bill.com',
                            `Vendor Statement - ${invoiceNums.join(', ') || filename}`,
                            `Vendor statement attached. Invoice pages removed.\nOriginal: ${filename}\nInvoices: ${invoiceNums.join(', ') || 'N/A'}`,
                            cleanedBuffer,
                            cleanFilename,
                        );
                        await ctx.reply(`Ã°Å¸â€œÂ§ Ã¢Å“â€¦ Sent statement to \`buildasoilap@bill.com\``, { parse_mode: 'Markdown' });
                    } catch (emailErr: any) {
                        console.error('Bill.com email error:', emailErr.message);
                        await ctx.reply(`Ã¢Å¡Â Ã¯Â¸Â PDF cleaned but email failed: ${emailErr.message}`, { parse_mode: 'Markdown' });
                    }

                    return;
                }

                // Single invoice Ã¢â‚¬â€ forward as-is
                if (invoicePages.length === 1 && statementPages.length === 0) {
                    const invNum = invoiceNums[0] || 'unknown';
                    reply += `\nÃ°Å¸â€œÂ§ Forwarding to bill.com...`;
                    await ctx.reply(reply, { parse_mode: 'Markdown' });

                    try {
                        await sendPdfEmail(
                            'buildasoilap@bill.com',
                            `Invoice ${invNum}`,
                            `Invoice ${invNum} attached.\nFile: ${filename}`,
                            buffer,
                            filename,
                        );
                        await ctx.reply(`Ã°Å¸â€œÂ§ Ã¢Å“â€¦ Sent to \`buildasoilap@bill.com\` Ã¢â‚¬â€ Invoice ${invNum}`, { parse_mode: 'Markdown' });
                    } catch (emailErr: any) {
                        await ctx.reply(`Ã¢Å¡Â Ã¯Â¸Â Email failed: ${emailErr.message}`, { parse_mode: 'Markdown' });
                    }

                    return;
                }
            }
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ DEFAULT: General document summary Ã¢â€â‚¬Ã¢â€â‚¬
        if (extraction.rawText.length > 50) {
            ctx.sendChatAction('typing');
            const summary = await unifiedTextGeneration({
                system: `You are Aria, summarizing a business document for Will at BuildASoil.
Be concise. Focus on: vendor name, amounts, dates, key items/SKUs, and any action needed.`,
                prompt: `Document type: ${typeLabel}\nCaption: ${caption || '(none)'}\n\n${extraction.rawText.slice(0, 3000)}`
            });
            reply += `\nÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€ÂÃ¢â€Â\n${summary}`;
        } else {
            reply += `\nÃ¢Å¡Â Ã¯Â¸Â _Very little text extracted. This might be a scanned/image PDF._`;
        }

        // Store this interaction as a memory
        try {
            await remember({
                category: 'general',
                content: `Processed document: ${filename} (${typeLabel}). ${extraction.metadata.pageCount} pages.`,
                tags: [typeLabel.toLowerCase(), filename],
                source: 'telegram',
            });
        } catch { /* non-critical */ }

        await ctx.reply(reply, { parse_mode: 'Markdown' });

        // Store in conversation history so follow-up questions have context
        const chatId = ctx.from?.id || ctx.chat.id;
        if (!chatHistory[chatId]) chatHistory[chatId] = [];
        chatLastActive[chatId] = Date.now();
        chatHistory[chatId].push({ role: "user", content: `[Uploaded file: ${filename}]${caption ? ' Ã¢â‚¬â€ ' + caption : ''}` });
        chatHistory[chatId].push({ role: "assistant", content: reply });
        if (chatHistory[chatId].length > 20) chatHistory[chatId] = chatHistory[chatId].slice(-20);

    } catch (err: any) {
        console.error(`Document processing error (${filename}):`, err.message);
        await ctx.reply(`Ã¢ÂÅ’ Failed to process *${filename}*: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.from?.id || ctx.chat.id;

    // Initialize history for this chat if it doesn't exist
    if (!chatHistory[chatId]) {
        chatHistory[chatId] = [];
    }
    chatLastActive[chatId] = Date.now();

    // Ã¢â€â‚¬Ã¢â€â‚¬ "Please forward" shortcut Ã¢â‚¬â€ removed (dropship concept retired) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // Previously this offered pending dropship invoice buttons.
    // Now all invoices go through normal PO matching.

    ctx.sendChatAction('typing');

    try {
        const { reply } = await handleTelegramText({
            chatId,
            text: userText,
        });

        chatHistory[chatId].push({ role: "user", content: userText });
        chatHistory[chatId].push({ role: "assistant", content: reply });
        if (chatHistory[chatId].length > 20) {
            chatHistory[chatId] = chatHistory[chatId].slice(-20);
        }

        await ctx.reply(reply, { parse_mode: 'Markdown' });
        return;
    } catch (err: any) {
        console.error('Chat Error:', err.message);
        await ctx.reply(`ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â Ops: ${err.message}`);
        return;
    }

});


// Boot Ã¢â‚¬â€ clear any competing session first, then start long-polling
(async () => {
    try {
        // Force-clear any existing long-poll session
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('Ã°Å¸â€â€ž Cleared previous Telegram session');
    } catch (err: any) {
        console.log('Ã¢Å¡Â Ã¯Â¸Â Webhook clear failed (non-fatal):', err.message);
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // RECONCILIATION APPROVAL INLINE BUTTONS
    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // DECISION(2026-02-26): Using Telegram bot (not Slack) for approvals per Will.
    // When AP Agent detects a price change >3%, it sends inline keyboard buttons.
    // These handlers capture the button taps and apply/reject changes.

    bot.action(/^approve_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`Ã°Å¸â€â€˜ Approval button tapped: ${approvalId}`);

        await ctx.answerCbQuery('Processing approval...');

        try {
            const result = await approvePendingReconciliation(approvalId);
            const responseMsg = result.success
                ? `${result.message}\n\nApplied:\n${result.applied.map(a => `  Ã¢Å“â€¦ ${a}`).join('\n')}${result.errors.length > 0 ? `\n\nErrors:\n${result.errors.map(e => `  Ã¢ÂÅ’ ${e}`).join('\n')}` : ''}`
                : `Ã¢Å¡Â Ã¯Â¸Â ${result.message}`;

            await ctx.editMessageText(ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text + '\n\n' + responseMsg
                : responseMsg);
        } catch (err: any) {
            await ctx.reply(`Ã¢ÂÅ’ Approval failed: ${err.message}`);
        }
    });

    bot.action(/^reject_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`Ã°Å¸â€â€™ Rejection button tapped: ${approvalId}`);

        await ctx.answerCbQuery('Changes rejected');

        const message = await rejectPendingReconciliation(approvalId);

        await ctx.editMessageText(ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text + '\n\n' + message
            : message);
    });

    // ──────────────────────────────────────────────────────────────────────
    // /tasks  — unified Aria task queue (control-plane phase 2.5 surface)
    // ──────────────────────────────────────────────────────────────────────
    // Reads from agent_task. Mobile-first paginated list: 5 rows per page,
    // sorted "blocking me first" (NEEDS_APPROVAL/owner=will → FAILED → PENDING),
    // each row gets its own per-type action buttons. No bulk-approve.
    //
    // Spec: .agents/plans/control-plane.md §3.5; option A from prior design.
    const TASKS_PAGE_SIZE = 5;
    const TASK_STATUS_DOT: Record<string, string> = {
        NEEDS_APPROVAL: '🟡',
        FAILED: '🔴',
        PENDING: '🟢',
        RUNNING: '🟢',
        CLAIMED: '🟢',
    };

    function renderTasksMessage(tasks: agentTask.AgentTask[], offset: number, totalOpen: number): { text: string; keyboard: any } {
        if (tasks.length === 0) {
            return {
                text: '📋 Nothing waiting. ✨',
                keyboard: TgMarkup.inlineKeyboard([[TgMarkup.button.callback('🔄 Refresh', 'tasks_page_0')]]),
            };
        }
        const lines: string[] = [`📋 ${totalOpen} open task${totalOpen === 1 ? '' : 's'} — showing ${offset + 1}–${offset + tasks.length}`, ''];
        const rows: any[][] = [];
        tasks.forEach((t, idx) => {
            const dot = TASK_STATUS_DOT[t.status] ?? '⚪';
            const num = offset + idx + 1;
            const goal = t.goal.length > 70 ? t.goal.slice(0, 67) + '...' : t.goal;
            lines.push(`${dot} ${num}. ${goal}`);
            if (t.type === 'approval' && t.requires_approval) {
                rows.push([
                    TgMarkup.button.callback(`✅ ${num} Approve`, `task_approve_${t.id}`),
                    TgMarkup.button.callback(`❌ ${num} Reject`, `task_reject_${t.id}`),
                ]);
            } else if (t.type === 'cron_failure' || t.status === 'FAILED') {
                rows.push([TgMarkup.button.callback(`✓ ${num} Dismiss`, `task_dismiss_${t.id}`)]);
            } else {
                rows.push([TgMarkup.button.callback(`✓ ${num} Done`, `task_dismiss_${t.id}`)]);
            }
        });
        const navRow: any[] = [];
        if (offset > 0) navRow.push(TgMarkup.button.callback('⏮ Prev', `tasks_page_${Math.max(0, offset - TASKS_PAGE_SIZE)}`));
        if (offset + tasks.length < totalOpen) navRow.push(TgMarkup.button.callback('Next ⏭', `tasks_page_${offset + TASKS_PAGE_SIZE}`));
        navRow.push(TgMarkup.button.callback('🔄', `tasks_page_${offset}`));
        rows.push(navRow);
        return { text: lines.join('\n'), keyboard: TgMarkup.inlineKeyboard(rows) };
    }

    async function fetchTasksPage(offset: number): Promise<{ tasks: agentTask.AgentTask[]; total: number }> {
        const all = await agentTask.listTasks({
            limit: 500,
            includeRecentFailed: true,
        });
        const rank = (t: agentTask.AgentTask) =>
            (t.status === 'NEEDS_APPROVAL' && t.owner === 'will' ? 0 : t.status === 'NEEDS_APPROVAL' ? 1 : t.status === 'FAILED' ? 2 : 3) * 1000 +
            (t.priority ?? 2);
        const sorted = [...all].sort((a, b) => {
            const r = rank(a) - rank(b);
            if (r !== 0) return r;
            return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        return { tasks: sorted.slice(offset, offset + TASKS_PAGE_SIZE), total: sorted.length };
    }

    bot.command('tasks', async (ctx) => {
        try {
            const { tasks, total } = await fetchTasksPage(0);
            const { text, keyboard } = renderTasksMessage(tasks, 0, total);
            await ctx.reply(text, keyboard);
        } catch (err: any) {
            await ctx.reply(`⚠️ Task queue unavailable: ${err.message ?? String(err)}`);
        }
    });

    bot.action(/^tasks_page_(\d+)$/, async (ctx) => {
        const offset = parseInt(ctx.match[1], 10) || 0;
        await ctx.answerCbQuery('Refreshing...');
        try {
            const { tasks, total } = await fetchTasksPage(offset);
            const { text, keyboard } = renderTasksMessage(tasks, offset, total);
            await ctx.editMessageText(text, keyboard);
        } catch (err: any) {
            await ctx.reply(`⚠️ Task queue unavailable: ${err.message ?? String(err)}`);
        }
    });

    bot.action(/^task_approve_(.+)$/, async (ctx) => {
        const taskId = ctx.match[1];
        const result = await approveTask(taskId, 'will-telegram');
        await ctx.answerCbQuery(result.cbQueryText);
        await ctx.reply(result.replyText);
    });

    bot.action(/^task_reject_(.+)$/, async (ctx) => {
        const taskId = ctx.match[1];
        const result = await rejectTask(taskId, 'will-telegram');
        await ctx.answerCbQuery(result.cbQueryText);
        await ctx.reply(result.replyText);
    });

    bot.action(/^task_dismiss_(.+)$/, async (ctx) => {
        const taskId = ctx.match[1];
        const result = await dismissTask(taskId, 'will-telegram');
        await ctx.answerCbQuery(result.cbQueryText);
        await ctx.reply(result.replyText);
    });

    // TEXT COMMAND FALLBACK for approvals Ã¢â‚¬â€ handles /approve_<id> and /reject_<id>
    // typed as plain text. Useful when the inline buttons are no longer tappable
    // (e.g., old message scrolled past, or approval came from the test pipeline script).
    bot.hears(/^\/approve_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`Ã°Å¸â€â€˜ Approval text command: ${approvalId}`);
        try {
            const result = await approvePendingReconciliation(approvalId);
            const responseMsg = result.success
                ? `${result.message}\n\nApplied:\n${result.applied.map((a: string) => `  Ã¢Å“â€¦ ${a}`).join('\n')}${result.errors.length > 0 ? `\n\nErrors:\n${result.errors.map((e: string) => `  Ã¢ÂÅ’ ${e}`).join('\n')}` : ''}`
                : `Ã¢Å¡Â Ã¯Â¸Â ${result.message}`;
            await ctx.reply(responseMsg, { parse_mode: 'Markdown' });
        } catch (err: any) {
            await ctx.reply(`Ã¢ÂÅ’ Approval failed: ${err.message}`);
        }
    });

    bot.hears(/^\/reject_(.+)$/, async (ctx) => {
        const approvalId = ctx.match[1];
        console.log(`Ã°Å¸â€â€™ Rejection text command: ${approvalId}`);
        const message = await rejectPendingReconciliation(approvalId);
        await ctx.reply(message, { parse_mode: 'Markdown' });
    });

    // DROPSHIP INVOICE INLINE BUTTONS (LEGACY Ã¢â‚¬â€ feature retired)
    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // These handlers remain as stubs to gracefully handle taps on old messages.

    bot.action(/^dropship_fwd_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Dropship forwarding has been retired');
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(
            original + '\n\nÃ¢Å¡Â Ã¯Â¸Â Dropship forwarding has been retired. All invoices now go through standard PO matching.\nForward manually to buildasoilap@bill.com if needed.'
        );
    });

    bot.action(/^invoice_has_po_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Legacy workflow retired');
        await ctx.reply(
            'That legacy invoice PO-entry flow has been retired. Please resend the invoice or use the current PO matching/review flow.'
        );
    });

    bot.action(/^invoice_skip_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Skipped');
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\nÃ¢ÂÂ­Ã¯Â¸Â Skipped Ã¢â‚¬â€ invoice left unmatched.');
    });

    // PO COMMIT & SEND INLINE BUTTONS
    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // Three-step flow:
    //   po_review_<orderId>      Ã¢â€ â€™ fetch PO details, look up vendor email, show confirm screen
    //   po_confirm_send_<sendId> Ã¢â€ â€™ commit in Finale + send email
    //   po_cancel_send_<sendId>  Ã¢â€ â€™ dismiss, PO stays as draft
    //   po_skip_<orderId>        Ã¢â€ â€™ silent dismiss (no review needed)

    bot.action(/^po_review_(.+)$/, async (ctx) => {
        const orderId = ctx.match[1];
        await ctx.answerCbQuery('Fetching PO detailsÃ¢â‚¬Â¦');
        try {
            // Reuse module-level finale singleton instead of creating a new instance
            const reviewClient = finale;
            const review = await reviewClient.getDraftPOForReview(orderId);

            if (!review.canCommit) {
                await ctx.editMessageText(
                    (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                    `\n\nÃ¢Å¡Â Ã¯Â¸Â PO #${orderId} is no longer in draft status Ã¢â‚¬â€ cannot commit.`
                );
                return;
            }

            const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);

            const itemLines = review.items.map(i =>
                `  Ã¢â‚¬Â¢ ${i.productId}  ${i.productName.slice(0, 28).padEnd(28)}  Ãƒâ€”${i.quantity}  $${i.unitPrice.toFixed(2)} = $${i.lineTotal.toFixed(2)}`
            ).join('\n');

            const reviewText = [
                `Ã°Å¸â€œâ€¹ *PO #${review.orderId} Ã¢â‚¬â€ ${review.vendorName}*`,
                ``,
                itemLines,
                ``,
                `*Total: $${review.total.toFixed(2)}*`,
                `To: ${email ? `${email} _(${source})_` : 'Ã¢Å¡Â Ã¯Â¸Â No vendor email on file'}`,
                ``,
                email
                    ? `Ã¢Å¡Â Ã¯Â¸Â _This will commit in Finale AND email the vendor._`
                    : `_Cannot send Ã¢â‚¬â€ no email address found for ${review.vendorName}._\n_Add it to vendor\\_profiles or the vendors table._`,
            ].join('\n');

            if (!email) {
                await ctx.editMessageText(reviewText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: 'Ã¢ÂÅ’ Cancel', callback_data: `po_cancel_send_noop_${orderId}` },
                        ]],
                    },
                });
                return;
            }

            const sendId = await storePendingPOSend(orderId, review, email, source, {
                channel: 'telegram',
                telegramChatId: String(ctx.chat.id),
                telegramMessageId: ctx.callbackQuery.message?.message_id,
            });
            await ctx.editMessageText(reviewText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: 'Ã¢Å“â€¦ Confirm Send', callback_data: `po_confirm_send_${sendId}` },
                        { text: 'Ã¢ÂÅ’ Cancel', callback_data: `po_cancel_send_${sendId}` },
                    ]],
                },
            });
        } catch (err: any) {
            await ctx.reply(`Ã¢ÂÅ’ Failed to fetch PO #${orderId}: ${err.message}`);
        }
    });

    bot.action(/^po_confirm_send_(.+)$/, async (ctx) => {
        const sendId = ctx.match[1];
        await ctx.answerCbQuery('Committing and sendingÃ¢â‚¬Â¦');
        const { pending, action: result } = await handleTelegramPOSendCallback({ sendId });
        if (!pending) {
            await ctx.editMessageText(
                (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                '\n\nÃ¢Å¡Â Ã¯Â¸Â Send data expired (bot restarted). Please tap "Review & Send" again to re-initiate.'
            );
            return;
        }
        try {
            if (result.status === 'failed') {
                await ctx.reply(`ÃƒÂ¢Ã‚ÂÃ…â€™ ${result.userMessage}`);
                return;
            }
            const details = result.details as {
                orderId: string;
                sentTo: string | null;
                emailError?: string;
            };
            await ctx.editMessageText(
                (ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '') +
                (result.status === 'partial_success'
                    ? `\n\n⚠️ PO #${details.orderId} committed in Finale, but vendor email failed: ${details.emailError}`
                    : `\n\n✅ PO #${details.orderId} committed in Finale and emailed to ${details.sentTo}`)
            );

            // DECISION(2026-03-19): Generate a copy-paste Slack response for Will.
            // After committing a PO, Will needs to reply in Slack with the PO#, a
            // clickable link, and the expected arrival date. We compute 14d from today
            // as the default expected date and send it as a separate message so he can
            // copy it directly into the Slack thread.
            const expectedDate = new Date();
            expectedDate.setDate(expectedDate.getDate() + 14);
            const expectedDateStr = expectedDate.toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                timeZone: 'America/Denver',
            });

            const slackResponse = [
                `Ã°Å¸â€œâ€¹ *Copy-paste for Slack:*`,
                ``,
                `\`\`\``,
                `Ã¢Å“â€¦ Ordered Ã¢â‚¬â€ PO #${details.orderId}`,
                `Ã°Å¸â€â€” ${pending.review.finaleUrl}`,
                `Ã°Å¸â€œâ€¦ Expected arrival: ~${expectedDateStr}`,
                `\`\`\``,
            ].join('\n');

            await ctx.reply(slackResponse, { parse_mode: 'Markdown' });

            // Pinecone auto-learn
            setImmediate(async () => {
                try {
                    const { remember } = await import('../lib/intelligence/memory');
                    await remember({
                        category: 'process',
                        content: result.status === 'partial_success'
                            ? `PO #${details.orderId} committed in Finale, but vendor email failed: ${details.emailError}`
                            : `PO #${details.orderId} committed in Finale and emailed to ${details.sentTo}`,
                        source: 'telegram',
                        priority: 'normal',
                    });
                } catch { }
            });
        } catch (err: any) {
            await ctx.reply(`Ã¢ÂÅ’ Failed to commit/send PO: ${err.message}`);
        }
    });

    bot.action(/^po_cancel_send_(.+)$/, async (ctx) => {
        const sendId = ctx.match[1];
        await ctx.answerCbQuery('Cancelled');
        await expirePendingPOSend(sendId);
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\n_Cancelled Ã¢â‚¬â€ PO remains as draft in Finale._', { parse_mode: 'Markdown' });
    });

    bot.action(/^po_skip_(.+)$/, async (ctx) => {
        await ctx.answerCbQuery('Skipped');
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\n_Skipped Ã¢Å¡â‚¬â€� PO stays as draft in Finale._', { parse_mode: 'Markdown' });
    });

    // ── ULINE FRIDAY APPROVAL ──────────────────────────────────────────────────
    bot.action('approve_uline_friday', async (ctx) => {
        await ctx.answerCbQuery('Creating PO and filling cart…');
        const pending = (ops as any).pendingUlineFriday;
        if (!pending) {
            await ctx.reply('No pending ULINE order found. The pre-check may have timed out or was already processed.');
            return;
        }

        const manifest = JSON.parse(pending.manifestJson);
        await ctx.reply('✅ Approved — creating draft PO and filling ULINE cart…');

        const { executeUlineFridayApproval } = await import('./cli/order-uline');
        const result = await executeUlineFridayApproval(manifest);

        (ops as any).pendingUlineFriday = null;

        if (!result.success) {
            await ctx.reply(
                `ðŸš¨ <b>ULINE Order Failed</b>\n\n` +
                `<b>Error:</b> ${result.error || 'Unknown error'}\n\n` +
                `Items: ${result.itemCount} | Total: $${result.estimatedTotal.toFixed(2)}`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const itemLines = result.items
            .slice(0, 10)
            .map((i: any) => `  <code>${i.ulineModel}</code> × ${i.qty}  ($${(i.qty * i.unitPrice).toFixed(2)})`)
            .join('\n');
        const more = result.items.length > 10 ? `\n  <i>…and ${result.items.length - 10} more</i>` : '';

        const poLine = result.finalePO && result.finaleUrl
            ? `ðŸ“„ <a href="${result.finaleUrl}">Finale PO #${result.finalePO}</a>`
            : `ðŸ“„ Finale PO #${result.finalePO}`;

        const cartIcon = result.cartVerificationStatus === 'verified' ? 'ðŸ›’'
            : result.cartVerificationStatus === 'partial' ? 'âš ï¸' : 'ðŸŸ¡';

        const msg = `ðŸ›’ <b>ULINE Order — Done</b>\n\n` +
            `${poLine}\n` +
            `ðŸ’° Est. Total: <b>$${result.estimatedTotal.toFixed(2)}</b>\n` +
            `ðŸ“¦ ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}:\n\n` +
            `${itemLines}${more}\n\n` +
            `${cartIcon} Cart: ${result.cartResult}\n` +
            (result.cartUrl
                ? `ðŸ—“ Cart link: <a href="${result.cartUrl}">Load in browser</a>\n`
                : `ðŸ—“ <a href="https://www.uline.com/Ordering/QuickOrder">ULINE Quick Order</a>`);

        await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    bot.action('skip_uline_friday', async (ctx) => {
        await ctx.answerCbQuery('Skipped this week');
        (ops as any).pendingUlineFriday = null;
        const original = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(original + '\n\n_Skipped this week._', { parse_mode: 'Markdown' });
    });

    // Fire-and-forget the launch, then start OpsManager right away.
    bot.launch({ dropPendingUpdates: true })
        .catch((err: any) => console.error('Ã¢ÂÅ’ Bot launch error:', err.message));

    console.log('Ã¢Å“â€¦ ARIA IS LIVE AND LISTENING');

    // Seed memory with vendor patterns and known processes on every boot
    // (seedMemories uses upsert so this is idempotent)
    try {
        const { seedMemories } = await import('../lib/intelligence/memory');
        const { seedKnownVendorPatterns } = await import('../lib/intelligence/vendor-memory');
        await Promise.all([seedMemories(), seedKnownVendorPatterns()]);
        console.log('Ã°Å¸Â§Â  Memory: Ã¢Å“â€¦ Vendor patterns seeded');
    } catch (err: any) {
        console.warn('Ã¢Å¡Â Ã¯Â¸Â Memory seed failed (non-fatal):', err.message);
    }

    // Start aria-review folder watcher
    try {
        const reviewAgent = new APAgent(bot);
        await initAriaReviewWatcher(reviewAgent);
    } catch (err: any) {
        console.warn('[aria-review] Watcher failed to start (non-fatal):', err.message);
    }

    // Start desktop Sandbox folder watcher
    try {
        const sandboxAgent = new APAgent(bot);
        await initSandboxWatcher(sandboxAgent, bot);
    } catch (err: any) {
        console.warn('[sandbox] Watcher failed to start (non-fatal):', err.message);
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Restore pending approvals from Supabase (survive pm2 restart) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    try {
        const pending = await loadPendingApprovalsFromSupabase();

        if (pending.length > 0) {
            console.log(`[boot] Restoring ${pending.length} pending approval(s) from Supabase...`);

            for (const entry of pending) {
                const { approvalId, result, telegramChatId, expiresAt } = entry;

                const minutesLeft = Math.round((expiresAt.getTime() - Date.now()) / 60000);

                if (minutesLeft <= 0) {
                    console.log(`[boot] Skipping expired approval ${approvalId} (already past 24h window)`);
                    continue;
                }

                const chatId = Number(telegramChatId) || Number(process.env.TELEGRAM_CHAT_ID);
                if (!chatId) {
                    console.warn(`[boot] No chat ID for approval ${approvalId} Ã¢â‚¬â€ skipping`);
                    continue;
                }

                const summaryText = buildRestoredApprovalMessage(result, approvalId, minutesLeft);

                try {
                    await bot.telegram.sendMessage(chatId, summaryText, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: 'Ã¢Å“â€¦ Approve & Apply', callback_data: `approve_${approvalId}` },
                                { text: 'Ã¢ÂÅ’ Reject', callback_data: `reject_${approvalId}` },
                            ]],
                        },
                    });
                    console.log(`[boot] Restored approval prompt for ${approvalId} (${minutesLeft}m remaining)`);
                } catch (sendErr: any) {
                    console.warn(`[boot] Could not send restored approval for ${approvalId}: ${sendErr.message}`);
                }
            }
        }
    } catch (err: any) {
        console.warn('[boot] Could not restore pending approvals (non-fatal):', err.message);
    }

    const ops = new OpsManager(bot);
    ops.registerJobs();
    console.log('[boot] OpsManager cron jobs registered.');

    // Start Slack Watchdog in-process BEFORE botDeps construction
    // so deps.watchdog captures the live instance, not null.
    // DECISION(2026-03-20): /requests needs deps.watchdog to be the running instance.
    const pollInterval = parseInt(process.env.SLACK_POLL_INTERVAL || '60', 10);
    let startedWatchdog: SlackWatchdog | null = null;
    const startupHealth = await getStartupHealth({
        hasSlackToken: Boolean(process.env.SLACK_ACCESS_TOKEN),
        startSlackWatchdog: async () => {
            const watchdog = new SlackWatchdog(pollInterval);
            await watchdog.start();
            startedWatchdog = watchdog;
        },
    });
    globalWatchdog = startedWatchdog;

    console.log(`[boot] Startup health: bot=${startupHealth.bot}, dashboard=${startupHealth.dashboard}, slack=${startupHealth.slack}`);
    if (startupHealth.slack === 'running') {
        console.log('Slack Watchdog: running in-process');
    } else if (process.env.SLACK_ACCESS_TOKEN) {
        startupHealth.notes.forEach((note) => console.warn(`[boot] ${note}`));
    } else {
        console.log('Slack Watchdog: disabled by config');
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ REGISTER MODULAR COMMANDS Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // DECISION(2026-03-20): Commands extracted to src/cli/commands/ modules.
    // Must be registered AFTER OpsManager is created so deps.opsManager is available.
    // Previously, /crons referenced undeclared `opsManager` variable Ã¢â‚¬â€ now fixed.
    const botDeps = {
        bot,
        finale,
        opsManager: ops,
        watchdog: globalWatchdog,
        chatHistory,
        chatLastActive,
        perplexityKey: perplexityKey || null,
        elevenLabsKey: elevenLabsKey || null,
        botStartTime: BOT_START_TIME,
    };
    registerAllCommands(bot, botDeps);
    startBotControlPlane(ops);


    console.log('Ã°Å¸â€œâ€¦ Cron schedules registered:');

    console.log('   Ã°Å¸ÂÂ­ Build Risk Report:  7:30 AM MT (Weekdays)');
    console.log('   Ã°Å¸â€œÅ  Daily PO Summary:  8:00 AM MT (Weekdays)');
    console.log('   Ã°Å¸â€”â€œÃ¯Â¸Â  Weekly Review:     8:01 AM MT (Fridays)');
    console.log('   Ã°Å¸â€œÂ¦ PO Sync:           Every 30 min');
    console.log('   Ã°Å¸Â§Â¹ Ad Cleanup:        Every hour');

    // Immediate healthcheck ping on boot
    const hcUrl = process.env.HEALTHCHECK_PING_URL;
    if (hcUrl) fetch(hcUrl).catch(() => {});

    // Ã¢â€â‚¬Ã¢â€â‚¬ MEMORY MONITORING (OOM prevention) Ã¢â€â‚¬Ã¢â€â‚¬
    // DECISION(2026-03-09): Log memory usage hourly for PM2 log analysis.
    // Also provides /memory command for on-demand diagnostics.
    // DECISION(2026-03-16): Added Healthchecks.io dead-man's switch ping.
    // If the bot stops pinging for 30 min, HC.io sends an email alert
    // independently of this machine. One-line fire-and-forget.
    setInterval(() => {
        const mem = process.memoryUsage();
        const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
        console.log(
            `[memory] RSS: ${mb(mem.rss)}MB | Heap: ${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB` +
            ` | External: ${mb(mem.external)}MB | Chats: ${Object.keys(chatHistory).length}`
        );

        // Healthchecks.io dead-man's switch Ã¢â‚¬â€ fire-and-forget
        const hcUrl = process.env.HEALTHCHECK_PING_URL;
        if (hcUrl) fetch(hcUrl).catch(() => {});
    }, 15 * 60 * 1000); // every 15 minutes

    let lastMemAlertSent = 0;
    setInterval(async () => {
        const heapUsed = process.memoryUsage().heapUsed;
        const HEAP_THRESHOLD = 768 * 1024 * 1024;
        const COOLDOWN = 2 * 60 * 60 * 1000;
        if (heapUsed > HEAP_THRESHOLD && Date.now() - lastMemAlertSent > COOLDOWN) {
            const mb = Math.round(heapUsed / 1024 / 1024);
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (chatId) {
                await bot.telegram.sendMessage(
                    chatId,
                    `Ã¢Å¡Â Ã¯Â¸Â Memory alert: heap at ${mb}MB / 768MB threshold (1GB hard cap) Ã¢â‚¬â€ consider restarting if this persists.`
                ).catch(() => { });
                lastMemAlertSent = Date.now();
            }
        }
    }, 30 * 60 * 1000); // every 30 minutes

    // ── CRON HEALTH WATCHDOG (setInterval, NOT cron — immune to node-cron bugs) ──
    // DECISION(2026-04-01): node-cron 4.x heartbeat chains can silently die at
    // midnight date rollover. This watchdog checks cron_runs for staleness every
    // 30 min. If a critical agent hasn't run in 2× its expected interval, sends
    // a Telegram alert so Will can investigate or restart.
    const CRON_WATCHDOG_INTERVAL = 30 * 60 * 1000; // 30 min
    // Only monitor high-frequency "always running" crons. Once-daily crons
    // (DailySummary, BuildRisk, etc.) legitimately go 20+ hours between runs
    // and should NOT trigger stale alerts.
    const CRITICAL_CRONS: { name: string; maxStaleMin: number }[] = [
        { name: 'APPolling', maxStaleMin: 25 },
        { name: 'POSync', maxStaleMin: 45 },
        { name: 'BuildCompletionWatcher', maxStaleMin: 45 },
        { name: 'POReceivingWatcher', maxStaleMin: 45 },
    ];
    let lastCronWatchdogAlert = 0;
    setInterval(async () => {
        try {
            const { createClient } = await import('../lib/supabase');
            const supabase = createClient();
            if (!supabase) return;

            // Query with the widest threshold so all crons are covered
            const maxCutoffMin = Math.max(...CRITICAL_CRONS.map(c => c.maxStaleMin));
            const cutoff = new Date(Date.now() - maxCutoffMin * 60 * 1000).toISOString();
            const { data } = await supabase.from('cron_runs')
                .select('task_name, started_at')
                .in('task_name', CRITICAL_CRONS.map(c => c.name))
                .gte('started_at', cutoff)
                .order('started_at', { ascending: false });

            // Check each cron against its own threshold
            const lastRunByTask = new Map<string, string>();
            for (const row of (data || [])) {
                if (!lastRunByTask.has(row.task_name)) {
                    lastRunByTask.set(row.task_name, row.started_at);
                }
            }
            const now = Date.now();
            const stale = CRITICAL_CRONS.filter(c => {
                const lastRun = lastRunByTask.get(c.name);
                if (!lastRun) return true;
                const ageMin = (now - new Date(lastRun).getTime()) / 60000;
                return ageMin > c.maxStaleMin;
            });

            if (stale.length > 0 && Date.now() - lastCronWatchdogAlert > 60 * 60 * 1000) {
                const chatId = process.env.TELEGRAM_CHAT_ID;
                if (chatId) {
                    const names = stale.map(s => `${s.name} (>${s.maxStaleMin}m)`).join(', ');
                    await bot.telegram.sendMessage(
                        chatId,
                        `🚨 <b>Cron Watchdog Alert</b>\n\n` +
                        `Stale crons:\n<code>${names}</code>\n\n` +
                        `Possible node-cron heartbeat death. Consider <code>pm2 restart aria-bot</code>.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                    lastCronWatchdogAlert = Date.now();
                    console.warn(`[cron-watchdog] ⚠️ Stale crons detected: ${names}`);
                }
            }
        } catch { /* non-critical */ }
    }, CRON_WATCHDOG_INTERVAL);
    // On-demand purchasing assessment: /purchases
    // Triggers scrape → assess → store → diff → Telegram
    bot.command('purchases', async (ctx) => {
        await ctx.reply('🔍 Starting purchase assessment pipeline... This may take a few minutes.');
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        try {
            await execAsync('node --import tsx src/cli/run-purchase-assessment.ts', { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
            await ctx.reply('✅ Pipeline triggered. You will receive a Telegram digest when complete.');
        } catch (err: any) {
            await ctx.reply(`❌ Failed to start pipeline: ${err.message}`);
        }
    });

    bot.command('vendor', async (ctx) => {
        const { exec: _exec } = await import('child_process');
        const { promisify: _promisify } = await import('util');
        const execAsync = _promisify(_exec);

        const args = ctx.message.text.split(' ').slice(1);
        const [vendor, ...flags] = args;
        const dryRun = flags.includes('--dry-run');
        const scrapeOnly = flags.includes('--scrape-only');
        const updateOnly = flags.includes('--update-only');
        const poFlag = flags.includes('--po') ? flags[flags.indexOf('--po') + 1] : null;
        const csvFlag = flags.includes('--csv') ? flags[flags.indexOf('--csv') + 1] : null;
        const limitFlag = flags.includes('--limit') ? flags[flags.indexOf('--limit') + 1] : null;

        const VENDORS: Record<string, { script: string; label: string; needsChrome?: boolean; needsCsv?: boolean }> = {
            uline:     { script: 'src/cli/order-uline.ts',          label: 'ULINE' },
            axiom:     { script: 'src/cli/reconcile-axiom.ts',      label: 'Axiom Print', needsChrome: true },
            fedex:     { script: 'src/cli/reconcile-fedex.ts',       label: 'FedEx', needsCsv: true },
            teraganix: { script: 'src/cli/reconcile-teraganix.ts',   label: 'TeraGanix' },
            aaa:       { script: 'src/cli/reconcile-aaa.ts',         label: 'AAA Cooper' },
        };

        const FLAG_HINTS: Record<string, string> = {
            uline:     '--dry-run --scrape-only --update-only --po <id>',
            axiom:     '--dry-run --scrape-only --update-only --po <id>',
            fedex:     '--dry-run --csv <path>',
            teraganix: '--dry-run',
            aaa:       '--dry-run --scrape-only --limit <N>',
        };

        if (!vendor) {
            const rows = Object.entries(VENDORS).map(([key, v]) => {
                return `/vendor ${key.padEnd(10)} — ${v.label.padEnd(12)} [${FLAG_HINTS[key]}]`;
            }).join('\n');
            await ctx.reply(
                `🛒 <b>Vendor Commands</b>\n\n` +
                `${rows}\n\n` +
                `Also: <code>/received</code> — sweep received POs for invoice matches\n` +
                `Also: <code>/uline</code> — ULINE pre-check + order\n` +
                `Also: <code>/ulinetest &lt;po&gt;</code> — test ULINE flow against a specific PO\n\n` +
                `<i>Flags: --dry-run | --scrape-only | --update-only | --po &lt;id&gt; | --csv &lt;path&gt;</i>`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const key = vendor.toLowerCase();
        const entry = VENDORS[key];
        if (!entry) {
            await ctx.reply(`❌ Unknown vendor: <b>${vendor}</b>\n\nTry: <code>/vendor</code> to see available vendors.`, { parse_mode: 'HTML' });
            return;
        }

        // AAA Cooper — extract invoices from ap@ Gmail, forward each to Bill.com
        if (key === 'aaa') {
            const extraFlags: string[] = [];
            if (dryRun) extraFlags.push('--dry-run');
            if (scrapeOnly) extraFlags.push('--scrape-only');
            if (limitFlag) extraFlags.push('--limit', limitFlag);
            const flagStr = extraFlags.length > 0 ? ' ' + extraFlags.join(' ') : '';
            const cmd = `node --import tsx src/cli/reconcile-aaa.ts${flagStr}`;
            await ctx.reply('🔄 Running <b>AAA Cooper</b> invoice extraction…\n<i>Scans ap@buildasoil.com, splits statement PDFs, forwards invoices to Bill.com.</i>', { parse_mode: 'HTML' });
            try {
                const { stdout, stderr } = await execAsync(cmd, { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
                const out = (stdout || '').slice(-2000);
                const errOut = (stderr || '').slice(-500);
                const summary = out || errOut || 'No output';
                await ctx.reply(`✅ <b>AAA Cooper Done</b>\n\n<pre>${summary.slice(0, 2000)}</pre>`, { parse_mode: 'HTML', disable_web_page_preview: true });
            } catch (err: any) {
                const out = (err.stdout || '').slice(-1500);
                const errOut = (err.stderr || '').slice(-500);
                await ctx.reply(`⚠️ <b>AAA Cooper Finished</b>\n\n<pre>${out || errOut || err.message.slice(0, 500)}</pre>`, { parse_mode: 'HTML', disable_web_page_preview: true });
            }
            return;
        }

        // Build flags list per vendor
        const extraFlags: string[] = [];
        if (dryRun && ['uline', 'axiom', 'fedex', 'teraganix', 'aaa'].includes(key)) extraFlags.push('--dry-run');
        if (scrapeOnly && ['uline', 'axiom', 'aaa'].includes(key)) extraFlags.push('--scrape-only');
        if (updateOnly && ['uline', 'axiom'].includes(key)) extraFlags.push('--update-only');
        if (poFlag && ['uline', 'axiom'].includes(key)) extraFlags.push('--po', poFlag);
        if (csvFlag && key === 'fedex') extraFlags.push('--csv', csvFlag);

        const flagStr = extraFlags.length > 0 ? ' ' + extraFlags.join(' ') : '';
        const cmd = `node --import tsx ${entry.script}${flagStr}`;

        const chromeNote = entry.needsChrome ? '\n⚠️ <i>Close Chrome before running (Playwright).</i>' : '';
        const csvNote = entry.needsCsv ? '\n📎 <i>Auto-finds latest CSV in Sandbox if --csv omitted.</i>' : '';

        await ctx.reply(`🔄 Running <b>${entry.label}</b>…${chromeNote}${csvNote}`, { parse_mode: 'HTML' });

        try {
            const { stdout, stderr } = await execAsync(cmd, { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
            const out = (stdout || '').slice(-2000);
            const errOut = (stderr || '').slice(-500);
            const summary = out || errOut || 'No output';
            await ctx.reply(
                `✅ <b>${entry.label} Done</b>\n\n<pre>${summary.slice(0, 2000)}</pre>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        } catch (err: any) {
            const out = (err.stdout || '').slice(-1500);
            const errOut = (err.stderr || '').slice(-500);
            await ctx.reply(
                `⚠️ <b>${entry.label} Finished</b>\n\n<pre>${out || errOut || err.message.slice(0, 500)}</pre>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        }
    });

    bot.command('uline', async (ctx) => {
        await ctx.reply('🔍 Checking ULINE status…');
        const ops = (bot.context as any).opsManager;
        if (!ops) {
            await ctx.reply('OpsManager not initialized.');
            return;
        }
        const { runFridayUlinePreCheck } = await import('./cli/order-uline');
        const FinaleClient = (await import('./lib/finale/client')).FinaleClient;
        const finale = new FinaleClient();

        let preCheck: Awaited<ReturnType<typeof runFridayUlinePreCheck>>;
        try {
            preCheck = await runFridayUlinePreCheck(finale);
        } catch (err: any) {
            await ctx.reply(`❌ Pre-check failed: ${err.message}`);
            return;
        }

        const account = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';

        if (preCheck.reason === 'recent_po_exists') {
            const po = preCheck.recentDraftPO!;
            const poUrl = `https://app.finaleinventory.com/${account}/purchaseOrder?orderId=${po.orderId}`;
            await ctx.reply(
                `✅ <b>ULINE Status</b>\n\n` +
                `Draft PO <a href="${poUrl}">#${po.orderId}</a> ` +
                `created ${new Date(po.orderDate).toLocaleDateString('en-US', { timeZone: 'America/Denver' })}.\n` +
                `A ULINE order may already be in progress — review the PO and cart.`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        if (preCheck.reason === 'no_items_needed') {
            await ctx.reply(
                `✅ <b>ULINE Status</b>\n\n` +
                `All ULINE items are above reorder threshold.\n` +
                `No order needed.`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const manifest = preCheck.manifest;
        const itemLines = manifest.items
            .slice(0, 15)
            .map((i: any) => {
                const qtyLabel = i.finaleEachQuantity === i.effectiveEachQuantity
                    ? `${i.quantity}`
                    : `${i.quantity} <i>(→ ${i.effectiveEachQuantity} ea)</i>`;
                return `  <code>${i.ulineModel}</code> × ${qtyLabel}  ($${(i.quantity * i.unitPrice).toFixed(2)})`;
            })
            .join('\n');
        const more = manifest.items.length > 15 ? `\n  <i>…and ${manifest.items.length - 15} more items</i>` : '';

        const skippedNote = manifest.skippedLowVelocity && manifest.skippedLowVelocity.length > 0
            ? `\n<i>⚠️ ${manifest.skippedLowVelocity.length} low-velocity items skipped</i>\n`
            : '';

        const msg = `🛒 <b>ULINE Order — Approval Needed</b>\n\n` +
            `${skippedNote}` +
            `📦 ${manifest.items.length} item${manifest.items.length === 1 ? '' : 's'} needing reorder\n` +
            `💰 Est. Total: <b>$${manifest.totalEstimate.toFixed(2)}</b>\n\n` +
            `${itemLines}${more}\n\n` +
            `<i>Create draft PO and fill ULINE cart?</i>`;

        const sentMsg = await ctx.reply(msg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Approve & Fill Cart', callback_data: 'approve_uline_friday' },
                    { text: '⏭️ Skip', callback_data: 'skip_uline_friday' },
                ]],
            },
        });

        (ops as any).pendingUlineFriday = {
            messageId: sentMsg.message_id,
            manifest,
            manifestJson: JSON.stringify(manifest),
        };
    });

    bot.command('ulinetest', async (ctx) => {
        const args = ctx.message.text.split(' ').slice(1);
        const poId = args[0];

        await ctx.reply(poId
            ? `🔍 Testing ULINE flow with PO #${poId}…`
            : '🔍 Testing ULINE flow with most recent draft PO…');

        const { gatherFromPO, executeUlineFridayApproval, gatherAllUlineDraftPOs } = await import('./cli/order-uline');
        const FinaleClient = (await import('./lib/finale/client')).FinaleClient;
        const finale = new FinaleClient();

        let manifest: any;
        if (poId) {
            manifest = await gatherFromPO(finale, poId);
        } else {
            const allDrafts = await gatherAllUlineDraftPOs(finale);
            if (allDrafts.length === 0) {
                await ctx.reply('❌ No ULINE draft POs found in Finale.');
                return;
            }
            manifest = allDrafts[0];
        }

        if (manifest.items.length === 0) {
            await ctx.reply(`❌ No ULINE items found in PO #${poId || 'latest draft'}.`);
            return;
        }

        const result = await executeUlineFridayApproval(manifest);

        if (!result.success) {
            await ctx.reply(
                `🚨 <b>ULINE Test Failed</b>\n\n` +
                `<b>Error:</b> ${result.error || 'Unknown error'}\n` +
                `Items: ${result.itemCount} | Total: $${result.estimatedTotal.toFixed(2)}`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        const itemLines = result.items
            .slice(0, 10)
            .map((i: any) => `  <code>${i.ulineModel}</code> × ${i.qty}  ($${(i.qty * i.unitPrice).toFixed(2)})`)
            .join('\n');
        const more = result.items.length > 10 ? `\n  <i>…and ${result.items.length - 10} more</i>` : '';

        const poLine = result.finalePO && result.finaleUrl
            ? `<a href="${result.finaleUrl}">Finale PO #${result.finalePO}</a>`
            : result.finalePO ? `Finale PO #${result.finalePO}` : '⚠️ PO creation skipped';

        const cartIcon = result.cartVerificationStatus === 'verified' ? '🛒'
            : result.cartVerificationStatus === 'partial' ? '⚠️' : '🟡';

        await ctx.reply(
            `🛒 <b>ULINE Test — Done</b>\n\n` +
            `📄 ${poLine}\n` +
            `💰 Est. Total: <b>$${result.estimatedTotal.toFixed(2)}</b>\n` +
            `📦 ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}:\n\n` +
            `${itemLines}${more}\n\n` +
            `${cartIcon} Cart: ${result.cartResult}\n` +
            (result.cartUrl
                ? `Cart link: <a href="${result.cartUrl}">Load in browser</a>`
                : `<a href="https://www.uline.com/Ordering/QuickOrder">ULINE Quick Order</a>`),
            { parse_mode: 'HTML', disable_web_page_preview: true }
        );
    });

    // ── RECEIVED PO SWEEP ───────────────────────────────────────────────────────
    bot.command('received', async (ctx) => {
        const args = ctx.message.text.split(' ').slice(1);
        const dryRun = args.includes('--dry-run');
        const daysArg = args.find((a: string) => a.startsWith('--days='));
        const days = daysArg ? daysArg.split('=')[1] : '60';
        const flagStr = dryRun ? ' --dry-run' : '';

        await ctx.reply(`🔄 Running PO sweep (last ${days} days)…`);

        const { exec: _exec } = await import('child_process');
        const { promisify: _promisify } = await import('util');
        const execAsync = _promisify(_exec);

        try {
            const { stdout, stderr } = await execAsync(
                `node --import tsx src/cli/reconcile-received-pos.ts --days=${days}${flagStr}`,
                { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 }
            );
            const out = (stdout || '').slice(-2000);
            const errOut = (stderr || '').slice(-500);
            const summary = out || errOut || 'No output';
            await ctx.reply(
                `✅ <b>PO Sweep Done</b>\n\n<pre>${summary.slice(0, 2000)}</pre>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        } catch (err: any) {
            const out = (err.stdout || '').slice(-1500);
            const errOut = (err.stderr || '').slice(-500);
            await ctx.reply(
                `⚠️ <b>PO Sweep Finished</b>\n\n<pre>${out || errOut || err.message.slice(0, 500)}</pre>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
        }
    });

    })();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


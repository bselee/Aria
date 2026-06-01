/**
 * @file    ap-autonomous-poll.ts
 * @purpose Headless AP inbox watchdog. Polls ap@buildasoil.com for unread
 *          invoices and ONLY emits actionable alerts (unmatched invoices
 *          from vendors with Finale PO history). Silent otherwise.
 * @usage   node --import tsx src/cli/ap-autonomous-poll.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Telegraf } from 'telegraf';
import { APAgent } from '../lib/intelligence/ap-agent';

async function main() {
    const token = process.env.TELEGRAM_BOT_TOKEN || 'dummy';
    const bot = new Telegraf(token);
    const agent = new APAgent(bot);

    // Capture stdout from processUnreadInvoices to filter noise
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    const actionable: string[] = [];
    let hasRateLimit = false;

    console.log = (...args: any[]) => {
        const msg = args.join(' ');
        if (msg.includes('unmatched') && msg.includes('alert')) {
            actionable.push(msg);
        }
        if (msg.includes('rate limit') || msg.includes('quota')) {
            hasRateLimit = true;
            actionable.push(msg);
        }
        // Suppress all other output for silent operation
    };
    console.warn = () => {};
    console.error = () => {};

    try {
        await agent.processUnreadInvoices();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    }

    if (actionable.length > 0) {
        console.log('[AP-WATCHDOG] Actionable items found:');
        actionable.forEach(a => console.log(a));
        process.exit(0);
    }

    // Silent success — no output means nothing to report
}

main().catch(err => {
    console.error('[AP-WATCHDOG] Fatal error:', err.message);
    process.exit(1);
});

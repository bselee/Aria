/**
 * @file    backfill-purchasing-calendar.ts
 * @purpose One-shot script to seed the purchasing Google Calendar with the last 7 days
 *          of Finale purchase orders (all statuses: open, received, cancelled).
 *
 * Idempotent — checks the purchasing_calendar_events Supabase table before creating,
 * so it's safe to run multiple times.
 *
 * Usage:
 *   node --import tsx src/cli/backfill-purchasing-calendar.ts
 *
 * To extend the lookback window:
 *   node --import tsx src/cli/backfill-purchasing-calendar.ts --days 14
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Telegraf } from 'telegraf';
import { OpsManager } from '../lib/intelligence/ops-manager';

(async () => {
    const args = process.argv.slice(2);
    const daysArg = args.findIndex(a => a === '--days');
    const daysBack = daysArg !== -1 && args[daysArg + 1] ? parseInt(args[daysArg + 1], 10) : 7;

    console.log(`\n🗓️  Purchasing Calendar Backfill — last ${daysBack} days\n`);

    // OpsManager requires a bot instance but we won't be sending Telegram messages
    // Use the real token since Telegraf validates format on construction
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const bot = new Telegraf(token);

    const manager = new OpsManager(bot);
    const result = await manager.syncPurchasingCalendar(daysBack);

    console.log(`\n✅ Backfill complete:`);
    console.log(`   Created : ${result.created}`);
    console.log(`   Updated : ${result.updated}`);
    console.log(`   Skipped : ${result.skipped} (already in sync)\n`);

    process.exit(0);
})();

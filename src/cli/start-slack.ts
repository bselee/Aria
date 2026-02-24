/**
 * @file    start-slack.ts
 * @purpose Standalone Slack Watchdog launcher for Aria.
 * @author  Antigravity
 * @created 2026-02-24
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { SlackWatchdog } from '../lib/slack/watchdog';

async function boot() {
    console.log("🌑 ARIA SLACK AGENT STARTING...");

    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
        console.error("❌ SLACK_BOT_TOKEN or SLACK_APP_TOKEN missing in .env.local");
        process.exit(1);
    }

    try {
        const watchdog = new SlackWatchdog();
        await watchdog.start();
    } catch (err: any) {
        console.error("❌ Slack Watchdog failed to start:", err.message);
        process.exit(1);
    }
}

boot();

/**
 * @file    start-slack.ts
 * @purpose Standalone Slack Watchdog launcher for Aria (polling mode).
 *          Uses Will's user token to silently monitor all his channels.
 * @author  Antigravity
 * @created 2026-02-24
 * @updated 2026-02-24
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { SlackWatchdog } from '../lib/slack/watchdog';

async function boot() {
    console.log("🌑 ARIA SLACK AGENT STARTING (Silent Monitor Mode)...");

    if (!process.env.SLACK_ACCESS_TOKEN) {
        console.error("❌ SLACK_ACCESS_TOKEN missing in .env.local");
        process.exit(1);
    }

    try {
        // Poll every 60 seconds by default
        const pollInterval = parseInt(process.env.SLACK_POLL_INTERVAL || "60", 10);
        const watchdog = new SlackWatchdog(pollInterval);
        await watchdog.start();
    } catch (err: any) {
        console.error("❌ Slack Watchdog failed to start:", err.message);
        process.exit(1);
    }
}

boot();

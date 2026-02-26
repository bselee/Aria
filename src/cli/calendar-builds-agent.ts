/**
 * @file    calendar-builds-agent.ts
 * @purpose CLI entrypoint for the Calendar Builds Agent.
 *          Thin wrapper around the reusable build-risk engine.
 * @author  Aria
 * @created 2026-02-25
 * @updated 2026-02-25
 *
 * Usage:
 *   npx tsx src/cli/calendar-builds-agent.ts           # Full run + Slack post
 *   npx tsx src/cli/calendar-builds-agent.ts --dry-run  # Console only, no Slack
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runBuildRiskAnalysis } from '../lib/builds/build-risk';

async function main() {
    const isDryRun = process.argv.includes('--dry-run');
    console.log(`\n🚀 Calendar Builds Agent${isDryRun ? ' (DRY RUN)' : ''}...\n`);

    const report = await runBuildRiskAnalysis(30, console.log);

    // Print console-friendly version of Slack report
    const consoleMsg = report.slackMessage
        .replace(/:factory:/g, '🏭')
        .replace(/:rotating_light:/g, '🚨')
        .replace(/:red_circle:/g, '🔴')
        .replace(/:large_yellow_circle:/g, '🟡')
        .replace(/:warning:/g, '⚠️')
        .replace(/:white_check_mark:/g, '✅')
        .replace(/:eyes:/g, '👀')
        .replace(/:package:/g, '📦')
        .replace(/:grey_question:/g, '❓');
    console.log(consoleMsg);

    // Post to Slack
    if (!isDryRun && process.env.SLACK_BOT_TOKEN) {
        try {
            const { WebClient } = await import('@slack/web-api');
            const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
            await slack.chat.postMessage({
                channel: '#purchasing',
                text: report.slackMessage,
                mrkdwn: true,
            });
            console.log('📤 Posted to Slack #purchasing');
        } catch (err: any) {
            console.error('❌ Slack post failed:', err.message);
        }
    } else if (isDryRun) {
        console.log('ℹ️  Dry run — skipping Slack post.');
    } else {
        console.log('⚠️ SLACK_BOT_TOKEN not set — skipping Slack post.');
    }
}

main().catch(console.error);

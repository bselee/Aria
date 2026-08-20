/**
 * @file    calendar-builds-agent.ts
 * @purpose CLI entrypoint for the Calendar Builds Agent.
 *          Thin wrapper around the reusable build-risk engine.
 * @author  Aria
 * @created 2026-02-25
 * @updated 2026-08-20 — Slack removed; console-only report.
 *
 * Usage:
 *   npx tsx src/cli/calendar-builds-agent.ts           # Full run, console report
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runBuildRiskAnalysis } from '../lib/builds/build-risk';

async function main() {
    console.log(`\n🚀 Calendar Builds Agent...\n`);

    const report = await runBuildRiskAnalysis(30, console.log);

    // Print console-friendly version of the report
    const consoleMsg = report.textReport
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
}

main().catch(console.error);

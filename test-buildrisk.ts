import { runBuildRiskAnalysis } from './src/lib/builds/build-risk';
import { WebClient } from '@slack/web-api';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function main() {
    console.log('Running 30-Day Build Risk Analysis for Slack reporting example...');

    // 1. Run the analysis
    const report = await runBuildRiskAnalysis(30, (msg) => {
        console.log(`[buildrisk] ${msg}`);
    });

    console.log('\n--- SLACK TEXT OUTPUT ---');
    console.log(report.slackMessage);

    // 2. Send to Slack if token exists
    const token = process.env.SLACK_BOT_TOKEN;
    if (token) {
        console.log('\nToken found. Sending to Slack channel #purchasing...');
        const slack = new WebClient(token);

        try {
            const res = await slack.chat.postMessage({
                channel: '#purchasing',
                text: report.slackMessage
            });
            console.log('Slack response OK:', res.ok, 'ts:', res.ts);
        } catch (err: any) {
            console.error('Error sending to slack:', err.message);
        }
    } else {
        console.log('\nNo SLACK_BOT_TOKEN found in .env.local, skipping Slack broadcast.');
    }
}

main().catch(console.error);

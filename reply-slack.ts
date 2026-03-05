import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { WebClient } from '@slack/web-api';

async function run() {
    const text = `ALK101 (Blumat Preset Adj Allen Key):\nPO 124416: 500 units from Amazon (arriving 2/27/2026)\n\nBLM208 (Blumat 8mm Elbows)\nPO 124352: 100 units from Sustainable Village (arriving 2/3/2026)`;

    try {
        const client = new WebClient(process.env.SLACK_BOT_TOKEN);
        await client.chat.postMessage({
            channel: 'C02QVN4P0QJ',
            thread_ts: '1772746584.126199',
            text: text,
            unfurl_links: false
        });
        console.log("Replied successfully with bot token!");
    } catch (e: any) {
        if (e.data?.error === 'not_in_channel' || e.data?.error === 'invalid_auth') {
            console.log("Bot not in channel or auth failed. Using user token.");
            const userClient = new WebClient(process.env.SLACK_ACCESS_TOKEN);
            await userClient.chat.postMessage({
                channel: 'C02QVN4P0QJ',
                thread_ts: '1772746584.126199',
                text: text,
                unfurl_links: false
            });
            console.log("Replied successfully with user token!");
        } else {
            console.error("Error firing slack message", e);
        }
    }
}
run();

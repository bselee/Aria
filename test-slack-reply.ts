import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { WebClient } from '@slack/web-api';

async function run() {
    const client = new WebClient(process.env.SLACK_BOT_TOKEN || process.env.SLACK_ACCESS_TOKEN);
    const convs = await client.conversations.list({ types: 'public_channel,private_channel', limit: 200, exclude_archived: true });

    // Check channels bot is in
    const channelsToSearch = convs.channels?.filter(c => c.is_member) || [];
    console.log(`Searching ${channelsToSearch.length} channels for the message...`);

    for (const channel of channelsToSearch) {
        if (!channel.id) continue;
        try {
            const res = await client.conversations.history({ channel: channel.id, limit: 100 });
            for (const msg of res.messages || []) {
                if (msg.text?.includes("Thursday walk with")) {
                    console.log(`FOUND IN CHANNEL: ${channel.name} (${channel.id}) ts: ${msg.ts}`);
                    return;
                }
            }
        } catch (e: any) {
            // Ignore errors for individual channels
        }
    }

    // Also try checking with user token if bot is not in the channel
    const userClient = new WebClient(process.env.SLACK_ACCESS_TOKEN);
    const userConvs = await userClient.conversations.list({ types: 'public_channel,private_channel', limit: 200, exclude_archived: true });
    const userChannelsToSearch = userConvs.channels?.filter(c => c.is_member) || [];
    console.log(`Searching ${userChannelsToSearch.length} channels with user token...`);

    for (const channel of userChannelsToSearch) {
        if (!channel.id) continue;
        try {
            const res = await userClient.conversations.history({ channel: channel.id, limit: 100 });
            for (const msg of res.messages || []) {
                if (msg.text?.includes("Thursday walk with")) {
                    console.log(`FOUND IN CHANNEL: ${channel.name} (${channel.id}) ts: ${msg.ts}`);
                    return;
                }
            }
        } catch (e: any) {
            // Ignore errors for individual channels
        }
    }
    console.log("NOT FOUND");
}
run();

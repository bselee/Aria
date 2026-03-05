import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { APAgent } from './src/lib/intelligence/ap-agent';
import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

async function run() {
    const agent = new APAgent(bot);
    console.log("Starting manual AP Agent run...");
    await agent.processUnreadInvoices();
    console.log("Manual AP Agent run complete.");
    process.exit(0);
}

run();

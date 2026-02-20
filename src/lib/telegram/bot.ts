import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { processDocument } from '../gmail/attachment-handler';
// We'd load via global or dynamic dotenv typically depending on env

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

bot.start((ctx: Context) => ctx.reply('ARIA Document Intel Online. Send me PDFs or images of invoices/BOLs and I will extract and queue them.'));

bot.on(message('document'), async (ctx: Context) => {
    const msg = (ctx as any).message;
    const document = msg.document;
    const fileId = document.file_id;
    const fileName = document.file_name || 'telegram-upload.pdf';
    const mimeType = document.mime_type || 'application/octet-stream';

    if (!mimeType.includes('pdf') && !mimeType.includes('image')) {
        return ctx.reply("Sorry, I can only process PDFs or images at this time.");
    }

    try {
        const fileLink = await ctx.telegram.getFileLink(fileId);

        // Fetch the buffer via the generated API link from Telegram
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);

        // Route it right into our defined extraction queue function
        const result = await processDocument(buffer, {
            filename: fileName,
            mimeType: mimeType,
            source: 'upload',
            sourceRef: `telegram_${msg.message_id}_${msg.from.id}`,
            emailFrom: msg.from.username || msg.from.first_name,
        });

        ctx.reply(`✅ Successfully grouped and extracted: ${fileName}\nStatus: ${result.document?.status}\nAction: ${result.document?.action_summary}`);

    } catch (err) {
        console.error(err);
        ctx.reply("❌ Error processing your document via ARIA.");
    }
});

// Optionally Export logic so NextJS or node handles the long-polling loop vs webhook mappings.
export function startTelegramBot() {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        console.warn("TELEGRAM_BOT_TOKEN not provided, skipping Telegram integration.");
        return;
    }
    bot.launch();
    console.log("ARIA Telegram listener running");
}

// Graceful stop listener pattern usually recommended for Next/Node services
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

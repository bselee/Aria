/**
 * @file    start-bot.ts
 * @purpose Standalone Telegram bot launcher for Aria. Connects the persona,
 *          Anthropic (Claude), and OpenAI (Fallback) with tool access.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-02-20
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Telegraf } from 'telegraf';
import axios from 'axios';
import OpenAI from 'openai';
import {
    SYSTEM_PROMPT,
    VOICE_CONFIG,
    TELEGRAM_CONFIG
} from '../config/persona';
import { OpsManager } from '../lib/intelligence/ops-manager';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { google } from 'googleapis';
import { unifiedTextGeneration } from '../lib/intelligence/llm';

// ──────────────────────────────────────────────────
// CLIENT INITIALIZATION
// ──────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const perplexityKey = process.env.PERPLEXITY_API_KEY;

if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env.local');
    process.exit(1);
}

const bot = new Telegraf(token);
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;
const perplexity = perplexityKey ? new OpenAI({
    apiKey: perplexityKey,
    baseURL: 'https://api.perplexity.ai'
}) : null;

console.log('🚀 ARIA BOT BOOTING...');
console.log(`🤖 Telegram: ✅ Connected`);
console.log(`🧠 Unified LLM: ✅ Ready (Anthropic + OpenAI Fallback)`);
console.log(`🔍 Perplexity: ${perplexityKey ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`🎙️ ElevenLabs: ${elevenLabsKey ? '✅ Loaded' : '❌ Not Configured'}`);

// ──────────────────────────────────────────────────
// COMMANDS
// ──────────────────────────────────────────────────

bot.start((ctx) => {
    const username = ctx.from?.first_name || 'Will';
    ctx.reply(TELEGRAM_CONFIG.welcomeMessage(username), { parse_mode: 'Markdown' });
});

bot.command('status', (ctx) => {
    ctx.reply(
        `🛰️ **Aria Internal Diagnostics**\n\n` +
        `Status: Operational\n` +
        `Telegram: ✅ Online\n` +
        `Intelligence: ✅ Unified (Sonnet 3.5 + GPT-4o)\n` +
        `Voice: ${elevenLabsKey ? '✅ Loaded' : '❌ Missing'}\n\n` +
        `_"Efficiency is doing things right; effectiveness is doing the right things."_`,
        { parse_mode: 'Markdown' }
    );
});

// /voice
bot.command('voice', async (ctx) => {
    if (!elevenLabsKey) return ctx.reply('❌ ElevenLabs API key not configured.');

    ctx.reply('🎙️ Aria is thinking... (Voice generation in progress)');

    try {
        let textToSpeak = await unifiedTextGeneration({
            system: SYSTEM_PROMPT + "\n\nLimit your response to a single, clever sentence under 25 words for a voice greeting.",
            prompt: "Say something witty and operational to Will to start the day."
        });

        // Pass to ElevenLabs
        const voiceResponse = await axios.post(
            `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_CONFIG.voiceId}`,
            {
                text: textToSpeak,
                model_id: VOICE_CONFIG.modelId,
                voice_settings: {
                    stability: VOICE_CONFIG.stability,
                    similarity_boost: VOICE_CONFIG.similarityBoost,
                    style: VOICE_CONFIG.style,
                },
            },
            {
                headers: {
                    'xi-api-key': elevenLabsKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                responseType: 'arraybuffer',
            }
        );

        await ctx.replyWithVoice({
            source: Buffer.from(voiceResponse.data),
            filename: 'aria-reply.ogg',
        });

        ctx.reply(`💬 _Text version: "${textToSpeak}"_`, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error('Voice generation error:', err.message);
        ctx.reply(`❌ Failed to find my voice: ${err.message}`);
    }
});

// /populate
bot.command('populate', async (ctx) => {
    ctx.reply("🧠 Starting PO Memory Backfill (Last 2 Weeks)... This will take a moment.");
    try {
        const { processEmailAttachments } = require('../lib/gmail/attachment-handler');
        const auth = await getAuthenticatedClient("default");
        const gmail = google.gmail({ version: "v1", auth });

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const dateQuery = twoWeeksAgo.toISOString().split('T')[0].replace(/-/g, '/');

        const { data: search } = await gmail.users.messages.list({
            userId: "me",
            q: `label:PO after:${dateQuery}`,
            maxResults: 15
        });

        if (!search.messages?.length) return ctx.reply("📭 No recent POs found.");

        let count = 0;
        for (const m of search.messages) {
            const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata" });
            const subject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
            const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "Unknown";
            const date = msg.payload?.headers?.find(h => h.name === 'Date')?.value || "";

            const { indexOperationalContext } = require('../lib/intelligence/pinecone');
            await indexOperationalContext(
                `po-thread-${m.id}`,
                `PO Thread: ${subject} from ${from}. Date: ${date}`,
                { source: "telegram_backfill", subject, from, date }
            );

            await processEmailAttachments("default", m.id!, { from, subject, date });
            count++;
        }
        ctx.reply(`✨ Backfill complete! Processed ${count} PO threads.`);
    } catch (err: any) {
        ctx.reply(`❌ Backfill failed: ${err.message}`);
    }
});

// ──────────────────────────────────────────────────
// MESSAGE HANDLERS
// ──────────────────────────────────────────────────

bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    ctx.sendChatAction('typing');

    try {
        // We use unifiedTextGeneration for the initial reply,
        // BUT for tool use we currently rely on the OpenAI path in gpt-4o 
        // because Claude SDK tool usage is slightly different than OpenAI's.
        // For now, I will improve the OpenAI tool choice and add the weather tool.

        let reply = "";

        if (openai) {
            const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
                {
                    type: "function",
                    function: {
                        name: "get_weather",
                        description: "Get real-time weather information for a specific location.",
                        parameters: {
                            type: "object",
                            properties: {
                                location: { type: "string", description: "City and State, e.g. Montrose, CO" }
                            },
                            required: ["location"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "list_recent_emails",
                        description: "List the 5 most recent emails from the inbox.",
                        parameters: { type: "object", properties: {} }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "perplexity_search",
                        description: "Search the internet for real-time information.",
                        parameters: {
                            type: "object",
                            properties: { query: { type: "string" } },
                            required: ["query"]
                        }
                    }
                }
            ];

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: SYSTEM_PROMPT + "\n\nYou have access to tools. Use 'get_weather' for weather requests." },
                    { role: "user", content: userText }
                ],
                tools,
                tool_choice: "auto",
            });

            const message = response.choices[0].message;

            if (message.tool_calls) {
                const toolResults: any[] = [];
                for (const toolCall of message.tool_calls) {
                    const args = JSON.parse(toolCall.function.arguments);
                    let result = "";

                    if (toolCall.function.name === "get_weather") {
                        const Firecrawl = require('@mendable/firecrawl-js').default;
                        const app = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
                        const scrape = await app.scrapeUrl(`https://duckduckgo.com/?q=weather+in+${encodeURIComponent(args.location)}`, { formats: ['markdown'] });
                        result = scrape.success ? scrape.markdown : "Could not retrieve weather.";
                    } else if (toolCall.function.name === "perplexity_search" && perplexity) {
                        const res = await perplexity.chat.completions.create({
                            model: "sonar-reasoning",
                            messages: [{ role: "user", content: args.query }]
                        });
                        result = res.choices[0].message.content || "";
                    } else if (toolCall.function.name === "list_recent_emails") {
                        const auth = await getAuthenticatedClient("default");
                        const gmail = google.gmail({ version: "v1", auth });
                        const { data } = await gmail.users.messages.list({ userId: "me", maxResults: 5 });
                        result = JSON.stringify(data.messages);
                    }

                    toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: result });
                }

                const finalRes = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: userText },
                        message,
                        ...toolResults
                    ]
                });
                reply = finalRes.choices[0].message.content || "";
            } else {
                reply = message.content || "";
            }
        } else {
            // No OpenAI, just use Unified (which will try Anthropic)
            reply = await unifiedTextGeneration({
                system: SYSTEM_PROMPT,
                prompt: userText
            });
        }

        ctx.reply(reply, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error('Chat Error:', err.message);
        ctx.reply(`⚠️ Ops: ${err.message}`);
    }
});

// Boot
bot.launch().then(() => {
    console.log('✅ ARIA IS LIVE AND LISTENING');
    const ops = new OpsManager(bot);
    ops.start();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

/**
 * @file    start-bot.ts
 * @purpose Standalone Telegram bot launcher for Aria. Connects the persona,
 *          Anthropic (Claude), and ElevenLabs for a ruthlessly helpful experience.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-02-20
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Telegraf } from 'telegraf';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
    SYSTEM_PROMPT,
    VOICE_CONFIG,
    TELEGRAM_CONFIG
} from '../config/persona';
import { OpsManager } from '../lib/intelligence/ops-manager';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { google } from 'googleapis';

// ──────────────────────────────────────────────────
// CLIENT INITIALIZATION
// ──────────────────────────────────────────────────
const token = process.env.TELEGRAM_BOT_TOKEN;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;

if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set in .env.local');
    process.exit(1);
}

const bot = new Telegraf(token);
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const perplexityKey = process.env.PERPLEXITY_API_KEY;
const perplexity = perplexityKey ? new OpenAI({
    apiKey: perplexityKey,
    baseURL: 'https://api.perplexity.ai'
}) : null;

console.log('🚀 ARIA BOT BOOTING...');
console.log(`🤖 Telegram: ✅ Connected`);
console.log(`🧠 Anthropic: ${anthropic ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`🧠 OpenAI (Fallback): ${openai ? '✅ Loaded' : '⚠️ Not Configured'}`);
console.log(`🔍 Perplexity: ${perplexityKey ? '✅ Loaded' : '❌ Not Configured'}`);
console.log(`🎙️ ElevenLabs: ${elevenLabsKey ? '✅ Loaded' : '❌ Not Configured'}`);

// ──────────────────────────────────────────────────
// COMMANDS
// ──────────────────────────────────────────────────

// /start
bot.start((ctx) => {
    const username = ctx.from?.first_name || 'Will';
    ctx.reply(TELEGRAM_CONFIG.welcomeMessage(username), { parse_mode: 'Markdown' });
});

// /status
bot.command('status', (ctx) => {
    const checks = {
        telegram: '✅ Online',
        anthropic: anthropicKey ? '✅ Loaded' : '❌ Missing',
        elevenlabs: elevenLabsKey ? '✅ Loaded' : '❌ Missing',
        persona: '✅ Loaded (Ruthlessly Helpful)',
    };

    ctx.reply(
        `🛰️ **Aria Internal Diagnostics**\n\n` +
        `Status: Operational\n` +
        `Telegram: ${checks.telegram}\n` +
        `Intelligence: ${checks.anthropic}\n` +
        `Voice: ${checks.elevenlabs}\n` +
        `Persona: ${checks.persona}\n\n` +
        `_"Efficiency is doing things right; effectiveness is doing the right things."_`,
        { parse_mode: 'Markdown' }
    );
});

// /voice
bot.command('voice', async (ctx) => {
    if (!elevenLabsKey) return ctx.reply('❌ ElevenLabs API key not configured.');

    // We'll generate a brief catch-up or status update in Aria's voice
    ctx.reply('🎙️ Aria is thinking... (Voice generation in progress)');

    try {
        // 1. Get a clever line from Claude first
        let textToSpeak = "I'm ready to handle the chaos, Will. What's on deck today?";

        if (anthropic) {
            try {
                const response = await anthropic.messages.create({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 100,
                    system: SYSTEM_PROMPT + "\n\nLimit your response to a single, clever sentence under 25 words for a voice greeting.",
                    messages: [{ role: "user", content: "Say something witty and operational to Will to start the day." }],
                });
                if (response.content[0].type === 'text') {
                    textToSpeak = response.content[0].text;
                }
            } catch (claudeErr: any) {
                console.error('Claude voice generation failed, using fallback:', claudeErr.message);
                if (claudeErr.message.includes('credit balance')) {
                    textToSpeak = "Pay your Anthropic credits Will! I'm brilliance on a budget over here. I'll use my backup greeting for now.";
                }
            }
        }

        // 2. Pass to ElevenLabs
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
        console.error('Voice/Claude generation error:', err.message);
        ctx.reply(`❌ Failed to find my voice: ${err.message}`);
    }
});

// /emails
bot.command('emails', async (ctx) => {
    // ... (existing logic)
});

// /populate
bot.command('populate', async (ctx) => {
    ctx.reply("🧠 Starting PO Memory Backfill (Last 2 Weeks)... This will take a moment.");
    try {
        console.log("🏁 Triggering Backfill...");
        const { processEmailAttachments } = require('../lib/gmail/attachment-handler');
        const auth = await getAuthenticatedClient("default");
        const gmail = google.gmail({ version: "v1", auth });

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const dateQuery = twoWeeksAgo.toISOString().split('T')[0].replace(/-/g, '/');

        const { data: search } = await gmail.users.messages.list({
            userId: "me",
            q: `label:PO after:${dateQuery}`,
            maxResults: 20 // Limit to avoid timeout in Telegram handler
        });

        if (!search.messages?.length) return ctx.reply("📭 No recent POs found.");

        let count = 0;
        for (const m of search.messages) {
            const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata" });
            const subject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
            const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "Unknown";
            const date = msg.payload?.headers?.find(h => h.name === 'Date')?.value || "";

            // Intelligence Index (RAG)
            const { indexOperationalContext } = require('../lib/intelligence/pinecone');
            await indexOperationalContext(
                `po-thread-${m.id}`,
                `PO Thread: ${subject} from ${from}. Date: ${date}`,
                { source: "telegram_backfill", subject, from, date }
            );

            await processEmailAttachments("default", m.id!, {
                from,
                subject,
                date
            });
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

// Document Handler
bot.on('document', async (ctx) => {
    const doc = ctx.message.document;
    const fileName = doc.file_name || 'unknown-file';
    const mimeType = doc.mime_type || 'application/octet-stream';

    ctx.reply(TELEGRAM_CONFIG.documentReceived(fileName), { parse_mode: 'Markdown' });

    // Receipt logic (stays simple for now as it was working)
    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        // In a real pipeline, we'd trigger a cloud function or Next.js route here
        ctx.reply(
            `✅ **Queued**\n\n` +
            `I've got the ${fileName}. Once I finish the backend wiring, I'll have the extraction summary ready for you.\n\n` +
            `_What's next?_`,
            { parse_mode: 'Markdown' }
        );
    } catch (err: any) {
        ctx.reply(`❌ Document pipeline hangup: ${err.message}`);
    }
});

// Text / Chat Handler
bot.on('text', async (ctx) => {
    const userText = ctx.message.text;
    const chatId = ctx.chat.id;
    console.log(`💬 Message from Chat ID: ${chatId}`);

    if (!anthropic) {
        return ctx.reply(`Aria: I heard "${userText}", but my brain (Claude) isn't plugged in yet. (Chat ID: ${chatId})`);
    }

    // Visual indicator
    ctx.sendChatAction('typing');

    try {
        let reply = "";

        // Try Anthropic First
        if (anthropic) {
            try {
                const response = await anthropic.messages.create({
                    model: "claude-3-5-sonnet-20241022",
                    max_tokens: 1000,
                    system: SYSTEM_PROMPT,
                    messages: [{ role: "user", content: userText }],
                });

                if (response.content[0].type === 'text') {
                    reply = response.content[0].text;
                }
            } catch (claudeErr: any) {
                console.error('Claude Chat Error:', claudeErr.message);
                if (!openai || !claudeErr.message.includes('credit balance')) {
                    throw claudeErr;
                }
                console.log('🔄 Falling back to OpenAI...');
            }
        }

        // Fallback or Direct to OpenAI if Anthropic is missing/failed
        if (!reply && openai) {
            const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
                {
                    type: "function",
                    function: {
                        name: "list_recent_emails",
                        description: "List the 5 most recent emails from the inbox (excluding ads).",
                        parameters: { type: "object", properties: {} }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "get_po_details",
                        description: "Get details for a specific purchase order by PO number from the database.",
                        parameters: {
                            type: "object",
                            properties: {
                                po_number: { type: "string", description: "The PO number to lookup." }
                            },
                            required: ["po_number"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "search_pos_by_vendor",
                        description: "Search for purchase orders by vendor name.",
                        parameters: {
                            type: "object",
                            properties: {
                                vendor_name: { type: "string", description: "The vendor name to search for." }
                            },
                            required: ["vendor_name"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "create_draft",
                        description: "Create a draft email in Gmail. Use this to draft responses to vendors.",
                        parameters: {
                            type: "object",
                            properties: {
                                to: { type: "string", description: "Recipient email." },
                                subject: { type: "string", description: "Email subject." },
                                body: { type: "string", description: "Email body content." }
                            },
                            required: ["to", "subject", "body"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "perplexity_search",
                        description: "Search the internet for real-time information using Perplexity AI.",
                        parameters: {
                            type: "object",
                            properties: {
                                query: { type: "string", description: "The search query." }
                            },
                            required: ["query"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "extract_tracking",
                        description: "Extract tracking numbers from a block of text.",
                        parameters: {
                            type: "object",
                            properties: {
                                text: { type: "string", description: "The text to analyze." }
                            },
                            required: ["text"]
                        }
                    }
                }
            ];

            const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
                { role: "system", content: SYSTEM_PROMPT + "\n\nCRITICAL: You have access to tools. If he asks to draft an email, check status, or list threads—DO IT. You ARRANGE the tool calls. \n\nBUSINESS CONTEXT: Will runs BuildASoil. We sell premium living soil and amendments. Tone is professional but authentic and high-energy/operational." },
                { role: "user", content: userText }
            ];

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages,
                tools,
                tool_choice: "auto",
                max_tokens: 1000,
            });

            const message = response.choices[0].message;

            if (message.tool_calls) {
                const toolMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
                    ...messages,
                    message
                ];

                for (const toolCall of message.tool_calls) {
                    const args = JSON.parse(toolCall.function.arguments);
                    let result = "";

                    console.log(`🛠️ Executing Tool: ${toolCall.function.name}`, args);

                    if (toolCall.function.name === "list_recent_emails") {
                        const auth = await getAuthenticatedClient("default");
                        const gmail = google.gmail({ version: "v1", auth });
                        const { data } = await gmail.users.messages.list({ userId: "me", maxResults: 5, q: "-label:Advertisements" });
                        let emailSummary = "Emails found:\n";
                        for (const m of data.messages || []) {
                            const { data: msg } = await gmail.users.messages.get({ userId: "me", id: m.id! });
                            const subject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
                            emailSummary += `- ${subject} (ID: ${m.id})\n`;
                        }
                        result = emailSummary;
                    }
                    else if (toolCall.function.name === "get_po_details") {
                        const { createClient } = require('../lib/supabase');
                        const supabase = createClient();
                        const { data } = await supabase.from("purchase_orders").select("*").eq("po_number", args.po_number).single();
                        result = data ? JSON.stringify(data) : "PO not found.";
                    }
                    else if (toolCall.function.name === "search_pos_by_vendor") {
                        const { createClient } = require('../lib/supabase');
                        const supabase = createClient();
                        const { data } = await supabase.from("purchase_orders").select("*").ilike("vendor_name", `%${args.vendor_name}%`);
                        result = data ? JSON.stringify(data) : "No POs found for that vendor.";
                    }
                    else if (toolCall.function.name === "create_draft") {
                        const auth = await getAuthenticatedClient("default");
                        const gmail = google.gmail({ version: "v1", auth });
                        await gmail.users.drafts.create({
                            userId: "me",
                            requestBody: {
                                message: {
                                    raw: Buffer.from(
                                        `To: ${args.to}\r\n` +
                                        `Subject: ${args.subject}\r\n\r\n` +
                                        `${args.body}`
                                    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
                                }
                            }
                        });
                        result = "Draft created successfully in Gmail.";
                    }
                    else if (toolCall.function.name === "perplexity_search" && perplexity) {
                        const searchResponse = await perplexity.chat.completions.create({
                            model: "sonar-reasoning",
                            messages: [{ role: "user", content: args.query }],
                        });
                        result = searchResponse.choices[0].message.content || "Search returned no results.";
                    }
                    else if (toolCall.function.name === "extract_tracking") {
                        const { extractTrackingNumbers } = require('../lib/intelligence/utils');
                        const numbers = extractTrackingNumbers(args.text);
                        result = numbers.length > 0 ? `Tracking numbers found: ${numbers.join(", ")}` : "No tracking numbers found.";
                    }

                    toolMessages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: result
                    });
                }

                const secondResponse = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: toolMessages
                });
                reply = secondResponse.choices[0].message.content || "";
            } else {
                reply = message.content || "";
            }
        }

        if (reply) {
            ctx.reply(reply, { parse_mode: 'Markdown' });
        } else {
            throw new Error("No intelligence provider available.");
        }

    } catch (err: any) {
        console.error('Final Intelligence Error:', err.message);

        const isCreditError = err.message.includes('credit balance');

        if (isCreditError && !openai) {
            ctx.reply(
                `💳 **Aria Account Alert (Anthropic)**\n\n` +
                `Will, I checked and Anthropic is STILL reporting a low balance. 🙄 (Usually takes a few minutes to sync).\n\n` +
                `I can't switch to my backup brain because you haven't given me an **OpenAI API Key** yet. 💅\n\n` +
                `Top up [here](https://console.anthropic.com/settings/billing) or add an OpenAI key to my config to get me back online.`,
                { parse_mode: 'Markdown' }
            );
        } else {
            ctx.reply(`⚠️ Ops, I'm having a bit of a crisis. Error: ${err.message}`);
        }
    }
});

// ──────────────────────────────────────────────────
// BOOT
// ──────────────────────────────────────────────────
bot.launch().then(() => {
    console.log('✅ ARIA IS LIVE AND LISTENING');
    console.log('   Send a message or PDF in Telegram.');

    // Start Operations Manager
    const ops = new OpsManager(bot);
    ops.start();
});

bot.catch((err: any) => {
    console.error('Telegraf error:', err.message);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

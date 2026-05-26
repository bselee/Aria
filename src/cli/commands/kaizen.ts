/**
 * @file    kaizen.ts
 * @purpose Telegram commands for the feedback loop and vendor intelligence:
 *          self-review reports, vendor reliability scorecards, data cleanup,
 *          and voice generation.
 *          Extracted from start-bot.ts lines ~802-894, ~708-753.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    feedback-loop, elevenlabs, axios
 */

import type { BotCommand, BotDeps } from './types';
import { getCmdText } from './types';

// DECISION(2026-02-20): ElevenLabs voice config kept centralized here.
// If voice features expand, this should move to a config module.
const VOICE_CONFIG = {
    voiceId: 'EXAVITQu4vr4xnSDxMaL',  // "Bella" voice
    modelId: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.3,
};

/**
 * /kaizen [days] — Generate a self-review report of Aria's accuracy and performance.
 */
const kaizenCommand: BotCommand = {
    name: 'kaizen',
    description: 'Run a Kaizen self-review report',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        await ctx.reply('🧘 Running Kaizen Self-Review... analyzing recent performance.', { parse_mode: 'Markdown' });

        try {
            const { generateSelfReview } = await import('../../lib/intelligence/feedback-loop');
            const args = getCmdText(ctx).replace(/^\/kaizen\s*/, '').trim();
            const days = Math.min(Math.max(parseInt(args) || 7, 1), 90);
            const report = await generateSelfReview(days);
            await ctx.reply(report, { parse_mode: 'HTML' });
        } catch (err: any) {
            console.error('Kaizen report error:', err.message);
            await ctx.reply(`❌ Kaizen report failed: ${err.message}`);
        }
    },
};

/**
 * /housekeeping — Manually trigger data cleanup (feedback events, chat logs, etc.).
 */
const housekeepingCommand: BotCommand = {
    name: 'housekeeping',
    description: 'Trigger manual data cleanup',
    handler: async (ctx, _deps) => {
        ctx.sendChatAction('typing');
        await ctx.reply('🧹 Running manual housekeeping...', { parse_mode: 'Markdown' });

        try {
            const { runHousekeeping } = await import('../../lib/intelligence/feedback-loop');
            const report = await runHousekeeping();
            let msg = `🧹 *Housekeeping Complete*\n\n`;
            msg += `Total reclaimed: *${report.totalReclaimed}* rows/vectors\n\n`;
            if (report.feedbackEventsPruned > 0) msg += `• Feedback events: ${report.feedbackEventsPruned} pruned\n`;
            if (report.chatLogsPruned > 0) msg += `• Chat logs: ${report.chatLogsPruned} pruned\n`;
            if (report.exceptionsPruned > 0) msg += `• Exceptions: ${report.exceptionsPruned} pruned\n`;
            if (report.alertsPruned > 0) msg += `• Alerts: ${report.alertsPruned} pruned\n`;
            if (report.pineconeMemoriesPruned > 0) msg += `• Pinecone memories: ${report.pineconeMemoriesPruned} pruned\n`;
            if (report.totalReclaimed === 0) msg += `_Nothing to clean — database is tidy._ ✨\n`;
            msg += `\n_Runs automatically every night at 11 PM MT._`;
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        } catch (err: any) {
            await ctx.reply(`❌ Housekeeping failed: ${err.message}`);
        }
    },
};

/**
 * /voice — Generate and send a witty voice greeting via ElevenLabs.
 */
const voiceCommand: BotCommand = {
    name: 'voice',
    description: 'Generate a voice greeting',
    handler: async (ctx, deps) => {
        if (!deps.elevenLabsKey) return ctx.reply('❌ ElevenLabs API key not configured.');

        ctx.reply('🎙️ Aria is thinking... (Voice generation in progress)');

        try {
            const { unifiedTextGeneration } = await import('../../lib/intelligence/llm');
            const { default: axios } = await import('axios');

            // Get the system prompt for voice content generation
            const SYSTEM_PROMPT = `You are Aria — the AI operations assistant for BuildASoil.`;

            let textToSpeak = await unifiedTextGeneration({
                system: SYSTEM_PROMPT + "\n\nLimit your response to a single, clever sentence under 25 words for a voice greeting.",
                prompt: "Say something witty and operational to Will to start the day."
            });

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
                        'xi-api-key': deps.elevenLabsKey,
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
    },
};

export const kaizenCommands: BotCommand[] = [
    kaizenCommand,
    housekeepingCommand,
    voiceCommand,
];



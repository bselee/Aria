/**
 * @file    src/lib/intelligence/telegram-notify.ts
 * @purpose Standalone Telegram notification helper. Sends a message to Bill's
 *          chat ID using the bot token from env. Used by cron jobs and SOPs
 *          that don't have access to the Telegraf bot instance.
 * @author  Hermia
 * @created 2026-05-28
 * @updated 2026-05-30 — Added business hours gate (Mon-Fri 7AM-5PM Denver)
 */

import { isBusinessHours } from './alert-gate';

/**
 * Send a Markdown message to Bill's Telegram chat.
 * Gated by business hours — drops silently outside Mon-Fri 7AM-5PM.
 * Falls back to plain text if Markdown parsing fails.
 */
export async function sendTelegramNotify(text: string): Promise<void> {
    // Gate: only send during business hours
    if (!isBusinessHours()) {
        const preview = text.slice(0, 60).replace(/\n/g, ' ');
        console.log(`[telegram-notify] Gated (outside business hours): "${preview}..."`);
        return;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.warn('[telegram-notify] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
        return;
    }

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            if (/can't parse/i.test(body)) {
                // Retry without Markdown
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text,
                        disable_web_page_preview: true,
                    }),
                });
            } else {
                console.warn(`[telegram-notify] Send failed: ${body}`);
            }
        }
    } catch (err: any) {
        console.warn(`[telegram-notify] Network error: ${err.message}`);
    }
}

/**
 * Inline keyboard button for Telegram callback queries.
 */
export interface TelegramInlineButton {
    text: string;
    callback_data: string;
}

/**
 * Send a Markdown message with inline keyboard buttons to Bill's Telegram chat.
 * Used for actionable prompts (confirm receipt, approve invoice, etc).
 * Falls back to plain text (without buttons) if Markdown parsing fails.
 */
export async function sendTelegramNotifyWithButtons(
    text: string,
    buttons: TelegramInlineButton[][],
): Promise<void> {
    // Gate: only send during business hours
    if (!isBusinessHours()) {
        const preview = text.slice(0, 60).replace(/\n/g, ' ');
        console.log(`[telegram-notify] Gated buttons (outside business hours): "${preview}..."`);
        return;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.warn('[telegram-notify] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
        return;
    }

    const replyMarkup = {
        inline_keyboard: buttons,
    };

    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: replyMarkup,
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            if (/can't parse/i.test(body)) {
                // Retry without Markdown
                await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text,
                        disable_web_page_preview: true,
                        reply_markup: replyMarkup,
                    }),
                });
            } else {
                console.warn(`[telegram-notify] Send with buttons failed: ${body}`);
            }
        }
    } catch (err: any) {
        console.warn(`[telegram-notify] Network error: ${err.message}`);
    }
}

/**
 * @file    po-uline-actions.ts
 * @purpose Handles inline callback actions for draft Purchase Orders review/send
 *          and Friday ULINE cart automated creation.
 * @author  Will / Antigravity
 * @created 2026-05-26
 * @updated 2026-05-26
 * @deps    telegraf, finale/client, order-uline
 */

import type { Context } from 'telegraf';
import type { FinaleClient } from '../../lib/finale/client';
import type { OpsManager } from '../../lib/intelligence/ops-manager';
import {
    storePendingPOSend,
    expirePendingPOSend,
    lookupVendorOrderEmail,
} from '../../lib/purchasing/po-sender';
import { handleTelegramPOSendCallback } from '../../lib/copilot/channels/telegram-callbacks';

/**
 * Handles 'po_review_{orderId}' callback queries.
 */
export async function handlePoReview(ctx: Context, finale: FinaleClient, orderId: string): Promise<void> {
    await ctx.answerCbQuery('Fetching PO details…');

    try {
        const review = await finale.getDraftPOForReview(orderId);

        if (!review.canCommit) {
            const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text : '';
            await ctx.editMessageText(
                originalText + `\n\n⚠️ PO #${orderId} is no longer in draft status — cannot commit.`
            );
            return;
        }

        const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);

        const itemLines = review.items.map(i =>
            `  • ${i.productId}  ${i.productName.slice(0, 28).padEnd(28)}  ×${i.quantity}  $${i.unitPrice.toFixed(2)} = $${i.lineTotal.toFixed(2)}`
        ).join('\n');

        const reviewText = [
            `📋 *PO #${review.orderId} — ${review.vendorName}*`,
            ``,
            itemLines,
            ``,
            `*Total: $${review.total.toFixed(2)}*`,
            `To: ${email ? `${email} _(${source})_` : '⚠️ No vendor email on file'}`,
            ``,
            email
                ? `⚠️ _This will commit in Finale AND email the vendor._`
                : `_Cannot send — no email address found for ${review.vendorName}._\n_Add it to vendor\\_profiles or the vendors table._`,
        ].join('\n');

        if (!email) {
            await ctx.editMessageText(reviewText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '❌ Cancel', callback_data: `po_cancel_send_noop_${orderId}` },
                    ]],
                },
            });
            return;
        }

        const sendId = await storePendingPOSend(orderId, review, email, source, {
            channel: 'telegram',
            telegramChatId: String(ctx.chat?.id),
            telegramMessageId: ctx.callbackQuery?.message?.message_id,
        });

        await ctx.editMessageText(reviewText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Confirm Send', callback_data: `po_confirm_send_${sendId}` },
                    { text: '❌ Cancel', callback_data: `po_cancel_send_${sendId}` },
                ]],
            },
        });
    } catch (err: any) {
        await ctx.reply(`❌ Failed to fetch PO #${orderId}: ${err.message}`);
    }
}

/**
 * Handles 'po_confirm_send_{sendId}' callback queries.
 */
export async function handlePoConfirmSend(ctx: Context, sendId: string): Promise<void> {
    await ctx.answerCbQuery('Committing and sending…');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const { pending, action: result } = await handleTelegramPOSendCallback({ sendId });

    if (!pending) {
        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(
            originalText + '\n\n⚠️ Send data expired (bot restarted). Please tap "Review & Send" again to re-initiate.'
        );
        return;
    }

    try {
        if (result.status === 'failed') {
            await ctx.reply(`❌ ${result.userMessage}`);
            return;
        }

        const details = result.details as {
            orderId: string;
            sentTo: string | null;
            emailError?: string;
        };

        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(
            originalText +
            (result.status === 'partial_success'
                ? `\n\n⚠️ PO #${details.orderId} committed in Finale, but vendor email failed: ${details.emailError}`
                : `\n\n✅ PO #${details.orderId} committed in Finale and emailed to ${details.sentTo}`)
        );

        // Expected date / copy-paste response
        const expectedDate = new Date();
        expectedDate.setDate(expectedDate.getDate() + 14); // 14d default
        const expectedStr = expectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const link = `https://app.finaleinventory.com/buildasoilorganics/purchaseOrder?orderId=${details.orderId}`;
        await ctx.reply(
            `🦊 *Slack copy-paste response:*\n` +
            `\`PO #${details.orderId} committed. Expected arrival: ${expectedStr}. ${link}\``,
            { parse_mode: 'Markdown' }
        );

        // Pinecone auto-learn
        setImmediate(async () => {
            try {
                const { remember } = await import('../../lib/intelligence/memory');
                await remember({
                    category: 'process',
                    content: result.status === 'partial_success'
                        ? `PO #${details.orderId} committed in Finale, but vendor email failed: ${details.emailError}`
                        : `PO #${details.orderId} committed in Finale and emailed to ${details.sentTo}`,
                    source: 'telegram',
                    priority: 'normal',
                });
            } catch { }
        });
    } catch (err: any) {
        await ctx.reply(`❌ Failed to commit/send PO: ${err.message}`);
    }
}

/**
 * Handles 'po_cancel_send_{sendId}' callback queries.
 */
export async function handlePoCancelSend(ctx: Context, sendId: string): Promise<void> {
    await ctx.answerCbQuery('Cancelled');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await expirePendingPOSend(sendId);
    const original = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : '';
    await ctx.editMessageText(original + '\n\n_Cancelled — PO remains as draft in Finale._', { parse_mode: 'Markdown' });
}

/**
 * Handles 'po_skip_{orderId}' callback queries.
 */
export async function handlePoSkip(ctx: Context, orderId: string): Promise<void> {
    await ctx.answerCbQuery('Skipped');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const original = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : '';
    await ctx.editMessageText(original + '\n\n_Skipped — PO stays as draft in Finale._', { parse_mode: 'Markdown' });
}

/**
 * Handles Friday ULINE order approval ('approve_uline_friday') callback queries.
 */
export async function handleApproveUlineFriday(ctx: Context, opsManager: OpsManager): Promise<void> {
    await ctx.answerCbQuery('Creating PO and filling cart…');
    const pending = (opsManager as any).pendingUlineFriday;

    if (!pending) {
        await ctx.reply('No pending ULINE order found. The pre-check may have timed out or was already processed.');
        return;
    }

    const manifest = JSON.parse(pending.manifestJson);
    await ctx.reply('✅ Approved — creating draft PO and filling ULINE cart…');

    const { executeUlineFridayApproval } = await import('../order-uline');
    const result = await executeUlineFridayApproval(manifest);

    (opsManager as any).pendingUlineFriday = null;

    if (!result.success) {
        await ctx.reply(
            `🚨 <b>ULINE Order Failed</b>\n\n` +
            `<b>Error:</b> ${result.error || 'Unknown error'}\n\n` +
            `Items: ${result.itemCount} | Total: $${result.estimatedTotal.toFixed(2)}`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    const itemLines = result.items
        .slice(0, 10)
        .map((i: any) => `  <code>${i.ulineModel}</code> × ${i.qty}  ($${(i.qty * i.unitPrice).toFixed(2)})`)
        .join('\n');
    const more = result.items.length > 10 ? `\n  <i>…and ${result.items.length - 10} more</i>` : '';

    const poLine = result.finalePO && result.finaleUrl
        ? `📄 <a href="${result.finaleUrl}">Finale PO #${result.finalePO}</a>`
        : `📄 Finale PO #${result.finalePO}`;

    const cartIcon = result.cartVerificationStatus === 'verified' ? '🛒'
        : result.cartVerificationStatus === 'partial' ? '⚠️' : '🟡';

    const msg = `🛒 <b>ULINE Order — Done</b>\n\n` +
        `${poLine}\n` +
        `💰 Est. Total: <b>$${result.estimatedTotal.toFixed(2)}</b>\n` +
        `📦 ${result.itemCount} item${result.itemCount === 1 ? '' : 's'}:\n\n` +
        `${itemLines}${more}\n\n` +
        `${cartIcon} Cart: ${result.cartResult}\n` +
        (result.cartUrl
            ? `📅 Cart link: <a href="${result.cartUrl}">Load in browser</a>\n`
            : `📅 <a href="https://www.uline.com/Ordering/QuickOrder">ULINE Quick Order</a>`);

    await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true });
}

/**
 * Handles Friday ULINE order skip ('skip_uline_friday') callback queries.
 */
export async function handleSkipUlineFriday(ctx: Context, opsManager: OpsManager): Promise<void> {
    await ctx.answerCbQuery('Skipped this week');
    (opsManager as any).pendingUlineFriday = null;
    const original = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text : '';
    await ctx.editMessageText(original + '\n\n_Skipped this week._', { parse_mode: 'Markdown' });
}

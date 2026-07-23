/**
 * @file    receipt-actions.ts
 * @purpose Handles inline callback actions for delivery receipt confirmation
 *          prompts: receipt_confirm_{poNumber} and receipt_skip_{poNumber}.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    telegraf, supabase
 *
 * DESIGN:
 *   receipt_confirm: Logs confirmation. Actual Finale receiving is manual
 *   for now (safety) — but this creates the intent and updates tracking.
 *   receipt_skip: Logs the skip so we don't re-prompt for 7 days.
 */

import type { Context } from "telegraf";
import { createClient } from "../../lib/db";

/**
 * Handle 'receipt_confirm_{poNumber}' — Bill confirms the PO was received.
 */
export async function handleReceiptConfirm(ctx: Context, poNumber: string): Promise<void> {
    console.log(`✅ Receipt confirm tapped: PO ${poNumber}`);
    await ctx.answerCbQuery(`Marking ${poNumber} as received...`);

    try {
        const db = createClient();
        if (!db) {
            await ctx.editMessageText("❌ Database unavailable");
            return;
        }

        // Log the confirmation
        await db.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Receipt confirmed: PO ${poNumber}`,
            intent: "RECEIPT_CONFIRMED",
            action_taken: `Bill confirmed PO ${poNumber} received via Telegram button`,
            metadata: {
                poNumber,
                confirmedAt: new Date().toISOString(),
                source: "telegram_callback",
            },
        });

        // Update the purchase_orders table to flag for receiving
        // (actual Finale receive is done by the receiving watcher cron)
        await db
            .from("purchase_orders")
            .update({ receipt_confirmed_at: new Date().toISOString() })
            .eq("po_number", poNumber);

        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text
            : "";

        await ctx.editMessageText(
            originalText + `\n\n✅ *PO ${poNumber} confirmed received.* Will be processed in next receiving cycle.`,
            { parse_mode: "Markdown" },
        );
    } catch (err: any) {
        await ctx.editMessageText(`❌ Failed to confirm: ${err.message}`);
    }
}

/**
 * Handle 'receipt_skip_{poNumber}' — Bill wants to skip this prompt.
 */
export async function handleReceiptSkip(ctx: Context, poNumber: string): Promise<void> {
    console.log(`⏭ Receipt skip tapped: PO ${poNumber}`);
    await ctx.answerCbQuery(`Skipped — won't prompt again for 7 days`);

    try {
        const db = createClient();
        if (!db) {
            await ctx.editMessageText("❌ Database unavailable");
            return;
        }

        // Log the skip — the receipt prompt module checks this for dedup
        await db.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Receipt prompt skipped: PO ${poNumber}`,
            intent: "RECEIPT_PROMPT",
            action_taken: "skipped",
            metadata: {
                poNumber,
                skippedAt: new Date().toISOString(),
                cooldownDays: 7,
            },
        });

        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text
            : "";

        await ctx.editMessageText(
            originalText + `\n\n⏭ *Skipped.* Will not prompt again for 7 days.`,
            { parse_mode: "Markdown" },
        );
    } catch (err: any) {
        await ctx.editMessageText(`❌ Failed to skip: ${err.message}`);
    }
}

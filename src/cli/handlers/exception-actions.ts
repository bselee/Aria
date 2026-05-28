/**
 * @file    exception-actions.ts
 * @purpose Telegram callback handlers for delivery exception escalation:
 *          exception_review_{shipmentId} and exception_dismiss_{shipmentId}.
 *
 * @author  Hermia
 * @created 2026-05-28
 */

import type { Context } from "telegraf";
import { createClient } from "../../lib/supabase";

/**
 * exception_review_{shipmentId} — Bill wants to review the draft.
 * Just acknowledge the tap; the draft is already in Gmail.
 */
export async function handleExceptionReview(ctx: Context, shipmentId: string): Promise<void> {
    await ctx.answerCbQuery("Draft is in your Gmail drafts folder");

    const originalText = ctx.callbackQuery && ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text
        : "";

    await ctx.editMessageText(
        originalText + `\n\n📧 *Reviewing draft in Gmail.* Check your Drafts folder.`,
        { parse_mode: "Markdown" },
    );
}

/**
 * exception_dismiss_{shipmentId} — Bill dismisses this exception.
 * Logs dismissal so we don't re-escalate for 7 days.
 */
export async function handleExceptionDismiss(ctx: Context, shipmentId: string): Promise<void> {
    console.log(`⏭ Exception dismiss: shipment ${shipmentId}`);
    await ctx.answerCbQuery("Dismissed — won't re-escalate for 7 days");

    const supabase = createClient();
    if (supabase) {
        await supabase.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Exception dismissed: shipment ${shipmentId}`,
            intent: "EXCEPTION_ESCALATED",
            action_taken: "dismissed",
            metadata: {
                shipmentId,
                dismissedAt: new Date().toISOString(),
                cooldownDays: 7,
            },
        });
    }

    const originalText = ctx.callbackQuery && ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
        ? ctx.callbackQuery.message.text
        : "";

    await ctx.editMessageText(
        originalText + `\n\n⏭ *Dismissed.* Won't re-escalate for 7 days.`,
        { parse_mode: "Markdown" },
    );
}

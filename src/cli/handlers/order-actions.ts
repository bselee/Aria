/**
 * @file    order-actions.ts
 * @purpose Telegram callback handlers for browser-based vendor ordering:
 *          order_approve_{poNumber} — Bill approves the cart, marks PO ordered
 *          order_abandon_{poNumber} — Bill abandons the cart
 *
 * @author  Hermia
 * @created 2026-05-28
 */

import type { Context } from "telegraf";
import { createClient } from "../../lib/supabase";

export async function handleOrderApprove(ctx: Context, poNumber: string): Promise<void> {
    console.log(`✅ Order approve tapped: PO ${poNumber}`);
    await ctx.answerCbQuery("Marking order as placed...");

    const supabase = createClient();
    if (!supabase) {
        await ctx.editMessageText("❌ Database unavailable");
        return;
    }

    try {
        await supabase.from("purchase_orders").update({
            lifecycle_stage: "ordered_browser",
            po_order_placed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        }).eq("po_number", poNumber);

        await supabase.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Order approved: PO ${poNumber}`,
            intent: "BROWSER_ORDER_APPROVED",
            action_taken: "Bill approved browser cart via Telegram",
            metadata: { poNumber, approvedAt: new Date().toISOString() },
        });

        const originalText = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : "";

        await ctx.editMessageText(
            originalText + `\n\n✅ *Order approved.* Complete checkout in the browser.`,
            { parse_mode: "Markdown" },
        );
    } catch (err: any) {
        await ctx.editMessageText(`❌ Failed: ${err.message}`);
    }
}

export async function handleOrderAbandon(ctx: Context, poNumber: string): Promise<void> {
    console.log(`❌ Order abandon tapped: PO ${poNumber}`);
    await ctx.answerCbQuery("Cart abandoned");

    const supabase = createClient();
    if (!supabase) {
        await ctx.editMessageText("❌ Database unavailable");
        return;
    }

    try {
        await supabase.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Order abandoned: PO ${poNumber}`,
            intent: "BROWSER_ORDER_ABANDONED",
            action_taken: "Bill abandoned browser cart via Telegram",
            metadata: { poNumber, abandonedAt: new Date().toISOString() },
        });

        const originalText = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : "";

        await ctx.editMessageText(
            originalText + `\n\n❌ *Cart abandoned.* PO remains committed for manual ordering.`,
            { parse_mode: "Markdown" },
        );
    } catch (err: any) {
        await ctx.editMessageText(`❌ Failed: ${err.message}`);
    }
}

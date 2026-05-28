/**
 * @file    escalation-actions.ts
 * @purpose Handles inline callback actions for L3 vendor escalation:
 *          escalation_replace_{poNumber} and escalation_draft_{poNumber}.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    telegraf, supabase
 */

import type { Context } from "telegraf";
import { createClient } from "../../lib/supabase";

/**
 * Handle 'escalation_replace_{poNumber}' — Bill wants to replace this order
 * with an alternate vendor.
 */
export async function handleEscalationReplace(ctx: Context, poNumber: string): Promise<void> {
    console.log(`🔄 Escalation replace tapped: PO ${poNumber}`);
    await ctx.answerCbQuery(`Planning replacement for PO ${poNumber}...`);

    try {
        const supabase = createClient();
        if (!supabase) {
            await ctx.editMessageText("❌ Database unavailable");
            return;
        }

        // Mark PO for replacement and flag for human review
        await supabase.from("purchase_orders").update({
            lifecycle_stage: "pending_replacement",
            needs_human_review: true,
            updated_at: new Date().toISOString(),
        }).eq("po_number", poNumber);

        // Log the decision
        await supabase.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Replace vendor: PO ${poNumber}`,
            intent: "ESCALATION_REPLACE",
            action_taken: `Bill requested vendor replacement for PO ${poNumber}`,
            metadata: {
                poNumber,
                requestedAt: new Date().toISOString(),
            },
        });

        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text
            : "";

        await ctx.editMessageText(
            originalText + `\n\n🔄 *PO ${poNumber} marked for replacement.* Check vendor scorecard for alternatives.`,
            { parse_mode: "Markdown" },
        );
    } catch (err: any) {
        await ctx.editMessageText(`❌ Failed: ${err.message}`);
    }
}

/**
 * Handle 'escalation_draft_{poNumber}' — Bill wants to draft a follow-up
 * email to the unresponsive vendor.
 */
export async function handleEscalationDraft(ctx: Context, poNumber: string): Promise<void> {
    console.log(`📝 Escalation draft tapped: PO ${poNumber}`);
    await ctx.answerCbQuery(`Drafting urgent follow-up for PO ${poNumber}...`);

    try {
        const supabase = createClient();
        if (!supabase) {
            await ctx.editMessageText("❌ Database unavailable");
            return;
        }

        // Mark for urgent follow-up
        await supabase.from("purchase_orders").update({
            lifecycle_stage: "urgent_followup_requested",
            updated_at: new Date().toISOString(),
        }).eq("po_number", poNumber);

        // Log the request
        await supabase.from("ap_activity_log").insert({
            email_from: "telegram-will",
            email_subject: `Urgent draft requested: PO ${poNumber}`,
            intent: "ESCALATION_DRAFT",
            action_taken: `Bill requested urgent follow-up draft for PO ${poNumber}`,
            metadata: {
                poNumber,
                requestedAt: new Date().toISOString(),
            },
        });

        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text
            : "";

        await ctx.editMessageText(
            originalText + `\n\n📝 *Urgent draft queued for PO ${poNumber}.* Will be generated in next follow-up cycle.`,
            { parse_mode: "Markdown" },
        );
    } catch (err: any) {
        await ctx.editMessageText(`❌ Failed: ${err.message}`);
    }
}

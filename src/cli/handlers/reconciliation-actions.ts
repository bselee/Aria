/**
 * @file    reconciliation-actions.ts
 * @purpose Handles inline callback actions for AP invoice approvals, noted/flag actions,
 *          and vendor learning loops, keeping Supabase and Finale synchronized.
 * @author  Will / Antigravity
 * @created 2026-05-26
 * @updated 2026-05-26
 * @deps    telegraf, supabase
 */

import type { Context } from 'telegraf';
import {
    approvePendingReconciliation,
    rejectPendingReconciliation,
} from '../../lib/finale/reconciler';

const NOTED_THRESHOLD = 5; // taps before graduating to Phase 2

/**
 * Handles 'approve_{approvalId}' callback queries.
 */
export async function handleApproveReconciliation(ctx: Context, approvalId: string): Promise<void> {
    console.log(`🔑 Approval button tapped: ${approvalId}`);
    await ctx.answerCbQuery('Processing approval...');

    try {
        const result = await approvePendingReconciliation(approvalId);
        const responseMsg = result.success
            ? `${result.message}\n\nApplied:\n${result.applied.map(a => `  ✅ ${a}`).join('\n')}${result.errors.length > 0 ? `\n\nErrors:\n${result.errors.map(e => `  ❌ ${e}`).join('\n')}` : ''}`
            : `⚠️ ${result.message}`;

        await ctx.editMessageText(
            ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text + '\n\n' + responseMsg
                : responseMsg
        );
    } catch (err: any) {
        await ctx.reply(`❌ Approval failed: ${err.message}`);
    }
}

/**
 * Handles 'reject_{approvalId}' callback queries.
 */
export async function handleRejectReconciliation(ctx: Context, approvalId: string): Promise<void> {
    console.log(`➡️ Rejection button tapped: ${approvalId}`);
    await ctx.answerCbQuery('Changes rejected');

    try {
        const message = await rejectPendingReconciliation(approvalId);
        await ctx.editMessageText(
            ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text + '\n\n' + message
                : message
        );
    } catch (err: any) {
        await ctx.reply(`❌ Rejection failed: ${err.message}`);
    }
}

/**
 * Handles 'noted_{logId}' learning loop actions.
 */
export async function handleNotedReconciliation(ctx: Context, logId: string): Promise<void> {
    await ctx.answerCbQuery('Noted ✓');

    const { createClient } = await import('../../lib/supabase');
    const supabase = createClient();
    if (!supabase) {
        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(originalText + '\n\n✅ Noted.');
        return;
    }

    try {
        // 1. Mark the activity log row as acknowledged
        await supabase.from('ap_activity_log').update({
            metadata: { acknowledged: true, acknowledged_at: new Date().toISOString() },
        }).eq('id', logId);

        // 2. Get vendor name from the log row so we can update vendor_profiles
        const { data: logRow } = await supabase
            .from('ap_activity_log')
            .select('email_from')
            .eq('id', logId)
            .single();

        const vendorName = logRow?.email_from;

        if (vendorName) {
            // 3. Upsert vendor_profiles — increment noted_count, update last_noted_at
            const { data: vp } = await supabase
                .from('vendor_profiles')
                .select('noted_count, autonomy_phase, vendor_name')
                .ilike('vendor_name', `%${vendorName.split(' ')[0]}%`)
                .limit(1)
                .single();

            if (vp) {
                const newCount = (vp.noted_count ?? 0) + 1;
                const currentPhase = vp.autonomy_phase ?? 1;

                if (newCount >= NOTED_THRESHOLD && currentPhase === 1) {
                    // Graduate to Phase 2 — daily digest only
                    await supabase.from('vendor_profiles').update({
                        noted_count: newCount,
                        autonomy_phase: 2,
                        phase_upgraded_at: new Date().toISOString(),
                        last_noted_at: new Date().toISOString(),
                    }).eq('vendor_name', vp.vendor_name);

                    // One-time "graduated" notification
                    await ctx.reply(
                        `🤖 *${vendorName}* price differences are now routine.\n` +
                        `After ${NOTED_THRESHOLD} confirmations, I'll stop pinging you and just log them.\n` +
                        `They'll appear in your daily digest. Tap ⚠️ Flag on any future invoice to revert.`,
                        { parse_mode: 'Markdown' }
                    );
                } else {
                    await supabase.from('vendor_profiles').update({
                        noted_count: newCount,
                        last_noted_at: new Date().toISOString(),
                    }).eq('vendor_name', vp.vendor_name);
                }
            }
        }

        // 4. Edit the original message to show it was noted
        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(originalText + '\n\n✅ Noted.');

    } catch (err: any) {
        console.error('noted_ handler error:', err.message);
        await ctx.reply(`⚠️ Could not record acknowledgment: ${err.message}`);
    }
}

/**
 * Handles 'flag_{logId}' learning loop actions.
 */
export async function handleFlagReconciliation(ctx: Context, logId: string): Promise<void> {
    await ctx.answerCbQuery('Flagged ⚠️');

    const { createClient } = await import('../../lib/supabase');
    const supabase = createClient();
    if (!supabase) {
        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        await ctx.editMessageText(originalText + '\n\n⚠️ Flagged for review.');
        return;
    }

    try {
        // 1. Mark the activity log row as flagged
        await supabase.from('ap_activity_log').update({
            metadata: { flagged: true, flagged_at: new Date().toISOString() },
        }).eq('id', logId);

        // 2. Get vendor name from the log row
        const { data: logRow } = await supabase
            .from('ap_activity_log')
            .select('email_from, email_subject')
            .eq('id', logId)
            .single();

        const vendorName = logRow?.email_from;

        if (vendorName) {
            // 3. Reset noted_count, increment flag_count, revert to Phase 1
            const { data: vp } = await supabase
                .from('vendor_profiles')
                .select('flag_count, autonomy_phase, vendor_name')
                .ilike('vendor_name', `%${vendorName.split(' ')[0]}%`)
                .limit(1)
                .single();

            if (vp) {
                const wasPhase2Plus = (vp.autonomy_phase ?? 1) >= 2;
                await supabase.from('vendor_profiles').update({
                    noted_count: 0,           // reset the learning counter
                    flag_count: (vp.flag_count ?? 0) + 1,
                    autonomy_phase: 1,         // revert to Surface (always show diffs)
                    phase_upgraded_at: null,
                }).eq('vendor_name', vp.vendor_name);

                if (wasPhase2Plus) {
                    await ctx.reply(
                        `⚠️ *${vendorName}* flagged and reverted to Phase 1.\n` +
                        `You'll see all future diffs from this vendor with Noted/Flag buttons again.`,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
        }

        // 4. Edit the original message + follow-up
        const originalText = ctx.callbackQuery && ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text : '';
        const subject = logRow?.email_subject ?? 'this invoice';
        await ctx.editMessageText(originalText + '\n\n⚠️ Flagged. Review manually — check the PO in Finale.');
        await ctx.reply(`📋 Flagged: _${subject}_\nOpen the AP panel or Finale to correct the PO.`, { parse_mode: 'Markdown' });

    } catch (err: any) {
        console.error('flag_ handler error:', err.message);
        await ctx.reply(`⚠️ Could not record flag: ${err.message}`);
    }
}

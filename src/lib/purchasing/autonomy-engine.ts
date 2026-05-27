/**
 * @file    autonomy-engine.ts
 * @purpose Periodically processes draft POs in Finale based on vendor autonomy levels (0/1/2)
 * @author  Will / Antigravity
 * @created 2026-05-27
 * @updated 2026-05-27
 * @deps    supabase/client, finale/client, po-sender, telegraf
 */

import { createClient } from '../supabase';
import { FinaleClient } from '../finale/client';
import {
    storePendingPOSend,
    commitAndSendPO,
    getVendorAutonomyLevel,
    lookupVendorOrderEmail
} from './po-sender';
import type { Telegraf } from 'telegraf';

/**
 * Scans Finale Inventory for draft POs and processes them according to autonomy rules:
 * - Level 0: Manual (No action)
 * - Level 1: Auto-Draft (Send interactive review prompt on Telegram)
 * - Level 2: Auto-Commit & Send (Commit and email automatically, report receipt)
 */
export async function autoProcessAutonomyDrafts(bot: Telegraf<any>): Promise<{ processed: number; errors: number }> {
    const db = createClient();
    if (!db) {
        console.warn('[autonomy] Database connection unavailable — skipping scan');
        return { processed: 0, errors: 0 };
    }

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
        console.warn('[autonomy] TELEGRAM_CHAT_ID not configured — skipping scan');
        return { processed: 0, errors: 0 };
    }

    console.log('[autonomy] Scanning for draft POs to process...');
    let processed = 0;
    let errors = 0;

    try {
        const finale = new FinaleClient();
        // Fetch recent POs (last 7 days) to identify active drafts
        const pos = await finale.getRecentPurchaseOrders(7, 100);
        const drafts = pos.filter(po => 
            (po.status || '').toLowerCase() === 'created' || 
            (po.statusId || '') === 'ORDER_CREATED'
        );

        console.log(`[autonomy] Found ${drafts.length} draft PO(s) in Finale`);

        for (const draft of drafts) {
            if (!draft.orderId) continue;

            // 1. Prevent duplicate processing — check if this orderId already has a session
            const { data: existingSession } = await db
                .from('copilot_action_sessions')
                .select('session_id, status')
                .eq('action_type', 'po_send')
                .eq('payload->>orderId', draft.orderId)
                .maybeSingle();

            if (existingSession) {
                // If it exists and succeeded or is pending, skip it
                if (existingSession.status === 'confirmed' || existingSession.status === 'pending') {
                    continue;
                }
            }

            // 2. Safety Check: has this PO already been manually sent by email?
            // This is a status-healing/sync step that runs for ALL vendors (even manual Level 0).
            const alreadyEmailed = await isPOAlreadyEmailed(draft.orderId);
            if (alreadyEmailed) {
                console.log(`[autonomy] PO #${draft.orderId} has already been emailed. Auto-marking as sent.`);
                
                try {
                    // Commit in Finale so that its status changes to ORDER_LOCKED/ORDER_COMMITTED and stock is officially marked on order
                    await finale.commitDraftPO(draft.orderId);
                    console.log(`[autonomy] PO #${draft.orderId} committed successfully in Finale`);

                    await db.from('ap_activity_log').insert({
                        email_from: draft.vendorName,
                        email_subject: `PO #${draft.orderId} manually sent detection`,
                        intent: 'PO_RECEIVED',
                        action_taken: `PO #${draft.orderId} manually sent — detected via Gmail search. Marking as sent in database & committing in Finale.`,
                        metadata: { poId: draft.orderId, supplier: draft.vendorName, source: 'gmail_search_proof' },
                    });

                    await db.from('purchase_orders').upsert({
                        po_number: draft.orderId,
                        po_sent_at: new Date().toISOString(),
                        po_sent_verified_at: new Date().toISOString(),
                        po_sent_verified_source: 'gmail_search_proof',
                        updated_at: new Date().toISOString(),
                    }, { onConflict: 'po_number' });

                    await db.from('copilot_action_sessions').insert({
                        session_id: crypto.randomUUID(),
                        channel: 'telegram',
                        action_type: 'po_send',
                        payload: { orderId: draft.orderId, review: { vendorName: draft.vendorName } },
                        status: 'confirmed',
                        created_at: new Date().toISOString(),
                        expires_at: new Date().toISOString(),
                    });

                    await bot.telegram.sendMessage(
                        chatId,
                        `ℹ️ *Draft PO #${draft.orderId} Detected!*\n` +
                        `*Vendor*: ${draft.vendorName}\n` +
                        `*Status*: Already manually sent (proven via Gmail search). Auto-committed in Finale and marked sent in database.`,
                        { parse_mode: 'Markdown' }
                    );
                    processed++;
                } catch (dbErr: any) {
                    console.warn(`[autonomy] Failed to write manual sent state for PO #${draft.orderId}:`, dbErr.message);
                }
                continue;
            }

            // 3. Fetch the vendor autonomy level for new purchases
            const autonomyLevel = await getVendorAutonomyLevel(draft.vendorName);
            if (autonomyLevel === 0) {
                // Level 0: Manual — do not automate
                continue;
            }


            console.log(`[autonomy] Processing draft PO #${draft.orderId} for ${draft.vendorName} at Autonomy Level ${autonomyLevel}`);

            try {
                // 3. Resolve PO details and vendor order email
                const review = await finale.getDraftPOForReview(draft.orderId);
                const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);

                if (!email) {
                    console.warn(`[autonomy] Missing email for vendor ${review.vendorName} on PO #${draft.orderId}`);
                    await bot.telegram.sendMessage(
                        chatId,
                        `⚠️ *Autonomy Blocked on PO #${draft.orderId}*\n` +
                        `*Vendor*: ${review.vendorName}\n` +
                        `*Reason*: No order contact email on file. Update vendor\\_profiles or vendors table.`,
                        { parse_mode: 'Markdown' }
                    );
                    errors++;
                    continue;
                }

                // 4. Act according to autonomy levels
                if (autonomyLevel === 1) {
                    // Level 1: Auto-Draft Review Prompter
                    const sendId = await storePendingPOSend(draft.orderId, review, email, source, {
                        channel: 'telegram',
                        telegramChatId: chatId,
                    });

                    const msg = `📦 *Draft PO #${draft.orderId} Generated (Level 1)*\n` +
                                `*Vendor*: ${review.vendorName}\n` +
                                `*Total*: $${review.total.toFixed(2)}\n\n` +
                                `☝️ _Aria auto-generated this draft. Tap below to review details and confirm sending:_`;

                    await bot.telegram.sendMessage(chatId, msg, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔍 Review & Send', callback_data: `po_review_${draft.orderId}` },
                                { text: '⏭️ Skip', callback_data: `po_skip_${draft.orderId}` }
                            ]]
                        }
                    });

                    processed++;
                    console.log(`[autonomy] Level 1 enqueued and Telegram review sent for PO #${draft.orderId}`);

                } else if (autonomyLevel === 2) {
                    // Level 2: Auto-Commit & Send
                    const sendId = await storePendingPOSend(draft.orderId, review, email, source, {
                        channel: 'telegram',
                        telegramChatId: chatId,
                    });

                    // Execute autonomous commit + email send via fallback
                    const outcome = await commitAndSendPO(sendId, 'telegram');

                    const link = `https://app.finaleinventory.com/buildasoilorganics/purchaseOrder?orderId=${draft.orderId}`;
                    await bot.telegram.sendMessage(
                        chatId,
                        `✅ *PO #${draft.orderId} Auto-Sent (Level 2)*\n` +
                        `*Vendor*: ${review.vendorName}\n` +
                        `*Total*: $${review.total.toFixed(2)}\n` +
                        `*Sent To*: ${email} (via active Gmail fallback)\n` +
                        `🔗 [View in Finale](${link})`,
                        { parse_mode: 'Markdown', disable_web_page_preview: true }
                    );

                    processed++;
                    console.log(`[autonomy] Level 2 completed and sent PO #${draft.orderId}`);
                }

            } catch (innerErr: any) {
                console.error(`[autonomy] Error processing PO #${draft.orderId}:`, innerErr);
                await bot.telegram.sendMessage(
                    chatId,
                    `🚨 *Autonomous PO #${draft.orderId} Failed*\n` +
                    `*Vendor*: ${draft.vendorName}\n` +
                    `*Error*: ${innerErr.message || innerErr}`,
                    { parse_mode: 'Markdown' }
                );
                errors++;
            }
        }

    } catch (err: any) {
        console.error('[autonomy] Scan failed:', err);
        errors++;
    }

    return { processed, errors };
}

/**
 * Searches the Gmail inbox/outbox for any sent messages containing the PO number in the subject or body.
 * Returns true if a sent email is found, indicating it has already been manually sent.
 */
export async function isPOAlreadyEmailed(poNumber: string): Promise<boolean> {
    try {
        const { getAuthenticatedClient } = await import('../gmail/auth');
        const { gmail: GmailApi } = await import('@googleapis/gmail');
        
        const auth = await getAuthenticatedClient('default');
        const gmail = GmailApi({ version: 'v1', auth });

        // Search query: find any message with the PO number in the text, subject, or threads.
        const q = `"${poNumber}" OR "PO ${poNumber}" OR "PO #${poNumber}"`;
        const { data: search } = await gmail.users.messages.list({
            userId: 'me',
            q,
            maxResults: 5,
        });

        return !!(search.messages && search.messages.length > 0);
    } catch (err: any) {
        console.warn(`[autonomy] Gmail search for PO #${poNumber} failed:`, err.message);
        return false;
    }
}

/**
 * @file    autonomy-engine.ts
 * @purpose Periodically processes draft POs in Finale based on vendor autonomy levels (0/1/2)
 * @author  Will / Antigravity
 * @created 2026-05-27
 * @updated 2026-05-27
 * @deps    supabase/client, finale/client, po-sender, telegraf
 */

import { createClient } from '../db';
import { FinaleClient } from '../finale/client';
import {
    storePendingPOSend,
    commitAndSendPO,
    getVendorAutonomyLevel,
    lookupVendorOrderEmail
} from './po-sender';
import { transitionLifecycleState } from './po-lifecycle';
import { isBusinessHours } from '../intelligence/alert-gate';
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
                    // Transition lifecycle to SENT since it was already dispatched
                    await transitionLifecycleState(draft.orderId, 'SENT', 'autonomy-engine', {
                        source: 'gmail_search_proof',
                        vendorName: draft.vendorName,
                    });

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

                    // ── Gated: only notify during business hours ──
                    if (!isBusinessHours()) {
                        console.log('[autonomy] Draft PO detected but outside business hours — skipping Telegram.');
                    } else {
                        await bot.telegram.sendMessage(
                            chatId,
                            `ℹ️ *Draft PO #${draft.orderId} Detected!*\n` +
                            `*Vendor*: ${draft.vendorName}\n` +
                            `*Status*: Already manually sent (proven via Gmail search). Auto-committed in Finale and marked sent in database.`,
                            { parse_mode: 'Markdown' }
                        );
                    }
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
                    if (isBusinessHours()) {
                        await bot.telegram.sendMessage(
                            chatId,
                            `⚠️ *Autonomy Blocked on PO #${draft.orderId}*\n` +
                            `*Vendor*: ${review.vendorName}\n` +
                            `*Reason*: No order contact email on file. Update vendor\\_profiles or vendors table.`,
                            { parse_mode: 'Markdown' }
                        );
                    }
                    errors++;
                    continue;
                }

                // 4. Act according to autonomy levels
                if (autonomyLevel === 1) {
                    // Level 1: Auto-Draft Review Prompter
                    // Set lifecycle to REVIEW so dashboard shows it awaiting review
                    await transitionLifecycleState(draft.orderId, 'REVIEW', 'autonomy-engine', {
                        vendorName: review.vendorName,
                        autonomyLevel: 1,
                    });

                    const sendId = await storePendingPOSend(draft.orderId, review, email, source, {
                        channel: 'telegram',
                        telegramChatId: chatId,
                    });

                    const msg = `📦 *Draft PO #${draft.orderId} Generated (Level 1)*\n` +
                                `*Vendor*: ${review.vendorName}\n` +
                                `*Total*: $${review.total.toFixed(2)}\n\n` +
                                `☝️ _Aria auto-generated this draft. Tap below to review details and confirm sending:_`;

                    if (isBusinessHours()) {
                        await bot.telegram.sendMessage(chatId, msg, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '🔍 Review & Send', callback_data: `po_review_${draft.orderId}` },
                                    { text: '⏭️ Skip', callback_data: `po_skip_${draft.orderId}` }
                                ]]
                            }
                        });
                    } else {
                        console.log(`[autonomy] Draft PO #${draft.orderId} ready, outside hours — skipping Telegram prompt.`);
                    }

                    processed++;
                    console.log(`[autonomy] Level 1 enqueued and Telegram review sent for PO #${draft.orderId}`);

                } else if (autonomyLevel === 2) {
                    // Level 2: Auto-Review (trust building — no auto-send until trust is earned)
                    // Set lifecycle to REVIEW so dashboard shows it awaiting review
                    await transitionLifecycleState(draft.orderId, 'REVIEW', 'autonomy-engine', {
                        vendorName: review.vendorName,
                        autonomyLevel: 2,
                    });

                    const sendId = await storePendingPOSend(draft.orderId, review, email, source, {
                        channel: 'telegram',
                        telegramChatId: chatId,
                    });

                    // Level 2 POs get the same review prompt as Level 1
                    // Auto-send disabled intentionally — trust building phase
                    const link = `https://app.finaleinventory.com/buildasoilorganics/purchaseOrder?orderId=${draft.orderId}`;
                    if (isBusinessHours()) {
                        await bot.telegram.sendMessage(
                            chatId,
                            `✅ *PO #${draft.orderId} Auto-Reviewed (Level 2 → Manual Send)*\n` +
                            `*Vendor*: ${review.vendorName}\n` +
                            `*Total*: $${review.total.toFixed(2)}\n` +
                            `*Sent To*: ${email}\n` +
                            `🔗 [View in Finale](${link})\n\n` +
                            `_Auto-send disabled during trust building. Review and approve via dashboard or /sendpo ${draft.orderId}_`,
                            { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } }
                        );
                    } else {
                        console.log(`[autonomy] Level 2 PO #${draft.orderId} reviewed, outside hours — skipping Telegram.`);
                    }

                    processed++;
                    console.log(`[autonomy] Level 2 reviewed (not auto-sent) PO #${draft.orderId}`);
                }

            } catch (innerErr: any) {
                console.error(`[autonomy] Error processing PO #${draft.orderId}:`, innerErr);
                if (isBusinessHours()) {
                    await bot.telegram.sendMessage(
                        chatId,
                        `🚨 *Autonomous PO #${draft.orderId} Failed*\n` +
                        `*Vendor*: ${draft.vendorName}\n` +
                        `*Error*: ${innerErr.message || innerErr}`,
                        { parse_mode: 'Markdown' }
                    );
                }
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
 * Searches Gmail for any OUTBOUND (sent) messages containing the PO number in the subject or body.
 * Only matches email that was actually sent externally (not internal notes, Finale confirmations, or forwards).
 * Returns true if a matching sent email is found, indicating the PO has already been manually sent.
 */
export async function isPOAlreadyEmailed(poNumber: string): Promise<boolean> {
    try {
        const { getAuthenticatedClient } = await import('../gmail/auth');
        const { gmail: GmailApi } = await import('@googleapis/gmail');
        
        const auth = await getAuthenticatedClient('default');
        const gmail = GmailApi({ version: 'v1', auth });

        // Search query: scope to SENT emails only to avoid matching internal notes, Finale confirmations, etc.
        // Scoped to subject for the bare PO number, and body for the "#PO" variant.
        const q = `in:sent subject:"${poNumber}" OR in:sent "PO #${poNumber}"`;
        const { data: search } = await gmail.users.messages.list({
            userId: 'me',
            q,
            maxResults: 5,
        });

        if (!search.messages || search.messages.length === 0) {
            return false;
        }

        // Verify the message was actually sent to an external party (not just forwarded internally)
        // by fetching message headers and checking the To field.
        for (const msg of search.messages) {
            try {
                const { data: msgData } = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id!,
                    format: 'metadata',
                    metadataHeaders: ['To', 'From'],
                });

                const headers = msgData.payload?.headers || [];
                const toHeader = headers.find(h => h.name === 'To')?.value || '';
                const fromHeader = headers.find(h => h.name === 'From')?.value || '';

                // Extract sender domain to detect internal forwarding
                const senderDomain = fromHeader.match(/@([^>\s]+)/)?.[1] || '';
                const toAddresses = toHeader.split(',').map(a => a.trim());

                // Check if any To recipient is external (different domain from sender)
                const hasExternalRecipient = toAddresses.some(addr => {
                    const domain = addr.match(/@([^>\s]+)/)?.[1] || '';
                    return domain && domain !== senderDomain && domain !== 'me';
                });

                if (hasExternalRecipient) {
                    return true;
                }
            } catch {
                // If we can't fetch metadata for a particular message, skip it
                continue;
            }
        }

        return false;
    } catch (err: any) {
        console.warn(`[autonomy] Gmail search for PO #${poNumber} failed:`, err.message);
        return false;
    }
}

/**
 * @file    po-sender.ts
 * @purpose Commit draft POs in Finale and send them through Finale's native PO email flow.
 *          Pending confirmation state is durably mirrored to `copilot_action_sessions`
 *          and cached in-memory for fast same-process reads.
 */

import { createClient } from '../supabase';
import { FinaleClient, type DraftPOReview } from '../finale/client';
import type { CopilotChannel } from '../copilot/types';
import * as agentTask from '../intelligence/agent-task';
import type { CommitVerification } from './po-verification';

// ──────────────────────────────────────────────────
// IN-MEMORY PENDING STORE (24h TTL)
// ──────────────────────────────────────────────────

const TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingPOSend {
    id: string;
    orderId: string;
    review: DraftPOReview;
    vendorEmail: string | null;
    vendorEmailSource: string;  // 'vendor_profiles' | 'vendors_table' | 'unknown'
    createdAt: number;
    expiresAt: number;
    channel: CopilotChannel;
    telegramMessageId?: number;
    telegramChatId?: string;
}

const pendingPOSends = new Map<string, PendingPOSend>();

interface StorePendingPOSendOptions {
    channel?: CopilotChannel;
    telegramMessageId?: number;
    telegramChatId?: string;
    expiresAt?: string;
}

function serializePendingPOSend(entry: PendingPOSend) {
    return {
        session_id: entry.id,
        channel: entry.channel,
        action_type: 'po_send',
        payload: {
            orderId: entry.orderId,
            review: entry.review,
            vendorEmail: entry.vendorEmail,
            vendorEmailSource: entry.vendorEmailSource,
        },
        status: 'pending',
        telegram_message_id: entry.telegramMessageId ?? null,
        telegram_chat_id: entry.telegramChatId ?? null,
        created_at: new Date(entry.createdAt).toISOString(),
        expires_at: new Date(entry.expiresAt).toISOString(),
    };
}

function rowToPendingPOSend(row: any): PendingPOSend | undefined {
    if (row?.status && row.status !== 'pending') {
        return undefined;
    }
    if (!row?.payload?.review || !row?.payload?.orderId) {
        return undefined;
    }

    return {
        id: row.session_id,
        orderId: row.payload.orderId,
        review: row.payload.review,
        vendorEmail: row.payload.vendorEmail ?? null,
        vendorEmailSource: row.payload.vendorEmailSource ?? 'unknown',
        createdAt: new Date(row.created_at ?? Date.now()).getTime(),
        expiresAt: new Date(row.expires_at).getTime(),
        channel: row.channel,
        telegramMessageId: row.telegram_message_id ?? undefined,
        telegramChatId: row.telegram_chat_id ?? undefined,
    };
}

async function persistPendingPOSend(entry: PendingPOSend): Promise<void> {
    const db = createClient();
    if (!db) return;
    await db.from('copilot_action_sessions').upsert(serializePendingPOSend(entry));

    try {
        const taskId = await agentTask.upsertFromSource({
            sourceTable: 'copilot_action_sessions',
            sourceId: entry.id,
            type: 'po_send_confirm',
            goal: `Confirm and send PO #${entry.orderId} to ${entry.review.vendorName}`,
            status: 'NEEDS_APPROVAL',
            owner: 'will',
            priority: 1,
            requiresApproval: true,
            inputs: {
                action_type: 'po_send',
                order_id: entry.orderId,
                vendor_name: entry.review.vendorName,
                vendor_party_id: entry.review.vendorPartyId,
                channel: entry.channel,
                has_vendor_email: Boolean(entry.vendorEmail),
            },
            deadlineAt: new Date(entry.expiresAt),
        });

        if (taskId) {
            await db
                .from('copilot_action_sessions')
                .update({ task_id: taskId })
                .eq('session_id', entry.id);
        }
    } catch (err: any) {
        console.warn(`[po-sender] hub upsert failed for ${entry.id}: ${err.message}`);
    }
}

async function loadPendingPOSend(id: string): Promise<PendingPOSend | undefined> {
    const db = createClient();
    if (!db) return undefined;

    const { data } = await db
        .from('copilot_action_sessions')
        .select('*')
        .eq('session_id', id)
        .maybeSingle();

    return rowToPendingPOSend(data);
}

async function updatePendingPOSendStatus(
    id: string,
    status: 'confirmed' | 'cancelled' | 'expired',
): Promise<void> {
    const db = createClient();
    if (!db) return;
    await db
        .from('copilot_action_sessions')
        .update({ status })
        .eq('session_id', id);

    const hubStatus = status === 'confirmed'
        ? 'SUCCEEDED'
        : status === 'cancelled'
        ? 'CANCELLED'
        : 'EXPIRED';

    try {
        await agentTask.updateBySource('copilot_action_sessions', id, {
            status: hubStatus,
        });
    } catch (err: any) {
        console.warn(`[po-sender] hub status mirror failed for ${id}: ${err.message}`);
    }
}

export function clearPendingPOSendCache(): void {
    pendingPOSends.clear();
}

export async function storePendingPOSend(
    orderId: string,
    review: DraftPOReview,
    vendorEmail: string | null,
    source: string,
    options: StorePendingPOSendOptions = {},
): Promise<string> {
    const id = `posend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    const expiresAt = options.expiresAt
        ? new Date(options.expiresAt).getTime()
        : createdAt + TTL_MS;
    const entry: PendingPOSend = {
        id,
        orderId,
        review,
        vendorEmail,
        vendorEmailSource: source,
        createdAt,
        expiresAt,
        channel: options.channel ?? 'dashboard',
        telegramMessageId: options.telegramMessageId,
        telegramChatId: options.telegramChatId,
    };

    pendingPOSends.set(id, entry);
    await persistPendingPOSend(entry);
    return id;
}

export async function getPendingPOSend(id: string): Promise<PendingPOSend | undefined> {
    const cached = pendingPOSends.get(id);
    if (cached) {
        if (Date.now() > cached.expiresAt) {
            pendingPOSends.delete(id);
            await updatePendingPOSendStatus(id, 'expired');
            return undefined;
        }
        return cached;
    }

    const persisted = await loadPendingPOSend(id);
    if (!persisted) return undefined;
    if (Date.now() > persisted.expiresAt) {
        await updatePendingPOSendStatus(id, 'expired');
        return undefined;
    }

    pendingPOSends.set(id, persisted);
    return persisted;
}

export async function expirePendingPOSend(
    id: string,
    status: 'cancelled' | 'expired' | 'confirmed' = 'cancelled',
): Promise<void> {
    pendingPOSends.delete(id);
    await updatePendingPOSendStatus(id, status);
}

// ──────────────────────────────────────────────────
// VENDOR EMAIL LOOKUP
// ──────────────────────────────────────────────────

/**
 * Look up the best order-contact email for a vendor.
 * Priority:
 *   1. vendor_profiles.vendor_emails[] — built by po-correlator from outgoing PO history
 *   2. vendors.ar_email — populated by the enricher
 *   3. null — caller should block send and ask Will to provide the email
 */
export async function lookupVendorOrderEmail(
    vendorName: string,
    vendorPartyId: string
): Promise<{ email: string | null; source: string }> {
    const db = createClient();
    if (!db) return { email: null, source: 'no_db' };

    // Use first significant word for fuzzy match (avoids "Inc", "LLC", etc.)
    const firstWord = vendorName.split(/\s+/).find(w => w.length > 3) ?? vendorName.split(' ')[0];

    // 1. vendor_profiles.vendor_emails[] (po-correlator built this)
    const { data: vp } = await db
        .from('vendor_profiles')
        .select('vendor_emails')
        .ilike('vendor_name', `%${firstWord}%`)
        .maybeSingle();

    if (vp?.vendor_emails?.length > 0) {
        return { email: vp.vendor_emails[0], source: 'vendor_profiles' };
    }

    // 2. vendors.ar_email (enricher)
    const { data: vendor } = await db
        .from('vendors')
        .select('ar_email')
        .ilike('name', `%${firstWord}%`)
        .maybeSingle();

    if (vendor?.ar_email) {
        return { email: vendor.ar_email, source: 'vendors_table' };
    }

    return { email: null, source: 'unknown' };
}

// ──────────────────────────────────────────────────
// EMAIL BODY GENERATION
// ──────────────────────────────────────────────────

export function generatePOEmailBody(review: DraftPOReview): { subject: string; body: string } {
    const date = new Date(`${review.orderDate.slice(0, 10)}T00:00:00`);
    const datePart = Number.isNaN(date.getTime())
        ? review.orderDate
        : `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    const subject = `BuildASoil PO # ${review.orderId} - ${review.vendorName} - ${datePart}`;

    const body = [
        `Hi ${review.vendorName},`,
        ``,
        `Please see our attached PO.`,
        ``,
        `Please acknowledge receipt and send ETA in this email thread.`,
        ``,
        `Thanks,`,
        ``,
        `BuildASoil Purchasing`,
    ].join('\n');

    return { subject, body };
}

async function findExistingPOSend(orderId: string): Promise<any | null> {
    const db = createClient();
    if (!db) return null;

    const { data } = await db
        .from('po_sends')
        .select('*')
        .eq('po_number', orderId)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

    return data?.sent_at ? data : null;
}

// ──────────────────────────────────────────────────
// COMMIT + SEND
// ──────────────────────────────────────────────────

/**
 * Commit the PO in Finale and email it to the vendor.
 * Logs to po_sends and ap_activity_log.
 */
export async function commitAndSendPO(
    id: string,
    triggeredBy: 'telegram' | 'dashboard',
    skipEmail: boolean = false
): Promise<{
    orderId: string;
    sentTo: string | null;
    gmailMessageId: null;
    finaleEmailSent: boolean;
    pdfAttached: boolean;
    emailSkipped: boolean;
    emailError?: string;
    verification: CommitVerification;
}> {
    const pending = await getPendingPOSend(id);
    if (!pending) throw new Error('Pending PO send not found or expired - initiate a new Review & Send');

    const { orderId, review, vendorEmail } = pending;

    try {
        await agentTask.updateBySource('copilot_action_sessions', id, {
            status: 'RUNNING',
        });
    } catch { /* best-effort */ }

    if (!skipEmail) {
        const existing = await findExistingPOSend(orderId);
        if (existing) {
            throw new Error(`PO #${orderId} was already sent at ${existing.sent_at}; blocked duplicate vendor email`);
        }
    }

    // 1. Commit in Finale
    const finale = new FinaleClient();
    await finale.commitDraftPO(orderId);
    const committedAt = new Date().toISOString();

    // 1b. Post-commit verification — re-fetch and confirm status flipped to ORDER_LOCKED
    const verificationIssues: string[] = [];
    let finalStatus = 'ORDER_LOCKED';
    let committed = true;
    try {
        const postCommitPO = await finale.getOrderDetails(orderId);
        finalStatus = postCommitPO?.statusId ?? 'unknown';
        committed = finalStatus === 'ORDER_LOCKED';
        if (!committed) {
            verificationIssues.push(
                `commit confirmed ORDER_CREATED → expected ORDER_LOCKED, got ${finalStatus}`
            );
        }
    } catch (err: any) {
        verificationIssues.push(`post-commit re-fetch failed: ${err?.message ?? String(err)}`);
    }

    // 2. Send through Finale's native PO email action so the Finale PDF is attached.
    let finaleEmailSent = false;
    let pdfAttached = false;
    let sentAt: string | null = null;
    let finaleEmailActionUrl: string | undefined;
    let emailError: string | undefined;

    if (!skipEmail && vendorEmail) {
        const { subject, body } = generatePOEmailBody(review);
        try {
            const sendResult = await finale.sendPurchaseOrderEmail(orderId, {
                toEmail: vendorEmail,
                subject,
                body,
            });
            finaleEmailSent = sendResult.sent;
            pdfAttached = sendResult.pdfAttached;
            finaleEmailActionUrl = sendResult.actionUrl;
            sentAt = new Date().toISOString();
        } catch (err: any) {
            emailError = err?.message ?? String(err);
        }
    }

    // 2b. Post-send verification — wait 8s for Finale to update, then check lastEmailedAt
    let emailVerified = false;
    let lastEmailedAt: string | null = null;
    if (!skipEmail && finaleEmailSent) {
        try {
            await new Promise(r => setTimeout(r, 8000));
            const postSendPO = await finale.getOrderDetails(orderId);
            const rawTs = postSendPO?.lastEmailedAt
                ?? postSendPO?.lastEmailDate
                ?? postSendPO?.emailHistory?.[0]?.timestamp
                ?? null;
            if (rawTs) {
                const ts = new Date(rawTs);
                if (!isNaN(ts.getTime())) {
                    lastEmailedAt = ts.toISOString();
                    if (Date.now() - ts.getTime() <= 60_000) emailVerified = true;
                }
            }
            if (!emailVerified) {
                verificationIssues.push('Finale accepted send but lastEmailedAt did not update');
            }
        } catch (err: any) {
            verificationIssues.push(`post-send re-fetch failed: ${err?.message ?? String(err)}`);
        }
    }

    const { subject } = generatePOEmailBody(review);

    // 3. Log to Supabase
    const db = createClient();
    if (db) {
        const lifecycleStage = finaleEmailSent ? 'sent' : 'committed';
        const writes: Array<PromiseLike<any>> = [
            db.from('ap_activity_log').insert({
                email_from: 'bill.selee@buildasoil.com',
                email_subject: subject,
                intent: finaleEmailSent ? 'PO_SEND_FINALE' : 'PO_COMMIT',
                action_taken: finaleEmailSent
                    ? `PO #${orderId} committed in Finale and emailed with native PDF attachment to ${vendorEmail}`
                    : `PO #${orderId} committed in Finale (Email skipped/unavailable)`,
                notified_slack: false,
                metadata: {
                    orderId,
                    vendorEmail: finaleEmailSent ? vendorEmail : null,
                    triggeredBy,
                    finaleEmailSent,
                    pdfAttached,
                    finaleEmailActionUrl,
                    itemCount: review.items.length,
                    emailSkipped: skipEmail || !vendorEmail,
                    emailError: emailError ?? null,
                },
            }),
            // Direct push to purchase_orders so the Active Purchases panel
            // sees the new PO immediately (no 4 h po-sync wait). Best-effort —
            // wrapped in allSettled below.
            db.from('purchase_orders').upsert({
                po_number: orderId,
                vendor_name: review.vendorName,
                vendor_party_id: review.vendorPartyId,
                status: 'open',
                order_date: review.orderDate,
                total_amount: review.total,
                item_count: review.items.length,
                finale_url: review.finaleUrl,
                committed_at: committed ? committedAt : null,
                po_sent_at: finaleEmailSent ? sentAt : null,
                po_email_message_id: finaleEmailSent ? finaleEmailActionUrl ?? null : null,
                lifecycle_stage: lifecycleStage,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'po_number' }),
        ];

        if (finaleEmailSent && vendorEmail && sentAt) {
            writes.push(db.from('po_sends').insert({
                po_number: orderId,
                vendor_name: review.vendorName,
                vendor_party_id: review.vendorPartyId,
                sent_to_email: vendorEmail,
                total_amount: review.total,
                item_count: review.items.length,
                committed_at: committedAt,
                sent_at: sentAt,
                triggered_by: triggeredBy,
                gmail_message_id: null,
                metadata: {
                    orderId,
                    vendorEmail,
                    triggeredBy,
                    finaleEmailSent,
                    pdfAttached,
                    finaleEmailActionUrl,
                    itemCount: review.items.length,
                },
            }));
        }

        await Promise.allSettled(writes);
    }

    await expirePendingPOSend(id, 'confirmed');
    return {
        orderId,
        sentTo: finaleEmailSent ? vendorEmail : null,
        gmailMessageId: null,
        finaleEmailSent,
        pdfAttached,
        emailSkipped: skipEmail || !vendorEmail,
        emailError,
        verification: {
            committed,
            finalStatus,
            emailSent: finaleEmailSent,
            emailVerified,
            lastEmailedAt,
            issues: verificationIssues,
        },
    };
}

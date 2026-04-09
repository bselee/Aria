/**
 * @file    po-sender.ts
 * @purpose Commit draft POs in Finale and email them to vendors via bill.selee@buildasoil.com.
 *          Holds pending send state in-memory (24h TTL — same pattern as pendingApprovals).
 *          Lost on restart; PO draft still exists in Finale so Will can re-initiate.
 */

import { createClient } from '../supabase';
import { getAuthenticatedClient } from '../gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';
import { FinaleClient, type DraftPOReview } from '../finale/client';
import type { CopilotChannel } from '../copilot/types';
import type { EvidenceEntry, POEvidence, POLifecycleState, isValidTransition } from '../types/purchase-orders';

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
    const subject = `Purchase Order #${review.orderId} – BuildASoil`;

    const header = `  ${'SKU'.padEnd(22)} ${'Description'.padEnd(34)} ${'Qty'.padStart(8)}  ${'Unit Price'.padStart(11)}  ${'Line Total'.padStart(12)}`;
    const divider = `  ${'-'.repeat(93)}`;

    const itemRows = review.items.map(item => {
        const sku = item.productId.slice(0, 21).padEnd(22);
        const desc = item.productName.slice(0, 33).padEnd(34);
        const qty = String(item.quantity).padStart(8);
        const unit = `$${item.unitPrice.toFixed(2)}`.padStart(11);
        const total = `$${item.lineTotal.toFixed(2)}`.padStart(12);
        return `  ${sku} ${desc} ${qty}  ${unit}  ${total}`;
    }).join('\n');

    const body = [
        `BuildASoil — Purchase Order`,
        ``,
        `PO Number : ${review.orderId}`,
        `Date      : ${review.orderDate}`,
        `Vendor    : ${review.vendorName}`,
        ``,
        header,
        divider,
        itemRows,
        divider,
        `  ${'TOTAL'.padEnd(78)} $${review.total.toFixed(2).padStart(12)}`,
        ``,
        `Please confirm receipt of this purchase order and provide your estimated delivery date.`,
        ``,
        `Thank you,`,
        `BuildASoil Purchasing`,
    ].join('\n');

    return { subject, body };
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
): Promise<{ orderId: string; sentTo: string | null; gmailMessageId: string | null; emailSkipped: boolean; emailError?: string }> {
    const pending = await getPendingPOSend(id);
    if (!pending) throw new Error('Pending PO send not found or expired — initiate a new Review & Send');

    const { orderId, review, vendorEmail } = pending;

    // Persist evidence for lifecycle transitions
    const db = createClient();
    if (!db) throw new Error('Database not available');

    // Read current PO state and evidence
    const { data: poRow } = await db.from('purchase_orders')
        .select('lifecycle_state, evidence')
        .eq('po_number', orderId)
        .maybeSingle();

    const currentEvidence: POEvidence = (poRow?.evidence as POEvidence) || {};
    const currentState: POLifecycleState = (poRow?.lifecycle_state as POLifecycleState) || 'DRAFT';

    // If PO not in DB, initialize with DRAFT evidence
    if (!poRow) {
        const now = new Date().toISOString();
        currentEvidence[now] = {
            type: 'timestamp',
            event: 'DRAFT',
            timestamp: now,
            description: 'Draft PO created via commit process'
        };
        await db.from('purchase_orders').upsert({
            po_number: orderId,
            lifecycle_state: 'DRAFT',
            evidence: currentEvidence,
            vendor_name: review.vendorName,
            vendor_party_id: review.vendorPartyId,
            updated_at: now
        }, { onConflict: 'po_number' });
    }

    // Validate transition to COMMITTED
    if (!isValidTransition(currentState, 'COMMITTED')) {
        throw new Error(`Cannot commit PO #${orderId} from state '${currentState}'`);
    }

    // 1. Commit in Finale
    const finale = new FinaleClient();
    await finale.commitDraftPO(orderId);
    const committedAt = new Date().toISOString();

    // Persist committed evidence and state
    currentEvidence[committedAt] = {
        type: 'timestamp',
        event: 'COMMITTED',
        timestamp: committedAt,
        description: 'Committed in Finale'
    };
    await db.from('purchase_orders').update({
        lifecycle_state: 'COMMITTED',
        evidence: currentEvidence,
        updated_at: committedAt
    }).eq('po_number', orderId);

    // 2. Send email via bill.selee@buildasoil.com (if not skipped and email exists)
    let gmailMessageId = null;
    let sentAt = null;
    let emailError: string | undefined;

    if (!skipEmail && vendorEmail) {
        try {
            const auth = await getAuthenticatedClient('default');
            const gmail = GmailApi({ version: 'v1', auth });

            const { subject, body } = generatePOEmailBody(review);
            const mimeMessage = [
                `To: ${vendorEmail}`,
                `From: bill.selee@buildasoil.com`,
                `Subject: ${subject}`,
                `Content-Type: text/plain; charset=utf-8`,
                ``,
                body,
            ].join('\r\n');

            const sendResult = await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: Buffer.from(mimeMessage).toString('base64url') },
            });

            gmailMessageId = sendResult.data.id || '';
            sentAt = new Date().toISOString();

            // Persist sent evidence and state
            currentEvidence[sentAt] = {
                type: 'email',
                emailId: gmailMessageId,
                timestamp: sentAt,
                subject: subject,
                description: `Sent to ${vendorEmail}`
            };
            await db.from('purchase_orders').update({
                lifecycle_state: 'SENT',
                evidence: currentEvidence,
                updated_at: sentAt
            }).eq('po_number', orderId);
        } catch (err: any) {
            emailError = err.message;
        }
    }

    const { subject } = generatePOEmailBody(review);

    // 3. Log to Supabase
    const db = createClient();
    if (db) {
        await Promise.allSettled([
            db.from('po_sends').insert({
                po_number: orderId,
                vendor_name: review.vendorName,
                vendor_party_id: review.vendorPartyId,
                sent_to_email: skipEmail ? null : vendorEmail,
                total_amount: review.total,
                item_count: review.items.length,
                committed_at: committedAt,
                sent_at: sentAt,
                triggered_by: triggeredBy,
                gmail_message_id: gmailMessageId,
            }),
            db.from('ap_activity_log').insert({
                email_from: 'bill.selee@buildasoil.com',
                email_subject: subject,
                intent: 'PO_SEND',
                action_taken: emailError
                    ? `PO #${orderId} committed in Finale (Email failed: ${emailError})`
                    : skipEmail || !vendorEmail
                    ? `PO #${orderId} committed in Finale (Email skipped/unavailable)`
                    : `PO #${orderId} committed in Finale and emailed to ${vendorEmail}`,
                notified_slack: false,
                metadata: {
                    orderId,
                    vendorEmail: skipEmail ? null : vendorEmail,
                    triggeredBy,
                    gmailMessageId,
                    itemCount: review.items.length,
                    emailSkipped: skipEmail || !vendorEmail,
                    emailError,
                },
            }),
        ]);
    }

    await expirePendingPOSend(id, 'confirmed');
    return {
        orderId,
        sentTo: skipEmail ? null : vendorEmail,
        gmailMessageId,
        emailSkipped: skipEmail || !vendorEmail,
        emailError,
    };
}

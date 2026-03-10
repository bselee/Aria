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

// ──────────────────────────────────────────────────
// IN-MEMORY PENDING STORE (24h TTL)
// ──────────────────────────────────────────────────

const TTL_MS = 24 * 60 * 60 * 1000;

interface PendingPOSend {
    id: string;
    orderId: string;
    review: DraftPOReview;
    vendorEmail: string | null;
    vendorEmailSource: string;  // 'vendor_profiles' | 'vendors_table' | 'unknown'
    createdAt: number;
}

const pendingPOSends = new Map<string, PendingPOSend>();

export function storePendingPOSend(
    orderId: string,
    review: DraftPOReview,
    vendorEmail: string | null,
    source: string
): string {
    const id = `posend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingPOSends.set(id, { id, orderId, review, vendorEmail, vendorEmailSource: source, createdAt: Date.now() });
    return id;
}

export function getPendingPOSend(id: string): PendingPOSend | undefined {
    const entry = pendingPOSends.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > TTL_MS) {
        pendingPOSends.delete(id);
        return undefined;
    }
    return entry;
}

export function expirePendingPOSend(id: string): void {
    pendingPOSends.delete(id);
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
): Promise<{ orderId: string; sentTo: string | null; gmailMessageId: string | null; emailSkipped: boolean }> {
    const pending = getPendingPOSend(id);
    if (!pending) throw new Error('Pending PO send not found or expired — initiate a new Review & Send');

    const { orderId, review, vendorEmail } = pending;

    // 1. Commit in Finale
    const finale = new FinaleClient();
    await finale.commitDraftPO(orderId);
    const committedAt = new Date().toISOString();

    // 2. Send email via bill.selee@buildasoil.com (if not skipped and email exists)
    let gmailMessageId = null;
    let sentAt = null;

    if (!skipEmail && vendorEmail) {
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
                action_taken: skipEmail || !vendorEmail
                    ? `PO #${orderId} committed in Finale (Email skipped/unavailable)`
                    : `PO #${orderId} committed in Finale and emailed to ${vendorEmail}`,
                notified_slack: false,
                metadata: { orderId, vendorEmail: skipEmail ? null : vendorEmail, triggeredBy, gmailMessageId, itemCount: review.items.length, emailSkipped: skipEmail || !vendorEmail },
            }),
        ]);
    }

    expirePendingPOSend(id);
    return { orderId, sentTo: skipEmail ? null : vendorEmail, gmailMessageId, emailSkipped: skipEmail || !vendorEmail };
}

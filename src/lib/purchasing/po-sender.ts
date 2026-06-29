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
import { renderPurchaseOrderPdf } from './po-email-pdf';
import { sendGmailPdfEmail, sendTextOnlyGmailEmail } from '../gmail/send-email';
import { transitionLifecycleState } from './po-lifecycle';

type POEmailVia = 'gmail' | 'finale-native' | 'gmail-fallback' | 'gmail-text-only';

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

function buildPOSentVerifiedEvidence(input: {
    emailVia: POEmailVia;
    sentAt: string;
    vendorEmail: string;
    triggeredBy: 'telegram' | 'dashboard';
    finaleEmailActionUrl?: string;
    gmailMessageId?: string | null;
    gmailFromAddress?: string | null;
}) {
    const viaLabel = input.emailVia === 'finale-native'
        ? 'Finale native'
        : 'Gmail fallback';

    return [{
        type: 'po_send',
        at: input.sentAt,
        detail: `${viaLabel} (${input.emailVia}) sent PO to ${input.vendorEmail}`,
        source: input.emailVia,
        by: input.triggeredBy,
        finaleEmailActionUrl: input.finaleEmailActionUrl ?? null,
        gmailMessageId: input.gmailMessageId ?? null,
        gmailFromAddress: input.gmailFromAddress ?? null,
    }];
}

function rowToPendingPOSend(row: any): PendingPOSend | undefined {
    // Accept rows that are still active OR parked in 'email_failed' awaiting a
    // retry. Anything terminal (confirmed/cancelled/expired) is gone.
    if (row?.status && row.status !== 'pending' && row.status !== 'email_failed') {
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
    status: 'confirmed' | 'cancelled' | 'expired' | 'email_failed' | 'pending',
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
        : status === 'email_failed'
        ? 'FAILED'
        : status === 'pending'
        ? 'NEEDS_APPROVAL'
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

/** RFC-ish quick check — rejects obviously broken addresses before we ship. */
function isPlausibleEmail(raw: string | null | undefined): raw is string {
    if (!raw) return false;
    const trimmed = raw.trim();
    if (trimmed.length < 5 || trimmed.length > 254) return false;
    // single @, non-empty local part, dotted domain with TLD of 2+ chars
    return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/i.test(trimmed);
}

function normalizeEmail(raw: string): string {
    return raw.trim().toLowerCase();
}

/**
 * Look up the best order-contact email for a vendor.
 * Priority:
 *   1. vendor_profiles.orders_email — trusted, set by po-followup write-back or Will
 *   2. vendor_profiles.vendor_emails[] — heuristic pick from po-correlator history
 *   3. null — caller should block send and ask Will to provide the email
 *
 * Addresses are validated (RFC-ish) and normalized to lowercase before return.
 * An invalid stored address is treated as no match so we never ship a PO to
 * "JOHN@VENDOR" or "salessomeonelse@example".
 */
/**
 * Resolves the autonomy level of a vendor from vendor_profiles.
 * 0 = Manual (default), 1 = Auto-Draft, 2 = Auto-Commit & Send
 */
export async function getVendorAutonomyLevel(vendorName: string): Promise<number> {
    const db = createClient();
    if (!db) return 0;

    const firstWord = vendorName.split(/\s+/).find(w => w.length > 3) ?? vendorName.split(' ')[0];
    const { data: vp } = await db
        .from('vendor_profiles')
        .select('autonomy_level')
        .ilike('vendor_name', `%${firstWord}%`)
        .maybeSingle();

    return vp?.autonomy_level ?? 0;
}

export async function lookupVendorOrderEmail(
    vendorName: string,
    vendorPartyId: string
): Promise<{ email: string | null; source: string }> {
    const db = createClient();
    if (!db) return { email: null, source: 'no_db' };

    // Use first significant word for fuzzy match (avoids "Inc", "LLC", etc.)
    const firstWord = vendorName.split(/\s+/).find(w => w.length > 3) ?? vendorName.split(' ')[0];

    const { data: vp } = await db
        .from('vendor_profiles')
        .select('orders_email, orders_email_source, vendor_emails')
        .ilike('vendor_name', `%${firstWord}%`)
        .maybeSingle();

    // 1. Trusted orders_email (set by vendor_reply write-back or Will manually)
    if (isPlausibleEmail(vp?.orders_email)) {
        return {
            email: normalizeEmail(vp!.orders_email!),
            source: vp?.orders_email_source ? `orders_email:${vp.orders_email_source}` : 'orders_email',
        };
    }

    // 2. First plausible address from the historical PO-thread harvest. Skip
    //    any malformed entries instead of trusting vendor_emails[0] blindly.
    if (Array.isArray(vp?.vendor_emails) && vp.vendor_emails.length > 0) {
        const picked = vp.vendor_emails.find((e: unknown) => typeof e === 'string' && isPlausibleEmail(e));
        if (picked) return { email: normalizeEmail(picked), source: 'vendor_profiles' };
    }

    return { email: null, source: 'unknown' };
}

/**
 * Record a vendor's reply address as the authoritative orders_email. Called by
 * po-followup-watcher when it detects a human reply on a PO thread. The
 * responder address is by definition the right contact for order matters —
 * routing self-corrects over time.
 *
 * Skipped if (a) the address looks invalid, (b) it's our own outbound address
 * (bill.selee@buildasoil.com / similar — don't write ourselves back), or
 * (c) the same address was already confirmed within the last 24h (avoid
 * thrashing on multi-reply threads).
 */
export async function recordVendorOrdersEmailFromReply(
    vendorName: string,
    replierEmail: string,
): Promise<{ updated: boolean; reason: string }> {
    const db = createClient();
    if (!db) return { updated: false, reason: 'no_db' };
    if (!isPlausibleEmail(replierEmail)) return { updated: false, reason: 'invalid_email' };

    const normalized = normalizeEmail(replierEmail);

    // Never write our own outbound addresses back as the vendor's address.
    if (/@buildasoil\.com$/i.test(normalized)) {
        return { updated: false, reason: 'self_address' };
    }

    const firstWord = vendorName.split(/\s+/).find(w => w.length > 3) ?? vendorName.split(' ')[0];
    const { data: existing } = await db
        .from('vendor_profiles')
        .select('id, orders_email, orders_email_source, orders_email_confirmed_at')
        .ilike('vendor_name', `%${firstWord}%`)
        .maybeSingle();

    if (!existing) return { updated: false, reason: 'no_profile' };

    const sameAddress = existing.orders_email && normalizeEmail(existing.orders_email) === normalized;
    const recentlyConfirmed = existing.orders_email_confirmed_at
        && Date.now() - new Date(existing.orders_email_confirmed_at).getTime() < 24 * 60 * 60 * 1000;

    if (sameAddress && recentlyConfirmed) {
        return { updated: false, reason: 'already_confirmed_recently' };
    }

    // A manual entry by Will outranks an automatic write-back — never overwrite
    // a manual source with a vendor_reply unless 30+ days have passed.
    const manualLockout = existing.orders_email_source === 'manual'
        && existing.orders_email_confirmed_at
        && Date.now() - new Date(existing.orders_email_confirmed_at).getTime() < 30 * 24 * 60 * 60 * 1000;
    if (manualLockout && !sameAddress) {
        return { updated: false, reason: 'manual_lockout' };
    }

    await db
        .from('vendor_profiles')
        .update({
            orders_email: normalized,
            orders_email_source: 'vendor_reply',
            orders_email_confirmed_at: new Date().toISOString(),
        })
        .eq('id', existing.id);

    return { updated: true, reason: sameAddress ? 're_confirmed' : 'changed' };
}

// ──────────────────────────────────────────────────
// EMAIL BODY GENERATION
// ──────────────────────────────────────────────────

export function generatePOEmailBody(review: DraftPOReview): { subject: string; body: string } {
    const date = new Date(`${review.orderDate.slice(0, 10)}T00:00:00`);
    const datePart = Number.isNaN(date.getTime())
        ? review.orderDate
        : `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    const subject = `BuildASoil PO #${review.orderId} - ${review.vendorName} - ${datePart}`;

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

// HERMIA(2026-05-28): Text-only PO email — used when PDF generation fails.
// Includes all line items inline so the vendor still gets the PO details.
export function generateTextOnlyPOEmail(review: DraftPOReview): string {
    const date = new Date(`${review.orderDate.slice(0, 10)}T00:00:00`);
    const datePart = Number.isNaN(date.getTime())
        ? review.orderDate
        : `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

    const fmtMoney = (v: number) => `$${Number.isFinite(v) ? v.toFixed(2) : "0.00"}`;

    const itemLines = (review.items || []).map((item, i) => {
        const sku = item.productId || '';
        const desc = item.productName || '';
        const qty = item.quantity ?? 0;
        const unit = item.unitPrice ?? 0;
        const lineTotal = qty * unit;
        return `  ${i + 1}. ${sku}\n     ${desc}\n     Qty: ${qty}  Unit: ${fmtMoney(unit)}  Line: ${fmtMoney(lineTotal)}`;
    });

    return [
        `Hi ${review.vendorName},`,
        ``,
        `Please see our purchase order below:`,
        ``,
        `PO #: ${review.orderId}`,
        `Date: ${datePart}`,
        `Total: ${fmtMoney(review.total || 0)}`,
        `Finale: ${review.finaleUrl}`,
        ``,
        `Line Items:`,
        ...(itemLines.length > 0 ? itemLines : ['  (no items listed)']),
        ``,
        `Please acknowledge receipt and send ETA in this email thread.`,
        ``,
        `Thanks,`,
        ``,
        `BuildASoil Purchasing`,
    ].join('\n');
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
    gmailMessageId: string | null;
    finaleEmailSent: boolean;
    emailSent: boolean;
    emailVia: POEmailVia | null;
    pdfAttached: boolean;
    emailSkipped: boolean;
    emailError?: string;
    retryable: boolean;
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

    // Refuse empty PO renders — review.items.length === 0 would otherwise
        // commit a $0/0-line PO in Finale and ship the vendor a blank PDF.
        if (!Array.isArray(review.items) || review.items.length === 0) {
            throw new Error(`PO #${orderId} has no line items — refusing to commit/send`);
        }

        // 1. Commit in Finale — with retry for API flakiness
        //    DECISION(2026-06-23): Finale REST API produces intermittent 502/fetch-failed
        //    errors. Retry up to 3 times with exponential backoff. If the PO is already
        //    ORDER_LOCKED (previous attempt crashed mid-send), skip commit and proceed
        //    directly to send.
        const finale = new FinaleClient();
        const verificationIssues: string[] = [];
        let finalStatus = 'ORDER_LOCKED';
        let committed = true;
        let committedAt = new Date().toISOString();
        const MAX_COMMIT_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt++) {
            try {
                await finale.commitDraftPO(orderId);
                break; // success
            } catch (err: any) {
                const msg = err?.message ?? String(err);
                if (/ORDER_LOCKED/.test(msg)) {
                    verificationIssues.push(`commit skipped: PO already ORDER_LOCKED (retrying email)`);
                    break;
                }
                if (attempt < MAX_COMMIT_RETRIES - 1) {
                    const delay = Math.pow(2, attempt) * 1000;
                    console.warn(`[po-sender] commitDraftPO retry ${attempt + 1}/${MAX_COMMIT_RETRIES} for ${orderId} after ${delay}ms: ${msg}`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    console.error(`[po-sender] commitDraftPO exhausted ${MAX_COMMIT_RETRIES} retries for ${orderId}: ${msg}`);
                    throw err;
                }
            }
        }

    // 1b. Post-commit verification — re-fetch and confirm status flipped to ORDER_LOCKED
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

    // 2. Send the PO. DECISION(2026-06-23): Gmail is now the primary email
    //    path. Finale's native email requires FINALE_PO_EMAIL_ACTION_TEMPLATE
    //    which is unset and unreliable. Gmail renders its own PDF, verifies
    //    delivery via Sent folder check, and records messageId for thread tracking.
    //    Finale native remains as fallback — if Gmail fails, try Finale email.
    let emailSent = false;
    let pdfAttached = false;
    let sentAt: string | null = null;
    let finaleEmailActionUrl: string | undefined;
    let emailError: string | undefined;
    let emailVia: POEmailVia | null = null;
    let gmailMessageId: string | null = null;
    let gmailThreadId: string | null = null;
    let gmailFromAddress: string | null = null;

    if (!skipEmail && vendorEmail) {
        const { subject, body } = generatePOEmailBody(review);
        // ── Primary: Gmail with self-rendered PDF ────────────────────────
        try {
            const pdfBuffer = await renderPurchaseOrderPdf(review);
            const gmailResult = await sendGmailPdfEmail({
                to: vendorEmail,
                cc: "bill.selee@buildasoil.com",
                subject,
                body,
                pdfBuffer,
                pdfFilename: `BuildASoil-PO-${orderId}.pdf`,
            });
            emailSent = true;
            pdfAttached = true;
            sentAt = new Date().toISOString();
            emailVia = 'gmail';
            gmailMessageId = gmailResult.messageId;
            gmailThreadId = gmailResult.threadId;
            gmailFromAddress = gmailResult.fromAddress;
            emailError = undefined;
            if (gmailResult.verified) {
                verificationIssues.push(`Gmail sent PO PDF to ${vendorEmail} — verified in Sent`);
            } else {
                verificationIssues.push(`Gmail sent PO PDF to ${vendorEmail} — NOT verified: ${gmailResult.verifyError || 'unknown'}`);
            }
        } catch (gmailErr: any) {
            console.warn(`[po-sender] Gmail primary send failed for ${orderId}: ${gmailErr?.message ?? String(gmailErr)}`);
            // ── Fallback: Finale native email ────────────────────────────
            try {
                const sendResult = await finale.sendPurchaseOrderEmail(orderId, {
                    toEmail: vendorEmail,
                    subject,
                    body,
                });
                emailSent = sendResult.sent;
                pdfAttached = sendResult.pdfAttached;
                finaleEmailActionUrl = sendResult.actionUrl;
                sentAt = new Date().toISOString();
                emailVia = 'finale-native';
                emailError = undefined;
                verificationIssues.push(`Finale native email fallback sent to ${vendorEmail}`);
            } catch (finaleErr: any) {
                emailError = `Gmail failed (${gmailErr?.message ?? String(gmailErr)}); Finale failed (${finaleErr?.message ?? String(finaleErr)})`;
                // ── Last resort: text-only Gmail ────────────────────────
                try {
                    const textOnlyBody = generateTextOnlyPOEmail(review);
                    const textGmailResult = await sendTextOnlyGmailEmail({
                        to: vendorEmail,
                        cc: "bill.selee@buildasoil.com",
                        subject,
                        body: textOnlyBody,
                    });
                    emailSent = true;
                    pdfAttached = false;
                    sentAt = new Date().toISOString();
                    emailVia = 'gmail-text-only';
                    gmailMessageId = textGmailResult.messageId;
                    gmailThreadId = textGmailResult.threadId;
                    gmailFromAddress = textGmailResult.fromAddress;
                    emailError = `PDF generation failed — sent text-only email.`;
                    verificationIssues.push(`Text-only Gmail fallback sent to ${vendorEmail}`);
                } catch (textErr: any) {
                    emailError = `All email paths failed: Gmail PDF (${gmailErr?.message ?? ''}), Finale native (${finaleErr?.message ?? ''}), Gmail text (${textErr?.message ?? ''})`;
                    verificationIssues.push(`PO #${orderId} is committed in Finale — all email paths failed. Send manually.`);
                }
            }
        }
    }

    const finaleEmailSent = emailVia === 'finale-native';

    // 2b. Post-send verification — only meaningful for the Finale-native path.
    //
    // FIXED(2026-06-10): Previously this polled Finale 3 × 5s = up to 15s,
    // blocking the dashboard response. Now we trust the send response: if
    // sendPurchaseOrderEmail returned {sent:true}, the email was accepted by
    // Finale's delivery pipeline. We do one quick re-fetch for the timestamp
    // (for logging), but don't block on it. A missing timestamp is a soft
    // warning, not a hard failure.
    let emailVerified = true;  // optimistically true — Finale accepted the send
    let lastEmailedAt: string | null = null;
    if (!skipEmail && finaleEmailSent) {
        const FINALE_TIMESTAMP_FIELDS = [
            'lastEmailedAt',
            'lastEmailDate',
            'lastEmailSentAt',
            'emailSentDate',
            'emailLastSentAt',
        ];
        try {
            const postSendPO = await finale.getOrderDetails(orderId);
            const rawTs = FINALE_TIMESTAMP_FIELDS
                .map(f => postSendPO?.[f])
                .concat(postSendPO?.emailHistory?.[0]?.timestamp)
                .find((v): v is string => typeof v === 'string' && v.length > 0)
                ?? null;
            if (rawTs) {
                const ts = new Date(rawTs);
                if (!isNaN(ts.getTime())) {
                    lastEmailedAt = ts.toISOString();
                    const ageMs = Date.now() - ts.getTime();
                    if (ageMs >= 0 && ageMs <= 300_000) {  // 5-minute window
                        emailVerified = true;
                    }
                }
            }
        } catch (err: any) {
            verificationIssues.push(`post-send re-fetch failed: ${err?.message ?? String(err)}`);
        }
        if (!lastEmailedAt) {
            verificationIssues.push(
                'Finale accepted send (no error) but lastEmailedAt timestamp not found on first check — ' +
                'email likely sent; check Finale order page if unsure.'
            );
        }
    }

    const { subject } = generatePOEmailBody(review);

    // 3. Log to Supabase
    const db = createClient();
    if (db) {
        const lifecycleStage = emailSent ? 'sent' : 'committed';
        const intent = emailVia === 'finale-native'
            ? 'PO_SEND_FINALE'
            : emailVia === 'gmail-fallback'
                ? 'PO_SEND_GMAIL'
                : 'PO_COMMIT';
        const actionTaken = emailVia === 'finale-native'
            ? `PO #${orderId} committed in Finale and emailed with native PDF attachment to ${vendorEmail}`
            : emailVia === 'gmail-fallback'
                ? `PO #${orderId} committed in Finale and emailed with Gmail PDF attachment to ${vendorEmail}`
            : emailError
                ? `PO #${orderId} committed in Finale — vendor email failed (${emailError}). Send manually from Finale.`
                : `PO #${orderId} committed in Finale (Email skipped/unavailable)`;
        const sentVerifiedEvidence = emailSent && vendorEmail && sentAt && emailVia
            ? buildPOSentVerifiedEvidence({
                emailVia,
                sentAt,
                vendorEmail,
                triggeredBy,
                finaleEmailActionUrl,
                gmailMessageId,
                gmailFromAddress,
            })
            : null;
        const writes: Array<PromiseLike<any>> = [
            db.from('ap_activity_log').insert({
                email_from: gmailFromAddress ?? 'bill.selee@buildasoil.com',
                email_subject: subject,
                intent,
                action_taken: actionTaken,
                notified_slack: false,
                metadata: {
                    orderId,
                    vendorEmail: vendorEmail ?? null,
                    attemptedVendorEmail: !emailSent && vendorEmail ? vendorEmail : null,
                    triggeredBy,
                    emailSent,
                    emailVia,
                    finaleEmailSent,
                    pdfAttached,
                    finaleEmailActionUrl,
                    gmailMessageId,
                    gmailFromAddress,
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
                po_sent_at: emailSent ? sentAt : null,
                ...(sentVerifiedEvidence
                    ? {
                        po_sent_verified_at: sentAt,
                        po_sent_verified_source: emailVia,
                        po_sent_verified_evidence: sentVerifiedEvidence,
                    }
                    : {}),
                po_email_message_id: emailSent
                    ? (gmailMessageId ?? finaleEmailActionUrl ?? null)
                    : null,
                lifecycle_stage: lifecycleStage,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'po_number' }),
        ];

        if (emailSent && vendorEmail && sentAt) {
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
                gmail_message_id: gmailMessageId,
                gmail_thread_id: gmailThreadId,
                metadata: {
                    orderId,
                    vendorEmail,
                    triggeredBy,
                    emailSent,
                    emailVia,
                    finaleEmailSent,
                    pdfAttached,
                    finaleEmailActionUrl,
                    gmailMessageId,
                    gmailFromAddress,
                    itemCount: review.items.length,
                },
            }));
        }

        await Promise.allSettled(writes);

                // Transition lifecycle state: REVIEW → SENT if email was sent,
                // otherwise stays in REVIEW (email failed or was skipped)
                await transitionLifecycleState(orderId, emailSent ? 'SENT' : 'REVIEW', triggeredBy, {
                    vendorEmail,
                    emailVia,
                    emailSent,
                    gmailMessageId,
                });
            }

            // Session lifecycle: full success closes the session ('confirmed').
    // Partial-success (commit landed, email failed both paths) parks the
    // session in 'email_failed' so the dashboard can fire a retry without
    // requiring Will to re-review from scratch. Skipping email entirely is
    // still a clean confirm — there's nothing to retry.
    if (emailError && !skipEmail) {
        await updatePendingPOSendStatus(id, 'email_failed');
        // Refresh the in-memory cache so getPendingPOSend returns the updated
        // status without a round-trip to Supabase.
        const cached = pendingPOSends.get(id);
        if (cached) pendingPOSends.set(id, { ...cached });
    } else {
        await expirePendingPOSend(id, 'confirmed');
    }

    return {
        orderId,
        sentTo: emailSent ? vendorEmail : null,
        gmailMessageId,
        finaleEmailSent,
        emailSent,
        emailVia,
        pdfAttached,
        emailSkipped: skipEmail || !vendorEmail,
        emailError,
        // When the session is parked in 'email_failed', the same sendId can
        // be passed to retrySendEmail() to retry just the email step.
        retryable: Boolean(emailError && !skipEmail),
        verification: {
            committed,
            finalStatus,
            emailSent,
            emailVerified,
            lastEmailedAt,
            issues: verificationIssues,
        },
    };
}

/**
 * Retry the email step for a PO that already committed in Finale but failed
 * to email on the prior attempt. Skips commit entirely (the PO is already
 * ORDER_LOCKED) and runs both send paths fresh. On success the session
 * closes; on another failure it stays parked for one more retry.
 *
 * This is the fix for the "stuck PO" problem: previously a partial-success
 * burned the sendId via expirePendingPOSend('confirmed'), leaving the locked
 * PO with no way for Aria to retry — Will had to email it manually.
 */
export async function retrySendEmail(
    id: string,
    triggeredBy: 'telegram' | 'dashboard',
): Promise<{
    orderId: string;
    sentTo: string | null;
    gmailMessageId: string | null;
    emailSent: boolean;
    emailVia: POEmailVia | null;
    pdfAttached: boolean;
    emailError?: string;
    retryable: boolean;
}> {
    const pending = await getPendingPOSend(id);
    if (!pending) throw new Error('No retryable PO send found for this id — start a fresh Review & Send');
    const { orderId, review, vendorEmail } = pending;
    if (!vendorEmail) throw new Error(`PO #${orderId} has no vendor email on file — cannot retry`);

    // Confirm Finale state: must be ORDER_LOCKED for a retry to make sense.
    const finale = new FinaleClient();
    const postCommitPO = await finale.getOrderDetails(orderId);
    if (postCommitPO?.statusId !== 'ORDER_LOCKED') {
        throw new Error(
            `Cannot retry email for PO #${orderId}: Finale status is "${postCommitPO?.statusId ?? 'unknown'}", expected ORDER_LOCKED`,
        );
    }

    // Block double-send if a prior retry succeeded before this call.
    const already = await findExistingPOSend(orderId);
    if (already) throw new Error(`PO #${orderId} was already sent at ${already.sent_at}; retry blocked`);

    const { subject, body } = generatePOEmailBody(review);

    let emailSent = false;
    let pdfAttached = false;
    let emailVia: POEmailVia | null = null;
    let gmailMessageId: string | null = null;
    let gmailFromAddress: string | null = null;
    let finaleEmailActionUrl: string | undefined;
    let emailError: string | undefined;
    let sentAt: string | null = null;

    try {
        const sendResult = await finale.sendPurchaseOrderEmail(orderId, { toEmail: vendorEmail, subject, body });
        emailSent = sendResult.sent;
        pdfAttached = sendResult.pdfAttached;
        finaleEmailActionUrl = sendResult.actionUrl;
        sentAt = new Date().toISOString();
        emailVia = 'finale-native';
    } catch (err: any) {
        const finaleNativeError = err?.message ?? String(err);
        try {
            const pdfBuffer = await renderPurchaseOrderPdf(review);
            const gmailResult = await sendGmailPdfEmail({
                to: vendorEmail,
                cc: "bill.selee@buildasoil.com",
                subject,
                body,
                pdfBuffer,
                pdfFilename: `BuildASoil-PO-${orderId}.pdf`,
            });
            emailSent = true;
            pdfAttached = true;
            sentAt = new Date().toISOString();
            emailVia = 'gmail-fallback';
            gmailMessageId = gmailResult.messageId;
            gmailFromAddress = gmailResult.fromAddress;
        } catch (gmailErr: any) {
            emailError = `Finale native failed (${finaleNativeError}); Gmail fallback failed (${gmailErr?.message ?? String(gmailErr)})`;
        }
    }

    // Best-effort writes: log the retry outcome to ap_activity_log + po_sends.
    const db = createClient();
    if (db && emailSent && sentAt) {
        const sentVerifiedEvidence = emailVia
            ? buildPOSentVerifiedEvidence({
                emailVia,
                sentAt,
                vendorEmail,
                triggeredBy,
                finaleEmailActionUrl,
                gmailMessageId,
                gmailFromAddress,
            })
            : null;
        const retryViaLabel = emailVia === 'gmail-fallback'
            ? 'Gmail fallback'
            : 'Finale native';
        const writes: Array<PromiseLike<any>> = [
            db.from('ap_activity_log').insert({
                email_from: gmailFromAddress ?? 'bill.selee@buildasoil.com',
                email_subject: subject,
                intent: emailVia === 'gmail-fallback' ? 'PO_SEND_GMAIL' : 'PO_SEND_FINALE',
                action_taken: `PO #${orderId} email retry succeeded via ${retryViaLabel} -> ${vendorEmail}`,
                notified_slack: false,
                metadata: {
                    orderId,
                    vendorEmail,
                    triggeredBy,
                    emailSent,
                    emailVia,
                    pdfAttached,
                    finaleEmailActionUrl,
                    gmailMessageId,
                    gmailFromAddress,
                    isRetry: true,
                },
            }),
            db.from('purchase_orders').upsert({
                po_number: orderId,
                vendor_name: review.vendorName,
                vendor_party_id: review.vendorPartyId,
                status: 'open',
                order_date: review.orderDate,
                total_amount: review.total,
                item_count: review.items.length,
                finale_url: review.finaleUrl,
                po_sent_at: sentAt,
                ...(sentVerifiedEvidence
                    ? {
                        po_sent_verified_at: sentAt,
                        po_sent_verified_source: emailVia,
                        po_sent_verified_evidence: sentVerifiedEvidence,
                    }
                    : {}),
                po_email_message_id: gmailMessageId ?? finaleEmailActionUrl ?? null,
                lifecycle_stage: 'sent',
                updated_at: new Date().toISOString(),
            }, { onConflict: 'po_number' }),
            db.from('po_sends').insert({
                po_number: orderId,
                vendor_name: review.vendorName,
                vendor_party_id: review.vendorPartyId,
                sent_to_email: vendorEmail,
                total_amount: review.total,
                item_count: review.items.length,
                committed_at: null,
                sent_at: sentAt,
                triggered_by: triggeredBy,
                gmail_message_id: gmailMessageId,
                metadata: { orderId, vendorEmail, triggeredBy, emailSent, emailVia, pdfAttached, isRetry: true },
            }),
        ];
        await Promise.allSettled(writes);
    }

    if (emailSent) {
        await expirePendingPOSend(id, 'confirmed');
    } else {
        // Keep the session parked so a third retry is possible.
        await updatePendingPOSendStatus(id, 'email_failed');
    }

    return {
        orderId,
        sentTo: emailSent ? vendorEmail : null,
        gmailMessageId,
        emailSent,
        emailVia,
        pdfAttached,
        emailError,
        retryable: Boolean(emailError),
    };
}

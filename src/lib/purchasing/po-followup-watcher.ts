/**
 * @file    po-followup-watcher.ts
 * @purpose Identify vendors quiet on a recently-sent PO, check if they replied
 *          OUTSIDE the original thread, and if not, DRAFT a polite poke for
 *          Will to review and send. Never auto-sends.
 *
 * Flow per PO (sent 5-9 days ago, no ack, no tracking):
 *   1. Scan bill.selee@ inbox for recent inbound mail (~14d).
 *   2. Run vendor-reply-detector with strategies: subject_po → body_po →
 *      domain_unique. If matched, write vendor_acknowledged_at + source.
 *   3. If no match, find the original PO thread, build VendorCommContext,
 *      call VendorCommsAgent.draftFollowUp() to create a Gmail DRAFT.
 *      Set tracking_requested_at so we don't re-draft.
 *
 * Dropships excluded (memory note 2026-05-04). Window is forward-looking
 * only: POs sent ≥10 days ago are aged out and never poked — Will reviews
 * those manually via /unresponsive or the dashboard.
 */
import { createClient } from "@/lib/supabase";
import { VendorCommsAgent, type VendorCommContext } from "@/lib/intelligence/vendor-comms-agent";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { matchPOAgainstInbox, type POTarget } from "./vendor-reply-detector";
import { lookupVendorOrderEmail } from "./po-sender";

const DROPSHIP_PATTERN = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i;

// Forward-looking window: only pokes POs sent 5–9 days ago. Anything older
// stays untouched — review manually.
const WINDOW_MIN_DAYS = 5;
const WINDOW_MAX_DAYS = 9;
// Inbound scan reaches back 14d to give correlation a fair chance.
const INBOX_LOOKBACK_DAYS = 14;

export interface FollowupOutcome {
    poNumber: string;
    action:
        | 'cross_thread_match'    // vendor reply found outside PO thread → acked
        | 'l1_drafted'            // Gmail draft created for Will to review
        | 'skipped_dropship'
        | 'skipped_no_thread'
        | 'skipped_aged_out'
        | 'skipped_recent';
    reason?: string;
}

interface StalePO {
    po_number: string;
    vendor_name: string | null;
    vendor_party_id: string | null;
    po_sent_verified_at: string | null;
    vendor_acknowledged_at: string | null;
    tracking_numbers: string[] | null;
    tracking_requested_at: string | null;
    vendor_noncomm_at: string | null;
}

function daysSince(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86_400_000);
}

async function fetchRecentInbound(gmail: any): Promise<any[]> {
    const sinceDate = new Date(Date.now() - INBOX_LOOKBACK_DAYS * 86_400_000);
    const sinceStr = sinceDate.toISOString().slice(0, 10).replace(/-/g, '/');
    // Inbound = not from buildasoil.com domain. Excludes auto-replies via header check later.
    const list = await gmail.users.messages.list({
        userId: 'me',
        q: `-from:buildasoil.com after:${sinceStr}`,
        maxResults: 200,
    });
    const messages = list.data?.messages ?? [];
    const full: any[] = [];
    for (const m of messages) {
        try {
            const got = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
            if (got.data) full.push(got.data);
        } catch { /* skip individual message failures */ }
    }
    return full;
}

async function findPOThread(gmail: any, poNumber: string): Promise<{
    threadId: string; messageId: string; subject: string; sentAt: Date; vendorEmail: string | null;
} | null> {
    const digits = poNumber.replace(/^PO-?/i, '');
    // Broad search; the in-thread filter below requires a real outbound PO
    // send so we never address Will himself by mistake.
    const search = await gmail.users.messages.list({
        userId: 'me',
        q: `(subject:"PO #${digits}" OR subject:"PO ${digits}")`,
        maxResults: 10,
    });
    const msgs = search.data?.messages ?? [];
    for (const m of msgs) {
        const t = await gmail.users.threads.get({
            userId: 'me', id: m.threadId,
            format: 'metadata',
            metadataHeaders: ['Subject', 'To', 'From', 'Date', 'Message-ID'],
        });
        const allMsgs = t.data.messages ?? [];
        if (allMsgs.length === 0) continue;

        // Two outbound PO paths exist:
        //   (a) Gmail send from bill.selee@ — has SENT label; To: is often
        //       bill.selee@ with the real vendor in BCC. Vendor email must
        //       come from lookupVendorOrderEmail (caller).
        //   (b) Finale native send — From=noreply@mail.finaleinventory.com,
        //       To: is the actual vendor. No SENT label (it landed in inbox).
        let anchor: any = null;
        let toVendor: string | null = null;
        for (const msg of allMsgs) {
            const labels = msg.labelIds ?? [];
            const hs = msg.payload?.headers ?? [];
            const fromHeader = (hs.find((h: any) => h.name === 'From')?.value ?? '').toLowerCase();
            const isGmailSend = labels.includes('SENT');
            const isFinaleSend = /noreply@mail\.finaleinventory\.com/i.test(fromHeader);
            if (!isGmailSend && !isFinaleSend) continue;
            anchor = msg;
            if (isFinaleSend) {
                const toHeader = hs.find((h: any) => h.name === 'To')?.value ?? '';
                const em = toHeader.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
                if (em && !/buildasoil\.com/i.test(em[0])) toVendor = em[0];
            }
            break;
        }
        if (!anchor) continue;

        const headers = anchor.payload?.headers ?? [];
        const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '';
        if (!new RegExp(`PO[-\\s]*#?\\s*${digits}\\b`).test(subject)) continue;
        const messageIdHeader = headers.find((h: any) => h.name === 'Message-ID')?.value ?? anchor.id;

        return {
            threadId: anchor.threadId!,
            messageId: messageIdHeader,
            subject,
            sentAt: new Date(parseInt(anchor.internalDate!)),
            vendorEmail: toVendor,  // null when we need lookupVendorOrderEmail fallback
        };
    }
    return null;
}

/** Pull recent vendor email patterns from past PO threads (for domain hints). */
async function resolveVendorDomainHints(gmail: any, vendorName: string | null): Promise<string[]> {
    if (!vendorName) return [];
    const hints = new Set<string>();
    try {
        const search = await gmail.users.messages.list({
            userId: 'me',
            q: `subject:"${vendorName}" newer_than:90d`,
            maxResults: 10,
        });
        for (const m of search.data?.messages ?? []) {
            const t = await gmail.users.threads.get({
                userId: 'me', id: m.threadId, format: 'metadata', metadataHeaders: ['To', 'From'],
            });
            for (const msg of t.data.messages ?? []) {
                for (const h of msg.payload?.headers ?? []) {
                    const v = h.value || '';
                    const mEm = v.match(/[\w.+-]+@([\w-]+\.[\w.-]+)/);
                    if (mEm && !/buildasoil\.com/i.test(mEm[0])) {
                        hints.add(mEm[1].toLowerCase());
                    }
                }
            }
        }
    } catch { /* best effort */ }
    return Array.from(hints);
}

/**
 * Determine which POs are unique per vendor in the current stale set —
 * required for the domain_unique correlation strategy to be safe.
 */
function uniqueVendorPOs(stale: StalePO[]): Set<string> {
    const counts = new Map<string, number>();
    for (const p of stale) {
        const v = (p.vendor_name ?? '').toLowerCase().trim();
        if (!v) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const result = new Set<string>();
    for (const p of stale) {
        const v = (p.vendor_name ?? '').toLowerCase().trim();
        if (v && counts.get(v) === 1) result.add(p.po_number);
    }
    return result;
}

/**
 * Main entry. Pass dryRun to plan without writing/drafting.
 */
export async function runPOFollowupWatcher(opts?: { dryRun?: boolean }): Promise<FollowupOutcome[]> {
    const dryRun = opts?.dryRun ?? false;
    const supabase = createClient();
    if (!supabase) return [];

    const outcomes: FollowupOutcome[] = [];
    const cutoffMax = new Date(Date.now() - WINDOW_MIN_DAYS * 86_400_000).toISOString();
    const cutoffMin = new Date(Date.now() - WINDOW_MAX_DAYS * 86_400_000).toISOString();

    const { data: pos, error } = await supabase
        .from('purchase_orders')
        .select(
            'po_number, vendor_name, vendor_party_id, po_sent_verified_at, ' +
            'vendor_acknowledged_at, tracking_numbers, tracking_requested_at, vendor_noncomm_at'
        )
        .gte('po_sent_verified_at', cutoffMin)
        .lte('po_sent_verified_at', cutoffMax)
        .is('vendor_noncomm_at', null)
        .is('vendor_acknowledged_at', null)
        .is('tracking_requested_at', null)  // not yet drafted
        .limit(20);

    if (error) {
        console.error('[po-followup] query failed:', error.message);
        return [];
    }
    if (!pos || pos.length === 0) return outcomes;

    const filtered: StalePO[] = (pos as StalePO[]).filter(po => {
        if (po.vendor_acknowledged_at) return false;
        if (po.tracking_numbers && po.tracking_numbers.length > 0) return false;
        return true;
    });
    if (filtered.length === 0) return outcomes;

    const auth = await getAuthenticatedClient('default');
    const gmail = GmailApi({ version: 'v1', auth });
    const agent = new VendorCommsAgent(gmail);

    // Single inbox scan, applied to every candidate PO. Saves Gmail quota.
    const inbound = await fetchRecentInbound(gmail);
    const uniqueSet = uniqueVendorPOs(filtered);

    for (const po of filtered) {
        if (DROPSHIP_PATTERN.test(po.vendor_name ?? '')) {
            outcomes.push({ poNumber: po.po_number, action: 'skipped_dropship' });
            continue;
        }
        const dSent = daysSince(po.po_sent_verified_at);
        if (dSent == null || dSent < WINDOW_MIN_DAYS || dSent > WINDOW_MAX_DAYS) {
            outcomes.push({ poNumber: po.po_number, action: 'skipped_aged_out', reason: `sent ${dSent}d ago` });
            continue;
        }

        // Build vendor domain hints from past correspondence
        const domainHints = await resolveVendorDomainHints(gmail, po.vendor_name);
        const isUnique = uniqueSet.has(po.po_number);

        // Strategy: only allow domain_unique when this PO is the lone unacked
        // candidate for its vendor in the current window.
        const target: POTarget = {
            poNumber: po.po_number,
            vendorName: po.vendor_name ?? '',
            vendorDomainHints: isUnique ? domainHints : [],
            poSentAt: po.po_sent_verified_at,
        };

        const match = matchPOAgainstInbox(target, inbound);

        if (match.matched) {
            if (!dryRun) {
                await supabase.from('purchase_orders').update({
                    vendor_acknowledged_at: match.receivedAt,
                    vendor_ack_source: match.source,
                    updated_at: new Date().toISOString(),
                }).eq('po_number', po.po_number);
            }
            outcomes.push({
                poNumber: po.po_number,
                action: 'cross_thread_match',
                reason: `${match.source}: ${match.evidenceDetail} (from ${match.fromEmail})`,
            });
            continue;
        }

        // No cross-thread evidence either. Draft a polite poke for Will.
        const thread = await findPOThread(gmail, po.po_number);
        if (!thread) {
            outcomes.push({ poNumber: po.po_number, action: 'skipped_no_thread', reason: 'no outbound PO thread' });
            continue;
        }

        // Prefer the vendor email taken straight off the Finale outbound (To:),
        // fall back to lookupVendorOrderEmail (vendor_profiles → Finale party).
        let vendorEmail = thread.vendorEmail;
        let vendorEmailSource = thread.vendorEmail ? 'finale_outbound_to' : 'unknown';
        if (!vendorEmail) {
            const lookup = await lookupVendorOrderEmail(po.vendor_name ?? '', po.vendor_party_id ?? '');
            vendorEmail = lookup.email;
            vendorEmailSource = lookup.source;
        }
        if (!vendorEmail || /buildasoil\.com/i.test(vendorEmail)) {
            outcomes.push({
                poNumber: po.po_number,
                action: 'skipped_no_thread',
                reason: `no vendor email on file (source=${vendorEmailSource})`,
            });
            continue;
        }

        const ctx: VendorCommContext = {
            poNumber: po.po_number,
            vendorEmail,
            vendorName: po.vendor_name ?? '',
            subject: thread.subject,
            threadId: thread.threadId,
            messageId: thread.messageId,
            sentAt: thread.sentAt,
            hasTracking: false,
            trackingQuality: 'none',
            responseType: 'follow_up_l1',
        };

        try {
            if (!dryRun) {
                await agent.draftFollowUp(ctx, 1);
                await supabase
                    .from('purchase_orders')
                    .update({ tracking_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                    .eq('po_number', po.po_number);
            }
            outcomes.push({ poNumber: po.po_number, action: 'l1_drafted' });
        } catch (err: any) {
            console.error(`[po-followup] ${po.po_number} draft failed:`, err?.message ?? err);
        }
    }

    return outcomes;
}

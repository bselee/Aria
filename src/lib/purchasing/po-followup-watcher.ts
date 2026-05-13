/**
 * @file    po-followup-watcher.ts
 * @purpose Politely ask vendors to confirm their PO when they've been quiet.
 *
 * Runs daily. For every committed PO where we have evidence the PO was sent
 * but no acknowledgment + no tracking after N days, sends a polite in-thread
 * follow-up. Escalates L1 → L2 → marks vendor NONCOMM (Telegram alert to
 * Will so he can call).
 *
 * Dropship vendors are excluded entirely — memory note 2026-05-04: an auto
 * "thanks for the update" reply was sent to Autopot; dropships get NO email
 * from Aria, ever.
 */
import { createClient } from "@/lib/supabase";
import { VendorCommsAgent, type VendorCommContext } from "@/lib/intelligence/vendor-comms-agent";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";

// Dropship match — keep in sync with EXCLUDED_VENDOR_PATTERN in client.ts.
const DROPSHIP_PATTERN = /autopot|printful|grand.?master|\bhlg\b|horticulture lighting|evergreen|ac.?infinity/i;

const L1_AFTER_DAYS = 5;
const L2_AFTER_DAYS = 7;       // days after L1 with no reply
const NONCOMM_AFTER_DAYS = 7;  // days after L2 with no reply

interface StalePO {
    po_number: string;
    vendor_name: string | null;
    vendor_email: string | null;
    po_sent_verified_at: string | null;
    vendor_acknowledged_at: string | null;
    tracking_numbers: string[] | null;
    tracking_requested_at: string | null;
    tracking_requested_at_l2: string | null;
    vendor_noncomm_at: string | null;
}

interface Outcome {
    poNumber: string;
    action: 'l1_sent' | 'l2_sent' | 'noncomm_marked' | 'skipped_dropship' | 'skipped_no_thread' | 'skipped_recent';
    reason?: string;
}

function daysSince(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * Find the original outbound PO email thread by subject. Returns Gmail
 * threadId + the first outbound message's id, subject, sentAt — enough
 * to build VendorCommContext.
 */
async function findPOThread(gmail: any, poNumber: string): Promise<{
    threadId: string; messageId: string; subject: string; sentAt: Date; vendorEmail: string | null;
} | null> {
    const search = await gmail.users.messages.list({
        userId: 'me',
        q: `(label:PO OR subject:"BuildASoil PO #${poNumber}")`,
        maxResults: 5,
    });
    const msgs = search.data?.messages ?? [];
    for (const m of msgs) {
        const t = await gmail.users.threads.get({ userId: 'me', id: m.threadId, format: 'metadata', metadataHeaders: ['Subject', 'To', 'Date', 'Message-ID'] });
        const firstMsg = t.data.messages?.[0];
        if (!firstMsg) continue;
        const headers = firstMsg.payload?.headers ?? [];
        const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '';
        if (!new RegExp(`PO\\s*#?\\s*${poNumber}\\b`).test(subject)) continue;
        const toHeader = headers.find((h: any) => h.name === 'To')?.value ?? '';
        const messageIdHeader = headers.find((h: any) => h.name === 'Message-ID')?.value ?? firstMsg.id;
        // Extract first email from To: e.g. "Vendor <a@b.com>" or "a@b.com, c@d.com"
        const emailMatch = toHeader.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        const vendorEmail = emailMatch ? emailMatch[0] : null;
        return {
            threadId: firstMsg.threadId!,
            messageId: messageIdHeader,
            subject,
            sentAt: new Date(parseInt(firstMsg.internalDate!)),
            vendorEmail,
        };
    }
    return null;
}

/**
 * Main entry point — called from the cron job.
 */
export async function runPOFollowupWatcher(opts?: { dryRun?: boolean }): Promise<Outcome[]> {
    const dryRun = opts?.dryRun ?? false;
    const supabase = createClient();
    if (!supabase) return [];

    const outcomes: Outcome[] = [];

    // Query: POs where we sent ≥5 days ago and have no ack + no tracking AND
    // haven't been marked noncomm. Includes ones already at L1 so we can
    // promote to L2 / noncomm based on age.
    const sentBefore = new Date(Date.now() - L1_AFTER_DAYS * 86_400_000).toISOString();
    const { data: pos, error } = await supabase
        .from('purchase_orders')
        .select(
            'po_number, vendor_name, vendor_email, po_sent_verified_at, ' +
            'vendor_acknowledged_at, tracking_numbers, tracking_requested_at, ' +
            'tracking_requested_at_l2, vendor_noncomm_at'
        )
        .lte('po_sent_verified_at', sentBefore)
        .is('vendor_noncomm_at', null)
        .limit(50);

    if (error) {
        console.error('[po-followup] query failed:', error.message);
        return [];
    }

    if (!pos || pos.length === 0) {
        return outcomes;
    }

    const auth = await getAuthenticatedClient('default');
    const gmail = GmailApi({ version: 'v1', auth });
    const agent = new VendorCommsAgent(gmail);

    for (const po of pos as StalePO[]) {
        // Skip if already acknowledged or tracking landed
        if (po.vendor_acknowledged_at) continue;
        if (po.tracking_numbers && po.tracking_numbers.length > 0) continue;

        // Dropship guard — never message these vendors
        if (DROPSHIP_PATTERN.test(po.vendor_name ?? '')) {
            outcomes.push({ poNumber: po.po_number, action: 'skipped_dropship' });
            continue;
        }

        const daysSinceSent = daysSince(po.po_sent_verified_at);
        const daysSinceL1 = daysSince(po.tracking_requested_at);
        const daysSinceL2 = daysSince(po.tracking_requested_at_l2);

        // Decide which tier to fire
        let tier: 1 | 2 | 3 | 0 = 0;
        if (po.tracking_requested_at_l2 && daysSinceL2 != null && daysSinceL2 >= NONCOMM_AFTER_DAYS) {
            tier = 3; // mark noncomm
        } else if (po.tracking_requested_at && daysSinceL1 != null && daysSinceL1 >= L2_AFTER_DAYS && !po.tracking_requested_at_l2) {
            tier = 2;
        } else if (!po.tracking_requested_at && daysSinceSent != null && daysSinceSent >= L1_AFTER_DAYS) {
            tier = 1;
        } else {
            outcomes.push({ poNumber: po.po_number, action: 'skipped_recent' });
            continue;
        }

        const thread = await findPOThread(gmail, po.po_number);
        if (!thread || !thread.vendorEmail) {
            outcomes.push({ poNumber: po.po_number, action: 'skipped_no_thread', reason: 'no Gmail thread found' });
            continue;
        }

        const ctx: VendorCommContext = {
            poNumber: po.po_number,
            vendorEmail: thread.vendorEmail,
            vendorName: po.vendor_name ?? '',
            subject: thread.subject,
            threadId: thread.threadId,
            messageId: thread.messageId,
            sentAt: thread.sentAt,
            hasTracking: false,
            trackingQuality: 'none',
            responseType: tier === 1 ? 'follow_up_l1' : tier === 2 ? 'follow_up_l2' : 'escalate',
        };

        try {
            if (tier === 3) {
                if (!dryRun) await agent.markVendorNoncomm(ctx);
                outcomes.push({ poNumber: po.po_number, action: 'noncomm_marked' });
            } else {
                if (!dryRun) {
                    await agent.sendFollowUp(ctx, tier);
                    const col = tier === 1 ? 'tracking_requested_at' : 'tracking_requested_at_l2';
                    await supabase
                        .from('purchase_orders')
                        .update({ [col]: new Date().toISOString(), updated_at: new Date().toISOString() })
                        .eq('po_number', po.po_number);
                }
                outcomes.push({ poNumber: po.po_number, action: tier === 1 ? 'l1_sent' : 'l2_sent' });
            }
        } catch (err: any) {
            console.error(`[po-followup] ${po.po_number} tier=${tier} failed:`, err?.message ?? err);
        }
    }

    return outcomes;
}

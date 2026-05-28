import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { buildFollowUpEmail } from "../carriers/tracking-service";

/**
 * @file vendor-comms-agent.ts
 * @purpose Unified vendor communication handler for PO lifecycle.
 *          Handles thank you messages, clarification requests, and follow-ups.
 *          Ensures consistent, professional, human-sounding responses.
 */

export interface VendorCommContext {
    poNumber: string;
    vendorEmail: string;
    vendorName: string;
    subject: string;
    threadId: string;
    messageId: string;
    sentAt: Date;
    hasTracking: boolean;
    trackingQuality: 'clear' | 'unclear' | 'none';
    responseType: 'thank_you' | 'clarify' | 'follow_up_l1' | 'follow_up_l2' | 'escalate' | 'none';
    // HERMIA(2026-05-28): PO context for enriched follow-up drafts
    poTotalAmount?: number;
    itemCount?: number;
    lineItems?: Array<{ sku?: string; description?: string; quantity?: number; unitPrice?: number }>;
    issueDate?: string;
    requiredDate?: string;
    lifecycleStage?: string;
}

export class VendorCommsAgent {
    private gmail: any;

    constructor(gmailClient: any) {
        this.gmail = gmailClient;
    }

    static async create(): Promise<VendorCommsAgent> {
        const auth = await getAuthenticatedClient("default");
        const gmail = GmailApi({ version: "v1", auth });
        return new VendorCommsAgent(gmail);
    }

    /**
     * Send a thank you message for clear tracking received from vendor.
     */
    async sendThankYou(context: VendorCommContext): Promise<void> {
        const thankYouMessages = [
            "Got it, thanks!",
            "Appreciate the tracking, thanks!",
            "Thanks for the update!",
            "Received, thanks!",
        ];
        const msg = thankYouMessages[Math.floor(Math.random() * thankYouMessages.length)];

        const rawEmail = buildFollowUpEmail({
            to: context.vendorEmail,
            subject: `Re: ${context.subject}`,
            inReplyTo: context.messageId,
            references: context.messageId,
            body: msg,
        });

        await this.gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: Buffer.from(rawEmail).toString('base64url'),
                threadId: context.threadId,
            },
        });

        console.log(`[vendor-comms] Sent thank you to ${context.vendorEmail} for PO #${context.poNumber}`);
    }

    /**
     * Request clarification for unclear/missing tracking.
     * Leaves in inbox for human review - drafts the email.
     */
    async requestClarification(context: VendorCommContext): Promise<{ draftId: string }> {
        const clarifyMessages = [
            "Hi, thanks for the update. Could you send the tracking number or PRO/BOL again? Having trouble reading it.",
            "Hi, got your message but couldn't read the tracking info clearly. Could you resend the tracking or PRO number?",
            "Hi, thanks! Could you send the tracking number in text format? Having trouble with the attachment.",
        ];
        const msg = clarifyMessages[Math.floor(Math.random() * clarifyMessages.length)];

        const rawEmail = buildFollowUpEmail({
            to: context.vendorEmail,
            subject: `Re: ${context.subject}`,
            inReplyTo: context.messageId,
            references: context.messageId,
            body: msg,
        });

        // Create as a DRAFT in Gmail instead of sending
        const draftRes = await this.gmail.users.drafts.create({
            userId: 'me',
            requestBody: {
                message: {
                    raw: Buffer.from(rawEmail).toString('base64url'),
                    threadId: context.threadId,
                }
            }
        });

        // Mark as needing human review
        const supabase = createClient();
        await supabase.from("purchase_orders").update({
            needs_human_review: true,
            updated_at: new Date().toISOString(),
        }).eq("po_number", context.poNumber);

        console.log(`[vendor-comms] Clarification DRAFT created for PO #${context.poNumber} - draftId: ${draftRes.data.id}`);

        return {
            draftId: draftRes.data.id,
        };
    }

    /**
     * Create a follow-up email as a Gmail DRAFT (does not send). Used by the
     * po-followup-watcher so Will reviews each poke before it goes out.
     * Returns the Gmail draft ID for traceability.
     */
    async draftFollowUp(context: VendorCommContext, followUpCount: number): Promise<{ draftId: string | null }> {
        const sentDateStr = context.sentAt.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            timeZone: 'America/Denver',
        });
        const body = this.getFollowUpBody(context, sentDateStr, followUpCount);
        const rawEmail = buildFollowUpEmail({
            to: context.vendorEmail,
            subject: `Re: ${context.subject}`,
            inReplyTo: context.messageId,
            references: context.messageId,
            body,
        });
        const res = await this.gmail.users.drafts.create({
            userId: 'me',
            requestBody: {
                message: {
                    raw: Buffer.from(rawEmail).toString('base64url'),
                    threadId: context.threadId,
                },
            },
        });
        console.log(`[vendor-comms] Drafted follow-up #${followUpCount} to ${context.vendorEmail} for PO #${context.poNumber} — draftId: ${res.data.id}`);
        return { draftId: res.data.id ?? null };
    }

    /**
     * Send a follow-up email (L1 or L2 based on count).
     */
    async sendFollowUp(context: VendorCommContext, followUpCount: number): Promise<void> {
        const sentDateStr = context.sentAt.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            timeZone: 'America/Denver',
        });

        const body = this.getFollowUpBody(context, sentDateStr, followUpCount);

        const rawEmail = buildFollowUpEmail({
            to: context.vendorEmail,
            subject: `Re: ${context.subject}`,
            inReplyTo: context.messageId,
            references: context.messageId,
            body,
        });

        await this.gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: Buffer.from(rawEmail).toString('base64url'),
                threadId: context.threadId,
            },
        });

        console.log(`[vendor-comms] Sent follow-up #${followUpCount} to ${context.vendorEmail} for PO #${context.poNumber}`);
    }

    /**
     * Mark vendor as non-communicative after failed follow-ups.
     */
    async markVendorNoncomm(context: VendorCommContext): Promise<void> {
        const supabase = createClient();
        const now = new Date().toISOString();

        await supabase.from("purchase_orders").update({
            vendor_noncomm_at: now,
            tracking_unavailable_at: now,
            lifecycle_stage: 'tracking_unavailable',
            needs_human_review: true,
            updated_at: now,
        }).eq("po_number", context.poNumber);

        // Update vendor profile
        await supabase.from("vendor_profiles")
            .update({ is_noncomm: true })
            .ilike("vendor_name", context.vendorName);

        console.log(`[vendor-comms] Marked vendor ${context.vendorName} as NONCOMM for PO #${context.poNumber}`);
    }

    /**
     * Mark PO as having human reply detected - deescalate follow-ups.
     */
    async markHumanReply(context: VendorCommContext): Promise<void> {
        const supabase = createClient();
        const now = new Date().toISOString();

        await supabase.from("purchase_orders").update({
            human_reply_detected_at: now,
            needs_human_review: false,
            updated_at: now,
        }).eq("po_number", context.poNumber);

        console.log(`[vendor-comms] Human reply detected for PO #${context.poNumber} - deescalated`);
    }

    /**
     * Build an enriched follow-up body including PO context when available.
     * HERMIA(2026-05-28): Previously templates contained only PO # + date.
     * Now includes total amount, item count, expected date, and line items
     * so Bill has full context when reviewing the draft before sending.
     */
    private getFollowUpBody(context: VendorCommContext, sentDateStr: string, count: number): string {
        const { poNumber, vendorName, poTotalAmount, itemCount, lineItems, requiredDate } = context;

        // Build PO details block (only if we have meaningful context)
        const hasContext = poTotalAmount || itemCount || requiredDate || (lineItems && lineItems.length > 0);
        let detailsBlock = '';
        if (hasContext) {
            const lines: string[] = [];
            if (itemCount) lines.push(`  ${itemCount} item(s)`);
            if (poTotalAmount) lines.push(`  Total: $${poTotalAmount.toFixed(2)}`);
            if (requiredDate) {
                const reqDate = new Date(requiredDate);
                const daysOverdue = Math.floor((Date.now() - reqDate.getTime()) / 86400000);
                if (daysOverdue > 0) {
                    lines.push(`  Expected by: ${reqDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (${daysOverdue}d overdue)`);
                } else {
                    lines.push(`  Expected by: ${reqDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`);
                }
            }
            if (lineItems && lineItems.length > 0) {
                lines.push(`  ${lineItems.slice(0, 5).map(li =>
                    `- ${li.description || li.sku || 'item'}${li.quantity ? ` (qty ${li.quantity})` : ''}`
                ).join('\n  ')}`);
                if (lineItems.length > 5) lines.push(`  ... and ${lineItems.length - 5} more`);
            }
            detailsBlock = '\n\nPO Details:\n' + lines.join('\n');
        }

        const L1_TEMPLATES = [
            `Hi,\n\nFollowing up on PO #${poNumber} sent ${sentDateStr}.${detailsBlock}\n\nDo you have an expected ship date or tracking number?\n\nThanks!`,
            `Hi,\n\nChecking in on PO #${poNumber} from ${sentDateStr}.${detailsBlock}\n\nAny update on tracking or an ETA?\n\nThanks!`,
            `Hi,\n\nJust following up on PO #${poNumber} sent ${sentDateStr}.${detailsBlock}\n\nCould you share tracking or a ship date?\n\nThanks!`,
        ];

        const L2_TEMPLATES = [
            `Hi,\n\nFollowing up again on PO #${poNumber} sent ${sentDateStr}.${detailsBlock}\n\nWe need tracking or a ship date to plan receiving. Any update?\n\nThanks!`,
            `Hi,\n\nHaven't heard back on PO #${poNumber} from ${sentDateStr}.${detailsBlock}\n\nCan you confirm the status?\n\nThanks!`,
        ];

        // HERMIA(2026-05-28): L3 templates for 15+ day unresponsive vendors.
        // Firmer tone, mentions reorder risk and alternate sourcing.
        const L3_TEMPLATES = [
            `Hi,\n\nThis is our third follow-up on PO #${poNumber} sent ${sentDateStr} — now ${Math.floor((Date.now() - new Date(sentDateStr).getTime()) / 86400000)} days ago.${detailsBlock}\n\nWe have not received tracking or a ship date. This is now impacting our reorder planning.\n\nPlease confirm the order status today. If the order cannot be fulfilled, we will need to source from an alternate vendor.\n\nRegards,\nBuildASoil Purchasing`,
            `Hi,\n\nWe've followed up twice on PO #${poNumber} from ${sentDateStr} with no response.${detailsBlock}\n\nWithout tracking or a status update, we're unable to plan our receiving schedule and may need to cancel and reorder elsewhere.\n\nCan you please respond with tracking or a ship date today?\n\nRegards,\nBuildASoil Purchasing`,
        ];

        if (count >= 3) {
            return L3_TEMPLATES[(count - 3) % L3_TEMPLATES.length];
        }
        if (count >= 2) {
            return L2_TEMPLATES[(count - 2) % L2_TEMPLATES.length];
        }
        return L1_TEMPLATES[count % L1_TEMPLATES.length];
    }
}

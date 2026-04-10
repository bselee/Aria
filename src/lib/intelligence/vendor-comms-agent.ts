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
     * Leaves in inbox for human review - drafts the email but doesn't send automatically.
     */
    async requestClarification(context: VendorCommContext): Promise<{ draft: string; shouldSend: boolean }> {
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

        // Mark as needing human review
        const supabase = createClient();
        await supabase.from("purchase_orders").update({
            needs_human_review: true,
            updated_at: new Date().toISOString(),
        }).eq("po_number", context.poNumber);

        console.log(`[vendor-comms] Clarification needed for PO #${context.poNumber} - marked for human review`);

        return {
            draft: rawEmail,
            shouldSend: false, // Human reviews first
        };
    }

    /**
     * Send a follow-up email (L1 or L2 based on count).
     */
    async sendFollowUp(context: VendorCommContext, followUpCount: number): Promise<void> {
        const sentDateStr = context.sentAt.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            timeZone: 'America/Denver',
        });

        const body = this.getFollowUpBody(context.poNumber, sentDateStr, followUpCount);

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

    private getFollowUpBody(poNumber: string, sentDateStr: string, count: number): string {
        const L1_TEMPLATES = [
            `Hi,\n\nFollowing up on PO #${poNumber} sent ${sentDateStr}. Do you have an expected ship date or tracking?\n\nThanks!`,
            `Hi,\n\nChecking in on PO #${poNumber} — any update on tracking or estimated arrival?\n\nThanks!`,
            `Hi,\n\nJust wanted to check on PO #${poNumber} sent ${sentDateStr}. Tracking or ETA would be great!\n\nThanks!`,
            `Hi,\n\nFollowing up on our PO #${poNumber}. Do you have shipping info or an ETA?\n\nThanks!`,
            `Hi,\n\nPO #${poNumber} from ${sentDateStr} — do you have tracking or ship date?\n\nThanks!`,
        ];

        const L2_TEMPLATES = [
            `Hi,\n\nFollowing up again on PO #${poNumber} sent ${sentDateStr}. We really need the tracking or ship date to plan our receiving.\n\nThanks!`,
            `Hi,\n\nHaven't heard back on PO #${poNumber}. Do you have an ETA or tracking info?\n\nThanks!`,
            `Hi,\n\nChecking in again on PO #${poNumber}. Any shipping updates or tracking?\n\nThanks!`,
            `Hi,\n\nStill waiting on tracking for PO #${poNumber} from ${sentDateStr}. Can you help?\n\nThanks!`,
        ];

        if (count >= 2) {
            return L2_TEMPLATES[(count - 2) % L2_TEMPLATES.length];
        }
        return L1_TEMPLATES[count % L1_TEMPLATES.length];
    }
}

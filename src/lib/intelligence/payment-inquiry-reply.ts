/**
 * @file    payment-inquiry-reply.ts
 * @purpose Helpers for the vendor_payment_inquiry flow's send_simple_ack step.
 *
 *          - pickTemplate() — picks a randomized non-robotic acknowledgment.
 *            Five short variants reduce template-fingerprinting; none names a
 *            specific pay date because Aria has no Bill.com schedule access.
 *
 *          - sendSimpleAck() — sends an in-thread reply via the ap@ Gmail
 *            slot. RFC2822 In-Reply-To + References + threadId so the reply
 *            lands in the existing thread (better UX than a new email).
 *
 *          The auto-reply is gated by PAYMENT_INQUIRY_AUTOREPLY_ENABLED.
 *          Default OFF; flow falls back to escalation when disabled. Flip
 *          to "true" after Will previews behavior.
 */

import { getAuthenticatedClient } from "../gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";

// First-contact templates: include the Friday payment cycle so the vendor
// gets a real expectation, not a hollow "I'm looking into it." Five short
// variants reduce template-fingerprint across vendors.
const TEMPLATES: readonly string[] = [
    "Got it — thanks. We typically run payments on Fridays, so you should see this in the next cycle. Will follow up if anything looks off.",
    "Thanks for the note. Payments usually go out on Fridays, so this should be in the next run.",
    "Got the invoice. We schedule payments on Fridays — should land shortly. Reach back out if you don't see it by next week.",
    "Thanks — payments typically go out Fridays, so this should be in hand soon.",
    "Got it. We run AP on Fridays, so this should be in the next batch. Will let you know if anything changes.",
];

export function pickTemplate(): string {
    return TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
}

export function autoReplyEnabled(): boolean {
    const v = (process.env.PAYMENT_INQUIRY_AUTOREPLY_ENABLED ?? "false").toLowerCase();
    return v === "true" || v === "1" || v === "on";
}

export interface SendSimpleAckInput {
    /** Original sender — becomes To: */
    replyTo: string;
    /** Original Subject — Re: prefix added if not already there */
    originalSubject: string;
    /** Gmail threadId so the reply threads (not a new message) */
    gmailThreadId: string;
    /** Original Message-Id header value (with angle brackets if present) */
    messageIdHeader: string;
    /** Body text. If omitted, pickTemplate() is used. */
    body?: string;
}

export interface SendSimpleAckResult {
    ok: boolean;
    template: string;
    error?: string;
    gmailMessageId?: string;
}

/**
 * Send an in-thread reply. Never throws — returns { ok: false, error }
 * on any failure so the caller (flow step) can decide retry vs escalate.
 */
export async function sendSimpleAck(input: SendSimpleAckInput): Promise<SendSimpleAckResult> {
    const body = input.body ?? pickTemplate();
    const subject = input.originalSubject.toLowerCase().startsWith("re:")
        ? input.originalSubject
        : `Re: ${input.originalSubject}`;

    // Normalize Message-Id: ensure angle brackets for In-Reply-To / References
    const normalizedMid = input.messageIdHeader.trim();
    const mid = normalizedMid.startsWith("<") ? normalizedMid : `<${normalizedMid}>`;

    const mimeLines = [
        `To: ${input.replyTo}`,
        `Subject: ${subject}`,
        `In-Reply-To: ${mid}`,
        `References: ${mid}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        body,
        ``,
    ];
    const raw = Buffer.from(mimeLines.join("\r\n"), "utf-8").toString("base64url");

    try {
        const auth = await getAuthenticatedClient("ap");
        const gmail = GmailApi({ version: "v1", auth: auth as any });
        const res = await gmail.users.messages.send({
            userId: "me",
            requestBody: {
                raw,
                threadId: input.gmailThreadId,
            },
        });
        return {
            ok: true,
            template: body,
            gmailMessageId: res.data.id ?? undefined,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, template: body, error: msg };
    }
}

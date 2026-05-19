/**
 * @file    po-gmail-fallback.ts
 * @purpose Send a committed PO to a vendor via Gmail (bill.selee@buildasoil.com)
 *          with a self-rendered PDF attached. Used as a fallback when Finale's
 *          native PO email action is unavailable.
 *
 * DECISION(2026-05-19): Finale REST does not expose any email or PDF action
 * URL on the order object (verified live on PO #124832 — only edit/complete/
 * cancel exist; /pdf, /print, /email all 404). The Finale UI's "Email PO"
 * button is not reachable via the public API. Rather than block sends behind
 * an env var the user has to capture by hand from a browser network trace,
 * we render our own PO PDF and send it through Gmail. The vendor still gets
 * an email with a PDF attachment from bill.selee@buildasoil.com — the same
 * outcome the user wants.
 */

import { gmail as gmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { renderPurchaseOrderPDF } from "./po-pdf";
import type { DraftPOReview } from "../finale/client";

export interface SendPOViaGmailInput {
    review: DraftPOReview;
    toEmail: string;
    subject: string;
    body: string;
    /** "default" → bill.selee@buildasoil.com (outgoing PO inbox). */
    accountSlot?: string;
}

export interface SendPOViaGmailResult {
    sent: true;
    pdfAttached: true;
    messageId: string;
    threadId: string | null;
    via: "gmail-fallback";
    fromAddress: string | null;
}

/**
 * Send a PO to the vendor through Gmail with an attached PDF rendered from the
 * Finale draft review. Throws on any failure; caller decides how to surface it.
 */
export async function sendPOViaGmail(
    input: SendPOViaGmailInput,
): Promise<SendPOViaGmailResult> {
    const auth = await getAuthenticatedClient(input.accountSlot ?? "default");
    const gmail = gmailApi({ version: "v1", auth });

    const pdf = await renderPurchaseOrderPDF(input.review);
    const filename = `BuildASoil-PO-${input.review.orderId}.pdf`;

    const profile = await gmail.users.getProfile({ userId: "me" });
    const fromAddress = profile.data.emailAddress ?? null;

    const rawMessage = buildPOEmailMime({
        from: fromAddress,
        to: input.toEmail,
        subject: input.subject,
        body: input.body,
        pdf,
        pdfFilename: filename,
    });

    const sendResult = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: rawMessage },
    });

    const messageId = sendResult.data.id;
    if (!messageId) {
        throw new Error(`Gmail accepted send but returned no message id for PO ${input.review.orderId}`);
    }

    return {
        sent: true,
        pdfAttached: true,
        messageId,
        threadId: sendResult.data.threadId ?? null,
        via: "gmail-fallback",
        fromAddress,
    };
}

interface BuildMimeInput {
    from: string | null;
    to: string;
    subject: string;
    body: string;
    pdf: Buffer;
    pdfFilename: string;
}

/**
 * Build a multipart/mixed RFC 2045 MIME message ready for Gmail.users.messages.send.
 * Exported for unit testing — keeps the MIME assembly deterministic and reviewable.
 */
export function buildPOEmailMime(input: BuildMimeInput): string {
    const base64 = input.pdf.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
    const boundary = `b_aria_po_${Math.random().toString(36).slice(2, 12)}`;

    const headers: string[] = [];
    if (input.from) headers.push(`From: ${input.from}`);
    headers.push(`To: ${input.to}`);
    headers.push(`Subject: ${encodeMimeHeader(input.subject)}`);
    headers.push(`MIME-Version: 1.0`);
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [
        headers.join("\r\n"),
        "",
        `--${boundary}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        `Content-Transfer-Encoding: 7bit`,
        "",
        input.body,
        "",
        `--${boundary}`,
        `Content-Type: application/pdf; name="${input.pdfFilename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${input.pdfFilename}"`,
        "",
        base64,
        `--${boundary}--`,
        "",
    ];

    return Buffer.from(parts.join("\r\n"), "utf8").toString("base64url");
}

function encodeMimeHeader(value: string): string {
    // ASCII-only check — keep simple. Non-ASCII subjects use RFC 2047 encoded-word.
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(value)) return value;
    const b64 = Buffer.from(value, "utf8").toString("base64");
    return `=?UTF-8?B?${b64}?=`;
}

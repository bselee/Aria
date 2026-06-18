import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "./auth";

export interface GmailPdfEmailInput {
    to: string;
    subject: string;
    body: string;
    pdfBuffer: Buffer;
    pdfFilename: string;
    tokenName?: "default" | "ap";
}

export interface GmailPdfEmailResult {
    messageId: string | null;
    threadId: string | null;
    fromAddress: string | null;
    verified: boolean;
    verifyError?: string;
}

function encodeHeader(value: string): string {
    return value.replace(/\r?\n/g, " ").trim();
}

/**
 * After sending, wait for Gmail to index then verify the message appeared
 * in Sent with the correct PDF attachment. Returns verified=true on success.
 */
async function verifyGmailSent(gmail: any, messageId: string, pdfFilename?: string): Promise<{ verified: boolean; error?: string }> {
    try {
        await new Promise(r => setTimeout(r, 2000));
        const msg = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
            format: "full",
        });
        if (!msg.data?.payload) return { verified: false, error: "Sent message not found" };

        if (pdfFilename) {
            let found = false;
            const walk = (part: any) => {
                if (!part) return;
                if (part.filename === pdfFilename && part.mimeType === "application/pdf") found = true;
                if (part.parts) for (const sp of part.parts) walk(sp);
            };
            walk(msg.data.payload);
            if (!found) return { verified: false, error: `PDF ${pdfFilename} not found in sent message` };
        }

        return { verified: true };
    } catch (e: any) {
        return { verified: false, error: e.message };
    }
}

export async function sendGmailPdfEmail(input: GmailPdfEmailInput): Promise<GmailPdfEmailResult> {
    const auth = await getAuthenticatedClient(input.tokenName ?? "default");
    const gmail = GmailApi({ version: "v1", auth });

    let fromAddress: string | null = null;
    try {
        const profile = await gmail.users.getProfile({ userId: "me" });
        fromAddress = profile.data.emailAddress ?? null;
    } catch {
        fromAddress = null;
    }

    const boundary = `----=_AriaPO_${Date.now()}`;
    const lines = [
        ...(fromAddress ? [`From: ${encodeHeader(fromAddress)}`] : []),
        `To: ${encodeHeader(input.to)}`,
        `Subject: ${encodeHeader(input.subject)}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        input.body,
        "",
        `--${boundary}`,
        `Content-Type: application/pdf; name="${encodeHeader(input.pdfFilename)}"`,
        `Content-Disposition: attachment; filename="${encodeHeader(input.pdfFilename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        input.pdfBuffer.toString("base64"),
        `--${boundary}--`,
    ];

    const raw = Buffer.from(lines.join("\r\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    const sent = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
    });

    const messageId = sent.data.id ?? null;
    const threadId = sent.data.threadId ?? null;

    // Verify the sent message in Gmail Sent folder
    const verify = messageId ? await verifyGmailSent(gmail, messageId, input.pdfFilename) : { verified: false, error: "No message ID" };

    return {
        messageId,
        threadId,
        fromAddress,
        verified: verify.verified,
        verifyError: verify.error,
    };
}

// ──────────────────────────────────────────────────
// TEXT-ONLY EMAIL (no PDF attachment)
// ──────────────────────────────────────────────────

export interface GmailTextEmailInput {
    to: string;
    subject: string;
    body: string;
    tokenName?: "default" | "ap";
}

export interface GmailTextEmailResult {
    messageId: string | null;
    threadId: string | null;
    fromAddress: string | null;
    verified: boolean;
    verifyError?: string;
}

export async function sendTextOnlyGmailEmail(input: GmailTextEmailInput): Promise<GmailTextEmailResult> {
    const auth = await getAuthenticatedClient(input.tokenName ?? "default");
    const gmail = GmailApi({ version: "v1", auth });

    let fromAddress: string | null = null;
    try {
        const profile = await gmail.users.getProfile({ userId: "me" });
        fromAddress = profile.data.emailAddress ?? null;
    } catch {
        fromAddress = null;
    }

    const lines = [
        ...(fromAddress ? [`From: ${encodeHeader(fromAddress)}`] : []),
        `To: ${encodeHeader(input.to)}`,
        `Subject: ${encodeHeader(input.subject)}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        input.body,
    ];

    const raw = Buffer.from(lines.join("\r\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    const sent = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
    });

    const messageId = sent.data.id ?? null;
    const threadId = sent.data.threadId ?? null;

    // Verify the sent message in Gmail Sent folder
    const verify = messageId ? await verifyGmailSent(gmail, messageId) : { verified: false, error: "No message ID" };

    return {
        messageId,
        threadId,
        fromAddress,
        verified: verify.verified,
        verifyError: verify.error,
    };
}

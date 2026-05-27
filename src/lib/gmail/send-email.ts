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
}

function encodeHeader(value: string): string {
    return value.replace(/\r?\n/g, " ").trim();
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

    return {
        messageId: sent.data.id ?? null,
        threadId: sent.data.threadId ?? null,
        fromAddress,
    };
}

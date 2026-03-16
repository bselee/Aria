import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../supabase";

/**
 * @file email-ingestion.ts
 * @purpose Decoupled worker that safely polls Gmail for new unread messages,
 *          inserts them into the Supabase `email_inbox_queue` so that downstream
 *          agents can process them without duplicate Gmail API calls or race conditions.
 * @author Antigravity
 * @updated 2026-03-13 — stores full body text + pdf filenames (PO #124462 fix)
 */
/**
 * Decode base64url-encoded Gmail body data to UTF-8 string.
 */
function decodeBase64(data: string): string {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/**
 * Recursively extract plain-text body from a Gmail message payload.
 * Handles multipart/mixed, multipart/related, and nested parts.
 */
function extractFullBodyText(payload: any): string {
    const parts: string[] = [];
    if (payload?.body?.data) {
        parts.push(decodeBase64(payload.body.data));
    }
    const walkParts = (arr: any[]) => {
        for (const part of arr) {
            if (part.mimeType === "text/plain" && part.body?.data) {
                parts.push(decodeBase64(part.body.data));
            }
            if (part.parts?.length) walkParts(part.parts);
        }
    };
    if (payload?.parts) walkParts(payload.parts);
    return parts.join("\n");
}

export class EmailIngestionWorker {
    private tokenIdentifier: string;

    constructor(tokenIdentifier: string = "default") {
        this.tokenIdentifier = tokenIdentifier;
    }

    async run(maxResults: number = 50) {
        console.log(`📡 [EmailIngestionWorker] Fetching unread emails to queue...`);
        try {
            const auth = await getAuthenticatedClient(this.tokenIdentifier);
            const gmail = GmailApi({ version: "v1", auth });
            const supabase = createClient();

            // Ensure our Aria-Ingested label exists so we don't process emails multiple times
            // but we also don't archive them away from the human inbox prematurely.
            const res = await gmail.users.labels.list({ userId: "me" });
            let ingestedLabelId = res.data.labels?.find(l => l.name?.toLowerCase() === "aria-ingested")?.id;
            if (!ingestedLabelId) {
                const created = await gmail.users.labels.create({
                    userId: "me",
                    requestBody: { name: "Aria-Ingested", labelListVisibility: "labelShow", messageListVisibility: "show" }
                });
                ingestedLabelId = created.data.id!;
            }

            const { data } = await gmail.users.messages.list({
                userId: "me",
                q: `is:unread in:inbox -label:Aria-Ingested newer_than:3d`,
                maxResults
            });

            const messages = data.messages || [];
            if (messages.length === 0) {
                return;
            }

            let insertedCount = 0;

            for (const m of messages) {
                let msg: any;
                try {
                    // Fetch full message metadata and parts
                    msg = await gmail.users.messages.get({ userId: "me", id: m.id! });
                } catch (err: any) {
                    console.error(`   ❌ Failed to fetch message ${m.id}:`, err.message);
                    continue;
                }

                const payload = msg.data.payload;
                const headers = payload?.headers || [];

                // Recursively check parts for PDF and collect PDF filenames
                let hasPdf = false;
                const pdfFilenames: string[] = [];
                const walkParts = (parts: any[]) => {
                    for (const part of parts) {
                        if (part.filename && part.filename.toLowerCase().endsWith(".pdf")) {
                            hasPdf = true;
                            pdfFilenames.push(part.filename);
                        }
                        if (part.parts?.length) walkParts(part.parts);
                    }
                };
                if (payload?.parts) walkParts(payload.parts);

                const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
                const rfcMessageId = headers.find((h: any) => h.name === "Message-ID")?.value || null;
                const fromHeader = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
                const emailMatch = fromHeader.match(/<(.+?)>/);
                const fromEmail = emailMatch ? emailMatch[1] : fromHeader;

                const snippet = msg.data.snippet || "";
                const threadId = msg.data.threadId || m.id!;

                // DECISION(2026-03-13): Extract and store full body text so downstream
                // agents (AcknowledgementAgent, InlineInvoiceHandler) have complete data,
                // not just the truncated Gmail snippet (~200 chars). PO #124462 showed
                // that snippet truncation causes detection failures.
                const bodyText = extractFullBodyText(payload);

                // Insert into Supabase Queue
                const { error } = await supabase.from('email_inbox_queue').insert({
                    gmail_message_id: m.id!,
                    rfc_message_id: rfcMessageId,
                    thread_id: threadId,
                    from_email: fromEmail,
                    subject,
                    body_snippet: snippet,
                    body_text: bodyText || null,
                    pdf_filenames: pdfFilenames.length > 0 ? pdfFilenames : null,
                    has_pdf: hasPdf,
                    status: 'unprocessed',
                    source_inbox: this.tokenIdentifier
                });

                if (error && error.code !== '23505') { // Ignore unique violation if it sneaked in
                    console.error(`   ❌ Failed to insert ${m.id} to queue:`, error.message);
                } else {
                    insertedCount++;
                    // Mark as Aria-Ingested in Gmail so we skip it next run
                    await gmail.users.messages.modify({
                        userId: "me",
                        id: m.id!,
                        requestBody: { addLabelIds: [ingestedLabelId!] }
                    });
                }
            }

            if (insertedCount > 0) {
                console.log(`✅ [EmailIngestionWorker] Ingested ${insertedCount} new emails into the queue.`);
            }

        } catch (err: any) {
            console.error("❌ [EmailIngestionWorker] Critical Error:", err.message);
        }
    }
}

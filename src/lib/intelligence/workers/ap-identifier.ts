/**
 * @file   ap-identifier.ts
 * @purpose Agent 1 of the decoupled AP pipeline (The "Eyes").
 *          Scans the AP inbox for unread PDFs, classifies their intent,
 *          uploads them to Supabase Storage, and adds them to the processing queue.
 * @author  Antigravity / Aria
 */

import { google } from "googleapis";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../supabase";
import { z } from "zod";
import { unifiedObjectGeneration } from "../llm";
import { recall } from "../memory";
import { KNOWN_DROPSHIP_KEYWORDS } from "../../../config/dropship-vendors";

export class APIdentifierAgent {
    private isKnownDropshipVendor(from: string, subject: string): boolean {
        const haystack = `${from} ${subject}`.toLowerCase();
        return KNOWN_DROPSHIP_KEYWORDS.some(kw => haystack.includes(kw.toLowerCase()));
    }

    private async classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
        const schema = z.object({
            intent: z.enum(["INVOICE", "DROPSHIP_INVOICE", "STATEMENT", "ADVERTISEMENT", "HUMAN_INTERACTION"]),
        });

        // Recall rules to see if this vendor has specific handling instructions (like always being DROPSHIP)
        const memories = await recall(`Accounts Payable routing rules for vendor ${from} subject ${subject}`, { topK: 3, minScore: 0.5 });
        let memoryContext = "";
        if (memories.length > 0) {
            memoryContext = "\n\nPast Experiences & Specific Vendor Rules:\n" + memories.map(m => `- [${m.category}] ${m.content}`).join("\n");
        }

        const prompt = `Classify this AP inbox email. Reply with the single intent label only.
From: ${from}
Subject: ${subject}
Snippet: ${snippet}
${memoryContext}

INVOICE - Standard vendor bill for PO-based stock.
DROPSHIP_INVOICE - Bill for goods shipped directly to our customer (no Finale PO).
STATEMENT - Account statement or aging summary.
ADVERTISEMENT - Marketing, spam, or newsletter.
HUMAN_INTERACTION - Payment question, order issue, or anything requiring a human reply.`;

        try {
            const res = await unifiedObjectGeneration({
                system: "AP routing engine. Return the intent label only.",
                prompt,
                schema,
                schemaName: "EmailIntent"
            }) as { intent: string };

            return res.intent;
        } catch (err) {
            console.error("   Failed to classify intent, defaulting to HUMAN_INTERACTION", err);
            return "HUMAN_INTERACTION";
        }
    }

    private async getOrCreateLabel(gmail: any, labelName: string): Promise<string> {
        const res = await gmail.users.labels.list({ userId: "me" });
        const existing = res.data.labels?.find((l: any) => l.name?.toLowerCase() === labelName.toLowerCase());

        if (existing?.id) return existing.id;

        const created = await gmail.users.labels.create({
            userId: "me",
            requestBody: {
                name: labelName,
                labelListVisibility: "labelShow",
                messageListVisibility: "show"
            }
        });
        return created.data.id!;
    }

    private async logActivity(supabase: any, from: string, subject: string, intent: string, action: string, metadata: any = {}) {
        if (!supabase) return;
        try {
            await supabase.from("ap_activity_log").insert({
                email_from: from,
                email_subject: subject,
                intent,
                action_taken: action,
                metadata
            });
        } catch (e: any) {
            console.error("   ❌ Failed to log activity:", e.message);
        }
    }

    /**
     * Polls the Supabase email queue for unread AP emails, classifies them, and queues PDFs.
     */
    async identifyAndQueue() {
        console.log("🕵️‍♀️ [AP-Identifier] Scanning queue for new invoices...");
        try {
            const supabase = createClient();

            if (!supabase) {
                console.error("   ❌ Supabase client not available.");
                return;
            }

            // Cache GMail clients by tokenIdentifier to prevent recreating them on every email
            const gmailClients: Record<string, any> = {};
            const getGmailClient = async (inbox: string) => {
                if (!gmailClients[inbox]) {
                    try {
                        const auth = await getAuthenticatedClient(inbox);
                        gmailClients[inbox] = google.gmail({ version: "v1", auth });
                    } catch (e: any) {
                        console.warn(`   ⚠️ Missing '${inbox}' token, falling back to 'default' token...`);
                        const fallbackAuth = await getAuthenticatedClient("default");
                        gmailClients[inbox] = google.gmail({ version: "v1", auth: fallbackAuth });
                    }
                }
                return gmailClients[inbox];
            };

            // Read from central queue instead of making a direct Gmail API search
            const { data: messages, error } = await supabase
                .from('email_inbox_queue')
                .select('*')
                .eq('processed_by_ap', false)
                .limit(15);

            if (error) throw error;

            if (!messages || messages.length === 0) {
                return;
            }

            console.log(`   Found ${messages.length} email(s) in queue to identify.`);

            // Labels are account-scoped in Gmail — fetch and cache per source inbox
            const labelCache: Record<string, { invoiceFwd: string; statements: string; apSeen: string }> = {};
            const getLabels = async (inbox: string) => {
                if (!labelCache[inbox]) {
                    const gm = await getGmailClient(inbox);
                    labelCache[inbox] = {
                        invoiceFwd: await this.getOrCreateLabel(gm, "Invoice Forward"),
                        statements: await this.getOrCreateLabel(gm, "Statements"),
                        apSeen: await this.getOrCreateLabel(gm, "AP-Seen"),
                    };
                }
                return labelCache[inbox];
            };

            for (const m of messages) {
                const sourceInbox = m.source_inbox || "ap";
                const gmail = await getGmailClient(sourceInbox);

                // Lock row
                await supabase.from('email_inbox_queue')
                    .update({ processed_by_ap: true })
                    .eq('id', m.id);

                // Fetch full message payload from Gmail ONLY to get the PDF buffers 
                // We could skip fetching if !m.has_pdf, but we'll fetch anyway to safely apply labels.
                let msg: any;
                try {
                    msg = await gmail.users.messages.get({ userId: "me", id: m.gmail_message_id });
                } catch (fetchErr: any) {
                    const isQuota = fetchErr.code === 429 ||
                        String(fetchErr.message).toLowerCase().includes("quota") ||
                        String(fetchErr.message).toLowerCase().includes("ratelimit");
                    if (isQuota) {
                        console.warn("   ⚠️ Gmail API rate limit hit — stopping batch early.");
                        break;
                    }
                    console.error(`   ❌ Failed to fetch message payload for ${m.gmail_message_id}`);
                    continue;
                }
                const payload = msg.data.payload;

                const subject = m.subject || "No Subject";
                const from = m.from_email || "Unknown Sender";
                const snippet = m.body_snippet || "";

                console.log(`   Evaluating Email: "${subject}" from ${from}`);

                const intent = this.isKnownDropshipVendor(from, subject)
                    ? "DROPSHIP_INVOICE"
                    : await this.classifyEmailIntent(subject, from, snippet);
                console.log(`     -> Classified as: ${intent}`);

                if (intent === "ADVERTISEMENT") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] }
                        });
                        await this.logActivity(supabase, from, subject, "ADVERTISEMENT", "Archived and marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }

                if (intent === "STATEMENT") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).statements],
                                removeLabelIds: ["UNREAD"]
                            }
                        });
                        await this.logActivity(supabase, from, subject, "STATEMENT", "Labeled as Statement, marked read");
                    } catch (e) { /* ignore */ }
                    continue;
                }

                if (intent === "HUMAN_INTERACTION") {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { addLabelIds: [(await getLabels(sourceInbox)).apSeen] }
                        });
                    } catch (e) { /* ignore */ }
                    continue;
                }

                // --- INVOICE / DROPSHIP QUEUEING ---
                const isDropship = intent === "DROPSHIP_INVOICE";
                let processedAnyPDF = false;

                const pdfParts: any[] = [];
                const walkParts = (parts: any[]): void => {
                    for (const part of parts) {
                        if (part.filename && part.filename.toLowerCase().endsWith(".pdf")) {
                            pdfParts.push(part);
                        }
                        if (part.parts?.length) {
                            walkParts(part.parts);
                        }
                    }
                };
                walkParts(payload?.parts || []);

                let attachmentIndex = 0;
                for (const part of pdfParts) {
                    if (part.body?.attachmentId) {
                        try {
                            const capturedFilename = part.filename;
                            const uniqueMsgId = pdfParts.length > 1 ? `${m.gmail_message_id}_${attachmentIndex}` : m.gmail_message_id;

                            // Check if already queued
                            const { data: existing } = await supabase
                                .from("ap_inbox_queue")
                                .select("id")
                                .eq("message_id", uniqueMsgId)
                                .maybeSingle();

                            if (existing) {
                                console.log(`     ⚠️ Already queued ${capturedFilename}, skipping...`);
                                attachmentIndex++;
                                continue;
                            }

                            console.log(`     -> Downloading attachment: ${capturedFilename}`);
                            const response = await gmail.users.messages.attachments.get({
                                userId: "me",
                                messageId: m.gmail_message_id,
                                id: part.body.attachmentId
                            });

                            const attachmentData = response.data.data;
                            if (!attachmentData) continue;
                            const buffer = Buffer.from(attachmentData, "base64url");

                            // Upload to Supabase Storage
                            const storagePath = `${m.gmail_message_id}/${Date.now()}_${capturedFilename}`;
                            const { error: uploadError } = await supabase.storage
                                .from('ap_invoices')
                                .upload(storagePath, buffer, {
                                    contentType: 'application/pdf',
                                    upsert: true
                                });

                            if (uploadError) {
                                throw new Error(`Storage upload failed: ${uploadError.message}`);
                            }

                            // Insert into Queue
                            const queueStatus = isDropship ? 'PENDING_FORWARD' : 'PENDING_EXTRACTION';

                            const { error: insertError } = await supabase.from("ap_inbox_queue").insert({
                                message_id: uniqueMsgId,
                                email_from: from,
                                email_subject: subject,
                                intent: intent,
                                pdf_path: storagePath,
                                pdf_filename: capturedFilename,
                                status: queueStatus,
                                source_inbox: sourceInbox
                            });

                            if (insertError) {
                                throw new Error(`Queue insert failed: ${insertError.message}`);
                            }

                            console.log(`     ✅ Queued ${capturedFilename} as ${queueStatus}`);
                            processedAnyPDF = true;
                            attachmentIndex++;

                        } catch (err: any) {
                            console.error(`     ❌ Failed to queue attachment:`, err.message);
                            await this.logActivity(supabase, from, subject, "PROCESSING_ERROR", `Queue failed: ${err.message}`);
                        }
                    }
                }

                if (processedAnyPDF) {
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: {
                                addLabelIds: [(await getLabels(sourceInbox)).invoiceFwd],
                                removeLabelIds: ["UNREAD"]  // Decoupled! We mark as read IMMEDIATELY upon successful queuing
                            }
                        });
                    } catch (e) { /* ignore */ }
                    const pdfNames = pdfParts.map((p: any) => p.filename).join(", ");
                    const logNote = `Queued for extraction (${pdfNames})`;
                    await this.logActivity(supabase, from, subject, intent, logNote, { attachments: pdfNames });
                } else {
                    console.log(`     ⚠️ No PDF found on ${intent}. Leaving unread for human check.`);
                    await this.logActivity(supabase, from, subject, intent, "No PDF attachment found — left unread for manual review");
                    try {
                        await gmail.users.messages.modify({
                            userId: "me",
                            id: m.gmail_message_id,
                            requestBody: { addLabelIds: [(await getLabels(sourceInbox)).apSeen] }
                        });
                    } catch (e) { /* ignore */ }
                }
            }
        } catch (err: any) {
            console.error("❌ [AP-Identifier] Error processing AP Inbox:", err.message);
        }
    }
}

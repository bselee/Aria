/**
 * @file tracking-agent.ts
 * @purpose Specialized agent that specifically hunts for tracking numbers in emails
 *          from vendors and matches them to active POs.
 * @author Aria (Antigravity)
 */

import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { extractPDF } from "../pdf/extractor";
import { unifiedObjectGeneration } from "./llm";
import { z } from "zod";

const TRACKING_PATTERNS = {
    ups: /\b1Z[A-Z0-9]{16}\b/gi,
    fedex: /\b(96\d{18}|\d{15}|\d{12})\b/g,
    usps: /\b(94|92|93|95)\d{20}\b/g,
    dhl: /\bJD\d{18}\b/gi,
    // generic: require '#' or ':' separator so "tracking information" doesn't match
    generic: /\b(?:tracking|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/gi,
    // PRO/BOL: require whitespace after keyword — prevents "production"/"bolus" false matches
    pro: /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/gi,
    bol: /\b(?:BOL[\s\-]+#?\s*|Bill\s+of\s+Lading\s+#?\s*)([0-9][0-9A-Z]{5,24})\b/gi,
};

// Tracking numbers must contain at least 2 digits — filters pure-word false positives
function isValidTrackingNum(num: string): boolean {
    return (num.match(/\d/g)?.length ?? 0) >= 2;
}

export class TrackingAgent {
    private decodeBase64(data: string): string {
        return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    }

    private async extractTrackingFromMessage(gmail: any, messageId: string, payload: any, snippet: string): Promise<string[]> {
        let combinedText = snippet + "\n";

        // Add full body text if non-multipart
        if (payload?.body?.data) {
            combinedText += this.decodeBase64(payload.body.data) + "\n";
        }

        const pdfParts: any[] = [];
        const walkParts = (parts: any[]) => {
            for (const part of parts) {
                if (part.mimeType === "text/plain" && part.body?.data) {
                    combinedText += this.decodeBase64(part.body.data) + "\n";
                }
                if (part.mimeType === "application/pdf" && part.filename) {
                    pdfParts.push(part);
                }
                if (part.parts?.length) walkParts(part.parts);
            }
        };

        if (payload?.parts) walkParts(payload.parts);

        for (const part of pdfParts) {
            if (part.body?.attachmentId) {
                try {
                    console.log(`     [TrackingAgent] Downloading PDF attachment: ${part.filename}`);
                    const attach = await gmail.users.messages.attachments.get({
                        userId: "me",
                        messageId: messageId,
                        id: part.body.attachmentId
                    });
                    if (attach.data.data) {
                        const buffer = Buffer.from(attach.data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
                        const { rawText } = await extractPDF(buffer);
                        combinedText += "\n" + rawText + "\n";
                    }
                } catch (e: any) {
                    console.error(`     ❌ [TrackingAgent] Failed to extract PDF attachment (${part.filename}):`, e.message);
                }
            }
        }

        const extracted: string[] = [];
        for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(combinedText)) !== null) {
                // Determine the actual tracking number based on capture groups.
                // Our complex regexes for generic, pro, bol capture the number in match[1].
                let trackingNum = match[0];
                if (["generic", "pro", "bol"].includes(carrier) && match[1]) {
                    trackingNum = match[1];
                } else if (carrier === "usps" || carrier === "fedex") {
                    // For USPS and FedEx we want the full match since we capture prefixes differently
                    trackingNum = match[0];
                }

                if (trackingNum && isValidTrackingNum(trackingNum) && !extracted.some(t => t.includes(trackingNum))) {
                    extracted.push(trackingNum);
                }
            }
        }

        // LTL / Freight advanced extraction fallback via LLM
        // Check for common trucking strings. If present, use Context-Aware Extraction
        const ltlKeywords = ["pro #", "pro-", "pro number", "bol", "bill of lading", "freight", "ltl", "pallet", "saia", "odfl", "dominion", "estes", "xpo"];
        const lowerBody = combinedText.toLowerCase();

        if (ltlKeywords.some(kw => lowerBody.includes(kw))) {
            console.log("     [TrackingAgent] LTL/Freight keywords triggered Context-Aware Extraction.");
            const schema = z.object({
                shipments: z.array(z.object({
                    carrierName: z.string().describe("The name of the freight or trucking company, e.g., 'Old Dominion', 'Saia', 'XPO', 'Dayton Freight'"),
                    trackingNumber: z.string().describe("The PRO #, BOL #, or tracking code itself (just the digits/characters)"),
                    type: z.enum(["PRO", "BOL", "OTHER"]).describe("The type of tracking number")
                }))
            });

            try {
                const res = await unifiedObjectGeneration({
                    system: "You are a specialized tracking extraction agent. Locate freight/trucking tracking details (PRO / BOL). Return nothing if none exist. ONLY EXTRACT the actual tracking numbers.",
                    prompt: `I am looking for LTL/Freight tracking numbers or BOLs in this email/document text. \n\n${combinedText.substring(0, 5000)}`,
                    schema,
                    schemaName: "LTLTrackingExtraction"
                }) as { shipments: { carrierName: string, trackingNumber: string, type: string }[] };

                if (res?.shipments?.length > 0) {
                    for (const s of res.shipments) {
                        if (!s.trackingNumber || s.trackingNumber.length < 5) continue;
                        // If string isn't already found
                        if (!extracted.some(t => t.includes(s.trackingNumber))) {
                            extracted.push(`${s.carrierName}:::${s.trackingNumber}`);
                        } else {
                            // It was already found via Regex (e.g. standard PRO regex), 
                            // but now we have the CARRIER name! We should upgrade the standard regex match to the advanced one.
                            const existingIndex = extracted.findIndex(t => t === s.trackingNumber);
                            if (existingIndex !== -1) {
                                console.log(`     [TrackingAgent] Upgrading tracking string ${s.trackingNumber} to include carrier ${s.carrierName}`);
                                extracted[existingIndex] = `${s.carrierName}:::${s.trackingNumber}`;
                            }
                        }
                    }
                }
            } catch (e: any) {
                console.error("     ❌ [TrackingAgent] Context-Aware Extraction Failed:", e.message);
            }
        }

        return extracted;
    }

    /**
     * Scans the Supabase email queue for tracking numbers.
     * This replaces the old behavior of polling the Gmail API directly for the last 14 days.
     */
    async processUnreadEmails(maxResults: number = 20) {
        console.log(`🕵️‍♂️ [TrackingAgent] Scanning queue for tracking numbers...`);
        try {
            const supabase = createClient();

            if (!supabase) {
                console.error("❌ [TrackingAgent] Supabase client unavailable — check env vars.");
                return [];
            }

            const gmailClients: Record<string, any> = {};
            const getGmailClient = async (inbox: string) => {
                if (!gmailClients[inbox]) {
                    try {
                        const auth = await getAuthenticatedClient(inbox);
                        gmailClients[inbox] = google.gmail({ version: "v1", auth });
                    } catch (e: any) {
                        try {
                            const fallback = await getAuthenticatedClient("default");
                            gmailClients[inbox] = google.gmail({ version: "v1", auth: fallback });
                        } catch (fallbackErr: any) {
                            console.error(`   ❌ [TrackingAgent] Could not authenticate any inbox for '${inbox}':`, fallbackErr.message);
                            return null;
                        }
                    }
                }
                return gmailClients[inbox];
            };
            // Fetch unprocessed rows
            const { data: messages, error } = await supabase
                .from('email_inbox_queue')
                .select('*')
                .eq('processed_by_tracking', false)
                .limit(maxResults);

            if (error) throw error;

            if (!messages || messages.length === 0) {
                return [];
            }

            console.log(`   Found ${messages.length} email(s) in queue to scan for tracking.`);

            const foundTracking = [];

            for (const m of messages) {
                // Lock row
                await supabase.from('email_inbox_queue')
                    .update({ processed_by_tracking: true })
                    .eq('id', m.id);

                const subject = m.subject || "";
                const bodyMsg = m.body_snippet || "";
                let poMatch = subject.match(/PO\s*#?\s*(\d+)/i) || bodyMsg.match(/PO\s*#?\s*(\d+)/i);

                // If no PO # in snippet, try LLM extraction as fallback before skipping
                if (!poMatch) {
                    try {
                        const schema = z.object({ poNumber: z.string().nullable() });
                        const res = await unifiedObjectGeneration({
                            system: "Extract a BuildASoil PO number from this email subject/snippet. Return null if not found.",
                            prompt: `Subject: ${subject}\nBody snippet: ${bodyMsg}`,
                            schema,
                            schemaName: "POExtraction"
                        }) as { poNumber: string | null };
                        if (res?.poNumber) {
                            const llmMatch = res.poNumber.match(/(\d+)/);
                            if (llmMatch) poMatch = llmMatch;
                        }
                    } catch (_) { /* ignore, will skip below */ }
                }

                // Still no PO # — can't associate tracking, skip
                if (!poMatch) {
                    continue;
                }

                const poNumber = poMatch[1];
                let extractedTracking: string[] = [];

                // We only need to fetch full payload if there's a PDF or we need full text
                try {
                    const sourceInbox = m.source_inbox || "default";
                    const gmail = await getGmailClient(sourceInbox);
                    if (!gmail) {
                        console.error(`   ❌ [TrackingAgent] No Gmail client available for inbox '${sourceInbox}', skipping message.`);
                        continue;
                    }
                    const { data: fullMsg } = await gmail.users.messages.get({
                        userId: "me",
                        id: m.gmail_message_id
                    });
                    extractedTracking = await this.extractTrackingFromMessage(gmail, m.gmail_message_id, fullMsg.payload, m.body_snippet || "");
                } catch (e: any) {
                    console.error(`   ❌ [TrackingAgent] Failed to fetch full message for ${m.gmail_message_id}:`, e.message);
                }

                if (extractedTracking.length > 0) {
                    const { data: existingPO } = await supabase
                        .from("purchase_orders")
                        .select("tracking_numbers")
                        .eq("po_number", poNumber)
                        .maybeSingle();

                    const oldTracking = existingPO?.tracking_numbers || [];
                    const newTracking = extractedTracking.filter(t => !oldTracking.includes(t));

                    if (newTracking.length > 0) {
                        const mergedTracking = [...new Set([...oldTracking, ...newTracking])];
                        await supabase.from("purchase_orders").upsert({
                            po_number: poNumber,
                            tracking_numbers: mergedTracking,
                            updated_at: new Date().toISOString()
                        }, { onConflict: "po_number" });

                        foundTracking.push({ poNumber, trackingNumbers: newTracking });
                        console.log(`✅ [TrackingAgent] Found new broad tracking for PO #${poNumber}: ${newTracking.join(', ')}`);
                    }
                }
            }

            if (foundTracking.length > 0) {
                console.log(`🏁 [TrackingAgent] Finished hunting. Found tracking for ${foundTracking.length} new PO updates.`);
            }
            return foundTracking;

        } catch (error: any) {
            console.error("❌ [TrackingAgent] Error hunting for tracking:", error.message);
            return [];
        }
    }
}

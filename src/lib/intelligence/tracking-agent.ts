/**
 * @file tracking-agent.ts
 * @purpose Specialized agent that specifically hunts for tracking numbers in emails
 *          from vendors and matches them to active POs.
 * @author Aria (Antigravity)
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { extractPDF } from "../pdf/extractor";
import { unifiedObjectGeneration } from "./llm";
import { z } from "zod";
import { upsertShipmentEvidence } from "../tracking/shipment-intelligence";

const TRACKING_PATTERNS = {
    ups: /\b1Z[A-Z0-9]{16}\b/gi,
    fedex: /\b(96\d{18}|\d{15}|\d{12})\b/g,
    usps: /\b(94|92|93|95)\d{20}\b/g,
    dhl: /\bJD\d{18}\b/gi,
    // generic: require '#' or ':' separator so "tracking information" doesn't match
    generic: /\b(?:tracking|track(?:\s+your)?\s+shipment|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/gi,
    // PRO/BOL: require whitespace after keyword — prevents "production"/"bolus" false matches
    pro: /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/gi,
    bol: /\b(?:BOL[\s\-]+#?\s*|Bill\s+of\s+Lading\s+#?\s*)([0-9][0-9A-Z]{5,24})\b/gi,
};

// Tracking numbers must contain at least 2 digits — filters pure-word false positives
function isValidTrackingNum(num: string): boolean {
    return (num.match(/\d/g)?.length ?? 0) >= 2;
}

type RecentPurchaseOrder = {
    po_number: string;
    vendor_name?: string | null;
    created_at?: string | null;
};

const VENDOR_NAME_STOP_WORDS = new Set([
    "inc",
    "llc",
    "ltd",
    "co",
    "company",
    "corp",
    "corporation",
    "usa",
    "the",
    "and",
]);

function normalizeComparisonText(value: string | null | undefined): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function vendorNameTokens(vendorName: string | null | undefined): string[] {
    return normalizeComparisonText(vendorName)
        .split(" ")
        .filter((token) => token.length >= 3 && !VENDOR_NAME_STOP_WORDS.has(token));
}

function extractNumericHints(text: string): string[] {
    return Array.from(new Set((text.match(/\b\d{6,}\b/g) || []).map((value) => value.trim())));
}

export function inferPONumberFromRecentPOs(
    message: { subject?: string | null; bodySnippet?: string | null; fromEmail?: string | null },
    recentPOs: RecentPurchaseOrder[],
): string | null {
    if (!recentPOs.length) return null;

    const subject = String(message.subject || "");
    const bodySnippet = String(message.bodySnippet || "");
    const fromEmail = String(message.fromEmail || "");
    const combinedText = `${subject}\n${bodySnippet}\n${fromEmail}`;
    const normalizedCombined = normalizeComparisonText(combinedText);
    const numericHints = extractNumericHints(combinedText);

    const directOrderMatch = recentPOs.filter((po) =>
        numericHints.some((hint) => String(po.po_number || "").toLowerCase().startsWith(hint.toLowerCase()))
    );
    if (directOrderMatch.length === 1) {
        return directOrderMatch[0].po_number;
    }

    const scored = recentPOs
        .map((po) => {
            const tokens = vendorNameTokens(po.vendor_name);
            if (!tokens.length) return { po, score: 0 };

            const fullVendor = normalizeComparisonText(po.vendor_name);
            const fullMatch = fullVendor.length >= 5 && normalizedCombined.includes(fullVendor);
            const tokenMatches = tokens.filter((token) => normalizedCombined.includes(token)).length;
            return { po, score: (fullMatch ? 10 : 0) + tokenMatches };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!scored.length) return null;

    const topScore = scored[0].score;
    const topMatches = scored.filter((entry) => entry.score === topScore).map((entry) => entry.po);
    const nonDropship = topMatches.filter((po) => !/dropship/i.test(String(po.po_number || "")));

    if (nonDropship.length === 1) {
        return nonDropship[0].po_number;
    }

    if (topMatches.length === 1 && numericHints.length === 0) {
        return topMatches[0].po_number;
    }

    return null;
}

function canonicalizePONumber(poNumber: string, recentPOs: RecentPurchaseOrder[]): string {
    const normalized = String(poNumber || "").trim();
    if (!normalized) return normalized;

    const directMatch = recentPOs.find((po) => String(po.po_number || "").toLowerCase() === normalized.toLowerCase());
    if (directMatch) return directMatch.po_number;

    const prefixMatches = recentPOs.filter((po) =>
        String(po.po_number || "").toLowerCase().startsWith(normalized.toLowerCase())
    );

    return prefixMatches.length === 1 ? prefixMatches[0].po_number : normalized;
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
                        gmailClients[inbox] = GmailApi({ version: "v1", auth });
                    } catch (e: any) {
                        try {
                            const fallback = await getAuthenticatedClient("default");
                            gmailClients[inbox] = GmailApi({ version: "v1", auth: fallback });
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

                if (!poMatch) {
                    const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
                    const { data: recentPOs } = await supabase
                        .from("purchase_orders")
                        .select("po_number, vendor_name, created_at")
                        .gte("created_at", recentCutoff)
                        .limit(200);

                    const inferredPO = inferPONumberFromRecentPOs({
                        subject,
                        bodySnippet: bodyMsg,
                        fromEmail: m.from_email,
                    }, (recentPOs || []) as RecentPurchaseOrder[]);

                    if (inferredPO) {
                        poMatch = [inferredPO, inferredPO.match(/(\d+)/)?.[1] || inferredPO];
                    }
                }

                // Still no PO # — can't associate tracking, skip
                if (!poMatch) {
                    continue;
                }

                const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
                const { data: recentPOs } = await supabase
                    .from("purchase_orders")
                    .select("po_number, vendor_name, created_at")
                    .gte("created_at", recentCutoff)
                    .limit(200);

                const poNumber = canonicalizePONumber(poMatch[1], (recentPOs || []) as RecentPurchaseOrder[]);
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
                    const newTracking: string[] = [];
                    for (const tracking of extractedTracking) {
                        const record = await upsertShipmentEvidence({
                            trackingNumber: tracking,
                            poNumber,
                            source: "email_tracking",
                            sourceRef: m.gmail_message_id,
                            confidence: 0.9,
                        });

                        if (record) {
                            newTracking.push(record.tracking_number);
                        }
                    }

                    if (newTracking.length > 0) {
                        const deduped = [...new Set(newTracking)];

                        foundTracking.push({ poNumber, trackingNumbers: deduped });
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

/**
 * @file    po-correlator.ts
 * @purpose Cross-inbox PO email correlation engine.
 *          Reads outgoing PO emails from bill.selee@buildasoil.com (label:PO)
 *          and correlates them with incoming invoices from ap@buildasoil.com.
 *          Builds vendor intelligence: communication patterns, response times,
 *          and payment behaviors.
 * @author  Aria (Antigravity)
 * @created 2026-02-26
 * @updated 2026-02-26
 * @deps    gmail/auth, supabase, llm
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
 *
 * DECISION(2026-02-26): Cross-inbox correlation is Phase 3 of invoice reconciliation.
 * This module reads the bill.selee@buildasoil.com account (label:PO) to:
 *   1. Extract PO numbers, vendor names, dates, and terms from outgoing PO emails
 *   2. Correlate with incoming invoices from ap@buildasoil.com
 *   3. Track vendor response patterns (some reply to PO thread, some don't)
 *   4. Build a vendor intelligence database for operational awareness
 */

import { google } from "googleapis";
import { getAuthenticatedClient } from "../gmail/auth";
import { createClient } from "../supabase";
import { unifiedObjectGeneration } from "./llm";
import { z } from "zod";

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

/** Shape of invoice rows returned from Supabase correlation queries */
interface InvoiceRow {
    invoice_number: string;
    po_number: string | null;
    vendor_name: string | null;
    total: number;
    created_at: string;
}

export interface POEmailRecord {
    messageId: string;
    threadId: string;
    poNumber: string;
    vendorName: string;
    vendorEmail: string;
    sentDate: string;
    subject: string;
    totalAmount?: number;
    itemCount?: number;
    /** Whether the vendor replied to the PO email thread */
    vendorReplied: boolean;
    /** Number of messages in the thread (1 = no vendor reply) */
    threadMessageCount: number;
    /** Tracking numbers if vendor included them in a reply */
    trackingNumbers: string[];
    /** Raw snippet for debugging */
    snippet: string;
}

export interface VendorProfile {
    vendorName: string;
    vendorEmails: string[];
    totalPOs: number;
    respondedCount: number;
    averageResponseHours: number | null;
    /** How the vendor typically communicates (thread reply, separate email, etc.) */
    communicationPattern: "thread_reply" | "separate_email" | "no_response" | "mixed";
    recentPOs: POEmailRecord[];
    lastPODate: string | null;
}

export interface CorrelationResult {
    poEmail: POEmailRecord;
    matchedInvoiceNumber: string | null;
    matchConfidence: "exact" | "high" | "medium" | "none";
    matchStrategy: string;
    daysBetweenPOAndInvoice: number | null;
}

// ──────────────────────────────────────────────────
// PO EMAIL EXTRACTION
// ──────────────────────────────────────────────────

/** Schema for LLM extraction of PO details from email body */
const POEmailSchema = z.object({
    poNumber: z.string().describe("Purchase Order number (e.g., PO-12345, 12345)"),
    vendorName: z.string().describe("Vendor or supplier name"),
    totalAmount: z.number().optional().describe("Total PO dollar amount if visible"),
    itemCount: z.number().optional().describe("Number of line items if visible"),
    trackingNumbers: z.array(z.string()).optional().describe("Any tracking numbers mentioned"),
    terms: z.string().optional().describe("Payment terms if mentioned (Net 30, etc.)"),
});

/**
 * Scan the bill.selee@buildasoil.com inbox for PO-labeled emails.
 * Extracts PO details from each email and returns structured records.
 *
 * @param maxResults - Maximum number of PO emails to scan (default: 50)
 * @param daysBack  - How far back to search (default: 90 days)
 */
export async function scanPOEmails(
    maxResults: number = 50,
    daysBack: number = 90
): Promise<POEmailRecord[]> {
    console.log(`📧 [PO-Correlator] Scanning bill.selee PO emails (last ${daysBack} days)...`);

    try {
        // "default" token maps to bill.selee@buildasoil.com
        const auth = await getAuthenticatedClient("default");
        const gmail = google.gmail({ version: "v1", auth });

        const afterDate = new Date(Date.now() - daysBack * 86_400_000);
        const afterStr = afterDate.toISOString().split("T")[0].replace(/-/g, "/");

        // Search for PO-labeled emails
        const listRes = await gmail.users.messages.list({
            userId: "me",
            q: `label:PO after:${afterStr}`,
            maxResults,
        });

        const messageIds = listRes.data.messages || [];
        console.log(`   📬 Found ${messageIds.length} PO email(s)`);

        const records: POEmailRecord[] = [];

        for (const msg of messageIds) {
            try {
                const record = await extractPOFromEmail(gmail, msg.id!, msg.threadId || "");
                if (record) records.push(record);
            } catch (err: any) {
                console.warn(`   ⚠️ Failed to extract PO from message ${msg.id}: ${err.message}`);
            }
        }

        console.log(`   ✅ Extracted ${records.length} PO record(s)`);
        return records;
    } catch (err: any) {
        console.error(`❌ [PO-Correlator] Failed to scan PO emails: ${err.message}`);
        return [];
    }
}

/**
 * Extract PO details from a single email message.
 */
async function extractPOFromEmail(
    gmail: any,
    messageId: string,
    threadId: string
): Promise<POEmailRecord | null> {
    const msgRes = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
    });

    const headers = msgRes.data.payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    const subject = getHeader("Subject");
    const to = getHeader("To");
    const from = getHeader("From");
    const dateStr = getHeader("Date");
    const snippet = msgRes.data.snippet || "";

    // Extract vendor email from "To" field (PO emails are SENT to vendors)
    const vendorEmail = extractEmail(to) || extractEmail(from) || "";

    // Check thread for replies (vendor response indicates active communication)
    const threadRes = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From"],
    });

    const threadMessages = threadRes.data.messages || [];
    const threadMessageCount = threadMessages.length;

    // A vendor replied if there's a message NOT from buildasoil.com
    const vendorReplied = threadMessages.some((m: any) => {
        const msgFrom = m.payload?.headers?.find((h: any) => h.name.toLowerCase() === "from")?.value || "";
        return !msgFrom.toLowerCase().includes("buildasoil.com");
    });

    // Extract tracking numbers from thread replies
    const trackingNumbers = extractTrackingFromThread(threadMessages);

    // Try to extract PO number from subject first (fast, no LLM needed)
    const poFromSubject = extractPONumber(subject);

    // If subject doesn't have a clear PO number, use LLM on snippet
    let poNumber = poFromSubject || "";
    let vendorName = "";
    let totalAmount: number | undefined;
    let itemCount: number | undefined;

    if (!poFromSubject || !vendorName) {
        try {
            const extracted = await unifiedObjectGeneration({
                system: "You extract structured data from purchase order emails. Be precise with PO numbers and vendor names.",
                prompt: `Extract PO details from this email:\nSubject: ${subject}\nTo: ${to}\nSnippet: ${snippet}`,
                schema: POEmailSchema,
                schemaName: "POEmail",
            }) as z.infer<typeof POEmailSchema>;

            poNumber = poNumber || extracted.poNumber;
            vendorName = extracted.vendorName;
            totalAmount = extracted.totalAmount;
            itemCount = extracted.itemCount;
        } catch {
            // If LLM fails, use what we have from subject parsing
            vendorName = extractVendorFromEmail(vendorEmail);
        }
    }

    if (!poNumber) return null; // Can't correlate without a PO number

    return {
        messageId,
        threadId,
        poNumber,
        vendorName: vendorName || extractVendorFromEmail(vendorEmail),
        vendorEmail,
        sentDate: dateStr,
        subject,
        totalAmount,
        itemCount,
        vendorReplied,
        threadMessageCount,
        trackingNumbers,
        snippet,
    };
}

// ──────────────────────────────────────────────────
// CROSS-INBOX CORRELATION
// ──────────────────────────────────────────────────

/**
 * Correlate PO emails with invoices stored in Supabase.
 * Finds which POs have matching invoices and identifies gaps.
 *
 * @param poRecords - PO email records from scanPOEmails()
 * @returns Correlation results with match quality indicators
 */
export async function correlatePOsWithInvoices(
    poRecords: POEmailRecord[]
): Promise<{
    correlated: CorrelationResult[];
    unmatchedPOs: POEmailRecord[];
    unmatchedInvoices: string[];
    summary: string;
}> {
    console.log(`🔗 [PO-Correlator] Correlating ${poRecords.length} PO(s) with invoices...`);

    const supabase = createClient();
    const correlated: CorrelationResult[] = [];
    const unmatchedPOs: POEmailRecord[] = [];

    // Fetch all invoices from the last 90 days
    const { data: invoices } = await supabase
        .from("invoices")
        .select("invoice_number, po_number, vendor_name, total, created_at")
        .gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString());

    const invoiceList: InvoiceRow[] = invoices || [];
    const matchedInvoiceNumbers = new Set<string>();

    for (const po of poRecords) {
        // Strategy 1: Exact PO number match
        const exactMatch = invoiceList.find(inv =>
            inv.po_number?.toLowerCase() === po.poNumber.toLowerCase()
        );

        if (exactMatch) {
            matchedInvoiceNumbers.add(exactMatch.invoice_number);
            const poDate = new Date(po.sentDate);
            const invDate = new Date(exactMatch.created_at);
            const daysBetween = Math.round((invDate.getTime() - poDate.getTime()) / 86_400_000);

            correlated.push({
                poEmail: po,
                matchedInvoiceNumber: exactMatch.invoice_number,
                matchConfidence: "exact",
                matchStrategy: "PO number exact match",
                daysBetweenPOAndInvoice: daysBetween,
            });
            continue;
        }

        // Strategy 2: Fuzzy vendor name + amount match
        const vendorMatches = invoiceList.filter(inv => {
            const invVendor = (inv.vendor_name || "").toLowerCase();
            const poVendor = po.vendorName.toLowerCase();
            return invVendor.includes(poVendor.slice(0, 10)) ||
                poVendor.includes(invVendor.slice(0, 10));
        });

        if (vendorMatches.length === 1) {
            matchedInvoiceNumbers.add(vendorMatches[0].invoice_number);
            correlated.push({
                poEmail: po,
                matchedInvoiceNumber: vendorMatches[0].invoice_number,
                matchConfidence: "medium",
                matchStrategy: "Vendor name fuzzy match (single candidate)",
                daysBetweenPOAndInvoice: null,
            });
            continue;
        }

        // Strategy 3: Vendor name + amount proximity
        if (po.totalAmount && vendorMatches.length > 0) {
            const amountMatch = vendorMatches.find(inv =>
                Math.abs(inv.total - po.totalAmount!) / po.totalAmount! < 0.05
            );

            if (amountMatch) {
                matchedInvoiceNumbers.add(amountMatch.invoice_number);
                correlated.push({
                    poEmail: po,
                    matchedInvoiceNumber: amountMatch.invoice_number,
                    matchConfidence: "high",
                    matchStrategy: "Vendor + amount proximity match",
                    daysBetweenPOAndInvoice: null,
                });
                continue;
            }
        }

        // No match found
        unmatchedPOs.push(po);
        correlated.push({
            poEmail: po,
            matchedInvoiceNumber: null,
            matchConfidence: "none",
            matchStrategy: "No invoice match found",
            daysBetweenPOAndInvoice: null,
        });
    }

    // Find invoices with no matching PO
    const unmatchedInvoices = invoiceList
        .filter(inv => !matchedInvoiceNumbers.has(inv.invoice_number))
        .map(inv => inv.invoice_number);

    // Build summary
    const matched = correlated.filter(c => c.matchConfidence !== "none");
    const summary = buildCorrelationSummary(correlated, unmatchedPOs, unmatchedInvoices);

    console.log(`   ✅ Correlated: ${matched.length}/${poRecords.length} POs | ${unmatchedInvoices.length} orphan invoices`);

    return { correlated, unmatchedPOs, unmatchedInvoices, summary };
}

// ──────────────────────────────────────────────────
// VENDOR INTELLIGENCE
// ──────────────────────────────────────────────────

/**
 * Build vendor communication profiles from PO email data.
 * Tracks how each vendor communicates: thread replies, separate emails, no response.
 *
 * DECISION(2026-02-26): Will noted vendors are inconsistent —
 * "some respond to PO message, few do not and it is frustrating."
 * This profile helps predict vendor behavior and flag non-responders.
 */
export function buildVendorProfiles(poRecords: POEmailRecord[]): VendorProfile[] {
    const vendorMap = new Map<string, POEmailRecord[]>();

    // Group POs by vendor
    for (const po of poRecords) {
        const key = po.vendorName.toLowerCase().trim();
        if (!vendorMap.has(key)) vendorMap.set(key, []);
        vendorMap.get(key)!.push(po);
    }

    const profiles: VendorProfile[] = [];

    for (const [, poList] of vendorMap) {
        const vendorName = poList[0].vendorName;
        const vendorEmails = [...new Set(poList.map(p => p.vendorEmail).filter(Boolean))];
        const totalPOs = poList.length;
        const respondedCount = poList.filter(p => p.vendorReplied).length;

        // Determine communication pattern
        const responseRate = respondedCount / totalPOs;
        let communicationPattern: VendorProfile["communicationPattern"];
        if (responseRate > 0.8) {
            communicationPattern = "thread_reply";
        } else if (responseRate > 0.3) {
            communicationPattern = "mixed";
        } else if (responseRate > 0) {
            communicationPattern = "separate_email";
        } else {
            communicationPattern = "no_response";
        }

        // Sort by date descending
        const sorted = poList.sort((a, b) =>
            new Date(b.sentDate).getTime() - new Date(a.sentDate).getTime()
        );

        profiles.push({
            vendorName,
            vendorEmails,
            totalPOs,
            respondedCount,
            averageResponseHours: null, // TODO(will)[2026-03-15]: Calculate from thread timestamps
            communicationPattern,
            recentPOs: sorted.slice(0, 5),
            lastPODate: sorted[0]?.sentDate || null,
        });
    }

    // Sort by total POs descending
    return profiles.sort((a, b) => b.totalPOs - a.totalPOs);
}

/**
 * Save vendor profiles to Supabase for persistence and trend tracking.
 */
export async function saveVendorProfiles(profiles: VendorProfile[]): Promise<void> {
    try {
        const supabase = createClient();
        if (!supabase) return;

        for (const profile of profiles) {
            await supabase
                .from("vendor_profiles")
                .upsert({
                    vendor_name: profile.vendorName,
                    vendor_emails: profile.vendorEmails,
                    total_pos: profile.totalPOs,
                    responded_count: profile.respondedCount,
                    communication_pattern: profile.communicationPattern,
                    last_po_date: profile.lastPODate,
                    updated_at: new Date().toISOString(),
                }, { onConflict: "vendor_name" });
        }
    } catch (err: any) {
        console.warn(`⚠️ Failed to save vendor profiles: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────
// FULL CORRELATION PIPELINE
// ──────────────────────────────────────────────────

/**
 * Run the full cross-inbox correlation:
 * 1. Scan PO emails from bill.selee
 * 2. Correlate with invoices in Supabase
 * 3. Build vendor intelligence profiles
 * 4. Return a comprehensive report
 *
 * Designed to be called by OpsManager on a schedule or on-demand via /correlate
 */
export async function runCorrelationPipeline(options?: {
    maxResults?: number;
    daysBack?: number;
}): Promise<{
    correlationResults: Awaited<ReturnType<typeof correlatePOsWithInvoices>>;
    vendorProfiles: VendorProfile[];
    formattedReport: string;
}> {
    const maxResults = options?.maxResults || 50;
    const daysBack = options?.daysBack || 90;

    // Step 1: Scan PO emails
    const poRecords = await scanPOEmails(maxResults, daysBack);

    if (poRecords.length === 0) {
        return {
            correlationResults: {
                correlated: [],
                unmatchedPOs: [],
                unmatchedInvoices: [],
                summary: "No PO emails found to correlate.",
            },
            vendorProfiles: [],
            formattedReport: "📧 No PO emails found in bill.selee label:PO for the last " + daysBack + " days.",
        };
    }

    // Step 2: Correlate with invoices
    const correlationResults = await correlatePOsWithInvoices(poRecords);

    // Step 3: Build vendor profiles
    const vendorProfiles = buildVendorProfiles(poRecords);

    // Step 4: Save profiles
    await saveVendorProfiles(vendorProfiles);

    // Step 5: Build formatted report
    const formattedReport = buildFullReport(correlationResults, vendorProfiles);

    return { correlationResults, vendorProfiles, formattedReport };
}

// ──────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────

/** Extract PO number from email subject using common patterns */
function extractPONumber(subject: string): string | null {
    // Match patterns like "PO-12345", "PO #12345", "Purchase Order 12345", "PO12345"
    const patterns = [
        /PO[- #]*(\d{3,})/i,
        /Purchase\s*Order[:\s#]*(\d{3,})/i,
        /Order[:\s#]*(\d{4,})/i,
    ];

    for (const pattern of patterns) {
        const match = subject.match(pattern);
        if (match) return match[0].replace(/[:#\s]+/g, "-").trim();
    }

    return null;
}

/** Extract email address from a "Name <email>" string */
function extractEmail(headerValue: string): string | null {
    const match = headerValue.match(/<([^>]+)>/);
    if (match) return match[1];
    // If no angle brackets, might be bare email
    const emailMatch = headerValue.match(/[\w.-]+@[\w.-]+\.\w+/);
    return emailMatch ? emailMatch[0] : null;
}

/** Extract vendor name from email address domain */
function extractVendorFromEmail(email: string): string {
    if (!email) return "Unknown";
    const domain = email.split("@")[1]?.split(".")[0] || "Unknown";
    return domain.charAt(0).toUpperCase() + domain.slice(1);
}

/**
 * Extract tracking numbers from thread reply messages.
 * Looks for common carrier patterns in vendor responses.
 */
function extractTrackingFromThread(messages: any[]): string[] {
    const trackingNumbers: string[] = [];
    const trackingPatterns = [
        // UPS
        /\b1Z[A-Z0-9]{16}\b/g,
        // FedEx
        /\b\d{12,22}\b/g,
        // USPS
        /\b(94|93|92|94|95)\d{18,22}\b/g,
        // Generic "tracking" followed by number
        /tracking[:\s#]*([A-Z0-9]{10,30})/gi,
    ];

    for (const msg of messages) {
        const snippet = msg.snippet || "";
        for (const pattern of trackingPatterns) {
            const matches = snippet.match(pattern);
            if (matches) {
                trackingNumbers.push(...matches);
            }
        }
    }

    return [...new Set(trackingNumbers)];
}

/** Build correlation summary for notifications */
function buildCorrelationSummary(
    correlated: CorrelationResult[],
    unmatchedPOs: POEmailRecord[],
    unmatchedInvoices: string[]
): string {
    const lines: string[] = [];

    const matched = correlated.filter(c => c.matchConfidence !== "none");
    lines.push(`📊 **PO ↔ Invoice Correlation Report**`);
    lines.push(`✅ Matched: ${matched.length} | ❓ Unmatched POs: ${unmatchedPOs.length} | 📑 Orphan Invoices: ${unmatchedInvoices.length}`);
    lines.push("");

    if (unmatchedPOs.length > 0) {
        lines.push("**POs Without Invoices (outstanding):**");
        for (const po of unmatchedPOs.slice(0, 10)) {
            lines.push(`  📦 ${po.poNumber} — ${po.vendorName} (${po.sentDate.slice(0, 10)})`);
        }
        if (unmatchedPOs.length > 10) lines.push(`  ...and ${unmatchedPOs.length - 10} more`);
        lines.push("");
    }

    if (unmatchedInvoices.length > 0) {
        lines.push("**Invoices Without PO Match (review needed):**");
        for (const inv of unmatchedInvoices.slice(0, 10)) {
            lines.push(`  📑 ${inv}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

/** Build full formatted report including vendor intelligence */
function buildFullReport(
    correlationResults: Awaited<ReturnType<typeof correlatePOsWithInvoices>>,
    vendorProfiles: VendorProfile[]
): string {
    const lines: string[] = [];

    lines.push(correlationResults.summary);
    lines.push("");
    lines.push("**Vendor Communication Intelligence:**");

    for (const vp of vendorProfiles.slice(0, 10)) {
        const emoji = vp.communicationPattern === "thread_reply" ? "✅"
            : vp.communicationPattern === "no_response" ? "🚨"
                : vp.communicationPattern === "mixed" ? "⚠️"
                    : "📧";

        const rateStr = `${vp.respondedCount}/${vp.totalPOs} replied`;

        lines.push(`${emoji} **${vp.vendorName}**: ${rateStr} (${vp.communicationPattern.replace("_", " ")})`);
    }

    return lines.join("\n");
}

/**
 * @file    src/lib/intelligence/email-search.ts
 * @purpose Telegram /emailsearch command backend. Searches both
 *          email_inbox_queue and ap_inbox_queue for matching emails.
 *          Returns concise results with snippet for Telegram display.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/supabase
 *
 * DESIGN:
 *   Searches across both inboxes:
 *   - email_inbox_queue (bill.selee@ emails)
 *   - ap_inbox_queue (ap@ emails, invoices)
 *
 *   Search dimensions:
 *   - from_email ILIKE (sender match)
 *   - subject ILIKE (subject match)
 *   - body_text ILIKE (body content match)
 *   - invoice_number ILIKE (AP queue only)
 *   - vendor_name ILIKE (AP queue only)
 *
 *   Returns top 10 results, sorted by recency.
 */

import { createClient } from "../supabase";

export interface EmailSearchResult {
    source: "default" | "ap";
    from: string;
    subject: string;
    snippet: string;
    status: string;
    createdAt: string;
    gmailMessageId?: string;
    invoiceNumber?: string | null;
    vendorName?: string | null;
}

export interface EmailSearchReport {
    query: string;
    results: EmailSearchResult[];
    totalHits: number;
    searchedAt: string;
}

/**
 * Search both email queues for matching emails.
 * Uses ILIKE for case-insensitive substring matching.
 */
export async function searchEmails(query: string): Promise<EmailSearchReport> {
    const db = createClient();
    if (!db) {
        return {
            query,
            results: [],
            totalHits: 0,
            searchedAt: new Date().toISOString(),
        };
    }

    const q = `%${query}%`;
    const results: EmailSearchResult[] = [];

    // Search 1: email_inbox_queue (bill.selee@ inbox)
    try {
        const { data: defaultEmails } = await db
            .from("email_inbox_queue")
            .select("from_email, subject, body_snippet, body_text, status, created_at, gmail_message_id")
            .or(`from_email.ilike.${q},subject.ilike.${q},body_text.ilike.${q},body_snippet.ilike.${q}`)
            .order("created_at", { ascending: false })
            .limit(5);

        if (defaultEmails) {
            for (const row of defaultEmails as any[]) {
                results.push({
                    source: "default",
                    from: row.from_email || "unknown",
                    subject: row.subject || "no subject",
                    snippet: (row.body_snippet || row.body_text || "").slice(0, 120),
                    status: row.status,
                    createdAt: row.created_at,
                    gmailMessageId: row.gmail_message_id,
                });
            }
        }
    } catch { /* table may differ in older migrations */ }

    // Search 2: ap_inbox_queue (ap@ inbox — invoices)
    try {
        const { data: apEmails } = await db
            .from("ap_inbox_queue")
            .select("email_from, email_subject, vendor_name, invoice_number, extracted_json, status, created_at, message_id")
            .or(`email_from.ilike.${q},email_subject.ilike.${q},vendor_name.ilike.${q},invoice_number.ilike.${q}`)
            .order("created_at", { ascending: false })
            .limit(5);

        if (apEmails) {
            for (const row of apEmails as any[]) {
                const ej = row.extracted_json || {};
                results.push({
                    source: "ap",
                    from: row.email_from || ej.from || "unknown",
                    subject: row.email_subject || ej.subject || "no subject",
                    snippet: `Vendor: ${row.vendor_name || ej.vendor_name || "?"} | Invoice: ${row.invoice_number || ej.invoice_number || "?"}`,
                    status: row.status,
                    createdAt: row.created_at,
                    invoiceNumber: row.invoice_number,
                    vendorName: row.vendor_name,
                });
            }
        }
    } catch { /* table may differ */ }

    // Sort all results by recency and take top 10
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
        query,
        results: results.slice(0, 10),
        totalHits: results.length,
        searchedAt: new Date().toISOString(),
    };
}

/**
 * Format search results for Telegram display.
 */
export function formatEmailSearchResults(report: EmailSearchReport): string {
    if (report.results.length === 0) {
        return `📭 *No emails found for "${report.query}"*\n\nSearched bill.selee@ and ap@ inboxes.`;
    }

    const lines: string[] = [];
    lines.push(`📧 *${report.totalHits} email${report.totalHits !== 1 ? "s" : ""} for "${report.query}"*`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    for (const r of report.results) {
        const icon = r.source === "ap" ? "📦" : "✉️";
        const age = Math.round((Date.now() - new Date(r.createdAt).getTime()) / 3600000);
        const ageLabel = age < 24 ? `${age}h ago` : `${Math.round(age / 24)}d ago`;
        const statusBadge = r.status === "completed" ? "✅" : r.status === "processing" ? "⏳" : r.status === "failed" ? "❌" : "📥";

        lines.push(`${icon} ${statusBadge} *${r.from}* — ${ageLabel}`);
        lines.push(`   📋 ${r.subject}`);
        if (r.snippet) {
            lines.push(`   _${r.snippet.slice(0, 100)}_`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

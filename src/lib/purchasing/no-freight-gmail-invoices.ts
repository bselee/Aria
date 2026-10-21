/**
 * @file    no-freight-gmail-invoices.ts
 * @purpose Find invoice PDFs in bill.selee@ and ap@ when vendor_invoices has
 *          no po_number link. Miles, Stock Bag, and Colorado Worm email the
 *          bill; the AP table often never gets the PO number.
 * @author  Hermia
 * @created 2026-09-28
 * @deps    gmail/auth, pdf/extractor, no-freight-invoice-text
 * @env     Gmail OAuth tokens (default + ap)
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../gmail/auth";
import { extractPDF } from "../pdf/extractor";
import type { NoFreightInvoice } from "./no-freight-po-complete";
import { invoiceMatchesPoLines, parseVendorInvoiceText } from "./no-freight-invoice-text";

interface GmailPart {
    filename?: string | null;
    mimeType?: string | null;
    body?: { attachmentId?: string | null; data?: string | null; size?: number | null };
    parts?: GmailPart[];
}

function vendorQuery(vendorName: string, orderId: string): string[] {
    const name = vendorName.toLowerCase();
    const queries = [`"${orderId}" (invoice OR packing OR "sales invoice") newer_than:90d`];
    if (name.includes("stock bag")) queries.push(`from:stockbagdepot.com subject:"Sales Invoice" newer_than:75d`);
    if (name.includes("miles") || name.includes("filippelli")) queries.push(`from:avinash.miles@gmail.com filename:pdf newer_than:30d`);
    if (name.includes("thrive")) queries.push(`"${orderId}" (invoice OR thrive) newer_than:45d`);
    if (name.includes("colorado worm") || name.includes("cowoco")) queries.push(`"${orderId}" (packing OR invoice) newer_than:45d`);
    if (name.includes("new moon")) queries.push(`from:kylednf@gmail.com "${orderId}" newer_than:180d`);
    return queries;
}

function attachments(part: GmailPart | undefined, acc: Array<{ filename: string; id: string }> = []): Array<{ filename: string; id: string }> {
    if (!part) return acc;
    if (part.filename && part.body?.attachmentId && part.filename.toLowerCase().endsWith(".pdf")) {
        acc.push({ filename: part.filename, id: part.body.attachmentId });
    }
    for (const child of part.parts || []) attachments(child, acc);
    return acc;
}

function headerDate(headers: Array<{ name?: string | null; value?: string | null }> | undefined): string | null {
    const raw = headers?.find(h => h.name?.toLowerCase() === "date")?.value;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Search both inboxes for this PO's invoice PDFs. Returns only bills that
 * name the PO, or whose goods total is a subset of this PO's lines and is
 * dated on or after the order.
 */
export async function findGmailInvoicesForPo(input: {
    orderId: string;
    vendorName: string;
    orderDate: string | null;
    poLineTotals: number[];
}): Promise<NoFreightInvoice[]> {
    const found: NoFreightInvoice[] = [];
    const seen = new Set<string>();

    for (const account of ["default", "ap"] as const) {
        let gmail: ReturnType<typeof GmailApi>;
        try {
            const auth = await getAuthenticatedClient(account);
            gmail = GmailApi({ version: "v1", auth });
        } catch {
            continue;
        }

        for (const q of vendorQuery(input.vendorName, input.orderId)) {
            const listed = await gmail.users.messages.list({ userId: "me", q, maxResults: 6 });
            for (const row of listed.data.messages || []) {
                if (!row.id || seen.has(row.id)) continue;
                seen.add(row.id);
                const msg = await gmail.users.messages.get({ userId: "me", id: row.id, format: "full" });
                const atts = attachments(msg.data.payload as GmailPart)
                    .filter(att => !/baspo|purchase-order|purchase order/i.test(att.filename));
                const dated = headerDate(msg.data.payload?.headers);
                for (const att of atts.slice(0, 1)) {
                    const got = await gmail.users.messages.attachments.get({
                        userId: "me",
                        messageId: row.id,
                        id: att.id,
                    });
                    if (!got.data.data) continue;
                    const buf = Buffer.from(got.data.data, "base64");
                    const extracted = await extractPDF(buf);
                    const parsed = parseVendorInvoiceText(extracted.rawText || "");
                    if (!(parsed.subtotal > 0 || parsed.total > 0)) continue;
                    const named = parsed.poNumber === input.orderId;
                    const subset = !parsed.poNumber && invoiceMatchesPoLines(
                        parsed.subtotal || parsed.total,
                        input.poLineTotals,
                        dated,
                        input.orderDate,
                    );
                    if (!named && !subset) continue;
                    if (parsed.poNumber && parsed.poNumber !== input.orderId) continue;
                    const poSum = input.poLineTotals.reduce((s, n) => s + n, 0);
                    const looksLikePoCopy = !parsed.invoiceNumber
                        && !/invoice|packing/i.test(att.filename)
                        && Math.abs((parsed.subtotal || parsed.total) - poSum) <= 0.5;
                    if (looksLikePoCopy) continue;
                    const key = parsed.invoiceNumber
                        || `${(parsed.subtotal || 0).toFixed(2)}|${parsed.freight.toFixed(2)}|${(parsed.total || 0).toFixed(2)}`;
                    if (seen.has(`inv:${key}`)) continue;
                    seen.add(`inv:${key}`);
                    found.push({
                        invoiceNumber: parsed.invoiceNumber,
                        status: "gmail",
                        subtotal: parsed.subtotal,
                        freight: parsed.freight,
                        tax: 0,
                        total: parsed.total || parsed.subtotal,
                    });
                }
            }
        }
    }

    return found;
}

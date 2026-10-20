/**
 * @file    fedex-freight-final-feed.ts
 * @purpose Glean the FedEx Freight final invoice triple (account / invoice
 *          number / amount) directly from the "New Invoices Available" notice
 *          email body, so a final amount is captured the moment it arrives —
 *          before the ~6-week mailbox retention drops the notice. This is the
 *          permanent fix for the Track-2 gap: the notice body carries the
 *          post-reweigh FINAL amount, so no CSV download and no PDF parse are
 *          needed. Only the three necessary fields are extracted; the HTML
 *          boilerplate, links, and disclaimers are discarded.
 *
 * @author  Hermia
 * @created 2026-10-20
 * @deps    @googleapis/gmail, lib/gmail/auth, lib/storage/vendor-invoices
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (freight account)
 */

import { getAuthenticatedClient } from "../gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { createClient } from "../db";

/** The three fields that matter — nothing else from the notice. */
export interface FedexFreightFinalNotice {
    /** FedEx Freight account number, e.g. 646135168. */
    accountNumber: string;
    /** Invoice number == freight bill number == the PRO join key. */
    invoiceNumber: string;
    /** FINAL amount due (post-reweigh), USD. */
    amount: number;
}

/** Sender whose notice body carries the triple. */
export const FEDEX_FREIGHT_NOTICE_SENDER = "from:fedex@billtrust.com";

/**
 * Parse the account/invoice/amount triples out of a notice email body.
 *
 * The body is an HTML table whose meaningful content reads, flattened:
 *   "Account Number Invoice Number Amount 646135168 300413379090 521.82"
 * Multiple rows concatenate, so the regex captures every triple. The amount is
 * the FINAL post-reweigh figure (it matches the invoice PDF's Total Amount Due,
 * not the LTL Select booked quote).
 *
 * @param body - raw HTML (or text) body of the notice email
 * @returns up to N triples, one per invoice listed in the notice
 */
export function parseFedexFreightFinalNotices(body: string): FedexFreightFinalNotice[] {
    if (!body) return [];
    // Strip tags so the table cells collapse into a single flat string.
    const flat = body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
    // Account (9 digits) Invoice (9-12 digits) Amount (decimal, 2 dp).
    const re = /(\d{9})\s+(\d{9,12})\s+(\d+\.\d{2})/g;
    const out: FedexFreightFinalNotice[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat)) !== null) {
        const invoiceNumber = m[2];
        const key = `${m[1]}:${invoiceNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ accountNumber: m[1], invoiceNumber, amount: parseFloat(m[3]) });
    }
    return out;
}

/**
 * Read one notice message's flat body text (HTML preferred, text fallback).
 */
function messageBodyText(payload: any): string {
    const parts: any[] = [];
    const walk = (p: any) => {
        if (!p) return;
        if (p.parts) p.parts.forEach(walk);
        else parts.push(p);
    };
    walk(payload);
    // Prefer HTML (the amount table lives there), fall back to text/plain.
    for (const mime of ["text/html", "text/plain"]) {
        for (const p of parts) {
            if (p.mimeType === mime && p.body?.data) {
                return Buffer.from(p.body.data, "base64").toString("utf-8");
            }
        }
    }
    return "";
}

/**
 * Fetch every FedEx Freight final invoice notice currently in the freight@
 * mailbox and parse the account/invoice/amount triple from each body.
 *
 * This is the glean step: idempotent (dedupes triples), reads only the body
 * (no PDF download), and returns the full set the mailbox still holds. Callers
 * persist the triples so they outlive the mailbox retention window.
 */
export async function fetchFedexFreightFinalNotices(): Promise<FedexFreightFinalNotice[]> {
    const auth = await getAuthenticatedClient("freight");
    const gmail = GmailApi({ version: "v1", auth });
    const list = await gmail.users.messages.list({
        userId: "me",
        q: FEDEX_FREIGHT_NOTICE_SENDER,
        maxResults: 500,
    });
    const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
    const out: FedexFreightFinalNotice[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const body = messageBodyText(msg.data.payload);
        for (const n of parseFedexFreightFinalNotices(body)) {
            const key = `${n.accountNumber}:${n.invoiceNumber}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(n);
        }
    }
    return out;
}

/**
 * Upsert the gleaned triples into the fedex_freight_finals ledger.
 *
 * Idempotent: (account_number, invoice_number) is unique, so re-running the
 * glean only inserts rows that are not yet captured. Returns the number of rows
 * newly inserted.
 */
export async function persistFedexFreightFinalNotices(
    notices: FedexFreightFinalNotice[],
): Promise<number> {
    if (!notices.length) return 0;
    const db = createClient();
    const { count: before } = await db
        .from("fedex_freight_finals")
        .select("id", { count: "exact", head: true });
    for (const n of notices) {
        const { error } = await db.from("fedex_freight_finals").upsert(
            {
                account_number: n.accountNumber,
                invoice_number: n.invoiceNumber,
                amount: n.amount,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "account_number,invoice_number" },
        );
        if (error) {
            console.error(`[fedex-freight-final-feed] upsert failed for ${n.invoiceNumber}:`, error.message);
        }
    }
    const { count: after } = await db
        .from("fedex_freight_finals")
        .select("id", { count: "exact", head: true });
    return Math.max(0, (after ?? 0) - (before ?? 0));
}

/**
 * Glean + persist in one call: fetch the notice triples from the freight@
 * mailbox and write them to the ledger. Returns the newly captured count.
 */
export async function captureFedexFreightFinals(): Promise<number> {
    const notices = await fetchFedexFreightFinalNotices();
    return persistFedexFreightFinalNotices(notices);
}

/**
 * @file    src/lib/purchasing/short-shipment-drafter.ts
 * @purpose When a deliver-and-bill vendor's reception is short compared to
 *          the invoice, auto-draft a Gmail reply to the vendor's delivery
 *          thread: "Yo {Name}, we are {N} short on {product} compared to
 *          invoice. How to handle?"
 *
 *          Bill's model (2026-11-10): "Miles delivers after invoicing. When
 *          we see one come through we flag, wait for reception. Cannot be
 *          entered into Bill.com until verified. AUTOMATIC. When a
 *          reception is short, draft a friendly email to Miles."
 *
 *          The AP forwarder already sends to Bill.com (we don't auto-pay
 *          Miles, so that's fine). This module handles the SHORT DETECTION
 *          + AUTO-DRAFT: the invoice landed, reception landed, the
 *          comparison shows a short, and the vendor needs a reply.
 *
 *          Dedup: a SQLite table `short_shipment_drafts` tracks (po_number,
 *          invoice_number) pairs already drafted. One draft per pair.
 *
 * @author  Hermia
 * @created 2026-11-10
 * @deps    @googleapis/gmail, @/lib/gmail/auth, @/lib/storage/local-db,
 *          @/lib/purchasing/deliver-bill-vendors, @/lib/purchasing/invoice-description-match
 * @env     GMAIL_DEFAULT_TOKEN (default account token.json)
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { getLocalDb } from "@/lib/storage/local-db";
import { isDeliverAndBillVendor } from "@/lib/purchasing/deliver-bill-vendors";
import { resolveMilesDescriptionToSku, isMilesVendorName } from "@/lib/purchasing/invoice-description-match";

// ── Types ────────────────────────────────────────────────────────────────

/** A receivings dashboard row with reconciliation data. */
export interface ReceivingsRow {
    orderId: string;
    supplier: string;
    receiveDate?: string | null;
    receiptStatus?: string | null;
    items: Array<{
        productId: string;
        orderedQuantity: number;
        receivedQuantity: number;
        unitPrice: number;
    }>;
    _reconciliation?: {
        matchedInvoice?: {
            invoice_number: string | null;
            line_items?: Array<{
                description?: string | null;
                qty?: number;
                unit_price?: number;
                ext_price?: number;
            }> | string | null;
        } | null;
        coveringBill?: {
            invoice_number: string | null;
            line_items?: Array<{
                description?: string | null;
                qty?: number;
                unit_price?: number;
                ext_price?: number;
            }> | string | null;
        } | null;
        invoiceVsReceipt?: {
            invoicedTotal: number;
            receivedValue: number;
            invoicedQty: number;
            receivedQty: number;
            overbilled: boolean;
            gracePending?: boolean;
            billed: boolean;
            shortQty?: number;
        } | null;
    } | null;
}

export interface ShortShipmentDraftResult {
    poNumber: string;
    vendor: string;
    invoiceNumber: string | null;
    shortQty: number;
    productDescription: string;
    draftId: string | null;
    drafted: boolean;
    reason: string;
}

// ── SQLite dedup table ────────────────────────────────────────────────────

/**
 * Ensure the `short_shipment_drafts` table exists. Called once on first use.
 * Tracks (po_number, invoice_number) pairs that have already been drafted
 * so the cron watcher does not re-draft the same short.
 */
function ensureDedupTable(): void {
    try {
        const db = getLocalDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS short_shipment_drafts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                po_number TEXT NOT NULL,
                invoice_number TEXT,
                short_qty INTEGER NOT NULL,
                product_description TEXT,
                draft_id TEXT,
                gmail_thread_id TEXT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(po_number, invoice_number)
            );
        `);
    } catch {
        // Table may already exist or local-db may be unavailable.
    }
}

/**
 * True when a draft has already been created for this PO + invoice pair.
 */
function alreadyDrafted(poNumber: string, invoiceNumber: string | null): boolean {
    try {
        const db = getLocalDb();
        const row = db
            .prepare(
                `SELECT 1 FROM short_shipment_drafts
                 WHERE po_number = ? AND (invoice_number = ? OR (invoice_number IS NULL AND ? IS NULL))
                 LIMIT 1`,
            )
            .get(poNumber, invoiceNumber, invoiceNumber);
        return !!row;
    } catch {
        return false;
    }
}

/**
 * Record that a draft was created for this PO + invoice pair.
 */
function recordDraft(
    poNumber: string,
    invoiceNumber: string | null,
    shortQty: number,
    productDescription: string,
    draftId: string,
    threadId: string,
): void {
    try {
        const db = getLocalDb();
        db.prepare(
            `INSERT OR IGNORE INTO short_shipment_drafts
             (po_number, invoice_number, short_qty, product_description, draft_id, gmail_thread_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(poNumber, invoiceNumber, shortQty, productDescription, draftId, threadId);
    } catch {
        // dedup is best-effort; never block the draft on recording failure
    }
}

// ── Email thread discovery ────────────────────────────────────────────────

/**
 * Find the most recent Gmail message from a vendor by email or name.
 * Returns the threadId, message ID, subject, and From email for drafting.
 */
async function findVendorThread(
    gmail: ReturnType<typeof GmailApi>,
    vendorName: string,
): Promise<{
    threadId: string;
    msgId: string;
    subject: string;
    toEmail: string;
    fromDisplay: string;
} | null> {
    // Build a Gmail search query from the vendor name.
    // Miles emails come from avinash.miles@gmail.com or "miles filippelli".
    const nameLower = vendorName.toLowerCase().trim();
    let query: string;
    if (nameLower.includes("miles") || nameLower.includes("fermented")) {
        query = "from:avinash.miles@gmail.com OR from:miles.filippelli newer_than:7d";
    } else {
        // Generic: search by vendor name
        query = `from:${JSON.stringify(vendorName).slice(1, -1)} newer_than:7d`;
    }

    const list = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 10,
    });

    const msgs = list.data.messages || [];
    if (msgs.length === 0) return null;

    let best: { threadId: string; msgId: string; subject: string; toEmail: string; fromDisplay: string; internalDate: number } | null = null;

    for (const m of msgs) {
        const full = await gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "full",
        });
        const headers = full.data.payload?.headers || [];
        const from = headers.find((h) => h.name === "From")?.value || "";
        const subject = headers.find((h) => h.name === "Subject")?.value || "";
        const msgId = headers.find((h) => h.name === "Message-ID")?.value || "";
        const internalDate = Number(full.data.internalDate || 0);

        // Skip sent mail (our own replies)
        const labelIds = full.data.labelIds || [];
        if (labelIds.includes("SENT")) continue;

        if (!best || internalDate > best.internalDate) {
            const emailMatch = from.match(/<([^>]+)>/);
            const toEmail = emailMatch ? emailMatch[1] : from;
            best = {
                threadId: m.threadId!,
                msgId,
                subject,
                toEmail,
                fromDisplay: from,
                internalDate,
            };
        }
    }

    if (!best) return null;
    return {
        threadId: best.threadId,
        msgId: best.msgId,
        subject: best.subject,
        toEmail: best.toEmail,
        fromDisplay: best.fromDisplay,
    };
}

/**
 * Extract the first name from a Gmail From display name.
 * "miles filippelli <avinash.miles@gmail.com>" → "Miles"
 * Never uses the email username — uses the display name.
 */
function firstNameFromDisplay(fromDisplay: string): string {
    // Strip email part
    const namePart = fromDisplay.replace(/<[^>]+>/, "").trim().replace(/^["']|["']$/g, "");
    if (!namePart) return "";
    // First word, capitalized
    const first = namePart.split(/\s+/)[0] || "";
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// ── Short detection ───────────────────────────────────────────────────────

/**
 * Detect a per-line short by comparing invoice line qtys against received
 * quantities for the same SKU/product. Returns the total short qty and a
 * product description for the draft.
 *
 * For Miles (Fermented Plant Extracts) the invoice lines carry descriptions
 * not SKUs, so we resolve the description to a Finale SKU and compare the
 * invoice qty against the received qty on that SKU's PO line.
 */
function detectShortFromReconciliation(row: ReceivingsRow): { shortQty: number; productDescription: string } | null {
    const recon = row._reconciliation;
    if (!recon) return null;

    // For Miles (Fermented Plant Extracts), resolve each invoice line's
    // description to a Finale SKU and compare the invoice qty against the
    // received qty on that SKU's PO line. A bill qty > received qty is a
    // real short.
    if (isMilesVendorName(row.supplier)) {
        const bills = [recon.matchedInvoice, recon.coveringBill].filter(Boolean);
        for (const bill of bills) {
            const lines = parseInvoiceLines(bill?.line_items);
            for (const line of lines) {
                const qty = Number(line.qty ?? 0);
                if (qty <= 0) continue;
                const sku = resolveMilesDescriptionToSku(line.description);
                if (!sku) continue;
                const poItem = (row.items || []).find((it) => it.productId === sku);
                if (poItem && poItem.receivedQuantity < qty) {
                    return {
                        shortQty: qty - poItem.receivedQuantity,
                        productDescription: line.description || sku,
                    };
                }
            }
        }
    }

    return null;
}

/** Coerce line_items (JSON string or array) to a typed array. */
function parseInvoiceLines(
    li: unknown,
): Array<{ description?: string | null; qty?: number; unit_price?: number; ext_price?: number }> {
    if (!li) return [];
    if (typeof li === "string") {
        try {
            const parsed = JSON.parse(li);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return Array.isArray(li) ? li : [];
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * For each receivings row from the dashboard, detect deliver-and-bill vendor
 * shorts and auto-draft a Gmail reply. Returns one result per row processed.
 *
 * @param rows Receivings dashboard rows (from /api/dashboard/receivings)
 * @returns   Array of draft results.
 */
export async function draftShortShipmentEmails(rows: ReceivingsRow[]): Promise<ShortShipmentDraftResult[]> {
    ensureDedupTable();
    const results: ShortShipmentDraftResult[] = [];

    // Filter to deliver-and-bill vendors with a reception that landed.
    const candidates = rows.filter(
        (r) =>
            isDeliverAndBillVendor(r.supplier) &&
            r.receiptStatus !== "none" &&
            r._reconciliation,
    );

    if (candidates.length === 0) return [];

    // Authenticate Gmail once for all drafts.
    let gmail: ReturnType<typeof GmailApi>;
    try {
        const auth = await getAuthenticatedClient("default");
        gmail = GmailApi({ version: "v1", auth: auth as any });
    } catch (e: any) {
        console.error("[short-shipment-drafter] Gmail auth failed:", e?.message);
        return candidates.map((r) => ({
            poNumber: r.orderId,
            vendor: r.supplier,
            invoiceNumber: r._reconciliation?.matchedInvoice?.invoice_number ?? null,
            shortQty: 0,
            productDescription: "",
            draftId: null,
            drafted: false,
            reason: `gmail auth failed: ${e?.message}`,
        }));
    }

    for (const row of candidates) {
        const poNumber = row.orderId;
        const vendor = row.supplier;

        // Detect the short
        const short = detectShortFromReconciliation(row);
        if (!short || short.shortQty <= 0) {
            results.push({
                poNumber,
                vendor,
                invoiceNumber: row._reconciliation?.matchedInvoice?.invoice_number ?? null,
                shortQty: 0,
                productDescription: "",
                draftId: null,
                drafted: false,
                reason: "no short detected",
            });
            continue;
        }

        const invoiceNumber = row._reconciliation?.matchedInvoice?.invoice_number ?? null;

        // Dedup: skip if already drafted
        if (alreadyDrafted(poNumber, invoiceNumber)) {
            results.push({
                poNumber,
                vendor,
                invoiceNumber,
                shortQty: short.shortQty,
                productDescription: short.productDescription,
                draftId: null,
                drafted: false,
                reason: "already drafted",
            });
            continue;
        }

        // Find the vendor's email thread
        const thread = await findVendorThread(gmail, vendor).catch(() => null);
        if (!thread) {
            results.push({
                poNumber,
                vendor,
                invoiceNumber,
                shortQty: short.shortQty,
                productDescription: short.productDescription,
                draftId: null,
                drafted: false,
                reason: "no vendor email thread found in last 7d",
            });
            continue;
        }

        // Build the draft body — Bill's exact voice (2026-11-10)
        const firstName = firstNameFromDisplay(thread.fromDisplay) || vendor.split(/\s+/)[0] || "Miles";
        const body = `Yo ${firstName}, we are ${short.shortQty} short on ${short.productDescription} compared to invoice. How to handle?`;

        const raw = [
            `From: bill.selee@buildasoil.com`,
            `To: ${thread.toEmail}`,
            `Subject: RE: ${thread.subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset=UTF-8`,
            `In-Reply-To: ${thread.msgId}`,
            `References: ${thread.msgId}`,
            ``,
            body,
        ].join("\r\n");

        const rawB64 = Buffer.from(raw).toString("base64url");

        try {
            // Dedupe existing drafts on the same subject
            const existing = await gmail.users.drafts.list({
                userId: "me",
                q: `subject:"${thread.subject}"`,
            });
            if (existing.data.drafts) {
                for (const d of existing.data.drafts) {
                    await gmail.users.drafts.delete({ userId: "me", id: d.id! });
                }
            }

            const draft = await gmail.users.drafts.create({
                userId: "me",
                requestBody: {
                    message: {
                        raw: rawB64,
                        threadId: thread.threadId,
                    },
                },
            });

            recordDraft(poNumber, invoiceNumber, short.shortQty, short.productDescription, draft.data.id!, thread.threadId);

            console.log(
                `[short-shipment-drafter] Drafted PO ${poNumber} (${vendor}): ${short.shortQty} short on ${short.productDescription} → draft ${draft.data.id}`,
            );

            results.push({
                poNumber,
                vendor,
                invoiceNumber,
                shortQty: short.shortQty,
                productDescription: short.productDescription,
                draftId: draft.data.id!,
                drafted: true,
                reason: "drafted",
            });
        } catch (e: any) {
            console.error(`[short-shipment-drafter] Draft failed for PO ${poNumber}:`, e?.message);
            results.push({
                poNumber,
                vendor,
                invoiceNumber,
                shortQty: short.shortQty,
                productDescription: short.productDescription,
                draftId: null,
                drafted: false,
                reason: `draft failed: ${e?.message}`,
            });
        }
    }

    return results;
}

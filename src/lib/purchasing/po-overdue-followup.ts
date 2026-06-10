/**
 * @file    src/lib/purchasing/po-overdue-followup.ts
 * @purpose Proactive vendor follow-up for overdue purchase orders.
 *          When a PO is past its expected receive date with 0 items received,
 *          scan Gmail for vendor replies and draft a polite status-check email.
 *          Notifies Bill via Telegram that a draft is ready.
 *
 *          Closes the gap where po-stuck-detector identifies overdue POs
 *          but only logs to console — nobody was chasing them.
 *
 * @author  Hermia
 * @created 2026-06-09
 * @deps    @/lib/finale/client, @/lib/gmail/auth, @googleapis/gmail,
 *          @/lib/intelligence/vendor-comms-agent, @/lib/intelligence/telegram-notify,
 *          @/lib/purchasing/po-sender
 * @env     FINALE_* (via FinaleClient), Gmail OAuth (via getAuthenticatedClient)
 */

import { FinaleClient } from "../finale/client";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { sendTelegramNotify } from "../intelligence/telegram-notify";

// ── Config ────────────────────────────────────────────────────────────────

/** Only check POs overdue by at least this many days. */
const MIN_OVERDUE_DAYS = 3;

/** Gmail search window for PO-related inbound emails. */
const EMAIL_SEARCH_DAYS = 30;

/** Max drafts per run to avoid runaway email creation. */
const MAX_DRAFTS_PER_RUN = 5;

/** Supabase query limit for overdue PO scan. */
const QUERY_LIMIT = 50;

// ── Types ─────────────────────────────────────────────────────────────────

interface OverduePO {
    orderId: string;
    vendorName: string | null;
    statusId: string;
    expectedReceiveDate: string | null;
    orderDate: string | null;
    items: Array<{ productId: string; quantityOrdered: number; quantityReceived: number }>;
    totalAmount: number;
    vendorEmail: string | null;
    vendorPartyId: string | null;
}

interface FollowupResult {
    orderId: string;
    action: "drafted" | "email_found" | "no_email" | "thread_missing" | "skipped";
    daysOverdue: number;
    emailFound: boolean;
    detail: string;
}

// ── Core Logic ────────────────────────────────────────────────────────────

/**
 * Check if an invoice exists for this PO = vendor has shipped/invoiced us.
 * If yes, no need to draft a vendor follow-up — goods are on the way.
 */
async function invoiceExists(orderId: string): Promise<boolean> {
    try {
        const { createClient } = await import("@/lib/supabase");
        const db = createClient();
        if (!db) return false;
        const { data } = await db
            .from("invoices")
            .select("id")
            .eq("po_number", orderId)
            .limit(1);
        return !!(data && data.length > 0);
    } catch {
        return false;
    }
}

/**
 * Main entry point. Scans Finale for overdue POs, drafts vendor follow-up
 * emails, and sends a Telegram summary.
 */
export async function runOverdueFollowup(): Promise<FollowupResult[]> {
    const finale = new FinaleClient();
    const overduePOs = await findOverduePOs(finale);

    if (overduePOs.length === 0) {
        console.log("[po-overdue] No overdue POs found");
        return [];
    }

    console.log(`[po-overdue] ${overduePOs.length} overdue PO(s) found`);

    // Authenticate Gmail
    const gmail = GmailApi({ version: "v1", auth: await getAuthenticatedClient("default") });

    const results: FollowupResult[] = [];
    let draftedCount = 0;

    for (const po of overduePOs) {
        if (draftedCount >= MAX_DRAFTS_PER_RUN) break;

        const daysOverdue = po.expectedReceiveDate
            ? Math.floor((Date.now() - new Date(po.expectedReceiveDate).getTime()) / 86_400_000)
            : 0;

        try {
            // 0. Check if vendor has already invoiced — if so, goods shipped.
            //    No need to draft a follow-up. The Slack detector already
            //    tells staff "shipped today" when they ask about the PO.
            const hasInvoice = await invoiceExists(po.orderId);
            if (hasInvoice) {
                results.push({
                    orderId: po.orderId,
                    action: "skipped",
                    daysOverdue,
                    emailFound: false,
                    detail: `Invoice exists — goods shipped, no follow-up needed`,
                });
                continue;
            }

            // 1. Search Gmail for any inbound emails about this PO
            const inboundEmails = await searchInboundForPO(gmail, po.orderId);

            // 2. Find the original PO send thread (for reply threading)
            const thread = await findPOThread(gmail, po.orderId);

            // 3. Resolve vendor email
            const vendorEmail = resolveVendorEmail(po, thread, inboundEmails);

            if (!vendorEmail) {
                results.push({
                    orderId: po.orderId,
                    action: "no_email",
                    daysOverdue,
                    emailFound: inboundEmails.length > 0,
                    detail: `No vendor email found for ${po.vendorName || "unknown vendor"}`,
                });
                continue;
            }

            if (inboundEmails.length > 0 && !thread) {
                // We found emails from the vendor but no original PO thread
                // — likely they replied outside the thread. Still useful.
                results.push({
                    orderId: po.orderId,
                    action: "email_found",
                    daysOverdue,
                    emailFound: true,
                    detail: `Vendor has sent emails (no PO thread found)`,
                });
                continue;
            }

            if (!thread) {
                results.push({
                    orderId: po.orderId,
                    action: "thread_missing",
                    daysOverdue,
                    emailFound: inboundEmails.length > 0,
                    detail: `No PO email thread found in Gmail`,
                });
                continue;
            }

            // 4. Draft the follow-up email
            const draftSuccess = await draftOverdueFollowup(
                gmail, po, thread, vendorEmail, daysOverdue,
            );

            if (draftSuccess) {
                draftedCount++;
                results.push({
                    orderId: po.orderId,
                    action: "drafted",
                    daysOverdue,
                    emailFound: inboundEmails.length > 0,
                    detail: `Drafted reply to ${vendorEmail} in thread`,
                });
            } else {
                results.push({
                    orderId: po.orderId,
                    action: "skipped",
                    daysOverdue,
                    emailFound: false,
                    detail: `Draft creation failed`,
                });
            }
        } catch (err: any) {
            console.warn(`[po-overdue] PO ${po.orderId} follow-up error: ${err.message}`);
            results.push({
                orderId: po.orderId,
                action: "skipped",
                daysOverdue,
                emailFound: false,
                detail: `Error: ${err.message?.slice(0, 100)}`,
            });
        }
    }

    // 5. Telegram summary
    const drafted = results.filter(r => r.action === "drafted").length;
    const emailFound = results.filter(r => r.action === "email_found").length;
    if (drafted > 0 || overduePOs.length > 0) {
        await sendTgSummary(overduePOs, results);
    }

    console.log(
        `[po-overdue] Done: ${drafted} drafted, ${emailFound} vendor-replied, ${results.filter(r => r.action === "no_email").length} no-email, ${results.filter(r => r.action === "skipped").length} skipped`,
    );

    return results;
}

// ── Finale Query ──────────────────────────────────────────────────────────

/**
 * Find POs where:
 *   - status = ORDER_LOCKED (committed/sent)
 *   - expected receive date is past
 *   - 0 items received
 *   - at least MIN_OVERDUE_DAYS overdue
 */
async function findOverduePOs(finale: FinaleClient): Promise<OverduePO[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - MIN_OVERDUE_DAYS * 86_400_000);

    // Use the existing getOpenPurchaseOrders method if available,
    // otherwise fall back to manual order scanning
    const results: OverduePO[] = [];

    try {
        // Fetch recent purchase orders from Finale
        const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
        const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";

        // Use the core client's authenticated fetch
        const apiKey = process.env.FINALE_API_KEY || "";
        const apiSecret = process.env.FINALE_API_SECRET || "";
        const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

        // Get all ORDER_LOCKED purchase orders
        const url = `${baseUrl}/${accountPath}/api/query.json`;
        const body = JSON.stringify({
            sql: `SELECT * FROM PurchaseOrder WHERE statusId = 'ORDER_LOCKED' ORDER BY expectedReceiveDate ASC LIMIT ${QUERY_LIMIT}`,
        });

        const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
            body,
        });

        if (!res.ok) {
            // Fallback: try the list endpoint
            const listRes = await fetch(
                `${baseUrl}/${accountPath}/api/order.json?limit=${QUERY_LIMIT}&orderTypeId=PURCHASE_ORDER`,
                { headers: { Authorization: auth, Accept: "application/json" } },
            );
            if (listRes.ok) {
                const data = await listRes.json() as any;
                const orders = (data.results || data || []);
                for (const o of orders) {
                    if (o.statusId === "ORDER_LOCKED" && o.expectedReceiveDate) {
                        const expDate = new Date(o.expectedReceiveDate);
                        if (expDate < cutoff) {
                            const poDetail = await (finale as any).getOrderDetails(o.orderId).catch(() => null);
                            if (poDetail && poDetail.statusId === "ORDER_LOCKED") {
                                const items = (poDetail.orderItemList || []).map((l: any) => ({
                                    productId: l.productId || "?",
                                    quantityOrdered: l.quantityOrdered || 0,
                                    quantityReceived: l.quantityReceived || 0,
                                }));
                                const totalReceived = items.reduce((s: number, i: any) => s + i.quantityReceived, 0);
                                if (totalReceived === 0) {
                                    results.push({
                                        orderId: o.orderId,
                                        vendorName: o.vendor || poDetail.vendor || null,
                                        statusId: "ORDER_LOCKED",
                                        expectedReceiveDate: o.expectedReceiveDate,
                                        orderDate: o.orderDate || poDetail.orderDate || null,
                                        items,
                                        totalAmount: poDetail.orderItemListTotal || 0,
                                        vendorEmail: null,
                                        vendorPartyId: null,
                                    });
                                }
                            }
                        }
                    }
                }
                return results;
            }
            console.warn(`[po-overdue] Finale query failed: ${res.status}`);
            return [];
        }

        const data = await res.json() as any;
        const rows = data.results || [];

        for (const row of rows) {
            if (!row.expectedReceiveDate) continue;
            const expDate = new Date(row.expectedReceiveDate);
            if (expDate >= cutoff) continue;

            // Load full details to check received qty
            try {
                const poDetail = await (finale as any).getOrderDetails(row.orderId);
                const items = (poDetail.orderItemList || []).map((l: any) => ({
                    productId: l.productId || "?",
                    quantityOrdered: l.quantityOrdered || 0,
                    quantityReceived: l.quantityReceived || 0,
                }));
                const totalReceived = items.reduce((s: number, i: any) => s + i.quantityReceived, 0);
                if (totalReceived === 0) {
                    results.push({
                        orderId: row.orderId,
                        vendorName: row.vendor || poDetail.vendor || null,
                        statusId: "ORDER_LOCKED",
                        expectedReceiveDate: row.expectedReceiveDate,
                        orderDate: row.orderDate || poDetail.orderDate || null,
                        items,
                        totalAmount: poDetail.orderItemListTotal || 0,
                        vendorEmail: null,
                        vendorPartyId: null,
                    });
                }
            } catch {
                // Skip POs that fail detail load
            }
        }
    } catch (err: any) {
        console.warn(`[po-overdue] findOverduePOs error: ${err.message}`);
    }

    // Sort by most overdue first
    results.sort((a, b) => {
        const dA = a.expectedReceiveDate ? new Date(a.expectedReceiveDate).getTime() : 0;
        const dB = b.expectedReceiveDate ? new Date(b.expectedReceiveDate).getTime() : 0;
        return dA - dB;
    });

    return results.slice(0, MAX_DRAFTS_PER_RUN);
}

// ── Gmail Search ──────────────────────────────────────────────────────────

/**
 * Search Gmail for inbound emails mentioning this PO number.
 * Returns message metadata (headers + snippet).
 */
async function searchInboundForPO(
    gmail: ReturnType<typeof GmailApi>,
    poNumber: string,
): Promise<any[]> {
    const digits = poNumber.replace(/^PO[-\s]*/i, "");
    try {
        const res = await gmail.users.messages.list({
            userId: "me",
            q: `${digits} newer_than:${EMAIL_SEARCH_DAYS}d -from:buildasoil.com`,
            maxResults: 5,
        });

        const messages = res.data.messages || [];
        const enriched: any[] = [];

        for (const m of messages) {
            const msg = await gmail.users.messages.get({
                userId: "me",
                id: m.id,
                format: "metadata",
                metadataHeaders: ["Subject", "From", "Date"],
            });
            enriched.push(msg.data);
        }

        return enriched;
    } catch {
        return [];
    }
}

/**
 * Find the original outbound PO email thread.
 * Returns thread anchor info for reply threading.
 */
async function findPOThread(
    gmail: ReturnType<typeof GmailApi>,
    poNumber: string,
): Promise<{ threadId: string; messageId: string; subject: string; sentAt: Date; vendorEmail: string | null } | null> {
    const digits = poNumber.replace(/^PO[-\s]*/i, "");
    try {
        const res = await gmail.users.messages.list({
            userId: "me",
            q: `(subject:"PO #${digits}" OR subject:"PO ${digits}" OR subject:"Purchase Order ${digits}")`,
            maxResults: 10,
        });

        const messages = res.data.messages || [];

        for (const m of messages) {
            const thread = await gmail.users.threads.get({
                userId: "me",
                id: m.threadId || "",
                format: "metadata",
                metadataHeaders: ["Subject", "To", "From", "Date", "Message-ID"],
            });

            // Find the outbound PO message
            const threadMessages = thread.data.messages || [];
            for (const tm of threadMessages) {
                const headers: Record<string, string> = {};
                for (const h of (tm.payload?.headers || [])) {
                    headers[h.name!] = h.value!;
                }

                const from = headers["From"] || "";
                const isOutbound =
                    from.includes("buildasoil.com") ||
                    from.includes("finaleinventory.com") ||
                    from.includes("noreply");

                if (!isOutbound) continue;

                // Extract vendor email from To: header
                const to = headers["To"] || "";
                const vendorMatch = to.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
                const vendorEmail = vendorMatch
                    ? vendorMatch[0]
                    : null;

                return {
                    threadId: m.threadId!,
                    messageId: headers["Message-ID"] || m.id!,
                    subject: headers["Subject"] || `PO #${digits}`,
                    sentAt: new Date(headers["Date"] || Date.now()),
                    vendorEmail: vendorEmail && !vendorEmail.includes("buildasoil.com")
                        ? vendorEmail
                        : null,
                };
            }
        }
    } catch {
        // Silent fall-through
    }

    return null;
}

// ── Vendor Email Resolution ───────────────────────────────────────────────

/**
 * Resolve vendor contact email from multiple sources, priority order:
 *   1. Thread's To: header (if Finale sent the PO)
 *   2. Inbound emails' From: header (vendor replied to us)
 *   3. Vendor profiles table (via po-sender lookup)
 */
function resolveVendorEmail(
    po: OverduePO,
    thread: { vendorEmail: string | null } | null,
    inboundEmails: any[],
): string | null {
    const blocked = (email: string) =>
        email.includes("buildasoil.com") ||
        email.includes("finaleinventory.com") ||
        email.includes("noreply");

    // Priority 1: Thread To: header
    if (thread?.vendorEmail && !blocked(thread.vendorEmail)) {
        return thread.vendorEmail;
    }

    // Priority 2: Inbound email From: header
    for (const msg of inboundEmails) {
        const fromHeader = (msg.payload?.headers || []).find(
            (h: any) => h.name === "From",
        )?.value || "";
        const emailMatch = fromHeader.match(/([\w.+-]+@[\w-]+\.[\w.-]+)/);
        if (emailMatch && !blocked(emailMatch[1])) {
            return emailMatch[1];
        }
    }

    // Priority 3: Already resolved on the PO
    if (po.vendorEmail && !blocked(po.vendorEmail)) {
        return po.vendorEmail;
    }

    return null;
}

// ── Email Draft ───────────────────────────────────────────────────────────

/**
 * Draft a polite overdue follow-up email in the PO thread.
 * Tone: casual, direct — "Hey, checking on PO X, it was due Y. Any update?"
 */
async function draftOverdueFollowup(
    gmail: ReturnType<typeof GmailApi>,
    po: OverduePO,
    thread: { threadId: string; messageId: string; subject: string; sentAt: Date },
    vendorEmail: string,
    daysOverdue: number,
): Promise<boolean> {
    const itemSummary = po.items
        .map(i => `${i.productId} (qty ${i.quantityOrdered})`)
        .join(", ") || `${po.items.length} item(s)`;

    const expected = po.expectedReceiveDate
        ? new Date(po.expectedReceiveDate).toLocaleDateString("en-US", {
            month: "long", day: "numeric",
        })
        : "TBD";

    const body = [
        `Hi,`,
        ``,
        `Checking in on PO #${po.orderId} — it was expected ${expected} (${daysOverdue} days ago).`,
        `We haven't received tracking or a ship date yet.`,
        ``,
        `Items: ${itemSummary}`,
        ``,
        `Could you let me know the status and an updated ETA?`,
        ``,
        `Thanks!`,
        `Bill`,
    ].join("\r\n");

    const rawEmail = [
        `From: bill.selee@buildasoil.com`,
        `To: ${vendorEmail}`,
        `Subject: Re: ${thread.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
        `In-Reply-To: ${thread.messageId}`,
        `References: ${thread.messageId}`,
        ``,
        body,
    ].join("\r\n");

    try {
        await gmail.users.drafts.create({
            userId: "me",
            requestBody: {
                message: {
                    raw: Buffer.from(rawEmail).toString("base64url"),
                    threadId: thread.threadId,
                },
            },
        });
        console.log(`[po-overdue] Drafted follow-up for PO ${po.orderId} → ${vendorEmail}`);
        return true;
    } catch (err: any) {
        console.warn(`[po-overdue] Draft failed for PO ${po.orderId}: ${err.message}`);
        return false;
    }
}

// ── Telegram Summary ──────────────────────────────────────────────────────

async function sendTgSummary(
    overduePOs: OverduePO[],
    results: FollowupResult[],
): Promise<void> {
    const drafted = results.filter(r => r.action === "drafted");
    const emailFound = results.filter(r => r.action === "email_found");
    const noEmail = results.filter(r => r.action === "no_email");
    const skipped = results.filter(r => r.action === "skipped" || r.action === "thread_missing");

    const lines: string[] = [];
    lines.push(`⚠️ ${overduePOs.length} overdue PO(s):`);
    lines.push("");

    for (const po of overduePOs.sort((a, b) => {
        const dA = a.expectedReceiveDate ? new Date(a.expectedReceiveDate).getTime() : 0;
        const dB = b.expectedReceiveDate ? new Date(b.expectedReceiveDate).getTime() : 0;
        return dA - dB;
    })) {
        const result = results.find(r => r.orderId === po.orderId);
        const daysOverdue = po.expectedReceiveDate
            ? Math.floor((Date.now() - new Date(po.expectedReceiveDate).getTime()) / 86_400_000)
            : 0;
        const vendor = po.vendorName || "?";
        const items = po.items.map(i => i.productId).join(", ");
        const icon =
            result?.action === "drafted" ? "📝" :
            result?.action === "email_found" ? "📧" :
            result?.action === "no_email" ? "❓" : "⏸";

        lines.push(`${icon} PO ${po.orderId} — ${vendor} (${daysOverdue}d overdue)`);
        lines.push(`   Expected: ${po.expectedReceiveDate?.slice(0, 10) || "?"}`);
        lines.push(`   Items: ${items}`);

        if (result?.action === "drafted") {
            lines.push(`   → Draft reply in Gmail`);
        } else if (result?.action === "email_found") {
            lines.push(`   → Vendor has replied (check inbox)`);
        } else if (result?.action === "no_email") {
            lines.push(`   → No vendor email found — draft it manually`);
        }
    }

    lines.push("");
    const counts = `Drafted: ${drafted.length} | Vendor replied: ${emailFound.length} | Need manual: ${noEmail.length + skipped.length}`;
    lines.push(counts);

    await sendTelegramNotify(lines.join("\n")).catch(() => {});
}

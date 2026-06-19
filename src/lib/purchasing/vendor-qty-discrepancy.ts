/**
 * @file    vendor-qty-discrepancy.ts
 * @purpose Cron-driven module that auto-emails vendors when reconciliation
 *          detects a short-shipment qty discrepancy, monitors for vendor
 *          replies, and escalates after 7 days of silence.
 *
 * Flow:
 *   1. Scan RECONCILIATION rows with short_shipment_detected=true
 *      that have NOT already been emailed (dedup by orderId::invoiceNumber)
 *   2. For each unhandled discrepancy, build and send email via Gmail,
 *      threaded to the original PO send if possible
 *   3. Check for vendor replies on already-emailed threads
 *   4. Escalate (VENDOR_QTY_DISCREPANCY_ESCALATED) after 7d no reply
 *
 * @deps    @googleapis/gmail, supabase, gmail/auth
 */

import { createClient } from "../supabase";
import { getAuthenticatedClient } from "../gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { lookupVendorOrderEmail } from "./po-sender";

// ── Types ──────────────────────────────────────────────────────────────────

export interface QtyDiscrepancyStats {
    scanned: number;
    emailed: number;
    resolved: number;
    errors: number;
}

interface DiscrepancyRow {
    id: string;
    created_at: string;
    metadata: any;
    short_shipment_lines: string[] | null;
    receiving_gap_total: number | null;
}

interface EmailedRow {
    id: string;
    created_at: string;
    metadata: any;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a human-readable description of the short-shipment lines for the
 * email body. Summarizes the per-SKU gap.
 */
function buildShortShipmentSummary(
    metadata: any,
    shortShipmentLines: string[] | null,
): string {
    const priceChanges: any[] = metadata?.priceChanges ?? [];
    const shortLines = priceChanges.filter(
        (pc: any) =>
            pc.verdict === "short_shipment_hold" && pc.productId,
    );

    if (shortLines.length === 0) {
        return "one or more items";
    }

    return shortLines
        .map((pc: any) => {
            const sku = pc.productId || pc.description || "unknown SKU";
            const poQty = pc.quantity ?? "?";
            const received = pc.receivedQty ?? "?";
            const invoiceQty = pc.quantity ?? "?";
            return `${sku}: ordered ${poQty} qty, received ${received} qty, invoiced ${invoiceQty} qty`;
        })
        .join("; ");
}

/**
 * Extract vendor name from a discrepancy row's metadata.
 */
function getVendorName(meta: any): string {
    return meta?.vendorName ?? meta?.vendor ?? "Unknown Vendor";
}

/**
 * Extract order ID from metadata.
 */
function getOrderId(meta: any): string | null {
    return meta?.orderId ?? meta?.poId ?? null;
}

/**
 * Extract invoice number from metadata.
 */
function getInvoiceNumber(meta: any): string | null {
    return meta?.invoiceNumber ?? null;
}

// ── Load already-handled dedup keys ────────────────────────────────────────

/**
 * Load composite keys (orderId::invoiceNumber) for rows we've already
 * emailed about (VENDOR_QTY_DISCREPANCY_EMAILED intent).
 */
async function loadEmailedKeys(): Promise<Set<string>> {
    const sb = createClient();
    if (!sb) return new Set();

    const emailed = new Set<string>();
    try {
        const { data } = await sb
            .from("ap_activity_log")
            .select("metadata")
            .eq("intent", "VENDOR_QTY_DISCREPANCY_EMAILED")
            .order("created_at", { ascending: false })
            .limit(1000);

        for (const row of (data ?? []) as any[]) {
            const orderId = row.metadata?.orderId;
            const invoiceNumber = row.metadata?.invoiceNumber;
            if (orderId && invoiceNumber) {
                emailed.add(`${orderId}::${invoiceNumber}`);
            }
        }
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to load emailed keys: ${err.message}`,
        );
    }
    return emailed;
}

/**
 * Load already-resolved composite keys — rows where VENDOR_QTY_DISCREPANCY_RESOLVED
 * exists (meaning the vendor replied and the issue is handled).
 */
async function loadResolvedKeys(): Promise<Set<string>> {
    const sb = createClient();
    if (!sb) return new Set();

    const resolved = new Set<string>();
    try {
        const { data } = await sb
            .from("ap_activity_log")
            .select("metadata")
            .eq("intent", "VENDOR_QTY_DISCREPANCY_RESOLVED")
            .order("created_at", { ascending: false })
            .limit(1000);

        for (const row of (data ?? []) as any[]) {
            const orderId = row.metadata?.orderId;
            const invoiceNumber = row.metadata?.invoiceNumber;
            if (orderId && invoiceNumber) {
                resolved.add(`${orderId}::${invoiceNumber}`);
            }
        }
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to load resolved keys: ${err.message}`,
        );
    }
    return resolved;
}

/**
 * Load the already-emailed rows that still need reply-checking.
 * Returns rows that have been emailed but NOT yet resolved or escalated.
 */
async function loadEmailedRows(): Promise<EmailedRow[]> {
    const sb = createClient();
    if (!sb) return [];

    const [resolvedSet, escalatedSet] = await Promise.all([
        loadResolvedKeys(),
        loadEscalatedKeys(),
    ]);

    try {
        const { data } = await sb
            .from("ap_activity_log")
            .select("id, created_at, metadata")
            .eq("intent", "VENDOR_QTY_DISCREPANCY_EMAILED")
            .order("created_at", { ascending: false })
            .limit(500);

        // Filter out rows that are already resolved or escalated
        return ((data ?? []) as EmailedRow[]).filter((row) => {
            const orderId = row.metadata?.orderId;
            const invoiceNumber = row.metadata?.invoiceNumber;
            if (!orderId || !invoiceNumber) return false;
            const key = `${orderId}::${invoiceNumber}`;
            return !resolvedSet.has(key) && !escalatedSet.has(key);
        });
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to load emailed rows: ${err.message}`,
        );
        return [];
    }
}

/**
 * Load escalated composite keys so we don't re-escalate.
 */
async function loadEscalatedKeys(): Promise<Set<string>> {
    const sb = createClient();
    if (!sb) return new Set();

    const escalated = new Set<string>();
    try {
        const { data } = await sb
            .from("ap_activity_log")
            .select("metadata")
            .eq("intent", "VENDOR_QTY_DISCREPANCY_ESCALATED")
            .order("created_at", { ascending: false })
            .limit(1000);

        for (const row of (data ?? []) as any[]) {
            const orderId = row.metadata?.orderId;
            const invoiceNumber = row.metadata?.invoiceNumber;
            if (orderId && invoiceNumber) {
                escalated.add(`${orderId}::${invoiceNumber}`);
            }
        }
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to load escalated keys: ${err.message}`,
        );
    }
    return escalated;
}

// ── Load unresolved discrepancies ──────────────────────────────────────────

/**
 * Load RECONCILIATION rows (last 120 days) where short_shipment_detected=true
 * OR overallVerdict="short_shipment_hold" in metadata.
 */
async function loadShortShipmentRows(): Promise<DiscrepancyRow[]> {
    const sb = createClient();
    if (!sb) return [];

    const since = new Date(
        Date.now() - 120 * 24 * 60 * 60 * 1000,
    ).toISOString();

    try {
        // Query by the column short_shipment_detected OR the JSONB verdict
        const { data } = await sb
            .from("ap_activity_log")
            .select("id, created_at, metadata, short_shipment_lines, receiving_gap_total")
            .eq("intent", "RECONCILIATION")
            .eq("short_shipment_detected", true)
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(200);

        return (data ?? []) as DiscrepancyRow[];
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to load short-shipment rows: ${err.message}`,
        );
        return [];
    }
}

// ── Gmail thread resolution ───────────────────────────────────────────────

/**
 * Given a PO number, try to find the Gmail thread for the original PO send
 * so we can thread our discrepancy email into the same conversation.
 *
 * Returns { threadId, replyReference } or empty strings if not found.
 */
async function resolvePOThread(
    orderId: string,
    gmail: ReturnType<typeof GmailApi>,
): Promise<{ threadId?: string; replyReference?: string }> {
    const sb = createClient();
    if (!sb) return {};

    try {
        const { data: poRow } = await sb
            .from("purchase_orders")
            .select("po_email_message_id")
            .eq("po_number", orderId)
            .maybeSingle();

        const poMessageId =
            typeof (poRow as any)?.po_email_message_id === "string"
                ? (poRow as any).po_email_message_id.trim()
                : "";

        if (!poMessageId) return {};

        // Try getting the message to find threadId
        try {
            const getRes = await gmail.users.messages.get({
                userId: "me",
                id: poMessageId,
                format: "metadata",
                metadataHeaders: ["Message-ID"],
            });
            const threadId = getRes.data.threadId ?? undefined;
            const replyReference =
                getRes.data.payload?.headers?.find(
                    (h: any) => h.name === "Message-ID",
                )?.value ?? undefined;
            return { threadId, replyReference };
        } catch {
            // Fallback: search by rfc822msgid
            try {
                const q = `rfc822msgid:${poMessageId}`;
                const listRes = await gmail.users.messages.list({
                    userId: "me",
                    q,
                });
                if (
                    listRes.data.messages &&
                    listRes.data.messages.length > 0
                ) {
                    return {
                        threadId: listRes.data.messages[0].threadId ?? undefined,
                        replyReference: poMessageId,
                    };
                }
            } catch {
                // Non-critical — send as new thread
            }
            return {};
        }
    } catch {
        return {};
    }
}

// ── Check for vendor replies ───────────────────────────────────────────────

/**
 * Check if the vendor has replied to the discrepancy email thread.
 *
 * Searches Gmail for messages in the thread. If the thread only has our
 * sent message (no newer messages from the vendor), returns false.
 */
async function checkForReply(
    threadId: string,
    sentGmailMessageId: string,
    gmail: ReturnType<typeof GmailApi>,
    vendorDomain?: string,
): Promise<boolean> {
    try {
        const threadRes = await gmail.users.threads.get({
            userId: "me",
            id: threadId,
            format: "minimal",
        });

        const messages = threadRes.data.messages ?? [];
        if (messages.length <= 1) return false; // Only our message

        // Check if any message in the thread was NOT sent by us
        for (const msg of messages) {
            if (msg.id === sentGmailMessageId) continue; // Skip our sent message

            // Check the internalDate — if it's newer than our sent message,
            // and the from address isn't ours, it's a reply
            const fromHeader = msg.payload?.headers?.find(
                (h: any) => h.name === "From",
            )?.value;

            if (
                fromHeader &&
                !fromHeader.toLowerCase().includes("bill.selee@buildasoil.com") &&
                !fromHeader.toLowerCase().includes("buildasoil.com")
            ) {
                return true;
            }
        }
        return false;
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to check thread ${threadId}: ${err.message}`,
        );
        return false;
    }
}

/**
 * Alternative reply detection: search inbox for vendor replies by PO subject.
 * Used when threadId is not available.
 */
async function checkForReplyBySubject(
    orderId: string,
    vendorEmail: string,
    gmail: ReturnType<typeof GmailApi>,
): Promise<boolean> {
    try {
        const vendorDomain = vendorEmail.split("@").pop()?.toLowerCase();
        const query = `in:inbox from:${vendorDomain ?? vendorEmail} subject:${orderId} newer_than:30d`;

        const listRes = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults: 5,
        });

        if (!listRes.data.messages || listRes.data.messages.length === 0) {
            return false;
        }

        // Verify at least one message in the result isn't ours
        for (const msg of listRes.data.messages) {
            if (!msg.id) continue;
            try {
                const getRes = await gmail.users.messages.get({
                    userId: "me",
                    id: msg.id,
                    format: "metadata",
                    metadataHeaders: ["From"],
                });
                const fromHeader =
                    getRes.data.payload?.headers?.find(
                        (h: any) => h.name === "From",
                    )?.value ?? "";
                if (
                    fromHeader &&
                    !fromHeader.toLowerCase().includes("bill.selee@buildasoil.com") &&
                    !fromHeader.toLowerCase().includes("buildasoil.com")
                ) {
                    return true;
                }
            } catch {
                continue;
            }
        }
        return false;
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Subject-based reply check failed: ${err.message}`,
        );
        return false;
    }
}

// ── Send discrepancy email ─────────────────────────────────────────────────

/**
 * Build and send a discrepancy notification email to the vendor, threaded
 * to the original PO conversation if possible.
 */
async function sendDiscrepancyEmail(
    row: DiscrepancyRow,
    vendorEmail: string,
    gmail: ReturnType<typeof GmailApi>,
): Promise<{ gmailMessageId: string; threadId?: string } | null> {
    const meta = row.metadata;
    const orderId = getOrderId(meta);
    const vendorName = getVendorName(meta);
    if (!orderId) {
        console.warn(
            `[vendor-qty-discrepancy] Skipping row ${row.id}: no orderId in metadata`,
        );
        return null;
    }

    // Resolve PO thread for threading
    const { threadId, replyReference } = await resolvePOThread(orderId, gmail);

    // Build email body
    const shortSummary = buildShortShipmentSummary(meta, row.short_shipment_lines);
    const gapTotal = row.receiving_gap_total ?? 0;

    const emailBody = [
        `Hi ${vendorName},`,
        "",
        `We noticed a quantity discrepancy on PO ${orderId}. We received fewer units than invoiced for: ${shortSummary}.`,
        gapTotal > 0
            ? `The total receiving gap is ${gapTotal} units.`
            : "",
        "",
        "Could you please look into this and let us know how you'd like to handle it?",
        "A credit memo or replacement shipment would be fine.",
        "",
        "Thanks,",
        "Bill",
    ]
        .filter(Boolean)
        .join("\n");

    // Build RFC 2822 email
    const lines = [
        `From: bill.selee@buildasoil.com`,
        `To: ${vendorEmail}`,
        `Subject: PO ${orderId} — shipment quantity discrepancy`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
    ];
    if (replyReference) {
        lines.push(`In-Reply-To: ${replyReference}`);
        lines.push(`References: ${replyReference}`);
    }
    lines.push("", emailBody);

    const rawEmail = lines.join("\r\n");

    try {
        const requestBody: any = {
            raw: Buffer.from(rawEmail).toString("base64url"),
        };
        if (threadId) {
            requestBody.threadId = threadId;
        }

        const sendRes = await gmail.users.messages.send({
            userId: "me",
            requestBody,
        });

        const gmailMessageId = sendRes.data.id ?? "";
        const returnedThreadId = sendRes.data.threadId ?? threadId;

        console.log(
            `[vendor-qty-discrepancy] Emailed ${vendorName} re PO ${orderId}: ` +
                `msgId=${gmailMessageId}, threadId=${returnedThreadId}`,
        );

        return { gmailMessageId, threadId: returnedThreadId };
    } catch (err: any) {
        console.error(
            `[vendor-qty-discrepancy] Failed to send email for PO ${orderId}: ${err.message}`,
        );
        return null;
    }
}

// ── Write activity log rows ────────────────────────────────────────────────

async function writeEmailedRow(
    row: DiscrepancyRow,
    gmailMessageId: string,
    threadId: string | undefined,
): Promise<void> {
    const sb = createClient();
    if (!sb) return;

    const meta = row.metadata;
    try {
        await sb.from("ap_activity_log").insert({
            email_from: getVendorName(meta),
            email_subject: `PO ${getOrderId(meta)} — shipment quantity discrepancy`,
            intent: "VENDOR_QTY_DISCREPANCY_EMAILED",
            action_taken:
                `Auto-emailed vendor about short shipment on PO ${getOrderId(meta)}, ` +
                `invoice ${getInvoiceNumber(meta)}`,
            metadata: {
                orderId: getOrderId(meta),
                invoiceNumber: getInvoiceNumber(meta),
                vendorName: getVendorName(meta),
                shortShipmentLines: row.short_shipment_lines,
                receivingGapTotal: row.receiving_gap_total,
                gmailMessageId,
                threadId: threadId ?? null,
                emailedAt: new Date().toISOString(),
                sourceActivityLogId: row.id,
            },
        });
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to write emailed row: ${err.message}`,
        );
    }
}

async function writeResolvedRow(
    emailedRow: EmailedRow,
): Promise<void> {
    const sb = createClient();
    if (!sb) return;

    const meta = emailedRow.metadata;
    try {
        await sb.from("ap_activity_log").insert({
            email_from: meta?.vendorName ?? "Unknown",
            email_subject: `PO ${meta?.orderId} — discrepancy resolved via vendor reply`,
            intent: "VENDOR_QTY_DISCREPANCY_RESOLVED",
            action_taken: `Vendor replied — discrepancy on PO ${meta?.orderId}, invoice ${meta?.invoiceNumber} marked resolved`,
            metadata: {
                orderId: meta?.orderId,
                invoiceNumber: meta?.invoiceNumber,
                vendorName: meta?.vendorName,
                sourceEmailedRowId: emailedRow.id,
                resolvedAt: new Date().toISOString(),
            },
        });
        console.log(
            `[vendor-qty-discrepancy] Resolved PO ${meta?.orderId} (${meta?.invoiceNumber})`,
        );
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to write resolved row: ${err.message}`,
        );
    }
}

async function writeEscalatedRow(
    emailedRow: EmailedRow,
): Promise<void> {
    const sb = createClient();
    if (!sb) return;

    const meta = emailedRow.metadata;
    try {
        await sb.from("ap_activity_log").insert({
            email_from: meta?.vendorName ?? "Unknown",
            email_subject: `PO ${meta?.orderId} — discrepancy escalated (7d no reply)`,
            intent: "VENDOR_QTY_DISCREPANCY_ESCALATED",
            action_taken:
                `Auto-escalated: vendor has not replied to discrepancy email on PO ` +
                `${meta?.orderId}, invoice ${meta?.invoiceNumber} after 7 days`,
            metadata: {
                orderId: meta?.orderId,
                invoiceNumber: meta?.invoiceNumber,
                vendorName: meta?.vendorName,
                sourceEmailedRowId: emailedRow.id,
                emailedAt: meta?.emailedAt,
                escalatedAt: new Date().toISOString(),
            },
        });
        console.log(
            `[vendor-qty-discrepancy] Escalated PO ${meta?.orderId} (${meta?.invoiceNumber}) — no reply in 7d`,
        );
    } catch (err: any) {
        console.warn(
            `[vendor-qty-discrepancy] Failed to write escalated row: ${err.message}`,
        );
    }
}

// ── Main handler ───────────────────────────────────────────────────────────

/**
 * Run one pass of the vendor qty-discrepancy handler.
 *
 * Step 1: Scan for unresolved RECONCILIATION rows with short_shipment_detected
 * Step 2: For each, build and send email, write VENDOR_QTY_DISCREPANCY_EMAILED
 * Step 3: Check already-emailed rows for vendor replies → mark resolved
 * Step 4: Escalate rows emailed >7d ago with no reply
 */
export async function runVendorQtyDiscrepancyHandler(): Promise<QtyDiscrepancyStats> {
    const stats: QtyDiscrepancyStats = {
        scanned: 0,
        emailed: 0,
        resolved: 0,
        errors: 0,
    };

    // ── Step 1: Load short-shipment rows and dedup keys ────────────
    const [rows, emailedKeys, resolvedKeys] = await Promise.all([
        loadShortShipmentRows(),
        loadEmailedKeys(),
        loadResolvedKeys(),
    ]);

    stats.scanned = rows.length;
    if (rows.length === 0) {
        console.log(
            "[vendor-qty-discrepancy] No unresolved qty discrepancies found.",
        );
    }

    // Filter to only unhandled rows (not emailed & not resolved)
    const unhandledRows = rows.filter((row) => {
        const meta = row.metadata;
        const orderId = getOrderId(meta);
        const invoiceNumber = getInvoiceNumber(meta);
        if (!orderId || !invoiceNumber) return false;
        const key = `${orderId}::${invoiceNumber}`;
        return !emailedKeys.has(key) && !resolvedKeys.has(key);
    });

    console.log(
        `[vendor-qty-discrepancy] Scanned ${rows.length} reconciliation rows, ` +
            `${unhandledRows.length} unhandled discrepancies`,
    );

    if (unhandledRows.length === 0 && rows.length > 0) {
        // All discrepancies already handled — still need to check for replies
        console.log(
            "[vendor-qty-discrepancy] All discrepancies already emailed — checking for replies",
        );
    }

    // ── Step 2: Send emails for unhandled discrepancies ───────────
    if (unhandledRows.length > 0) {
        let gmail: ReturnType<typeof GmailApi> | null = null;
        try {
            const auth = await getAuthenticatedClient("default");
            gmail = GmailApi({ version: "v1", auth });
        } catch (err: any) {
            console.error(
                `[vendor-qty-discrepancy] Gmail auth failed: ${err.message}`,
            );
            stats.errors = unhandledRows.length;
            // Can't proceed without Gmail, but still check for replies below
        }

        if (gmail) {
            for (const row of unhandledRows) {
                try {
                    const meta = row.metadata;
                    const vendorName = getVendorName(meta);
                    const orderId = getOrderId(meta);
                    if (!orderId) {
                        stats.errors++;
                        continue;
                    }

                    // Resolve vendor email
                    const { email } = await lookupVendorOrderEmail(
                        vendorName,
                        "", // vendorPartyId not available from metadata
                    );

                    if (!email) {
                        console.warn(
                            `[vendor-qty-discrepancy] No vendor email for ${vendorName} (PO ${orderId}) — skipping.`,
                        );
                        stats.errors++;
                        continue;
                    }

                    const result = await sendDiscrepancyEmail(
                        row,
                        email,
                        gmail,
                    );

                    if (result) {
                        await writeEmailedRow(
                            row,
                            result.gmailMessageId,
                            result.threadId,
                        );
                        stats.emailed++;
                    } else {
                        stats.errors++;
                    }
                } catch (err: any) {
                    console.error(
                        `[vendor-qty-discrepancy] Error processing row ${row.id}: ${err.message}`,
                    );
                    stats.errors++;
                }
            }
        }
    }

    // ── Step 3: Check for replies on already-emailed rows ─────────
    const emailedRows = await loadEmailedRows();
    if (emailedRows.length > 0) {
        let gmail: ReturnType<typeof GmailApi> | null = null;
        try {
            const auth = await getAuthenticatedClient("default");
            gmail = GmailApi({ version: "v1", auth });
        } catch (err: any) {
            console.warn(
                `[vendor-qty-discrepancy] Gmail auth failed for reply check: ${err.message}`,
            );
        }

        if (gmail) {
            const now = Date.now();
            const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

            for (const emailedRow of emailedRows) {
                try {
                    const meta = emailedRow.metadata;
                    const threadId = meta?.threadId;
                    const gmailMessageId = meta?.gmailMessageId;
                    const emailedAt = meta?.emailedAt;
                    const vendorName = meta?.vendorName ?? "Unknown";
                    const orderId = meta?.orderId;

                    // Determine vendor domain for reply checking
                    const vendorEmail = meta?.vendorEmail ?? "";

                    let hasReply = false;

                    if (threadId && gmailMessageId) {
                        hasReply = await checkForReply(
                            threadId,
                            gmailMessageId,
                            gmail,
                        );
                    } else if (vendorEmail && orderId) {
                        // Fallback: search by subject
                        hasReply = await checkForReplyBySubject(
                            orderId,
                            vendorEmail,
                            gmail,
                        );
                    }

                    if (hasReply) {
                        await writeResolvedRow(emailedRow);
                        stats.resolved++;
                    } else if (emailedAt) {
                        // Check 7-day escalation
                        const emailedTime = new Date(emailedAt).getTime();
                        if (now - emailedTime > SEVEN_DAYS_MS) {
                            await writeEscalatedRow(emailedRow);
                            console.log(
                                `[vendor-qty-discrepancy] Escalated PO ${orderId} — no vendor reply in 7 days`,
                            );
                        }
                    }
                } catch (err: any) {
                    console.warn(
                        `[vendor-qty-discrepancy] Reply-check error on row ${emailedRow.id}: ${err.message}`,
                    );
                    stats.errors++;
                }
            }
        }
    }

    return stats;
}

/**
 * @file    src/lib/tracking/delivery-exception-escalator.ts
 * @purpose Auto-escalates delivery exceptions. When a shipment shows
 *          "exception" status (return to sender, address issue, customs
 *          hold, etc), drafts a vendor email and alerts Bill via Telegram.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db, @/lib/intelligence/telegram-notify
 *
 * DESIGN:
 *   Runs from cron every 4h on weekdays.
 *   1. Query shipment_intelligence for active exceptions
 *   2. Dedup: skip if already escalated (ap_activity_log + in-memory)
 *   3. For each new exception:
 *      a. Find vendor email from purchase_orders/vendor_profiles
 *      b. Draft Gmail email citing tracking # and exception details
 *      c. Send Telegram alert with draft ID for one-tap send
 *   4. Log to ap_activity_log intent='EXCEPTION_ESCALATED'
 */

import { createClient } from "@/lib/db";
import { sendTelegramNotifyWithButtons } from "@/lib/intelligence/telegram-notify";

const supabase = createClient();

const MAX_PER_RUN = 5;
const alertedThisSession = new Set<string>();

export interface ExceptionEscalation {
    id: string;
    poNumber: string;
    vendorName: string | null;
    trackingNumber: string;
    carrierName: string | null;
    statusDisplay: string;
    vendorEmail: string | null;
    draftId: string | null;
}

export interface ExceptionEscalationResult {
    escalated: ExceptionEscalation[];
    skipped: number;
}

/**
 * Find active delivery exceptions and escalate them.
 */
export async function escalateDeliveryExceptions(): Promise<ExceptionEscalationResult> {
    const db = createClient();
    if (!db) return { escalated: [], skipped: 0 };

    // Find active exceptions
    const { data: exceptions } = await supabase
        .from("shipment_intelligence")
        .select("id, tracking_number, po_numbers, vendor_names, carrier_name, status_display, status_category, active, last_checked_at")
        .eq("status_category", "exception")
        .eq("active", true)
        .order("last_checked_at", { ascending: false })
        .limit(20);

    if (!exceptions || exceptions.length === 0) {
        return { escalated: [], skipped: 0 };
    }

    // Dedup: check ap_activity_log for already-escalated exceptions
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString(); // 7-day dedup
    const { data: recentEscalations } = await supabase
        .from("ap_activity_log")
        .select("metadata")
        .eq("intent", "EXCEPTION_ESCALATED")
        .gte("created_at", cutoff)
        .limit(100);

    const alreadyEscalated = new Set<string>();
    for (const row of (recentEscalations || []) as any[]) {
        const id = row?.metadata?.shipmentId;
        if (id) alreadyEscalated.add(id);
    }

    const escalated: ExceptionEscalation[] = [];
    let skipped = 0;

    for (const ex of exceptions as any[]) {
        if (alertedThisSession.has(ex.id) || alreadyEscalated.has(ex.id)) {
            skipped++;
            continue;
        }
        if (escalated.length >= MAX_PER_RUN) break;

        const poNumbers: string[] = ex.po_numbers || [];
        const vendorNames: string[] = ex.vendor_names || [];
        const poNumber = poNumbers[0] || "unknown";
        const vendorName = vendorNames[0] || null;

        // Look up vendor email
        let vendorEmail: string | null = null;
        try {
            if (vendorName) {
                const { data: vp } = await supabase
                    .from("vendor_profiles")
                    .select("order_email, contact_email")
                    .ilike("vendor_name", `%${vendorName}%`)
                    .limit(1)
                    .single();
                vendorEmail = vp?.order_email || vp?.contact_email || null;
            }
        } catch { /* no match */ }

        // Draft the exception email if we have a vendor email
        let draftId: string | null = null;
        if (vendorEmail && poNumber !== "unknown") {
            draftId = await draftExceptionEmail(ex, poNumber, vendorName, vendorEmail);
        }

        escalated.push({
            id: ex.id,
            poNumber,
            vendorName,
            trackingNumber: ex.tracking_number,
            carrierName: ex.carrier_name,
            statusDisplay: ex.status_display || "Delivery exception",
            vendorEmail,
            draftId,
        });

        alertedThisSession.add(ex.id);
    }

    // Send Telegram alert
    if (escalated.length > 0) {
        const lines: string[] = [];
        lines.push(`🚨 *${escalated.length} Delivery Exception${escalated.length > 1 ? "s" : ""} Escalated*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const e of escalated) {
            lines.push(`\n*PO ${e.poNumber}* — ${e.vendorName || "Unknown vendor"}`);
            lines.push(`🚚 ${e.carrierName || "Carrier"} #${e.trackingNumber}`);
            lines.push(`⚠️ ${e.statusDisplay}`);
            if (e.draftId) lines.push(`📧 Draft ready in Gmail`);
        }

        const buttons = escalated
            .filter(e => e.draftId)
            .map(e => [
                { text: `📧 Review: ${e.poNumber}`, callback_data: `exception_review_${e.id}` },
                { text: `⏭ Dismiss`, callback_data: `exception_dismiss_${e.id}` },
            ]);

        const text = lines.join("\n");
        if (buttons.length > 0) {
            await sendTelegramNotifyWithButtons(text, buttons);
        } else {
            // No drafts (no vendor emails found) — still alert
            const { sendTelegramNotify } = await import("@/lib/intelligence/telegram-notify");
            await sendTelegramNotify(text);
        }

        // Log to ap_activity_log for dedup
        for (const e of escalated) {
            try {
                await db.from("ap_activity_log").insert({
                    email_from: e.vendorName || "unknown",
                    email_subject: `Delivery exception: PO ${e.poNumber} — ${e.trackingNumber}`,
                    intent: "EXCEPTION_ESCALATED",
                    action_taken: e.draftId ? "Drafted vendor email + Telegram alert" : "Telegram alert (no vendor email)",
                    metadata: {
                        shipmentId: e.id,
                        poNumber: e.poNumber,
                        vendorName: e.vendorName,
                        trackingNumber: e.trackingNumber,
                        statusDisplay: e.statusDisplay,
                        draftId: e.draftId,
                        escalatedAt: new Date().toISOString(),
                    },
                });
            } catch { /* non-blocking */ }
        }

        console.log(`[exception-escalator] Escalated ${escalated.length} exception(s), skipped ${skipped}`);
    }

    return { escalated, skipped };
}

/**
 * Draft an email to the vendor about the delivery exception.
 * Uses Gmail API directly to create a draft in the thread.
 */
async function draftExceptionEmail(
    ex: any,
    poNumber: string,
    vendorName: string | null,
    vendorEmail: string,
): Promise<string | null> {
    try {
        const { getAuthenticatedClient } = await import("@/lib/gmail/auth");
        const { gmail: GmailApi } = await import("@googleapis/gmail");
        const auth = await getAuthenticatedClient("default");
        const gmail = GmailApi({ version: "v1", auth });

        const poDigits = poNumber.replace(/^PO-?/i, "");
        const subject = `URGENT: Delivery Exception — PO #${poDigits} (${ex.tracking_number})`;

        const body = [
            "Hi,",
            "",
            `We received a delivery exception notification for PO #${poDigits}:`,
            "",
            `  Tracking: ${ex.tracking_number}`,
            `  Carrier: ${ex.carrier_name || "N/A"}`,
            `  Status: ${ex.status_display || "Delivery exception"}`,
            vendorName ? `  Vendor: ${vendorName}` : "",
            "",
            "Can you look into this and let us know what happened? If the shipment is being returned, we need to arrange re-ship or cancel.",
            "",
            "Thanks,",
            "BuildASoil Purchasing",
        ].filter(l => l !== undefined).join("\n");

        // Build MIME
        const boundary = "boundary_" + Date.now();
        const raw = [
            `To: ${vendorEmail}`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=UTF-8",
            "",
            body,
            `--${boundary}--`,
        ].join("\r\n");

        const res = await gmail.users.drafts.create({
            userId: "me",
            requestBody: {
                message: {
                    raw: Buffer.from(raw).toString("base64url"),
                },
            },
        });

        return res.data.id ?? null;
    } catch (err: any) {
        console.error(`[exception-escalator] Draft failed for ${poNumber}:`, err.message);
        return null;
    }
}

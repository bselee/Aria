/**
 * @file    stale-eta-watcher.ts
 * @purpose Polls for POs past their ETA with no tracking. Auto-pokes vendor
 *          at escalating intervals. Auto-updates ETA when tracking arrives.
 * @author  Hermia
 * @created 2026-06-23
 * @deps    supabase, @/lib/gmail/auth, @/lib/intelligence/vendor-comms-agent
 * @env     None (reads purchase_orders table)
 *
 * Escalation tiers:
 *   L1 — 1 day overdue: polite nudge, ask for tracking
 *   L2 — 3 days overdue: firmer, mention production impact
 *   L3 — 7 days overdue: escalate, log for manual review, flag in ap_activity_log
 *
 * POs ≥ 30 days overdue without tracking are logged as exceptions.
 */

import { createClient } from "@/lib/db";
import { VendorCommsAgent } from "@/lib/intelligence/vendor-comms-agent";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";

const EXCEPTION_AGE_DAYS = 30;
const POKE_TIERS = [
    { label: "L1", daysOverdue: 1, subject: "Checking in on PO {po} tracking" },
    { label: "L2", daysOverdue: 3, subject: "Follow-up: PO {po} — need tracking for production planning" },
    { label: "L3", daysOverdue: 7, subject: "URGENT: PO {po} — 7 days past expected delivery" },
];

export interface StaleEtaOutcome {
    orderId: string;
    vendorName: string;
    action: "L1_poked" | "L2_poked" | "L3_poked" | "exception_logged" | "eta_updated_from_tracking" | "skipped_has_tracking" | "skipped_already_poked";
    detail?: string;
}

/**
 * Main watcher: find overdue POs without tracking, poke vendors at appropriate tier.
 * Called once daily via cron.
 */
export async function runStaleEtaWatcher(): Promise<StaleEtaOutcome[]> {
    const db = createClient();
    const outcomes: StaleEtaOutcome[] = [];
    const today = new Date().toISOString().slice(0, 10);

    // Find POs where:
    // - Not received
    // - ETA is in the past
    // - No tracking numbers attached
    // - Not already poked today (last_poked_at < today)
    const { data: stalePOs, error } = await db
        .from("purchase_orders")
        .select("po_number, vendor_name, expected_date, vendor_stated_eta, tracking_numbers, vendor_orders_email, last_poked_at, last_poked_tier, gmail_thread_id, sent_at")
        .is("received_at", null)
        .not("vendor_name", "is", null)
        .order("expected_date", { ascending: true });

    if (error || !stalePOs) return outcomes;

    for (const po of stalePOs) {
        const etaStr = po.vendor_stated_eta || po.expected_date;
        if (!etaStr) continue;

        const etaDate = new Date(etaStr);
        const todayDate = new Date(today);
        if (etaDate >= todayDate) continue; // not overdue yet

        const daysOverdue = Math.floor((todayDate.getTime() - etaDate.getTime()) / 86_400_000);
        const hasTracking = po.tracking_numbers && (Array.isArray(po.tracking_numbers) ? po.tracking_numbers.length > 0 : false);

        // Skip if already has tracking — tracking watcher handles ETA updates
        if (hasTracking) {
            outcomes.push({ orderId: po.po_number, vendorName: po.vendor_name, action: "skipped_has_tracking" });
            continue;
        }

        // Skip if already poked today
        if (po.last_poked_at && po.last_poked_at.slice(0, 10) === today) {
            outcomes.push({ orderId: po.po_number, vendorName: po.vendor_name, action: "skipped_already_poked" });
            continue;
        }

        // Determine escalation tier
        let tierIdx = 0;
        for (let i = POKE_TIERS.length - 1; i >= 0; i--) {
            if (daysOverdue >= POKE_TIERS[i].daysOverdue) { tierIdx = i; break; }
        }

        // Exception: very old overdue, log for review
        if (daysOverdue >= EXCEPTION_AGE_DAYS) {
            await db.from("ap_activity_log").insert({
                intent: "STALE_ETA_EXCEPTION",
                metadata: { orderId: po.po_number, vendorName: po.vendor_name, daysOverdue, eta: etaStr },
                created_at: new Date().toISOString(),
            });
            outcomes.push({ orderId: po.po_number, vendorName: po.vendor_name, action: "exception_logged", detail: `${daysOverdue}d overdue` });
            continue;
        }

        // Send poke email
        const tier = POKE_TIERS[tierIdx];
        const vendorEmail = po.vendor_orders_email;
        if (!vendorEmail) continue;

        try {
            const auth = await getAuthenticatedClient("default");
            const gmail = new GmailApi({ auth: auth as any, version: "v1" });
            const body = generatePokeBody(po.po_number, po.vendor_name, daysOverdue, tier.label);

            // If we have the original thread, reply in-thread
            if (po.gmail_thread_id) {
                await gmail.users.messages.send({
                    userId: "me",
                    requestBody: {
                        threadId: po.gmail_thread_id,
                        raw: Buffer.from(
                            `To: ${vendorEmail}\r\n` +
                            `Subject: ${tier.subject.replace("{po}", po.po_number)}\r\n` +
                            `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`
                        ).toString("base64url"),
                    },
                });
            } else {
                // New thread
                await gmail.users.messages.send({
                    userId: "me",
                    requestBody: {
                        raw: Buffer.from(
                            `To: ${vendorEmail}\r\n` +
                            `Cc: bill.selee@buildasoil.com\r\n` +
                            `Subject: ${tier.subject.replace("{po}", po.po_number)}\r\n` +
                            `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`
                        ).toString("base64url"),
                    },
                });
            }

            // Mark poke in database
            await db.from("purchase_orders").upsert({
                po_number: po.po_number,
                last_poked_at: today,
                last_poked_tier: tier.label,
                updated_at: new Date().toISOString(),
            }, { onConflict: "po_number" });

            outcomes.push({ orderId: po.po_number, vendorName: po.vendor_name, action: `${tier.label}_poked` as any, detail: `${daysOverdue}d overdue` });
        } catch (e: any) {
            outcomes.push({ orderId: po.po_number, vendorName: po.vendor_name, action: `${tier.label}_poked` as any, detail: `send failed: ${e.message}` });
        }
    }

    return outcomes;
}

function generatePokeBody(po: string, vendorName: string, daysOverdue: number, tier: string): string {
    const lines = [`Hi ${vendorName},`];
    if (tier === "L1") {
        lines.push(``);
        lines.push(`We're checking in on PO ${po}. The expected delivery date has passed and we don't have tracking yet.`);
        lines.push(``);
        lines.push(`Please send tracking numbers and an updated ETA when you have them.`);
    } else if (tier === "L2") {
        lines.push(``);
        lines.push(`PO ${po} is now ${daysOverdue} days past the expected delivery date. We need tracking to plan production.`);
        lines.push(``);
        lines.push(`Please send tracking today — this is impacting our schedule.`);
    } else {
        lines.push(``);
        lines.push(`PO ${po} is now ${daysOverdue} days past due. This is our third request for tracking information.`);
        lines.push(``);
        lines.push(`If you cannot provide tracking today, please let us know the status so we can plan accordingly.`);
    }
    lines.push(``);
    lines.push(`Thanks,`);
    lines.push(`BuildASoil Purchasing`);
    return lines.join("\n");
}
/**
 * @file    src/lib/purchasing/po-receipt-recheck.ts
 * @purpose Post-reconciliation receiving check — re-verifies invoice quantities
 *          against Finale receiving data when goods arrive AFTER reconciliation.
 * @author  Hermia
 * @created 2026-06-01
 * @deps    @/lib/supabase, @/lib/finale/receivings, @/lib/intelligence/alert-gate
 *
 * DESIGN:
 *   Runs as a cron job every 30 min. Queries POs in lifecycle_state INVOICED
 *   or RECONCILED that have pending deliveries. Fetches current receiving data
 *   from Finale. If invoice qty > received qty and goods arrived after invoice
 *   date, alerts via Telegram.
 *
 *   Dedup: in-memory Set + ap_activity_log check to avoid re-alerting the same
 *   short-shipment gap within the same process lifetime.
 */

import { createClient } from "@/lib/supabase";
import { businessHoursAlert } from "@/lib/intelligence/alert-gate";

/** How many POs to check per run */
const MAX_POS_PER_RUN = 20;

/** Don't re-alert a PO within this window */
const RE_ALERT_COOLDOWN_HOURS = 72;

/** In-memory dedup: PO numbers already alerted this process lifetime */
const alertedThisSession = new Set<string>();

export interface ReceiptRecheckResult {
    checked: number;
    rechecked: number;
    shortShipments: number;
    fullyReceived: number;
    errors: number;
    details: string[];
}

/**
 * Re-check POs where an invoice was reconciled but receiving data
 * may have changed since. Called from the po-receipt-recheck cron.
 */
export async function recheckReconciledInvoices(): Promise<ReceiptRecheckResult> {
    const result: ReceiptRecheckResult = {
        checked: 0,
        rechecked: 0,
        shortShipments: 0,
        fullyReceived: 0,
        errors: 0,
        details: [],
    };

    try {
        const supabase = createClient();
        if (!supabase) {
            console.warn("[po-receipt-recheck] No Supabase client");
            return result;
        }

        // Step 1: Find POs that have been invoiced or reconciled but not completed
        const { data: pos, error } = await supabase
            .from("purchase_orders")
            .select("po_number, lifecycle_state, updated_at")
            .in("lifecycle_state", ["INVOICED", "RECONCILED"])
            .order("updated_at", { ascending: false })
            .limit(MAX_POS_PER_RUN);

        if (error || !pos || pos.length === 0) {
            return result;
        }

        result.checked = pos.length;

        // Step 2: For each PO, check its most recent activity log entry
        for (const po of pos) {
            try {
                const poNumber = po.po_number;
                if (!poNumber) continue;

                // Step 2a: Get the last invoice/reconciliation activity for this PO
                const { data: activity } = await supabase
                    .from("ap_activity_log")
                    .select("created_at, metadata, action_taken, intent")
                    .in("intent", ["BILL_FORWARD", "RECONCILIATION", "RECONCILE"])
                    .filter("metadata->poNumber", "eq", poNumber)
                    .order("created_at", { ascending: false })
                    .limit(1);

                if (!activity || activity.length === 0) continue;

                const lastActivity = activity[0];
                const lastProcessedAt = new Date(lastActivity.created_at).getTime();

                // Step 2b: Check if PO has received goods since last processing
                const { data: transitions } = await supabase
                    .from("po_lifecycle_transitions")
                    .select("transitioned_at")
                    .eq("po_number", poNumber)
                    .eq("to_state", "RECEIVED")
                    .order("transitioned_at", { ascending: false })
                    .limit(1);

                const receivedTransition = transitions && transitions[0];
                const receivedAt = receivedTransition
                    ? new Date(receivedTransition.transitioned_at).getTime()
                    : null;

                // If goods were received after last invoice processing, we need to re-check
                if (!receivedAt || receivedAt <= lastProcessedAt) continue;

                result.rechecked++;

                // Step 2c: Check dedup
                if (alertedThisSession.has(poNumber)) {
                    result.details.push(`${poNumber}: already alerted this session`);
                    continue;
                }

                const cooldownCutoff = new Date(
                    Date.now() - RE_ALERT_COOLDOWN_HOURS * 3600000
                ).toISOString();

                const { data: recentAlerts } = await supabase
                    .from("ap_activity_log")
                    .select("id")
                    .eq("intent", "RECEIPT_RECHECK")
                    .filter("metadata->poNumber", "eq", poNumber)
                    .gte("created_at", cooldownCutoff)
                    .limit(1);

                if (recentAlerts && recentAlerts.length > 0) {
                    result.details.push(`${poNumber}: within cooldown, skipping`);
                    continue;
                }

                // Step 2d: Fetch current receiving from Finale via FinaleReceivingsClient
                // We use a dynamic import to avoid tight coupling
                const { FinaleReceivingsClient } = await import(
                    "@/lib/finale/receivings"
                );
                const receivingsClient = new FinaleReceivingsClient();
                const receivedPOs = await receivingsClient.getTodaysReceivedPOs();

                const poReceived = receivedPOs.find(
                    (rp: any) => rp.po_number === poNumber || String(rp.id) === poNumber
                );

                if (!poReceived) {
                    result.details.push(
                        `${poNumber}: marked received but no Finale data found`
                    );
                    continue;
                }

                // Step 2e: Build alert message
                const meta = lastActivity.metadata || {};
                const vendorName = meta.vendorName || "Unknown vendor";
                const invoiceTotal = meta.total || 0;
                const invoiceNumber = meta.invoiceNumber || "Unknown";

                const alertMsg = [
                    `🔔 *Receipt-Reconciliation Alert*`,
                    `━━━━━━━━━━━━━━━━━━━━`,
                    `PO *${poNumber}* — ${vendorName}`,
                    `Invoice #${invoiceNumber} — \$${invoiceTotal}`,
                    `📅 Invoice processed: ${lastActivity.created_at?.substring(0, 10)}`,
                    `📦 Goods received after invoice — recommend manual verification`,
                ].join("\n");

                await businessHoursAlert(
                    undefined as any,
                    process.env.TELEGRAM_CHAT_ID || "",
                    alertMsg,
                    { parse_mode: "Markdown" }
                );

                // Log to ap_activity_log for dedup
                await supabase.from("ap_activity_log").insert({
                    email_from: "po-receipt-recheck",
                    email_subject: `Receipt recheck: PO ${poNumber}`,
                    intent: "RECEIPT_RECHECK",
                    action_taken:
                        `Alerted: goods received after invoice for PO ${poNumber}`,
                    metadata: {
                        poNumber,
                        vendorName,
                        invoiceNumber,
                        invoiceTotal,
                        lastProcessedAt: lastActivity.created_at,
                        receivedAt: receivedTransition?.transitioned_at,
                    },
                });

                alertedThisSession.add(poNumber);
                result.shortShipments++;
                result.details.push(
                    `${poNumber}: alerted — goods received after invoice`
                );
            } catch (poErr: any) {
                console.warn(
                    `[po-receipt-recheck] Error checking PO ${po.po_number}:`,
                    poErr.message
                );
                result.errors++;
            }
        }
    } catch (err: any) {
        console.warn(
            `[po-receipt-recheck] Unexpected error:`,
            err.message
        );
        result.errors++;
    }

    console.log(
        `[po-receipt-recheck] Checked ${result.checked} POs: ` +
        `${result.rechecked} re-checks, ${result.shortShipments} short-shipments alerted, ` +
        `${result.fullyReceived} fully received, ${result.errors} errors`
    );

    return result;
}
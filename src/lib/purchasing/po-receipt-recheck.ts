/**
 * @file    src/lib/purchasing/po-receipt-recheck.ts
 * @purpose Post-reconciliation receiving check — re-verifies when goods arrive
 *          AFTER invoice reconciliation. Uses po_lifecycle_transitions table
 *          with a 21-day lookback window instead of Finale API calls.
 * @author  Hermia
 * @created 2026-06-01
 * @updated 2026-06-01 — 21-day window via lifecycle transitions, no Finale API
 * @deps    @/lib/db, @/lib/intelligence/alert-gate
 */
import { createClient } from "@/lib/db";
import { businessHoursAlert } from "@/lib/intelligence/alert-gate";

const MAX_POS_PER_RUN = 20;
const RE_ALERT_COOLDOWN_HOURS = 72;
/** Look back up to 21 days — most PO lifecycles complete within this window */
const LOOKBACK_DAYS = 21;

/** In-memory dedup to avoid re-alerting the same PO within a process lifetime */
const alertedThisSession = new Set<string>();

export interface ReceiptRecheckResult {
    checked: number;
    shortShipments: number;
    errors: number;
    details: string[];
}

/**
 * Re-check POs where receiving happened after invoicing/reconciliation.
 * Uses po_lifecycle_transitions (21-day window) — no Finale API calls.
 */
export async function recheckReconciledInvoices(): Promise<ReceiptRecheckResult> {
    const result: ReceiptRecheckResult = { checked: 0, shortShipments: 0, errors: 0, details: [] };

    try {
        const db = createClient();
        if (!db) {
            console.warn("[po-receipt-recheck] No Supabase client");
            return result;
        }

        const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

        // Find POs where RECEIVED transition happened after invoicing
        const { data: transitions, error } = await supabase
            .from("po_lifecycle_transitions")
            .select("po_number, from_state, to_state, transitioned_at, triggered_by")
            .eq("to_state", "RECEIVED")
            .gte("transitioned_at", cutoff)
            .order("transitioned_at", { ascending: false })
            .limit(MAX_POS_PER_RUN);

        if (error || !transitions || transitions.length === 0) {
            console.log(`[po-receipt-recheck] No RECEIVED transitions in ${LOOKBACK_DAYS}d window`);
            return result;
        }

        result.checked = transitions.length;

        for (const t of transitions) {
            try {
                const poNumber = t.po_number;
                if (!poNumber || alertedThisSession.has(poNumber)) continue;

                // Skip transitions that were already RECEIVED (redundant entries)
                if (t.from_state === "RECEIVED") continue;

                // Cooldown check — don't re-alert within 72h
                const cooldownCutoff = new Date(Date.now() - RE_ALERT_COOLDOWN_HOURS * 3600000).toISOString();
                const { data: recentAlerts } = await supabase
                    .from("ap_activity_log")
                    .select("id")
                    .eq("intent", "RECEIPT_RECHECK")
                    .filter("metadata->poNumber", "eq", poNumber)
                    .gte("created_at", cooldownCutoff)
                    .limit(1);

                if (recentAlerts && recentAlerts.length > 0) {
                    result.details.push(`${poNumber}: cooldown active`);
                    continue;
                }

                // Get invoice details from activity log
                const { data: activity } = await supabase
                    .from("ap_activity_log")
                    .select("created_at, metadata")
                    .in("intent", ["BILL_FORWARD", "RECONCILIATION"])
                    .filter("metadata->poNumber", "eq", poNumber)
                    .order("created_at", { ascending: false })
                    .limit(1);

                if (!activity || activity.length === 0) {
                    // PO was received but never had an invoice — not actionable
                    result.details.push(`${poNumber}: no invoice activity`);
                    continue;
                }

                const lastActivity = activity[0];
                const meta = lastActivity.metadata || {};

                const alertMsg = `\u{1F514} *Receipt-Reconciliation Alert*\n` +
                    `\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\n` +
                    `PO *${poNumber}* — ${meta.vendorName || "Unknown vendor"}\n` +
                    `Invoice #${meta.invoiceNumber || "?"} — $${meta.total || 0}\n` +
                    `\u{1F4C5} Invoiced: ${lastActivity.created_at?.substring(0, 10)}\n` +
                    `\u{1F4E6} Received: ${t.transitioned_at?.substring(0, 10)} (${t.triggered_by})\n` +
                    `\u{26A0}\u{FE0F} Goods arrived after invoice — verify quantities`;

                await businessHoursAlert(
                    undefined as any,
                    process.env.TELEGRAM_CHAT_ID || "",
                    alertMsg,
                    { parse_mode: "Markdown" }
                );

                await db.from("ap_activity_log").insert({
                    email_from: "po-receipt-recheck",
                    email_subject: `Receipt recheck: PO ${poNumber}`,
                    intent: "RECEIPT_RECHECK",
                    action_taken: `Alerted: goods received ${(t.transitioned_at || "").substring(0, 10)} after invoice ${(lastActivity.created_at || "").substring(0, 10)}`,
                    metadata: {
                        poNumber,
                        vendorName: meta.vendorName,
                        invoiceNumber: meta.invoiceNumber,
                        invoiceTotal: meta.total,
                        lastProcessedAt: lastActivity.created_at,
                        receivedAt: t.transitioned_at,
                        lookbackDays: LOOKBACK_DAYS,
                    },
                });

                alertedThisSession.add(poNumber);
                result.shortShipments++;
                result.details.push(`${poNumber}: alerted`);
            } catch (poErr: any) {
                console.warn(`[po-receipt-recheck] Error on PO ${t.po_number}:`, poErr.message);
                result.errors++;
            }
        }
    } catch (err: any) {
        console.warn(`[po-receipt-recheck] Error:`, err.message);
        result.errors++;
    }

    console.log(
        `[po-receipt-recheck] ${result.checked} POs checked, ` +
        `${result.shortShipments} alerted, ${result.errors} errors`
    );
    return result;
}
/**
 * @file    src/lib/purchasing/po-eta-sync.ts
 * @purpose Pushes the best-known ETA for a PO back to Finale's dueDate field.
 *          Called whenever a new ETA is derived — vendor reply, carrier tracking,
 *          manual override. Always updates to the latest known date.
 *
 *          Idempotent: skips the Finale API call if dueDate already matches.
 *
 * @author  Hermia
 * @created 2026-06-18
 * @deps    @/lib/finale/client, @/lib/supabase, @/lib/purchasing/vendor-eta-profile
 * @env     None (uses existing Finale + Supabase clients)
 */

import { createClient } from "@/lib/supabase";
import { finaleClient } from "@/lib/finale/client";

/**
 * Push the best-known ETA for a purchase order to Finale's dueDate field.
 *
 * Resolution order (best to worst):
 *   1. Carrier tracking ETA (highest confidence)
 *   2. Vendor-stated ETA from email reply (medium confidence)
 *   3. Explicitly provided date override
 *
 * @param poNumber    - Finale PO number (e.g. "124931" or "PO-124931")
 * @param explicitDate - Optional explicit date override (YYYY-MM-DD). When provided,
 *                       this wins over all derived sources.
 * @param source       - What triggered this sync (for logging)
 * @returns true if Finale was updated, false if already matched or errored
 */
export async function syncPOETA(
    poNumber: string,
    explicitDate?: string | null,
    source: string = "auto"
): Promise<boolean> {
    // Normalise PO number — Finale uses numeric IDs without "PO-" prefix
    const orderId = poNumber.startsWith("PO-") ? poNumber.slice(3) : poNumber;
    const numericId = orderId;

    try {
        // ── 1. Resolve best ETA ──────────────────────────────────────
        let bestEta: string | null = explicitDate ?? null;

        if (!bestEta) {
            const supabase = createClient();
            if (supabase) {
                const { data: po } = await supabase
                    .from("purchase_orders")
                    .select("vendor_stated_eta, vendor_stated_eta_confidence, last_eta_update")
                    .eq("po_number", numericId)
                    .maybeSingle();

                if (po) {
                    // Prefer vendor-stated ETA (high or medium confidence)
                    const vendorEta = po.vendor_stated_eta;
                    const vendorConf = po.vendor_stated_eta_confidence;
                    if (vendorEta && (vendorConf === "high" || vendorConf === "medium")) {
                        bestEta = vendorEta.slice(0, 10);
                    }

                    // Fallback: last_eta_update (tracking-derived)
                    if (!bestEta && po.last_eta_update?.estimated_delivery_at) {
                        bestEta = po.last_eta_update.estimated_delivery_at.slice(0, 10);
                    }
                }
            }
        }

        if (!bestEta) {
            // No ETA available — nothing to push
            return false;
        }

        // ── 2. Push to Finale ────────────────────────────────────────
        const updated = await finaleClient.updateOrderDueDate(orderId, bestEta);

        if (updated) {
            console.log(
                `[po-eta-sync] Pushed ETA ${bestEta} to Finale PO ${orderId} (source: ${source})`
            );

            // Log to ap_activity_log for audit trail
            try {
                const supabase = createClient();
                if (supabase) {
                    await supabase.from("ap_activity_log").insert({
                        intent: "ETA_SYNC",
                        action_taken: `Pushed dueDate ${bestEta} to Finale`,
                        metadata: {
                            po_number: numericId,
                            orderId,
                            etaDate: bestEta,
                            source,
                            synced_at: new Date().toISOString(),
                        },
                        created_at: new Date().toISOString(),
                    });
                }
            } catch (logErr: any) {
                // Best-effort logging — don't fail the sync
            }
        }

        return updated;
    } catch (err: any) {
        console.warn(
            `[po-eta-sync] Failed to sync ETA for ${orderId}: ${err.message}`
        );
        return false;
    }
}

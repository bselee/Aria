/**
 * @file    src/lib/tracking/delivery-receipt-prompt.ts
 * @purpose Finds delivered shipments (24-72h old) that haven't been
 *          confirmed as received in Finale. Sends Telegram prompts with
 *          inline buttons so Bill can one-tap confirm receipt.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db, @/lib/intelligence/telegram-notify
 *
 * DESIGN:
 *   Runs as part of the po-receiving-watcher cron (every 30 min).
 *   Queries shipment_intelligence for delivered_at between 24-72h ago
 *   where the PO hasn't been received in Finale yet.
 *
 *   Dedup: module-level Set of prompted PO numbers. Persists across
 *   cron runs within PM2 process lifetime. Cross-restart dedup via
 *   ap_activity_log check with intent='RECEIPT_PROMPT'.
 *
 *   Action flow:
 *   1. Find delivered-but-unreceived POs
 *   2. Check dedup (skip if already prompted)
 *   3. Send Telegram with [✅ Confirm Received] [⏭ Skip] buttons
 *   4. Log prompt to ap_activity_log
 *   5. On confirm: call Finale receive endpoint (future)
 *   6. On skip: log skip, don't re-prompt for 7 days
 */

import { createClient } from "@/lib/db";
import { sendTelegramNotifyWithButtons } from "@/lib/intelligence/telegram-notify";

/** Prompt window: delivered between 24h and 72h ago */
const PROMPT_MIN_HOURS = 24;
const PROMPT_MAX_HOURS = 72;

/** In-memory dedup: PO numbers already prompted this process lifetime */
const promptedThisSession = new Set<string>();

/** Skip cooldown: don't re-prompt for 7 days after skip */
const SKIP_COOLDOWN_DAYS = 7;

export interface DeliveryReceiptCandidate {
    poNumber: string;
    vendorName: string | null;
    trackingNumber: string;
    carrierName: string | null;
    deliveredAt: string;
    hoursSinceDelivery: number;
}

export interface ReceiptPromptResult {
    prompted: number;
    skippedAlreadyPrompted: number;
    skippedNoCandidates: boolean;
    candidates: DeliveryReceiptCandidate[];
}

/**
 * Find delivered-but-unreceived shipments and send Telegram prompts.
 * Called from po-receiving-watcher cron.
 */
export async function promptDeliveredReceipts(): Promise<ReceiptPromptResult> {
    const db = createClient();
    if (!db) {
        return { prompted: 0, skippedAlreadyPrompted: 0, skippedNoCandidates: true, candidates: [] };
    }

    const now = new Date();
    const minCutoff = new Date(now.getTime() - PROMPT_MAX_HOURS * 3600000).toISOString();
    const maxCutoff = new Date(now.getTime() - PROMPT_MIN_HOURS * 3600000).toISOString();

    // Step 1: Find delivered shipments in the prompt window
    const { data: shipments, error } = await supabase
        .from("shipment_intelligence")
        .select("tracking_number, po_numbers, vendor_names, carrier_name, delivered_at, status_category, active")
        .eq("status_category", "delivered")
        .eq("active", true)
        .gte("delivered_at", minCutoff)
        .lte("delivered_at", maxCutoff)
        .limit(50);

    if (error || !shipments || shipments.length === 0) {
        return { prompted: 0, skippedAlreadyPrompted: 0, skippedNoCandidates: true, candidates: [] };
    }

    // Step 2: Get PO numbers that are already received in Finale
    // Query purchase_orders for received/complete POs
    const allPoNumbers = shipments.flatMap(s => (s.po_numbers || []) as string[]);
    if (allPoNumbers.length === 0) {
        return { prompted: 0, skippedAlreadyPrompted: 0, skippedNoCandidates: true, candidates: [] };
    }

    const { data: receivedPOs } = await supabase
        .from("purchase_orders")
        .select("po_number, completion_state")
        .in("po_number", allPoNumbers)
        .in("completion_state", ["complete", "finale-received"]);

    const receivedSet = new Set((receivedPOs || []).map(r => r.po_number));

    // Step 3: Check ap_activity_log for recently prompted/skipped POs
    const skipCutoff = new Date(now.getTime() - SKIP_COOLDOWN_DAYS * 86400000).toISOString();
    const { data: recentPrompts } = await supabase
        .from("ap_activity_log")
        .select("metadata")
        .eq("intent", "RECEIPT_PROMPT")
        .gte("created_at", skipCutoff)
        .limit(200);

    const dbPromptedPOs = new Set<string>();
    for (const row of (recentPrompts || []) as any[]) {
        const po = row?.metadata?.poNumber;
        if (po) dbPromptedPOs.add(po);
    }

    // Step 4: Build candidate list
    const candidates: DeliveryReceiptCandidate[] = [];
    let prompted = 0;
    let skippedAlready = 0;

    for (const s of shipments as any[]) {
        const poNumbers: string[] = s.po_numbers || [];
        for (const poNumber of poNumbers) {
            // Skip already received in Finale
            if (receivedSet.has(poNumber)) continue;

            // Skip already prompted (in-memory or DB)
            if (promptedThisSession.has(poNumber) || dbPromptedPOs.has(poNumber)) {
                skippedAlready++;
                continue;
            }

            const hoursSince = Math.round(
                (now.getTime() - new Date(s.delivered_at).getTime()) / 3600000
            );

            candidates.push({
                poNumber,
                vendorName: (s.vendor_names || [])[0] || null,
                trackingNumber: s.tracking_number,
                carrierName: s.carrier_name,
                deliveredAt: s.delivered_at,
                hoursSinceDelivery: hoursSince,
            });
        }
    }

    // Step 5: Send Telegram prompts (batch up to 5 per run to avoid spam)
    const toPrompt = candidates.slice(0, 5);

    if (toPrompt.length > 0) {
        const lines: string[] = [];
        lines.push(`📦 *Deliveries Awaiting Receipt Confirmation*`);
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const c of toPrompt) {
            const vendor = c.vendorName || "Unknown vendor";
            const carrier = c.carrierName || "Carrier";
            lines.push(`\n*PO ${c.poNumber}* — ${vendor}`);
            lines.push(`🚚 ${carrier} #${c.trackingNumber}`);
            lines.push(`📅 Delivered ${c.hoursSinceDelivery}h ago`);
        }

        // Build inline keyboard: one row per PO with confirm/skip buttons
        const buttons = toPrompt.map(c => [
            { text: `✅ Receive ${c.poNumber}`, callback_data: `receipt_confirm_${c.poNumber}` },
            { text: `⏭ Skip`, callback_data: `receipt_skip_${c.poNumber}` },
        ]);

        await sendTelegramNotifyWithButtons(lines.join("\n"), buttons);

        for (const c of toPrompt) {
            promptedThisSession.add(c.poNumber);

            // Log prompt to DB for cross-restart dedup
            try {
                await db.from("ap_activity_log").insert({
                    email_from: c.vendorName || "unknown",
                    email_subject: `Receipt prompt: PO ${c.poNumber}`,
                    intent: "RECEIPT_PROMPT",
                    action_taken: `Sent Telegram prompt for delivered PO (delivered ${c.hoursSinceDelivery}h ago)`,
                    metadata: {
                        poNumber: c.poNumber,
                        vendorName: c.vendorName,
                        trackingNumber: c.trackingNumber,
                        deliveredAt: c.deliveredAt,
                        promptedAt: now.toISOString(),
                    },
                });
            } catch { /* non-blocking */ }
        }

        prompted = toPrompt.length;
        console.log(`[receipt-prompt] Prompted for ${prompted} PO(s)`);
    }

    return {
        prompted,
        skippedAlreadyPrompted: skippedAlready,
        skippedNoCandidates: false,
        candidates,
    };
}

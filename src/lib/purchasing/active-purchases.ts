import { leadTimeService } from "../builds/lead-time-service";
import type { FinaleClient, FullPO } from "../finale/client";
import { createClient } from "../supabase";
import { RECEIVED_DASHBOARD_RETENTION_DAYS, shouldKeepReceivedPurchase } from "./calendar-lifecycle";
import { loadPOCompletionSignalIndex } from "./po-completion-loader";
import { derivePOCompletionState, type POCompletionState } from "./po-completion-state";

export interface ActivePurchase extends FullPO {
    expectedDate: string;
    leadProvenance: string;
    trackingNumbers: string[];
    isReceived: boolean;
    completionState: POCompletionState;
}

function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split("T")[0];
}

export async function loadActivePurchases(
    finale: FinaleClient,
    daysBack = 60
): Promise<ActivePurchase[]> {
    const pos = await finale.getRecentPurchaseOrders(daysBack);
    await leadTimeService.warmCache();

    const supabase = createClient();
    const poNumbers = pos.map(p => p.orderId).filter(Boolean);
    const trackingMap = new Map<string, string[]>();

    if (supabase && poNumbers.length > 0) {
        try {
            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: dbPOs } = await supabase
                    .from("purchase_orders")
                    .select("po_number, tracking_numbers")
                    .in("po_number", chunk);

                for (const dp of dbPOs || []) {
                    trackingMap.set(dp.po_number, dp.tracking_numbers || []);
                }
            }
        } catch (e: any) {
            console.warn("[purchasing] active purchases tracking fetch failed:", e.message);
        }
    }

    const completionSignals = await loadPOCompletionSignalIndex(supabase, poNumbers);
    const activePos: ActivePurchase[] = [];

    for (const po of pos) {
        if (!po.orderId) continue;
        if (po.orderId.toLowerCase().includes("dropship")) continue;

        const status = (po.status || "").toLowerCase();
        if (!["committed", "completed"].includes(status)) continue;

        const isReceived = status === "completed";
        const completionSignal = completionSignals.get(po.orderId);
        const completionState = derivePOCompletionState({
            finaleReceived: isReceived,
            trackingDelivered: false,
            hasMatchedInvoice: completionSignal?.hasMatchedInvoice || false,
            reconciliationVerdict: completionSignal?.reconciliationVerdict || null,
            freightResolved: completionSignal?.freightResolved || false,
            unresolvedBlockers: completionSignal?.unresolvedBlockers || [],
        });

        if (
            completionState === "complete" &&
            isReceived &&
            !shouldKeepReceivedPurchase(po.receiveDate, RECEIVED_DASHBOARD_RETENTION_DAYS)
        ) {
            continue;
        }

        let expectedDate: string;
        let leadProvenance: string;

        if (po.orderDate) {
            const lt = await leadTimeService.getForVendor(po.vendorName);
            expectedDate = addDays(po.orderDate, lt.days);
            leadProvenance = lt.label;
        } else {
            expectedDate = new Date().toISOString().split("T")[0];
            leadProvenance = "14d default";
        }

        activePos.push({
            ...po,
            expectedDate,
            leadProvenance,
            isReceived,
            completionState,
            trackingNumbers: trackingMap.get(po.orderId) || [],
        });
    }

    activePos.sort((a, b) => {
        const da = new Date(a.orderDate || 0).getTime();
        const db = new Date(b.orderDate || 0).getTime();
        return db - da;
    });

    return activePos;
}

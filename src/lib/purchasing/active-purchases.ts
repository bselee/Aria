import { leadTimeService } from "../builds/lead-time-service";
import type { FinaleClient, FullPO } from "../finale/client";
import { createClient } from "../supabase";
import { RECEIVED_DASHBOARD_RETENTION_DAYS, shouldKeepReceivedPurchase } from "./calendar-lifecycle";
import { addCalendarDays } from "./calendar-display";
import { loadPOCompletionSignalIndex } from "./po-completion-loader";
import { derivePOCompletionState, type POCompletionState } from "./po-completion-state";
import { listShipmentsForPurchaseOrders, type ShipmentRecord } from "../tracking/shipment-intelligence";

export interface ActivePurchase extends FullPO {
    expectedDate: string;
    leadProvenance: string;
    sentAt: string | null;
    trackingNumbers: string[];
    shipments: ShipmentRecord[];
    isReceived: boolean;
    completionState: POCompletionState;
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
    const shipmentMap = new Map<string, ShipmentRecord[]>();
    const sentAtMap = new Map<string, string | null>();

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

                const { data: sendRows } = await supabase
                    .from("po_sends")
                    .select("po_number, sent_at")
                    .in("po_number", chunk)
                    .order("sent_at", { ascending: false });

                for (const sendRow of sendRows || []) {
                    if (!sentAtMap.has(sendRow.po_number)) {
                        sentAtMap.set(sendRow.po_number, sendRow.sent_at || null);
                    }
                }
            }

            const shipments = await listShipmentsForPurchaseOrders(poNumbers);
            for (const shipment of shipments) {
                for (const poNumber of shipment.po_numbers || []) {
                    if (!shipmentMap.has(poNumber)) shipmentMap.set(poNumber, []);
                    shipmentMap.get(poNumber)!.push(shipment);
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
        const shipments = shipmentMap.get(po.orderId) || [];
        const completionSignal = completionSignals.get(po.orderId);
        const completionState = derivePOCompletionState({
            finaleReceived: isReceived,
            trackingDelivered: shipments.length > 0 && shipments.every((shipment) => shipment.status_category === "delivered"),
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
            expectedDate = addCalendarDays(po.orderDate, lt.days);
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
            sentAt: sentAtMap.get(po.orderId) || null,
            trackingNumbers: trackingMap.get(po.orderId) || [],
            shipments,
        });
    }

    activePos.sort((a, b) => {
        const da = new Date(a.orderDate || 0).getTime();
        const db = new Date(b.orderDate || 0).getTime();
        return db - da;
    });

    return activePos;
}

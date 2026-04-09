import { leadTimeService } from "../builds/lead-time-service";
import type { FinaleClient, FullPO } from "../finale/client";
import { createClient } from "../supabase";
import { RECEIVED_DASHBOARD_RETENTION_DAYS, shouldKeepReceivedPurchase } from "./calendar-lifecycle";
import { loadPOCompletionSignalIndex } from "./po-completion-loader";
import { derivePOCompletionState, type POCompletionState } from "./po-completion-state";
import { listShipmentsForPurchaseOrders, type ShipmentRecord } from "../tracking/shipment-intelligence";
import { derivePOLifecycleState, type POLifecycleStage } from "./po-lifecycle-state";
import type { POShippingEvidence } from "./po-lifecycle-evidence";

export interface ActivePurchase extends FullPO {
    expectedDate: string;
    leadProvenance: string;
    trackingNumbers: string[];
    shipments: ShipmentRecord[];
    isReceived: boolean;
    completionState: POCompletionState;
    lifecycleStage: POLifecycleStage;
    lifecycleSummary: string | null;
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
    const lifecycleRowMap = new Map<string, {
        committed_at?: string | null;
        po_sent_at?: string | null;
        vendor_acknowledged_at?: string | null;
        shipping_evidence?: POShippingEvidence[] | null;
        tracking_requested_at?: string | null;
        tracking_request_count?: number | null;
        lifecycle_stage?: POLifecycleStage | null;
        tracking_status_summary?: string | null;
        last_movement_summary?: string | null;
    }>();
    const shipmentMap = new Map<string, ShipmentRecord[]>();

    if (supabase && poNumbers.length > 0) {
        try {
            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                const { data: dbPOs } = await supabase
                    .from("purchase_orders")
                    .select("po_number, tracking_numbers, committed_at, po_sent_at, vendor_acknowledged_at, shipping_evidence, tracking_requested_at, tracking_request_count, lifecycle_stage, tracking_status_summary, last_movement_summary")
                    .in("po_number", chunk);

                for (const dp of dbPOs || []) {
                    trackingMap.set(dp.po_number, dp.tracking_numbers || []);
                    lifecycleRowMap.set(dp.po_number, dp);
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

        const lifecycleRow = lifecycleRowMap.get(po.orderId);
        const status = (po.status || "").toLowerCase();
        if (!["committed", "completed"].includes(status)) continue;

        const isReceived = !!po.receiveDate;
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
        const shippingEvidence = Array.isArray(lifecycleRow?.shipping_evidence) ? lifecycleRow.shipping_evidence : [];
        const lifecycleStage = lifecycleRow?.lifecycle_stage || derivePOLifecycleState({
            committedAt: lifecycleRow?.committed_at || po.orderDate || null,
            poSentAt: lifecycleRow?.po_sent_at || po.orderDate || null,
            vendorAcknowledgedAt: lifecycleRow?.vendor_acknowledged_at || null,
            shippingEvidence,
            trackingRequestedAt: lifecycleRow?.tracking_requested_at || null,
            trackingRequestCount: lifecycleRow?.tracking_request_count || 0,
            receiveDate: isReceived ? po.receiveDate : null,
            completionState,
        });
        const lifecycleSummary = lifecycleStage === "moving_with_tracking"
            ? lifecycleRow?.last_movement_summary || lifecycleRow?.tracking_status_summary || shipments[0]?.status_display || null
            : null;

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
            lifecycleStage,
            lifecycleSummary,
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

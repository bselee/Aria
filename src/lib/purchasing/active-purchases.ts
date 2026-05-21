import { leadTimeService } from "../builds/lead-time-service";
import type { FinaleClient, FullPO } from "../finale/client";
import { createClient } from "../supabase";
import { RECEIVED_DASHBOARD_RETENTION_DAYS, shouldKeepReceivedPurchase } from "./calendar-lifecycle";
import { loadPOCompletionSignalIndex } from "./po-completion-loader";
import { derivePOCompletionState, type POCompletionState } from "./po-completion-state";
import { listShipmentsForPurchaseOrders, type ShipmentRecord } from "../tracking/shipment-intelligence";
import { hasPurchaseOrderReceipt, resolvePurchaseOrderReceiptDate } from "./po-receipt-state";
import { derivePOSentVerification, type POSentVerification } from "./po-sent-verification";
import { deriveVendorEtaProfile, type VendorEtaProfile } from "./vendor-eta-profile";

export interface ActivePurchase extends FullPO {
    expectedDate: string;
    leadProvenance: string;
    trackingNumbers: string[];
    shipments: ShipmentRecord[];
    isReceived: boolean;
    completionState: POCompletionState;
    lifecycleStage?: string;
    lifecycleSummary?: string;
    lastMovementSummary?: string | null;
    trackingUnavailableAt?: string | null;
    trackingRequestedAt?: string | null;
    vendorAcknowledgedAt?: string | null;
    humanReplyDetectedAt?: string | null;
    sentVerification: POSentVerification;
    etaProfile: VendorEtaProfile;
    trackingPaused?: boolean;
    trackingSource?: string | null;
    typicalTrackingSource?: string | null;
    vendorOrdersEmail?: string | null;
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

    // KAIZEN #2: pre-warm per-vendor lead-time cache so the per-PO loop reads
    // synchronously from cache instead of chaining ~N awaits serially.
    const uniqueVendors = [...new Set(pos.map(p => p.vendorName).filter(Boolean))];
    await Promise.all(uniqueVendors.map(v => leadTimeService.getForVendor(v)));

    const supabase = createClient();
    const vendorMap = new Map<string, { typical_tracking_source?: string; orders_email?: string; vendor_emails?: string[] }>();
    if (supabase && uniqueVendors.length > 0) {
        try {
            const { data: vData } = await supabase
                .from("vendor_profiles")
                .select("vendor_name, typical_tracking_source, orders_email, vendor_emails")
                .in("vendor_name", uniqueVendors);
            for (const v of vData || []) {
                vendorMap.set(v.vendor_name.toLowerCase(), v);
            }
        } catch (e) {
            console.warn("Failed to load vendor profiles in loadActivePurchases:", e);
        }
    }

    const poNumbers = pos.map(p => p.orderId).filter(Boolean);
    const trackingMap = new Map<string, string[]>();
    const shipmentMap = new Map<string, ShipmentRecord[]>();
    const lifecycleMap = new Map<string, Record<string, any>>();
    const poSendMap = new Map<string, Array<Record<string, any>>>();

    if (supabase && poNumbers.length > 0) {
        try {
            for (let i = 0; i < poNumbers.length; i += 100) {
                const chunk = poNumbers.slice(i, i + 100);
                // KAIZEN #7: parallelize independent Supabase queries per chunk.
                const [poRes, sendRes] = await Promise.all([
                    supabase
                        .from("purchase_orders")
                        .select(
                            "po_number, tracking_numbers, lifecycle_stage, last_movement_summary, " +
                            "tracking_unavailable_at, tracking_requested_at, vendor_acknowledged_at, vendor_ack_source, " +
                            "human_reply_detected_at, po_sent_at, po_sent_verified_at, po_sent_verified_source, " +
                            "po_sent_verified_evidence, last_eta_update, vendor_stated_eta, vendor_stated_eta_confidence, tracking_paused, tracking_source"
                        )
                        .in("po_number", chunk),
                    supabase
                        .from("po_sends")
                        .select("po_number, sent_at, committed_at, sent_to_email, triggered_by, gmail_message_id")
                        .in("po_number", chunk),
                ]);
                const dbPOs = poRes.data;
                const poSends = sendRes.data;

                for (const dp of dbPOs || []) {
                    trackingMap.set(dp.po_number, dp.tracking_numbers || []);
                    lifecycleMap.set(dp.po_number, dp);
                }

                for (const row of poSends || []) {
                    if (!poSendMap.has(row.po_number)) poSendMap.set(row.po_number, []);
                    poSendMap.get(row.po_number)!.push(row);
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

        const shipments = shipmentMap.get(po.orderId) || [];
        const resolvedReceiveDate = resolvePurchaseOrderReceiptDate({
            status: po.status,
            receiveDate: po.receiveDate,
            shipments: po.shipments,
        });
        const isReceived = hasPurchaseOrderReceipt({
            status: po.status,
            receiveDate: po.receiveDate,
            shipments: po.shipments,
        });
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
            !shouldKeepReceivedPurchase(resolvedReceiveDate, RECEIVED_DASHBOARD_RETENTION_DAYS)
        ) {
            continue;
        }

        let expectedDate: string;
        let leadProvenance: string;

        let lt: Awaited<ReturnType<typeof leadTimeService.getForVendor>> | null = null;
        if (po.orderDate) {
            lt = await leadTimeService.getForVendor(po.vendorName);
            expectedDate = addDays(po.orderDate, lt.days);
            leadProvenance = lt.label;
        } else {
            expectedDate = new Date().toISOString().split("T")[0];
            leadProvenance = "14d default";
        }

        const poLifecycle = lifecycleMap.get(po.orderId);
        const vendorPromisedEta =
            // LLM-extracted vendor-stated ETA wins when present (high or medium confidence).
            (poLifecycle?.vendor_stated_eta &&
                (poLifecycle?.vendor_stated_eta_confidence === 'high' ||
                 poLifecycle?.vendor_stated_eta_confidence === 'medium')
                    ? poLifecycle.vendor_stated_eta
                    : null) ??
            poLifecycle?.last_eta_update?.estimated_delivery_at ??
            poLifecycle?.last_eta_update?.eta ??
            poLifecycle?.last_eta_update?.date ??
            null;
        const etaProfile = deriveVendorEtaProfile({
            vendorName: po.vendorName,
            orderDate: po.orderDate || new Date().toISOString().slice(0, 10),
            fallbackLeadDays: lt?.days ?? 14,
            fallbackLabel: lt?.label ?? "14d default",
            fallbackSource: lt?.provenance ?? "default",
            vendorPromisedEta,
            shipments: shipments.map((shipment) => ({
                estimated_delivery_at: shipment.estimated_delivery_at,
                delivered_at: shipment.delivered_at,
                created_at: shipment.created_at,
            })),
        });
        const sentVerification = derivePOSentVerification({
            poNumber: po.orderId,
            purchaseOrder: poLifecycle,
            sendRows: poSendMap.get(po.orderId) || [],
            hasTracking: (trackingMap.get(po.orderId)?.length || 0) > 0 || shipments.length > 0,
        });

        const vendorProfile = vendorMap.get(po.vendorName?.toLowerCase());

        activePos.push({
            ...po,
            receiveDate: resolvedReceiveDate,
            expectedDate: etaProfile.expectedDate || expectedDate,
            leadProvenance: etaProfile.label || leadProvenance,
            isReceived,
            completionState,
            trackingNumbers: trackingMap.get(po.orderId) || [],
            shipments,
            lifecycleStage: poLifecycle?.lifecycle_stage || undefined,
            lastMovementSummary: poLifecycle?.last_movement_summary || null,
            trackingUnavailableAt: poLifecycle?.tracking_unavailable_at || null,
            trackingRequestedAt: poLifecycle?.tracking_requested_at || null,
            vendorAcknowledgedAt: poLifecycle?.vendor_acknowledged_at || null,
            humanReplyDetectedAt: poLifecycle?.human_reply_detected_at || null,
            sentVerification,
            etaProfile,
            trackingPaused: poLifecycle?.tracking_paused || false,
            trackingSource: poLifecycle?.tracking_source || null,
            typicalTrackingSource: vendorProfile?.typical_tracking_source || null,
            vendorOrdersEmail: vendorProfile?.orders_email || vendorProfile?.vendor_emails?.[0] || null,
        });
    }

    activePos.sort((a, b) => {
        const da = new Date(a.orderDate || 0).getTime();
        const db = new Date(b.orderDate || 0).getTime();
        return db - da;
    });

    return activePos;
}

import type { TrackingStatus } from "../carriers/tracking-service";
import type { POCompletionState } from "./po-completion-state";
import { hasPurchaseOrderReceipt } from "./po-receipt-state";

export const RECEIVED_CALENDAR_RETENTION_DAYS = 14;
export const RECEIVED_DASHBOARD_RETENTION_DAYS = 3;

export type PurchasingCalendarStatus =
    | "open"
    | "delivered"
    | "received"
    | "cancelled"
    | "exception"
    | "in_transit"
    | "awaiting_tracking"
    | "noncomm"
    | "partial"
    | "past_due";

export interface PurchasingLifecycleState {
    calendarStatus: PurchasingCalendarStatus;
    completionState: POCompletionState | null;
    colorId: string;
    prefixText: string;
    statusLabel: string;
    isReceived: boolean;
    isCancelled: boolean;
    isDeliveredAwaitingReceipt: boolean;
    isNoncomm?: boolean;
    isPartial?: boolean;
    isHumanEscalated?: boolean;
}

/**
 * High-level purchasing event states that drive the calendar rendering.
 */
export function derivePurchasingLifecycle(
    status: string | null | undefined,
    trackingStatuses: Array<TrackingStatus | null> = [],
    completionState: POCompletionState | null = null,
    expectedDeliveryDate?: string,
    receiveDate?: string | null,
    shipments?: POShipmentLike[] | null,
    poData?: {
        vendor_noncomm_at?: string | null;
        human_reply_detected_at?: string | null;
        lifecycle_stage?: string | null;
    }
): PurchasingLifecycleState {
    const normalized = (status || "").toLowerCase();
    const isReceived = hasPurchaseOrderReceipt({ status: normalized, receiveDate, shipments });
    const isCancelled = normalized === "cancelled" || normalized === "canceled";
    const knownStatuses = trackingStatuses.filter((item): item is TrackingStatus => item !== null);
    
    // PARTIAL / MULTI-SHIPMENT DETECTION
    // If not fully received, but we have multiple shipments OR at least one shipment is received
    const shipmentList = shipments || [];
    const hasMultipleShipments = shipmentList.length > 1;
    const hasAnyReceivedShipment = shipmentList.some(s => String(s.status || "").toLowerCase() === "received");
    const isPartial = !isReceived && !isCancelled && (hasMultipleShipments || hasAnyReceivedShipment);

    const hasDeliveredProof =
        !isReceived &&
        !isCancelled &&
        trackingStatuses.length > 0 &&
        knownStatuses.length === trackingStatuses.length &&
        knownStatuses.every(item => item.category === "delivered");

    const isReceivedCompletionState = completionState &&
        (completionState.includes('received') || completionState === 'delivered_awaiting_receipt');

    if (isReceived || isReceivedCompletionState) {
        return {
            calendarStatus: "received",
            completionState,
            colorId: "2",
            prefixText: "RCV",
            statusLabel: "Received",
            isReceived: true,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
        };
    }

    if (isCancelled) {
        return {
            calendarStatus: "cancelled",
            completionState,
            colorId: "11",
            prefixText: "CNCL",
            statusLabel: "Cancelled",
            isReceived: false,
            isCancelled: true,
            isDeliveredAwaitingReceipt: false,
        };
    }

    if (hasDeliveredProof) {
        return {
            calendarStatus: "delivered",
            completionState,
            colorId: "5",
            prefixText: "DLVD",
            statusLabel: "Delivered - Awaiting Receipt",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: true,
        };
    }

    // HUMAN ESCALATED (Purple)
    if (poData?.human_reply_detected_at || poData?.lifecycle_stage === 'human_escalated') {
        return {
            calendarStatus: "open",
            completionState,
            colorId: "10", // Purple
            prefixText: "HUMAN",
            statusLabel: "Human Intervened",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
            isHumanEscalated: true,
        };
    }

    // NONCOMM (Red/Exception)
    if (poData?.vendor_noncomm_at || poData?.lifecycle_stage === 'tracking_unavailable') {
        return {
            calendarStatus: "noncomm",
            completionState,
            colorId: "6", // Tomato/Red
            prefixText: "NONCOMM",
            statusLabel: "Vendor Non-Communicative",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
            isNoncomm: true,
        };
    }

    // PARTIAL (Cyan/Teal) - Should take priority over LATE
    if (isPartial) {
        return {
            calendarStatus: "partial",
            completionState,
            colorId: "7", // Cyan/Teal
            prefixText: "PARTIAL",
            statusLabel: "Partial Receipt / Multi-Shipment",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
            isPartial: true,
        };
    }

    const hasAnyTracking = trackingStatuses.length > 0;
    const ageDays = daysSinceDate(expectedDeliveryDate || undefined) || 0;

    if (ageDays > 14 && hasAnyTracking) {
        return {
            calendarStatus: "delivered",
            completionState,
            colorId: "5",
            prefixText: "LATE",
            statusLabel: "Past Due - Verify Receipt in Finale",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: true,
        };
    }

    if (ageDays > 35) {
        return {
            calendarStatus: "exception",
            completionState,
            colorId: "6",
            prefixText: "EXCP",
            statusLabel: "Long Outstanding - Needs Attention",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
        };
    }

    if (ageDays > 0) {
        return {
            calendarStatus: "past_due",
            completionState,
            colorId: "11", // Graphite/Grey (actually Graphite 11)
            prefixText: "LATE",
            statusLabel: "Past Due - Needs Follow-up",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
        };
    }

    if (hasAnyTracking) {
        return {
            calendarStatus: "in_transit",
            completionState,
            colorId: "9", // Blueberry (Blue)
            prefixText: "IT",
            statusLabel: "In Transit",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
        };
    }

    return {
        calendarStatus: "awaiting_tracking",
        completionState,
        colorId: "8", // Graphite (Grey)
        prefixText: "AT",
        statusLabel: "Awaiting Tracking",
        isReceived: false,
        isCancelled: false,
        isDeliveredAwaitingReceipt: false,
    };
}

export function getPurchasingEventDate(
    expectedDate: string,
    actualReceiveDate: string | null,
    lifecycle: PurchasingLifecycleState,
    latestETA?: string | null
): string {
    const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    
    if (actualReceiveDate) {
        return toDateOnly(actualReceiveDate) || actualReceiveDate;
    }

    let eventDate = expectedDate;
    if (latestETA) {
        eventDate = toDateOnly(latestETA) || expectedDate;
    }

    // Push past due unreceived items forward to today for visibility
    if (!lifecycle.isReceived && eventDate < todayKey) {
        // Also apply to PARTIAL/NONCOMM/EXCEPTION/PAST_DUE
        return todayKey;
    }

    return eventDate;
}

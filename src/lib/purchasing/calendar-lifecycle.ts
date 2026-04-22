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
    | "multi"
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
    isIntendedMulti?: boolean;
    isHumanEscalated?: boolean;
}

export function toDateOnly(dateStr: string | null | undefined): string | null {
    if (!dateStr) return null;
    const isoPrefix = /^(\d{4}-\d{2}-\d{2})/.exec(dateStr);
    if (isoPrefix) return isoPrefix[1];
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().split("T")[0];
}

export function daysSinceDate(dateStr: string | null | undefined, now: Date = new Date()): number | null {
    const dateOnly = toDateOnly(dateStr);
    if (!dateOnly) return null;
    const todayKey = now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const thenMs = new Date(`${dateOnly}T12:00:00Z`).getTime();
    const nowMs = new Date(`${todayKey}T12:00:00Z`).getTime();
    return Math.round((nowMs - thenMs) / 86_400_000);
}

export function shouldKeepReceivedPurchase(
    receiveDate: string | null | undefined,
    retentionDays: number,
    now: Date = new Date()
): boolean {
    const ageDays = daysSinceDate(receiveDate, now);
    if (ageDays === null) return true;
    return ageDays <= retentionDays;
}

export interface POShipmentLike {
    status?: string | null;
    receiveDate?: string | null;
}

/**

 * Derives the calendar/purchasing lifecycle state for a PO.
 *
 * EDGE CASES & STATE PRIORITY (highest to lowest):
 * 1. RECEIVED (green) — PO has at least one "received" shipment OR status="received"
 * 2. CANCELLED (yellow) — PO status is "cancelled"
 * 3. DELIVERED (orange) — All tracking shows "delivered" but not yet marked received in Finale
 * 4. MULTI (purple) — PO is an intended multi-shipment (blanket/quarterly). Shown even before shipments arrive.
 *    Detection: DB flag `is_intended_multi` OR keywords in notes/comments OR 2+ date patterns in notes
 * 5. HUMAN ESCALATED (purple) — Human reply detected or lifecycle_stage='human_escalated'
 * 6. NONCOMM (red) — Vendor marked non-communicative (vendor_noncomm_at set or lifecycle_stage='tracking_unavailable')
 * 7. PARTIAL (cyan) — Accidental partial shipment. Has multiple shipments or received shipments but NOT intended multi.
 *    Detection: hasMultipleShipments || hasAnyReceivedShipment, NOT isIntendedMulti, NOT isReceived, NOT isCancelled
 * 8. PAST DUE (yellow) — Expected date has passed but not yet received
 * 9. EXCEPTION (red) — More than 35 days old with no delivery
 * 10. IN TRANSIT (blue) — Has tracking but not delivered
 * 11. AWAITING TRACKING (grey) — No tracking information
 *
 * MULTI vs PARTIAL distinction:
 * - MULTI: Vendor intentionally splitting delivery (blanket PO, scheduled deliveries). Keyword-triggered.
 * - PARTIAL: Accidental partial shipment or backorder. Unintended.
 * These two states are mutually exclusive — a PO cannot be both MULTI and PARTIAL.
 *
 * The `is_intended_multi` DB flag takes precedence over keyword detection. Once set, the PO
 * stays in MULTI state even if shipments arrive, until explicitly unmarked or fully received.
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
        is_intended_multi?: boolean | null;
        notes?: string | null;    // Internal notes (fallback)
        comments?: string | null; // External notes (primary for MULTI detection)
    }
): PurchasingLifecycleState {
    const normalized = (status || "").toLowerCase();
    const isReceived = hasPurchaseOrderReceipt({ status: normalized, receiveDate, shipments });
    const isCancelled = normalized === "cancelled" || normalized === "canceled";
    const knownStatuses = trackingStatuses.filter((item): item is TrackingStatus => item !== null);
    
    // PARTIAL / MULTI-SHIPMENT DETECTION
    const shipmentList = shipments || [];
    const hasMultipleShipments = shipmentList.length > 1;
    const hasAnyReceivedShipment = shipmentList.some(s => String(s.status || "").toLowerCase() === "received");
    
    // AUTONOMOUS CLASSIFICATION
    // 1. Is it intended multi? (Check DB flag OR scan external comments/internal notes for keywords)
    const externalNotes = (poData?.comments || "").toLowerCase();
    const internalNotes = (poData?.notes || "").toLowerCase();
    const combinedNotes = `${externalNotes} ${internalNotes}`;
    
    const multiKeywords = [
        "blanket", "quarterly", "scheduled", "advance", "multi", "split",
        "monthly", "deliveries", "stages", "expected delivery", "delivery date",
        "multiple shipments", "shipping schedule", "expected deliveries", "dates"
    ];
    
    // Also check for multiple dates in notes (e.g. "6/1, 8/1, 10/1")
    const datePattern = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g;
    const dateMatches = combinedNotes.match(datePattern) || [];
    
    const isIntendedMulti = poData?.is_intended_multi || 
        multiKeywords.some(k => combinedNotes.includes(k)) ||
        dateMatches.length >= 2; // Multiple dates in notes is a strong MULTI signal

    // 2. Is it an accidental partial?
    const isPartial = !isReceived && !isCancelled && (hasMultipleShipments || hasAnyReceivedShipment) && !isIntendedMulti;

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

    // MULTI (Purple) - Intended blanket/scheduled POs
    // These show as MULTI even before shipments arrive to indicate an intentional long-lead item.
    if (isIntendedMulti && !isReceived && !isCancelled) {
        return {
            calendarStatus: "multi",
            completionState,
            colorId: "10", // Purple
            prefixText: "MULTI",
            statusLabel: "MULTI - Intended Multi-Shipment",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
            isIntendedMulti: true,
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

    // RCV P (Cyan) - Accidental partials/backorders
    if (isPartial) {
        return {
            calendarStatus: "partial",
            completionState,
            colorId: "7", // Cyan/Teal
            prefixText: "RCV P",
            statusLabel: "RCV P - Partial / Backordered",
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
            colorId: "11",
            prefixText: "LATE",
            statusLabel: "Past Due - Needs Review",
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
        return todayKey;
    }

    return eventDate;
}

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

export function derivePurchasingLifecycle(
    status: string | null | undefined,
    trackingStatuses: Array<TrackingStatus | null> = [],
    completionState: POCompletionState | null = null,
    expectedDeliveryDate?: string,
    receiveDate?: string | null,
    shipments?: POShipmentLike[] | null
): PurchasingLifecycleState {
    const normalized = (status || "").toLowerCase();
    const isReceived = hasPurchaseOrderReceipt({ status: normalized, receiveDate, shipments });
    const isCancelled = normalized === "cancelled" || normalized === "canceled";
    const knownStatuses = trackingStatuses.filter((item): item is TrackingStatus => item !== null);
    const hasDeliveredProof =
        !isReceived &&
        !isCancelled &&
        trackingStatuses.length > 0 &&
        knownStatuses.length === trackingStatuses.length &&
        knownStatuses.every(item => item.category === "delivered");

    if (isReceived || (completionState && (completionState.includes('received') || completionState === 'complete'))) {
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

    // Smart logic for past-due items - reduce red, show orange for overdue
    const hasAnyTracking = trackingStatuses.length > 0;
    const ageDays = daysSinceDate(expectedDeliveryDate || undefined) || 0;

    // If past expected and has tracking → treat as likely delivered
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

    // Very old with no tracking = exception
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

    // "Way past due should be red"
    // If it's past expected date and NOT delivered, it's Past Due
    if (ageDays > 0) {
        return {
            calendarStatus: "past_due",
            completionState,
            colorId: "11", // Tomato Red
            prefixText: "LATE",
            statusLabel: "Past Due - Needs Follow-up",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
        };
    }

    // "but we need an in transit color, on track industry standards"
    if (hasAnyTracking) {
        return {
            calendarStatus: "in_transit",
            completionState,
            colorId: "9", // Blueberry (Blue) - Industry standard for active transit
            prefixText: "IT",
            statusLabel: "In Transit",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: false,
        };
    }

    // Awaiting tracking / processing
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
    receiveDate: string | null | undefined,
    lifecycle: PurchasingLifecycleState,
    latestETA?: string
): string {
    // Priority: actual receive date > latest tracking ETA > original expected date
    // If not received and calculated date is in the past, push to today
    const todayKey = toDateOnly(new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" }))!;

    if (lifecycle.isReceived) {
        if (receiveDate) {
            const parsed = toDateOnly(receiveDate);
            if (parsed) return parsed;
        }
        // If we absolutely don't have a receiveDate, leave it on its expected date
        // (or today if you prefer, but "actual day" is best effort via receiveDate)
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

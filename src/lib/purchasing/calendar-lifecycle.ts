import type { TrackingStatus } from "../carriers/tracking-service";
import type { POCompletionState } from "./po-completion-state";

export const RECEIVED_CALENDAR_RETENTION_DAYS = 14;
export const RECEIVED_DASHBOARD_RETENTION_DAYS = 3;

export type PurchasingCalendarStatus =
    | "open"
    | "delivered"
    | "received"
    | "received_pending_invoice"
    | "received_pending_reconciliation"
    | "complete"
    | "exception"
    | "cancelled";

export interface PurchasingLifecycleState {
    calendarStatus: PurchasingCalendarStatus;
    completionState: POCompletionState | null;
    colorId: string;
    titleEmoji: string;
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

export function derivePurchasingLifecycle(
    status: string | null | undefined,
    trackingStatuses: Array<TrackingStatus | null> = [],
    completionState: POCompletionState | null = null
): PurchasingLifecycleState {
    const normalized = (status || "").toLowerCase();
    const isReceived = normalized === "completed";
    const isCancelled = normalized === "cancelled";
    const knownStatuses = trackingStatuses.filter((item): item is TrackingStatus => item !== null);
    const hasDeliveredProof =
        !isReceived &&
        !isCancelled &&
        trackingStatuses.length > 0 &&
        knownStatuses.length === trackingStatuses.length &&
        knownStatuses.every(item => item.category === "delivered");

    if (isReceived) {
        switch (completionState) {
            case "complete":
                return {
                    calendarStatus: "complete",
                    completionState,
                    colorId: "2",
                    titleEmoji: "✅",
                    statusLabel: "Complete",
                    isReceived: true,
                    isCancelled: false,
                    isDeliveredAwaitingReceipt: false,
                };
            case "received_pending_invoice":
                return {
                    calendarStatus: "received_pending_invoice",
                    completionState,
                    colorId: "2",
                    titleEmoji: "🟢",
                    statusLabel: "Received - Awaiting Invoice",
                    isReceived: true,
                    isCancelled: false,
                    isDeliveredAwaitingReceipt: false,
                };
            case "received_pending_reconciliation":
                return {
                    calendarStatus: "received_pending_reconciliation",
                    completionState,
                    colorId: "2",
                    titleEmoji: "🟢",
                    statusLabel: "Received - AP Follow-Up Needed",
                    isReceived: true,
                    isCancelled: false,
                    isDeliveredAwaitingReceipt: false,
                };
            case "exception":
                return {
                    calendarStatus: "exception",
                    completionState,
                    colorId: "6",
                    titleEmoji: "🟠",
                    statusLabel: "Received - Exception Needs Review",
                    isReceived: true,
                    isCancelled: false,
                    isDeliveredAwaitingReceipt: false,
                };
            default:
                return {
                    calendarStatus: "received",
                    completionState,
                    colorId: "2",
                    titleEmoji: "✅",
                    statusLabel: "Received",
                    isReceived: true,
                    isCancelled: false,
                    isDeliveredAwaitingReceipt: false,
                };
        }
    }

    if (isCancelled) {
        return {
            calendarStatus: "cancelled",
            completionState,
            colorId: "11",
            titleEmoji: "❌",
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
            titleEmoji: "🟡",
            statusLabel: "Delivered - Awaiting Receipt",
            isReceived: false,
            isCancelled: false,
            isDeliveredAwaitingReceipt: true,
        };
    }

    return {
        calendarStatus: "open",
        completionState,
        colorId: "11",
        titleEmoji: "🔴",
        statusLabel: "In Transit",
        isReceived: false,
        isCancelled: false,
        isDeliveredAwaitingReceipt: false,
    };
}

export function getPurchasingEventDate(
    expectedDate: string,
    receiveDate: string | null | undefined,
    lifecycle: PurchasingLifecycleState
): string {
    return lifecycle.isReceived ? toDateOnly(receiveDate) || expectedDate : expectedDate;
}

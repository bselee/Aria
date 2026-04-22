export type {
    POLifecycleState,
    POLifecycleResult,
    POLifecycleEvidence,
    POInput,
} from "./derive-po-lifecycle";

export type {
    PurchasingCalendarStatus,
    PurchasingLifecycleState,
    POShipmentLike,
} from "./calendar-lifecycle";

export const LIFECYCLE_STAGES = {
    PRE_RECEIPT: {
        SENT: "sent" as const,
        VENDOR_ACKNOWLEDGED: "vendor_acknowledged" as const,
        TRACKING_UNAVAILABLE: "tracking_unavailable" as const,
        MOVING_WITH_TRACKING: "moving_with_tracking" as const,
        AP_FOLLOW_UP: "ap_follow_up" as const,
    },
    POST_RECEIPT: {
        OPEN: "open" as const,
        DELIVERED: "delivered" as const,
        RECEIVED: "received" as const,
        CANCELLED: "cancelled" as const,
        EXCEPTION: "exception" as const,
        IN_TRANSIT: "in_transit" as const,
        AWAITING_TRACKING: "awaiting_tracking" as const,
        PAST_DUE: "past_due" as const,
        NONCOMM: "noncomm" as const,
        PARTIAL: "partial" as const,
        MULTI: "multi" as const,
    },
} as const;

export const LIFECYCLE_COLORS: Record<string, string> = {
    received: "2",
    cancelled: "11",
    delivered: "5",
    exception: "6",
    past_due: "11",
    noncomm: "6", 
    partial: "7", // Cyan for RCV P
    multi: "10",  // Purple for intended MULTI
    in_transit: "9",
    awaiting_tracking: "8",
    open: "8",
    sent: "8",
    vendor_acknowledged: "8",
    tracking_unavailable: "6",
    moving_with_tracking: "9",
    ap_follow_up: "6",
    human_escalated: "10",
};

export const LIFECYCLE_LABELS: Record<string, string> = {
    sent: "Sent - Awaiting Vendor Response",
    vendor_acknowledged: "Vendor Acknowledged",
    tracking_unavailable: "Tracking Unavailable",
    moving_with_tracking: "In Transit",
    ap_follow_up: "AP Review Needed",
    received: "Received",
    cancelled: "Cancelled",
    delivered: "Delivered - Awaiting Receipt",
    exception: "Long Outstanding - Needs Attention",
    past_due: "Past Due - Needs Review",
    noncomm: "Vendor Non-Communicative",
    partial: "RCV P - Partial / Backordered",
    multi: "MULTI - Intended Multi-Shipment",
    open: "Open",
    human_escalated: "Human Intervened",
};

export function isPreReceiptStage(stage: string): boolean {
    const preReceipt = LIFECYCLE_STAGES.PRE_RECEIPT;
    return Object.values(preReceipt).includes(stage as any);
}

export function isPostReceiptStage(stage: string): boolean {
    const postReceipt = LIFECYCLE_STAGES.POST_RECEIPT;
    return Object.values(postReceipt).includes(stage as any);
}

export function isActiveLifecycle(stage: string): boolean {
    return stage !== "received" && stage !== "cancelled";
}

export function getLifecycleColor(stage: string): string {
    return LIFECYCLE_COLORS[stage] ?? "8";
}

export function getLifecycleLabel(stage: string): string {
    return LIFECYCLE_LABELS[stage] ?? "Unknown";
}

export function isReceiptedState(stage: string): boolean {
    return stage === "received";
}

export function isProblemState(stage: string): boolean {
    return ["exception", "past_due", "tracking_unavailable", "ap_follow_up"].includes(stage);
}

export type AnyLifecycleStage = string;

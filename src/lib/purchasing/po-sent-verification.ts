export type POSentVerificationSource =
    | "po_send"
    | "purchase_order"
    | "tracking"
    | "vendor_reply"
    | "manual";

export interface POSentEvidence {
    type: POSentVerificationSource;
    at: string | null;
    detail: string;
}

export interface POSentVerification {
    verified: boolean;
    sentAt: string | null;
    source: POSentVerificationSource | null;
    evidence: POSentEvidence[];
}

export interface DerivePOSentVerificationInput {
    poNumber: string;
    purchaseOrder?: Record<string, any> | null;
    sendRows?: Array<Record<string, any>>;
    hasTracking: boolean;
}

function firstTimestamp(...values: Array<string | null | undefined>): string | null {
    return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

export function derivePOSentVerification(input: DerivePOSentVerificationInput): POSentVerification {
    const evidence: POSentEvidence[] = [];
    const po = input.purchaseOrder ?? {};
    const sendRow = (input.sendRows ?? []).find((row) => row?.sent_at || row?.committed_at);
    const manualAt = firstTimestamp(po.po_sent_verified_at, po.manual_sent_verified_at);

    if (manualAt) {
        evidence.push({
            type: "manual",
            at: manualAt,
            detail: po.po_sent_verified_source || "Marked verified by user",
        });
    }

    if (sendRow) {
        evidence.push({
            type: "po_send",
            at: firstTimestamp(sendRow.sent_at, sendRow.committed_at),
            detail: "PO send log recorded by Aria",
        });
    }

    if (po.po_sent_at) {
        evidence.push({
            type: "purchase_order",
            at: po.po_sent_at,
            detail: "purchase_orders.po_sent_at is populated",
        });
    }

    if (po.vendor_acknowledged_at || po.human_reply_detected_at) {
        evidence.push({
            type: "vendor_reply",
            at: firstTimestamp(po.vendor_acknowledged_at, po.human_reply_detected_at),
            detail: po.vendor_ack_source || "Vendor email thread references this PO",
        });
    }

    if (input.hasTracking) {
        evidence.push({
            type: "tracking",
            at: null,
            detail: "Tracking is linked to this PO",
        });
    }

    const primary = evidence[0];
    return {
        verified: evidence.length > 0,
        sentAt: primary?.at ?? null,
        source: primary?.type ?? null,
        evidence,
    };
}

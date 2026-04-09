export type POLifecycleState =
    | 'sent'
    | 'vendor_acknowledged'
    | 'tracking_unavailable'
    | 'moving_with_tracking'
    | 'ap_follow_up';

export interface POLifecycleEvidence {
    sentDate?: string;
    acknowledgmentDate?: string;
    trackingNumbers?: string[];
    trackingStatuses?: string[];
    apFollowUpReason?: string;
    followUpSentAt?: string;
    computedAt: string;
}

export interface POLifecycleResult {
    state: POLifecycleState;
    evidence: POLifecycleEvidence;
}

export interface POInput {
    id: string;
    sentDate?: string | null;
    hasTracking?: boolean;
    hasVendorAck?: boolean;
    hasInvoice?: boolean;
    followUpSentAt?: string | null;
    trackingNumbers?: string[];
    acknowledgmentDate?: string | null;
}

export function derivePOLifecycleState(po: POInput): POLifecycleResult {
    const now = new Date().toISOString();

    const evidence: POLifecycleEvidence = {
        sentDate: po.sentDate ?? now,
        computedAt: now,
    };

    if (po.trackingNumbers?.length) {
        evidence.trackingNumbers = po.trackingNumbers;
    }
    if (po.acknowledgmentDate) {
        evidence.acknowledgmentDate = po.acknowledgmentDate;
    }
    if (po.followUpSentAt) {
        evidence.followUpSentAt = po.followUpSentAt;
    }

    if (po.hasVendorAck && po.hasTracking) {
        return { state: 'moving_with_tracking', evidence };
    }

    if (po.hasVendorAck && !po.hasTracking) {
        return { state: 'vendor_acknowledged', evidence };
    }

    if (po.hasInvoice && !po.hasTracking && !po.hasVendorAck) {
        evidence.apFollowUpReason = 'invoice_received_without_tracking_or_acknowledgment';
        return { state: 'ap_follow_up', evidence };
    }

    if (!po.hasVendorAck && po.followUpSentAt) {
        return { state: 'tracking_unavailable', evidence };
    }

    return { state: 'sent', evidence };
}

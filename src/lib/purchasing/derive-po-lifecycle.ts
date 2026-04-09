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
    computedAt: string;
}

export interface POLifecycleResult {
    state: POLifecycleState;
    evidence: POLifecycleEvidence;
}

export interface POInput {
    id: string;
    sentDate?: string | null;
}

export function derivePOLifecycleState(po: POInput): POLifecycleResult {
    const now = new Date().toISOString();

    const evidence: POLifecycleEvidence = {
        sentDate: po.sentDate ?? now,
        computedAt: now,
    };

    return {
        state: 'sent',
        evidence,
    };
}
